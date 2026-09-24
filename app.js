const canvas = document.getElementById("renderCanvas");
const ctx = canvas.getContext("2d");
const vuFill = document.getElementById("vuFill");
const recBadge = document.getElementById("recBadge");
const recTime = document.getElementById("recTime");
const clipCount = document.getElementById("clipCount");
const clipList = document.getElementById("clipList");
const techInfoBadge = document.getElementById("techInfoBadge");

const sBright = document.getElementById("sBright");
const sContrast = document.getElementById("sContrast");

let videoEl = document.createElement("video");
videoEl.playsInline = true;
videoEl.muted = true;
videoEl.autoplay = true;

let stream = null;
let facingMode = "environment";
let audioCtx, analyser, dataArray;
let recording = false;
let mediaRecorder = null;
let recChunks = [];
let recStarted = 0;
let recTimer = null;

// Încărcare imagini din folderul assets (Logo + Site www)
const logoImg = new Image();
logoImg.src = "assets/logo.png";

const siteImg = new Image();
// Înlocuiește "assets/site.png" cu numele exact al fișierului tău PNG cu site-ul (ex: "assets/www.png" sau "assets/site.png")
siteImg.src = "assets/site.png"; 

// Poziții inițiale pe ecran
let logoState = { x: 30, y: 30, w: 100, h: 50 };
let siteState = { x: 30, y: 100, w: 140, h: 40 };

let activeDrag = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

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
    videoEl.srcObject = stream;
    await videoEl.play();

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

// Bucle de randare continuă pe Canvas
function renderFrame() {
  if (videoEl.readyState >= videoEl.HAVE_CURRENT_OF_ENOUGH) {
    if (canvas.width !== videoEl.videoWidth || canvas.height !== videoEl.videoHeight) {
      canvas.width = videoEl.videoWidth || 1280;
      canvas.height = videoEl.videoHeight || 720;
    }

    ctx.save();
    ctx.filter = `brightness(${sBright.value}%) contrast(${sContrast.value}%)`;
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Desenează logo-ul
    if (logoImg.complete && logoImg.naturalWidth !== 0) {
      ctx.drawImage(logoImg, logoState.x, logoState.y, logoState.w, logoState.h);
    }
    // Desenează poza cu site-ul www
    if (siteImg.complete && siteImg.naturalWidth !== 0) {
      ctx.drawImage(siteImg, siteState.x, siteState.y, siteState.w, siteState.h);
    }

    // Informații text șantier & dată (opțional)
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

// Interacțiune tactilă / mouse pentru a muta elementele direct pe canvas
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

canvas.onpointerdown = (e) => {
  const pos = getCanvasCoords(e);
  // Verifică dacă ai dat click pe logo
  if (pos.x >= logoState.x && pos.x <= logoState.x + logoState.w && pos.y >= logoState.y && pos.y <= logoState.y + logoState.h) {
    activeDrag = "logo";
    dragOffsetX = pos.x - logoState.x;
    dragOffsetY = pos.y - logoState.y;
  } 
  // Verifică dacă ai dat click pe site
  else if (pos.x >= siteState.x && pos.x <= siteState.x + siteState.w && pos.y >= siteState.y && pos.y <= siteState.y + siteState.h) {
    activeDrag = "site";
    dragOffsetX = pos.x - siteState.x;
    dragOffsetY = pos.y - siteState.y;
  }
};

canvas.onpointermove = (e) => {
  if (!activeDrag) return;
  const pos = getCanvasCoords(e);
  if (activeDrag === "logo") {
    logoState.x = pos.x - dragOffsetX;
    logoState.y = pos.y - dragOffsetY;
  } else if (activeDrag === "site") {
    siteState.x = pos.x - dragOffsetX;
    siteState.y = pos.y - dragOffsetY;
  }
};

canvas.onpointerup = () => { activeDrag = null; };
canvas.onpointercancel = () => { activeDrag = null; };

// Înregistrare video direct din Canvas (imprimă absolut tot ce se vede)
function startRecording() {
  recChunks = [];
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
  
  const canvasStream = canvas.captureStream(60);
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length) canvasStream.addTrack(audioTracks[0]);

  mediaRecorder = new MediaRecorder(canvasStream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
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

document.getElementById("btnReset").onclick = () => {
  sBright.value = 100;
  sContrast.value = 100;
};

document.getElementById("btnResetPos").onclick = () => {
  logoState.x = 30; logoState.y = 30;
  siteState.x = 30; siteState.y = 100;
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

(async () => {
  await startCamera();
  refreshLibrary();
})();
