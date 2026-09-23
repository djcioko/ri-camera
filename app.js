const liveVideo = document.getElementById("liveVideo");
const canvas = document.getElementById("previewCanvas");
const ctx = canvas.getContext("2d");
const vuFill = document.getElementById("vuFill");
const recBadge = document.getElementById("recBadge");
const recTime = document.getElementById("recTime");
const clipCount = document.getElementById("clipCount");
const clipList = document.getElementById("clipList");
const techInfoBadge = document.getElementById("techInfoBadge");

const sBright = document.getElementById("sBright");
const sContrast = document.getElementById("sContrast");

const logoImg = new Image();
const telImg = new Image();
logoImg.src = "assets/logo.png";
telImg.src = "assets/telefon.png";

let stream = null;
let facingMode = "environment";
let audioCtx, analyser, dataArray;
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
    favorite: false,
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
    clipList.innerHTML = "<p style='color:#777; font-size:12px; text-align:center; margin-top:20px;'>Niciun clip salvat încă.</p>";
    return;
  }
  for (const c of clips) {
    const url = URL.createObjectURL(c.blob);
    const el = document.createElement("div");
    el.className = "clip";
    const dt = new Date(c.createdAt);
    el.innerHTML = `
      <video src="${url}" controls playsinline webkit-playsinline></video>
      <div class="meta">
        <strong>${c.site}</strong><br>
        ${dt.toLocaleTimeString("ro-RO")} <small>${(c.size / 1024 / 1024).toFixed(1)} MB</small>
      </div>
      <button class="icon-btn" data-act="fav" title="Favorit">${c.favorite ? "★" : "☆"}</button>
      <button class="icon-btn" data-act="dl" title="Descarcă">⬇</button>
      <button class="icon-btn" data-act="del" title="Șterge">🗑</button>
    `;
    el.querySelector('[data-act="fav"]').onclick = async () => {
      c.favorite = !c.favorite;
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(c);
      tx.oncomplete = refreshLibrary;
    };
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

    // Detectare FPS efectiv și rezoluție
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
  } catch (err) {
    alert("Erore pornire cameră: " + err.message);
  }
}

function resizeCanvas() {
  const vw = liveVideo.videoWidth || 1920;
  const vh = liveVideo.videoHeight || 1080;
  canvas.width = vw;
  canvas.height = vh;
}

function drawTransparentPng(img, x, y, w, h) {
  if (!img.complete || !img.naturalWidth) return;
  const off = document.createElement("canvas");
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const octx = off.getContext("2d");
  octx.drawImage(img, 0, 0);
  const data = octx.getImageData(0, 0, off.width, off.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] < 30 && px[i + 1] < 30 && px[i + 2] < 30) px[i + 3] = 0;
  }
  octx.putImageData(data, 0, 0);
  ctx.drawImage(off, x, y, w, h);
}

function drawFrame() {
  const w = canvas.width;
  const h = canvas.height;
  if (w && h && liveVideo.readyState >= 2) {
    ctx.save();
    ctx.filter = `brightness(${sBright.value}%) contrast(${sContrast.value}%)`;
    ctx.drawImage(liveVideo, 0, 0, w, h);
    ctx.restore();

    // Logo stânga sus / Telefon dreapta sus pe randare
    const logoSize = w * 0.18;
    drawTransparentPng(logoImg, 30, 30, logoSize, logoSize * (logoImg.naturalHeight / logoImg.naturalWidth || 0.5));
    
    const telSize = w * 0.28;
    drawTransparentPng(telImg, w - telSize - 30, 30, telSize, telSize * (telImg.naturalHeight / telImg.naturalWidth || 0.3));

    if (document.getElementById("chkDate")?.checked) {
      const site = (document.getElementById("siteName").value || "Șantier").trim();
      const d = new Date().toLocaleString("ro-RO");
      ctx.save();
      ctx.font = `bold ${Math.max(16, Math.round(w * 0.022))}px sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.textAlign = "right";
      ctx.fillText(`${site} | ${d}`, w - 30, h - 30);
      ctx.restore();
    }
  }

  if (analyser && dataArray) {
    analyser.getByteTimeDomainData(dataArray);
    let peak = 0;
    for (let i = 0; i < dataArray.length; i++) peak = Math.max(peak, Math.abs(dataArray[i] - 128));
    vuFill.style.height = `${Math.min(100, Math.max(5, (peak / 128) * 140))}%`;
  }

  requestAnimationFrame(drawFrame);
}

// Înregistrare Video
function startRecording() {
  const streamToCapture = canvas.captureStream(60);
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length) streamToCapture.addTrack(audioTracks[0]);

  recChunks = [];
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
  mediaRecorder = new MediaRecorder(streamToCapture, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  
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

// Butoane Control
document.getElementById("btnFlipMicro").onclick = async () => {
  facingMode = facingMode === "environment" ? "user" : "environment";
  await startCamera();
};

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

document.getElementById("btnGrid").onclick = () => {
  // Opțional toggle grid dacă e cazul
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

liveVideo.addEventListener("loadedmetadata", () => {
  resizeCanvas();
  drawFrame();
});

(async () => {
  await startCamera();
  refreshLibrary();
})();
