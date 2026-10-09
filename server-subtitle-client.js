(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RIServerSubtitleClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BASE_URL = 'https://ai.djshopitalia.it/api/ri-subtitles/v1';
  const MAX_INPUT_BYTES = 512 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
  const statuses = ['awaiting_upload','uploading','queued','transcribing','rendering','ready','empty','failed','cancelled','expired'];
  function invalid() { throw new Error('Răspunsul serverului nu este valid. Originalul este păstrat.'); }
  function validateId(id) { if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) invalid(); return id; }
  function validateRequestId(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(id)) invalid(); return id; }
  function validateSnapshot(value, expected = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    validateId(value.id); validateRequestId(value.requestId);
    if ((expected.id && value.id !== expected.id) || (expected.requestId && value.requestId !== expected.requestId)) invalid();
    if (!statuses.includes(value.status) || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1 || typeof value.message !== 'string') invalid();
    for (const key of ['createdAt','expiresAt']) if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))) invalid();
    if (!Number.isSafeInteger(value.inputBytes) || value.inputBytes <= 0 || value.inputBytes > MAX_INPUT_BYTES || !Number.isSafeInteger(value.outputBytes) || value.outputBytes < 0 || value.outputBytes > MAX_OUTPUT_BYTES) invalid();
    for (const key of ['duration','width','height']) if (value[key] !== null && (!Number.isFinite(value[key]) || value[key] <= 0)) invalid();
    if (value.duration !== null && value.duration > 900) invalid();
    if (!Array.isArray(value.cues) || value.cues.length > 20000) invalid();
    let previousStart = -1;
    for (const cue of value.cues) {
      if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.start < previousStart || value.duration === null || cue.end > value.duration + 0.001 || typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 10000) invalid();
      previousStart = cue.start;
    }
    if (value.error !== null && (!value.error || typeof value.error.code !== 'string' || typeof value.error.message !== 'string')) invalid();
    if (['ready','empty'].includes(value.status) && (!(value.outputBytes > 0) || !(value.duration > 0) || !Number.isInteger(value.width) || !Number.isInteger(value.height))) invalid();
    if (value.status === 'empty' && value.cues.length) invalid();
    return value;
  }
  function createClient(options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
    async function request(path, settings = {}) {
      const response = await fetchImpl(BASE_URL + path, { ...settings, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) {
        let serverCode = '';
        try { const value = await response.json(); if (value.error && typeof value.error.code === 'string') serverCode = value.error.code; } catch (_) {}
        const error = new Error('Serverul nu a acceptat cererea (' + response.status + '). Reîncearcă din Arhivă.');
        error.status = response.status; error.code = serverCode; throw error;
      }
      return response;
    }
    async function json(path, settings, expected) {
      const response = await request(path, settings);
      if (!(response.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) invalid();
      let value; try { value = await response.json(); } catch (_) { invalid(); }
      return validateSnapshot(value, expected);
    }
    async function download(path, expectedBytes, mimeTypes, signal) {
      const response = await request(path, { signal });
      const type = (response.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
      if (!mimeTypes.includes(type)) invalid();
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_OUTPUT_BYTES || (expectedBytes !== undefined && Number(length) !== expectedBytes))) invalid();
      const blob = await response.blob();
      if ((expectedBytes !== undefined && blob.size !== expectedBytes) || (length !== null && blob.size !== Number(length)) || blob.size > MAX_OUTPUT_BYTES || (mimeTypes[0] === 'video/mp4' && !blob.size)) invalid();
      if (mimeTypes[0] === 'video/mp4') {
        const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
        if (header.length < 12 || String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') invalid();
        const boxLength = new DataView(header.buffer).getUint32(0);
        if (boxLength < 8 || boxLength > blob.size) invalid();
      }
      return blob;
    }
    return {
      createJob: (data, { signal } = {}) => {
        validateRequestId(data.requestId);
        if (typeof data.filename !== 'string' || !data.filename || data.filename.length > 255 || !Number.isSafeInteger(data.bytes) || data.bytes <= 0 || data.bytes > MAX_INPUT_BYTES || data.language !== 'ro') throw new Error('Clipul nu respectă limita de 512 MB sau numele fișierului nu este valid.');
        return json('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({requestId:data.requestId,filename:data.filename,bytes:data.bytes,language:'ro'}), signal }, { requestId: data.requestId });
      },
      uploadSource: (id, blob, { signal, requestId } = {}) => json('/jobs/' + validateId(id) + '/source', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob, signal }, { id, requestId }),
      getJob: (id, { signal, requestId } = {}) => json('/jobs/' + validateId(id), { signal }, { id, requestId }),
      downloadOutput: (id, bytes, { signal } = {}) => download('/jobs/' + validateId(id) + '/output', bytes, ['video/mp4'], signal),
      downloadSubtitles: (id, { signal } = {}) => download('/jobs/' + validateId(id) + '/subtitles', undefined, ['application/x-subrip','text/plain'], signal),
      cancelJob: (id, { signal, requestId } = {}) => json('/jobs/' + validateId(id), { method: 'DELETE', signal }, { id, requestId }),
    };
  }
  return { BASE_URL, MAX_INPUT_BYTES, createClient, validateSnapshot, validateId, validateRequestId };
});
