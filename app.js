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
let facingMode = "environment";
let audioCtx, analyser, dataArray;
let recording = false;
let mediaRecorder = null;
let recChunks = [];
let recStarted = 0;
let recTimer = null;

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

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveClip(blob) {
  const db = await openDb();
  const clip = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    size: blob.size,
    site: (document.getElementById("siteName").value || "santier").trim(),
    blob,
  };
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(clip);
    tx.oncomplete = resolve;
  });
  refreshLibrary();
}

async function replaceClipBlob(id, blob) {
  const db = await openDb();
  const clip = await new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
  });
  if (!clip) return;
  clip.blob = blob;
  clip.size = blob.size;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(clip);
    tx.oncomplete = resolve;
  });
}

async function getClips() {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.id - a.id));
  });
}

async function refreshLibrary() {
  const clips = await getClips();
  clipCount.textContent = clips.length;
  clipList.innerHTML = "";
  if (!clips.length) {
    clipList.innerHTML = "<p style='color:#777; font-size:12px; text-align:center; margin-top:20px;'>Niciun clip salvat încă în arhivă.</p>";
    return;
  }
  for (const c of clips) {
    const url = URL.createObjectURL(c.blob);
    const isMp4 = c.blob.type.toLowerCase().includes("mp4");
    const el = document.createElement("div");
    el.className = "clip-card";
    const dt = new Date(c.createdAt);
    el.innerHTML = `
      <video src="${url}" controls playsinline webkit-playsinline preload="metadata"></video>
      <div class="clip-info">
        <div class="meta">
          <strong>Șantier: ${c.site}</strong><br>
          <small>${dt.toLocaleDateString("ro-RO")} ${dt.toLocaleTimeString("ro-RO")} • ${(c.size / 1024 / 1024).toFixed(1)} MB</small>
        </div>
      </div>
      <div class="clip-actions">
        <button class="icon-btn" data-act="dl" title="Descarcă clipul">${isMp4 ? "⬇ Descarcă MP4" : "⚙ Pregătește MP4"}</button>
        <button class="icon-btn" data-act="del" title="Șterge">🗑 Șterge</button>
      </div>
    `;
    el.querySelector('[data-act="dl"]').onclick = (event) => {
      const button = event.currentTarget;
      if (isMp4) {
        downloadBlob(c.blob, `RI_${c.site}_${c.id}.mp4`);
        return;
      }
      prepareArchivedClipAsMp4(c, button);
    };
    el.querySelector('[data-act="del"]').onclick = async () => {
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(c.id);
      tx.oncomplete = refreshLibrary;
    };
    clipList.appendChild(el);
  }
}

async function prepareArchivedClipAsMp4(clip, button) {
      button.disabled = true;
      const originalLabel = button.textContent;
      try {
        button.textContent = "Conversie MP4 0%…";
        const mp4Blob = await convertToMp4(clip.blob, (ratio) => {
              button.textContent = `Conversie MP4 ${Math.round(ratio * 100)}%…`;
            });
        await replaceClipBlob(clip.id, mp4Blob);
        await refreshLibrary();
        alert("MP4 este pregătit. Apasă «Descarcă MP4».");
      } catch (error) {
        console.error(error);
        alert("Conversia MP4 nu a reușit. Verifică internetul și spațiul liber, apoi reîncearcă.");
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
}

function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function setExportStatus(message, visible = true) {
  exportStatus.textContent = message;
  exportStatus.classList.toggle("hidden", !visible);
}

let ffmpegPromise = null;

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (window.FFmpeg) resolve();
      else existing.addEventListener("load", resolve, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Biblioteca de conversie MP4 nu poate fi încărcată."));
    document.head.appendChild(script);
  });
}

async function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      await loadExternalScript("https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js");
      const ffmpeg = window.FFmpeg.createFFmpeg({
        log: false,
        corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",
      });
      await ffmpeg.load();
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

async function convertToMp4(blob, onProgress) {
  const ffmpeg = await getFfmpeg();
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const input = `input-${token}.webm`;
  const output = `output-${token}.mp4`;
  ffmpeg.setProgress(({ ratio }) => onProgress(Math.max(0, Math.min(1, ratio || 0))));
  ffmpeg.FS("writeFile", input, await window.FFmpeg.fetchFile(blob));
  try {
    await ffmpeg.run(
      "-i", input,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-b:a", "128k",
      output
    );
    const data = ffmpeg.FS("readFile", output);
    return new Blob([data.buffer], { type: "video/mp4" });
  } finally {
    try { ffmpeg.FS("unlink", input); } catch (_) {}
    try { ffmpeg.FS("unlink", output); } catch (_) {}
  }
}

async function startCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, min: 30 }
      },
    });
    liveVideo.srcObject = stream;
    await liveVideo.play();

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
    alert("Erore pornire cameră: " + err.message);
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
  if (liveVideo.readyState >= liveVideo.HAVE_CURRENT_DATA) {
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

// Înregistrare video din Canvas
function startRecording() {
  recChunks = [];
  const format = RIMediaUtils.selectRecordingFormat((type) => MediaRecorder.isTypeSupported(type));
  
  const canvasStream = canvas.captureStream(60);
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length) canvasStream.addTrack(audioTracks[0]);

  mediaRecorder = new MediaRecorder(canvasStream, { mimeType: format.mimeType, videoBitsPerSecond: 10_000_000 });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    const recordedBlob = new Blob(recChunks, { type: mediaRecorder.mimeType || format.mimeType });
    try {
      const mp4Blob = await RIMediaUtils.finalizeRecordingBlob(recordedBlob, (blob) => {
        setExportStatus("Pregătire MP4 0%…");
        return convertToMp4(blob, (ratio) => setExportStatus(`Pregătire MP4 ${Math.round(ratio * 100)}%…`));
      });
      await saveClip(mp4Blob);
      setExportStatus("MP4 pregătit pentru descărcare.");
      setTimeout(() => setExportStatus("", false), 2500);
    } catch (error) {
      console.error(error);
      await saveClip(recordedBlob);
      setExportStatus("Clip salvat. Conversia MP4 poate fi reluată din Arhivă.");
    }
  };
  
  mediaRecorder.start(250);
  recording = true;
  recStarted = Date.now();
  recBadge.classList.remove("hidden");
  document.getElementById("btnRec").classList.add("on");
  
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStarted) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    recTime.textContent = `${mm}:${ss}`;
  }, 250);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  recording = false;
  recBadge.classList.add("hidden");
  document.getElementById("btnRec").classList.remove("on");
  clearInterval(recTimer);
}

document.getElementById("btnRec").onclick = () => {
  recording ? stopRecording() : startRecording();
};

async function flipCamera() {
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
  refreshLibrary();
};
document.getElementById("btnCloseLib").onclick = () => {
  document.getElementById("library").classList.add("hidden");
};

const siteInput = document.getElementById("siteName");
siteInput.value = localStorage.getItem("ri_site_name") || "";
siteInput.oninput = () => localStorage.setItem("ri_site_name", siteInput.value);

(async () => {
  await startCamera();
  refreshLibrary();
})();
