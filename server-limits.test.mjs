import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {loadStack} from './test-support.mjs';

// Limits of the service against a real listener: body size, time, writes per key, and which origins and preflights it answers.
// server.test.mjs checks the protocol itself; this file is about what the service refuses.
process.env.MINITANDEM_FAMILY_SYNC='1';
const script=fileURLToPath(new URL('server.mjs',import.meta.url));

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-limits-'));
const env={...process.env,MINITANDEM_STATE_DIR:path.join(temp,'state'),MINITANDEM_CORRECTION_DIR:path.join(temp,'corrections'),MINITANDEM_QUEUE_FILE:path.join(temp,'queue','jobs.sqlite')};
const issue=command=>{const result=spawnSync(process.execPath,[script,command],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
// One family per test that writes: a write moves the family's revision on.
const keys=Array.from({length:6},()=>issue('new-family')),editorKey=issue('new-admin');
Object.assign(process.env,{MINITANDEM_STATE_DIR:env.MINITANDEM_STATE_DIR,MINITANDEM_CORRECTION_DIR:env.MINITANDEM_CORRECTION_DIR,MINITANDEM_QUEUE_FILE:env.MINITANDEM_QUEUE_FILE});
const {createServer,writeLimiter}=await import('./server.mjs?limits='+Date.now());
test.after(()=>fs.rmSync(temp,{recursive:true,force:true}));

async function listen(t,options){
  const server=createServer(options);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  return {server,port:server.address().port,base:'http://127.0.0.1:'+server.address().port};
}
// One raw HTTP exchange: what the service answers, and how long until it let go of the connection. The caller decides how much of the request to send.
function exchange(port,request,{wait=3000}={}){
  return new Promise(resolve=>{
    const started=Date.now();let data='',timedOut=false;
    const socket=net.connect(port,'127.0.0.1',()=>socket.write(request));
    socket.setEncoding('latin1');
    socket.on('data',chunk=>{data+=chunk;});
    socket.on('error',()=>{});
    const timer=setTimeout(()=>{timedOut=true;socket.destroy();},wait);
    socket.on('close',()=>{
      clearTimeout(timer);
      resolve({data,closed:!timedOut,ms:Date.now()-started,status:Number((/^HTTP\/1\.1 (\d{3})/.exec(data)||[])[1])||null,head:data.split('\r\n\r\n')[0].toLowerCase()});
    });
  });
}
const head=(method,route,extra=[])=>[`${method} ${route} HTTP/1.1`,'Host: minitandem.test',...extra,'',''].join('\r\n');
const bearer=key=>'Authorization: Bearer '+key;
const jsonType='Content-Type: application/json';
const call=async(base,route,key,method='GET',payload,extra={})=>{
  const response=await fetch(base+route,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),...(payload?{'Content-Type':'application/json'}:{}),...extra},body:payload?JSON.stringify(payload):undefined});
  return {status:response.status,headers:response.headers,data:await response.json().catch(()=>null)};
};

test('a body announced above the limit is refused at once, on any route, authenticated or not, with the connection closed',async t=>{
  const {port}=await listen(t);
  // The case from the pre-launch review: 50 MB announced, 5 bytes sent. It used to wait; it must not.
  for(const [name,request] of [
    ['family profile',head('PUT','/api/v1/family',[bearer(keys[0]),jsonType,'Content-Length: 50000000'])+'12345'],
    ['no key at all',head('PUT','/api/v1/family',[jsonType,'Content-Length: 50000000'])+'12345'],
    ['a route that takes no body',head('POST','/',['Content-Length: 50000000'])+'12345'],
    ['a static file',head('GET','/index.html',['Content-Length: 50000000'])+'12345'],
    ['just above the largest limit',head('PUT','/api/v1/family',[bearer(keys[0]),jsonType,'Content-Length: '+(512*1024+1)])+'12345']
  ]){
    const answer=await exchange(port,request,{wait:5000});
    assert.equal(answer.status,413,name);
    assert.match(answer.head,/connection: close/,name);
    assert.match(answer.data,/"error":"Request too large"/,name);
    assert.ok(answer.ms<1500,name+': answered in '+answer.ms+' ms');
    assert.ok(answer.closed,name+': the connection is let go');
  }
});

