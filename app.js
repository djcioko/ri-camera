const liveVideo = document.getElementById("liveVideo");
const stageCanvas = document.getElementById("stageCanvas");
const ctx = stageCanvas.getContext("2d");
const stageArea = document.getElementById("stageArea") || document.querySelector(".stage");

const vuFill = document.getElementById("vuFill");
const recBadge = document.getElementById("recBadge");
const recTime = document.getElementById("recTime");
const clipCount = document.getElementById("clipCount");
const clipList = document.getElementById("clipList");
const techInfoBadge = document.getElementById("techInfoBadge");

const sBright = document.getElementById("sBright");
const sContrast = document.getElementById("sContrast");

const draggableLogo = document.getElementById("draggableLogo");
const draggableSite = document.getElementById("draggableSite");
const logoImg = draggableLogo.querySelector("img");
const siteImgEl = draggableSite.querySelector("img");

let stream = null;
let facingMode = "environment";

let audioCtx, analyser, dataArray;
let destNode = null;
let micSourceNode = null;

let recording = false;
let mediaRecorder = null;
let recChunks = [];
let recStarted = 0;
let recTimer = null;

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
        <button class="icon-btn" data-act="dl" title="Descarcă clipul">⬇ Descarcă / Deschide</button>
        <button class="icon-btn" data-act="del" title="Șterge">🗑 Șterge</button>
      </div>
    `;
    el.querySelector('[data-act="dl"]').onclick = () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = `RI_${c.site}_${c.id}.webm`;
      a.click();
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

async function startCamera() {
  const oldStream = stream;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, min: 30 }
      },
    });

    liveVideo.srcObject = newStream;
    await liveVideo.play();
    stream = newStream;

    const track = newStream.getVideoTracks()[0];
    const settings = track.getSettings();
    const vw = settings.width || 1920;
    const vh = settings.height || 1080;
    if (stageCanvas.width !== vw || stageCanvas.height !== vh) {
      stageCanvas.width = vw;
      stageCanvas.height = vh;
    }
    techInfoBadge.textContent = `${vw}x${vh} / ${Math.round(settings.frameRate || 60)} FPS`;

    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } else if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    if (!destNode) {
      destNode = audioCtx.createMediaStreamDestination();
    }
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      monitorAudio();
    }

    if (micSourceNode) {
      try { micSourceNode.disconnect(); } catch (_) {}
    }
    micSourceNode = audioCtx.createMediaStreamSource(newStream);
    micSourceNode.connect(destNode);
    micSourceNode.connect(analyser);

    if (oldStream) oldStream.getTracks().forEach((t) => t.stop());

    if (!drawLoopStarted) {
      drawLoopStarted = true;
      requestAnimationFrame(drawFrame);
    }
  } catch (err) {
    alert("Eroare pornire cameră: " + err.message);
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

let drawLoopStarted = false;

function drawFrame() {
  if (liveVideo.readyState >= 2 && stageCanvas.width && stageCanvas.height) {
    ctx.save();
    ctx.filter = `brightness(${sBright.value}%) contrast(${sContrast.value}%)`;
    ctx.drawImage(liveVideo, 0, 0, stageCanvas.width, stageCanvas.height);
    ctx.restore();

    drawOverlayImage(logoImg, draggableLogo);
    drawOverlayImage(siteImgEl, draggableSite);
  }
  requestAnimationFrame(drawFrame);
}

function getCoverTransform() {
  const rect = stageArea.getBoundingClientRect();
  const iw = stageCanvas.width || 1;
  const ih = stageCanvas.height || 1;
  const s = Math.max(rect.width / iw, rect.height / ih) || 1;
  return {
    s,
    offsetX: (iw * s - rect.width) / 2,
    offsetY: (ih * s - rect.height) / 2,
  };
}

function drawOverlayImage(imgEl, wrapperEl) {
  if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) return;
  const t = getCoverTransform();
  const cssX = wrapperEl.offsetLeft;
  const cssY = wrapperEl.offsetTop;
  const cssW = wrapperEl.offsetWidth;
  const cssH = wrapperEl.offsetHeight;
  const cx = (cssX + t.offsetX) / t.s;
  const cy = (cssY + t.offsetY) / t.s;
  const cw = cssW / t.s;
  const ch = cssH / t.s;
  ctx.drawImage(imgEl, cx, cy, cw, ch);
}

function startRecording() {
  if (!stageCanvas.captureStream) {
    alert("Browserul tău nu suportă înregistrarea din canvas.");
    return;
  }
  recChunks = [];
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";

  const canvasStream = stageCanvas.captureStream(30);
  const recordStream = new MediaStream();
  canvasStream.getVideoTracks().forEach((t) => recordStream.addTrack(t));
  if (destNode) destNode.stream.getAudioTracks().forEach((t) => recordStream.addTrack(t));

  mediaRecorder = new MediaRecorder(recordStream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recChunks, { type: mime });
    saveClip(blob);
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

let locked = false;
document.getElementById("btnLock").onclick = async () => {
  locked = !locked;
  const track = stream?.getVideoTracks()[0];
  if (track) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: locked ? "locked" : "continuous", exposureMode: locked ? "locked" : "continuous" }] });
    } catch (_) {}
  }
  document.getElementById("lockBadge").classList.toggle("hidden", !locked);
};

document.getElementById("btnReset").onclick = () => {
  sBright.value = 100;
  sContrast.value = 100;
};

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

function makeDraggable(elm) {
  let startX = 0, startY = 0, posX = 0, posY = 0;

  const savedX = localStorage.getItem(elm.id + "_x");
  const savedY = localStorage.getItem(elm.id + "_y");
  if (savedX !== null && savedY !== null) {
    elm.style.left = savedX + "px";
    elm.style.top = savedY + "px";
    elm.style.right = "auto";
  }
  const savedW = localStorage.getItem(elm.id + "_w");
  if (savedW !== null) {
    elm.style.width = savedW + "px";
  }

  elm.onpointerdown = dragMouseDown;

  function dragMouseDown(e) {
    e.preventDefault();
    posX = e.clientX;
    posY = e.clientY;
    document.onpointermove = elementDrag;
    document.onpointerup = closeDragElement;
  }

  function elementDrag(e) {
    e.preventDefault();
    startX = posX - e.clientX;
    startY = posY - e.clientY;
    posX = e.clientX;
    posY = e.clientY;

    elm.style.top = (elm.offsetTop - startY) + "px";
    elm.style.left = (elm.offsetLeft - startX) + "px";
    elm.style.right = "auto";
  }

  function closeDragElement() {
    document.onpointermove = null;
    document.onpointerup = null;
    localStorage.setItem(elm.id + "_x", elm.offsetLeft);
    localStorage.setItem(elm.id + "_y", elm.offsetTop);
  }
}

function makeResizable(elm, minWidth, maxWidth) {
  const handle = elm.querySelector(".resize-handle");
  if (!handle) return;
  let startW = 0, startX = 0;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startW = elm.offsetWidth;
    startX = e.clientX;

    const move = (ev) => {
      const dx = ev.clientX - startX;
      const newW = Math.min(maxWidth, Math.max(minWidth, startW + dx));
      elm.style.width = newW + "px";
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      localStorage.setItem(elm.id + "_w", elm.offsetWidth);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
}

makeDraggable(draggableLogo);
makeDraggable(draggableSite);
makeResizable(draggableLogo, 40, 320);
makeResizable(draggableSite, 40, 320);

(async () => {
  await startCamera();
  refreshLibrary();
})();
