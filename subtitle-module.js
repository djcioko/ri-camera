(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RISubtitleModule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function patchRemoteClip(db, storeName, id, requestId, changes) {
    return new Promise((resolve, reject) => {
      let updated = null;
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const get = store.get(id);
      get.onsuccess = () => {
        const clip = get.result;
        if (!clip || !clip.remoteJob || clip.remoteJob.requestId !== requestId) return;
        updated = { ...clip, ...changes };
        store.put(updated);
      };
      tx.oncomplete = () => { db.close(); resolve(updated); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('Rezultatul nu a putut fi salvat. Verifică spațiul liber și reia salvarea.')); };
    });
  }
  function createModule(dependencies) {
    const { document, getClips, process, isBusy = () => false, onOpen = () => {} } = dependencies;
    const find = id => document.getElementById(id);
    const panel = find('subtitlePanel'), fileInput = find('subtitleFile'), archive = find('subtitleArchive'), button = find('btnServerSubtitle'), status = find('subtitleModuleStatus');
    let selectedFile = null, clips = [], renderGeneration = 0;
    const say = message => { if (status) status.textContent = message; };
    if (fileInput) fileInput.onchange = () => {
      selectedFile = fileInput.files && fileInput.files[0] || null;
      if (archive) archive.value = '';
      say(selectedFile ? 'Selectat: ' + selectedFile.name + '. Fișierul nu a fost trimis. Apasă Subtitrează pe server pentru salvare și transfer.' : 'Alege un videoclip sau un original din Arhivă.');
    };
    if (archive) archive.onchange = () => { selectedFile = null; if (fileInput) fileInput.value = ''; say('Originalul selectat nu a fost trimis. Apasă Subtitrează pe server.'); };
    async function refresh() {
      if (!archive) return;
      const generation = ++renderGeneration;
      try {
        const next = await getClips(); if (generation !== renderGeneration) return;
        clips = next;
        const previous = archive.value;
        archive.replaceChildren();
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Alege un original din Arhivă'; archive.appendChild(placeholder);
        for (const clip of clips) { const option = document.createElement('option'); option.value = String(clip.id); option.textContent = clip.originalName || ('Șantier: ' + clip.site + ' · ' + new Date(clip.createdAt).toLocaleString('ro-RO')); archive.appendChild(option); }
        archive.value = previous;
      } catch (_) { say('Arhiva nu poate fi citită. Verifică spațiul și reîncearcă.'); }
    }
    if (button) button.onclick = async () => {
      if (isBusy()) { say('Așteaptă finalizarea filmării sau a lucrării curente.'); return; }
      let clip;
      if (selectedFile) {
        if (!selectedFile.size || selectedFile.size > 512 * 1024 * 1024) { say('Alege un fișier video de maximum 512 MB.'); return; }
        clip = {id:Date.now(),createdAt:new Date().toISOString(),site:'Clip importat',originalName:selectedFile.name,blob:selectedFile,size:selectedFile.size};
      } else clip = clips.find(value => String(value.id) === archive.value);
      if (!clip) { say('Alege un videoclip sau un original din Arhivă.'); return; }
      button.disabled = true;
      try { await process({...clip,subtitleProcessor:'server',autoSubtitles:true}); await refresh(); }
      catch (error) { say('Originalul nu a putut fi salvat sau prelucrat. ' + error.message); }
      finally { button.disabled = false; }
    };
    return {
      refresh,
      show: async () => { if (panel) panel.classList.toggle('hidden',false); onOpen(); await refresh(); },
      hide: () => { if (panel) panel.classList.toggle('hidden',true); },
      setStatus: say,
    };
  }
  return {createModule,patchRemoteClip};
});
