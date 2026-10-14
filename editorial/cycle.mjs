// One editorial cycle for a timer: the routine a scheduled chat used to run,
// without a model in the loop. Models are called only by agent-run.mjs, per job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {PROJECT_ID} from './project-id.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const zurich=(now,options)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',...options}).format(now);
export const localDate=now=>zurich(now,{year:'numeric',month:'2-digit',day:'2-digit'});
export const localHour=now=>Number(zurich(now,{hour:'2-digit',hourCycle:'h23'}));
const readJson=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;
const writeJson=(file,value)=>{
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=`${file}.tmp-${process.pid}`;fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);
};

export function readPolicy(base=here){
  const policy=readJson(path.join(base,'cycle-policy.json'),null);
  if(policy?.schema!==1||policy.project!==PROJECT_ID||!Number.isInteger(policy.limitPerRun)||policy.limitPerRun<1||policy.limitPerRun>4||
    !Number.isInteger(policy.maxJobsPerDay)||policy.maxJobsPerDay<1||!Array.isArray(policy.leadRoles)||!policy.leadRoles.length||
    policy.leadRoles.some(role=>!['verify','search','arbitrate','editor'].includes(role))||
    !Number.isInteger(policy.dailyAfterHour)||!Array.isArray(policy.codexAutomationIds))throw Error('Invalid cycle policy');
  return policy;
}

// The daily maintenance pass runs once per local day; other runs rotate the role that goes first.
export function plan(state,policy,now,claimedToday){
  const today=localDate(now),daily=state.lastDailyOn!==today&&localHour(now)>=policy.dailyAfterHour;
  const limit=Math.max(0,Math.min(policy.limitPerRun,policy.maxJobsPerDay-claimedToday));
  const role=daily?null:policy.leadRoles[(state.roleTurn||0)%policy.leadRoles.length];
  const minutes=n=>n*60000,steps=[];
  if(daily)for(const name of ['monitor','review','discover-events','canton-audit'])steps.push({label:name,args:[`editorial/${name}.mjs`],timeoutMs:minutes(15)});
  if(daily)steps.push({label:'work-packets',args:['editorial/work-packets.mjs','--no-semantic'],timeoutMs:minutes(10)});
  steps.push({label:'sync',args:['editorial/workflow.mjs','sync'],timeoutMs:minutes(10)});
  if(limit>0)steps.push({label:'batch',needsSync:true,timeoutMs:minutes(45),
    args:['editorial/agent-run.mjs',...(role?[`--role=${role}`]:[]),'--chain',`--limit=${limit}`]});
  if(daily)steps.push({label:'backup',needsSync:true,args:['editorial/workflow.mjs','backup'],timeoutMs:minutes(10)});
  for(const name of ['external-pipeline','external-review'])steps.push({label:name,needsSync:true,args:[`editorial/${name}.mjs`],timeoutMs:minutes(10)});
  steps.push({label:'report',needsSync:true,args:['editorial/workflow.mjs','report'],timeoutMs:minutes(10)});
  return {today,daily,role,limit,capReached:limit===0,steps};
}

// The old and the new schedule must never work the queue at the same time.
export function codexSchedules(policy,home=os.homedir()){
  const file=path.join(home,'.codex','sqlite','codex-dev.db');
  if(!policy.codexAutomationIds.length||!fs.existsSync(file))return {checked:false,active:[]};
  let db;
  try{
    db=new DatabaseSync(file,{readOnly:true});
    const marks=policy.codexAutomationIds.map(()=>'?').join(',');
    const rows=db.prepare(`SELECT id,status FROM automations WHERE id IN (${marks})`).all(...policy.codexAutomationIds);
    return {checked:true,active:rows.filter(row=>row.status!=='PAUSED').map(row=>row.id)};
  }catch{return {checked:false,active:[]};}
  finally{db?.close();}
}

const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
export function acquireLock(directory,now=Date.now()){
  const lock=path.join(directory,'lock'),owner=path.join(lock,'owner.json');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  for(let attempt=0;attempt<2;attempt++){
    try{fs.mkdirSync(lock);writeJson(owner,{pid:process.pid,startedAt:new Date(now).toISOString()});return ()=>fs.rmSync(lock,{recursive:true,force:true});}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const held=readJson(owner,null);
      // A run is bounded well below three hours; an older or ownerless lock was left by a crash.
      if(held&&alive(held.pid)&&now-Date.parse(held.startedAt)<3*3600000)return null;
      fs.rmSync(lock,{recursive:true,force:true});
    }
  }
  return null;
}

