const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fixture() {
  const elements = new Map();
  const records = new Map();
  const cameraTrack = { readyState: "live", stop() {} };
  const originalBytes = "camera recording, retained after Stop";
  const captionedBlob = new Blob(["finished MP4 with subtitles"], { type: "video/mp4" });
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        value: "", textContent: "", checked: false, disabled: false,
        style: {}, dataset: {}, width: 1280, height: 720,
        readyState: 0, HAVE_CURRENT_DATA: 2,
        classList: {
          add: (name) => classes.add(name), remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name),
          toggle(name, force) {
            const present = force === undefined ? !classes.has(name) : force;
            if (present) classes.add(name); else classes.delete(name);
          },
        },
        setAttribute() {}, addEventListener() {},
        getContext: () => ({}),
        captureStream: () => ({ getVideoTracks: () => [cameraTrack], addTrack() {} }),
      });
    }
    return elements.get(id);
  };
  const sandbox = {
    Blob, AbortController, DOMException, Float32Array, URL, performance,
    console: { error() {}, warn() {}, log() {} },
    document: { getElementById: element, addEventListener() {}, visibilityState: "visible" },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    // Park unrelated page initialization before camera access. The tests supply
    // the store adapter below while exercising the actual persistence boundary.
    indexedDB: { open: () => ({}) },
    Image: class { addEventListener() {} },
    MediaRecorder: class {
      static isTypeSupported() { return true; }
      constructor(_stream, options) { this.mimeType = options.mimeType; this.state = "inactive"; }
      start() { this.state = "recording"; }
    },
    RIMediaUtils: require("../media-utils.js"),
    RIOverlayUtils: require("../overlay-utils.js"),
    RISubtitleUtils: require("../subtitle-utils.js"),
    RIRecordingPipeline: require("../recording-pipeline.js"),
    RIMediaProcessor: {
      extractAudio: async () => ({ audio: new Float32Array([0.1, 0.2]), duration: 2 }),
      exportMp4: async () => captionedBlob,
    },
    RISpeechRecognizer: {
      transcribe: async () => ({ text: "Bună ziua.", chunks: [{ text: "Bună ziua.", timestamp: [0, 1] }] }),
    },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
    requestAnimationFrame() {}, addEventListener() {}, alert() {},
    cameraStream: { getVideoTracks: () => [cameraTrack], getAudioTracks: () => [] },
    storeAdapter: async (_mode, action) => {
      const request = action({
        put(clip) { records.set(clip.id, { ...clip }); return { result: clip.id }; },
        getAll() { return { result: [...records.values()] }; },
      });
      return request && request.result;
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve("../app.js"), "utf8"), context);
  vm.runInContext("useClipsStore = storeAdapter; stream = cameraStream; refreshLibrary = async () => {};", context);
  return {
    context, records, captionedBlob, element,
    async stopWithRepaintFailure() {
      vm.runInContext("startRecording();", context);
      const recorder = vm.runInContext("mediaRecorder", context);
      recorder.ondataavailable({ data: new Blob([originalBytes], { type: recorder.mimeType }) });
      vm.runInContext("refreshLibrary = async () => { throw new Error('Archive repaint failed'); };", context);
      await recorder.onstop();
    },
  };
}

test("Stop retains the original and clears busy state when archive repaint fails", async () => {
  const f = fixture();
  f.context.RIMediaProcessor.extractAudio = async () => { throw new Error("Model processing unavailable"); };

  await f.stopWithRepaintFailure();

  assert.equal(f.records.size, 1);
  const saved = [...f.records.values()][0];
  assert.equal(await saved.blob.text(), "camera recording, retained after Stop");
  assert.equal(saved.subtitleStatus, "failed");
  assert.equal(vm.runInContext("processing", f.context), false);
  assert.equal(vm.runInContext("processingController", f.context), null);
  assert.equal(vm.runInContext("emergencyClip", f.context), null);
});

