import contextlib
import json
import os
import shutil
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone


FINAL = {"ready", "empty", "failed", "cancelled", "expired"}
ACTIVE = {"transcribing", "rendering"}


class JobError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


class Storage:
    def __init__(self, config):
        self.config = config
        config.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(config.data_dir, 0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(config.data_dir / "jobs.sqlite3", check_same_thread=False)
        os.chmod(config.data_dir / "jobs.sqlite3", 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, filename TEXT NOT NULL,
            input_bytes INTEGER NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
            message TEXT NOT NULL DEFAULT '', created REAL NOT NULL, expires REAL NOT NULL,
            error_code TEXT, error_message TEXT)""")
        self.db.commit()

    def get(self, job_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise JobError(404, "not_found", "Lucrarea de subtitrare nu există")
            return dict(row)

    def rows(self):
        with self.lock:
            return [dict(row) for row in self.db.execute("SELECT * FROM jobs ORDER BY created, id")]

    def path(self, job_id):
        # Only database-issued IDs may reach filesystem operations.
        if len(job_id) != 32 or any(char not in "0123456789abcdef" for char in job_id):
            raise JobError(404, "not_found", "Lucrarea de subtitrare nu există")
        return self.config.data_dir / job_id

    def disk_bytes(self):
        # Spool quota covers media and private job artifacts, not SQLite bookkeeping.
        total = 0
        for directory in self.config.data_dir.iterdir():
            if directory.is_dir() and len(directory.name) == 32:
                for path in directory.rglob("*"):
                    with contextlib.suppress(FileNotFoundError):
                        if path.is_file():
                            total += path.stat().st_size
        return total

    def ensure_space(self, additional=0):
        if self.disk_bytes() + additional > self.config.max_spool_bytes or shutil.disk_usage(self.config.data_dir).free - additional < self.config.min_free_bytes:
            raise JobError(507, "storage_full", "Spațiul disponibil pentru subtitrări este insuficient")

    def create(self, request_id, filename, input_bytes):
        with self.lock:
            old = self.db.execute("SELECT * FROM jobs WHERE request_id=?", (request_id,)).fetchone()
            if old:
                if old["filename"] != filename or old["input_bytes"] != input_bytes:
                    raise JobError(409, "request_conflict", "Identitatea cererii aparține deja altui fișier")
                return dict(old)
            pending = [row for row in self.rows() if row["status"] not in FINAL]
            if len(pending) >= self.config.max_pending_jobs:
                raise JobError(429, "queue_full", "Coada de subtitrare este plină")
            reserved = sum(row["input_bytes"] for row in pending if row["status"] in {"awaiting_upload", "uploading"})
            self.ensure_space(reserved + input_bytes)
            job_id, now = uuid.uuid4().hex, time.time()
            self.path(job_id).mkdir(mode=0o700)
            self.db.execute("INSERT INTO jobs(id,request_id,filename,input_bytes,status,created,expires) VALUES(?,?,?,?,?,?,?)",
                            (job_id, request_id, filename, input_bytes, "awaiting_upload", now, now + self.config.upload_ttl_seconds))
            self.db.commit()
            return self.get(job_id)

    def update(self, job_id, **values):
        if not values:
            return self.get(job_id)
        allowed = {"status", "progress", "message", "expires", "error_code", "error_message"}
        if not values.keys() <= allowed:
            raise ValueError("Invalid state fields")
        with self.lock:
            self.db.execute("UPDATE jobs SET " + ",".join(key + "=?" for key in values) + " WHERE id=?", (*values.values(), job_id))
            self.db.commit()
            return self.get(job_id)

    def snapshot(self, row):
        result = {}
        if row["status"] in {"ready", "empty"}:
            try:
                result = json.loads((self.path(row["id"]) / "result.json").read_text())
            except (OSError, ValueError):
                raise JobError(409, "result_unavailable", "Rezultatul subtitrării nu este disponibil")
        return {"id": row["id"], "requestId": row["request_id"], "status": row["status"],
                "progress": row["progress"], "message": row["message"], "createdAt": iso(row["created"]),
                "expiresAt": iso(row["expires"]), "inputBytes": row["input_bytes"],
                "outputBytes": result.get("outputBytes", 0), "duration": result.get("duration"),
                "width": result.get("width"), "height": result.get("height"), "cues": result.get("cues", []),
                "error": {"code": row["error_code"], "message": row["error_message"]} if row["error_code"] else None}

    def remove_files(self, job_id):
        directory = self.path(job_id)
        try:
            if directory.exists():
                shutil.rmtree(directory)
            if directory.exists():
                raise OSError("Job cleanup incomplete")
        except OSError:
            raise JobError(500, "cleanup_failed", "Fișierele nu au putut fi șterse; oprirea nu este confirmată")

    def prune_tombstones(self, now):
        # Keep expired identities for a further day, so retries and DELETE remain
        # idempotent across the media-retention boundary; never retain them forever.
        cutoff = now - max(86400, self.config.retention_seconds)
        with self.lock:
            old = self.db.execute("SELECT id FROM jobs WHERE status='expired' AND expires<? AND created<?", (cutoff, cutoff)).fetchall()
            removed = False
            for row in old:
                if not self.path(row["id"]).exists():
                    self.db.execute("DELETE FROM jobs WHERE id=?", (row["id"],))
                    removed = True
            if removed:
                self.db.commit()
                self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def recover(self):
        with self.lock:
            for row in self.rows():
                directory = self.path(row["id"])
                (directory / "source.part").unlink(missing_ok=True)
                if row["status"] == "uploading":
                    source = directory / "source.media"
                    if source.is_file() and source.stat().st_size == row["input_bytes"]:
                        self.update(row["id"], status="queued", progress=0, message="În așteptarea procesării", expires=time.time() + self.config.retention_seconds)
                    else:
                        source.unlink(missing_ok=True)
                        self.update(row["id"], status="awaiting_upload", progress=0, message="Încărcarea trebuie reluată")
                elif row["status"] in ACTIVE | {"queued"}:
                    source = directory / "source.media"
                    if source.is_file() and source.stat().st_size == row["input_bytes"]:
                        for path in directory.iterdir():
                            if path.name != "source.media" and path.is_file():
                                path.unlink(missing_ok=True)
                        self.update(row["id"], status="queued", progress=0, message="În așteptarea procesării")
                    else:
                        self.remove_files(row["id"])
                        self.update(row["id"], status="failed", error_code="source_missing", error_message="Încărcarea originalului este incompletă")
