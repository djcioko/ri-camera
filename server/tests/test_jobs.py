import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

try:
    from ri_subtitles.jobs import Supervisor
    from ri_subtitles.config import Config
    from ri_subtitles.storage import Storage
except ImportError:
    Supervisor = None


class JobTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.assertIsNotNone(Supervisor, "A single-process supervisor is required")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.config = Config("s" * 40, base/"jobs", base/"model", base/"font.ttf",
                             ("https://djcioko.github.io",), min_free_bytes=0)
        self.storage = Storage(self.config)
        self.script = base/"worker.py"
        self.script.write_text("import pathlib,time,sys\np=pathlib.Path(sys.argv[1]); (p/'started').write_text('yes'); time.sleep(30)\n")
        self.supervisor = Supervisor(self.config, self.storage, worker_command=lambda path: [sys.executable, str(self.script), str(path)])

    async def asyncTearDown(self):
        if Supervisor is not None and hasattr(self, "supervisor"):
            await self.supervisor.stop()

    def queued(self, name):
        row = self.storage.create(name, "clip.mov", 4)
        (self.storage.path(row["id"])/"source.media").write_bytes(b"1234")
        return self.storage.update(row["id"], status="queued", expires=time.time()+3600)

    async def wait_started(self, row):
        for _ in range(100):
            if (self.storage.path(row["id"])/"started").exists():
                return
            await asyncio.sleep(.01)
        self.fail("worker did not start")

    async def test_only_one_worker_is_active_and_cancel_waits_for_exit(self):
        first = self.queued("request_0123456789")
        second = self.queued("request_1123456789")
        await self.supervisor.tick()
        await self.wait_started(first)
        await self.supervisor.tick()
        self.assertFalse((self.storage.path(second["id"])/"started").exists())
        process = self.supervisor.process
        await self.supervisor.cancel(first["id"])
        self.assertIsNotNone(process.returncode)
        self.assertEqual(self.storage.get(first["id"])["status"], "cancelled")
        self.assertFalse(self.storage.path(first["id"]).exists())
        await self.supervisor.tick()
        await self.wait_started(second)

    async def test_timeout_terminates_worker_and_removes_files(self):
        row = self.queued("request_0123456789")
        await self.supervisor.tick()
        await self.wait_started(row)
        self.supervisor.started_at -= self.config.job_timeout_seconds + 1
        process = self.supervisor.process
        await self.supervisor.tick()
        self.assertIsNotNone(process.returncode)
        self.assertEqual(self.storage.get(row["id"])["error_code"], "job_timeout")
        self.assertFalse(self.storage.path(row["id"]).exists())

    async def test_restart_recovers_accepted_source_and_removes_partial_upload(self):
        row = self.queued("request_0123456789")
        self.storage.update(row["id"], status="rendering")
        upload = self.storage.create("request_1123456789", "clip.mov", 4)
        directory = self.storage.path(upload["id"])
        (directory/"source.part").write_bytes(b"12")
        self.storage.update(upload["id"], status="uploading")
        self.storage.recover()
        self.assertEqual(self.storage.get(row["id"])["status"], "queued")
        self.assertEqual(self.storage.get(upload["id"])["status"], "awaiting_upload")
        self.assertFalse((directory/"source.part").exists())

    async def test_restart_recovers_upload_committed_before_database_update(self):
        row = self.queued("request_0123456789")
        self.storage.update(row["id"], status="uploading")
        self.storage.recover()
        self.assertEqual(self.storage.get(row["id"])["status"], "queued")

    async def test_expiry_removes_private_files(self):
        row = self.queued("request_0123456789")
        self.storage.update(row["id"], expires=time.time()-1)
        await self.supervisor.tick()
        self.assertEqual(self.storage.get(row["id"])["status"], "expired")
        self.assertFalse(self.storage.path(row["id"]).exists())

    async def test_validated_result_is_only_published_after_exit(self):
        self.script.write_text("import pathlib,json,sys\np=pathlib.Path(sys.argv[1]); (p/'output.mp4').write_bytes(b'video'); (p/'subtitles.srt').write_text(''); (p/'result.json').write_text(json.dumps(dict(status='empty',duration=1,width=2,height=2,cues=[],outputBytes=5)))\n")
        row = self.queued("request_0123456789")
        await self.supervisor.tick()
        await self.supervisor.process.wait()
        await self.supervisor.tick()
        self.assertEqual(self.storage.snapshot(self.storage.get(row["id"]))["status"], "empty")

    async def test_partial_or_invalid_result_is_never_published(self):
        self.script.write_text("import pathlib,json,sys\np=pathlib.Path(sys.argv[1]); (p/'output.mp4').write_bytes(b'video'); (p/'subtitles.srt').write_text(''); (p/'result.json').write_text(json.dumps(dict(status='ready',duration=1,width=2,height=2,cues=[dict(start=0,end=2,text='secret')],outputBytes=5)))\n")
        row = self.queued("request_0123456789")
        await self.supervisor.tick()
        await self.supervisor.process.wait()
        await self.supervisor.tick()
        self.assertEqual(self.storage.get(row["id"])["status"], "failed")
        self.assertFalse(self.storage.path(row["id"]).exists())
        self.assertNotIn(b"secret", (self.config.data_dir/"jobs.sqlite3").read_bytes())

    async def test_empty_subtitle_file_cannot_publish_spoken_result(self):
        self.script.write_text("import pathlib,json,sys\np=pathlib.Path(sys.argv[1]); (p/'output.mp4').write_bytes(b'video'); (p/'subtitles.srt').write_text(''); (p/'result.json').write_text(json.dumps(dict(status='ready',duration=1,width=2,height=2,cues=[dict(start=0,end=1,text='Bună')],outputBytes=5)))\n")
        row = self.queued("request_0123456789")
        await self.supervisor.tick()
        await self.supervisor.process.wait()
        await self.supervisor.tick()
        self.assertEqual(self.storage.get(row["id"])["status"], "failed")

    async def test_access_code_is_removed_from_worker_environment(self):
        self.script.write_text("import pathlib,os,time,sys\np=pathlib.Path(sys.argv[1]); (p/'leaked').write_text(str('RI_SUBTITLES_ACCESS_CODE' in os.environ)); (p/'started').write_text('yes'); time.sleep(30)\n")
        row = self.queued("request_0123456789")
        with patch.dict(os.environ, {"RI_SUBTITLES_ACCESS_CODE": "private-sentinel-do-not-inherit"}):
            await self.supervisor.tick()
        await self.wait_started(row)
        self.assertEqual((self.storage.path(row["id"])/"leaked").read_text(), "False")

    async def test_cleanup_failure_does_not_confirm_cancellation(self):
        row = self.queued("request_0123456789")
        with patch("ri_subtitles.storage.shutil.rmtree", side_effect=PermissionError("private path")):
            with self.assertRaises(Exception) as raised:
                await self.supervisor.cancel(row["id"])
        self.assertEqual(raised.exception.code, "cleanup_failed")
        self.assertNotEqual(self.storage.get(row["id"])["status"], "cancelled")
        self.assertTrue(self.storage.path(row["id"]).exists())

    async def test_old_expired_tombstones_are_removed_after_idempotency_window(self):
        row = self.queued("request_0123456789")
        self.storage.update(row["id"], status="expired", expires=time.time()-90000)
        self.storage.remove_files(row["id"])
        with self.storage.lock:
            self.storage.db.execute("UPDATE jobs SET created=? WHERE id=?", (time.time()-180000,row["id"]))
            self.storage.db.commit()
        await self.supervisor.tick()
        self.assertEqual(self.storage.rows(), [])

    async def test_invalid_progress_metadata_cannot_orphan_worker(self):
        self.script.write_text("import pathlib,time,sys\np=pathlib.Path(sys.argv[1]); (p/'progress.json').write_text('[]'); (p/'started').write_text('yes'); time.sleep(30)\n")
        row = self.queued("request_0123456789")
        await self.supervisor.tick()
        await self.wait_started(row)
        await self.supervisor.tick()
        self.assertIsNone(self.supervisor.process.returncode)
        await self.supervisor.cancel(row["id"])
        self.assertEqual(self.storage.get(row["id"])["status"], "cancelled")

    async def test_cancel_terminates_descendant_process_group(self):
        heartbeat = Path(self.temp.name)/"heartbeat"
        child_code = "import pathlib,time,signal; signal.signal(signal.SIGTERM,signal.SIG_IGN); p=pathlib.Path(" + repr(str(heartbeat)) + ");\nwhile True: p.write_text(str(time.time_ns())); time.sleep(.01)"
        self.script.write_text("import pathlib,subprocess,time,sys\np=pathlib.Path(sys.argv[1]); child=subprocess.Popen([sys.executable,'-c'," + repr(child_code) + "]);\nwhile not pathlib.Path(" + repr(str(heartbeat)) + ").exists(): time.sleep(.005)\n(p/'started').write_text('yes'); time.sleep(30)\n")
        row = self.queued("request_0123456789")
        await self.supervisor.tick()
        await self.wait_started(row)
        await self.supervisor.cancel(row["id"])
        await asyncio.sleep(.05)
        stopped = heartbeat.read_text()
        await asyncio.sleep(.1)
        self.assertEqual(stopped, heartbeat.read_text(), "Worker descendant remained active after cancellation")


if __name__ == "__main__":
    unittest.main()