test("a repaint failure after a committed export cannot remove the captioned MP4", async () => {
  const f = fixture();
  const original = new Blob(["saved original"], { type: "video/webm" });
  const clip = { id: 123, blob: original, autoSubtitles: true, subtitleStatus: "rendering", subtitleCues: [{ start: 0, end: 1, text: "Bună." }] };
  f.records.set(clip.id, clip);
  f.context.clipToProcess = clip;
  vm.runInContext("processingController = new AbortController(); refreshLibrary = async () => { throw new Error('Archive repaint failed after commit'); };", f.context);

  await vm.runInContext("RIRecordingPipeline.processClip(clipToProcess, pipelineDependencies())", f.context);

  const saved = f.records.get(clip.id);
  assert.equal(saved.subtitleStatus, "ready");
  assert.equal(saved.captionedBlob, f.captionedBlob);
  assert.equal(saved.blob, original);
});

test("an error entering processing still offers the recorded original and releases the lock", async () => {
  const f = fixture();
  vm.runInContext("startRecording();", f.context);
  const recorder = vm.runInContext("mediaRecorder", f.context);
  recorder.ondataavailable({ data: new Blob(["unsaved camera recording"], { type: recorder.mimeType }) });
  vm.runInContext(`
    const realUpdateBusyUi = updateBusyUi;
    let failNextBusyUpdate = true;
    updateBusyUi = () => {
      if (failNextBusyUpdate) { failNextBusyUpdate = false; throw new Error("Processing UI failed"); }
      realUpdateBusyUi();
    };
  `, f.context);

  await recorder.onstop();

  const rescued = vm.runInContext("emergencyClip", f.context);
  assert.ok(rescued && rescued.blob);
  assert.equal(await rescued.blob.text(), "unsaved camera recording");
  assert.equal(vm.runInContext("processing", f.context), false);
  assert.equal(vm.runInContext("processingController", f.context), null);
  assert.equal(vm.runInContext("mediaRecorder", f.context), null);
});

test("camera opening blocks rapid flips and recording until preview is ready, and releases failed streams", async () => {
  const f = fixture();
  const requests = [];
  const stopped = [];
  const makeStream = (name) => {
    const track = { readyState: "live", getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }), stop: () => stopped.push(name) };
    return { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  };
  f.context.navigator.mediaDevices = {
    getUserMedia: () => new Promise((resolve) => requests.push(resolve)),
  };
  let previewReady;
  f.element("liveVideo").play = () => new Promise((resolve) => { previewReady = resolve; });
  f.context.cameraAudioContext = {
    state: "running",
    createMediaStreamSource: () => ({ connect() {} }),
    createAnalyser: () => ({ frequencyBinCount: 8, getByteTimeDomainData: (array) => array.fill(128) }),
  };
  vm.runInContext("stream = null; audioCtx = cameraAudioContext;", f.context);

  const opening = vm.runInContext("startCamera()", f.context);
  assert.equal(f.element("btnFlipBig").disabled, true);
  assert.equal(f.element("btnRec").disabled, true);
  await vm.runInContext("flipCamera()", f.context);
  assert.equal(requests.length, 1);
  const firstStream = makeStream("first");
  requests[0](firstStream);
  await Promise.resolve();
  await vm.runInContext("flipCamera()", f.context);
  vm.runInContext("startRecording();", f.context);
  assert.equal(requests.length, 1);
  assert.equal(vm.runInContext("mediaRecorder", f.context), null);
  assert.equal(f.element("btnRec").disabled, true);

  previewReady();
  await opening;
  assert.equal(vm.runInContext("stream", f.context), firstStream);
  assert.equal(f.element("btnFlipBig").disabled, false);
  assert.equal(f.element("btnRec").disabled, false);

  f.element("liveVideo").play = async () => { throw new Error("Preview failed"); };
  const flipping = vm.runInContext("flipCamera()", f.context);
  assert.equal(requests.length, 2);
  requests[1](makeStream("failed"));
  await flipping;
  assert.deepEqual(stopped, ["first", "failed"]);
  assert.equal(vm.runInContext("stream", f.context), null);
  assert.equal(f.element("btnFlipBig").disabled, false);
  assert.equal(f.element("btnRec").disabled, true);
});
