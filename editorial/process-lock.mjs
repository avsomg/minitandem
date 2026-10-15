// A lock between processes on one machine, for the editorial cycle (editorial/cycle.mjs) and the daily off-site copy (ops/editorial-offsite.mjs).
//
// One file. It holds who owns it: {schema, pid, token, startedAt, processStart}. The owner writes that record to a temporary file first and
// then links the finished file into place (link fails when the name is taken), so the lock never exists without its owner and two processes
// that start together cannot both get it.
//
// Stale or not is decided by the process, never by the clock alone:
//   - the owner's pid is not alive                                         -> stale
//   - the pid is alive but is another process now (its start time differs
//     from the one recorded, or it started after the lock was written)     -> stale (the pid was reused)
//   - the pid is alive and is the same process                             -> held, however long that takes (a sleeping Mac, a long batch)
// Only when the start time of the owner was not recorded (ps unavailable) is the pid not enough to tell the same process from a reused pid;
// then a lock older than UNVERIFIED_MAX_AGE_MS counts as stale. A run is bounded to a few hours by its step timeouts, so a day is far beyond it.
//
// A stale lock is removed under a marker file that only one contender can create for that very lock, after the file has been read again and
// found unchanged; a lock that was replaced in the meantime is never removed. Release removes the file only when its token is still ours.
//
// Older versions used a directory (cycle: workflow-state/cycle/lock/owner.json, off-site: staging/.lock/pid). `legacyDirectory` makes this version
// respect a live old-style owner and remove a dead or ownerless one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const UNVERIFIED_MAX_AGE_MS=24*3600000;
const LEGACY_MAX_AGE_MS=3*3600000;       // what the old code allowed a live owner (its runs are bounded well below that)
const LEGACY_FRESH_MS=60000;             // an old-style directory without an owner this young may still be being written by its creator
const CORRUPT_MS=10*60000;               // a lock file that cannot be read as a record is left alone this long (it is never half-written by this code)
const REAP_ABANDONED_MS=2*60000;         // a marker of a remover that died
const START_TOLERANCE_MS=10000;          // ps reports start times in whole seconds, and some systems derive them from a boot time that wobbles
const TEMP_MAX_AGE_MS=3600000;

export const pidAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};

// When the process with this pid started, as an ISO string, or null when that cannot be told. UTC and the C locale: the same process gives the same
// answer whatever time zone the asking process runs in (launchd sets one for the cycle, a terminal may have another).
export function processStart(pid){
  const ps=fs.existsSync('/bin/ps')?'/bin/ps':'ps';
  const run=spawnSync(ps,['-o','lstart=','-p',String(pid)],{encoding:'utf8',timeout:5000,env:{...process.env,LC_ALL:'C',TZ:'UTC'}});
  if(run.error||run.status!==0)return null;
  const text=String(run.stdout).trim().replace(/\s+/g,' ');
  const ms=text?Date.parse(`${text} UTC`):NaN;
  return Number.isFinite(ms)?new Date(ms).toISOString():null;
}

const TOKEN=/^[A-Za-z0-9-]{8,64}$/;
const read=file=>{try{return {raw:fs.readFileSync(file,'utf8')};}catch(error){if(error.code==='ENOENT')return null;throw error;}};
function parse(raw){
  try{
    const value=JSON.parse(raw);
    if(value?.schema===1&&Number.isInteger(value.pid)&&value.pid>0&&TOKEN.test(value.token??'')&&Number.isFinite(Date.parse(value.startedAt)))return value;
  }catch{}
  return null;
}
// What identifies one lock: its token, or a hash of the bytes when it cannot be read as a record.
const keyOf=raw=>parse(raw)?.token??'x'+crypto.createHash('sha256').update(raw).digest('hex').slice(0,16);
const mtime=file=>{try{return fs.statSync(file).mtimeMs;}catch{return null;}};
const remove=file=>{try{fs.rmSync(file,{recursive:true,force:true});}catch{}};

function judge(record,ctx){
  if(!ctx.alive(record.pid))return 'stale';
  const live=ctx.startOf(record.pid);
  if(record.processStart){
    if(live&&Math.abs(Date.parse(live)-Date.parse(record.processStart))>START_TOLERANCE_MS)return 'stale';
    return 'held';
  }
  if(live&&Date.parse(live)>Date.parse(record.startedAt)+START_TOLERANCE_MS)return 'stale';
  return ctx.clock()-Date.parse(record.startedAt)>UNVERIFIED_MAX_AGE_MS?'stale':'held';
}