test('a sender that asks to send a large body (Expect: 100-continue) is refused without being told to go ahead',async t=>{
  const {port}=await listen(t);
  const answer=await exchange(port,head('PUT','/api/v1/family',[bearer(keys[1]),jsonType,'Content-Length: 50000000','Expect: 100-continue']),{wait:5000});
  assert.equal(answer.status,413);
  assert.ok(!/100 Continue/i.test(answer.data));
  assert.ok(answer.ms<1500);
  // A small body is told to go ahead, once the route has accepted the key and the size.
  const small=JSON.stringify({revision:0,profile:{version:1,favorites:[],notes:{},statuses:{},visits:{},tracked:{},age:null,origin:''}});
  let continued=false;
  const proceed=await new Promise((resolve,reject)=>{
    const request=http.request({port,method:'PUT',path:'/api/v1/family',headers:{Authorization:'Bearer '+keys[1],'Content-Type':'application/json','Content-Length':Buffer.byteLength(small),Expect:'100-continue'}},response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve({status:response.statusCode,text,continued}));
    });
    request.on('continue',()=>{continued=true;request.end(small);});
    request.on('error',reject);
    request.flushHeaders();
  });
  assert.equal(proceed.continued,true);assert.equal(proceed.status,200);
});

test('each route has the limit its data needs: a heavy but real profile fits, a correction or a review is small',async t=>{
  const {base,port}=await listen(t);
  // A family that saved every card of the catalogue, wrote notes on a hundred of them and planned fifty visits.
  const stack=loadStack({});
  const tracked=Object.fromEntries(stack.records.map(record=>[record.id,stack.P.snapshot(record,'2026-10-17')]));
  const ids=stack.records.map(record=>record.id);
  const notes=Object.fromEntries(ids.slice(0,100).map((id,index)=>[id,('Quiet on Tuesdays, ask for Ms '+index+'. ').repeat(35)]));
  const visits=Object.fromEntries(ids.slice(0,50).map((id,index)=>['v-'+index,{activity:id,date:'2026-11-01',time:'10:00',booking:'confirmed',reply:'x'.repeat(500),bring:'x'.repeat(200),observations:'x'.repeat(1000)}]));
  const profile={version:1,favorites:ids,notes,statuses:{},visits,tracked,age:2.5,origin:'Plaffeien'};
  const size=Buffer.byteLength(JSON.stringify({revision:0,profile}));
  assert.ok(size>250*1024&&size<400*1024,'the example is large and still under the limit: '+size);
  const saved=await call(base,'/api/v1/family',keys[2],'PUT',{revision:0,profile});
  assert.equal(saved.status,200);assert.equal(Object.keys(saved.data.profile.tracked).length,ids.length);
  // A correction: a few hundred bytes are normal; 20 KB is not.
  const report={type:'vmeste-correction',version:1,activity:ids[0],topic:'Schedule',message:'Check the opening hours',source:'https://www.fr.ch/',date:'2026-10-17'};
  const filed=await call(base,'/api/v1/corrections',keys[2],'POST',report);
  assert.equal(filed.status,201);
  const big=await call(base,'/api/v1/corrections',keys[2],'POST',{...report,message:'x'.repeat(20_000)});
  assert.equal(big.status,413);assert.equal(big.headers.get('connection'),'close');
  // The longest legal message (2,000 characters, three bytes each in UTF-8, six as JSON escapes) still fits.
  const longest=await call(base,'/api/v1/corrections',keys[2],'POST',{...report,message:'\u4e2d'.repeat(2000)});
  assert.equal(longest.status,201);
  // An editor's review is a single word; 5 KB is refused (the editor routes need the editor key).
  const review=await fetch(base+'/api/v1/admin/corrections/'+filed.data.id,{method:'POST',headers:{Authorization:'Bearer '+editorKey,'Content-Type':'application/json'},body:JSON.stringify({status:'rejected',padding:'x'.repeat(5000)})});
  assert.equal(review.status,413);
  const accepted=await fetch(base+'/api/v1/admin/corrections/'+filed.data.id,{method:'POST',headers:{Authorization:'Bearer '+editorKey,'Content-Type':'application/json'},body:JSON.stringify({status:'rejected'})});
  assert.equal(accepted.status,200);
  // The profile limit, announced: one byte over.
  const over=await exchange(port,head('PUT','/api/v1/family',[bearer(keys[2]),jsonType,'Content-Length: '+(512*1024+1)])+'{',{wait:3000});
  assert.equal(over.status,413);
});

test('a body without a declared length is cut off at the limit, with a 413, and the service keeps serving',async t=>{
  const {base,port}=await listen(t);
  const outcome=await new Promise(resolve=>{
    const request=http.request({port,method:'POST',path:'/api/v1/corrections',headers:{Authorization:'Bearer '+keys[3],'Content-Type':'application/json','Transfer-Encoding':'chunked'}},response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve({status:response.statusCode,text,connection:response.headers.connection}));
    });
    request.on('error',error=>resolve({error:error.code}));
    // 64 KiB in 4 KiB pieces, against a limit of 16 KiB; stops writing once the service has answered.
    let sent=0;
    const write=()=>{
      if(request.destroyed||request.writableEnded)return;
      if(sent++>=16)return request.end();
      request.write('x'.repeat(4096),write);
    };
    write();
  });
  assert.equal(outcome.status,413,JSON.stringify(outcome));
  assert.equal(outcome.connection,'close');
  assert.equal((await fetch(base+'/healthz')).status,200);
});

