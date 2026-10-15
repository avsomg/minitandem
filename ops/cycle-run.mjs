// Runs one editorial cycle exactly as `node editorial/cycle.mjs` does (same arguments, same output, same exit code) and then
// tells the server that it ran: a small heartbeat over the restricted drop key (ops/drop-client.mjs, ops/drop.sh). The server mails the owner
// when no heartbeat arrives for hours or the last one reports a failure (ops/cycle-watch.sh). launchd starts this file instead of cycle.mjs.
//
// The heartbeat holds counts, step names and card ids, no card text and no quotes. A heartbeat that cannot be sent is logged and changes nothing:
// the exit code is always the cycle's own. `--status` and `--dry-run` do not run a cycle and send nothing.
//
// Every invocation gets a run id, passed to the cycle in MINITANDEM_CYCLE_RUN_ID; the cycle writes it into its receipt (latest.json). A receipt
// counts only when it carries this id. A run that exits with 0 and has no such receipt is reported as ok:false, reason "no-receipt".
import crypto from 'node:crypto';
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

// `record` is editorial/workflow-state/cycle/latest.json as the cycle wrote it; it counts only when it carries `runId`, the id of this invocation.
// What the heartbeat says (ok, reason):
//   ok:true,  reason:null          the run finished and nothing needs the owner (a pause has paused:true, another cycle running has skipped:"...": both alive and well)
//   ok:false, reason:"exit"        the cycle exited with a non-zero code
//   ok:false, reason:"no-receipt"  the cycle exited with 0 but this invocation has no receipt: missing, unreadable, from an earlier run or from an overlapping one
//   ok:false, reason:"needs-owner" the receipt says something needs the owner (the condition of the cycle's Mac banner: needsOwner in editorial/cycle.mjs)
export function buildHeartbeat({exit,record=null,startedMs,now=new Date(),runId=null}){
  const mine=runId&&record&&record.runId===runId?record:null;
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
  // A batch lost to a missing Claude login exits with 0, and still must reach the owner.
  const reason=exit!==0?'exit':!mine?'no-receipt':reasons.length?'needs-owner':null;
  return {
    at:now.toISOString(),
    exit,
    ok:reason===null,
    reason,
    paused:Boolean(skipped&&/^paused/.test(skipped)),
    skipped,
    runId:runId?clean(runId,64):null,
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
  const runId=crypto.randomUUID();
  const child=spawn(process.execPath,[cycleScript,...args],{stdio:'inherit',env:{...process.env,MINITANDEM_CYCLE_RUN_ID:runId}});
  for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));
  const exit=await new Promise(resolve=>{
    child.on('error',error=>{console.error(`${stamp()} cycle-run: could not start the cycle: ${error.message}`);resolve(127);});
    child.on('close',(code,signal)=>resolve(code??(signal?128+(os.constants.signals[signal]||0):1)));
  });
  if(args.includes('--status')||args.includes('--dry-run'))return exit;
  try{
    const heartbeat=buildHeartbeat({exit,record:readLatest(),startedMs,runId});
    if(heartbeat.reason==='no-receipt')console.error(`${stamp()} cycle-run: the cycle exited with 0 but left no receipt of run ${runId} (editorial/workflow-state/cycle/latest.json is missing, unreadable or from another run)`);
    const result=await runDropWithRetry('heartbeat',{input:JSON.stringify(heartbeat)+'\n',timeoutMs:60000});
    if(result.ok)console.error(`${stamp()} cycle-run: heartbeat sent (exit ${exit}, ${heartbeat.ok?'ok':'reason '+heartbeat.reason}, attempt ${result.attempts})`);
    else console.error(`${stamp()} cycle-run: heartbeat NOT sent after ${result.attempts} attempt(s): ssh status ${result.status}, ${result.stderr}`);
  }catch(error){
    console.error(`${stamp()} cycle-run: heartbeat NOT sent: ${error.message}`);
  }
  return exit;
}

if(process.argv[1]&&(()=>{try{return fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url);}catch{return false;}})()){
  process.exit(await main());
}
