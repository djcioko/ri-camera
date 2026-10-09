const test=require('node:test');const assert=require('node:assert/strict');
let api={};try{api=require('../subtitle-module.js');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
function element(){return {value:'',files:[],textContent:'',disabled:false,classList:{toggle(){}},replaceChildren(){},appendChild(){},addEventListener(){}};}
function fixture(clips=[]){const controls=new Map(); const document={getElementById:id=>{if(!controls.has(id))controls.set(id,element());return controls.get(id);},createElement:()=>element()}; const events=[];const module=api.createModule({document,isBusy:()=>false,getClips:async()=>clips,process:async clip=>events.push(clip),onOpen:()=>events.push('open')});return {module,events,controls};}
test('choosing MOV waits for explicit subtitle action and submits without a code or browser metadata',async()=>{
 assert.equal(typeof api.createModule,'function');const f=fixture(); const file=new Blob(['mov'],{type:'video/quicktime'});file.name='real-name.mov';f.controls.get('subtitleFile').files=[file];f.controls.get('subtitleFile').onchange();assert.equal(f.events.length,0);
 await f.controls.get('btnServerSubtitle').onclick();assert.equal(f.events.length,1);assert.equal(f.events[0].originalName,'real-name.mov');assert.equal(f.events[0].subtitleProcessor,'server');assert.equal(f.events[0].blob,file);assert.equal(f.events[0].width,undefined);
});
test('an archived original resumes publicly only after the explicit subtitle action',async()=>{
 const clip={id:12,originalName:'film.mov',blob:new Blob(['movie']),remoteJob:{id:'a'.repeat(32),requestId:'request_0123456789abcdef',status:'queued'}};
 const f=fixture([clip]);await f.module.refresh();f.controls.get('subtitleArchive').value='12';f.controls.get('subtitleArchive').onchange();
 assert.equal(f.events.length,0);await f.controls.get('btnServerSubtitle').onclick();
 assert.equal(f.events.length,1);assert.equal(f.events[0].blob,clip.blob);assert.equal(f.events[0].remoteJob,clip.remoteJob);assert.equal(f.events[0].subtitleProcessor,'server');assert.equal(f.events[0].autoSubtitles,true);
});
function fakeDb(initial) {
 let stored=initial, writes=0; const tx={error:null,objectStore:()=>({get:()=>{const request={};queueMicrotask(()=>{request.result=stored;request.onsuccess();queueMicrotask(()=>tx.oncomplete());});return request;},put:clip=>{writes++;stored=clip;}})};
 return {db:{transaction:()=>tx,close(){}},get stored(){return stored;},get writes(){return writes;}};
}
test('atomic database patch requires current request identity and never recreates a deleted clip',async()=>{
 assert.equal(typeof api.patchRemoteClip,'function');
 for (const initial of [undefined,{id:1,remoteJob:{requestId:'new-request'}}]) {const f=fakeDb(initial);const next=await api.patchRemoteClip(f.db,'clips',1,'old-request',{subtitleStatus:'ready'});assert.equal(next,null);assert.equal(f.writes,0);}
 const f=fakeDb({id:1,blob:new Blob(['original']),remoteJob:{requestId:'same-request'}});const next=await api.patchRemoteClip(f.db,'clips',1,'same-request',{subtitleStatus:'ready'});assert.equal(next.subtitleStatus,'ready');assert.equal(f.writes,1);assert.equal(next.blob,f.stored.blob);
});
