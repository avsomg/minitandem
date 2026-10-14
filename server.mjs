import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadCatalog, qualityReport} from './editorial/quality.mjs';
import {JobQueue} from './editorial/jobs.mjs';
import {operationsReport} from './editorial/operations-report.mjs';
import {SITE_ORIGIN} from './site.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const stateDir=process.env.MINITANDEM_STATE_DIR||path.join(root,'server-state');
const dataFile=path.join(stateDir,'families.json');
const correctionDir=process.env.MINITANDEM_CORRECTION_DIR||path.join(root,'editorial/corrections');
const MAX_PENDING_CORRECTIONS=Number(process.env.MINITANDEM_MAX_PENDING_CORRECTIONS||500);
const queueFile=process.env.MINITANDEM_QUEUE_FILE||path.join(root,'editorial/workflow-state/jobs.sqlite');
const catalog=loadCatalog();
const allowed=new Map(catalog.ACTIVITIES.map(a=>[a.id,a]));
const statuses=new Set(['','discuss','contact','waiting','booked','visited','skip']);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const randomToken=()=>crypto.randomBytes(32).toString('base64url');
const origins=new Set([SITE_ORIGIN,'http://localhost:8787','http://127.0.0.1:8787',...(process.env.MINITANDEM_ORIGINS||'').split(',').filter(Boolean)]);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.txt':'text/plain; charset=utf-8','.xml':'application/xml','.md':'text/markdown; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};

