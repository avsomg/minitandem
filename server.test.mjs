import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {JobQueue} from './editorial/jobs.mjs';

test('Mac service authenticates family sync, conflicts and editorial intake',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-service-'));
  // The operations route reads the editorial queue; the test gives it an empty one of its own instead of the real, private queue.
  const queueFile=path.join(temp,'queue','jobs.sqlite');
  new JobQueue(queueFile).close();
  const env={...process.env,MINITANDEM_STATE_DIR:path.join(temp,'state'),MINITANDEM_CORRECTION_DIR:path.join(temp,'corrections'),MINITANDEM_QUEUE_FILE:queueFile};
  const script=fileURLToPath(new URL('server.mjs',import.meta.url));
  const issue=command=>{
    const result=spawnSync(process.execPath,[script,command],{env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  const familyKey=issue('new-family'),editorKey=issue('new-admin');
  process.env.MINITANDEM_STATE_DIR=env.MINITANDEM_STATE_DIR;
  process.env.MINITANDEM_CORRECTION_DIR=env.MINITANDEM_CORRECTION_DIR;
  process.env.MINITANDEM_QUEUE_FILE=env.MINITANDEM_QUEUE_FILE;
  const {createServer}=await import('./server.mjs?test='+Date.now());
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(route,token,method='GET',payload,origin)=>{
    const response=await fetch(base+route,{method,headers:{Authorization:'Bearer '+token,...(payload?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{})},body:payload?JSON.stringify(payload):undefined});
    return {status:response.status,data:await response.json()};
  };
  try{
    assert.equal((await fetch(base+'/.vercel/project.json')).status,404);
    assert.equal((await fetch(base+'/.gitignore')).status,404);
    assert.equal((await fetch(base+'/index.html')).status,200);
    assert.match((await fetch(base+'/assets/apple-touch-icon.png')).headers.get('content-type'),/^image\/png/);
    // Folders are served by their index page, as on a static host: the footer link, the sitemap and every card's plain page use them.
    assert.equal((await fetch(base+'/places/')).status,200);
    const card=fs.readdirSync(new URL('.publish/places/',import.meta.url),{withFileTypes:true}).find(entry=>entry.isDirectory()).name;
    assert.match(await (await fetch(base+'/places/'+card+'/')).text(),/<html/);
    const bare=await fetch(base+'/places',{redirect:'manual'});
    assert.equal(bare.status,301);assert.equal(bare.headers.get('location'),'/places/');
    const head=await fetch(base+'/',{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.match((await fetch(base+'/research.md')).headers.get('content-type'),/^text\/markdown/);
    assert.match((await fetch(base+'/assets/papiliorama-outside.jpg')).headers.get('content-type'),/^image\/jpeg/);
    assert.equal((await call('/api/v1/family','wrong')).status,401);
    assert.equal((await call('/api/v1/family',familyKey,'GET',null,'https://bad.example')).status,403);
    const empty=await call('/api/v1/family',familyKey);assert.equal(empty.status,200);assert.equal(empty.data.profile,null);
    const profile={version:1,favorites:['memo-library'],notes:{'memo-library':'Quiet in the morning'},statuses:{},visits:{},tracked:{},age:2.5,origin:'Plaffeien'};
    const saved=await call('/api/v1/family',familyKey,'PUT',{revision:0,profile});
    assert.equal(saved.status,200);assert.equal(saved.data.revision,1);
    const conflict=await call('/api/v1/family',familyKey,'PUT',{revision:0,profile});
    assert.equal(conflict.status,409);assert.equal(conflict.data.profile.notes['memo-library'],'Quiet in the morning');
    const pendingPut=()=>{
      let request;
      const result=new Promise((resolve,reject)=>{
        request=http.request(base+'/api/v1/family',{method:'PUT',headers:{Authorization:'Bearer '+familyKey,'Content-Type':'application/json'}},response=>{
          let chunks='';response.setEncoding('utf8');response.on('data',chunk=>{chunks+=chunk;});response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(chunks)}));
        });
        request.on('error',reject);
        request.write('{');
      });
      return {request,result};
    };
    const firstWrite=pendingPut(),secondWrite=pendingPut();
    await new Promise(resolve=>setTimeout(resolve,30));
    firstWrite.request.end(JSON.stringify({revision:1,profile:{...profile,notes:{'memo-library':'First answer'}}}).slice(1));
    secondWrite.request.end(JSON.stringify({revision:1,profile:{...profile,notes:{'memo-library':'Second answer'}}}).slice(1));
    const parallel=await Promise.all([firstWrite.result,secondWrite.result]);
    assert.deepEqual(parallel.map(item=>item.status).sort(),[200,409]);
    assert.equal((await call('/api/v1/family',familyKey)).data.revision,2);
    const report={type:'vmeste-correction',version:1,activity:'memo-library',topic:'Schedule',message:'Check the opening hours',source:'https://www.fr.ch/',date:'2026-09-27'};
    const first=await call('/api/v1/corrections',familyKey,'POST',report),duplicate=await call('/api/v1/corrections',familyKey,'POST',report);
    assert.equal(first.status,201);assert.equal(duplicate.data.duplicate,true);
    const badTopic=await call('/api/v1/corrections',familyKey,'POST',{...report,topic:'Weather'});
    assert.equal(badTopic.status,400);assert.equal(badTopic.data.error,'Invalid correction.');
    const badSource=await call('/api/v1/corrections',familyKey,'POST',{...report,source:'http://example.com/'});
    assert.equal(badSource.status,400);assert.match(badSource.data.error,/HTTPS/);
    assert.equal((await call('/api/v1/admin/queue',familyKey)).status,401);
    const queue=await call('/api/v1/admin/queue',editorKey);assert.equal(queue.status,200);assert.equal(queue.data.corrections.length,1);
    assert.equal((await call('/api/v1/admin/operations',familyKey)).status,401);
    const ops=await call('/api/v1/admin/operations',editorKey);assert.equal(ops.status,200);
    assert.equal(ops.data.project,'vmeste');assert.equal(JSON.stringify(ops.data).includes('lease_until'),false);
    const reviewed=await call('/api/v1/admin/corrections/'+first.data.id,editorKey,'POST',{status:'ready-to-apply'});
    assert.equal(reviewed.status,200);assert.equal(reviewed.data.catalogChanged,false);
    const raw=fs.readFileSync(path.join(env.MINITANDEM_STATE_DIR,'families.json'),'utf8');
    assert.equal(raw.includes(familyKey),false);assert.equal(raw.includes(editorKey),false);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

test('/healthz answers without a key, reads and writes no state, and only to GET and HEAD',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-health-'));
  const state=path.join(temp,'state'),corrections=path.join(temp,'corrections');
  process.env.MINITANDEM_STATE_DIR=state;process.env.MINITANDEM_CORRECTION_DIR=corrections;
  const {createServer}=await import('./server.mjs?health='+Date.now());
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const get=await fetch(base+'/healthz');
    assert.equal(get.status,200);
    assert.match(get.headers.get('content-type'),/^application\/json/);
    assert.equal(get.headers.get('cache-control'),'no-store');
    const body=await get.json();
    assert.equal(body.status,'ok');assert.ok(Number.isInteger(body.records)&&body.records>0);
    const head=await fetch(base+'/healthz',{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal((await fetch(base+'/healthz',{method:'POST'})).status,405);
    assert.equal((await fetch(base+'/healthz/extra')).status,404);
    assert.equal((await fetch(base+'/healthz',{headers:{Origin:'https://bad.example'}})).status,403);
    // No state was created by asking: the check does not touch the state directory.
    assert.equal(fs.existsSync(state),false);assert.equal(fs.existsSync(corrections),false);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

test('/healthz names the build that is live: revision of the built files, date of the latest review, and the commit only when one is set',async()=>{
  const built=fileURLToPath(new URL('.publish/',import.meta.url));
  const info=JSON.parse(fs.readFileSync(built+'build-info.json','utf8'));
  // build-info.json holds no time of day (a build must be reproducible); the revision is the content hash of the catalogue files that were built.
  assert.deepEqual(Object.keys(info),['revision','catalogueUpdated','records']);
  const files=['data.js','data-reviewed.js','data-practical.js','data-geo.js','regions.js','data-de.js','data-fr.js'];
  const revision=crypto.createHash('sha256').update(files.map(file=>fs.readFileSync(built+file)).join('\n')).digest('hex').slice(0,16);
  assert.equal(info.revision,revision);
  assert.equal(info.catalogueUpdated,/^Catalogue updated (\d{4}-\d{2}-\d{2})\./m.exec(fs.readFileSync(built+'research.md','utf8'))[1]);
  const health=async(tag,commit)=>{
    if(commit===undefined)delete process.env.MINITANDEM_COMMIT;else process.env.MINITANDEM_COMMIT=commit;
    const {createServer}=await import('./server.mjs?build='+tag+Date.now());
    const server=createServer();
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{return await (await fetch('http://127.0.0.1:'+server.address().port+'/healthz')).json();}
    finally{await new Promise(resolve=>server.close(resolve));}
  };
  const before=process.env.MINITANDEM_COMMIT;
  try{
    const plain=await health('plain');
    assert.deepEqual(plain,{status:'ok',records:info.records,revision:info.revision,catalogueUpdated:info.catalogueUpdated});
    assert.equal('commit' in plain,false,'no commit without MINITANDEM_COMMIT');
    assert.equal('commit' in await health('empty',''),false,'an empty variable (compose without a tag) counts as unset');
    assert.deepEqual(await health('tagged','1a2b3c4'),{status:'ok',records:info.records,revision:info.revision,catalogueUpdated:info.catalogueUpdated,commit:'1a2b3c4'});
  }finally{if(before===undefined)delete process.env.MINITANDEM_COMMIT;else process.env.MINITANDEM_COMMIT=before;}
});

test('a damaged state file gives a 500 for that request and the service keeps running',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-damaged-'));
  const state=path.join(temp,'state');
  fs.mkdirSync(state,{recursive:true});fs.writeFileSync(path.join(state,'families.json'),'{broken');
  process.env.MINITANDEM_STATE_DIR=state;process.env.MINITANDEM_CORRECTION_DIR=path.join(temp,'corrections');
  const {createServer}=await import('./server.mjs?damaged='+Date.now());
  const server=createServer();
  const logged=console.error;console.error=()=>{};
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const response=await fetch(base+'/api/v1/family',{headers:{Authorization:'Bearer '+'k'.repeat(43)}});
    assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'Server error'});
    assert.equal((await fetch(base+'/healthz')).status,200);
  }finally{
    console.error=logged;
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

// A request line goes out as written (the fetch API would refuse these targets); Node's parser lets them through to the listener.
const rawGet=(port,target)=>new Promise((resolve,reject)=>{
  const request=http.request({host:'127.0.0.1',port,path:target,method:'GET'},response=>{
    let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,text}));
  });
  request.on('error',reject);request.end();
});
const quietServer=async(tag)=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-'+tag+'-'));
  process.env.MINITANDEM_STATE_DIR=path.join(temp,'state');process.env.MINITANDEM_CORRECTION_DIR=path.join(temp,'corrections');
  const {createServer}=await import('./server.mjs?'+tag+'='+Date.now());
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,temp,port:server.address().port,base:'http://127.0.0.1:'+server.address().port,
    close:async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});fs.rmSync(temp,{recursive:true,force:true});}};
};

