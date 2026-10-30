// One night of the editorial queue: agent-run.mjs --chain --limit=4, one process, again and again, until a set hour or a stop rule.
// The design and its reasons: the Architect's review of 30 October 2026. It sits outside editorial/ so that the runtime revision does not change.
//
// It holds the cycle's own lock, so a timer run in the meantime records "another cycle is still running" and exits cleanly; never editorial/cycle.pause.
// It changes no limit, attempt, priority or circuit, and it publishes nothing. Before each run it looks at the clock, the stop file and the circuit.
//
//   node ops/night-run.mjs --background      start it detached from this terminal; the log is workflow-state/night/run.log
//   node ops/night-run.mjs                   run here
//   node ops/night-run.mjs --until=04:45 --card=<id> --card=<id>    the hour after which no new run starts, the cards that go first
//   touch editorial/workflow-state/night.stop                       stop after the current run (the file is removed on stopping)
//   editorial/workflow-state/night/latest.json                      where it stands
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {acquireLock,digest,queueMarks} from '../editorial/cycle.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const MINUTE=60000;
export const RULES={
  provider:{waitMinutes:40,max:8},  // a usage limit or a login: nothing is claimed while the probe fails. 40 minutes keeps failures below 3 per hour (the circuit)
  failed:{waitMinutes:10,max:3},    // crash, or every job of the run failed: attempts were spent, so this stops early
  idle:{waitMinutes:15,max:4},      // nothing could be claimed: chains may be waiting for a retry
  soft:{waitMinutes:0,max:3},       // a lost lease or the 30-minute budget of one run
};

const zurich=(now,options)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Zurich',hourCycle:'h23',...options}).format(now);
export function deadlineAfter(now,until){
  for(let minute=1;minute<=25*60;minute++){
    const at=new Date(now.getTime()+minute*MINUTE);
    if(zurich(at,{hour:'2-digit',minute:'2-digit'})===until){at.setSeconds(0,0);return at;}
  }
  throw Error('--until must be HH:MM');
}

// What one agent-run means for the night: ok, or which rule applies, or fatal.
export function classify({code,output}){
  const stop=output?.stopReason??null,results=output?.results||[];
  if(['systemic-failure-circuit','editorial-runtime-changed'].includes(stop))return 'fatal';
  if(['worker-provider-failure','worker-login-unavailable'].includes(stop))return 'provider';
  if(code!==0||!output||(results.length&&results.every(job=>job.error)))return 'failed';
  if(['lease-lost','run-time-budget'].includes(stop))return 'soft';
  if(!results.length)return 'idle';
  return 'ok';
}

