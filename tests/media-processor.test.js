const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// FFmpeg's real browser wrapper runs against a deterministic Worker transport.
// Actual codecs and subtitle rendering are covered by the browser smoke test.
function fixture(options = {}) {
  const workers = [];
  const fetches = [];
  const revoked = [];
  const objectURLs = new Map();
  let resolveExec;
  const executionStarted = new Promise((resolve) => { resolveExec = resolve; });
  let resolveLoad;
  const loadingStarted = new Promise((resolve) => { resolveLoad = resolve; });
  const pcm = new Float32Array([0, 0.25, -0.5, 0.75]);
  const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 109, 112, 52, 50]);

  class Worker {
    constructor(url) {
      if (options.failOnOverlap && workers.some((worker) => !worker.terminated)) {
        throw new Error("Two video engines overlapped in memory");
      }
      this.url = String(url);
      this.messages = [];
      this.files = new Map();
      this.terminated = false;
      workers.push(this);
    }
    terminate() { this.terminated = true; }
    postMessage(message) {
      this.messages.push(message);
      queueMicrotask(() => {
        if (this.terminated) return;
        const { id, type, data } = message;
        if (type === "LOAD") resolveLoad();
        if (type === "LOAD" && options.crashLoad) {
          this.onerror?.({ message: "WASM worker crashed", preventDefault() {} });
          return;
        }
        if (type === "LOAD" && options.pauseLoad) return;
        if (type === "EXEC") {
          resolveExec();
          if (options.pauseExec) return;
          if (options.noAudio) {
            this.onmessage?.({ data: { type: "LOG", data: { message: "Stream map '0:a:0' matches no streams." } } });
          }
          this.onmessage?.({ data: { type: "PROGRESS", data: { progress: 0.5, time: 500000 } } });
        }
        if (type === "WRITE_FILE") this.files.set(data.path, data.data);
        let result = true;
        if (type === "EXEC") result = options.noAudio ? 1 : (options.exitCode || 0);
        if (type === "READ_FILE") {
          const bytes = data.path.endsWith(".f32") ? new Uint8Array(pcm.buffer) : (options.output || mp4);
          // A nonzero byteOffset catches accidental use of a full backing buffer.
          const wrapped = new Uint8Array(bytes.length + 8);
          wrapped.set(bytes, 4);
          result = options.emptyOutput ? new Uint8Array(0) : wrapped.subarray(4, 4 + bytes.length);
        }
        this.onmessage?.({ data: { id, type, data: result } });
      });
    }
  }
  class FixtureURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:https://example.test/${objectURLs.size}`;
      objectURLs.set(url, blob);
      return url;
    }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const sandbox = {
    Blob, URL: FixtureURL, Worker, Uint8Array, Float32Array, ArrayBuffer, DataView,
    TextEncoder, DOMException, AbortController, AbortSignal, Response, Request,
    setTimeout, clearTimeout, queueMicrotask, console,
    location: { href: "https://example.test/ri-camera/" },
    document: {
      baseURI: "https://example.test/ri-camera/",
      currentScript: { src: "https://example.test/ri-camera/vendor/ffmpeg/ffmpeg.js" },
    },
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      if (options.fetch) return options.fetch(url, init, fetches.length);
      return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 });
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  if (options.cache) {
    const stored = new Map();
    sandbox.caches = { open: async () => ({
      match: async (url) => stored.get(url)?.clone(),
      put: async (url, response) => { stored.set(url, response.clone()); },
    }) };
  }
  const context = vm.createContext(sandbox);
  const root = path.resolve(__dirname, "..");
  const vendor = path.join(root, "vendor/ffmpeg/ffmpeg.js");
  if (fs.existsSync(vendor)) vm.runInContext(fs.readFileSync(vendor, "utf8"), context);
  sandbox.document.currentScript.src = "https://example.test/ri-camera/media-processor.js";
  const implementation = path.join(root, "media-processor.js");
  if (fs.existsSync(implementation)) vm.runInContext(fs.readFileSync(implementation, "utf8"), context);
  const media = sandbox.RIMediaProcessor;
  return { media, workers, fetches, revoked, objectURLs, executionStarted, loadingStarted, pcm, mp4, sandbox };
}

function processor(f) {
  assert.equal(typeof f.media?.extractAudio, "function", "public audio extraction API exists");
  assert.equal(typeof f.media?.exportMp4, "function", "public MP4 export API exists");
  return f.media;
}

test("audio extraction returns mono PCM samples and sample-accurate duration", async () => {
  const f = fixture();
  const original = new Blob(["recorded bytes"], { type: "video/webm" });
  const result = await processor(f).extractAudio(original);
  assert.deepEqual(Array.from(result.audio), Array.from(f.pcm));
  assert.equal(result.duration, f.pcm.length / 16000);
  assert.equal(await original.text(), "recorded bytes");
  assert.ok(f.workers.every((worker) => worker.terminated));
  assert.equal(f.revoked.length, 2);
});

test("a recording without an audio stream rejects instead of inventing silent samples", async () => {
  const f = fixture({ noAudio: true });
  await assert.rejects(processor(f).extractAudio(new Blob(["video"])), /audio|sunet|microfon/i);
  assert.ok(f.workers.every((worker) => worker.terminated));
});

