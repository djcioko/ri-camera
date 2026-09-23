const liveVideo = document.getElementById("liveVideo");
const canvas = document.getElementById("previewCanvas");
const ctx = canvas.getContext("2d");
const vuFill = document.getElementById("vuFill");
const recBadge = document.getElementById("recBadge");
const recTime = document.getElementById("recTime");
const clipCount = document.getElementById("clipCount");
const clipList = document.getElementById("clipList");

const sBright = document.getElementById("sBright");
const sContrast = document.getElementById("sContrast");
const sSaturate = document.getElementById("sSaturate");
const sZoom = document.getElementById("sZoom");

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
let captureStream = null;

const overlays = {
  logo: { size: 70, rot: 0, x: 0, y: 0 },
  tel: { size: 70, rot: 0, x: 0, y: 8 },
};
let activeOv = "logo";

const DB_NAME = "ri-camera";
const STORE = "clips";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
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
    type: blob.type || "video/webm",
    favorite: false,
    site: (document.getElementById("siteName").value || "santier").trim(),
    blob,
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(clip);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await refreshLibrary();
}

async function getClips() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.id - a.id));
    req.onerror = () => reject(req.error);
  });
}

async function toggleFavorite(id) {
  const clips = await getClips();
  const c = clips.find((x) => x.id === id);
  if (!c) return;
  c.favorite = !c.favorite;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(c);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await refreshLibrary();
}

async function deleteClip(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await refreshLibrary();
}

async function refreshLibrary() {
  const clips = await getClips();
  clipCount.textContent = clips.length;
  clipList.innerHTML = "";
  if (!clips.length) {
    clipList.innerHTML = "<p class='hint'>Niciun clip încă. Filmează pe șantier și rămân aici.</p>";
    return;
  }
  for (const c of clips) {
    const url = URL.createObjectURL(c.blob);
    const el = document.createElement("div");
    el.className = "clip";
    const dt = new Date(c.createdAt);
    el.innerHTML = `
      <video src="${url}" muted playsinline></video>
      <div class="meta">
        ${c.favorite ? "★ " : ""}${dt.toLocaleString("ro-RO")}
        <small>${(c.size / 1024 / 1024).toFixed(1)} MB ${c.favorite ? "· CEL MAI BUN" : ""}</small>
      </div>
      <button class="pill" data-act="fav">${c.favorite ? "★" : "☆"}</button>
      <button class="pill" data-act="play">▶</button>
      <button class="pill" data-act="dl">Salvează</button>
      <button class="pill" data-act="del">Șterge</button>
    `;
    const v = el.querySelector("video");
    el.querySelector('[data-act="fav"]').onclick = () => toggleFavorite(c.id);
    el.querySelector('[data-act="play"]').onclick = () => {
      if (v.paused) { v.muted = false; v.play(); } else v.pause();
    };
    el.querySelector('[data-act="dl"]').onclick = () => {
      const a = document.createElement("a");
      a.href = url;
      const site = (c.site || "santier").replace(/\s+/g, "_");
      a.download = `RI_${site}_${dt.toISOString().slice(0,10)}_${c.id}.webm`;
      a.click();
    };
    el.querySelector('[data-act="del"]').onclick = () => deleteClip(c.id);
    clipList.appendChild(el);
  }
}

async function startCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: {
      facingMode,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  liveVideo.srcObject = stream;
  await liveVideo.play();

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  dataArray = new Uint8Array(analyser.frequencyBinCount);

  resizeCanvas();
}

function resizeCanvas() {
  const maxW = canvas.clientWidth || window.innerWidth;
  const maxH = canvas.clientHeight || window.innerHeight * 0.55;
  const vw = liveVideo.videoWidth || 1280;
  const vh = liveVideo.videoHeight || 720;
  const scale = Math.min(maxW / vw, maxH / vh) || 1;
  canvas.width = Math.round(vw * scale) || maxW;
  canvas.height = Math.round(vh * scale) || maxH;
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
    if (px[i] < 28 && px[i + 1] < 28 && px[i + 2] < 28) px[i + 3] = 0;
  }
  octx.putImageData(data, 0, 0);
  ctx.drawImage(off, x, y, w, h);
}

