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
let wakeLock = null;
let emergencyClip = null;
let cameraGeneration = 0;

const logoImg = new Image();
logoImg.src = "assets/logo.png";

const siteImg = new Image();
siteImg.src = "assets/site.png";

function storedNumber(key, fallback) {
  const value = Number.parseFloat(localStorage.getItem(key));
  return Number.isFinite(value) ? value : fallback;
}

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
    localStorage.setItem(`\( {name}_ \){key}`, String(Math.round(state[key] * 100) / 100));
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

function extensionFor(blob) {
  const type = blob.type.toLowerCase();
  if (type.includes("quicktime")) return "mov";
  if (type.includes("matroska")) return "mkv";
  return type.includes("mp4") ? "mp4" : "webm";
}

function originalFilename(clip) {
  return clip.originalName || `RI_\( {safeFilename(clip.site)}_ \){clip.id}_original.${extensionFor(clip.blob)}`;
}

function safeFilename(value) {
  return String(value || "santier").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 90);
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
  for (const player of clipList.querySelectorAll("video")) {
    player.pause();
    player.removeAttribute("src");
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
    const output = c.blob;
    const el = document.createElement("div");
    el.className = "clip-card";
    el.dataset.clipId = c.id;
    el.innerHTML = `
      <video controls playsinline webkit-playsinline preload="metadata"></video>
      <div class="clip-info"><div class="meta"><strong></strong><small></small></div></div>
      <div class="clip-actions"></div>
    `;
    const player = el.querySelector("video");
    player.src = trackedUrl(output);
    el.querySelector("strong").textContent = "Șantier: " + c.site;
    const dt = new Date(c.createdAt);
    el.querySelector("small").textContent = `${dt.toLocaleDateString("ro-RO")} ${dt.toLocaleTimeString("ro-RO")} • ${(output.size / 1024 / 1024).toFixed(1)} MB`;
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
    const filename = `RI_\( {safeFilename(c.site)}_ \){c.id}`;
    addButton("dl", `⬇ ${extensionFor(output).toUpperCase()}`, () => {
      downloadBlob(output, originalFilename(c));
    });
    addButton("del", "🗑 Șterge", async () => {
      if (processing || recording) return;
      if (!confirm("Ștergi acest clip din Arhivă?")) return;
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
  document.getElementById("btnFlipBig").disabled = cameraOpening;
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

async function startCamera() {
  if (cameraOpening) return;
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
    if (generation !== cameraGeneration) { openedStream.getTracks().forEach(track => track.stop()); return; }
    liveVideo.srcObject = openedStream;
    await liveVideo.play();
    if (generation !== cameraGeneration) { openedStream.getTracks().forEach(track => track.stop()); liveVideo.srcObject = null; return; }
    stream = openedStream;

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    techInfoBadge.textContent = `\( {settings.width || 1920}x \){settings.height || 1080} / ${settings.frameRate || 60} FPS`;

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
    if (generation !== cameraGeneration && !stream) Promise.resolve().then(startCamera);
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

function renderFrame() {
  if (!processing && liveVideo.readyState >= liveVideo.HAVE_CURRENT_DATA) {
    if (canvas.width !== liveVideo.videoWidth || canvas.height !== liveVideo.videoHeight) {
      canvas.width = liveVideo.videoWidth || 1280;
      canvas.height = liveVideo.videoHeight || 720;
      Object.assign(logoState, RIOverlayUtils.clampOverlay(logoState, { width: canvas.width, height: canvas.height }));
      Object.assign(siteState, RIOverlayUtils.clampOverlay(siteState, { width: canvas.width, height: canvas.height }));
    }

    ctx.save();
    ctx.filter = `brightness(\( {sBright.value}%) contrast( \){sContrast.value}%)`;
    ctx.drawImage(liveVideo, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    if (logoImg.complete && logoImg.naturalWidth !== 0) {
      ctx.drawImage(logoImg, logoState.x, logoState.y, logoState.w, logoState.h);
    }
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
  } else if (