(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RISpeechRecognizer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  const scriptURL = root.document && root.document.currentScript && root.document.currentScript.src;
  const workerURL = scriptURL ? new URL("subtitle-worker.js", scriptURL).href : "./subtitle-worker.js";
  const SAMPLE_RATE = 16000;

  function abortError() {
    return new DOMException("Transcrierea a fost anulată.", "AbortError");
  }

  function isNearSilent(audio) {
    let sum = 0;
    let sumSquares = 0;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const sample of audio) {
      if (!Number.isFinite(sample)) throw new Error("Datele audio pentru transcriere sunt invalide.");
      sum += sample;
      sumSquares += sample * sample;
      minimum = Math.min(minimum, sample);
      maximum = Math.max(maximum, sample);
    }
    if (!audio.length) return true;
    const mean = sum / audio.length;
    const rms = Math.sqrt(Math.max(0, sumSquares / audio.length - mean * mean));
    // A conservative silence check, not a speech or speaker classifier.
    return rms <= 0.0001 && maximum - minimum <= 0.001;
  }

  function hasExtremeRepetition(text) {
    const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    // Reject an obvious decoder loop as a failed attempt; never trim it into a
    // plausible caption. Short, ordinary repetitions are deliberately allowed.
    for (let period = 1; period <= 6; period++) {
      let run = period;
      const limit = Math.max(24, period * 8);
      for (let index = period; index < words.length; index++) {
        run = words[index] === words[index - period] ? run + 1 : period;
        if (run >= limit) return true;
      }
    }
    return false;
  }

  /**
   * Transcribe mono, 16 kHz PCM locally. The audio buffer is transferred to the
   * worker and must not be reused by the caller after this call starts.
   * Each call owns one worker, released before the returned promise settles.
   */
  async function transcribe(audio, { signal, onProgress } = {}) {
    if (signal && signal.aborted) throw abortError();
    if (!(audio instanceof Float32Array)) throw new Error("Transcrierea necesită date audio PCM.");
    const progress = (message) => {
      if (typeof onProgress === "function") {
        try { onProgress(message); } catch (_) { /* UI updates must not strand the worker. */ }
      }
    };
    if (isNearSilent(audio)) {
      progress("Nu există sunet suficient pentru transcriere.");
      return { text: "", chunks: [] };
    }
    if (typeof root.Worker !== "function") {
      throw new Error("Acest browser nu permite transcrierea automată. Încearcă un browser actualizat.");
    }

    const duration = audio.length / SAMPLE_RATE;
    // The first model download is about 760 MB, and mobile inference can be
    // slow. Allow at least 15 minutes, but keep a finite deadline as well as the
    // immediate cancellation path for an unresponsive download or worker.
    const timeoutMs = Math.min(30 * 60 * 1000, Math.max(15 * 60 * 1000, 120000 + duration * 20000));
    let worker;
    let timer;
    let onAbort;
    try {
      worker = new root.Worker(workerURL, { type: "module" });
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(result);
        };
        onAbort = () => finish(abortError());
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        if (signal && signal.aborted) { onAbort(); return; }

        worker.onmessage = ({ data }) => {
          if (settled || !data) return;
          if (data.type === "progress") {
            if (typeof data.message === "string") progress(data.message);
          } else if (data.type === "result") {
            if (!data.result || typeof data.result.text !== "string" || !Array.isArray(data.result.chunks)) {
              finish(new Error("Transcrierea nu a furnizat un rezultat valid."));
            } else if (hasExtremeRepetition(data.result.text)) {
              finish(new Error("Transcrierea a produs prea multe repetiții. Reîncearcă un clip mai scurt, cu vocea mai clară."));
            } else {
              finish(null, data.result);
            }
          } else if (data.type === "error") {
            finish(new Error(data.message || "Transcrierea nu a putut fi finalizată."));
          }
        };
        worker.onerror = (event) => {
          if (event.preventDefault) event.preventDefault();
          finish(new Error("Motorul de transcriere nu a putut porni sau s-a oprit. Verifică internetul și reîncearcă."));
        };
        worker.onmessageerror = () => finish(new Error("Rezultatul transcrierii nu a putut fi citit."));
        timer = setTimeout(() => finish(new DOMException(
          "Transcrierea a durat prea mult pe acest dispozitiv. Încearcă un clip mai scurt.",
          "TimeoutError"
        )), timeoutMs);
        progress("Se pregătește transcrierea în limba română…");
        worker.postMessage({ type: "transcribe", audio }, [audio.buffer]);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      }
    }
  }

  return { transcribe };
});
