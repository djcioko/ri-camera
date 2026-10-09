const liveVideo = document.getElementById("liveVideo");
const canvas = document.getElementById("renderCanvas");
const ctx = canvas.getContext("2d");
const vuFill = document.getElementById("vuFill");
const recBadge = document.getElementById("recBadge");
const recTime = document.getElementById("recTime");
const clipCount = document.getElementById("clipCount");
const clipList = document.getElementById("clipList");
const techInfoBadge = document.getElementById("techInfoBadge");
const exportStatus = document.getElementById("exportStatus");

const sBright = document.getElementById("sBright");
const sContrast = document.getElementById("sContrast");

let stream = null;
let cameraOpening = false;
let facingMode = "environment";
let audioCtx, analyser, dataArray;
let recording = false;
let mediaRecorder = null;
let recStarted = 0;
let recTimer = null;
let processing = false;
let processingController = null;
let wakeLock = null;
let emergencyClip = null;
const chkSubtitles = document.getElementById("chkSubtitles");
const processorSelect = document.getElementById("subtitleProcessor");
let subtitleModule = null;
let userCancelledProcessing = false;
let cameraGeneration = 0;
function subtitleRoute() { return !!(window.location && window.location.hash === "#subtitrari"); }
function currentProcessor() { return processorSelect && processorSelect.value === "server" ? "server" : "device"; }

// Încărcare imagini din folderul assets
const logoImg = new Image();
logoImg.src = "assets/logo.png";

const siteImg = new Image();
siteImg.src = "assets/site.png"; // Asigură-te că fișierul PNG cu site-ul din folderul assets are acest nume

function storedNumber(key, fallback) {
  const value = Number.parseFloat(localStorage.getItem(key));
  return Number.isFinite(value) ? value : fallback;
}

// Poziții salvate sau implicite pentru elemente
let logoState = { 
  x: storedNumber("logo_x", 30),
  y: storedNumber("logo_y", 30),
  w: storedNumber("logo_w", 220),
  h: storedNumber("logo_h", 160),
  aspect: 877 / 636,
};
let siteState = { 
  x: storedNumber("site_x", 30),
  y: storedNumber("site_y", 220),
  w: storedNumber("site_w", 420),
  h: storedNumber("site_h", 90),
  aspect: 1024 / 219,
};

let activeDrag = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let selectedOverlay = null;
let pinchStart = null;
const pointerPositions = new Map();

function overlayState(name) {
  return name === "logo" ? logoState : siteState;
}

function persistOverlay(name) {
  const state = overlayState(name);
  for (const key of ["x", "y", "w", "h"]) {
    localStorage.setItem(`${name}_${key}`, String(Math.round(state[key] * 100) / 100));
  }
}

function updateAspectFromImage(name, image) {
  if (!image.naturalWidth || !image.naturalHeight) return;
  const state = overlayState(name);
  state.aspect = image.naturalWidth / image.naturalHeight;
  state.h = state.w / state.aspect;
}

logoImg.addEventListener("load", () => updateAspectFromImage("logo", logoImg));
siteImg.addEventListener("load", () => updateAspectFromImage("site", siteImg));

const DB_NAME = "ri-camera-db";
const STORE = "clips";
let libraryUrls = [];
let libraryRenderGeneration = 0;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Închide celelalte ferestre ale aplicației și reîncearcă."));
  });
}

async function useClipsStore(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    let request;
    try {
      tx = db.transaction(STORE, mode);
      request = action(tx.objectStore(STORE));
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    tx.oncomplete = () => { db.close(); resolve(request ? request.result : undefined); };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error || new Error("Arhiva nu a putut fi actualizată. Verifică spațiul liber."));
    };
  });
}

async function persistClip(clip) {
  await useClipsStore("readwrite", (store) => store.put(clip));
  // UI rendering is not part of a successful database commit. A damaged older
  // card must never make the pipeline roll back a newly saved recording/output.
  refreshLibrarySafely();
}

async function refreshLibrarySafely() {
  try { await refreshLibrary(); }
  catch (error) { console.warn("Arhiva nu a putut fi afișată", error); }
}

