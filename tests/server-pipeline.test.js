const test=require('node:test'); const assert=require('node:assert/strict');
let api={};try {api=require('../server-subtitle-pipeline.js');} catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
const recording=require('../recording-pipeline.js');
const id='b'.repeat(32), requestId='request_0123456789abcdef';
function snapshot(status='queued'){return {id,requestId,status,progress:1,message:status,expiresAt:new Date(Date.now()+10000).toISOString(),inputBytes:3,outputBytes:3,duration:2,width:640,height:480,cues:[{start:0,end:1,text:'Bună.'}],error:null};}
function fixture(overrides={}) {
  const source=new Blob(['mov'],{type:'video/quicktime'}); const events=[];
  let stored={id:1,blob:source,originalName:'film.mov',subtitleProcessor:'server',autoSubtitles:true};
  const client={createJob:async()=>{events.push('post');assert.ok(stored.remoteJob.requestId);return snapshot('awaiting_upload');},uploadSource:async()=>{events.push('put');assert.equal(stored.remoteJob.id,id);return snapshot();},getJob:async()=>snapshot('ready'),downloadOutput:async()=>new Blob(['mp4'],{type:'video/mp4'}),downloadSubtitles:async()=>new Blob(['SRT'],{type:'application/x-subrip'}),cancelJob:async()=>{events.push('delete');return snapshot('cancelled');},...overrides};
  const deps={client,persist:async c=>{events.push('save-original');stored={...c};},patchRemote:async(clipId,expected,changes)=>{if(!stored||stored.id!==clipId||stored.remoteJob?.requestId!==expected)return null;events.push(changes.captionedBlob?'save-output':'patch');stored={...stored,...changes};return stored;},requestId:()=>requestId,wait:async()=>{},signal:new AbortController().signal};
  return {clip:stored,deps,events,get stored(){return stored;},delete(){stored=null;}};
}
test('server pipeline saves original and durable identities before upload and commits result before cleanup',async()=>{
 assert.equal(typeof api.processClip,'function'); const f=fixture(); const result=await api.processClip(f.clip,f.deps);
 assert.equal(result.subtitleStatus,'ready');assert.equal(result.originalName,'film.mov');assert.equal(result.blob,f.clip.blob);
 assert.ok(f.events.indexOf('save-original')<f.events.indexOf('post'));assert.ok(f.events.indexOf('save-output')<f.events.indexOf('delete'));
});
test('accepted job resumes after reload without POST or PUT',async()=>{
 assert.equal(typeof api.processClip,'function');const f=fixture({createJob:async()=>{throw Error('must not create');},uploadSource:async()=>{throw Error('must not upload');}});f.clip.remoteJob={id,requestId,status:'queued'};
 const result=await api.processClip(f.clip,f.deps);assert.equal(result.subtitleStatus,'ready');
});
test('lost create response retains request identity and retries idempotently',async()=>{
 assert.equal(typeof api.processClip,'function');const f=fixture({createJob:async()=>{throw Error('offline');}});
 const result=await api.processClip(f.clip,f.deps);assert.equal(result.remoteJob.requestId,requestId);assert.equal(result.subtitleStatus,'interrupted');
});
test('unconfirmed DELETE keeps job reference, while unload does not implicitly delete',async()=>{
 assert.equal(typeof api.processClip,'function');const controller=new AbortController();const f=fixture({getJob:async()=>{controller.abort();throw new DOMException('stop','AbortError');},cancelJob:async(_id,options)=>{assert.notEqual(options.signal,controller.signal);assert.equal(options.signal.aborted,false);throw Error('offline');}}); f.clip.remoteJob={id,requestId,status:'queued'};f.deps.signal=controller.signal;f.deps.isUserCancellation=()=>true;
 const result=await api.processClip(f.clip,f.deps);assert.equal(result.subtitleStatus,'interrupted');assert.equal(result.remoteJob.id,id);assert.match(result.subtitleError,/confirmată/);
});
test('stale callback cannot recreate a deleted clip or download output',async()=>{
 assert.equal(typeof api.processClip,'function');let downloaded=false;const f=fixture({getJob:async()=>{f.delete();return snapshot('ready');},downloadOutput:async()=>{downloaded=true;return new Blob(['mp4']);}});f.clip.remoteJob={id,requestId,status:'queued'};
 await api.processClip(f.clip,f.deps);assert.equal(f.stored,null);assert.equal(downloaded,false);
});
test('quota failure retains ready server identity and does not clean server output',async()=>{
 assert.equal(typeof api.processClip,'function');const f=fixture();const patch=f.deps.patchRemote;f.deps.patchRemote=async(...args)=>{if(args[2].captionedBlob)throw new Error('QuotaExceededError');return patch(...args);};
 const result=await api.processClip(f.clip,f.deps);assert.equal(result.remoteJob.id,id);assert.equal(result.remoteJob.status,'ready');assert.equal(f.events.includes('delete'),false);
});
test('server processor with auto subtitles off never invokes local engines',async()=>{
 const calls=[]; const source=new Blob(['original'],{type:'video/webm'});
 const result=await recording.finalizeRecording(source,{subtitleProcessor:'server',autoSubtitles:false},{persist:async()=>calls.push('save'),media:{exportMp4:async()=>calls.push('local')},speech:{transcribe:async()=>calls.push('asr')}});
 assert.equal(result.subtitleStatus,'disabled');assert.deepEqual(calls,['save']);
});

test('lost upload response reconnects accepted job without retransmission',async()=>{
 const f=fixture({uploadSource:async()=>{throw Error('response lost');}});
 const interrupted=await api.processClip(f.clip,f.deps);assert.equal(interrupted.remoteJob.id,id);
 f.deps.client.uploadSource=async()=>{throw Error('must not reupload accepted source');};
 const result=await api.processClip(interrupted,f.deps);assert.equal(result.subtitleStatus,'ready');
});
test('only explicit user cancellation issues DELETE with a fresh signal',async()=>{
 const controller=new AbortController();const f=fixture({getJob:async()=>{controller.abort();throw new DOMException('page closing','AbortError');}});f.clip.remoteJob={id,requestId,status:'queued'};f.deps.signal=controller.signal;
 const result=await api.processClip(f.clip,f.deps);assert.equal(result.subtitleStatus,'interrupted');assert.equal(f.events.includes('delete'),false);
});
test('original storage failure prevents remote requests',async()=>{
 const f=fixture();f.deps.persist=async()=>{throw Error('quota');};await assert.rejects(api.processClip(f.clip,f.deps),/quota/);assert.equal(f.events.includes('post'),false);assert.equal(f.events.includes('put'),false);
});

test('reconnection retries a source only after uploading transitions back to awaiting_upload',async()=>{
 const states=['uploading','awaiting_upload','queued','ready'];let uploads=0,reads=0;
 const f=fixture({getJob:async()=>{reads++;if(reads>6)throw Error('state machine polled awaiting_upload forever');if(states[0]==='queued' && uploads===0)return snapshot('awaiting_upload');return snapshot(states.shift());},uploadSource:async(jobId,blob,options)=>{uploads++;assert.equal(jobId,id);assert.equal(options.requestId,requestId);assert.equal(blob,f.clip.blob);return snapshot('queued');}});
 f.clip.remoteJob={id,requestId,status:'uploading'};
 const result=await api.processClip(f.clip,f.deps);
 assert.equal(result.subtitleStatus,'ready');assert.equal(uploads,1);assert.equal(f.events.includes('post'),false);
});
