(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RIRecordingPipeline = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function checkAborted(signal) {
    if (signal && signal.aborted) throw new DOMException("Prelucrare oprită.", "AbortError");
  }

  function recoverInterruptedClip(clip) {
    if (!["pending", "transcribing", "rendering"].includes(clip.subtitleStatus)) return clip;
    return { ...clip, subtitleStatus: "interrupted", subtitleError: "Prelucrarea a fost întreruptă. Poți relua din Arhivă." };
  }

  async function finalizeRecording(blob, metadata, dependencies) {
    if (!blob || !blob.size) throw new Error("Înregistrarea nu conține date video.");
    const autoSubtitles = metadata.autoSubtitles !== false;
    const clip = {
      ...metadata,
      id: metadata.id || Date.now(),
      createdAt: metadata.createdAt || new Date().toISOString(),
      site: metadata.site || "șantier",
      blob,
      size: blob.size,
      autoSubtitles,
      subtitleStatus: autoSubtitles ? "pending" : "disabled",
      subtitleCues: [],
      subtitleError: "",
    };
    // Persist the camera file BEFORE downloading a model or starting any conversion.
    // Processing products are separate fields: the source blob is never replaced.
    await dependencies.persist(clip);
    return processClip(clip, dependencies);
  }

  async function processClip(originalClip, dependencies) {
    const { persist, media, speech, subtitles, signal, onProgress = () => {} } = dependencies;
    let clip = { ...originalClip };
    const update = async (changes) => {
      const next = { ...clip, ...changes };
      await persist(next);
      clip = next;
    };
    try {
      checkAborted(signal);
      if (clip.autoSubtitles !== false) {
        let cues = clip.subtitleCues || [];
        if (!cues.length) {
          await update({ autoSubtitles: true, subtitleStatus: "transcribing", subtitleError: "" });
          onProgress("Se pregătește vocea pentru subtitrare…");
          const extracted = await media.extractAudio(clip.blob, { signal, onProgress });
          checkAborted(signal);
          const transcript = await speech.transcribe(extracted.audio, { signal, onProgress });
          checkAborted(signal);
          cues = subtitles.normalizeCues(transcript.chunks || [], extracted.duration);
          if (!cues.length && transcript.text && transcript.text.trim()) {
            throw new Error("Lipsesc timpii necesari sincronizării textului. Reîncearcă subtitrarea.");
          }
          await update({
            duration: extracted.duration,
            subtitleCues: cues,
            subtitleStatus: cues.length ? "rendering" : "empty",
            subtitleError: "",
          });
        }
        if (cues.length) {
          checkAborted(signal);
          if (clip.subtitleStatus !== "rendering") await update({ subtitleStatus: "rendering", subtitleError: "" });
          const ass = subtitles.toAss(cues, { width: clip.width, height: clip.height });
          const captionedBlob = await media.exportMp4(clip.blob, { ass, duration: clip.duration, signal, onProgress });
          checkAborted(signal);
          await update({ captionedBlob, subtitleStatus: "ready", subtitleError: "" });
          onProgress("MP4 cu subtitrare în română pregătit în Arhivă.");
          return clip;
        }
      }

      // With subtitles off, or without detected speech, keep a native MP4 intact.
      // WebM still gets a separately stored MP4 for devices that need that format.
      if (!clip.blob.type.toLowerCase().includes("mp4") && !clip.mp4Blob) {
        checkAborted(signal);
        const mp4Blob = await media.exportMp4(clip.blob, { duration: clip.duration, signal, onProgress });
        checkAborted(signal);
        await update({ mp4Blob });
      }
      onProgress(clip.autoSubtitles === false
        ? "Filmarea este pregătită în Arhivă."
        : "Nu s-a detectat vorbire pentru subtitrare. Filmarea este salvată în Arhivă.");
      return clip;
    } catch (error) {
      const cancelled = (signal && signal.aborted) || error.name === "AbortError";
      await update({
        subtitleStatus: cancelled ? "cancelled" : "failed",
        subtitleError: cancelled ? "Prelucrare oprită. Poți relua din Arhivă." : (error.message || "Prelucrarea nu a reușit."),
      });
      onProgress(cancelled
        ? "Prelucrare oprită. Filmarea originală este în Arhivă."
        : "Filmarea este salvată. Prelucrarea poate fi reluată din Arhivă.");
      return clip;
    }
  }

  return { finalizeRecording, processClip, recoverInterruptedClip };
});