test("export returns only output bytes in an MP4 blob and writes Romanian ASS text with its font", async () => {
  const f = fixture();
  const ass = "[Script Info]\n; Șțâîă\n";
  const result = await processor(f).exportMp4(new Blob(["video"]), { ass, duration: 1 });
  assert.equal(result.type, "video/mp4");
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), f.mp4);
  const files = f.workers[0].files;
  assert.ok(Array.from(files.values()).some((data) => new TextDecoder().decode(data) === ass));
  assert.ok(Array.from(files.keys()).some((name) => name.endsWith(".ttf")));
  assert.ok(f.workers.every((worker) => worker.terminated));
});

test("FFmpeg failure never exposes a partial downloadable MP4", async () => {
  const f = fixture({ exitCode: 1 });
  await assert.rejects(processor(f).exportMp4(new Blob(["video"])), /MP4|export|conversi/i);
  assert.ok(f.workers.every((worker) => worker.terminated));
});

test("an empty engine output rejects", async () => {
  const f = fixture({ emptyOutput: true });
  await assert.rejects(processor(f).extractAudio(new Blob(["video"])), /gol|audio|sunet/i);
  assert.ok(f.workers.every((worker) => worker.terminated));
});

test("an already cancelled request never starts downloading or creating a worker", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(processor(f).exportMp4(new Blob(["video"]), { signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.fetches.length, 0);
  assert.equal(f.workers.length, 0);
});

test("cancelling execution rejects promptly and terminates the busy worker", async () => {
  const f = fixture({ pauseExec: true });
  const controller = new AbortController();
  const running = processor(f).extractAudio(new Blob(["video"]), { signal: controller.signal });
  await f.executionStarted;
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.ok(f.workers.every((worker) => worker.terminated));
});

test("HTTP failure rejects before treating an error page as the FFmpeg engine", async () => {
  const f = fixture({ fetch: async () => new Response("missing", { status: 404 }) });
  await assert.rejects(processor(f).exportMp4(new Blob(["video"])), /404|încărc|descărc/i);
  assert.ok(f.workers.every((worker) => worker.terminated));
});

test("operations queued behind extraction do not allocate overlapping engine workers", async () => {
  const f = fixture({ failOnOverlap: true });
  const media = processor(f);
  const results = await Promise.all([
    media.extractAudio(new Blob(["video"])),
    media.exportMp4(new Blob(["video"])),
  ]);
  assert.equal(results.length, 2);
  assert.equal(f.workers.length, 2);
  assert.ok(f.workers.every((worker) => worker.terminated));
});

test("cancelling engine initialization frees its Worker and all Blob URLs", async () => {
  const f = fixture({ pauseLoad: true });
  const controller = new AbortController();
  const pending = processor(f).exportMp4(new Blob(["video"]), { signal: controller.signal });
  await f.loadingStarted;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  // Wait for the internal finally after the externally cancellable queue settles.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.workers.every((worker) => worker.terminated));
  assert.equal(f.revoked.length, f.objectURLs.size);
});

test("cancelling a pending engine download aborts the underlying fetch", async () => {
  let started;
  let fetchAborted = false;
  const downloadStarted = new Promise((resolve) => { started = resolve; });
  const f = fixture({ fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      fetchAborted = true;
      reject(new DOMException("Aborted", "AbortError"));
    });
    started();
  }) });
  const controller = new AbortController();
  const pending = processor(f).extractAudio(new Blob(["video"]), { signal: controller.signal });
  await downloadStarted;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(fetchAborted, true);
  assert.equal(f.workers.length, 0);
});

test("a temporary CDN outage is retried and can still produce an MP4", async () => {
  const f = fixture({ fetch: async (_url, _init, call) => new Response("core", { status: call === 1 ? 503 : 200 }) });
  const result = await processor(f).exportMp4(new Blob(["video"]));
  assert.equal(result.type, "video/mp4");
  assert.ok(result.size > 0);
});

test("a later export works offline using the versioned core cache", async () => {
  let offline = false;
  const f = fixture({ cache: true, fetch: async () => {
    if (offline) throw new Error("Offline");
    return new Response("core", { status: 200 });
  } });
  const media = processor(f);
  await media.extractAudio(new Blob(["video"]));
  offline = true;
  const result = await media.exportMp4(new Blob(["video"]));
  assert.equal(result.type, "video/mp4");
  assert.ok(result.size > 0);
});

test("a non-MP4 output cannot be relabeled as downloadable MP4", async () => {
  const f = fixture({ output: new Uint8Array(20).fill(1) });
  await assert.rejects(processor(f).exportMp4(new Blob(["video"])), /MP4 valid/i);
});

test("the vendored wrapper rejects pending calls when its Worker crashes", async () => {
  const f = fixture({ crashLoad: true });
  assert.equal(typeof f.sandbox.FFmpegWASM?.FFmpeg, "function", "official wrapper is available");
  const engine = new f.sandbox.FFmpegWASM.FFmpeg();
  let timer;
  try {
    const outcome = await Promise.race([
      engine.load().then(() => "loaded", (error) => error),
      new Promise((resolve) => { timer = setTimeout(() => resolve("hung"), 100); }),
    ]);
    assert.notEqual(outcome, "hung", "worker crashes must reject load rather than leave it pending");
    assert.match(String(outcome), /worker|WASM/i);
    assert.equal(engine.loaded, false);
    assert.ok(f.workers.every((worker) => worker.terminated));
  } finally {
    clearTimeout(timer);
    engine.terminate();
  }
});
