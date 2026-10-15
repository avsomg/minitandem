// Runs one editorial cycle exactly as `node editorial/cycle.mjs` does (same arguments, same output, same exit code) and then
// tells the server that it ran: a small heartbeat over the restricted drop key (ops/drop-client.mjs, ops/drop.sh). The server mails the owner
// when no heartbeat arrives for hours or the last one reports a failure (ops/cycle-watch.sh). launchd starts this file instead of cycle.mjs.
//
// The heartbeat holds counts, step names and card ids, no card text and no quotes. A heartbeat that cannot be sent is logged and changes nothing:
// the exit code is always the cycle's own. `--status` and `--dry-run` do not run a cycle and send nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runDropWithRetry} from './drop-client.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const editorial=path.join(here,'..','editorial');
const cycleScript=path.join(editorial,'cycle.mjs');
const latestFile=path.join(editorial,'workflow-state','cycle','latest.json');

// Text that goes into the heartbeat: plain characters only, so the server can read it with grep and sed and print it in a mail.
const clean=(value,max=120)=>String(value??'').replace(/[^A-Za-z0-9 ,.:;()_/+-]/g,'?').replace(/\s+/g,' ').trim().slice(0,max);

// `record` is editorial/workflow-state/cycle/latest.json as the cycle wrote it; it counts only when this run wrote it
// (its startedAt is not older than the moment this script started the cycle).
export function buildHeartbeat({exit,record=null,startedMs,now=new Date()}){
  const mine=record&&Date.parse(record.startedAt)>=startedMs-1000?record:null;
  const skipped=mine?.skipped?clean(mine.skipped,60):null;
  const failedSteps=(mine?.failedSteps||[]).slice(0,12).map(step=>clean(step,40));
  const attention=(mine?.changes?.attention||[]).map(job=>clean(job.card,60)).filter(Boolean);
  const reasons=[];
  if(mine?.blocked)reasons.push('blocked: '+clean(mine.blocked,120));
  if(failedSteps.length)reasons.push('failed steps: '+failedSteps.join(', '));
  if(attention.length)reasons.push('attention: '+attention.slice(0,5).join(', ')+(attention.length>5?` and ${attention.length-5} more`:''));
  if(mine?.changes?.circuitOpened?.length)reasons.push('circuit breaker opened');
  if(mine?.changes?.loginUnavailable?.length)reasons.push('Claude login unavailable');
  if(mine?.batch?.stopReason)reasons.push('batch stopped: '+clean(mine.batch.stopReason,40));
  return {
    at:now.toISOString(),
    exit,
    // ok:false is what the cycle itself calls "needs the owner" (the condition of its Mac banner: cycle.mjs needsOwner), as well as a non-zero exit.
    // A batch lost to a missing Claude login exits with 0, and still must reach the owner.
    ok:exit===0&&reasons.length===0,
    paused:Boolean(skipped&&/^paused/.test(skipped)),
    skipped,
    startedAt:new Date(startedMs).toISOString(),
    seconds:Math.max(0,Math.round((now.getTime()-startedMs)/1000)),
    daily:Boolean(mine?.daily),
    failedSteps,
    needsOwner:{count:reasons.length,text:clean(reasons.join('; '),300)},
    approvedUpdates:(mine?.approvedUpdates||[]).length,
    jobsRun:(mine?.batch?.jobs||[]).length,
    record:Boolean(mine)
  };
}

const readLatest=()=>{try{return JSON.parse(fs.readFileSync(latestFile,'utf8'));}catch{return null;}};
const stamp=()=>new Date().toISOString();

async function main(){
  const args=process.argv.slice(2);
  const startedMs=Date.now();
  const child=spawn(process.execPath,[cycleScript,...args],{stdio:'inherit'});
  for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));
  const exit=await new Promise(resolve=>{
    child.on('error',error=>{console.error(`${stamp()} cycle-run: could not start the cycle: ${error.message}`);resolve(127);});
    child.on('close',(code,signal)=>resolve(code??(signal?128+(os.constants.signals[signal]||0):1)));
  });
  if(args.includes('--status')||args.includes('--dry-run'))return exit;
  try{
    const heartbeat=buildHeartbeat({exit,record:readLatest(),startedMs});
    const result=await runDropWithRetry('heartbeat',{input:JSON.stringify(heartbeat)+'\n',timeoutMs:60000});
    if(result.ok)console.error(`${stamp()} cycle-run: heartbeat sent (exit ${exit}, attempt ${result.attempts})`);
    else console.error(`${stamp()} cycle-run: heartbeat NOT sent after ${result.attempts} attempt(s): ssh status ${result.status}, ${result.stderr}`);
  }catch(error){
    console.error(`${stamp()} cycle-run: heartbeat NOT sent: ${error.message}`);
  }
  return exit;
}

if(process.argv[1]&&(()=>{try{return fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url);}catch{return false;}})()){
  process.exit(await main());
}
