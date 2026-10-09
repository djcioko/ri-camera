// Optional integration smoke test. Requires Playwright + Chromium.
// The camera, MediaRecorder, IndexedDB and FFmpeg WASM run for real. The first
// caption transcript is deterministic unless RI_REAL_SPEECH_WAV points to a WAV.
// Run: node tests/browser-smoke.cjs
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + "/playwright" : "playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const outputDir = process.env.RI_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), "ri-camera-qa-"));
fs.mkdirSync(outputDir, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf", ".wav": "audio/wav" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/speech-fixture.wav" && process.env.RI_REAL_SPEECH_WAV) {
    res.writeHead(200, { "Content-Type": "audio/wav" });
    fs.createReadStream(process.env.RI_REAL_SPEECH_WAV).pipe(res);
    return;
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/ri-camera\/?/, "");
  const filename = path.resolve(root, relative || "index.html");
  if (!filename.startsWith(root + path.sep) && filename !== path.join(root, "index.html")) {
    res.writeHead(403).end(); return;
  }
  fs.readFile(filename, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(filename)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
});

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.RI_CHROMIUM_EXECUTABLE || undefined,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream=fps=60", "--use-fake-ui-for-media-stream"],
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } } : {}),
  });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"], ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.log("PAGE_ERROR", error.message); });
    page.on("console", (message) => { if (message.type() === "error") console.log("BROWSER", message.text()); });
    page.on("dialog", (dialog) => { console.log("DIALOG", dialog.message()); return dialog.dismiss(); });
    await page.exposeFunction("reportProgress", (value) => console.log("STATUS", value));
    await page.goto(origin + "/ri-camera/", { waitUntil: "networkidle" });
    await page.waitForFunction(() => !document.getElementById("btnRec").disabled && document.getElementById("renderCanvas").width > 1);
    assert.equal(await page.locator("#chkSubtitles").isChecked(), true);
    assert.equal(await page.evaluate(() => crossOriginIsolated), false);
    console.log("CAMERA_READY", await page.locator("#techInfoBadge").innerText());
    await page.evaluate(() => {
      new MutationObserver(() => window.reportProgress(document.getElementById("exportStatus").textContent))
        .observe(document.getElementById("exportStatus"), { childList: true, subtree: true });
    });
    let captureMs = 2600;
    if (process.env.RI_REAL_SPEECH_WAV) {
      captureMs = await page.evaluate(async (origin) => {
        const soundContext = new AudioContext();
        await soundContext.resume();
        const buffer = await soundContext.decodeAudioData(await (await fetch(origin + "/speech-fixture.wav")).arrayBuffer());
        const source = soundContext.createBufferSource();
        source.buffer = buffer;
        const destination = soundContext.createMediaStreamDestination();
        source.connect(destination);
        for (const track of stream.getAudioTracks()) stream.removeTrack(track);
        stream.addTrack(destination.stream.getAudioTracks()[0]);
        window.testSpeechSource = source;
        window.testSpeechContext = soundContext;
        return Math.ceil((buffer.duration + 0.5) * 1000);
      }, origin);
    } else {
      await page.evaluate(() => { RISpeechRecognizer.transcribe = async () => ({
        text: "Bună ziua! Lucrăm pe șantier.",
        chunks: [
          { text: "Bună ziua!", timestamp: [0.1, 1] },
          { text: "Lucrăm pe șantier.", timestamp: [1, 2.3] },
        ],
      }); });
    }
    await page.locator("#siteName").fill("Pipera — șantier nou");
    await page.locator("#btnRec").click();
    await page.waitForFunction(() => document.getElementById("btnRec").classList.contains("on"));
    if (process.env.RI_REAL_SPEECH_WAV) await page.evaluate(() => window.testSpeechSource.start());
    // A real capture interval, not a synchronization substitute.
    await new Promise((resolve) => setTimeout(resolve, captureMs));
    await page.locator("#btnRec").click();
    await page.waitForFunction(() => document.querySelectorAll(".clip-card").length === 1
      && document.getElementById("btnRec").disabled);
    console.log("ORIGINAL_PERSISTED_BEFORE_EXPORT");
    await page.waitForFunction(() => !processing
      && ["ready", "failed"].includes(document.querySelector(".subtitle-status")?.dataset.state), null, { timeout: 300000 });
    const result = await page.evaluate(async () => {
      const clip = (await getClips())[0];
      const bytes = clip.captionedBlob ? Array.from(new Uint8Array(await clip.captionedBlob.arrayBuffer())) : [];
      return {
        status: clip.subtitleStatus, error: clip.subtitleError, sourceType: clip.blob.type,
        sourceSize: clip.blob.size, outputSize: clip.captionedBlob?.size || 0,
        cues: clip.subtitleCues, duration: clip.duration, width: clip.width, height: clip.height,
        srt: RISubtitleUtils.toSrt(clip.subtitleCues || []), bytes,
      };
    });
    const { bytes, ...summary } = result;
    console.log("EXPORT_RESULT", JSON.stringify(summary));
    assert.equal(result.status, "ready", result.error);
    assert.ok(result.outputSize > 0 && result.sourceSize > 0);
    if (process.env.RI_REAL_SPEECH_WAV) assert.ok(result.cues.length > 0 && result.srt.trim().length > 0);
    else assert.match(result.srt, /Bună ziua!/);
    fs.writeFileSync(path.join(outputDir, "romanian-caption-smoke.mp4"), Buffer.from(bytes));
    fs.writeFileSync(path.join(outputDir, "romanian-caption-smoke.ro.srt"), result.srt);
    const dimensions = await page.evaluate(async () => readClipDimensions((await getClips())[0].blob, new AbortController().signal));
    assert.deepEqual(dimensions, { width: result.width, height: result.height });
    await page.locator("#btnLibrary").click();
    await page.locator('[data-act="srt"]').waitFor();
    assert.equal(await page.locator('[data-act="original"]').count(), 1);
    await page.screenshot({ path: path.join(outputDir, "archive-mobile.png"), fullPage: true });
    await page.locator("#btnCloseLib").click();
    await page.screenshot({ path: path.join(outputDir, "camera-mobile.png"), fullPage: true });

    // A real abort must settle and leave the original available for retry.
    await page.evaluate(() => {
      RISpeechRecognizer.transcribe = (_, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      });
    });
    await page.locator("#btnRec").click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    await page.locator("#btnRec").click();
    await page.locator("#btnCancelProcess").waitFor({ state: "visible" });
    await page.locator("#btnCancelProcess").click();
    await page.waitForFunction(() => !processing, null, { timeout: 10000 });
    assert.equal(await page.evaluate(async () => (await getClips())[0].subtitleStatus), "cancelled");
    assert.ok(await page.evaluate(async () => (await getClips())[0].blob.size > 0));

    // Recover a stored interrupted job when the PWA is opened again.
    await page.evaluate(async () => {
      const clip = (await getClips())[0];
      await persistClip({ ...clip, subtitleStatus: "rendering" });
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector(".subtitle-status")?.dataset.state === "interrupted");
    await page.locator("#btnLibrary").click();
    await page.locator('[data-act="subtitles"]').first().waitFor();
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("BROWSER_SMOKE_PASS", JSON.stringify({ tests: ["real camera capture", "original saved first", "actual FFmpeg PCM + H264/AAC/libass", "Romanian SRT", "download original", "abort retains recording", "reload recovers interrupted job"], outputDir }));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
