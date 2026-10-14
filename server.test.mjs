import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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