async function getClips() {
  const clips = await useClipsStore("readonly", (store) => store.getAll());
  return clips.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function selectedClipBlob(clip) {
  return clip.captionedBlob || clip.mp4Blob || clip.blob;
}

function extensionFor(blob) {
  const type = blob.type.toLowerCase();
  if (type.includes("quicktime")) return "mov";
  if (type.includes("matroska")) return "mkv";
  return type.includes("mp4") ? "mp4" : "webm";
}
function originalFilename(clip) {
  return clip.originalName || `RI_${safeFilename(clip.site)}_${clip.id}_original.${extensionFor(clip.blob)}`;
}
async function patchRemoteClip(id, requestId, changes) {
  const clip = await RISubtitleModule.patchRemoteClip(await openDb(), STORE, id, requestId, changes);
  refreshLibrarySafely();
  return clip;
}

function safeFilename(value) {
  return String(value || "santier").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 90);
}

function subtitleStatusText(clip) {
  const labels = {
    pending: "Subtitrare RO: în așteptare…",
    transcribing: "Se transcrie vocea în română…",
    rendering: "Se pregătește MP4 cu subtitrarea inclusă…",
    ready: "✓ Subtitrare în română inclusă în videoclip.",
    empty: "Nu s-a detectat vorbire pentru subtitrare.",
    disabled: "Subtitrarea automată a fost oprită pentru acest clip.",
    failed: "Prelucrarea nu a reușit. Filmarea originală este disponibilă.",
    cancelled: "Prelucrare oprită. Poți relua oricând.",
    interrupted: "Conexiune sau salvare întreruptă. Reia din Arhivă.",
    awaiting_upload: "Original salvat. Transferul poate fi reluat.",
    uploading: "Originalul se trimite către ai.djshopitalia.it…",
    queued: "Lucrare în așteptare pe ai.djshopitalia.it…",
    expired: "Lucrarea a expirat. Poți porni o lucrare nouă.",
  };
  const label = labels[clip.subtitleStatus] || "Poți adăuga subtitrare în română acestui clip.";
  return label + (clip.subtitleError ? "\n" + clip.subtitleError : "");
}

