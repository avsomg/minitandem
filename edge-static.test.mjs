import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

// Caddy serves the public files itself (docker/site.caddy); the service used to. This file holds the two to the same answers:
// the headers, types, cache rules and refusals that server.mjs gave for a file, plus what the edge added in front of it (docker/Caddyfile
// before the Caddy images). The first group needs no Caddy: it reads the routes as text and compares them with what the service really answers.
// The last test runs the real Caddy against the real service when a Caddy binary is given (MINITANDEM_CADDY_BIN), and says so when it is skipped.
// It reads only files of the build and of docker/, and server.mjs, so that it can also run inside the API image of a release (docs/betrieb.md).
const root=path.dirname(fileURLToPath(import.meta.url));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const publish=path.join(root,'.publish');
const BUILT=fs.existsSync(path.join(publish,'index.html'));
const skipUnbuilt=BUILT?false:'the site is not built: run node build.mjs --public';

// The service as the image runs it: production, so that only the site's own origin is allowed, and with the public files it serves itself.
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-edge-'));
Object.assign(process.env,{NODE_ENV:'production',MINITANDEM_STATE_DIR:path.join(temp,'state'),MINITANDEM_CORRECTION_DIR:path.join(temp,'corrections')});
for(const name of ['MINITANDEM_ORIGINS','MINITANDEM_API_ONLY','MINITANDEM_COMMIT'])delete process.env[name];
const {createServer}=await import('./server.mjs?edge-static='+Date.now());
const {SITE_ORIGIN}=await import('./site.mjs');
test.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
async function listen(t,server=createServer()){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  return {server,base:'http://127.0.0.1:'+server.address().port};
}

// ---- the routes as text
const code=text=>text.split('\n').filter(line=>!line.trim().startsWith('#')).join('\n');
// The text between the braces that open at the first "{" from `from`; an escaped brace (\{) is not counted.
function inner(text,from){
  let depth=0,start=-1;
  for(let i=from;i<text.length;i++){
    if(text[i-1]==='\\')continue;
    if(text[i]==='{'){if(depth===0)start=i+1;depth++;}
    else if(text[i]==='}'&&--depth===0)return text.slice(start,i);
  }
  throw Error('unbalanced braces');
}
const unquote=value=>value.replace(/^"(.*)"$/,'$1');
const routes=code(read('docker/site.caddy'));
// `header { ... }` of the snippet: what every answer gets (the edge's headers).
const edgeLines=inner(routes,routes.indexOf('header {')).split('\n').map(line=>line.trim()).filter(Boolean);
const edge={},deleted=[];
for(const line of edgeLines){
  if(line.startsWith('-'))deleted.push(line.slice(1).toLowerCase());
  else{const [name,...value]=line.split(/\s+/);edge[name.toLowerCase()]=unquote(value.join(' '));}
}
// The rules for an existing file: fixed headers, then a type for each extension; later lines win, as they do in the route.
const fileBlock=inner(routes,routes.indexOf('handle @existing'));
const fileHeaders={},extensions=[],matchers={};
for(const line of fileBlock.split('\n').map(item=>item.trim())){
  let found;
  if((found=/^(@\w+) path (.+)$/.exec(line)))matchers[found[1]]=found[2].split(/\s+/);
  else if((found=/^header (?:(@\w+) )?([A-Za-z-]+) (.+)$/.exec(line))){
    const [,matcher,name,value]=found;
    if(matcher)extensions.push({patterns:matchers[matcher],type:unquote(value)});
    else fileHeaders[name.toLowerCase()]=unquote(value);
  }
}
// What the route sends for the existing file `file` (path inside the site, "places/index.html").
function caddyHeaders(file){
  const headers={...edge,...fileHeaders};
  for(const {patterns,type} of extensions)if(patterns.some(pattern=>file.toLowerCase().endsWith(pattern.slice(1))))headers['content-type']=type;
  return headers;
}