function drawFrame() {
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) {
    requestAnimationFrame(drawFrame);
    return;
  }

  const bright = sBright.value;
  const contrast = sContrast.value;
  const saturate = sSaturate.value;
  const zoom = sZoom.value / 100;

  ctx.save();
  ctx.filter = `brightness(${bright}%) contrast(${contrast}%) saturate(${saturate}%)`;

  const vw = liveVideo.videoWidth || w;
  const vh = liveVideo.videoHeight || h;
  const zw = vw / zoom;
  const zh = vh / zoom;
  const sx = (vw - zw) / 2;
  const sy = (vh - zh) / 2;
  if (liveVideo.readyState >= 2) {
    ctx.drawImage(liveVideo, sx, sy, zw, zh, 0, 0, w, h);
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  function drawOv(img, ov, baseW) {
    if (!img.complete || !img.naturalWidth) return;
    const scale = ov.size / 70;
    const dw = baseW * scale;
    const dh = dw * (img.naturalHeight / img.naturalWidth);
    const cx = w / 2 + (ov.x / 100) * w;
    const cy = 16 + dh / 2 + (ov.y / 100) * h;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((ov.rot * Math.PI) / 180);
    drawTransparentPng(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  drawOv(logoImg, overlays.logo, Math.min(w * 0.32, 240));
  drawOv(telImg, overlays.tel, Math.min(w * 0.62, 460));

  if (document.getElementById("chkDate")?.checked) {
    const site = (document.getElementById("siteName").value || "R&I").trim();
    const d = new Date().toLocaleDateString("ro-RO");
    ctx.save();
    ctx.font = `600 ${Math.max(12, Math.round(w * 0.022))}px sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,.88)";
    ctx.textAlign = "right";
    ctx.fillText(`${site} · ${d}`, w - 12, h - 14);
    ctx.restore();
  }

  if (analyser && dataArray) {
    analyser.getByteTimeDomainData(dataArray);
    let peak = 0;
    for (let i = 0; i < dataArray.length; i++) {
      peak = Math.max(peak, Math.abs(dataArray[i] - 128));
    }
    const pct = Math.min(100, (peak / 128) * 160);
    vuFill.style.height = `${Math.max(6, pct)}%`;
  }

  requestAnimationFrame(drawFrame);
}

function mimeType() {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function startRecording() {
  captureStream = canvas.captureStream(30);
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length) captureStream.addTrack(audioTracks[0]);

  recChunks = [];
  mediaRecorder = new MediaRecorder(captureStream, { mimeType: mimeType(), videoBitsPerSecond: 6_000_000 });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "video/webm" });
    await saveClip(blob);
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
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  recording ? stopRecording() : startRecording();
};

document.getElementById("btnFlip").onclick = async () => {
  facingMode = facingMode === "environment" ? "user" : "environment";
  await startCamera();
};

document.getElementById("btnReset").onclick = () => {
  sBright.value = 100;
  sContrast.value = 100;
  sSaturate.value = 110;
  sZoom.value = 100;
  overlays.logo = { size: 70, rot: 0, x: 0, y: 0 };
  overlays.tel = { size: 70, rot: 0, x: 0, y: 8 };
  syncOvSliders();
};

function syncOvSliders() {
  const o = overlays[activeOv];
  document.getElementById("sOvSize").value = o.size;
  document.getElementById("sOvRot").value = o.rot;
  document.getElementById("sOvX").value = o.x;
  document.getElementById("sOvY").value = o.y;
  document.getElementById("tabLogo").classList.toggle("on", activeOv === "logo");
  document.getElementById("tabTel").classList.toggle("on", activeOv === "tel");
}
document.getElementById("tabLogo").onclick = () => { activeOv = "logo"; syncOvSliders(); };
document.getElementById("tabTel").onclick = () => { activeOv = "tel"; syncOvSliders(); };
["sOvSize", "sOvRot", "sOvX", "sOvY"].forEach((id) => {
  document.getElementById(id).oninput = () => {
    overlays[activeOv].size = +document.getElementById("sOvSize").value;
    overlays[activeOv].rot = +document.getElementById("sOvRot").value;
    overlays[activeOv].x = +document.getElementById("sOvX").value;
    overlays[activeOv].y = +document.getElementById("sOvY").value;
  };
});

document.getElementById("btnLibrary").onclick = () => {
  document.getElementById("library").classList.remove("hidden");
  refreshLibrary();
};
document.getElementById("btnCloseLib").onclick = () => {
  document.getElementById("library").classList.add("hidden");
};

function clipFileName(c) {
  const site = (c.site || document.getElementById("siteName").value || "santier").replace(/\s+/g, "_");
  const day = (c.createdAt || "").slice(0, 10);
  return `RI_${site}_${day}_${c.id}.webm`;
}

document.getElementById("btnFavExport").onclick = async () => {
  const clips = (await getClips()).filter((c) => c.favorite);
  if (!clips.length) {
    alert("Marchează întâi clipurile bune cu ☆.");
    return;
  }
  for (const c of clips) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(c.blob);
    a.download = clipFileName(c);
    a.click();
    await new Promise((r) => setTimeout(r, 400));
  }
};

async function renderMontage(clips) {
  const w = 1280, h = 720, fps = 30, hold = 3.2;
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const octx = off.getContext("2d");
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true;

  const outStream = off.captureStream(fps);
  const music = document.getElementById("musicFile").files[0];
  let audioDest = null;
  const actx = new (window.AudioContext || window.webkitAudioContext)();
  audioDest = actx.createMediaStreamDestination();
  if (music) {
    const buf = await actx.decodeAudioData(await music.arrayBuffer());
    const src = actx.createBufferSource();
    src.buffer = buf;
    const gain = actx.createGain();
    gain.gain.value = 0.35;
    src.connect(gain); gain.connect(audioDest);
    src.start();
  }
  outStream.addTrack(audioDest.stream.getAudioTracks()[0]);
  const chunks = [];
  const rec = new MediaRecorder(outStream, { mimeType: mimeType(), videoBitsPerSecond: 5_000_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });
  rec.start(200);

  for (const c of clips.slice().reverse()) {
    v.src = URL.createObjectURL(c.blob);
    await v.play().catch(() => {});
    const t0 = performance.now();
    while ((performance.now() - t0) / 1000 < hold) {
      octx.fillStyle = "#000"; octx.fillRect(0, 0, w, h);
      if (v.readyState >= 2) octx.drawImage(v, 0, 0, w, h);
      const fade = Math.min(1, (performance.now() - t0) / 280, (hold * 1000 - (performance.now() - t0)) / 280);
      octx.fillStyle = `rgba(0,0,0,${1 - fade})`;
      octx.fillRect(0, 0, w, h);
      await new Promise((r) => requestAnimationFrame(r));
    }
    v.pause();
  }
  rec.stop();
  await stopped;
  return new Blob(chunks, { type: rec.mimeType || "video/webm" });
}

document.getElementById("btnMontage").onclick = async () => {
  let clips = await getClips();
  const favs = clips.filter((c) => c.favorite);
  if (favs.length) clips = favs;
  if (!clips.length) { alert("Nu există clipuri de montat."); return; }
  const btn = document.getElementById("btnMontage");
  btn.textContent = "Bot-ul editează…";
  try {
    const blob = await renderMontage(clips);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const site = (document.getElementById("siteName").value || "santier").replace(/\s+/g, "_");
    a.download = `RI_MONTAJ_${site}_${new Date().toISOString().slice(0, 10)}.webm`;
    a.click();
  } catch (e) {
    alert("Montaj eșuat: " + e.message);
  }
  btn.textContent = "🤖 Bot editor — montaj (2–4s, fade)";
};

document.getElementById("btnGrid").onclick = () => {
  document.getElementById("grid").classList.toggle("hidden");
};
let aeLocked = false;
document.getElementById("btnLock").onclick = async () => {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return;
  aeLocked = !aeLocked;
  try {
    await track.applyConstraints({
      advanced: [{ exposureMode: aeLocked ? "locked" : "continuous", focusMode: aeLocked ? "locked" : "continuous" }],
    });
  } catch (_) {}
  document.getElementById("lockBadge").classList.toggle("hidden", !aeLocked);
};
document.getElementById("btnGloves").onclick = () => {
  document.body.classList.toggle("gloves");
};
const siteEl = document.getElementById("siteName");
siteEl.value = localStorage.getItem("ri-site") || "";
siteEl.oninput = () => localStorage.setItem("ri-site", siteEl.value);

window.addEventListener("resize", resizeCanvas);
liveVideo.addEventListener("loadedmetadata", resizeCanvas);

(async function init() {
  try {
    await startCamera();
  } catch (e) {
    alert("Trebuie permisă camera + microfonul. Deschide pagina pe HTTPS sau localhost.\n" + e.message);
  }
  drawFrame();
  refreshLibrary();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