async function refreshLibrary() {
  const generation = ++libraryRenderGeneration;
  let clips;
  try { clips = await getClips(); }
  catch (error) {
    if (generation !== libraryRenderGeneration) return;
    clipList.textContent = "Arhiva nu poate fi citită: " + error.message;
    return;
  }
  if (generation !== libraryRenderGeneration) return;
  // Stop pending reads before revoking the previous cards' Blob URLs.
  for (const player of clipList.querySelectorAll("video")) {
    player.pause();
    player.removeAttribute("src");
    for (const track of player.querySelectorAll("track")) track.remove();
    player.load();
  }
  clipList.replaceChildren();
  for (const url of libraryUrls) URL.revokeObjectURL(url);
  libraryUrls = [];
  clipCount.textContent = clips.length;
  if (!clips.length) {
    const empty = document.createElement("p");
    empty.className = "subtitle-help";
    empty.textContent = "Niciun clip salvat încă în arhivă.";
    clipList.appendChild(empty);
    return;
  }
  const trackedUrl = (blob) => {
    const url = URL.createObjectURL(blob);
    libraryUrls.push(url);
    return url;
  };
  for (const c of clips) {
    const output = selectedClipBlob(c);
    const el = document.createElement("div");
    el.className = "clip-card";
    el.dataset.clipId = c.id;
    el.innerHTML = `
      <video controls playsinline webkit-playsinline preload="metadata"></video>
      <div class="clip-info"><div class="meta"><strong></strong><small></small></div></div>
      <p class="subtitle-status"></p><div class="clip-actions"></div>
    `;
    const player = el.querySelector("video");
    player.src = trackedUrl(output);
    if (!c.captionedBlob && c.subtitleCues && c.subtitleCues.length) {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = "Română";
      track.srclang = "ro";
      track.default = true;
      track.src = trackedUrl(new Blob([RISubtitleUtils.toVtt(c.subtitleCues)], { type: "text/vtt" }));
      player.appendChild(track);
    }
    el.querySelector("strong").textContent = "Șantier: " + c.site;
    const dt = new Date(c.createdAt);
    el.querySelector("small").textContent = `${dt.toLocaleDateString("ro-RO")} ${dt.toLocaleTimeString("ro-RO")} • ${(output.size / 1024 / 1024).toFixed(1)} MB`;
    const status = el.querySelector(".subtitle-status");
    status.textContent = subtitleStatusText(c);
    status.dataset.state = c.subtitleStatus || "";
    const actions = el.querySelector(".clip-actions");
    const addButton = (action, label, handler, disabled = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "icon-btn";
      button.dataset.act = action;
      button.textContent = label;
      button.disabled = disabled;
      button.onclick = handler;
      actions.appendChild(button);
    };
    const filename = `RI_${safeFilename(c.site)}_${c.id}`;
    addButton("dl", c.captionedBlob ? "⬇ MP4 subtitrat" : `⬇ ${extensionFor(output).toUpperCase()}`, () => {
      downloadBlob(output, output === c.blob ? originalFilename(c) : `${filename}${c.captionedBlob ? "_subtitrat_ro" : ""}.${extensionFor(output)}`);
    });
    if (output !== c.blob) {
      addButton("original", "⬇ Original", () => downloadBlob(c.blob, originalFilename(c)));
    }
    if (c.subtitleCues && c.subtitleCues.length) {
      addButton("srt", "⬇ Text SRT", () => downloadBlob(c.srtBlob || new Blob([RISubtitleUtils.toSrt(c.subtitleCues)], { type: "application/x-subrip;charset=utf-8" }), `${filename}.ro.srt`));
    }
    if (!c.captionedBlob) {
      const retry = ["failed", "cancelled", "interrupted"].includes(c.subtitleStatus);
      addButton("subtitles", retry ? "↻ Reia subtitrarea RO" : "Adaugă subtitrare RO", () => processArchivedClip(c), processing || recording);
    }
    if (c.subtitleProcessor !== "server" && !output.type.toLowerCase().includes("mp4")) {
      addButton("mp4", "Pregătește MP4", () => prepareArchivedClipAsMp4(c), processing || recording);
    }
    addButton("del", "🗑 Șterge", async () => {
      if (processing || recording) return;
      if (!confirm("Ștergi acest clip și subtitrarea lui din Arhivă?")) return;
      try {
        await useClipsStore("readwrite", (store) => store.delete(c.id));
        await refreshLibrary();
      } catch (error) { alert("Clipul nu a putut fi șters: " + error.message); }
    }, processing || recording);
    clipList.appendChild(el);
  }
}

function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

function setExportStatus(message, visible = true) {
  exportStatus.textContent = message;
  document.getElementById("processingNotice").classList.toggle("hidden", !visible);
}

function updateBusyUi() {
  document.getElementById("btnRec").disabled = processing || cameraOpening || !stream || !!emergencyClip;
  document.getElementById("btnRec").setAttribute("aria-label", recording ? "Oprește înregistrarea" : "Înregistrează");
  document.getElementById("btnFlipBig").disabled = recording || processing || cameraOpening;
  chkSubtitles.disabled = recording || processing;
  if (processorSelect) processorSelect.disabled = recording || processing;
  const openSubtitles = document.getElementById("btnSubtitles");
  if (openSubtitles) openSubtitles.disabled = recording;
  document.getElementById("btnCancelProcess").classList.toggle("hidden", !processing || !processingController);
}

async function requestWakeLock() {
  if (!navigator.wakeLock || document.visibilityState !== "visible" || wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if ((!recording && !processing) || wakeLock) { await lock.release(); return; }
    wakeLock = lock;
  }
  catch (_) { /* Screen wake lock is optional on older phones. */ }
}

async function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  if (lock) { try { await lock.release(); } catch (_) {} }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (recording || processing)) {
    if (wakeLock && wakeLock.released) wakeLock = null;
    requestWakeLock();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (!recording && !processing && !emergencyClip) return;
  event.preventDefault();
  event.returnValue = "";
});