const openQueue=file=>new DatabaseSync(file,{readOnly:true});
export function queueMarks(file,now){
  if(!fs.existsSync(file))return {lastEventId:0,claimedToday:0};
  const db=openQueue(file);
  try{
    const midnight=new Date(now);
    // Count claims of the current Zurich day: step back hour by hour to the first instant of today.
    while(localDate(new Date(midnight.getTime()-3600000))===localDate(now))midnight.setTime(midnight.getTime()-3600000);
    midnight.setMinutes(0,0,0);
    return {lastEventId:db.prepare('SELECT coalesce(max(id),0) AS id FROM events').get().id,
      claimedToday:db.prepare("SELECT count(*) AS n FROM events WHERE kind='claimed' AND created_at>=?").get(midnight.toISOString()).n};
  }finally{db.close();}
}

// What changed in the queue since the previous cycle, in the terms the owner is told about.
export function digest(file,sinceEventId){
  if(!fs.existsSync(file))return null;
  const db=openQueue(file);
  try{
    const events=db.prepare(`SELECT e.id,e.kind,e.details,j.kind AS job,j.card_id AS card,j.id AS jobId FROM events e
      LEFT JOIN jobs j ON j.id=e.job_id WHERE e.id>? ORDER BY e.id`).all(sinceEventId);
    const count=kind=>events.filter(event=>event.kind===kind).length;
    const detail=event=>{try{return JSON.parse(event.details);}catch{return {};}};
    const problem=event=>({jobId:event.jobId,card:event.card,kind:event.job,error:String(detail(event).error||'').slice(0,300)});
    const completed={};
    for(const event of events)if(event.kind==='completed')completed[event.job]=(completed[event.job]||0)+1;
    return {lastEventId:events.at(-1)?.id??sinceEventId,claimed:count('claimed'),completed,enqueued:count('enqueued'),superseded:count('superseded'),
      attention:events.filter(event=>event.kind==='attention').map(problem),
      retries:events.filter(event=>event.kind==='retry').map(problem),
      rejectedOutputs:count('rejected-output'),
      circuitOpened:events.filter(event=>event.kind==='circuit-opened').map(detail),
      loginUnavailable:events.filter(event=>event.kind==='worker-preflight-failed').map(event=>String(detail(event).reason||'').slice(0,300)),
      open:Object.fromEntries(db.prepare("SELECT kind||' '||state AS k,count(*) AS n FROM jobs WHERE state NOT IN ('done','superseded') GROUP BY 1 ORDER BY 1").all().map(row=>[row.k,row.n])),
      circuit:JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='circuit'").get()?.value||'null')};
  }finally{db.close();}
}

const approvedUpdates=base=>readJson(path.join(base,'approved-updates.json'),{updates:[]}).updates;
const updateBrief=update=>({card:update.draft?.cardId,approvedOn:update.approvedOn,jobId:update.jobId,
  fields:[...Object.keys(update.draft?.patch||{}),...Object.keys(update.draft?.practicalPatch||{}).map(key=>'practical.'+key)]});

function runNode(root,step){
  const started=Date.now();
  const run=spawnSync(process.execPath,step.args,{cwd:root,timeout:step.timeoutMs,encoding:'utf8',maxBuffer:64_000_000,env:process.env});
  return {code:run.error?null:run.status,seconds:Math.round((Date.now()-started)/1000),stdout:run.stdout||'',
    error:run.error?String(run.error.message):null,stderr:(run.stderr||'').split('\n').filter(line=>line&&!/ExperimentalWarning|--trace-warnings/.test(line)).join('\n')};
}
function notifyMac(title,text){
  spawnSync('osascript',['-e',`display notification ${JSON.stringify(text.slice(0,220))} with title ${JSON.stringify(title)}`],{timeout:10000});
}
export const needsOwner=record=>Boolean(record.blocked||record.failedSteps?.length||record.changes?.attention.length||
  record.changes?.circuitOpened.length||record.changes?.loginUnavailable.length||record.batch?.stopReason);

export function runCycle({base=here,home=os.homedir(),now=new Date(),run=runNode,notify=notifyMac,dryRun=false}={}){
  const root=path.dirname(base),stateDirectory=path.join(base,'workflow-state','cycle'),stateFile=path.join(stateDirectory,'state.json');
  const queueFile=path.join(base,'workflow-state','jobs.sqlite');
  const policy=readPolicy(base),state=readJson(stateFile,{}),record={project:PROJECT_ID,startedAt:now.toISOString()};
  const finish=()=>{
    if(dryRun)return record;
    fs.mkdirSync(path.join(stateDirectory,'log'),{recursive:true,mode:0o700});
    fs.appendFileSync(path.join(stateDirectory,'log',localDate(now)+'.jsonl'),JSON.stringify(record)+'\n',{mode:0o600});
    writeJson(path.join(stateDirectory,'latest.json'),record);
    if(needsOwner(record))notify('Minitandem: the cycle needs attention',record.blocked||
      [record.failedSteps?.length&&`failed steps: ${record.failedSteps.join(', ')}`,record.changes?.attention.length&&`attention: ${record.changes.attention.map(a=>a.card).join(', ')}`,
        record.changes?.circuitOpened.length&&'circuit breaker opened',record.changes?.loginUnavailable.length&&'Claude login unavailable',
        record.batch?.stopReason&&`batch stopped: ${record.batch.stopReason}`].filter(Boolean).join('; '));
    return record;
  };
  if(fs.existsSync(path.join(base,'cycle.pause'))){record.skipped='paused by editorial/cycle.pause';return dryRun?record:(writeJson(path.join(stateDirectory,'latest.json'),record),record);}
  const codex=codexSchedules(policy,home);record.codexSchedules=codex;
  if(codex.active.length){record.blocked=`Codex schedules are active: ${codex.active.join(', ')}`;return finish();}
  const marks=queueMarks(queueFile,now),planned=plan(state,policy,now,marks.claimedToday);
  Object.assign(record,{daily:planned.daily,leadRole:planned.role,limit:planned.limit,claimedToday:marks.claimedToday,capReached:planned.capReached});
  if(dryRun){record.steps=planned.steps.map(step=>['node',...step.args].join(' '));return record;}
  const release=acquireLock(stateDirectory,now.getTime());
  if(!release){record.skipped='another cycle is still running';writeJson(path.join(stateDirectory,'latest.json'),record);return record;}
  try{
    const before=approvedUpdates(base).length;let syncFailed=false;
    record.steps=[];record.failedSteps=[];
    for(const step of planned.steps){
      if(step.needsSync&&syncFailed){record.steps.push({label:step.label,skipped:'sync failed'});continue;}
      const result=run(root,step),failed=result.code!==0;
      record.steps.push({label:step.label,code:result.code,seconds:result.seconds,...(failed?{error:(result.error||result.stderr||result.stdout).slice(-600)}:{})});
      if(failed){record.failedSteps.push(step.label);if(step.label==='sync')syncFailed=true;}
      if(step.label==='batch'&&!failed){
        let output=null;try{output=JSON.parse(result.stdout);}catch{}
        record.batch={stopReason:output?.stopReason??null,jobs:(output?.results||[]).map(job=>({card:job.cardId,kind:job.kind,...(job.error?{error:String(job.error).slice(0,300)}:{state:job.result?.state})}))};
      }
    }
    record.changes=digest(queueFile,marks.lastEventId);
    record.approvedUpdates=approvedUpdates(base).slice(before).map(updateBrief);
    record.finishedAt=new Date().toISOString();
    writeJson(stateFile,{...state,runs:(state.runs||0)+1,lastRunAt:record.startedAt,lastEventId:record.changes?.lastEventId??marks.lastEventId,
      roleTurn:(state.roleTurn||0)+(planned.daily?0:1),lastDailyOn:planned.daily?planned.today:state.lastDailyOn});
    return finish();
  }finally{release();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--status'))console.log(JSON.stringify(readJson(path.join(here,'workflow-state','cycle','latest.json'),null),null,2));
  else{
    const record=runCycle({dryRun:process.argv.includes('--dry-run'),...(process.argv.includes('--no-notify')?{notify:()=>{}}:{})});
    console.log(JSON.stringify(record,null,2));
    process.exit(record.blocked||record.failedSteps?.length?1:0);
  }
}
