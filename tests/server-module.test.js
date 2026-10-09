const test=require('node:test');const assert=require('node:assert/strict');
let api={};try{api=require('../subtitle-module.js');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
function element(){return {value:'',files:[],textContent:'',disabled:false,classList:{toggle(){}},replaceChildren(){},appendChild(){},addEventListener(){}};}
function fixture(){const controls=new Map(); const document={getElementById:id=>{if(!controls.has(id))controls.set(id,element());return controls.get(id);},createElement:()=>element()}; const events=[];const module=api.createModule({document,isBusy:()=>false,getClips:async()=>[],process:async clip=>events.push(clip),onOpen:()=>events.push('open')});return {module,events,controls};}
test('choosing MOV keeps selection private until explicit subtitle action without browser metadata',async()=>{
 assert.equal(typeof api.createModule,'function');const f=fixture(); const file=new Blob(['mov'],{type:'video/quicktime'});file.name='real-name.mov';f.controls.get('subtitleFile').files=[file];f.controls.get('subtitleFile').onchange();assert.equal(f.events.length,0);
 f.controls.get('subtitleAccessCode').value='private';f.controls.get('subtitleAccessCode').oninput();await f.controls.get('btnServerSubtitle').onclick();assert.equal(f.events.length,1);assert.equal(f.events[0].originalName,'real-name.mov');assert.equal(f.events[0].subtitleProcessor,'server');assert.equal(f.events[0].blob,file);assert.equal(f.events[0].width,undefined);
});
test('private code stays in module memory and never enters clip metadata',async()=>{
 assert.equal(typeof api.createModule,'function');const f=fixture();const input=f.controls.get('subtitleAccessCode');input.value='secret';input.oninput();assert.equal(f.module.getAccessCode(),'secret');const file=new Blob(['movie']);file.name='x.mov';f.controls.get('subtitleFile').files=[file];f.controls.get('subtitleFile').onchange();await f.controls.get('btnServerSubtitle').onclick();assert.equal(JSON.stringify(f.events[0]).includes('secret'),false);
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