function pipelineDependencies() {
  return {
    persist: persistClip,
    patchRemote: patchRemoteClip,
    serverPipeline: window.RIServerSubtitlePipeline,
    client: window.RIServerSubtitleClient ? RIServerSubtitleClient.createClient() : null,
    isUserCancellation: () => userCancelledProcessing,
    media: RIMediaProcessor,
    speech: RISpeechRecognizer,
    subtitles: RISubtitleUtils,
    signal: processingController.signal,
    onProgress: (message) => { setExportStatus(message); if (subtitleModule) subtitleModule.setStatus(message); },
  };
}

function beginProcessing() {
  processing = true;
  userCancelledProcessing = false;
  processingController = new AbortController();
  document.getElementById("btnCancelProcess").disabled = false;
  document.getElementById("library").classList.add("hidden");
  updateBusyUi();
  requestWakeLock();
}

async function finishProcessing() {
  processing = false;
  processingController = null;
  updateBusyUi();
  await releaseWakeLock();
  await refreshLibrarySafely();
}

async function processArchivedClip(clip, forceServer = false) {
  if (processing || recording) return;
  try {
    beginProcessing();
    clip = { ...clip, subtitleProcessor: forceServer ? "server" : (clip.subtitleProcessor || currentProcessor()) };
    if (clip.subtitleProcessor === "server" && clip.remoteJob && ["cancelled", "failed", "expired", "cleaned"].includes(clip.remoteJob.status)) clip = { ...clip, remoteJob: undefined };
    if (clip.subtitleProcessor !== "server" && !(clip.width > 0 && clip.height > 0)) {
      setExportStatus("Se citește dimensiunea filmării…");
      const dimensions = await readClipDimensions(clip.blob, processingController.signal);
      clip = { ...clip, ...dimensions };
    }
    await RIRecordingPipeline.processClip({ ...clip, autoSubtitles: true }, pipelineDependencies());
  } catch (error) {
    console.error(error);
    setExportStatus(processingController?.signal.aborted
      ? "Prelucrare oprită. Originalul este în Arhivă."
      : "Prelucrarea nu a reușit. Originalul este disponibil. " + error.message);
  } finally { await finishProcessing(); }
}

function readClipDimensions(blob, signal) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      video.onloadedmetadata = video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new DOMException("Prelucrare oprită.", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Dimensiunea clipului nu a putut fi citită. Reîncearcă.")), 15000);
    video.onloadedmetadata = () => {
      if (video.videoWidth && video.videoHeight) finish(null, { width: video.videoWidth, height: video.videoHeight });
      else finish(new Error("Clipul nu conține dimensiuni video valide."));
    };
    video.onerror = () => finish(new Error("Acest browser nu poate citi filmarea arhivată."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    video.preload = "metadata";
    video.muted = true;
    video.src = url;
    video.load();
  });
}

async function prepareArchivedClipAsMp4(clip) {
  if (processing || recording) return;
  try {
    beginProcessing();
    const mp4Blob = await RIMediaProcessor.exportMp4(clip.blob, {
      duration: clip.duration,
      signal: processingController.signal,
      onProgress: setExportStatus,
    });
    await persistClip({ ...clip, mp4Blob });
    setExportStatus("MP4 pregătit în Arhivă.");
  } catch (error) {
    console.error(error);
    setExportStatus(processingController?.signal.aborted ? "Conversie oprită. Originalul este în Arhivă." : "Conversia MP4 nu a reușit: " + error.message);
  } finally { await finishProcessing(); }
}

document.getElementById("btnCancelProcess").onclick = () => {
  if (!processingController) return;
  document.getElementById("btnCancelProcess").disabled = true;
  userCancelledProcessing = true;
  processingController.abort();
  setExportStatus("Se oprește prelucrarea…");
};

document.getElementById("btnRescue").onclick = () => {
  if (!emergencyClip) return;
  downloadBlob(emergencyClip.blob, `RI_${safeFilename(emergencyClip.site)}_${emergencyClip.id}_original.${extensionFor(emergencyClip.blob)}`);
  // Keep the Blob reachable until the page closes, even after the download begins.
  setExportStatus("Descărcarea originalului a fost pornită. Verifică fișierul înainte să închizi aplicația.");
};