// What the visitor got for a public file before Caddy served it: the headers the edge added (docker/Caddyfile, set out here as they were)
// over those the service sent. These are the values to keep.
const EDGE_BEFORE={
  'strict-transport-security':'max-age=86400','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer',
  'permissions-policy':'camera=(), microphone=(), geolocation=(self)','cross-origin-opener-policy':'same-origin','cross-origin-resource-policy':'same-origin'
};
// Headers of the transport and of the file system, not of the policy. Caddy adds the last three for a file; the service never did.
const TRANSPORT=new Set(['date','connection','keep-alive','transfer-encoding','content-length']);
const FROM_FILE_SERVER=new Set(['etag','last-modified','accept-ranges']);
const headersOf=response=>Object.fromEntries([...response.headers].map(([name,value])=>[name.toLowerCase(),value]));
const policy=headers=>Object.fromEntries(Object.entries(headers).filter(([name])=>!TRANSPORT.has(name)&&!FROM_FILE_SERVER.has(name)).sort(([a],[b])=>a.localeCompare(b)));
// Two identical lines of one header (the service and the edge both sent nosniff) read as one; Vary is a set of names, and encoding is Caddy's business.
const tidy=headers=>Object.fromEntries(Object.entries(headers).map(([name,value])=>{
  if(name==='vary')return [name,value.split(/\s*,\s*/).filter(token=>token.toLowerCase()!=='accept-encoding').sort().join(', ')];
  return [name,[...new Set(value.split(/\s*,\s*(?=nosniff|no-referrer)/))].join(', ')];
}).filter(([name,value])=>name!=='vary'||value));
// The part of the route for public files: everything inside `handle { root * /srv/site ... }`, where the refusals are written too.
const staticBlock=inner(routes,routes.indexOf('handle {\n\t\troot * /srv/site'));
const walk=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name)):[path.relative(publish,path.join(directory,entry.name))]);
const visible=file=>!file.split(path.sep).some(part=>part.startsWith('.'));

test('the headers Caddy sends for public files are those of the service and of the edge before it, file by file',{skip:skipUnbuilt},async t=>{
  const {base}=await listen(t);
  assert.deepEqual(edge,EDGE_BEFORE,'the headers set for every answer are those the edge set before');
  assert.deepEqual(deleted.sort(),['server','via'],'Server and Via are removed');
  const files=walk(publish).filter(visible);
  assert.ok(files.length>300,'every page of the catalogue is covered');
  for(const file of files){
    const url='/'+file.split(path.sep).join('/'),response=await fetch(base+url);
    assert.equal(response.status,200,url);
    const before=tidy(policy({...headersOf(response),...EDGE_BEFORE})),now=tidy(policy(caddyHeaders(file)));
    assert.deepEqual(now,before,url);
    await response.arrayBuffer();
  }
});

test('the pages and files named in the review have the security headers, the cache rule and the type they had, and no Via or Server',{skip:skipUnbuilt},async t=>{
  const {base}=await listen(t);
  const csp="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://wmts.geo.admin.ch; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
  for(const [url,file,type] of [['/','index.html','text/html; charset=utf-8'],['/projekt/','projekt/index.html','text/html; charset=utf-8'],['/impressum/','impressum/index.html','text/html; charset=utf-8'],
    ['/datenschutz/','datenschutz/index.html','text/html; charset=utf-8'],['/places/','places/index.html','text/html; charset=utf-8'],['/sitemap.xml','sitemap.xml','application/xml'],
    ['/robots.txt','robots.txt','text/plain; charset=utf-8'],['/sw.js','sw.js','text/javascript; charset=utf-8'],['/manifest.webmanifest','manifest.webmanifest','application/manifest+json'],
    ['/build-info.json','build-info.json','application/json'],['/assets/favicon.svg','assets/favicon.svg','image/svg+xml'],['/assets/icon-512.png','assets/icon-512.png','image/png']]){
    const expected={'content-security-policy':csp,'cache-control':'public, max-age=0, must-revalidate','content-type':type,...EDGE_BEFORE};
    const now=caddyHeaders(file),response=await fetch(base+url),before=tidy({...headersOf(response),...EDGE_BEFORE});
    for(const [name,value] of Object.entries(expected)){
      assert.equal(now[name],value,url+' '+name);
      assert.equal(before[name],value,url+' '+name+' (the service, with the edge\'s headers over it)');
    }
    for(const name of ['via','server'])assert.equal(name in now,false,url+' '+name);
    await response.arrayBuffer();
  }
  // The service worker is served from the root with no wider scope header; its scope is the whole site, as before.
  assert.equal('service-worker-allowed' in caddyHeaders('sw.js'),false);
  assert.equal((await fetch(base+'/sw.js')).headers.get('service-worker-allowed'),null);
});

test('every type of the service\'s table is a type of the route, and the route has no other',()=>{
  const server=read('server.mjs'),table=/const mime=\{([^}]+)\}/.exec(server)?.[1];assert.ok(table,'the service has a type table');
  const node=Object.fromEntries([...table.matchAll(/'(\.[^']+)':'([^']+)'/g)].map(match=>[match[1],match[2]]));
  assert.ok(Object.keys(node).length>=13);
  for(const [extension,type] of Object.entries(node))assert.equal(caddyHeaders('x'+extension)['content-type'],type,extension);
  const routeExtensions=new Set(extensions.flatMap(({patterns})=>patterns.map(pattern=>pattern.slice(1))));
  assert.deepEqual([...routeExtensions].sort(),Object.keys(node).sort(),'the same extensions');
  // What no table names is a download, as in the service (assets/LICENSE has no extension).
  assert.equal(caddyHeaders('assets/LICENSE')['content-type'],'application/octet-stream');
  assert.equal(caddyHeaders('x.unknown')['content-type'],'application/octet-stream');
});

