import asyncio
import hmac
import json
import os
import re
import shutil
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import ClientDisconnect

from .config import Config
from .jobs import Supervisor
from .storage import JobError, Storage


def error_response(status, code, message):
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status,
                        headers={"Cache-Control": "no-store"})


class AuthMiddleware:
    """Check the header at the ASGI boundary before anything can consume the body."""
    def __init__(self, app, access_code):
        self.app, self.expected = app, ("Bearer " + access_code).encode("ascii")

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            public = scope["path"] == "/v1/health" and scope["method"] == "GET"
            preflight = scope["method"] == "OPTIONS"
            headers = [value for key, value in scope.get("headers", []) if key.lower() == b"authorization"]
            if not public and not preflight and (len(headers) != 1 or not hmac.compare_digest(headers[0], self.expected)):
                await error_response(401, "unauthorized", "Este necesar un cod privat valid")(scope, receive, send)
                return
        await self.app(scope, receive, send)


def model_ready(config):
    try:
        from .worker import MediaError, verify_model
        verify_model(config.model_dir, full=False)
        return config.font_path.is_file() and bool(shutil.which("ffmpeg")) and bool(shutil.which("ffprobe"))
    except ImportError:
        return False
    except (MediaError, OSError, ValueError, RuntimeError):
        return False


async def bounded_stream(request, deadline):
    stream = request.stream().__aiter__()
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise JobError(408, "upload_timeout", "Timpul permis pentru încărcare a expirat")
        try:
            yield await asyncio.wait_for(anext(stream), timeout=remaining)
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError:
            raise JobError(408, "upload_timeout", "Timpul permis pentru încărcare a expirat")


