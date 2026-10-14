import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {PRIVATE} from './editorial/public-audit.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const tmp=(t,prefix)=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;};

// ---- .dockerignore: a small model of how Docker reads it (last matching pattern wins; a pattern also matches everything below a folder it matches)
function dockerignore(text){
  const rules=text.split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')).map(line=>{
    const negate=line.startsWith('!');
    const pattern=path.posix.normalize((negate?line.slice(1):line).replace(/^\//,''));
    const source=pattern.split('/').map(part=>part==='**'?'(?:.+/)?':part.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'[^/]*').replace(/\?/g,'[^/]')+'/').join('').replace(/\/$/,'').replace(/\(\?:\.\+\/\)\?$/,'.*');
    return {negate,regex:new RegExp('^'+source+'$')};
  });
  return file=>{
    const parts=file.split('/'),candidates=parts.map((_,index)=>parts.slice(0,index+1).join('/'));
    let excluded=false;
    for(const rule of rules)if(candidates.some(candidate=>rule.regex.test(candidate)))excluded=!rule.negate;
    return excluded;
  };
}

test('.dockerignore, read by a model of Docker\'s matching rules (no real build has run yet), keeps every private path out and lets the build files in',t=>{
  const excluded=dockerignore(read('.dockerignore'));
  for(const item of PRIVATE){
    const file=item.endsWith('/')?item+'some-file.json':item;
    assert.equal(excluded(file),true,item+' would enter the image');
  }
  for(const file of ['editorial/release-identity.json','.env','.playwright-path','.workspace-in-use','.git/config','.publish/index.html','server-state/families.json',
    'editorial/workflow-state/jobs.sqlite','editorial/external-review-receipts.json','editorial/agent-artifacts/0123.json','node_modules/x/index.js'])
    assert.equal(excluded(file),true,file+' would enter the image');
  for(const file of ['server.mjs','build.mjs','site.mjs','index.html','data.js','research.md','assets/leaflet.js','editorial/quality.mjs','editorial/package.json',
    'editorial/package-lock.json','editorial/source-watch.json','editorial/approved-updates.json','docker/entrypoint.sh','.vercelignore',
    'case-study.mjs','content/fallstudie.de.md','content/fallstudie.en.md'])
    assert.equal(excluded(file),false,file+' is needed by the build');
  for(const file of ['server.test.mjs','editorial/jobs.test.mjs','verify.mjs','demo/run.mjs','design/minitandem-mockup.html'])
    assert.equal(excluded(file),true,file+' is not needed in the image');
  // Every file of a working folder is checked against the real list: nothing private may be included, whatever else is there.
  const privateInside=[];
  const walk=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
    const full=path.join(folder,entry.name),rel=path.relative(root,full);
    if(rel==='.git'||rel.endsWith('node_modules'))continue;
    if(entry.isDirectory()){walk(full);continue;}
    if(!excluded(rel)&&PRIVATE.some(item=>rel===item||rel.startsWith(item.endsWith('/')?item:item+'/')))privateInside.push(rel);
  }};
  walk(root);
  assert.deepEqual(privateInside,[]);
});

