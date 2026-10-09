// The model and runtime are downloaded; recorded audio stays in this worker.
// Pin both the runtime and model revision so future releases cannot change the
// decoder or WASM files underneath an existing installation.
// Version 4 includes Whisper generation and word timestamp fixes from upstream
// PR #1594; 3.8.1 can repeat tokens on Romanian audio with word timestamps.
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";
// The smaller base/small checkpoints produced phonetic errors on independent
// Romanian speech fixtures. This timestamp-enabled turbo export retains useful
// Romanian recognition while q4 limits its download and session memory.
const MODEL_ID = "onnx-community/whisper-large-v3-turbo_timestamped";
const MODEL_REVISION = "b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a";
const MODEL_FILE_BYTES = {
  "encoder_model_q4.onnx": 425003939,
  "decoder_model_merged_q4.onnx": 334207912,
};
const MODEL_TOTAL_BYTES = Object.values(MODEL_FILE_BYTES).reduce((sum, size) => sum + size, 0);
let running = false;

function progress(message) {
  self.postMessage({ type: "progress", message });
}

self.onmessage = async ({ data }) => {
  if (running || !data || data.type !== "transcribe") return;
  running = true;
  let transcriber;
  let modelReady = false;
  try {
    if (!(data.audio instanceof Float32Array)) throw new Error("Invalid PCM input");
    progress("Se încarcă motorul de transcriere…");
    // Dynamic import keeps module download failures inside this error boundary.
    // The parent also handles worker startup errors and a stalled download.
    const { pipeline, env } = await import(TRANSFORMERS_URL);
    env.allowLocalModels = false;
    env.useBrowserCache = typeof caches !== "undefined";
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;

    const loadedBytes = new Map();
    let lastPercent = -1;
    progress("Se încarcă modelul vocal pentru limba română…");
    transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, {
      revision: MODEL_REVISION,
      device: "wasm",
      dtype: "q4",
      progress_callback: (event) => {
        const file = String(event.file || "").split("/").pop();
        const size = MODEL_FILE_BYTES[file];
        if (!size) return;
        if (event.status === "done") loadedBytes.set(file, size);
        else if (event.status === "progress" && Number.isFinite(event.loaded)) {
          loadedBytes.set(file, Math.min(size, event.loaded));
        }
        const total = [...loadedBytes.values()].reduce((sum, value) => sum + value, 0);
        const percent = Math.min(100, Math.floor(total / MODEL_TOTAL_BYTES * 100));
        if (percent > lastPercent) {
          lastPercent = percent;
          progress(`Se încarcă modelul vocal: ${percent}%…`);
        }
      },
    });
    modelReady = true;
    progress("Se transcrie în limba română…");
    const output = await transcriber(data.audio, {
      language: "romanian",
      task: "transcribe",
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      num_beams: 1,
      do_sample: false,
    });
    const result = {
      text: output.text || "",
      chunks: (output.chunks || []).map((chunk) => ({
        text: chunk.text || "",
        timestamp: [chunk.timestamp[0], chunk.timestamp[1]],
      })),
    };
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: modelReady
        ? "Transcrierea nu a putut fi finalizată pe acest dispozitiv. Încearcă un clip mai scurt."
        : "Modelul vocal nu s-a putut încărca. Verifică internetul, spațiul disponibil și reîncearcă.",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // The parent terminates this worker after success, failure, or cancellation.
    // Dispose too when it remains alive long enough to release the sessions.
    if (transcriber) {
      try { await transcriber.dispose(); } catch (_) { /* Worker termination also releases the sessions. */ }
    }
  }
};