async function startCamera() {
  // Serialize acquisition through preview readiness, so a late camera request
  // cannot replace the video while a different microphone is being recorded.
  if (cameraOpening || subtitleRoute()) return;
  const generation = cameraGeneration;
  cameraOpening = true;
  const previousStream = stream;
  stream = null;
  let openedStream = null;
  try {
    if (previousStream) previousStream.getTracks().forEach((track) => track.stop());
    updateBusyUi();
    openedStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, min: 30 }
      },
    });
    if (generation !== cameraGeneration || subtitleRoute()) { openedStream.getTracks().forEach(track => track.stop()); return; }
    liveVideo.srcObject = openedStream;
    await liveVideo.play();
    if (generation !== cameraGeneration || subtitleRoute()) { openedStream.getTracks().forEach(track => track.stop()); liveVideo.srcObject = null; return; }
    stream = openedStream;

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    techInfoBadge.textContent = `${settings.width || 1920}x${settings.height || 1080} / ${settings.frameRate || 60} FPS`;

    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } else if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    monitorAudio();
  } catch (err) {
    if (openedStream) openedStream.getTracks().forEach((track) => track.stop());
    if (liveVideo.srcObject === openedStream) liveVideo.srcObject = null;
    stream = null;
    alert("Eroare pornire cameră: " + err.message);
  } finally {
    cameraOpening = false;
    updateBusyUi();
    // Returning from the module may have been blocked by this old acquisition.
    // Start a new request after releasing the serialized camera lock.
    if (generation !== cameraGeneration && !subtitleRoute() && !stream) Promise.resolve().then(startCamera);
  }
}

function monitorAudio() {
  if (!analyser || !dataArray) return;
  analyser.getByteTimeDomainData(dataArray);
  let peak = 0;
  for (let i = 0; i < dataArray.length; i++) peak = Math.max(peak, Math.abs(dataArray[i] - 128));
  vuFill.style.height = `${Math.min(100, Math.max(5, (peak / 128) * 140))}%`;
  requestAnimationFrame(monitorAudio);
}

// Randare cadru pe Canvas cu imagini și filtre
function renderFrame() {
  if (!processing && liveVideo.readyState >= liveVideo.HAVE_CURRENT_DATA) {
    if (canvas.width !== liveVideo.videoWidth || canvas.height !== liveVideo.videoHeight) {
      canvas.width = liveVideo.videoWidth || 1280;
      canvas.height = liveVideo.videoHeight || 720;
      Object.assign(logoState, RIOverlayUtils.clampOverlay(logoState, { width: canvas.width, height: canvas.height }));
      Object.assign(siteState, RIOverlayUtils.clampOverlay(siteState, { width: canvas.width, height: canvas.height }));
    }

    ctx.save();
    ctx.filter = `brightness(${sBright.value}%) contrast(${sContrast.value}%)`;
    ctx.drawImage(liveVideo, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Logo R&I
    if (logoImg.complete && logoImg.naturalWidth !== 0) {
      ctx.drawImage(logoImg, logoState.x, logoState.y, logoState.w, logoState.h);
    }
    // Poză Site www
    if (siteImg.complete && siteImg.naturalWidth !== 0) {
      ctx.drawImage(siteImg, siteState.x, siteState.y, siteState.w, siteState.h);
    }

    if (!recording && selectedOverlay) {
      const state = overlayState(selectedOverlay);
      ctx.save();
      ctx.strokeStyle = "#e2c14a";
      ctx.lineWidth = Math.max(2, canvas.width / 640);
      ctx.setLineDash([10, 7]);
      ctx.strokeRect(state.x, state.y, state.w, state.h);
      ctx.restore();
    }

    // Dată și Nume Șantier
    if (document.getElementById("chkDate").checked) {
      ctx.save();
      ctx.font = "bold 16px Inter, sans-serif";
      ctx.fillStyle = "#e2c14a";
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      ctx.shadowBlur = 4;
      const sName = document.getElementById("siteName").value || "Șantier";
      const timeStr = new Date().toLocaleString("ro-RO");
      ctx.fillText(`Șantier: ${sName} | ${timeStr}`, 20, canvas.height - 25);
      ctx.restore();
    }
  }
  requestAnimationFrame(renderFrame);
}
requestAnimationFrame(renderFrame);

// Mutare și redimensionare proporțională cu mouse-ul sau degetele
function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
}

