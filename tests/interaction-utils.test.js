const test = require("node:test");
const assert = require("node:assert/strict");

const overlay = require("../overlay-utils.js");
const media = require("../media-utils.js");

test("scaling an overlay preserves its PNG aspect ratio and keeps it inside the canvas", () => {
  const state = { x: 70, y: 40, w: 100, h: 50, aspect: 2 };
  const scaled = overlay.scaleOverlay(state, 3, { width: 240, height: 160 });

  assert.equal(scaled.w / scaled.h, 2);
  assert.ok(scaled.x >= 0);
  assert.ok(scaled.y >= 0);
  assert.ok(scaled.x + scaled.w <= 240);
  assert.ok(scaled.y + scaled.h <= 160);
});

test("recording format prefers real MP4 and identifies WebM conversion fallback", () => {
  const mp4 = media.selectRecordingFormat((type) => type.startsWith("video/mp4"));
  assert.equal(mp4.extension, "mp4");
  assert.equal(mp4.needsConversion, false);

  const webm = media.selectRecordingFormat((type) => type === "video/webm");
  assert.equal(webm.extension, "webm");
  assert.equal(webm.needsConversion, true);
});

test("a WebM recording is converted before it becomes downloadable", async () => {
  const webm = { type: "video/webm" };
  const mp4 = { type: "video/mp4" };
  let convertedInput = null;

  const result = await media.finalizeRecordingBlob(webm, async (input) => {
    convertedInput = input;
    return mp4;
  });

  assert.equal(convertedInput, webm);
  assert.equal(result, mp4);
});