test('a malformed request target gets 400 and the same process keeps serving /healthz and a page',async()=>{
  const service=await quietServer('target');
  const failures=[];
  const onRejection=error=>failures.push(error);process.on('unhandledRejection',onRejection);
  try{
    // Each one makes new URL() throw ERR_INVALID_URL.
    for(const target of ['//[','//%','http://[','//a:99999999','//[::1']){
      const answer=await rawGet(service.port,target);
      assert.equal(answer.status,400,target);
      assert.deepEqual(JSON.parse(answer.text),{error:'Malformed request target'},target);
    }
    // After all of them the process is the same one and answers: the health check, a page and the API.
    const health=await fetch(service.base+'/healthz');
    assert.equal(health.status,200);assert.equal((await health.json()).status,'ok');
    assert.equal((await fetch(service.base+'/index.html')).status,200);
    assert.equal((await fetch(service.base+'/api/v1/family')).status,401);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(failures,[],'no unhandled rejection');
  }finally{process.off('unhandledRejection',onRejection);await service.close();}
});

test('a static file that cannot be read gets a plain 500 or 404, and a stream that fails midway only cuts that connection',async()=>{
  const service=await quietServer('static');
  const open=fs.promises.open,logged=console.error,logs=[];
  console.error=(...args)=>logs.push(args);
  const failures=[];
  const onRejection=error=>failures.push(error);process.on('unhandledRejection',onRejection);
  const onException=error=>failures.push(error);process.on('uncaughtException',onException);
  try{
    // The file exists when it is checked but cannot be opened (a permission change, a file replaced during a deploy).
    fs.promises.open=async()=>{throw Object.assign(Error("EACCES: permission denied, open '/srv/minitandem/.publish/index.html'"),{code:'EACCES'});};
    const denied=await fetch(service.base+'/index.html');
    const deniedText=await denied.text();
    assert.equal(denied.status,500);assert.deepEqual(JSON.parse(deniedText),{error:'Server error'});
    assert.doesNotMatch(deniedText,/EACCES|\/srv\/|\bat\s/,'no path and no stack for the caller');
    assert.ok(logs.length>0,'the cause is logged on the server');
    fs.promises.open=async()=>{throw Object.assign(Error('ENOENT: no such file'),{code:'ENOENT'});};
    const gone=await fetch(service.base+'/index.html');
    assert.equal(gone.status,404);assert.deepEqual(await gone.json(),{error:'Not found'});
    // The status line is out, then the file fails: nothing can be corrected any more, the connection ends, the process goes on.
    fs.promises.open=async()=>({createReadStream:()=>new Readable({read(){this.push('partial');setImmediate(()=>this.destroy(Object.assign(Error('EIO: read failed'),{code:'EIO'})));}})});
    const cut=await fetch(service.base+'/index.html');
    assert.equal(cut.status,200);
    await assert.rejects(cut.text());
    fs.promises.open=open;
    assert.equal((await fetch(service.base+'/healthz')).status,200);
    assert.equal((await fetch(service.base+'/index.html')).status,200);
    assert.deepEqual(failures,[],'no unhandled rejection or exception');
  }finally{
    fs.promises.open=open;console.error=logged;process.off('unhandledRejection',onRejection);process.off('uncaughtException',onException);
    await service.close();
  }
});
