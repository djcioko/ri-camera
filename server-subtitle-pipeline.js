(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RIServerSubtitlePipeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function makeRequestId() {
    const bytes = new Uint8Array(24); globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function checkAborted(signal) { if (signal && signal.aborted) throw new DOMException('Prelucrare oprită.', 'AbortError'); }
  function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const done = () => { if (signal) signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, milliseconds);
      const abort = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); reject(new DOMException('Prelucrare oprită.', 'AbortError')); };
      if (signal) { signal.addEventListener('abort', abort, { once:true }); if (signal.aborted) abort(); }
    });
  }
  async function processClip(originalClip, dependencies) {
    const { client, persist, patchRemote, signal, onProgress = () => {} } = dependencies;
    if (!client || !patchRemote) throw new Error('Procesarea pe server nu este configurată.');
    let clip = { ...originalClip, subtitleProcessor: 'server', autoSubtitles: true };
    let requestId = clip.remoteJob && clip.remoteJob.requestId;
    if (!requestId) {
      requestId = (dependencies.requestId || makeRequestId)();
      clip = { ...clip, subtitleStatus:'pending', subtitleError:'', remoteJob:{requestId,id:null,status:'awaiting_upload',expiresAt:null} };
      // This commit is mandatory: neither reservation nor upload can precede it.
      await persist(clip);
    }
    let stale = false;
    async function patch(changes) {
      const next = await patchRemote(clip.id, requestId, changes);
      if (!next) { stale = true; throw new Error('Clipul nu mai este disponibil pentru această lucrare.'); }
      clip = next; return clip;
    }
    async function snapshotPatch(snapshot) {
      if (snapshot.requestId !== requestId || (clip.remoteJob.id && snapshot.id !== clip.remoteJob.id)) throw new Error('Identitatea lucrării primite nu corespunde clipului.');
      await patch({remoteJob:{requestId,id:snapshot.id,status:snapshot.status,expiresAt:snapshot.expiresAt},subtitleStatus:['ready','empty'].includes(snapshot.status)?'rendering':snapshot.status,subtitleError:''});
      onProgress(snapshot.message || 'Se prelucrează clipul pe djcioko.ro…');
    }
    async function removeRemote() {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
      try { return await client.cancelJob(clip.remoteJob.id, {signal:controller.signal,requestId}); }
      finally { clearTimeout(timer); }
    }
    try {
      checkAborted(signal);
      let snapshot;
      if (clip.remoteJob.id) snapshot = await client.getJob(clip.remoteJob.id, {signal,requestId});
      else snapshot = await client.createJob({requestId,filename:clip.originalName || ('RI_' + clip.id + (clip.blob.type.includes('mp4') ? '.mp4' : '.webm')),bytes:clip.blob.size,language:'ro'}, {signal});
      await snapshotPatch(snapshot);
      while (!['ready','empty','failed','cancelled','expired'].includes(snapshot.status)) {
        checkAborted(signal);
        // A disconnected upload can return to awaiting_upload after the first
        // reconnection snapshot. Retry only once the server requests the source;
        // queued/accepted jobs are never uploaded again.
        if (snapshot.status === 'awaiting_upload') {
          onProgress('Originalul este salvat. Se trimite către djcioko.ro…');
          snapshot = await client.uploadSource(snapshot.id, clip.blob, {signal,requestId});
        } else {
          await (dependencies.wait || wait)(1500, signal);
          snapshot = await client.getJob(clip.remoteJob.id, {signal,requestId});
        }
        await snapshotPatch(snapshot);
      }
      if (['failed','cancelled','expired'].includes(snapshot.status)) {
        await patch({subtitleStatus:snapshot.status,subtitleError:snapshot.error ? snapshot.error.message : (snapshot.status === 'expired' ? 'Lucrarea a expirat. Pornește o lucrare nouă.' : '')});
        return clip;
      }
      checkAborted(signal);
      onProgress('Se salvează MP4 și SRT din djcioko.ro în Arhivă…');
      const output = await client.downloadOutput(snapshot.id, snapshot.outputBytes, {signal});
      checkAborted(signal);
      const srtBlob = await client.downloadSubtitles(snapshot.id, {signal});
      checkAborted(signal);
      await patch({captionedBlob:snapshot.status==='ready'?output:undefined,mp4Blob:snapshot.status==='empty'?output:clip.mp4Blob,srtBlob,subtitleCues:snapshot.cues,duration:snapshot.duration,width:snapshot.width,height:snapshot.height,subtitleStatus:snapshot.status,subtitleError:''});
      // Delete is safe only after the durable output commit. Cleanup failure keeps
      // the reference for later; it does not invalidate the saved MP4.
      try { const deleted = await removeRemote(); if (['cancelled','expired'].includes(deleted.status)) await patch({remoteJob:{...clip.remoteJob,status:deleted.status}}); } catch (_) {}
      onProgress(snapshot.status==='empty'?'MP4 salvat. Nu s-a detectat vorbire.':'MP4 subtitrat și SRT salvate în Arhivă.');
      return clip;
    } catch (error) {
      if (stale) return clip;
      const aborted = (signal && signal.aborted) || error.name === 'AbortError';
      let confirmed = false;
      if (aborted && dependencies.isUserCancellation && dependencies.isUserCancellation() && clip.remoteJob.id) {
        try { const result = await removeRemote(); confirmed = ['cancelled','expired'].includes(result.status); } catch (_) {}
      }
      const message = confirmed ? 'Oprirea a fost confirmată de server. Originalul este păstrat.' : aborted ? 'Oprirea pe server nu a fost confirmată. Reconectează lucrarea din Arhivă.' : 'Originalul și identitatea lucrării sunt păstrate. Reia conexiunea sau salvarea din Arhivă. ' + (error.message || '');
      try { await patch({subtitleStatus:confirmed?'cancelled':'interrupted',subtitleError:message,remoteJob:confirmed?{...clip.remoteJob,status:'cancelled'}:clip.remoteJob}); } catch (_) { /* A quota failure must not remove the last durable remote identity. */ }
      onProgress(message); return clip;
    }
  }
  return { processClip, makeRequestId };
});
