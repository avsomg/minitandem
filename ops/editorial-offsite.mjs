// Daily copy of the private editorial state from the Mac to our own server, run by its own launchd agent at 06:50.
//   1. node editorial/backup.mjs create --to=<staging>/<date>   (queue + editorial files, no family data; refuses while a job is leased)
//   2. node editorial/backup.mjs verify <staging>/<date>
//   3. tar -czf <staging>/editorial-<date>.tar.gz, then the unpacked folder is removed
//   4. sha256, then the archive is streamed to `ssh ... backup <date> <sha256>` (ops/drop.sh checks the sum, keeps the newest 14)
//   5. the local archive is removed. The Mac keeps nothing: its disk is nearly full and the server holds the copies.
// On any failure the script says which step failed, exits 1 and leaves nothing in the staging folder.
// `--dry-run` does steps 1 to 4 up to the checksum and keeps the archive (it prints path, size and sha256); nothing leaves the Mac.
// Other options: --staging=DIR (default ~/Backups/minitandem-editorial/staging, outside the repository), --date=YYYY-MM-DD (default: today in Zurich).
//
// Restore: tar -xzf editorial-DATE.tar.gz -C SOMEWHERE; node editorial/backup.mjs verify SOMEWHERE/DATE;
//          node editorial/backup.mjs restore SOMEWHERE/DATE --to=NEW_EMPTY_FOLDER   (docs/betrieb.md)
//
// Environment (all optional; see ops/drop-client.mjs for the connection settings):
//   MINITANDEM_OFFSITE_STAGING, MINITANDEM_TAR (default /usr/bin/tar), OFFSITE_BACKUP_SCRIPT (default editorial/backup.mjs)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runDropWithRetry} from './drop-client.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.join(here,'..');

class StepError extends Error{constructor(step,message){super(message);this.step=step;}}
const option=(args,name)=>args.find(arg=>arg.startsWith(name+'='))?.slice(name.length+1);
const stamp=()=>new Date().toISOString();
const log=text=>console.log(`${stamp()} editorial-offsite: ${text}`);
const tail=text=>String(text||'').trim().split('\n').filter(line=>!/ExperimentalWarning|--trace-warnings/.test(line)).slice(-6).join('\n');
const zurichDate=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);

function node(step,script,args,timeoutMs){
  const run=spawnSync(process.execPath,[script,...args],{cwd:repo,encoding:'utf8',timeout:timeoutMs,maxBuffer:32_000_000,env:process.env});
  if(run.error)throw new StepError(step,run.error.message);
  if(run.status!==0)throw new StepError(step,`exit ${run.status}\n${tail(run.stderr||run.stdout)}`);
  return run.stdout;
}

const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
function takeLock(staging){
  const lock=path.join(staging,'.lock');
  for(let attempt=0;attempt<2;attempt++){
    try{fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'pid'),String(process.pid));return ()=>fs.rmSync(lock,{recursive:true,force:true});}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let pid=0;try{pid=Number(fs.readFileSync(path.join(lock,'pid'),'utf8'));}catch{}
      if(pid&&alive(pid))throw new StepError('lock',`another run is active (pid ${pid})`);
      fs.rmSync(lock,{recursive:true,force:true});
    }
  }
  throw new StepError('lock','could not take the lock');
}

// Only what this script itself makes: leftovers of a run that was killed
const LEFTOVER=/^(?:\d{4}-\d{2}-\d{2}(?:\.tmp-[0-9a-f-]+)?|editorial-\d{4}-\d{2}-\d{2}\.tar\.gz(?:\.part)?)$/;
const sweep=staging=>{for(const name of fs.readdirSync(staging))if(LEFTOVER.test(name))fs.rmSync(path.join(staging,name),{recursive:true,force:true});};

function sha256(file){
  const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1<<20);
  try{for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;)hash.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}
  return hash.digest('hex');
}

export async function offsite(args=process.argv.slice(2),env=process.env){
  const dryRun=args.includes('--dry-run');
  const day=option(args,'--date')||zurichDate(new Date());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new StepError('arguments',`not a date: ${day}`);
  const staging=path.resolve(option(args,'--staging')||env.MINITANDEM_OFFSITE_STAGING||path.join(os.homedir(),'Backups','minitandem-editorial','staging'));
  if(staging===repo||staging.startsWith(repo+path.sep))throw new StepError('arguments','the staging folder must be outside the repository');
  const backupScript=env.OFFSITE_BACKUP_SCRIPT||path.join(repo,'editorial','backup.mjs');
  const tar=env.MINITANDEM_TAR||(fs.existsSync('/usr/bin/tar')?'/usr/bin/tar':'tar');
  const folder=path.join(staging,day),archive=path.join(staging,`editorial-${day}.tar.gz`),part=archive+'.part';

  fs.mkdirSync(staging,{recursive:true,mode:0o700});
  const release=takeLock(staging);
  let keepArchive=false;
  try{
    sweep(staging);

    log(`step 1/5: creating the backup in ${folder}`);
    node('backup create',backupScript,['create',`--to=${folder}`],20*60000);

    log('step 2/5: verifying it');
    node('backup verify',backupScript,['verify',folder],10*60000);

    log('step 3/5: packing it');
    const packed=spawnSync(tar,['-czf',part,'-C',staging,day],{encoding:'utf8',timeout:15*60000,env:{...process.env,COPYFILE_DISABLE:'1'}});
    if(packed.error||packed.status!==0)throw new StepError('pack',packed.error?.message||tail(packed.stderr)||`tar exit ${packed.status}`);
    fs.renameSync(part,archive);
    fs.rmSync(folder,{recursive:true,force:true});

    log('step 4/5: checksum');
    const bytes=fs.statSync(archive).size;
    if(bytes===0)throw new StepError('pack','the archive is empty');
    const sum=sha256(archive);

    if(dryRun){
      keepArchive=true;
      log(`dry run: stopped before the upload. archive ${archive}, ${bytes} bytes, sha256 ${sum}`);
      return {dryRun:true,date:day,archive,bytes,sha256:sum};
    }

    log(`step 5/5: sending ${bytes} bytes to the server`);
    const result=await runDropWithRetry(`backup ${day} ${sum}`,{inputFile:archive,timeoutMs:2*3600000,env},[60000]);
    if(!result.ok)throw new StepError('upload',`ssh status ${result.status} after ${result.attempts} attempt(s): ${result.stderr}`);
    log(`done: ${day} ${bytes} bytes sha256 ${sum}; server: ${result.stdout.trim()}`);
    return {dryRun:false,date:day,bytes,sha256:sum,server:result.stdout.trim()};
  }finally{
    fs.rmSync(folder,{recursive:true,force:true});
    fs.rmSync(part,{force:true});
    if(!keepArchive)fs.rmSync(archive,{force:true});
    release();
  }
}

if(process.argv[1]&&(()=>{try{return fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url);}catch{return false;}})()){
  try{await offsite();}
  catch(error){
    console.error(`${stamp()} editorial-offsite: FAILED at step "${error.step||'unexpected'}": ${error.message}`);
    process.exit(1);
  }
}