test('the Dockerfile builds from tracked files with the public flag, runs unprivileged and checks /healthz',()=>{
  const file=read('Dockerfile');
  assert.match(file,/npm ci --omit=dev/);
  assert.match(file,/RUN node build\.mjs --public/);
  assert.match(file,/^USER node$/m);
  assert.match(file,/HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(file,/ENTRYPOINT \["docker\/entrypoint\.sh"\]/);
  assert.match(file,/ARG NODE_VERSION=24\.\d+\.\d+/);
  assert.doesNotMatch(file,/new-admin/);
  assert.doesNotMatch(file,/(?:^|\s)COPY[^\n]*(?:workflow-state|archive-ru|receipts|release-identity)/);
});

test('compose.yaml: Caddy is the only service with public ports, the state is a named volume, nothing can create an editor key',()=>{
  const compose=read('compose.yaml');
  assert.match(compose,/^name: minitandem$/m);
  const app=compose.slice(compose.indexOf('\n  app:'),compose.indexOf('\n  caddy:')),caddy=compose.slice(compose.indexOf('\n  caddy:'),compose.indexOf('\nvolumes:'));
  assert.doesNotMatch(app,/^\s+ports:/m);
  assert.match(app,/expose:\s*\n\s+- "8787"/);
  assert.match(app,/state:\/state/);
  assert.match(app,/read_only: true/);
  assert.match(app,/cap_drop:\s*\n\s+- ALL/);
  for(const port of ['"80:80"','"443:443"','"443:443/udp"'])assert.ok(caddy.includes(port),port);
  assert.match(caddy,/ACME_EMAIL: \$\{ACME_EMAIL:\?/);
  assert.match(caddy,/condition: service_healthy/);
  assert.match(compose,/^volumes:\s*\n(?:\s+#.*\n)*\s+state:\s*\n(?:\s+#.*\n)*\s+caddy-data:/m);
  assert.doesNotMatch(compose,/new-admin|MINITANDEM_ADMIN/);
  const local=read('compose.local.yaml');
  assert.match(local,/127\.0\.0\.1:8787:8787/);
  assert.match(local,/profiles: \["edge"\]/);
});

test('Caddyfile: both names, www redirects to the apex, editor paths refused, everything else to the service',()=>{
  const file=read('docker/Caddyfile');
  assert.equal(file.split('{').length,file.split('}').length,'braces are balanced');
  assert.match(file,/^www\.minitandem\.ch \{\s*\n\s+redir https:\/\/minitandem\.ch\{uri\} permanent/m);
  assert.match(file,/^minitandem\.ch \{/m);
  assert.match(file,/@editor path \/admin \/admin\.js \/admin\.css \/api\/v1\/admin\/\*\s*\n\s+respond @editor 404/);
  assert.match(file,/reverse_proxy app:8787/);
  assert.match(file,/health_uri \/healthz/);
  assert.match(file,/email \{\$ACME_EMAIL\}/);
});

function freePort(){
  return new Promise((resolve,reject)=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});server.on('error',reject);});
}
async function waitFor(url,tries=60){
  for(let i=0;i<tries;i++){try{const response=await fetch(url);if(response.ok)return response;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('Service did not answer at '+url);
}

test('the entrypoint creates one demo family, never an editor key, serves /healthz, and does nothing more on the second start',async t=>{
  const state=tmp(t,'minitandem-entrypoint-'),port=await freePort();
  const env={...process.env,MINITANDEM_STATE_DIR:path.join(state,'state'),MINITANDEM_CORRECTION_DIR:path.join(state,'state','corrections'),
    MINITANDEM_HOST:'127.0.0.1',MINITANDEM_PORT:String(port)};
  const start=()=>{const child=spawn('sh',[path.join(root,'docker','entrypoint.sh')],{env,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});return {child,output:()=>output};};
  const stop=async run=>{run.child.kill('SIGTERM');await new Promise(resolve=>run.child.on('close',resolve));};
  let run=start();
  try{
    const health=await waitFor(`http://127.0.0.1:${port}/healthz`);
    assert.equal((await health.json()).status,'ok');
    const keyFile=path.join(env.MINITANDEM_STATE_DIR,'demo-family-key.txt');
    const key=fs.readFileSync(keyFile,'utf8').trim();
    assert.match(key,/^[A-Za-z0-9_-]{40,}$/);
    assert.equal(fs.statSync(keyFile).mode&0o077,0,'the key file is readable by its owner only');
    const db=JSON.parse(fs.readFileSync(path.join(env.MINITANDEM_STATE_DIR,'families.json'),'utf8'));
    assert.equal(db.adminHash,null,'no editor key exists');
    assert.equal(Object.keys(db.families).length,1,'exactly one demo family');
    assert.equal(JSON.stringify(db).includes(key),false,'the file holds the hash of the key, not the key');
    // The demo family key works; a made-up editor key does not.
    const family=await fetch(`http://127.0.0.1:${port}/api/v1/family`,{headers:{Authorization:'Bearer '+key}});
    assert.equal(family.status,200);
    const fakeEditor='x'.repeat(43);
    for(const route of ['/api/v1/admin/queue','/api/v1/admin/operations'])
      assert.equal((await fetch(`http://127.0.0.1:${port}${route}`,{headers:{Authorization:'Bearer '+fakeEditor}})).status,401,route);
    assert.match(run.output(),/Created one demo family/);
    await stop(run);
    run=start();
    await waitFor(`http://127.0.0.1:${port}/healthz`);
    assert.equal(fs.readFileSync(keyFile,'utf8').trim(),key,'the key is not replaced');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(env.MINITANDEM_STATE_DIR,'families.json'),'utf8')).families).length,1);
    assert.doesNotMatch(run.output(),/Created one demo family/);
  }finally{await stop(run);}
});

// The image runs `node build.mjs --public` on the files the build context lets in. Building from exactly those files
// here catches a source the build needs but .dockerignore leaves out; the first deployment of /projekt/ failed that way.
test('the site builds from the files the Docker build context lets in',t=>{
  const listed=spawnSync('git',['ls-files'],{cwd:root,encoding:'utf8'});
  if(listed.status!==0)return t.skip('not a git checkout');
  const excluded=dockerignore(read('.dockerignore'));
  const context=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-context-'));
  t.after(()=>fs.rmSync(context,{recursive:true,force:true}));
  for(const file of listed.stdout.split('\n').filter(Boolean).filter(file=>!excluded(file))){
    fs.mkdirSync(path.dirname(path.join(context,file)),{recursive:true});
    fs.copyFileSync(path.join(root,file),path.join(context,file));
  }
  // The image installs the pipeline's dependencies in its own stage; here the checkout's copy stands in for them.
  if(fs.existsSync(path.join(root,'editorial/node_modules')))fs.symlinkSync(path.join(root,'editorial/node_modules'),path.join(context,'editorial/node_modules'));
  const build=spawnSync(process.execPath,['build.mjs','--public'],{cwd:context,encoding:'utf8'});
  assert.equal(build.status,0,build.stderr.slice(-800));
  for(const file of ['index.html','projekt/index.html','projekt/en/index.html','places/index.html','sitemap.xml'])
    assert.ok(fs.existsSync(path.join(context,'.publish',file)),file);
});

const HAS_CURL=spawnSync('curl',['--version'],{stdio:'ignore'}).status===0;
test('ops/healthcheck.sh mails once when the service goes down and once when it is back, and stays quiet otherwise',{skip:HAS_CURL?false:'curl is not installed'},async t=>{
  const folder=tmp(t,'minitandem-health-script-'),mailbox=path.join(folder,'mail.txt');
  const sendmail=path.join(folder,'fake-sendmail');
  fs.writeFileSync(sendmail,`#!/bin/sh\ncat >> '${mailbox}'\necho '--- end of mail ---' >> '${mailbox}'\n`,{mode:0o755});
  let healthy=true;
  const server=http.createServer((request,response)=>{if(healthy){response.writeHead(200,{'Content-Type':'application/json'});response.end('{"status":"ok","records":1}');}else{response.writeHead(503);response.end('down');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  // Asynchronous on purpose: this process also runs the fake service, and a blocking call would stop it from answering.
  const check=()=>new Promise(resolve=>{
    const child=spawn('sh',[path.join(root,'ops','healthcheck.sh')],{stdio:'ignore',env:{...process.env,HEALTH_MAIL_TO:'owner@example.org',HEALTH_MAIL_FROM:'monitor@example.org',
      HEALTH_URL:`http://127.0.0.1:${server.address().port}/healthz`,HEALTH_STATE:path.join(folder,'state','last'),HEALTH_SENDMAIL:sendmail}});
    child.on('close',status=>resolve({status}));
  });
  const mails=()=>fs.existsSync(mailbox)?fs.readFileSync(mailbox,'utf8').split('--- end of mail ---').filter(part=>part.trim()).length:0;
  assert.equal((await check()).status,0);assert.equal(mails(),0,'up on the first check: no mail');
  assert.equal((await check()).status,0);assert.equal(mails(),0);
  healthy=false;
  assert.equal((await check()).status,1);assert.equal(mails(),1,'down: one mail');
  assert.equal((await check()).status,1);assert.equal(mails(),1,'still down: no second mail');
  healthy=true;
  assert.equal((await check()).status,0);assert.equal(mails(),2,'back up: one mail');
  const text=fs.readFileSync(mailbox,'utf8');
  assert.match(text,/Subject: Minitandem is DOWN/);assert.match(text,/Subject: Minitandem is back up/);assert.match(text,/To: owner@example\.org/);
});
