import asyncio
import contextlib
import json
import math
import os
import signal
import sys
import time

from .storage import ACTIVE, FINAL, JobError


class Supervisor:
    def __init__(self, config, storage, worker_command=None):
        self.config, self.storage = config, storage
        self.worker_command = worker_command or self.command
        self.process = None
        self.job_id = None
        self.started_at = None
        self.task = None
        self.processing_enabled = True
        self.uploads = {}
        self.lock = asyncio.Lock()

    def track_upload(self, job_id, task):
        current = self.uploads.get(job_id)
        if current and not current.done():
            task.cancel()
            raise JobError(409, "upload_conflict", "Încărcarea este deja activă")
        self.uploads[job_id] = task

    def forget_upload(self, job_id, task):
        if self.uploads.get(job_id) is task:
            self.uploads.pop(job_id)

    async def stop_upload(self, job_id):
        task = self.uploads.get(job_id)
        if task is not None:
            task.cancel()
            # Receiver cleanup never takes the supervisor lock. Waiting here
            # closes the file before unlinking it or confirming deletion.
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            self.forget_upload(job_id, task)

    async def stop_uploads(self):
        for job_id in tuple(self.uploads):
            await self.stop_upload(job_id)

    def command(self, directory):
        return [sys.executable, "-m", "ri_subtitles.worker", "--job-dir", str(directory),
                "--model-dir", str(self.config.model_dir), "--font-path", str(self.config.font_path),
                "--cpu-threads", str(self.config.cpu_threads), "--max-duration", str(self.config.max_duration),
                "--max-pixels", str(self.config.max_pixels),
                "--max-input-bytes", str(self.config.max_input_bytes),
                "--max-output-bytes", str(max(1, min(2 * 1024**3, self.config.max_spool_bytes - self.storage.disk_bytes()))),
                "--job-timeout", str(self.config.job_timeout_seconds)]

    async def start(self):
        self.storage.recover()
        self.task = asyncio.create_task(self.run())

    async def run(self):
        try:
            while True:
                await self.tick()
                await asyncio.sleep(.25)
        finally:
            # Service shutdown and unexpected supervisor errors stop the whole
            # media group, even when the current tick did not complete.
            async with self.lock:
                await self.stop_uploads()
                await self.terminate()

    async def terminate(self):
        process = self.process
        if process is None:
            return
        # A worker may already have exited while one of its children remains.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except asyncio.TimeoutError:
            pass
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()
        self.process = self.job_id = self.started_at = None

    async def stop(self):
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
            self.task = None
        async with self.lock:
            await self.stop_uploads()
            await self.terminate()

    async def cancel(self, job_id):
        async with self.lock:
            row = self.storage.get(job_id)
            await self.stop_upload(job_id)
            row = self.storage.get(job_id)
            if self.job_id == job_id:
                await self.terminate()
            try:
                self.storage.remove_files(job_id)
            except JobError:
                self.storage.update(job_id, status="failed", progress=0, error_code="cleanup_failed",
                                    error_message="Fișierele nu au putut fi șterse; oprirea nu este confirmată")
                raise
            if row["status"] != "expired":
                row = self.storage.update(job_id, status="cancelled", progress=0, message="Anulat și șters",
                                          error_code=None, error_message=None)
            return row

    async def _expire(self, row):
        await self.stop_upload(row["id"])
        if self.job_id == row["id"]:
            await self.terminate()
        try:
            self.storage.remove_files(row["id"])
        except JobError:
            self.storage.update(row["id"], status="failed", error_code="cleanup_failed",
                                error_message="Fișierele expirate nu au putut fi șterse")
            raise
        return self.storage.update(row["id"], status="expired", progress=0, message="Lucrarea a expirat", error_code=None, error_message=None)

    async def expire(self, job_id):
        async with self.lock:
            return await self._expire(self.storage.get(job_id))

    def fail(self, job_id, code, message):
        try:
            self.storage.remove_files(job_id)
        except JobError:
            code, message = "cleanup_failed", "Fișierele nu au putut fi șterse"
        self.storage.update(job_id, status="failed", progress=0, message="Procesarea a eșuat", error_code=code, error_message=message)

    def read_json(self, path, max_bytes=8*1024*1024):
        if path.stat().st_size > max_bytes:
            raise ValueError("Oversized worker metadata")
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError("Worker metadata must be an object")
        return value

    def validated_result(self, directory):
        result = self.read_json(directory / "result.json")
        if result.get("status") not in {"ready", "empty"}:
            raise ValueError("Invalid result status")
        duration = result.get("duration")
        if isinstance(duration, bool) or not isinstance(duration, (float, int)) or not math.isfinite(duration) or not 0 < duration <= self.config.max_duration + 1:
            raise ValueError("Invalid duration")
        width, height = result.get("width"), result.get("height")
        if any(isinstance(n, bool) or not isinstance(n, int) or n <= 0 or n % 2 for n in (width, height)) or max(width, height) > 1920:
            raise ValueError("Invalid dimensions")
        output = directory / "output.mp4"
        output_bytes = result.get("outputBytes")
        if isinstance(output_bytes, bool) or not isinstance(output_bytes, int) or not output.is_file() or output.stat().st_size <= 0 or output_bytes != output.stat().st_size:
            raise ValueError("Missing or truncated output")
        if not (directory / "subtitles.srt").is_file():
            raise ValueError("Missing subtitles")
        cues = result.get("cues")
        if not isinstance(cues, list) or (result["status"] == "ready" and not cues) or (result["status"] == "empty" and cues):
            raise ValueError("Invalid cues")
        previous = 0
        for cue in cues:
            start, end, text = cue.get("start"), cue.get("end"), cue.get("text")
            if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in (start, end)) or not previous <= start < end <= duration or not isinstance(text, str) or not text.strip():
                raise ValueError("Invalid cue timing")
            previous = end
        from .subtitles import to_srt
        subtitle_file = directory / "subtitles.srt"
        if subtitle_file.stat().st_size > 8 * 1024 * 1024 or subtitle_file.read_text(encoding="utf-8") != to_srt(cues):
            raise ValueError("Missing or truncated subtitles")
        return result

    async def tick(self):
        async with self.lock:
            now = time.time()
            for row in self.storage.rows():
                if row["expires"] <= now and row["status"] != "expired":
                    with contextlib.suppress(JobError):
                        await self._expire(row)
            self.storage.prune_tombstones(now)
            if self.process:
                job_id, directory = self.job_id, self.storage.path(self.job_id)
                if time.monotonic() - self.started_at > self.config.job_timeout_seconds:
                    await self.terminate()
                    self.fail(job_id, "job_timeout", "Procesarea a depășit timpul permis")
                    return
                try:
                    self.storage.ensure_space()
                except JobError:
                    await self.terminate()
                    self.fail(job_id, "storage_full", "Procesarea a depășit spațiul disponibil")
                    return
                if self.process.returncode is not None:
                    exit_code = self.process.returncode
                    await self.terminate()
                    try:
                        result = self.validated_result(directory)
                        if exit_code:
                            raise ValueError("Worker failed")
                        self.storage.update(job_id, status=result["status"], progress=1, message="Rezultatul este disponibil")
                        # Retain only the verified original and final artifacts; remove extracted audio and temporary files.
                        for path in directory.iterdir():
                            if path.name not in {"source.media", "output.mp4", "subtitles.srt", "result.json"} and path.is_file():
                                path.unlink()
                    except (OSError, ValueError, TypeError, AttributeError):
                        self.fail(job_id, "processing_failed", "Rezultatul subtitrării nu a putut fi verificat")
                else:
                    try:
                        progress = self.read_json(directory / "progress.json", 16384)
                        value = progress.get("progress")
                        if progress.get("status") in ACTIVE and not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= 1:
                            # Worker messages are never propagated: they could expose paths or source text.
                            status = progress["status"]
                            self.storage.update(job_id, status=status, progress=value,
                                                message="Transcrierea sunetului" if status == "transcribing" else "Aplicarea subtitrărilor")
                    except (OSError, ValueError, TypeError):
                        pass
                return
            if not self.processing_enabled:
                return
            for row in self.storage.rows():
                if row["status"] == "queued":
                    directory = self.storage.path(row["id"])
                    source = directory / "source.media"
                    if not source.is_file() or source.stat().st_size != row["input_bytes"]:
                        self.fail(row["id"], "source_missing", "Încărcarea originalului este incompletă")
                        continue
                    try:
                        self.storage.ensure_space()
                        self.process = await asyncio.create_subprocess_exec(*self.worker_command(directory), start_new_session=True,
                            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                            env={name: value for name, value in os.environ.items() if name != "RI_SUBTITLES_ACCESS_CODE"})
                        self.job_id, self.started_at = row["id"], time.monotonic()
                        self.storage.update(row["id"], status="transcribing", progress=0, message="Transcrierea sunetului")
                    except (OSError, JobError):
                        self.fail(row["id"], "worker_unavailable", "Procesarea subtitrărilor nu este disponibilă")
                    break
