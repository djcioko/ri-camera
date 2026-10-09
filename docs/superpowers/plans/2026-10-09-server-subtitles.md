# Server Subtitle Module Implementation Plan

> **For agentic workers:** Use the established collaborative execution method; independent components are implemented in parallel against the shared contract, followed by integration and whole-branch review. Steps use checkbox notation.

**Goal:** Add a separate subtitle module backed by the selected djcioko.ro VPS, with protected original recordings and MP4/SRT results.

**Architecture:** A static panel and remote pipeline use a two-phase authenticated jobs API. FastAPI persists queue state in SQLite and supervises one isolated faster-whisper/FFmpeg process. An idempotent installer configures the existing VPS without replacing its Nginx configuration.

**Tech Stack:** Existing vanilla JavaScript PWA; Python 3.12+, FastAPI 0.143.0, Uvicorn 0.54.0, faster-whisper 1.2.1, CTranslate2 4.8.2, FFmpeg, SQLite, systemd/Nginx.

**Spec:** `docs/superpowers/specs/2026-10-09-server-subtitles-design.md`

## Global Constraints

- Implement the exact HTTP v1 and worker-file contracts in the spec.
- Do not store an access code in source, IndexedDB, URLs or logs.
- Preserve the original before any upload; avoid browser ASR/FFmpeg in server mode.
- Keep local processing available explicitly and preserve the existing recording tests.
- No active SSH connection exists here: do not claim a live VPS installation.
- Limits: 512 MiB input, 900 s media, 3 pending jobs, 4 GiB spool, 2 GiB free reserve, 24 h retention, 15-minute upload reservations, 3600 s job timeout.

## Review Focus

- Lost POST/PUT responses must reconnect to one job (API and client tests).
- Browser reload, deletion or a new retry must not be overwritten by stale callbacks (pipeline/storage tests).
- Cancellation must stop descendants and never turn an unconfirmed HTTP request into a success claim (supervisor/client tests).
- Untrusted media, timing offsets, rotation and malformed output must not produce a misleading ready clip (native media tests).
- Existing Nginx installations and insufficient VPS resources must produce a safe preflight failure (installer fixture tests).

---

## Task 1: API and queue

**Files:** `server/ri_subtitles/{__init__,config,storage,api,jobs}.py`, `server/requirements*.txt`, `server/tests/test_api.py`, `server/tests/test_jobs.py`.

**Interfaces:** API routes and snapshots from the spec; `create_app(config=None)` for Uvicorn factory and tests. The supervisor consumes worker `progress.json`/`result.json` and fixed artifact names. Expose validated configuration for the worker CLI and offline model path.

- [ ] Write and run failing tests for authentication-before-body, idempotent create, bounded streamed PUT, missing/partial sources and output authorization.
- [ ] Implement configuration, private storage and HTTP routes.
- [ ] Write and run failing tests for one active process, cancellation, timeout, restart recovery and expiry.
- [ ] Implement the supervisor with injectable worker command for tests, no test branches in production behavior.
- [ ] Run API/queue tests and validate a real local HTTP request with the pinned API dependencies.

## Task 2: Native media processor

**Files:** `server/ri_subtitles/{worker,subtitles}.py`, `server/tests/test_worker.py`, `server/tests/test_subtitles.py`, `server/scripts/download_model.py`.

**Interfaces:** Exact worker command, progress and result files from the spec; no coupling to the API database. The downloader validates the fixed revision and checksum before a worker may load the model offline.

- [ ] Write and run failing tests for normalized word cues, Romanian/ASS escaping and timestamp carry.
- [ ] Implement subtitle formatting and timing validation.
- [ ] Write and run failing media-fixture tests for invalid/oversized/offset/rotated video and output validation.
- [ ] Implement probe, audio extraction, real ASR adapter and native MP4 export with deadlines and bounded subprocess output.
- [ ] Verify real FFmpeg output, audio presence, aspect/orientation and visible diacritics; perform real human Romanian ASR if the model can be downloaded.

## Task 3: Browser module and persistence

**Files:** `server-subtitle-client.js`, `server-subtitle-pipeline.js`, `subtitle-module.js`, `app.js`, `recording-pipeline.js`, `index.html`, `styles.css`, `sw.js`, `tests/server-*.test.js`, relevant existing lifecycle tests.

**Interfaces:** Fixed default HTTPS base URL from the spec; client `createJob`, `uploadSource`, `getJob`, `downloadOutput`, `cancelJob`; server pipeline `processClip(clip, dependencies)`; atomic IndexedDB patch conditioned on current request ID.

- [ ] Write and run failing client/pipeline tests for saved originals, no local engines, lost responses, reload, unconfirmed cancellation and stale callbacks.
- [ ] Implement the HTTP client and remote pipeline against the shared API schema.
- [ ] Implement the separate subtitle panel, file/archive selection, in-memory access code and explicit processor selection.
- [ ] Preserve imported names and bypass browser metadata requirements in server mode; prevent camera startup for the subtitle route.
- [ ] Update the PWA shell version and run the full Node regression suite.

## Task 4: Installation, review and delivery

**Files:** `server/deploy/*`, `server/scripts/inspect_vps.sh`, `server/README.md`, root `README.md`, deployment fixture tests.

- [ ] Write and run failing tests for precise Nginx vhost selection, idempotent include insertion and preservation of unrelated blocks.
- [ ] Implement preflight, dedicated runtime/model/state directories, secret generation, socket/systemd and rollback-capable Nginx setup.
- [ ] Run syntax checks, package installation checks, full API/Node tests and an integrated HTTP upload-to-output smoke test.
- [ ] Review the complete branch, resolve concrete findings and document verified results and missing VPS access.
- [ ] Push the reviewed branch, create a PR for Cioko and provide a pinned installation command. Production activation remains pending real VPS execution evidence.
