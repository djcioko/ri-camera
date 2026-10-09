(function (root) {
  "use strict";

  // The wrapper and its Worker are same-origin. The single-thread core does not
  // require SharedArrayBuffer or COOP/COEP headers (including on GitHub Pages).
  const baseURL = new URL(".", root.document.currentScript?.src || root.location.href);
  const coreBaseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
  const coreCacheName = "ri-ffmpeg-core-v0.12.10";
  const sampleRate = 16000;
  let operationQueue = Promise.resolve();

  function cancelled() {
    return new DOMException("Procesarea a fost anulată.", "AbortError");
  }

  function checkSignal(signal) {
    if (signal?.aborted) throw cancelled();
  }

  // FFmpeg's AbortSignal support rejects a message but does not stop its work.
  // We also terminate the Worker, and remove our listeners after every wait.
  function waitFor(promise, signal, { timeout = 0, onCancel, timeoutMessage } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      const stop = (error) => {
        finish(reject, error);
        try { onCancel?.(); } catch (_) { /* The caller still receives the error. */ }
      };
      const abort = () => stop(cancelled());
      signal?.addEventListener("abort", abort, { once: true });
      if (timeout) {
        timer = setTimeout(() => stop(new Error(timeoutMessage || "Procesarea nu a răspuns la timp. Reîncearcă.")), timeout);
      }
      Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
      if (signal?.aborted) abort();
    });
  }

  function progress(callback, message) {
    // A UI update must never stop encoding or prevent cleanup.
    try { callback?.(message); } catch (_) { /* Ignore a detached UI callback. */ }
  }

  function enqueue(operation, signal) {
    const pending = operationQueue.then(() => {
      checkSignal(signal);
      return operation();
    });
    operationQueue = pending.catch(() => {});
    // A cancelled queued request can settle before the current job finishes.
    return waitFor(pending, signal);
  }

  async function loadWrapper(signal) {
    checkSignal(signal);
    if (root.FFmpegWASM?.FFmpeg) return;
    const script = root.document.createElement("script");
    script.src = new URL("vendor/ffmpeg/ffmpeg.js", baseURL).href;
    const loaded = new Promise((resolve, reject) => {
      script.onload = () => root.FFmpegWASM?.FFmpeg
        ? resolve()
        : reject(new Error("Biblioteca video nu s-a inițializat. Reîncarcă pagina."));
      script.onerror = () => reject(new Error("Biblioteca video nu poate fi încărcată. Verifică conexiunea și reîncearcă."));
      root.document.head.appendChild(script);
    });
    try {
      await waitFor(loaded, signal, {
        timeout: 30000,
        onCancel: () => script.remove(),
        timeoutMessage: "Biblioteca video nu s-a încărcat la timp. Reîncearcă.",
      });
    } catch (error) {
      script.remove();
      throw error;
    } finally {
      script.onload = null;
      script.onerror = null;
    }
  }

  async function openCoreCache(signal) {
    if (!root.caches) return null;
    try {
      return await waitFor(root.caches.open(coreCacheName), signal);
    } catch (error) {
      checkSignal(signal);
      // Private browsing or insufficient storage must not block processing.
      return null;
    }
  }

  async function fetchAsset(url, type, { signal, cache, reload = false } = {}) {
    checkSignal(signal);
    if (cache && !reload) {
      try {
        const stored = await waitFor(cache.match(url), signal);
        if (stored?.ok) {
          const blob = await waitFor(stored.blob(), signal);
          if (blob.size) return new Blob([blob], { type });
        }
      } catch (error) {
        checkSignal(signal);
      }
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      checkSignal(signal);
      const controller = new AbortController();
      try {
        const response = await waitFor(root.fetch(url, {
          signal: controller.signal,
          cache: reload ? "reload" : "force-cache",
          credentials: new URL(url).origin === baseURL.origin ? "same-origin" : "omit",
        }), signal, {
          timeout: 120000,
          onCancel: () => controller.abort(),
          timeoutMessage: "Descărcarea motorului video a durat prea mult. Verifică conexiunea și reîncearcă.",
        });
        if (!response.ok) {
          const error = new Error(`Fișierul necesar procesării nu poate fi descărcat (HTTP ${response.status}).`);
          error.retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
          throw error;
        }
        // Clone before reading; Cache Storage is optional and versioned.
        const cacheResponse = cache ? response.clone() : null;
        const blob = await waitFor(response.blob(), signal, {
          timeout: 120000,
          onCancel: () => controller.abort(),
          timeoutMessage: "Descărcarea motorului video s-a întrerupt. Reîncearcă.",
        });
        if (!blob.size) throw new Error("Fișierul descărcat pentru procesare este gol. Reîncearcă.");
        if (cacheResponse) {
          try { await waitFor(cache.put(url, cacheResponse), signal); } catch (error) { checkSignal(signal); }
        }
        return new Blob([blob], { type });
      } catch (error) {
        controller.abort();
        checkSignal(signal);
        if (attempt === 2 || error.retryable === false) throw error;
        await waitFor(new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1))), signal);
      }
    }
  }

  function validInput(blob) {
    if (!blob || typeof blob.arrayBuffer !== "function" || !blob.size) {
      throw new Error("Înregistrarea este goală sau nu poate fi citită.");
    }
  }

  function inputFilename(blob) {
    return blob.type?.toLowerCase().includes("mp4") ? "/input.mp4" : "/input.webm";
  }

  async function withEngine(blob, options, action) {
    const { signal, onProgress } = options;
    validInput(blob);
    checkSignal(signal);
    let engine = null;
    let objectURLs = [];
    const recentLogs = [];
    let stage = "Se procesează clipul";
    let lastPercent = -1;
    const terminate = () => { try { engine?.terminate(); } catch (_) {} };
    const release = () => {
      terminate();
      engine = null;
      objectURLs.forEach((url) => URL.revokeObjectURL(url));
      objectURLs = [];
    };
    signal?.addEventListener("abort", terminate, { once: true });
    try {
      await loadWrapper(signal);
      const cache = await openCoreCache(signal);
      // A failed script/WASM initialization gets a fresh Worker and fresh assets.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        checkSignal(signal);
        progress(onProgress, attempt
          ? "Se reîncarcă motorul video. Verifică conexiunea…"
          : "Se pregătește motorul video (~31 MB la prima utilizare)…");
        try {
          const assetOptions = { signal, cache, reload: attempt > 0 };
          const core = await fetchAsset(`${coreBaseURL}/ffmpeg-core.js`, "text/javascript", assetOptions);
          const wasm = await fetchAsset(`${coreBaseURL}/ffmpeg-core.wasm`, "application/wasm", assetOptions);
          checkSignal(signal);
          const coreURL = URL.createObjectURL(core);
          objectURLs.push(coreURL);
          const wasmURL = URL.createObjectURL(wasm);
          objectURLs.push(wasmURL);
          engine = new root.FFmpegWASM.FFmpeg();
          engine.on("log", ({ message }) => {
            recentLogs.push(String(message));
            if (recentLogs.length > 30) recentLogs.shift();
          });
          engine.on("progress", ({ progress: ratio, time }) => {
            // MediaRecorder WebM can have an unknown container duration.
            const seconds = Number(time) / 1000000;
            const estimate = Number.isFinite(options.duration) && options.duration > 0
              ? seconds / options.duration : Number(ratio);
            if (!Number.isFinite(estimate) || estimate < 0) return;
            const percent = Math.max(0, Math.min(99, Math.round(estimate * 100)));
            if (percent === lastPercent) return;
            lastPercent = percent;
            progress(onProgress, `${stage}… ${percent}%`);
          });
          progress(onProgress, "Se inițializează motorul video…");
          await waitFor(engine.load({ coreURL, wasmURL }), signal, {
            timeout: 120000,
            onCancel: terminate,
            timeoutMessage: "Motorul video nu a pornit la timp. Reîncearcă.",
          });
          break;
        } catch (error) {
          release();
          checkSignal(signal);
          if (attempt === 1 || error.retryable === false) throw error;
        }
      }
      checkSignal(signal);
      const run = (promise) => waitFor(promise, signal, { onCancel: terminate });
      const input = inputFilename(blob);
      const bytes = new Uint8Array(await waitFor(blob.arrayBuffer(), signal));
      checkSignal(signal);
      await run(engine.writeFile(input, bytes));
      return await action({
        engine, input, run, recentLogs,
        setStage(message) {
          stage = message;
          lastPercent = -1;
          progress(onProgress, `${message}…`);
        },
      });
    } catch (error) {
      checkSignal(signal);
      throw error;
    } finally {
      signal?.removeEventListener("abort", terminate);
      // Termination drops the entire WASM heap and virtual FS before ASR starts.
      release();
    }
  }

  function extractAudio(blob, { signal, onProgress } = {}) {
    return enqueue(() => withEngine(blob, { signal, onProgress }, async ({ engine, input, run, recentLogs, setStage }) => {
      setStage("Se extrage sunetul pentru transcriere");
      const code = await run(engine.exec([
        "-hide_banner", "-i", input, "-map", "0:a:0", "-vn", "-sn", "-dn",
        "-ac", "1", "-ar", String(sampleRate), "-c:a", "pcm_f32le", "-f", "f32le", "/audio.f32",
      ]));
      if (code !== 0) {
        const missing = recentLogs.some((line) => /matches no streams|does not contain any stream/i.test(line));
        throw new Error(missing
          ? "Clipul nu conține o pistă audio. Verifică accesul la microfon."
          : "Extragerea sunetului a eșuat. Verifică dacă înregistrarea conține audio.");
      }
      const data = await run(engine.readFile("/audio.f32"));
      if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength % 4) {
        throw new Error("Pista audio extrasă este goală sau nu poate fi citită.");
      }
      const audio = new Float32Array(data.byteLength / 4);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let index = 0; index < audio.length; index += 1) {
        const value = view.getFloat32(index * 4, true);
        if (!Number.isFinite(value)) throw new Error("Pista audio conține eșantioane nevalide.");
        audio[index] = value;
      }
      progress(onProgress, "Sunetul este pregătit pentru transcriere.");
      return { audio, duration: audio.length / sampleRate };
    }), signal);
  }

  function exportMp4(blob, { ass = "", duration, signal, onProgress } = {}) {
    return enqueue(() => withEngine(blob, { duration, signal, onProgress }, async ({ engine, input, run, setStage }) => {
      if (typeof ass !== "string") throw new TypeError("Subtitrarea trebuie să fie text ASS.");
      const filters = [];
      if (ass.trim()) {
        progress(onProgress, "Se pregătește fontul pentru subtitrările în română…");
        const font = await fetchAsset(new URL("assets/subtitles-font.ttf", baseURL).href, "font/ttf", { signal });
        await run(engine.createDir("/fonts"));
        await run(engine.writeFile("/fonts/DejaVuSans.ttf", new Uint8Array(await waitFor(font.arrayBuffer(), signal))));
        await run(engine.writeFile("/subtitles.ass", new TextEncoder().encode(ass)));
        // libass, FreeType and FriBidi are included in the pinned official core.
        filters.push("-vf", "ass=filename=/subtitles.ass:fontsdir=/fonts");
      }
      setStage(ass.trim() ? "Se imprimă subtitrarea pe video" : "Se exportă clipul MP4");
      const code = await run(engine.exec([
        "-hide_banner", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        ...filters,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p", "-threads", "1",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4", "/output.mp4",
      ]));
      if (code !== 0) throw new Error("Exportul MP4 a eșuat. Înregistrarea originală poate fi reprocesată.");
      const data = await run(engine.readFile("/output.mp4"));
      if (!(data instanceof Uint8Array) || data.byteLength < 12
          || data[4] !== 102 || data[5] !== 116 || data[6] !== 121 || data[7] !== 112) {
        throw new Error("Exportul nu a produs un fișier MP4 valid.");
      }
      const result = new Blob([data], { type: "video/mp4" });
      progress(onProgress, "Clipul MP4 este gata.");
      return result;
    }), signal);
  }

  root.RIMediaProcessor = Object.freeze({ extractAudio, exportMp4 });
})(typeof window !== "undefined" ? window : globalThis);