// The directory of the older versions. Returns who holds it, or null when there is nothing (left) to respect.
function legacyHolder(directory,ctx){
  let stat;
  try{stat=fs.statSync(directory);}catch{return null;}
  if(!stat.isDirectory())return null;
  let pid=0,startedMs=NaN;
  const owner=read(path.join(directory,'owner.json'))?.raw,plain=read(path.join(directory,'pid'))?.raw;
  try{const value=JSON.parse(owner);pid=Number(value.pid);startedMs=Date.parse(value.startedAt);}catch{}
  if(!(pid>0)&&plain!==undefined)pid=Number(String(plain).trim());
  const age=ctx.clock()-(Number.isFinite(startedMs)?startedMs:stat.mtimeMs);
  if(Number.isInteger(pid)&&pid>0){if(ctx.alive(pid)&&age<LEGACY_MAX_AGE_MS)return {pid,legacy:true};}
  else if(age<LEGACY_FRESH_MS)return {pid:0,legacy:true};
  remove(directory);
  return null;
}

// Temporary files and markers that a killed process left next to the lock
function tidy(file,ctx){
  const base=path.basename(file);
  try{
    for(const name of fs.readdirSync(path.dirname(file))){
      const kind=name.startsWith(base+'.tmp-')?TEMP_MAX_AGE_MS:name.startsWith(base+'.reap-')?REAP_ABANDONED_MS:null;
      const full=path.join(path.dirname(file),name),time=kind===null?null:mtime(full);
      if(time!==null&&ctx.clock()-time>kind)remove(full);
    }
  }catch{}
}

// Removes the stale lock `key`, but only that one: the marker lets a single contender do it, and the file is read again under the marker.
// Returns true when the name is free now, false when somebody else is doing it or a new lock took the place.
function reap(file,key,ctx){
  const marker=`${file}.reap-${key}`;
  for(let attempt=0;;attempt++){
    try{fs.writeFileSync(marker,String(ctx.pid),{flag:'wx',mode:0o600});break;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      // somebody else is removing this very lock; if that process died, its marker ages out and this one takes over
      const time=mtime(marker);
      if(attempt>0||time!==null&&ctx.clock()-time<=REAP_ABANDONED_MS)return false;
      remove(marker);
    }
  }
  try{
    ctx.hooks.beforeReap?.();
    const now=read(file);
    if(!now)return true;
    if(keyOf(now.raw)!==key)return false;
    try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    return true;
  }finally{remove(marker);}
}

function release(file,token){
  const seen=read(file);
  if(!seen||parse(seen.raw)?.token!==token)return false;
  try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  return true;
}

// takeProcessLock(file, options) -> {ok:true, token, release()} when this process owns the lock now,
//                                   {ok:false, holder} when somebody else does (holder: their record, {pid,legacy:true}, or null when unknown).
// release() returns false when the lock was no longer ours (it is then left exactly as it is).
// Options are for tests: pid, alive(pid), startOf(pid), clock(), token, hooks:{beforeLink(), beforeReap()}; legacyDirectory is the old-style directory.
export function takeProcessLock(file,options={}){
  const ctx={pid:process.pid,alive:pidAlive,startOf:processStart,clock:Date.now,hooks:{},legacyDirectory:null,...options};
  const token=options.token||crypto.randomUUID();
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  if(ctx.legacyDirectory){const holder=legacyHolder(ctx.legacyDirectory,ctx);if(holder)return {ok:false,holder};}
  tidy(file,ctx);
  const record={schema:1,pid:ctx.pid,token,startedAt:new Date(ctx.clock()).toISOString(),processStart:ctx.startOf(ctx.pid)};
  const temp=`${file}.tmp-${ctx.pid}-${token.slice(0,8)}`;
  fs.writeFileSync(temp,JSON.stringify(record)+'\n',{flag:'wx',mode:0o600});
  try{
    ctx.hooks.beforeLink?.();
    for(let attempt=0;attempt<4;attempt++){
      try{fs.linkSync(temp,file);return {ok:true,token,release:()=>release(file,token)};}
      catch(error){if(error.code!=='EEXIST')throw error;}
      const seen=read(file);
      if(!seen)continue;
      const holder=parse(seen.raw);
      if(holder){
        if(judge(holder,ctx)==='held')return {ok:false,holder};
      }else{
        const time=mtime(file);
        if(time===null)continue;
        if(ctx.clock()-time<CORRUPT_MS)return {ok:false,holder:null};
      }
      if(!reap(file,keyOf(seen.raw),ctx))return {ok:false,holder};
    }
    return {ok:false,holder:null};
  }finally{remove(temp);}
}