test('the refusals of the route are the ones the service gives, with the same status, type, cache rule and body',{skip:skipUnbuilt},async t=>{
  const {base}=await listen(t);
  const answers=[...staticBlock.matchAll(/respond `([^`]*)` (\d{3})/g)].map(match=>({body:match[1].replace(/\\([{}])/g,'$1'),status:Number(match[2])}));
  assert.equal(answers.length,5);
  const sent=[
    ['Origin not allowed',()=>fetch(base+'/',{headers:{Origin:'https://other.example'}})],
    ['Preflight not allowed',()=>fetch(base+'/',{method:'OPTIONS'})],
    ['Method not allowed',()=>fetch(base+'/',{method:'POST'})],
    ['Not found (dot path)',()=>fetch(base+'/.vercelignore')],
    ['Not found',()=>fetch(base+'/missing')]
  ];
  for(const [index,[name,send]] of sent.entries()){
    const response=await send(),text=await response.text();
    assert.equal(response.status,answers[index].status,name);
    assert.equal(text,answers[index].body,name);
    assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8',name);
    assert.equal(response.headers.get('cache-control'),'no-store',name);
  }
  // The route sets these two on its own refusals as well (the lines before each respond).
  assert.equal((staticBlock.match(/header Content-Type "application\/json; charset=utf-8"\n\s+header Cache-Control no-store\n\s+respond/g)||[]).length,5);
  // Only the site's own origin is allowed for a file, as for the service in production; the route names the same one.
  assert.match(routes,new RegExp('@siteOrigin header Origin '+SITE_ORIGIN.replace(/[.]/g,'\\.')));
  assert.match(routes,new RegExp('not header Origin '+SITE_ORIGIN.replace(/[.]/g,'\\.')));
  const own=await fetch(base+'/robots.txt',{headers:{Origin:SITE_ORIGIN}});
  assert.equal(own.status,200);assert.equal(own.headers.get('access-control-allow-origin'),SITE_ORIGIN);assert.match(own.headers.get('vary'),/Origin/);
  assert.match(routes,new RegExp('header @siteOrigin Access-Control-Allow-Origin '+SITE_ORIGIN.replace(/[.]/g,'\\.')));
  assert.match(routes,/header @origin Vary Origin/);
  // A folder without its slash is sent to the slashed path with 301, and the target is a clean path from the segments.
  const folder=await fetch(base+'/projekt',{redirect:'manual'});
  assert.equal(folder.status,301);assert.equal(folder.headers.get('location'),'/projekt/');
  assert.match(routes,/redir @directory \{http\.matchers\.file\.relative\} 301/);
  assert.equal((await fetch(base+'/sw.js/')).status,404,'a file with a slash is not a file');
  assert.equal((await fetch(base+'/assets/')).status,404,'no listing');
  assert.equal((await fetch(base+'/places/does-not-exist/')).status,404,'no fallback to index.html');
});

// ---- the real Caddy against the real service
const CADDY=process.env.MINITANDEM_CADDY_BIN||'caddy';
const HAS_CADDY=spawnSync(CADDY,['version'],{stdio:'ignore'}).status===0;
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});server.on('error',reject);});

test('real Caddy: the preview configuration answers every built file, folder, refusal and method as the service did, and keeps serving files without it',{skip:HAS_CADDY?skipUnbuilt:'Caddy is not installed; run with MINITANDEM_CADDY_BIN set (docs/betrieb.md)'},async t=>{
  const folder=fs.mkdtempSync(path.join(temp,'caddy-')),port=await freePort();
  const reference=await listen(t),upstream=reference.base.replace('http://','');
  // The real routes, with the paths of this machine: the site folder and the service's address replace the two container values.
  // The listener keeps http:// in front: a site address with a host and no scheme is HTTPS for Caddy, even with auto_https off.
  const siteFile=path.join(folder,'site.caddy'),previewFile=path.join(folder,'preview.Caddyfile');
  const siteText=read('docker/site.caddy').replace('root * /srv/site',`root * "${publish}"`).replace('reverse_proxy app:8787',`reverse_proxy ${upstream}`);
  assert.notEqual(siteText,read('docker/site.caddy'));
  fs.writeFileSync(siteFile,siteText);
  const previewText=read('docker/preview.Caddyfile').replace('/etc/caddy/site.caddy',siteFile).replace(':8080',`http://127.0.0.1:${port}`);
  assert.ok(previewText.includes(siteFile)&&previewText.includes(`127.0.0.1:${port}`));
  fs.writeFileSync(previewFile,previewText);
  const environment={...process.env,XDG_DATA_HOME:path.join(folder,'data'),XDG_CONFIG_HOME:path.join(folder,'config'),ACME_EMAIL:'owner@example.org'};
  // The Caddyfile of the real edge (certificates, access log, timeouts) must be accepted too: only its two paths are made local.
  const edgeFile=path.join(folder,'Caddyfile');
  fs.writeFileSync(edgeFile,read('docker/Caddyfile').replace('/etc/caddy/site.caddy',siteFile).replace('/var/log/caddy/access.json',path.join(folder,'access.json')));
  const validated=spawnSync(CADDY,['validate','--config',edgeFile,'--adapter','caddyfile'],{env:environment,encoding:'utf8'});
  assert.equal(validated.status,0,'caddy validate: '+validated.stderr.slice(-1500));
  const child=spawn(CADDY,['run','--config',previewFile,'--adapter','caddyfile'],{env:environment,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>log+=chunk);
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.on('close',resolve));}});
  const base='http://127.0.0.1:'+port;
  for(let i=0;;i++){
    try{if((await fetch(base+'/build-info.json')).ok)break;}catch{}
    if(i>150||child.exitCode!==null)throw Error('Caddy did not answer\n'+log.slice(-2000));
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  // What the service says with the edge's headers over it is what Caddy has to say.
  const compare=async(route,{method='GET',headers={},body}={})=>{
    const init={method,redirect:'manual',headers:{'Accept-Encoding':'identity',...headers},body};
    const [expected,actual]=await Promise.all([fetch(reference.base+route,init),fetch(base+route,init)]);
    const label=`${method} ${route} ${headers.Origin||''}`;
    assert.equal(actual.status,expected.status,label+' status');
    const wanted=tidy(policy({...headersOf(expected),...EDGE_BEFORE})),got=tidy(policy(headersOf(actual)));
    for(const name of deleted)assert.equal(name in got,false,label+' '+name);
    assert.deepEqual(got,wanted,label+' headers');
    if(expected.status<300||expected.status>=400)assert.deepEqual(Buffer.from(await actual.arrayBuffer()),Buffer.from(await expected.arrayBuffer()),label+' body');
  };
  const files=walk(publish).filter(visible).map(file=>'/'+file.split(path.sep).join('/'));
  const folders=['/projekt','/projekt/','/projekt/en/','/impressum/','/datenschutz/','/places','/places/','/assets','/assets/'];
  const refused=['/missing','/places/does-not-exist/','/.vercelignore','/assets/.hidden','/sw.js/','/index.html/','/%2e%2e/server.mjs','/healthz/extra','/vercel.json','/assets/lucide.min.js'];
  for(const route of [...files,'/',...folders,...refused])await compare(route);
  for(const method of ['HEAD','POST','PUT','DELETE','OPTIONS'])for(const origin of [undefined,SITE_ORIGIN,'https://other.example'])
    await compare('/',{method,headers:origin?{Origin:origin}:{}});
  await compare('/robots.txt',{headers:{Origin:SITE_ORIGIN}});
  await compare('/robots.txt',{headers:{Origin:'https://other.example'}});
  // The two kinds of request that belong to the service go to it and come back with the edge's headers and without Via.
  for(const route of ['/healthz','/api/v1/family']){
    const actual=await fetch(base+route),expected=await fetch(reference.base+route);
    assert.equal(actual.status,expected.status,route);assert.equal(await actual.text(),await expected.text(),route);
    assert.equal(actual.headers.get('via'),null,route);
    for(const [name,value] of Object.entries(EDGE_BEFORE))assert.equal(tidy({[name]:actual.headers.get(name)})[name],value,route+' '+name);
  }
  // The editor panel and its API are refused at the edge, as they were, though the service would answer them.
  for(const route of ['/admin','/admin.js','/admin.css','/admin-icons.js','/api/v1/admin/queue','/api/v1/admin/operations','/api/v1/admin/corrections/0123456789abcdef0123'])
    assert.equal((await fetch(base+route)).status,404,route);
  // A body above the cap is refused at the edge.
  const large=await fetch(base+'/api/v1/corrections',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"x":"'+'a'.repeat(600*1024)+'"}'});
  assert.equal(large.status,413);
  // Files do not depend on the service: with it stopped they are served, and the service's paths fail.
  reference.server.closeAllConnections();await new Promise(resolve=>reference.server.close(resolve));
  for(const route of ['/','/projekt/','/sw.js','/places/','/sitemap.xml'])assert.equal((await fetch(base+route)).status,200,route+' without the service');
  const gone=await fetch(base+'/api/v1/family');assert.ok([502,503].includes(gone.status),'API without the service: '+gone.status);
  assert.equal((await fetch(base+'/healthz')).ok,false);
});
