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
// A config without its comment lines, for checks of what it does rather than what it says.
const code=text=>text.split('\n').filter(line=>!line.trim().startsWith('#')).join('\n');
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
    // The Caddy image copies these four from the context.
    'docker/Caddyfile','docker/site.caddy','docker/preview.Caddyfile','docker/access-log-entrypoint.sh',
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
  // The deployed commit is written into build-info.json of the image, so the files of a code-only release differ from the previous ones.
  assert.match(file,/ARG RELEASE_COMMIT=local/);assert.match(file,/info\.commit=process\.argv\[1\]/);
  assert.match(file,/^USER node$/m);
  assert.match(file,/HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(file,/ENTRYPOINT \["docker\/entrypoint\.sh"\]/);
  // The API is the last stage, so that a build without a target still gives the service, as before the Caddy image.
  assert.ok(file.lastIndexOf('AS app')>file.indexOf('AS edge')&&file.indexOf('AS edge')>file.indexOf('AS build'),'stages: build, edge, app');
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
  // The deployed commit reaches /healthz through the image tag (docs/betrieb.md, Update); an unset tag gives an empty value, not a warning.
  assert.match(app,/MINITANDEM_COMMIT: \$\{MINITANDEM_TAG:-\}/);
  assert.match(app,/read_only: true/);
  assert.match(app,/cap_drop:\s*\n\s+- ALL/);
  for(const port of ['"80:80"','"443:443"','"443:443/udp"'])assert.ok(caddy.includes(port),port);
  assert.match(caddy,/ACME_EMAIL: \$\{ACME_EMAIL:\?/);
  assert.match(caddy,/condition: service_healthy/);
  // Both images are built from the same Dockerfile, commit, tag and build arguments, so the files Caddy serves and the API are one release.
  assert.match(app,/target: app\n/);assert.match(caddy,/target: edge\n/);
  assert.match(caddy,/image: minitandem-caddy:\$\{MINITANDEM_TAG:-current\}/);assert.match(app,/image: minitandem-app:\$\{MINITANDEM_TAG:-current\}/);
  for(const service of [app,caddy]){
    assert.match(service,/RELEASE_COMMIT: \$\{MINITANDEM_TAG:-current\}/);
    assert.match(service,/MINITANDEM_FAMILY_SYNC: \$\{MINITANDEM_FAMILY_SYNC:-0\}/);
  }
  // Nothing of the checkout is mounted into Caddy: its Caddyfile, the routes and the log script are in the image of the release.
  assert.doesNotMatch(caddy,/\.\/docker|Caddyfile:|\/srv\/site/);
  assert.doesNotMatch(caddy,/^\s+- \.\//m);
  assert.match(compose,/^volumes:\s*\n(?:\s+#.*\n)*\s+state:\s*\n(?:\s+#.*\n)*\s+caddy-data:/m);
  assert.doesNotMatch(compose,/new-admin|MINITANDEM_ADMIN/);
  const local=read('compose.local.yaml');
  assert.match(local,/127\.0\.0\.1:8787:8787/);
  assert.match(local,/profiles: \["edge"\]/);
});

test('compose and Dockerfile: Caddy is a fixed release with only the capability to bind its ports, and Node in the image is a fixed release',()=>{
  const compose=read('compose.yaml'),caddy=compose.slice(compose.indexOf('\n  caddy:'),compose.indexOf('\nvolumes:'));
  // The pinned release is the base of the Caddy image of every release (it was the image of the service before the Caddy images).
  assert.match(read('Dockerfile'),/^FROM caddy:\d+\.\d+\.\d+-alpine AS edge$/m);
  assert.doesNotMatch(read('Dockerfile'),/caddy:2-alpine|caddy:latest|caddy:alpine/);
  assert.match(caddy,/entrypoint: \["\/bin\/sh", "\/etc\/caddy\/access-log-entrypoint\.sh"\]/);
  assert.match(caddy,/cap_drop:\s*\n\s+- ALL/);assert.match(caddy,/cap_add:\s*\n\s+- NET_BIND_SERVICE\n/);
  assert.match(caddy,/security_opt:\s*\n\s+- no-new-privileges:true/);
  const node=read('Dockerfile').match(/ARG NODE_VERSION=(\d+\.\d+\.\d+)/);assert.ok(node);
  assert.equal(read('.nvmrc').trim(),node[1],'CI tests the Node release the image runs');
});
test('Caddyfile and routes: both names, www redirects to the apex, editor paths refused, only the API and /healthz go to the service, the files are the image\'s',()=>{
  const file=read('docker/Caddyfile'),routes=read('docker/site.caddy'),preview=read('docker/preview.Caddyfile');
  for(const config of [file,routes,preview])assert.equal(config.split('{').length,config.split('}').length,'braces are balanced');
  assert.match(file,/^www\.minitandem\.ch \{\s*\n\s+redir https:\/\/minitandem\.ch\{uri\} permanent/m);
  assert.match(file,/^minitandem\.ch \{/m);
  assert.match(file,/email \{\$ACME_EMAIL\}/);
  // The real edge and the preview import the very same routes; the snippet is defined before either site block uses it.
  for(const config of [file,preview])assert.match(config,/^import \/etc\/caddy\/site\.caddy$[\s\S]*^\s+import catalogue$/m);
  assert.match(preview,/admin off/);assert.match(preview,/auto_https off/);assert.match(preview,/^:8080 \{/m);assert.doesNotMatch(preview,/email|log \{|minitandem\.ch/);
  assert.match(routes,/^\(catalogue\) \{/m);
  assert.match(routes,/@editor path \/admin \/admin\.js \/admin\.css \/admin-icons\.js \/api\/v1\/admin\/\*\s*\n\s+handle @editor \{\s*\n\s+respond 404\s*\n\s+\}/);
  assert.match(routes,/@backend path \/api\/\* \/healthz\s*\n\s+handle @backend \{\s*\n\s+reverse_proxy app:8787/);
  assert.equal((code(routes).match(/reverse_proxy/g)||[]).length,1,'one proxy, for the two backend paths');
  assert.match(routes,/health_uri \/healthz/);assert.match(routes,/root \* \/srv\/site/);
  // Order of the handle blocks decides what is served: editor paths first, then the service paths, then the files.
  assert.ok(routes.indexOf('handle @editor')<routes.indexOf('handle @backend')&&routes.indexOf('handle @backend')<routes.indexOf('root * /srv/site'));
  // Files as the service served them: no fallback to index.html, no listing, dot paths refused, folders redirected with 301, nothing larger than a file is guessed.
  assert.doesNotMatch(code(routes),/\bbrowse\b|try_files|precompressed|fallback/);
  assert.match(routes,/@hidden path_regexp hidden \(\^\|\/\)\\\./);
  assert.match(routes,/redir @directory \{http\.matchers\.file\.relative\} 301/);
  assert.match(routes,/file_server \{\s*disable_canonical_uris\s*\}/);
  assert.match(read('Dockerfile'),/FROM caddy:[\d.]+-alpine AS edge\nCOPY --from=build \/app\/\.publish \/srv\/site\nCOPY docker\/Caddyfile docker\/site\.caddy docker\/preview\.Caddyfile docker\/access-log-entrypoint\.sh \/etc\/caddy\/$/m);
});

test('Caddyfile and routes: read timeouts and a body cap for the API at the edge, cross-origin policies, no Via, and only modules the standard build has',()=>{
  const file=read('docker/Caddyfile'),routes=read('docker/site.caddy'),options=file.slice(0,file.indexOf('\nwww.minitandem.ch'));
  // Only reads are limited; a slow download is not cut.
  assert.match(options,/servers \{\s*timeouts \{\s*read_header 10s\s*read_body 30s\s*\}\s*\}/);
  assert.doesNotMatch(options,/^\s*(?:write|idle)\s/m);
  const header=routes.match(/\n\theader \{([\s\S]*?)\n\t\}/)?.[1];assert.ok(header,'the routes set headers for every answer');
  for(const line of ['Cross-Origin-Opener-Policy same-origin','Cross-Origin-Resource-Policy same-origin','-Via','-Server','Strict-Transport-Security "max-age=86400"',
    'X-Content-Type-Options nosniff','X-Frame-Options DENY','Referrer-Policy no-referrer','Permissions-Policy "camera=(), microphone=(), geolocation=(self)"'])
    assert.ok(header.split('\n').some(item=>item.trim()===line),line);
  // Caddy adds Via in the proxy; it is removed there as well as in the header block.
  assert.match(routes,/reverse_proxy app:8787 \{[^}]*\n\t\t\theader_down -Via\n/);
  // The edge fence is for the API paths and is not smaller than the largest body the service reads, or it would cut off a legitimate profile.
  const fence=routes.match(/request_body \/api\/\* \{\s*max_size (\d+)KiB\s*\}/);assert.ok(fence,'the API paths have a body cap');
  const profile=read('server.mjs').match(/profile:(\d+)\*1024/);assert.ok(profile);
  assert.ok(Number(fence[1])>=Number(profile[1]),'the edge cap is not below the service limit');
  // A per-client rate limit needs a third-party module; the image is the standard one.
  assert.doesNotMatch(file+routes,/rate_limit/);
});

function freePort(){
  return new Promise((resolve,reject)=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});server.on('error',reject);});
}
async function waitFor(url,tries=300){ // up to 30 s on a busy machine; returns as soon as the service answers
  for(let i=0;i<tries;i++){try{const response=await fetch(url);if(response.ok)return response;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('Service did not answer at '+url);
}

test('the entrypoint creates one demo family, never an editor key, serves /healthz, and does nothing more on the second start',async t=>{
  const state=tmp(t,'minitandem-entrypoint-'),port=await freePort();
  const env={...process.env,MINITANDEM_FAMILY_SYNC:'1',MINITANDEM_STATE_DIR:path.join(state,'state'),MINITANDEM_CORRECTION_DIR:path.join(state,'state','corrections'),
    MINITANDEM_HOST:'127.0.0.1',MINITANDEM_PORT:String(port)};
  delete env.MINITANDEM_COMMIT;
  const start=()=>{const child=spawn('sh',[path.join(root,'docker','entrypoint.sh')],{env,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});return {child,output:()=>output};};
  const stop=async run=>{run.child.kill('SIGTERM');await new Promise(resolve=>run.child.on('close',resolve));};
  let run=start();
  try{
    const health=await waitFor(`http://127.0.0.1:${port}/healthz`);
    const answer=await health.json();
    assert.equal(answer.status,'ok');
    // The image's own build says which catalogue it holds; there is no commit unless the deployment passes one.
    assert.match(answer.revision,/^[a-f0-9]{16}$/);assert.match(answer.catalogueUpdated,/^\d{4}-\d{2}-\d{2}$/);assert.equal('commit' in answer,false);
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
  const build=spawnSync(process.execPath,['build.mjs','--public'],{cwd:context,encoding:'utf8',env:{...process.env,MINITANDEM_FAMILY_SYNC:'0'}});
  assert.equal(build.status,0,build.stderr.slice(-800));
  for(const file of ['index.html','projekt/index.html','projekt/en/index.html','places/index.html','impressum/index.html','impressum/fr/index.html','impressum/en/index.html','datenschutz/index.html','datenschutz/fr/index.html','datenschutz/en/index.html','sitemap.xml','build-info.json'])
    assert.ok(fs.existsSync(path.join(context,'.publish',file)),file);
  assert.match(fs.readFileSync(path.join(context,'.publish/features.js'),'utf8'),/familySync":false/);
  const enabled=spawnSync(process.execPath,['build.mjs','--public'],{cwd:context,encoding:'utf8',env:{...process.env,MINITANDEM_FAMILY_SYNC:'1'}});
  assert.equal(enabled.status,0,enabled.stderr.slice(-800));
  assert.match(fs.readFileSync(path.join(context,'.publish/features.js'),'utf8'),/familySync":true/);
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
