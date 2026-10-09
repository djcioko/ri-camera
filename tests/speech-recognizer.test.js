const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const filename = path.join(__dirname, "../speech-recognizer.js");
  assert.ok(fs.existsSync(filename), "the speech recognizer must be available");
  const workers = [];
  const timers = new Map();
  let timerId = 0;
  class Worker {
    constructor(url, options) {
      this.url = String(url);
      this.options = options;
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message, transfer) {
      this.message = message;
      this.transfer = transfer;
    }
    terminate() { this.terminated = true; }
    emit(data) { if (this.onmessage) this.onmessage({ data }); }
    fail(message) {
      if (this.onerror) this.onerror({ message, preventDefault() {} });
    }
  }
  const context = {
    module: { exports: {} }, Worker, URL, Float32Array, DOMException,
    document: { currentScript: { src: "https://example.test/ri-camera/speech-recognizer.js" } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return { api: context.module.exports, workers, timers };
}

function speech() {
  return Float32Array.from({ length: 16000 }, (_, index) => Math.sin(index * 0.13) * 0.1);
}

test("near-silent audio finishes without downloading a speech model", async () => {
  const { api, workers } = harness();
  const result = await api.transcribe(new Float32Array(32000).fill(0.00001));
  assert.equal(result.text, "");
  assert.equal(result.chunks.length, 0);
  assert.equal(workers.length, 0);
});

test("a completed transcript retains timed Romanian words and releases its worker", async () => {
  const { api, workers, timers } = harness();
  const progress = [];
  const audio = speech();
  const pending = api.transcribe(audio, { onProgress: (message) => progress.push(message) });
  const worker = workers[0];
  assert.equal(worker.url, "https://example.test/ri-camera/subtitle-worker.js");
  assert.equal(worker.options.type, "module");
  worker.emit({ type: "progress", message: "Se transcrie în limba română…" });
  const expected = { text: "Știință și țară.", chunks: [
    { text: "Știință", timestamp: [0, 0.4] },
    { text: " și", timestamp: [0.4, 0.6] },
    { text: " țară.", timestamp: [0.6, 1] },
  ] };
  worker.emit({ type: "result", result: expected });
  const result = await pending;
  assert.deepEqual(result, expected);
  assert.ok(progress.includes("Se transcrie în limba română…"));
  assert.ok(worker.terminated);
  assert.equal(timers.size, 0);
});

test("extreme decoder token loops fail retryably instead of becoming captions", async () => {
  const { api, workers, timers } = harness();
  const pending = api.transcribe(speech());
  const text = "Bună ziua suntem pe șantier" + "-r".repeat(137);
  workers[0].emit({ type: "result", result: { text, chunks: [
    { text, timestamp: [0, 1] },
  ] } });
  await assert.rejects(pending, /repetiții.*Reîncearcă/);
  assert.ok(workers[0].terminated);
  assert.equal(timers.size, 0);
});

test("extreme repeating phrases also fail without silently shortening the transcript", async () => {
  const { api, workers } = harness();
  const pending = api.transcribe(speech());
  const text = "Vă mulțumesc pentru vizionare. ".repeat(10);
  workers[0].emit({ type: "result", result: { text, chunks: [
    { text, timestamp: [0, 1] },
  ] } });
  await assert.rejects(pending, /repetiții/);
  assert.ok(workers[0].terminated);
});

test("normal spoken repetitions remain intact", async () => {
  const { api, workers } = harness();
  const pending = api.transcribe(speech());
  const text = "Da, da, da! Mai încercăm. Și apoi montăm geamul, geamul, geamul.";
  const expected = { text, chunks: [{ text, timestamp: [0, 1] }] };
  workers[0].emit({ type: "result", result: expected });
  assert.deepEqual(await pending, expected);
});

test("cancelling an active transcription settles immediately and releases memory", async () => {
  const { api, workers, timers } = harness();
  const controller = new AbortController();
  const pending = api.transcribe(speech(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(workers[0].terminated);
  assert.equal(timers.size, 0);
});

test("an already-cancelled operation never starts a worker", async () => {
  const { api, workers } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.transcribe(speech(), { signal: controller.signal }), { name: "AbortError" });
  assert.equal(workers.length, 0);
});

test("a worker module import failure rejects instead of leaving the recording busy", async () => {
  const { api, workers, timers } = harness();
  const pending = api.transcribe(speech());
  workers[0].fail("Failed to fetch dynamically imported module");
  await assert.rejects(pending, /transcriere/i);
  assert.ok(workers[0].terminated);
  assert.equal(timers.size, 0);
});

test("a model error rejects and releases its worker", async () => {
  const { api, workers, timers } = harness();
  const pending = api.transcribe(speech());
  workers[0].emit({ type: "error", message: "Modelul vocal nu s-a putut încărca." });
  await assert.rejects(pending, /Modelul vocal/);
  assert.ok(workers[0].terminated);
  assert.equal(timers.size, 0);
});

test("a stalled worker has a finite deadline and is terminated", async () => {
  const { api, workers, timers } = harness();
  const pending = api.transcribe(speech());
  const deadline = [...timers.values()][0];
  assert.ok(deadline.delay > 0 && deadline.delay <= 30 * 60 * 1000);
  deadline.fn();
  await assert.rejects(pending, { name: "TimeoutError" });
  assert.ok(workers[0].terminated);
  assert.equal(timers.size, 0);
});

test("invalid audio is rejected before allocating a worker", async () => {
  const { api, workers } = harness();
  await assert.rejects(api.transcribe(new Float32Array([0.2, NaN, 0.3])), /audio/i);
  assert.equal(workers.length, 0);
});