test('time limits: a stalled head or body is cut off, a prompt request is not, and the defaults are the ones chosen',async t=>{
  const defaults=createServer();
  assert.equal(defaults.headersTimeout,10_000);assert.equal(defaults.requestTimeout,30_000);assert.equal(defaults.keepAliveTimeout,125_000);
  assert.ok(defaults.headersTimeout<=defaults.requestTimeout);
  const {port,base}=await listen(t,{headersTimeout:400,requestTimeout:900});
  // The head never ends.
  const stalledHead=await exchange(port,'PUT /api/v1/family HTTP/1.1\r\nHost: minitandem.test\r\n',{wait:6000});
  assert.ok(stalledHead.closed,'the connection is cut off');
  assert.ok(stalledHead.ms<4000,'cut off after '+stalledHead.ms+' ms');
  if(stalledHead.data)assert.equal(stalledHead.status,408);
  // The head is complete and announces 100 bytes; five arrive and then nothing.
  const stalledBody=await exchange(port,head('PUT','/api/v1/family',[bearer(keys[0]),jsonType,'Content-Length: 100'])+'12345',{wait:6000});
  assert.ok(stalledBody.closed,'the connection is cut off');
  assert.ok(stalledBody.ms<4000,'cut off after '+stalledBody.ms+' ms');
  if(stalledBody.data)assert.equal(stalledBody.status,408);
  assert.equal((await fetch(base+'/healthz')).status,200);
});

test('writes are limited per family key; reads, other keys and wrong keys are not affected',async t=>{
  const {base}=await listen(t,{writesPerMinute:3});
  const profile={version:1,favorites:[],notes:{},statuses:{},visits:{},tracked:{},age:null,origin:''};
  for(const revision of [0,1,2])assert.equal((await call(base,'/api/v1/family',keys[4],'PUT',{revision,profile})).status,200,'write '+(revision+1));
  const limited=await call(base,'/api/v1/family',keys[4],'PUT',{revision:3,profile});
  assert.equal(limited.status,429);assert.equal(limited.data.code,'rate.limit');
  const wait=Number(limited.headers.get('retry-after'));assert.ok(wait>=1&&wait<=60,'Retry-After '+wait);
  // Corrections count with the writes of the same key.
  const report={type:'vmeste-correction',version:1,activity:'memo-library',topic:'Schedule',message:'Check the opening hours',source:'',date:'2026-10-17'};
  assert.equal((await call(base,'/api/v1/corrections',keys[4],'POST',report)).status,429);
  // Reading is free, another family has its own allowance, and a wrong key is a 401 however often it tries.
  assert.equal((await call(base,'/api/v1/family',keys[4])).status,200);
  assert.equal((await call(base,'/api/v1/family',keys[5],'PUT',{revision:0,profile})).status,200);
  for(let attempt=0;attempt<6;attempt++)assert.equal((await call(base,'/api/v1/family','wrong'.repeat(10),'PUT',{revision:0,profile})).status,401);
});

test('the write limiter is a fixed window per key that forgets expired windows',()=>{
  let time=1_000_000;
  const limiter=writeLimiter(2,60_000,()=>time);
  assert.equal(limiter('a'),0);assert.equal(limiter('a'),0);
  assert.equal(limiter('a'),60);
  time+=10_000;assert.equal(limiter('a'),50,'still the same window, counted down');
  assert.equal(limiter('b'),0,'another key has its own window');
  time+=50_000;assert.equal(limiter('a'),0,'a new window starts when the old one is over');
  assert.equal(limiter('a'),0);assert.equal(limiter('a'),60);
});

