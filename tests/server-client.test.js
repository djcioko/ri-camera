const test = require('node:test');
const assert = require('node:assert/strict');
let api = {}; try { api = require('../server-subtitle-client.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const id = 'a'.repeat(32);
const requestId = 'req_0123456789abcdef';
function snapshot(changes = {}) { return { id, requestId, status: 'awaiting_upload', progress: 0, message: 'OK', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+10000).toISOString(), inputBytes: 3, outputBytes: 0, duration: null, width: null, height: null, cues: [], error: null, ...changes }; }
test('client authenticates exact v1 schema with omitted cookies and forbidden redirects', async () => {
  assert.equal(typeof api.createClient, 'function');
  const calls=[]; const client=api.createClient({getAccessCode:()=> 'private-test-code',fetch:async(url,options)=> {calls.push({url,options}); return new Response(JSON.stringify(snapshot()),{headers:{'Content-Type':'application/json'}});}});
  await client.createJob({requestId, filename:'original.mov', bytes:3, language:'ro'});
  assert.equal(calls[0].url,'https://ai.djshopitalia.it/api/ri-subtitles/v1/jobs');
  assert.equal(calls[0].options.credentials,'omit'); assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.headers.Authorization,'Bearer private-test-code');
  assert.deepEqual(JSON.parse(calls[0].options.body),{requestId,filename:'original.mov',bytes:3,language:'ro'});
});
test('client rejects invalid identity, cues and non-JSON snapshots', async()=> {
  assert.equal(typeof api.createClient,'function');
  let reply=snapshot({id:'../bad'}); const client=api.createClient({getAccessCode:()=> 'x',fetch:async()=>new Response(JSON.stringify(reply),{headers:{'Content-Type':'application/json'}})});
  await assert.rejects(client.createJob({requestId,filename:'x',bytes:3,language:'ro'}));
  reply=snapshot({status:'ready',duration:2,width:640,height:480,outputBytes:5,cues:[{start:1,end:3,text:'bad'}]});
  await assert.rejects(client.getJob(id));
  const html=api.createClient({getAccessCode:()=> 'x',fetch:async()=>new Response('<html>',{headers:{'Content-Type':'text/html'}})});
  await assert.rejects(html.getJob(id));
});
test('output download validates MIME, declared byte length, and rejects empty or HTML media', async()=> {
  assert.equal(typeof api.createClient,'function');
  let response; const client=api.createClient({getAccessCode:()=> 'x',fetch:async()=>response});
  const mp4=Buffer.from([0,0,0,12,102,116,121,112,105,115,111,109]);
  response=new Response(mp4,{headers:{'Content-Type':'video/mp4','Content-Length':'12'}});
  assert.equal((await client.downloadOutput(id,12)).size,12);
  response=new Response('html',{headers:{'Content-Type':'text/html'}}); await assert.rejects(client.downloadOutput(id,4));
  response=new Response('mp4',{headers:{'Content-Type':'video/mp4','Content-Length':'3'}}); await assert.rejects(client.downloadOutput(id,9));
  response=new Response('',{headers:{'Content-Type':'video/mp4'}}); await assert.rejects(client.downloadOutput(id,0));
});
module.exports={snapshot,id,requestId};
test('HTML mislabeled as video/mp4 cannot become an archive result',async()=>{
 const html='<html>maintenance page</html>';const client=api.createClient({getAccessCode:()=> 'x',fetch:async()=>new Response(html,{headers:{'Content-Type':'video/mp4','Content-Length':String(html.length)}})});
 await assert.rejects(client.downloadOutput(id,html.length));
});
