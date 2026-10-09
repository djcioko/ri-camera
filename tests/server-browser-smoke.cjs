// Browser/IndexedDB integration with a deterministic HTTP transport, no live VPS.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright' : 'playwright');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{const relative=new URL(req.url,'http://localhost').pathname;const name=path.resolve(root,'.'+(relative==='/'?'/index.html':relative));if(!name.startsWith(root+path.sep)){res.writeHead(403).end();return;}fs.readFile(name,(error,data)=>{if(error){res.writeHead(404).end();return;}const type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png','.ttf':'font/ttf'}[path.extname(name)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(data);});});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.RI_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}}); const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{window.cameraRequests=0; navigator.mediaDevices.getUserMedia=async()=>{window.cameraRequests++;throw Error('camera must stay off');};});
 const id='c'.repeat(32),output=fs.readFileSync(process.env.RI_QA_MP4),calls=[];let requestId;
 const snapshot=status=>({id,requestId,status,progress:status==='ready'?1:0,message:status,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+100000).toISOString(),inputBytes:3,outputBytes:status==='ready'?output.length:0,duration:status==='ready'?2:null,width:status==='ready'?640:null,height:status==='ready'?480:null,cues:status==='ready'?[{start:0,end:1,text:'Bună ziua.'}]:[],error:null});
 await page.route('https://ai.djshopitalia.it/api/ri-subtitles/v1/**',async route=>{
 const request=route.request();const url=new URL(request.url());calls.push(request.method()+' '+url.pathname);assert.equal(request.headers().authorization,'Bearer test-private-code');
 if(request.method()==='POST'){const data=request.postDataJSON();requestId=data.requestId;assert.deepEqual(Object.keys(data).sort(),['bytes','filename','language','requestId']);assert.equal(data.filename,'original-real.mov');
 const saved=await page.evaluate(()=>new Promise(resolve=>{const req=indexedDB.open('ri-camera-db',1);req.onsuccess=()=>{const db=req.result;const r=db.transaction('clips').objectStore('clips').getAll();r.onsuccess=()=>{db.close();resolve(r.result.map(c=>({name:c.originalName,size:c.blob.size,remote:c.remoteJob})));};};}));assert.equal(saved[0].name,'original-real.mov');assert.equal(saved[0].remote.requestId,requestId);await route.fulfill({json:snapshot('awaiting_upload')});}
 else if(request.method()==='PUT'){assert.equal(request.postDataBuffer().toString(),'mov');await route.fulfill({json:snapshot('queued')});}
 else if(request.method()==='DELETE')await route.fulfill({json:snapshot('cancelled')});
 else if(url.pathname.endsWith('/output'))await route.fulfill({contentType:'video/mp4',headers:{'Content-Length':String(output.length)},body:output});
 else if(url.pathname.endsWith('/subtitles'))await route.fulfill({contentType:'application/x-subrip',body:'1\n00:00:00,000 --> 00:00:01,000\nBună ziua.\n'});
 else await route.fulfill({json:snapshot('ready')});
 });
 await page.goto('http://127.0.0.1:'+server.address().port+'/#subtitrari');await page.locator('#subtitlePanel').waitFor({state:'visible'});
 await page.evaluate(()=>{window.localEngineCalls=0;for(const name of ['extractAudio','exportMp4'])RIMediaProcessor[name]=()=>{window.localEngineCalls++;throw Error('local engine forbidden');};RISpeechRecognizer.transcribe=()=>{window.localEngineCalls++;throw Error('local ASR forbidden');};});
 assert.equal(await page.evaluate(()=>window.cameraRequests),0);
 await page.locator('#subtitleFile').setInputFiles({name:'original-real.mov',mimeType:'video/quicktime',buffer:Buffer.from('mov')});
 assert.equal(calls.length,0);await page.locator('#subtitleAccessCode').fill('test-private-code');await page.locator('#btnServerSubtitle').click();
 await page.waitForFunction(()=>document.getElementById('subtitleModuleStatus').textContent.includes('SRT salvate'));
 const saved=await page.evaluate(()=>getClips().then(clips=>clips.map(c=>({name:c.originalName,source:c.blob.size,output:c.captionedBlob?.size,status:c.subtitleStatus,remote:c.remoteJob,srt:c.srtBlob?.size}))));
 assert.equal(saved[0].status,'ready');assert.equal(saved[0].source,3);assert.equal(saved[0].output,output.length);assert.ok(saved[0].srt>0);assert.equal(saved[0].remote.status,'cancelled');assert.equal(await page.evaluate(()=>window.localEngineCalls),0);assert.equal(await page.evaluate(()=>window.cameraRequests),0);assert.deepEqual(errors,[]);
 await page.screenshot({path:process.env.RI_QA_SCREENSHOT||path.join('/tmp','ri-server-subtitles-mobile.png'),fullPage:true});
 console.log(JSON.stringify({passed:true,calls,clip:saved[0],cameraRequests:0,localEngineCalls:0,pageErrors:errors}));
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