const childEnv=()=>{
  // What launchd gives the cycle: no keys or session variables of whatever started this file.
  const home=os.homedir();
  const temp=spawnSync('getconf',['DARWIN_USER_TEMP_DIR'],{encoding:'utf8'}).stdout?.trim();
  return {PATH:`${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,HOME:home,USER:os.userInfo().username,LOGNAME:os.userInfo().username,
    LANG:'en_US.UTF-8',TZ:'Europe/Zurich',...(temp?{TMPDIR:temp}:{})};
};
function runAgent(root,args){
  const started=Date.now();
  const run=spawnSync(process.execPath,['--no-warnings','editorial/agent-run.mjs','--chain','--limit=4',...args],{cwd:root,timeout:45*MINUTE,encoding:'utf8',maxBuffer:64_000_000,env:childEnv()});
  let output=null;try{output=JSON.parse(run.stdout);}catch{}
  return {code:run.error?null:run.status,output,seconds:Math.round((Date.now()-started)/1000),error:run.error?String(run.error.message):(run.status?(run.stderr||'').slice(-600):null)};
}
const notifyMac=(title,text)=>spawnSync('osascript',['-e',`display notification ${JSON.stringify(text.slice(0,220))} with title ${JSON.stringify(title)}`],{timeout:10000});
const sleepFor=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const writeJson=(file,value)=>{const temp=`${file}.tmp-${process.pid}`;fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);};
const readApprovals=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8')).updates.length;}catch{return 0;}};

// Everything outside (the runs, the clock, the waiting) comes in as arguments, so the rules can be tested without a model.
export function runNight({base=path.join(here,'..','editorial'),until='04:45',cards=[],run=runAgent,now=()=>new Date(),sleep=sleepFor,notify=notifyMac,lock=acquireLock,lockWaitMinutes=15,readDigest=digest}={}){
  const root=path.dirname(base),state=path.join(base,'workflow-state'),night=path.join(state,'night'),stopFile=path.join(state,'night.stop');
  const queueFile=path.join(state,'jobs.sqlite'),journal=path.join(base,'approved-updates.json');
  fs.mkdirSync(night,{recursive:true,mode:0o700});
  const startedAt=now(),deadline=deadlineAfter(startedAt,until);
  const record={startedAt:startedAt.toISOString(),until,deadline:deadline.toISOString(),pid:process.pid,state:'starting',runs:0,jobs:{},jobErrors:0,streaks:{provider:0,failed:0,idle:0,soft:0},approvalsTonight:0};
  const firstEvent=queueMarks(queueFile,startedAt).lastEventId;
  const approvalsBefore=readApprovals(journal);
  const logFile=path.join(night,`${zurich(startedAt,{year:'numeric',month:'2-digit',day:'2-digit'}).split('/').reverse().join('-')}.jsonl`);
  const save=()=>{record.updatedAt=now().toISOString();writeJson(path.join(night,'latest.json'),record);};

  let release=null;
  for(let waited=0;;waited++){
    release=lock(path.join(state,'cycle'));
    if(release)break;
    if(waited>=lockWaitMinutes){record.state='stopped';record.stopped='the cycle lock stayed taken';save();notify('Minitandem night run',record.stopped);return record;}
    record.state='waiting for the cycle lock';save();sleep(MINUTE);
  }
  let lastNotice=now().getTime();
  const finish=reason=>{record.state='stopped';record.stopped=reason;refresh();save();notify('Minitandem night run stopped',`${reason}. ${record.runs} runs, ${record.approvalsTonight} approvals.`);return record;};
  const refresh=()=>{
    record.approvalsTonight=readApprovals(journal)-approvalsBefore;
    try{
      const seen=readDigest(queueFile,firstEvent,{now:now(),journalFile:journal});
      if(seen)Object.assign(record,{claimed:seen.claimed,completed:seen.completed,attention:seen.attention.map(job=>({card:job.card,kind:job.kind,error:job.error.slice(0,160)})),
        retries:seen.retries.length,rejectedOutputs:seen.rejectedOutputs,usage:seen.usage.line,open:seen.open,circuit:seen.circuit});
    }catch(error){record.digestError=String(error.message).slice(0,200);}
  };
  // A wait that the stop file or the deadline can cut short.
  const wait=minutes=>{
    const end=Math.min(now().getTime()+minutes*MINUTE,deadline.getTime());
    while(now().getTime()<end&&!fs.existsSync(stopFile))sleep(Math.min(MINUTE/2,Math.max(1,end-now().getTime())));
  };
  try{
    const firstCards=[...cards];
    let cardTurns=0;
    for(;;){
      if(fs.existsSync(stopFile)){fs.rmSync(stopFile,{force:true});return finish('stop file');}
      if(now()>=deadline)return finish(`no new run after ${until}`);
      refresh();
      if(record.circuit?.open)return finish('the circuit is open');
      // The cards that go first get a few runs of their own: search, then verify. Then the queue's own order.
      const card=firstCards[0];
      const args=card?[`--card=${card}`]:[];
      record.state=card?`running: first card ${card}`:'running';record.currentRunStartedAt=now().toISOString();save();
      const result=run(root,args);
      record.runs++;
      const kind=classify(result);
      const results=result.output?.results||[];
      for(const job of results){record.jobs[job.kind]=(record.jobs[job.kind]||0)+1;if(job.error)record.jobErrors++;}
      refresh();
      fs.appendFileSync(logFile,JSON.stringify({at:now().toISOString(),run:record.runs,card:card||null,seconds:result.seconds,code:result.code,verdict:kind,stopReason:result.output?.stopReason??null,
        jobs:results.map(job=>({card:job.cardId,kind:job.kind,...(job.error?{error:String(job.error).slice(0,300)}:{state:job.result?.state})})),...(result.error?{error:result.error}:{})})+'\n',{mode:0o600});
      record.lastRun={verdict:kind,seconds:result.seconds,stopReason:result.output?.stopReason??null,jobs:results.length,...(result.error?{error:result.error.slice(0,300)}:{})};
      if(card){
        cardTurns++;
        if(kind==='idle'||cardTurns>=3){firstCards.shift();cardTurns=0;}
        if(kind==='idle'){save();continue;}  // nothing open for this card: not a reason to wait
      }
      if(kind==='fatal')return finish(result.output.stopReason);
      if(kind==='ok')for(const key of Object.keys(record.streaks))record.streaks[key]=0;
      else{
        record.streaks[kind]++;
        if(record.streaks[kind]>=RULES[kind].max)return finish(`${RULES[kind].max} ${kind} runs without a good one in between (last: ${result.output?.stopReason||result.error||'nothing to claim'})`);
        if(kind==='provider'&&record.streaks[kind]===1)notify('Minitandem night run',`Waiting: ${result.output?.stopReason}. Retries every ${RULES.provider.waitMinutes} minutes.`);
        if(RULES[kind].waitMinutes){record.state=`waiting ${RULES[kind].waitMinutes} min (${kind})`;save();wait(RULES[kind].waitMinutes);}
      }
      if(now().getTime()-lastNotice>=60*MINUTE){lastNotice=now().getTime();notify('Minitandem night run',`${record.runs} runs, ${record.approvalsTonight} approvals, ${record.claimed??0} jobs.`);}
      save();
    }
  }finally{release?.();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const value=name=>process.argv.filter(arg=>arg.startsWith(`--${name}=`)).map(arg=>arg.slice(name.length+3));
  if(process.argv.includes('--background')){
    const night=path.join(here,'..','editorial','workflow-state','night');
    fs.mkdirSync(night,{recursive:true,mode:0o700});
    const log=fs.openSync(path.join(night,'run.log'),'a',0o600);
    const child=spawn(process.execPath,['--no-warnings',fileURLToPath(import.meta.url),...process.argv.slice(2).filter(arg=>arg!=='--background')],{detached:true,stdio:['ignore',log,log],env:childEnv(),cwd:path.join(here,'..')});
    child.unref();console.log(child.pid);process.exit(0);
  }
  // The Mac stays awake as long as this process lives.
  spawn('caffeinate',['-is','-w',String(process.pid)],{detached:true,stdio:'ignore'}).unref();
  const record=runNight({until:value('until')[0]||'04:45',cards:value('card')});
  console.log(JSON.stringify(record,null,2));
}
