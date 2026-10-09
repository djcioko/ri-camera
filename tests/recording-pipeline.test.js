const test = require("node:test");
const assert = require("node:assert/strict");
const pipeline = require("../recording-pipeline.js");

function fixture(overrides = {}) {
  const events = [];
  const saved = [];
  const source = new Blob(["original camera recording"], { type: "video/webm" });
  const captioned = new Blob(["mp4 with captions"], { type: "video/mp4" });
  const cues = [{ start: 0.2, end: 1.8, text: "Bună ziua, suntem pe șantier." }];
  const deps = {
    persist: async (clip) => { events.push("save:" + clip.subtitleStatus); saved.push({ ...clip }); },
    media: {
      extractAudio: async (blob) => {
        assert.equal(blob, source);
        events.push("audio");
        return { audio: new Float32Array(32000), duration: 2 };
      },
      exportMp4: async (blob, options) => {
        assert.equal(blob, source);
        events.push(options.ass ? "burn" : "convert");
        return captioned;
      },
    },
    speech: { transcribe: async () => { events.push("speech"); return { chunks: [{ text: cues[0].text, timestamp: [0.2, 1.8] }] }; } },
    subtitles: { normalizeCues: () => cues, toAss: () => "[Script Info]\n[Events]" },
    ...overrides,
  };
  return { deps, events, saved, source, captioned, cues };
}

test("Stop saves the original before loading speech or video processing and stores a separate captioned MP4", async () => {
  const f = fixture();
  const clip = await pipeline.finalizeRecording(f.source, { id: 1, site: "Șantier", autoSubtitles: true, width: 1280, height: 720 }, f.deps);
  assert.equal(f.events[0], "save:pending");
  assert.ok(f.events.indexOf("audio") > f.events.indexOf("save:pending"));
  assert.ok(f.events.indexOf("save:rendering") < f.events.indexOf("burn"));
  assert.equal(clip.blob, f.source);
  assert.equal(clip.captionedBlob, f.captioned);
  assert.equal(clip.subtitleStatus, "ready");
  assert.deepEqual(clip.subtitleCues, f.cues);
});

test("a speech failure leaves a downloadable original and a retryable error", async () => {
  const f = fixture({ speech: { transcribe: async () => { throw new Error("Model indisponibil"); } } });
  const clip = await pipeline.finalizeRecording(f.source, { id: 2, autoSubtitles: true }, f.deps);
  assert.equal(clip.blob, f.source);
  assert.equal(clip.subtitleStatus, "failed");
  assert.match(clip.subtitleError, /Model indisponibil/);
  assert.equal(clip.captionedBlob, undefined);
  assert.ok(!f.events.includes("burn"));
});

test("a failed burn preserves timed text and retries export without recognizing the voice again", async () => {
  const f = fixture();
  const originalExport = f.deps.media.exportMp4;
  f.deps.media.exportMp4 = async () => { throw new Error("Memorie insuficientă"); };
  const failed = await pipeline.finalizeRecording(f.source, { id: 3, autoSubtitles: true }, f.deps);
  assert.equal(failed.subtitleStatus, "failed");
  assert.deepEqual(failed.subtitleCues, f.cues);
  f.deps.media.extractAudio = async () => assert.fail("audio extraction must not repeat");
  f.deps.speech.transcribe = async () => assert.fail("speech inference must not repeat");
  f.deps.media.exportMp4 = originalExport;
  const retried = await pipeline.processClip(failed, f.deps);
  assert.equal(retried.subtitleStatus, "ready");
  assert.equal(retried.blob, f.source);
});

test("empty speech produces no invented subtitles and can still produce MP4", async () => {
  const f = fixture({ subtitles: { normalizeCues: () => [], toAss: () => assert.fail("no ASS for silence") } });
  const clip = await pipeline.finalizeRecording(f.source, { id: 4, autoSubtitles: true }, f.deps);
  assert.equal(clip.subtitleStatus, "empty");
  assert.equal(clip.captionedBlob, undefined);
  assert.equal(clip.mp4Blob, f.captioned);
  assert.deepEqual(clip.subtitleCues, []);
  assert.ok(!f.events.includes("burn"));
});

test("subtitles switched off skips ASR and keeps an existing native MP4 without re-encoding", async () => {
  const f = fixture();
  const mp4 = new Blob(["native mp4"], { type: "video/mp4;codecs=avc1" });
  const clip = await pipeline.finalizeRecording(mp4, { id: 5, autoSubtitles: false }, f.deps);
  assert.equal(clip.blob, mp4);
  assert.equal(clip.subtitleStatus, "disabled");
  assert.deepEqual(f.events, ["save:disabled"]);
});

test("cancelling after transcription preserves cues and the original without starting export", async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  const persist = f.deps.persist;
  f.deps.persist = async (clip) => {
    await persist(clip);
    if (clip.subtitleStatus === "rendering") controller.abort();
  };
  const clip = await pipeline.finalizeRecording(f.source, { id: 6, autoSubtitles: true }, f.deps);
  assert.equal(clip.subtitleStatus, "cancelled");
  assert.equal(clip.blob, f.source);
  assert.deepEqual(clip.subtitleCues, f.cues);
  assert.ok(!f.events.includes("burn"));
});

test("storage failure at Stop rejects before heavy processing so the caller can offer emergency download", async () => {
  const f = fixture({ persist: async () => { throw new Error("QuotaExceededError"); } });
  await assert.rejects(pipeline.finalizeRecording(f.source, { id: 7, autoSubtitles: true }, f.deps), /QuotaExceededError/);
  assert.deepEqual(f.events, []);
});

test("an interrupted stored job becomes retryable without affecting completed captions", () => {
  assert.equal(pipeline.recoverInterruptedClip({ subtitleStatus: "transcribing" }).subtitleStatus, "interrupted");
  assert.equal(pipeline.recoverInterruptedClip({ subtitleStatus: "rendering" }).subtitleStatus, "interrupted");
  const done = { subtitleStatus: "ready", subtitleCues: [1] };
  assert.equal(pipeline.recoverInterruptedClip(done), done);
});