function hitOverlay(pos) {
  for (const name of ["site", "logo"]) {
    const state = overlayState(name);
    if (pos.x >= state.x && pos.x <= state.x + state.w && pos.y >= state.y && pos.y <= state.y + state.h) return name;
  }
  return null;
}

function pointerDistance() {
  const points = [...pointerPositions.values()];
  if (points.length < 2) return 0;
  return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
}

canvas.onpointerdown = (event) => {
  event.preventDefault();
  const pos = getCanvasCoords(event);
  pointerPositions.set(event.pointerId, pos);
  try { canvas.setPointerCapture(event.pointerId); } catch (_) {}

  if (!activeDrag) {
    activeDrag = hitOverlay(pos);
    selectedOverlay = activeDrag;
    if (!activeDrag) return;
    const state = overlayState(activeDrag);
    dragOffsetX = pos.x - state.x;
    dragOffsetY = pos.y - state.y;
  }

  if (pointerPositions.size === 2 && activeDrag) {
    pinchStart = { distance: pointerDistance(), state: { ...overlayState(activeDrag) } };
  }
};

canvas.onpointermove = (event) => {
  if (!pointerPositions.has(event.pointerId) || !activeDrag) return;
  event.preventDefault();
  const pos = getCanvasCoords(event);
  pointerPositions.set(event.pointerId, pos);
  const bounds = { width: canvas.width, height: canvas.height };

  if (pointerPositions.size >= 2 && pinchStart && pinchStart.distance > 0) {
    const scaled = RIOverlayUtils.scaleOverlay(pinchStart.state, pointerDistance() / pinchStart.distance, bounds);
    Object.assign(overlayState(activeDrag), scaled);
    return;
  }

  const state = overlayState(activeDrag);
  Object.assign(state, RIOverlayUtils.clampOverlay({
    ...state,
    x: pos.x - dragOffsetX,
    y: pos.y - dragOffsetY,
  }, bounds));
};

function finishPointer(event) {
  pointerPositions.delete(event.pointerId);
  if (pointerPositions.size === 0) {
    if (activeDrag) persistOverlay(activeDrag);
    activeDrag = null;
    pinchStart = null;
  } else if (pointerPositions.size === 1 && activeDrag) {
    pinchStart = null;
    const pos = [...pointerPositions.values()][0];
    const state = overlayState(activeDrag);
    dragOffsetX = pos.x - state.x;
    dragOffsetY = pos.y - state.y;
  }
}

canvas.onpointerup = finishPointer;
canvas.onpointercancel = finishPointer;

canvas.addEventListener("wheel", (event) => {
  const pos = getCanvasCoords(event);
  const name = hitOverlay(pos);
  if (!name) return;
  event.preventDefault();
  selectedOverlay = name;
  const factor = event.deltaY < 0 ? 1.08 : 0.92;
  Object.assign(overlayState(name), RIOverlayUtils.scaleOverlay(
    overlayState(name), factor, { width: canvas.width, height: canvas.height }
  ));
  persistOverlay(name);
}, { passive: false });