function readDb(){
  try{return JSON.parse(fs.readFileSync(dataFile,'utf8'));}
  // A damaged file is the server's problem, not the caller's: it must not look like a bad request (a SyntaxError would be answered with 400).
  catch(error){if(error.code==='ENOENT')return {schema:1,adminHash:null,families:{}};throw Error('State file unreadable: '+dataFile,{cause:error});}
}
function writeAtomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  fs.renameSync(temp,file);
}
function saveDb(db){
  if(fs.existsSync(dataFile)){
    const backup=path.join(stateDir,'backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex')+'.json');
    fs.copyFileSync(dataFile,backup);
    const backups=fs.readdirSync(stateDir).filter(name=>name.startsWith('backup-')&&name.endsWith('.json')).sort();
    for(const name of backups.slice(0,-20))fs.unlinkSync(path.join(stateDir,name));
  }
  writeAtomic(dataFile,db);
}
function cleanProfile(raw){
  if(!raw||raw.version!==1||!Array.isArray(raw.favorites)||!raw.notes||typeof raw.notes!=='object'||!raw.statuses||typeof raw.statuses!=='object')throw Error('Invalid family profile');
  const notes=Object.fromEntries(Object.entries(raw.notes).filter(([id,value])=>allowed.has(id)&&typeof value==='string').map(([id,value])=>[id,value.slice(0,10000)]));
  const selected=Object.fromEntries(Object.entries(raw.statuses).filter(([id,value])=>allowed.has(id)&&statuses.has(value)));
  return {version:1,favorites:[...new Set(raw.favorites.filter(id=>typeof id==='string'&&allowed.has(id)))],notes,statuses:selected,
    visits:catalog.MinitandemPlanning.validateVisits(raw.visits,allowed),tracked:catalog.MinitandemPlanning.validateTracked(raw.tracked,allowed),
    age:Number.isFinite(raw.age)&&raw.age>=0&&raw.age<=18?raw.age:null,
    origin:typeof raw.origin==='string'?raw.origin.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,80):''};
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('JSON required');
  let size=0,chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>1_000_000)throw Error('Request too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function auth(req,db,admin=false){
  const token=/^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.authorization||'')?.[1];
  if(!token)return null;
  const digest=hash(token);
  return admin?(digest===db.adminHash?'admin':null):(db.families[digest]?digest:null);
}
function corrections(){
  if(!fs.existsSync(correctionDir))return [];
  return fs.readdirSync(correctionDir).filter(name=>/^[a-f0-9]{20}\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(correctionDir,name),'utf8'))).sort((a,b)=>b.importedAt.localeCompare(a.importedAt));
}
function staticFile(req,res,pathname){
  if(pathname.split('/').some(segment=>segment.startsWith('.')||segment==='..'))return json(res,404,{error:'Not found'});
  const editorial=pathname==='/admin'||pathname==='/admin.js'||pathname==='/admin.css';
  let file=editorial?path.join(root,'editorial',pathname==='/admin'?'admin.html':pathname.slice(1)):path.join(root,'.publish',pathname==='/'?'index.html':pathname.slice(1));
  const base=editorial?path.join(root,'editorial'):path.join(root,'.publish');
  if(!path.resolve(file).startsWith(path.resolve(base)+path.sep)||!fs.existsSync(file))return json(res,404,{error:'Not found'});
  // A folder is served by its index.html, as static hosts do (/places/, /places/<id>/). Without the trailing slash the browser
  // is sent to the slashed path first, so the page's relative links resolve; the target is rebuilt from segments, never //host.
  if(!editorial&&fs.statSync(file).isDirectory()){
    if(!pathname.endsWith('/')){res.writeHead(301,{Location:'/'+pathname.split('/').filter(Boolean).join('/')+'/'});return res.end();}
    file=path.join(file,'index.html');
  }
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{error:'Not found'});
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':pathname==='/admin'||pathname==='/admin.js'?'no-store':'public, max-age=0, must-revalidate','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://wmts.geo.admin.ch; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(file).pipe(res);
}
// A request the caller can fix: malformed JSON, an error from the planning and exchange modules (they carry a code such as
// 'plan.invalidVisit' or 'report.source'), or one of this file's own English messages. Operating-system errors also carry
// a string code (ENOENT, EACCES), so the code must have the dotted module form to count; those stay a 500.
const isClientError=error=>error instanceof SyntaxError||(typeof error?.code==='string'&&/^[a-z]+\.[A-Za-z]+$/.test(error.code))||/^(Invalid|JSON required|Request too large)/.test(error?.message||'');
export function createServer(){
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const origin=req.headers.origin;
    if(origin&&origins.has(origin)){
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods','GET, PUT, POST, OPTIONS');
    }
    if(req.method==='OPTIONS')return json(res,origin&&origins.has(origin)?204:403,{});
    if(origin&&!origins.has(origin))return json(res,403,{error:'Origin not allowed'});
    const pathname=new URL(req.url,'http://localhost').pathname;
    // For container health checks and uptime monitors: answers from memory, reads no state and needs no key.
    if(pathname==='/healthz'&&['GET','HEAD'].includes(req.method)){
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      return res.end(req.method==='HEAD'?undefined:JSON.stringify({status:'ok',records:allowed.size}));
    }
    if(!pathname.startsWith('/api/'))return ['GET','HEAD'].includes(req.method)?staticFile(req,res,pathname):json(res,405,{error:'Method not allowed'});
    try{
      // Inside the try: a damaged state file must end in a 500 for this request, not in an unhandled rejection that stops the process.
      const db=readDb();
      if(pathname==='/api/v1/family'){
        const key=auth(req,db);if(!key)return json(res,401,{error:'Invalid family key'});
        const family=db.families[key];
        if(req.method==='GET')return json(res,200,{revision:family.revision,profile:family.profile});
        if(req.method!=='PUT')return json(res,405,{error:'Method not allowed'});
        const submitted=await body(req);
        const fresh=readDb(),currentKey=auth(req,fresh);
        if(!currentKey)return json(res,401,{error:'Invalid family key'});
        const current=fresh.families[currentKey];
        if(!Number.isInteger(submitted.revision)||submitted.revision!==current.revision)return json(res,409,{error:'Revision changed',revision:current.revision,profile:current.profile});
        const profile=cleanProfile(submitted.profile);
        current.profile=profile;current.revision++;current.updatedAt=new Date().toISOString();saveDb(fresh);
        return json(res,200,{revision:current.revision,profile});
      }
      if(pathname==='/api/v1/corrections'&&req.method==='POST'){
        if(!auth(req,db))return json(res,401,{error:'Invalid family key'});
        const report=catalog.MinitandemExchange.report(await body(req),allowed);
        const id=hash(JSON.stringify(report)).slice(0,20),file=path.join(correctionDir,id+'.json');
        if(fs.existsSync(file))return json(res,200,{id,duplicate:true,status:'pending-review'});
        // Keys go only to families the owner knows, but a leaked key must not be able to fill the disk.
        if(corrections().filter(item=>item.status==='pending-review').length>=MAX_PENDING_CORRECTIONS)return json(res,429,{error:'Too many corrections are waiting for review'});
        writeAtomic(file,{id,status:'pending-review',assignedTo:null,importedAt:new Date().toISOString(),report});
        return json(res,201,{id,duplicate:false,status:'pending-review'});
      }
      if(pathname==='/api/v1/admin/queue'&&req.method==='GET'){
        if(!auth(req,db,true))return json(res,401,{error:'Invalid editor key'});
        const sources=JSON.parse(fs.readFileSync(path.join(root,'editorial/source-watch.json'),'utf8')).sources;
        const monitorFile=path.join(root,'editorial/monitor-state.json');
        const monitor=fs.existsSync(monitorFile)?JSON.parse(fs.readFileSync(monitorFile,'utf8')):null;
        const date=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
        const quality=qualityReport(loadCatalog().ACTIVITIES,sources,date,monitor);
        return json(res,200,{quality:{records:quality.records,stale:quality.stale,withoutMonitor:quality.withoutMonitor,sourceAffected:quality.sourceAffected,queue:quality.queue.slice(0,50)},corrections:corrections()});
      }
      if(pathname==='/api/v1/admin/operations'&&req.method==='GET'){
        if(!auth(req,db,true))return json(res,401,{error:'Invalid editor key'});
        if(!fs.existsSync(queueFile))return json(res,503,{error:'Editorial queue is not initialized'});
        const queue=new JobQueue(queueFile,{readOnly:true});
        try{return json(res,200,operationsReport(queue));}finally{queue.close();}
      }
      if(pathname.startsWith('/api/v1/admin/corrections/')&&req.method==='POST'){
        if(!auth(req,db,true))return json(res,401,{error:'Invalid editor key'});
        const id=pathname.split('/').at(-1);
        if(!/^[a-f0-9]{20}$/.test(id))return json(res,404,{error:'Not found'});
        const file=path.join(correctionDir,id+'.json');
        if(!fs.existsSync(file))return json(res,404,{error:'Not found'});
        const update=await body(req);
        if(!['pending-review','ready-to-apply','rejected'].includes(update.status))return json(res,400,{error:'Invalid status'});
        const current=JSON.parse(fs.readFileSync(file,'utf8'));
        writeAtomic(file,{...current,status:update.status,reviewedAt:new Date().toISOString()});
        return json(res,200,{id,status:update.status,catalogChanged:false});
      }
      return json(res,404,{error:'Not found'});
    }catch(error){
      if(isClientError(error))return json(res,400,{error:error.message});
      console.error(error);return json(res,500,{error:'Server error'});
    }
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const command=process.argv[2]||'start';
  if(command==='new-family'||command==='new-admin'){
    const db=readDb(),token=randomToken();
    if(command==='new-admin')db.adminHash=hash(token);
    else db.families[hash(token)]={revision:0,profile:null,updatedAt:null};
    saveDb(db);console.log(token);
  }else if(command==='start'){
    const host=process.env.MINITANDEM_HOST||'127.0.0.1',port=Number(process.env.MINITANDEM_PORT||8787);
    createServer().listen(port,host,()=>console.log(`Minitandem Mac service: http://${host}:${port}`));
  }else throw Error('Use start, new-family or new-admin');
}