test('CORS: only the site and local development origins; a preflight is answered for the family routes, their methods and headers, and nothing else',async t=>{
  const {base}=await listen(t);
  const ask=(route,origin,method,headers,extra={})=>call(base,route,null,'OPTIONS',null,{...(origin?{Origin:origin}:{}),...(method?{'Access-Control-Request-Method':method}:{}),...(headers?{'Access-Control-Request-Headers':headers}:{}),...extra});
  const site='https://minitandem.ch';
  for(const origin of [site,'http://localhost:8787']){
    const answer=await ask('/api/v1/family',origin,'PUT','authorization, content-type');
    assert.equal(answer.status,204,origin);
    assert.equal(answer.headers.get('access-control-allow-origin'),origin);
    assert.equal(answer.headers.get('access-control-allow-methods'),'GET, PUT');
    assert.equal(answer.headers.get('access-control-allow-headers'),'Authorization, Content-Type');
    assert.equal(answer.headers.get('access-control-max-age'),'600');
    assert.match(answer.headers.get('vary'),/Origin/);
    assert.equal(answer.headers.get('access-control-allow-credentials'),null);
  }
  assert.equal((await ask('/api/v1/corrections',site,'POST','content-type')).headers.get('access-control-allow-methods'),'POST');
  assert.equal((await ask('/api/v1/family',site,'GET',null)).status,204);
  // Refused: a stranger's origin, no origin, another method, another route, the editor routes, a header the API does not use.
  for(const [what,answer] of [
    ['foreign origin',await ask('/api/v1/family','https://bad.example','PUT','authorization')],
    ['a lookalike',await ask('/api/v1/family','https://minitandem.ch.evil.example','PUT','authorization')],
    ['no origin',await ask('/api/v1/family',null,'PUT','authorization')],
    ['no method',await ask('/api/v1/family',site,null,null)],
    ['DELETE',await ask('/api/v1/family',site,'DELETE','authorization')],
    ['POST on the profile',await ask('/api/v1/family',site,'POST','authorization')],
    ['PUT on corrections',await ask('/api/v1/corrections',site,'PUT','authorization')],
    ['an editor route',await ask('/api/v1/admin/queue',site,'GET','authorization')],
    ['a review',await ask('/api/v1/admin/corrections/'+'a'.repeat(20),site,'POST','authorization')],
    ['a static file',await ask('/index.html',site,'GET',null)],
    ['another header',await ask('/api/v1/family',site,'PUT','authorization, x-forwarded-host')]
  ]){
    assert.equal(answer.status,403,what);
    assert.equal(answer.headers.get('access-control-allow-methods'),null,what);
  }
  for(const origin of ['https://bad.example','https://minitandem.ch.evil.example']){
    const answer=await ask('/api/v1/family',origin,'PUT','authorization');
    assert.equal(answer.headers.get('access-control-allow-origin'),null,origin);
    assert.equal(answer.headers.get('access-control-allow-methods'),null,origin);
  }
  // The ordinary answers carry the allowed origin and nothing about methods or headers; a foreign origin gets none and a 403.
  const plain=await call(base,'/healthz',null,'GET',null,{Origin:site});
  assert.equal(plain.status,200);assert.equal(plain.headers.get('access-control-allow-origin'),site);
  assert.equal(plain.headers.get('access-control-allow-methods'),null);
  assert.notEqual(plain.headers.get('access-control-allow-origin'),'*');
  const foreign=await call(base,'/healthz',null,'GET',null,{Origin:'https://bad.example'});
  assert.equal(foreign.status,403);assert.equal(foreign.headers.get('access-control-allow-origin'),null);
  // While family sync is off, nothing is promised to another origin.
  process.env.MINITANDEM_FAMILY_SYNC='0';
  try{assert.equal((await ask('/api/v1/family',site,'PUT','authorization')).status,403);}
  finally{process.env.MINITANDEM_FAMILY_SYNC='1';}
});

test('in production only the site is an allowed origin; development origins come back outside it or by name',async t=>{
  const free=()=>new Promise((resolve,reject)=>{const probe=net.createServer();probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port));});probe.on('error',reject);});
  async function origins(extraEnv){
    const port=await free();
    const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',script,'start'],{env:{...env,MINITANDEM_HOST:'127.0.0.1',MINITANDEM_PORT:String(port),NODE_ENV:'',...extraEnv},stdio:'ignore'});
    t.after(()=>child.kill());
    let ready=false;
    for(let tries=0;tries<200&&!ready;tries++){try{ready=(await fetch(`http://127.0.0.1:${port}/healthz`)).ok;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
    assert.ok(ready,'the service started');
    const status=async origin=>(await fetch(`http://127.0.0.1:${port}/healthz`,{headers:{Origin:origin}})).status;
    const result={site:await status('https://minitandem.ch'),localhost:await status('http://localhost:8787'),loopback:await status('http://127.0.0.1:8787')};
    child.kill();await new Promise(resolve=>child.once('close',resolve));
    return result;
  }
  assert.deepEqual(await origins({NODE_ENV:'production'}),{site:200,localhost:403,loopback:403});
  assert.deepEqual(await origins({NODE_ENV:'production',MINITANDEM_ORIGINS:'http://localhost:8787'}),{site:200,localhost:200,loopback:403});
  assert.deepEqual(await origins({}),{site:200,localhost:200,loopback:200});
});