def create_app(config=None):
    config = config or Config.from_env()
    storage = Storage(config)
    supervisor = Supervisor(config, storage)

    @asynccontextmanager
    async def lifespan(app):
        app.state.ready = model_ready(config)
        supervisor.processing_enabled = app.state.ready
        await supervisor.start()
        try:
            yield
        finally:
            await supervisor.stop()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    app.state.config, app.state.storage, app.state.supervisor = config, storage, supervisor
    app.state.ready = False
    supervisor.processing_enabled = False
    app.add_middleware(AuthMiddleware, access_code=config.access_code)
    app.add_middleware(CORSMiddleware, allow_origins=list(config.allowed_origins), allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Authorization", "Content-Type"],
                       expose_headers=["Content-Length", "Content-Disposition"])

    @app.exception_handler(JobError)
    async def job_error(request, exception):
        return error_response(exception.status, exception.code, exception.message)

    @app.exception_handler(HTTPException)
    async def http_error(request, exception):
        return error_response(exception.status_code, "not_found" if exception.status_code == 404 else "http_error", "Ruta de subtitrare nu este disponibilă")

    @app.exception_handler(Exception)
    async def unexpected_error(request, exception):
        return error_response(500, "internal_error", "Serviciul de subtitrare nu a putut termina cererea")

    @app.get("/v1/health")
    async def health():
        return JSONResponse({"ready": app.state.ready, "limits": config.limits()}, headers={"Cache-Control": "no-store"})

    def snapshot(row):
        return JSONResponse(storage.snapshot(row), headers={"Cache-Control": "no-store"})

    @app.post("/v1/jobs")
    async def create(request: Request):
        if not app.state.ready:
            raise JobError(503, "service_unavailable", "Serviciul de subtitrare nu este pregătit. Reîncearcă mai târziu")
        payload = bytearray()
        async for chunk in bounded_stream(request, time.time() + 30):
            payload.extend(chunk)
            if len(payload) > 16384:
                raise JobError(413, "request_too_large", "Cererea de subtitrare este prea mare")
        try:
            body = json.loads(payload)
        except (ValueError, UnicodeError):
            raise JobError(400, "invalid_request", "Este necesară o cerere JSON validă")
        if not isinstance(body, dict) or set(body) != {"requestId", "filename", "bytes", "language"}:
            raise JobError(400, "invalid_request", "Câmpurile cererii lipsesc sau sunt invalide")
        request_id, filename, size = body["requestId"], body["filename"], body["bytes"]
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
            raise JobError(400, "invalid_request_id", "Este necesară o identitate aleatorie validă")
        if not isinstance(filename, str) or not filename or len(filename) > 255 or any(ord(c) < 32 for c in filename):
            raise JobError(400, "invalid_filename", "Numele originalului este invalid")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0 or body["language"] != "ro":
            raise JobError(400, "invalid_request", "Sunt necesare o dimensiune pozitivă și limba română")
        if size > config.max_input_bytes:
            raise JobError(413, "input_too_large", "Originalul depășește limita de încărcare")
        row = storage.create(request_id, filename, size)
        if row["expires"] <= time.time() and row["status"] != "expired":
            row = await supervisor.expire(row["id"])
        return snapshot(row)

    @app.put("/v1/jobs/{job_id}/source")
    async def upload(job_id: str, request: Request):
        if not app.state.ready:
            raise JobError(503, "service_unavailable", "Serviciul de subtitrare nu este pregătit. Reîncearcă mai târziu")
        with storage.lock:
            row = storage.get(job_id)
            if row["expires"] <= time.time():
                raise JobError(410, "expired", "Rezervarea pentru încărcare a expirat")
            if row["status"] != "awaiting_upload":
                raise JobError(409, "upload_conflict", "Originalul este deja acceptat sau nu mai este disponibil")
            content_length = request.headers.get("content-length")
            if content_length is not None:
                try:
                    declared = int(content_length)
                except ValueError:
                    raise JobError(400, "invalid_length", "Dimensiunea încărcării este invalidă")
                if declared > config.max_input_bytes or declared > row["input_bytes"]:
                    raise JobError(413, "input_too_large", "Încărcarea depășește limita declarată")
                if declared != row["input_bytes"]:
                    raise JobError(400, "length_mismatch", "Dimensiunea încărcării diferă de cea a originalului")
            storage.update(job_id, status="uploading", progress=0, message="Se încarcă originalul")
        task = asyncio.create_task(receive_upload(row, request))
        supervisor.track_upload(job_id, task)
        try:
            return snapshot(await task)
        except asyncio.CancelledError:
            # A server-driven DELETE/expiry stops the child receiver, while the
            # ASGI request itself remains able to send a clean JSON response.
            if asyncio.current_task().cancelling():
                raise
            raise JobError(409, "upload_cancelled", "Încărcarea nu mai este activă")
        finally:
            supervisor.forget_upload(job_id, task)

    async def receive_upload(row, request):
        job_id = row["id"]
        directory, total = storage.path(job_id), 0
        partial = directory / "source.part"
        try:
            with partial.open("xb", buffering=0) as handle:
                os.chmod(partial, 0o600)
                async for chunk in bounded_stream(request, row["expires"]):
                    total += len(chunk)
                    if total > config.max_input_bytes or total > row["input_bytes"]:
                        raise JobError(413, "input_too_large", "Încărcarea depășește limita declarată")
                    with storage.lock:
                        current = storage.get(job_id)
                        if current["status"] != "uploading" or current["expires"] <= time.time():
                            raise JobError(409, "upload_cancelled", "Încărcarea nu mai este activă")
                        storage.ensure_space(len(chunk))
                        handle.write(chunk)
                        storage.update(job_id, progress=total / row["input_bytes"])
                if total != row["input_bytes"]:
                    raise JobError(400, "length_mismatch", "Încărcarea originalului este incompletă")
                handle.flush()
                os.fsync(handle.fileno())
            with storage.lock:
                if storage.get(job_id)["status"] != "uploading":
                    raise JobError(409, "upload_cancelled", "Încărcarea nu mai este activă")
                os.replace(partial, directory / "source.media")
                row = storage.update(job_id, status="queued", progress=0, message="În așteptarea procesării",
                                     expires=time.time() + config.retention_seconds)
            return row
        except BaseException as exception:
            partial.unlink(missing_ok=True)
            with storage.lock:
                if storage.get(job_id)["status"] == "uploading":
                    if row["expires"] <= time.time():
                        storage.remove_files(job_id)
                        storage.update(job_id, status="expired", progress=0, message="Încărcarea a expirat")
                    else:
                        storage.update(job_id, status="awaiting_upload", progress=0, message="Încărcarea trebuie reluată")
            if isinstance(exception, (ClientDisconnect, OSError)):
                raise JobError(400, "upload_interrupted", "Încărcarea originalului a fost întreruptă")
            raise

    @app.get("/v1/jobs/{job_id}")
    async def get_job(job_id: str):
        row = storage.get(job_id)
        if row["expires"] <= time.time() and row["status"] != "expired":
            row = await supervisor.expire(job_id)
        return snapshot(row)

    async def artifact(job_id, name, media_type):
        row = storage.get(job_id)
        if row["status"] not in {"ready", "empty"}:
            raise JobError(409, "result_unavailable", "Rezultatul subtitrării nu este încă disponibil")
        if row["expires"] <= time.time():
            raise JobError(410, "expired", "Rezultatul subtitrării a expirat")
        directory = storage.path(job_id)
        try:
            supervisor.validated_result(directory)
        except (OSError, ValueError, TypeError, AttributeError):
            raise JobError(409, "result_unavailable", "Rezultatul subtitrării nu a putut fi verificat")
        return FileResponse(directory / name, media_type=media_type, filename=name, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @app.get("/v1/jobs/{job_id}/output")
    async def output(job_id: str):
        return await artifact(job_id, "output.mp4", "video/mp4")

    @app.get("/v1/jobs/{job_id}/subtitles")
    async def subtitles(job_id: str):
        return await artifact(job_id, "subtitles.srt", "application/x-subrip")

    @app.delete("/v1/jobs/{job_id}")
    async def delete(job_id: str):
        return snapshot(await supervisor.cancel(job_id))

    return app
