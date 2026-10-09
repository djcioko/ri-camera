import asyncio
import contextlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from ri_subtitles.api import create_app
    from ri_subtitles.config import Config
except ImportError:
    create_app = Config = None


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(create_app, "The public API factory is required")
        from fastapi.testclient import TestClient
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = Config(data_dir=Path(self.temp.name)/"jobs",
                             model_dir=Path(self.temp.name)/"model", font_path=Path(self.temp.name)/"font.ttf",
                             allowed_origins=("https://djcioko.github.io",), max_input_bytes=8,
                             max_spool_bytes=1000, min_free_bytes=0, max_pending_jobs=3)
        self.app = create_app(self.config)
        self.app.state.ready = True
        self.client = TestClient(self.app)
        self.headers = {}

    def create(self, request_id="request_0123456789", **changes):
        body = dict(requestId=request_id, filename="original.mov", bytes=4, language="ro")
        body.update(changes)
        return self.client.post("/v1/jobs", json=body, headers=self.headers)

    def test_public_request_reaches_json_validation_without_access_code(self):
        read = []
        scope = {"type": "http", "asgi": {"version": "3.0"}, "method": "POST",
                 "scheme": "http", "path": "/v1/jobs", "raw_path": b"/v1/jobs",
                 "query_string": b"", "headers": [(b"content-type", b"application/json")],
                 "server": ("localhost", 80), "client": ("localhost", 1)}
        async def receive():
            read.append(True)
            return {"type": "http.request", "body": b"invalid", "more_body": False}
        messages = []
        async def send(message):
            messages.append(message)
        asyncio.run(self.app(scope, receive, send))
        self.assertTrue(read)
        self.assertEqual(messages[0]["status"], 400)
        self.assertEqual(json.loads(messages[1]["body"])["error"]["code"], "invalid_request")

    def test_legacy_authorization_header_is_ignored(self):
        response = self.client.post("/v1/jobs", json=dict(requestId="request_0123456789",
            filename="original.mov", bytes=4, language="ro"),
            headers={"Authorization": "Bearer unused-legacy-code"})
        self.assertEqual(response.status_code, 200, response.text)
        response = self.client.get(f'/v1/jobs/{response.json()["id"]}')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "awaiting_upload")

    def test_create_is_durably_idempotent(self):
        response = self.create()
        self.assertEqual(response.status_code, 200, response.text)
        first = response.json()
        second = self.create().json()
        self.assertEqual(first["id"], second["id"])
        restarted = create_app(self.config)
        restarted.state.ready = True
        from fastapi.testclient import TestClient
        response = TestClient(restarted).post("/v1/jobs", json={"requestId": first["requestId"],
            "filename": "original.mov", "bytes": 4, "language": "ro"}, headers=self.headers)
        self.assertEqual(first["id"], response.json()["id"])
        self.assertEqual(self.create(bytes=5).status_code, 409)

    def test_upload_requires_complete_declared_bytes(self):
        job = self.create().json()
        response = self.client.put(f'/v1/jobs/{job["id"]}/source', content=b"12", headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertFalse((self.config.data_dir/job["id"]/"source.media").exists())
        response = self.client.put(f'/v1/jobs/{job["id"]}/source', content=b"1234", headers=self.headers)
        self.assertEqual(response.json()["status"], "queued")
        self.assertEqual((self.config.data_dir/job["id"]/"source.media").read_bytes(), b"1234")
        self.assertEqual(self.client.put(f'/v1/jobs/{job["id"]}/source', content=b"1234", headers=self.headers).status_code, 409)

    def test_stream_and_reservation_limits(self):
        self.assertEqual(self.create(bytes=9).status_code, 413)
        job = self.create().json()
        response = self.client.put(f'/v1/jobs/{job["id"]}/source', content=iter([b"1234", b"56789"]), headers=self.headers)
        self.assertEqual(response.status_code, 413)
        self.assertFalse((self.config.data_dir/job["id"]/"source.part").exists())
        self.create("request_1123456789")
        self.create("request_2123456789")
        self.assertEqual(self.create("request_3123456789").status_code, 429)

    def test_outputs_are_public_and_unavailable_until_complete(self):
        job = self.create().json()
        for suffix in ("output", "subtitles"):
            url = f'/v1/jobs/{job["id"]}/{suffix}'
            self.assertEqual(self.client.get(url).status_code, 409)
        response = self.client.get("/v1/jobs/../output", headers=self.headers)
        self.assertNotEqual(response.status_code, 200)

    def test_readiness_is_false_with_missing_model(self):
        self.app.state.ready = False
        body = self.client.get("/v1/health").json()
        self.assertFalse(body["ready"])
        self.assertEqual(body.get("access"), "public")
        self.assertEqual(body["limits"]["maxInputBytes"], 8)

    def test_public_request_body_is_still_bounded(self):
        response = self.client.post("/v1/jobs", content=iter([b"x" * 8192, b"y" * 8193]))
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(response.json()["error"]["code"], "request_too_large")
        self.assertEqual(self.app.state.storage.rows(), [])

    def test_public_jobs_have_opaque_ids_and_no_listing_route(self):
        response = self.create()
        self.assertEqual(response.status_code, 200, response.text)
        job = response.json()
        self.assertRegex(job["id"], r"^[a-f0-9]{32}$")
        other = self.create("request_1123456789").json()
        self.assertNotEqual(other["id"], job["id"])
        self.assertEqual(self.client.get("/v1/jobs").status_code, 405)
        self.assertEqual(self.client.get("/v1/jobs/" + "0" * 32).status_code, 404)

    def test_unready_service_does_not_accept_uploads(self):
        job = self.create().json()
        self.app.state.ready = False
        self.assertEqual(self.create("request_1123456789").status_code, 503)
        self.assertEqual(self.client.put(f'/v1/jobs/{job["id"]}/source', content=b"1234", headers=self.headers).status_code, 503)
        self.assertEqual(self.app.state.storage.get(job["id"])["status"], "awaiting_upload")

    def test_stalled_upload_obeys_total_reservation_deadline(self):
        from dataclasses import replace
        config = replace(self.config, data_dir=self.config.data_dir/"short", upload_ttl_seconds=.03)
        app = create_app(config)
        app.state.ready = True
        row = app.state.storage.create("request_0123456789", "clip.mov", 4)
        messages = []
        scope = {"type": "http", "asgi": {"version": "3.0"}, "method": "PUT", "scheme": "http",
                 "path": f'/v1/jobs/{row["id"]}/source', "query_string": b"",
                 "headers": [],
                 "server": ("localhost", 80), "client": ("localhost", 1)}
        async def receive():
            await asyncio.sleep(.1)
            return {"type": "http.request", "body": b"1234", "more_body": False}
        async def send(message):
            messages.append(message)
        asyncio.run(app(scope, receive, send))
        self.assertEqual(messages[0]["status"], 408)
        self.assertFalse((config.data_dir/row["id"]/"source.media").exists())

    def test_cors_allows_only_exact_origin_and_never_cookies(self):
        headers = {"Origin": "https://djcioko.github.io", "Access-Control-Request-Method": "PUT",
                   "Access-Control-Request-Headers": "authorization,content-type"}
        response = self.client.options("/v1/jobs/unknown/source", headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("access-control-allow-origin"), headers["Origin"])
        self.assertNotIn("access-control-allow-credentials", response.headers)
        headers["Origin"] = "https://djcioko.github.io.evil.example"
        response = self.client.options("/v1/jobs/unknown/source", headers=headers)
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_finished_artifacts_and_idempotent_delete(self):
        job = self.create().json()
        directory = self.config.data_dir/job["id"]
        (directory/"output.mp4").write_bytes(b"video")
        (directory/"subtitles.srt").write_text("")
        result = dict(status="empty", duration=1, width=2, height=2, cues=[], outputBytes=5)
        (directory/"result.json").write_text(json.dumps(result))
        self.app.state.storage.update(job["id"], status="empty")
        response = self.client.get(f'/v1/jobs/{job["id"]}/output', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"video")
        self.assertEqual(response.headers["content-type"], "video/mp4")
        response = self.client.get(f'/v1/jobs/{job["id"]}/subtitles')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"")
        self.assertEqual(response.headers["content-type"], "application/x-subrip")
        for _ in range(2):
            response = self.client.delete(f'/v1/jobs/{job["id"]}', headers=self.headers)
            self.assertEqual(response.json()["status"], "cancelled")
        self.assertFalse(directory.exists())

    def test_disk_reservations_prevent_overallocation(self):
        from dataclasses import replace
        app = create_app(replace(self.config, data_dir=self.config.data_dir/"small", max_spool_bytes=6))
        app.state.ready = True
        from fastapi.testclient import TestClient
        client = TestClient(app)
        first = client.post("/v1/jobs", json=dict(requestId="request_0123456789", filename="a.mov", bytes=4, language="ro"), headers=self.headers)
        self.assertEqual(first.status_code, 200)
        second = client.post("/v1/jobs", json=dict(requestId="request_1123456789", filename="a.mov", bytes=4, language="ro"), headers=self.headers)
        self.assertEqual(second.status_code, 507)

    def test_snapshot_enforces_expiry_without_supervisor_poll(self):
        import time
        job = self.create().json()
        directory = self.config.data_dir/job["id"]
        (directory/"source.media").write_bytes(b"1234")
        self.app.state.storage.update(job["id"], expires=time.time()-1)
        response = self.client.get(f'/v1/jobs/{job["id"]}', headers=self.headers)
        self.assertEqual(response.json()["status"], "expired")
        self.assertFalse(directory.exists())

    async def stalled_upload_control(self, expire=False, shutdown=False):
        row = self.app.state.storage.create("request_0123456789", "clip.mov", 8)
        directory = self.config.data_dir/row["id"]
        opened = []
        path_open = Path.open
        def tracked_open(path, *args, **kwargs):
            handle = path_open(path, *args, **kwargs)
            if path.name == "source.part":
                opened.append(handle)
            return handle
        stalled = asyncio.Event()
        blocked = asyncio.Event()
        reads = 0
        async def receive():
            nonlocal reads
            reads += 1
            if reads == 1:
                return {"type": "http.request", "body": b"1234", "more_body": True}
            stalled.set()
            await blocked.wait()
            return {"type": "http.request", "body": b"5678", "more_body": False}
        messages = []
        async def send(message):
            messages.append(message)
        scope = {"type": "http", "asgi": {"version": "3.0"}, "method": "PUT", "scheme": "http",
                 "path": f'/v1/jobs/{row["id"]}/source', "query_string": b"",
                 "headers": [(b"content-length", b"8")],
                 "server": ("localhost", 80), "client": ("localhost", 1)}
        with patch.object(Path, "open", new=tracked_open):
            upload_task = asyncio.create_task(self.app(scope, receive, send))
            try:
                await asyncio.wait_for(stalled.wait(), timeout=1)
                self.assertEqual(len(opened), 1)
                self.assertFalse(opened[0].closed)
                if shutdown:
                    await asyncio.wait_for(self.app.state.supervisor.stop(), timeout=1)
                elif expire:
                    import time
                    self.app.state.storage.update(row["id"], expires=time.time()-1)
                    await asyncio.wait_for(self.app.state.supervisor.tick(), timeout=1)
                else:
                    async def no_body():
                        self.fail("DELETE must not receive the upload body")
                    deletion = []
                    async def delete_send(message):
                        deletion.append(message)
                    delete_scope = dict(scope, method="DELETE", path=f'/v1/jobs/{row["id"]}')
                    await asyncio.wait_for(self.app(delete_scope, no_body, delete_send), timeout=1)
                    self.assertEqual(deletion[0]["status"], 200)
                self.assertTrue(opened[0].closed, "Deletion cannot confirm while source.part has an open descriptor")
                await asyncio.wait_for(upload_task, timeout=.2)
                self.assertEqual(messages[0]["status"], 409)
                expected = "awaiting_upload" if shutdown else "expired" if expire else "cancelled"
                self.assertEqual(self.app.state.storage.get(row["id"])["status"], expected)
                self.assertFalse((directory/"source.part").exists())
                if not shutdown:
                    self.assertFalse(directory.exists())
                self.assertEqual(self.app.state.supervisor.uploads, {})
                self.assertEqual(self.app.state.storage.disk_bytes(), 0)
            finally:
                upload_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await upload_task

    def test_delete_stalled_upload_closes_file_before_confirmation(self):
        asyncio.run(self.stalled_upload_control())

    def test_expiry_stalled_upload_closes_file_before_cleanup(self):
        asyncio.run(self.stalled_upload_control(expire=True))

    def test_shutdown_stalled_upload_closes_file_and_finishes_request(self):
        asyncio.run(self.stalled_upload_control(shutdown=True))


if __name__ == "__main__":
    unittest.main()