// Înregistrare video din Canvas. Fiecare înregistrare are propriile bucăți și metadate.
function startRecording() {
  if (recording || processing || cameraOpening || emergencyClip || subtitleRoute()) return;
  if (!stream || !stream.getVideoTracks().some((track) => track.readyState === "live") || !canvas.width || !canvas.height) {
    alert("Pornește camera și microfonul înainte de înregistrare.");
    return;
  }
  let canvasStream;
  try {
    const format = RIMediaUtils.selectRecordingFormat((type) => MediaRecorder.isTypeSupported(type));
    canvasStream = canvas.captureStream(60);
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) canvasStream.addTrack(audioTracks[0]);
    const recorder = new MediaRecorder(canvasStream, { mimeType: format.mimeType, videoBitsPerSecond: 10_000_000 });
    const chunks = [];
    const started = performance.now();
    const metadata = {
      id: Date.now(),
      createdAt: new Date().toISOString(),
      site: (document.getElementById("siteName").value || "șantier").trim(),
      autoSubtitles: chkSubtitles.checked,
      subtitleProcessor: currentProcessor(),
      width: canvas.width,
      height: canvas.height,
    };
    mediaRecorder = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = (event) => {
      console.error("Înregistrare întreruptă", event.error);
      setExportStatus("Camera a întrerupt înregistrarea. Se salvează datele disponibile…");
      stopRecording();
    };
    recorder.onstop = async () => {
      recording = false;
      clearInterval(recTimer);
      recBadge.classList.add("hidden");
      document.getElementById("btnRec").classList.remove("on");
      // The microphone track is borrowed from the live camera: stop only capture video.
      canvasStream.getVideoTracks().forEach((track) => track.stop());
      const recordedBlob = new Blob(chunks, { type: recorder.mimeType || format.mimeType });
      chunks.length = 0;
      metadata.duration = ((recorder.stoppedAt || performance.now()) - started) / 1000;
      try {
        beginProcessing();
        setExportStatus("Se salvează filmarea originală…");
        await RIRecordingPipeline.finalizeRecording(recordedBlob, metadata, pipelineDependencies());
      } catch (error) {
        console.error(error);
        if (recordedBlob.size) {
          emergencyClip = { ...metadata, blob: recordedBlob };
          document.getElementById("rescuePanel").classList.remove("hidden");
          setExportStatus("Stocarea nu a reușit. Descarcă originalul înainte să închizi aplicația.");
        } else {
          setExportStatus("Camera nu a furnizat date video. Verifică permisiunile și reîncearcă.");
        }
      } finally {
        if (mediaRecorder === recorder) mediaRecorder = null;
        await finishProcessing();
      }
    };
    recorder.start(250);
    recording = true;
    recStarted = Date.now();
    recTime.textContent = "00:00";
    recBadge.classList.remove("hidden");
    document.getElementById("btnRec").classList.add("on");
    setExportStatus("", false);
    updateBusyUi();
    requestWakeLock();
    refreshLibrarySafely();
    recTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - recStarted) / 1000);
      recTime.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    }, 250);
  } catch (error) {
    if (canvasStream) canvasStream.getVideoTracks().forEach((track) => track.stop());
    mediaRecorder = null;
    setExportStatus("Înregistrarea nu poate porni: " + error.message);
    updateBusyUi();
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  // Lock before the asynchronous final data/stop events, preventing a second recording.
  processing = true;
  mediaRecorder.stoppedAt = performance.now();
  mediaRecorder.stop();
  recording = false;
  recBadge.classList.add("hidden");
  document.getElementById("btnRec").classList.remove("on");
  clearInterval(recTimer);
  updateBusyUi();
  setExportStatus("Se finalizează filmarea…");
}

document.getElementById("btnRec").onclick = () => {
  if (processing) return;
  recording ? stopRecording() : startRecording();
};

async function flipCamera() {
  if (recording || processing || cameraOpening) return;
  facingMode = facingMode === "environment" ? "user" : "environment";
  await startCamera();
}
document.getElementById("btnFlipBig").onclick = flipCamera;

document.getElementById("btnHideCtrl").onclick = () => {
  document.getElementById("controlPanel").classList.toggle("hidden-panel");
};

document.getElementById("btnFullscreen").onclick = () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
  }
};

document.getElementById("btnReset").onclick = () => {
  sBright.value = 100;
  sContrast.value = 100;
};

