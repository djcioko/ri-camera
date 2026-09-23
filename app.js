let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let currentFacingMode = 'environment'; // 'user' pentru față, 'environment' pentru spate
let recordings = []; // Coada de înregistrări cronologice

const videoPreview = document.getElementById('video-preview');
const btnRecord = document.getElementById('btn-record');
const btnSwitchCam = document.getElementById('btn-switch-cam');
const btnFullscreen = document.getElementById('btn-fullscreen');
const infoBadge = document.getElementById('info-badge');
const vumeterBar = document.getElementById('vumeter-bar');

const playbackModal = document.getElementById('playback-modal');
const videoPlayer = document.getElementById('video-player');
const btnCloseModal = document.getElementById('btn-close-modal');
const queueList = document.getElementById('queue-list');

// Inițializare Cameră
async function initCamera(facingMode = 'environment') {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }

    try {
        const constraints = {
            video: {
                facingMode: facingMode,
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 60 }
            },
            audio: true
        };

        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        videoPreview.srcObject = mediaStream;

        // Detecție cadru și FPS efectiv pentru afișare în info badge
        const videoTrack = mediaStream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        infoBadge.innerText = `${settings.height || 1080}p • ${settings.frameRate || 60} FPS`;

        setupAudioMeter(mediaStream);
    } catch (error) {
        console.error("Erore la pornirea camerei:", error);
        alert("Nu s-a putut accesa camera sau microfonul.");
    }
}

// Simulare Vumetru Audio pe baza fluxului de microfon
function setupAudioMeter(stream) {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioCtx.createAnalyser();
        const microphone = audioCtx.createMediaStreamSource(stream);
        const javascriptNode = audioCtx.createScriptProcessor(2048, 1, 1);

        analyser.smoothingTimeConstant = 0.8;
        analyser.fftSize = 512;

        microphone.connect(analyser);
        analyser.connect(javascriptNode);
        javascriptNode.connect(audioCtx.destination);

        javascriptNode.onaudioprocess = () => {
            const array = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(array);
            let values = 0;
            for (let i = 0; i < array.length; i++) {
                values += array[i];
            }
            let average = values / array.length;
            let percentage = Math.min(100, (average / 128) * 100);
            vumeterBar.style.width = percentage + '%';
        };
    } catch (e) {
        console.log("Audio context eroare / nepermis:", e);
    }
}

// Comutare Cameră Față / Spate chiar și în timpul înregistrării
btnSwitchCam.addEventListener('click', () => {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    initCamera(currentFacingMode);
});

// Fullscreen Toggle
btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            alert(`Erore la activarea ecranului complet: ${err.message}`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
});

// Gestionare Înregistrare Video (Record)
btnRecord.addEventListener('click', () => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        startRecording();
    } else {
        stopRecording();
    }
});

function startRecording() {
    recordedChunks = [];
    try {
        mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'video/webm; codecs=vp9' });
    } catch (e) {
        mediaRecorder = new MediaRecorder(mediaStream); // Fallback
    }

    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };

    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const videoUrl = URL.createObjectURL(blob);
        const timestamp = new Date().toLocaleTimeString();

        const recordingObj = {
            id: Date.now(),
            url: videoUrl,
            time: timestamp,
            blob: blob
        };

        recordings.push(recordingObj);
        renderQueue();
    };

    mediaRecorder.start();
    btnRecord.classList.add('recording');
    btnRecord.innerText = "■ STOP";
}

function stopRecording() {
    mediaRecorder.stop();
    btnRecord.classList.remove('recording');
    btnRecord.innerText = "● REC";
}

// Randare Coadă / Rând cronologic
function renderQueue() {
    queueList.innerHTML = '';
    recordings.forEach((rec, index) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        item.innerText = `Video #${index + 1}\n${rec.time}`;
        item.onclick = () => openPlayer(rec);
        queueList.appendChild(item);
    });
}

// Deschidere Player Full format cu X pentru întoarcere în rând
function openPlayer(recording) {
    videoPlayer.src = recording.url;
    playbackModal.classList.remove('hidden');
    videoPlayer.play();
}

btnCloseModal.addEventListener('click', () => {
    videoPlayer.pause();
    videoPlayer.src = '';
    playbackModal.classList.add('hidden');
});

// Pornire lancadrare inițială
window.addEventListener('DOMContentLoaded', () => {
    initCamera(currentFacingMode);
});