document.getElementById("btnResetPos").onclick = () => {
  Object.assign(logoState, { x: 30, y: 30, w: 220, h: 220 / logoState.aspect });
  Object.assign(siteState, { x: 30, y: 220, w: 420, h: 420 / siteState.aspect });
  for (const name of ["logo", "site"]) {
    for (const key of ["x", "y", "w", "h"]) localStorage.removeItem(`${name}_${key}`);
  }
};

function scaleOverlayFromButton(name, factor) {
  selectedOverlay = name;
  Object.assign(overlayState(name), RIOverlayUtils.scaleOverlay(
    overlayState(name), factor, { width: canvas.width, height: canvas.height }
  ));
  persistOverlay(name);
}

document.getElementById("btnLogoMinus").onclick = () => scaleOverlayFromButton("logo", 0.85);
document.getElementById("btnLogoPlus").onclick = () => scaleOverlayFromButton("logo", 1.15);
document.getElementById("btnSiteMinus").onclick = () => scaleOverlayFromButton("site", 0.85);
document.getElementById("btnSitePlus").onclick = () => scaleOverlayFromButton("site", 1.15);

document.getElementById("btnLibrary").onclick = () => {
  document.getElementById("library").classList.remove("hidden");
  refreshLibrarySafely();
};
document.getElementById("btnCloseLib").onclick = () => {
  document.getElementById("library").classList.add("hidden");
};

const siteInput = document.getElementById("siteName");
siteInput.value = localStorage.getItem("ri_site_name") || "";
siteInput.oninput = () => localStorage.setItem("ri_site_name", siteInput.value);

chkSubtitles.checked = localStorage.getItem("ri_auto_subtitles") !== "false";
chkSubtitles.onchange = () => localStorage.setItem("ri_auto_subtitles", String(chkSubtitles.checked));


if (window.RISubtitleModule) {
  subtitleModule = RISubtitleModule.createModule({
    document, getClips, isBusy: () => recording || processing,
    process: clip => processArchivedClip(clip, true),
    onOpen: () => {
      cameraGeneration++;
      if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
      liveVideo.srcObject = null;
      analyser = null;
      document.getElementById("stageArea")?.classList.add("hidden");
      document.getElementById("controlPanel").classList.add("hidden");
      updateBusyUi();
    },
  });
  document.getElementById("btnSubtitles").onclick = () => { if (!recording) window.location.hash = "subtitrari"; };
  document.getElementById("btnCloseSubtitles").onclick = () => { window.location.hash = "camera"; };
  window.addEventListener("hashchange", async () => {
    if (subtitleRoute()) {
      if (recording) { window.location.hash = "camera"; return; }
      await subtitleModule.show();
    } else {
      subtitleModule.hide();
      document.getElementById("stageArea")?.classList.remove("hidden");
      document.getElementById("controlPanel").classList.remove("hidden");
      await startCamera();
    }
  });
}
if (processorSelect) {
  processorSelect.value = localStorage.getItem("ri_subtitle_processor") === "server" ? "server" : "device";
  const updateProcessorDescription = () => {
    const description = document.getElementById("processorDescription");
    if (description) description.textContent = currentProcessor() === "server"
      ? "Cu subtitrarea activă, originalul se trimite către ai.djshopitalia.it. Modelul vocal și conversia rulează pe server. Cu subtitrarea oprită se salvează numai originalul."
      : "Procesare pe acest dispozitiv. Prima utilizare descarcă aproximativ 820 MB; folosește Wi-Fi. Păstrează aplicația deschisă.";
  };
  processorSelect.onchange = () => { localStorage.setItem("ri_subtitle_processor", currentProcessor()); updateProcessorDescription(); };
  updateProcessorDescription();
}

(async () => {
  updateBusyUi();
  try {
    for (const clip of await getClips()) {
      const recovered = RIRecordingPipeline.recoverInterruptedClip(clip);
      if (recovered !== clip) await useClipsStore("readwrite", (store) => store.put(recovered));
    }
  } catch (error) { setExportStatus("Arhiva nu este disponibilă: " + error.message); }
  if (subtitleRoute()) { if (subtitleModule) await subtitleModule.show(); }
  else await startCamera();
  await refreshLibrarySafely();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Modul offline nu este disponibil", error));
  }
})();
