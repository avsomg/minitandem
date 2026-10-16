import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {JobQueue} from './jobs.mjs';
import {processStart} from './process-lock.mjs';
import {plan,runCycle,digest,usageSummary,acquireLock,codexSchedules,needsOwner,readPolicy} from './cycle.mjs';

const policy=readPolicy();
const at=(hour,day='2026-10-13')=>new Date(`${day}T${String(hour).padStart(2,'0')}:30:00+02:00`);
function fixture(t,{codex=null}={}){
  const top=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-cycle-')),base=path.join(top,'app','editorial'),home=path.join(top,'home');
  fs.mkdirSync(path.join(base,'workflow-state'),{recursive:true});fs.mkdirSync(home,{recursive:true});
  fs.copyFileSync(new URL('./cycle-policy.json',import.meta.url),path.join(base,'cycle-policy.json'));
  fs.writeFileSync(path.join(base,'approved-updates.json'),JSON.stringify({updates:[]}));
  const queue=new JobQueue(path.join(base,'workflow-state','jobs.sqlite'));
  if(codex){
    fs.mkdirSync(path.join(home,'.codex','sqlite'),{recursive:true});
    const db=new DatabaseSync(path.join(home,'.codex','sqlite','codex-dev.db'));
    db.exec('CREATE TABLE automations(id TEXT PRIMARY KEY,status TEXT)');
    for(const [id,status] of Object.entries(codex))db.prepare('INSERT INTO automations VALUES (?,?)').run(id,status);db.close();
  }
  t.after(()=>{queue.close();fs.rmSync(top,{recursive:true,force:true});});
  // Most cases look at an ordinary run, after the day's maintenance pass has already happened.
  const dailyDone=()=>{fs.mkdirSync(path.join(base,'workflow-state','cycle'),{recursive:true});
    fs.writeFileSync(path.join(base,'workflow-state','cycle','state.json'),JSON.stringify({lastDailyOn:'2026-10-13'}));};
  return {base,home,queue,dailyDone,latest:()=>JSON.parse(fs.readFileSync(path.join(base,'workflow-state','cycle','latest.json'),'utf8'))};
}
const labels=steps=>steps.map(step=>step.label);

test('daily maintenance runs once per local day and other runs rotate the leading role',()=>{
  const first=plan({},policy,at(7),0);
  assert.equal(first.daily,true);assert.equal(first.role,null);
  assert.deepEqual(labels(first.steps),['monitor','review','discover-events','canton-audit','work-packets','sync','batch','backup','external-pipeline','external-review','report','release-summary']);
  assert.deepEqual(first.steps.find(step=>step.label==='batch').args,['editorial/agent-run.mjs','--chain','--limit=4']);
  assert.equal(plan({},policy,at(3),0).daily,false);
  const later=plan({lastDailyOn:'2026-10-13',roleTurn:1},policy,at(11),0);
  assert.equal(later.daily,false);assert.deepEqual(labels(later.steps),['sync','batch','external-pipeline','external-review','report']);
  assert.deepEqual(later.steps[1].args,['editorial/agent-run.mjs','--role=search','--chain','--limit=4']);
  assert.equal(plan({lastDailyOn:'2026-10-13',roleTurn:3},policy,at(15),0).role,'verify');
  assert.equal(plan({lastDailyOn:'2026-10-13'},policy,at(7,'2026-10-14'),0).daily,true);
});
test('the daily job cap shrinks and then removes the model batch, never the bookkeeping',()=>{
  assert.equal(plan({lastDailyOn:'2026-10-13'},policy,at(19),22).steps.find(step=>step.label==='batch').args.at(-1),'--limit=2');
  const capped=plan({lastDailyOn:'2026-10-13'},policy,at(23),24);
  assert.equal(capped.capReached,true);assert.deepEqual(labels(capped.steps),['sync','external-pipeline','external-review','report']);
});
test('an active Codex schedule blocks the cycle before anything runs',t=>{
  const f=fixture(t,{codex:{automation:'PAUSED','automation-2':'ACTIVE','automation-3':'PAUSED','automation-4':'PAUSED',other:'ACTIVE'}});
  const calls=[],notes=[];
  const record=runCycle({base:f.base,home:f.home,now:at(11),run:(_root,step)=>{calls.push(step.label);return {code:0,seconds:0,stdout:'',stderr:''};},notify:(...a)=>notes.push(a)});
  assert.match(record.blocked,/automation-2/);assert.deepEqual(calls,[]);assert.equal(notes.length,1);assert.equal(needsOwner(record),true);
  assert.deepEqual(codexSchedules(policy,f.home),{checked:true,active:['automation-2']});
  assert.deepEqual(codexSchedules(policy,path.join(f.home,'absent')),{checked:false,active:[]});
});
test('a pause file and a running cycle both skip quietly',t=>{
  const f=fixture(t),calls=[],run=(_root,step)=>{calls.push(step.label);return {code:0,seconds:0,stdout:'{}',stderr:''};};
  fs.writeFileSync(path.join(f.base,'cycle.pause'),'');
  assert.match(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>assert.fail('no notice')}).skipped,/paused/);
  fs.rmSync(path.join(f.base,'cycle.pause'));
  const release=acquireLock(path.join(f.base,'workflow-state','cycle'));
  assert.equal(acquireLock(path.join(f.base,'workflow-state','cycle')),null);
  assert.match(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>assert.fail('no notice')}).skipped,/still running/);
  release();assert.deepEqual(calls,[]);
  assert.equal(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{}}).skipped,undefined);assert.ok(calls.includes('sync'));
});
test('the cycle lock is a file that exists while the cycle runs and is gone afterwards; a skipped run leaves the running one\'s lock alone',t=>{
  const f=fixture(t),directory=path.join(f.base,'workflow-state','cycle'),lock=path.join(directory,'cycle.lock');f.dailyDone();
  let during=null,skipped=null;
  runCycle({base:f.base,home:f.home,now:at(11),notify:()=>{},run:(_root,step)=>{
    if(step.label==='sync'){
      during=JSON.parse(fs.readFileSync(lock,'utf8'));
      skipped=runCycle({base:f.base,home:f.home,now:at(11),run:()=>assert.fail('nothing runs'),notify:()=>assert.fail('no notice')}).skipped;
      assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).token,during.token,'the skipped run did not touch the lock');
    }
    return {code:0,seconds:0,stdout:'',stderr:''};
  }});
  assert.equal(during.pid,process.pid);assert.match(skipped,/still running/);
  assert.equal(fs.existsSync(lock),false);
  assert.equal(fs.readdirSync(directory).some(name=>name.startsWith('cycle.lock')),false,'no temporary file or marker is left');
});
test('a lock held by a live process is not taken however old it is; one left by a process that is gone is',t=>{
  const f=fixture(t),directory=path.join(f.base,'workflow-state','cycle'),lock=path.join(directory,'cycle.lock'),calls=[];f.dailyDone();
  const run=(_root,step)=>{calls.push(step.label);return {code:0,seconds:0,stdout:'',stderr:''};};
  // this test process is the live owner, and has been "for" years, as far as the file says (the old rule gave up on a live owner after three hours)
  const owner={schema:1,pid:process.pid,token:'0123456789abcdef',startedAt:'2020-01-01T00:00:00.000Z',processStart:processStart(process.pid)};
  fs.writeFileSync(lock,JSON.stringify(owner)+'\n');
  const record=runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>assert.fail('no notice')});
  assert.match(record.skipped,/still running/);assert.deepEqual(calls,[]);assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).token,owner.token);
  assert.equal(f.latest().skipped,record.skipped);
  // a process that has exited
  const gone=spawnSync(process.execPath,['-e','0']).pid;
  fs.writeFileSync(lock,JSON.stringify({...owner,pid:gone,processStart:null})+'\n');
  assert.equal(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{}}).skipped,undefined);
  assert.ok(calls.includes('sync'));assert.equal(fs.existsSync(lock),false);
});
test('a directory lock left by an older version is respected while its owner runs and cleared when it is gone or too old',t=>{
  const f=fixture(t),directory=path.join(f.base,'workflow-state','cycle'),old=path.join(directory,'lock'),calls=[];f.dailyDone();
  const run=(_root,step)=>{calls.push(step.label);return {code:0,seconds:0,stdout:'',stderr:''};};
  const legacy=(pid,startedAt)=>{fs.rmSync(old,{recursive:true,force:true});fs.mkdirSync(old);fs.writeFileSync(path.join(old,'owner.json'),JSON.stringify({pid,startedAt}));};
  legacy(process.pid,new Date(Date.now()-3600000).toISOString());
  assert.match(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{}}).skipped,/still running/);
  assert.ok(fs.existsSync(old),'an older version\'s run in progress is not disturbed');assert.deepEqual(calls,[]);
  legacy(spawnSync(process.execPath,['-e','0']).pid,new Date().toISOString());
  assert.equal(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{}}).skipped,undefined);
  assert.equal(fs.existsSync(old),false);assert.ok(calls.includes('sync'));
  calls.length=0;
  legacy(process.pid,'2026-10-12T00:00:00.000Z');
  assert.equal(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{}}).skipped,undefined);
  assert.equal(fs.existsSync(old),false);assert.ok(calls.includes('sync'));
});
test('the shared planning state is read after the lock is taken, not before',t=>{
  const f=fixture(t),directory=path.join(f.base,'workflow-state','cycle'),calls=[];
  // Another run finishes while this one is on its way to the lock: it did the day\'s maintenance and used the daily job allowance up to the cap.
  const order=[];
  const lock=dir=>{
    order.push('lock');
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'state.json'),JSON.stringify({lastDailyOn:'2026-10-13',roleTurn:1,runs:5}));
    return acquireLock(dir);
  };
  const record=runCycle({base:f.base,home:f.home,now:at(11),lock,notify:()=>{},run:(_root,step)=>{calls.push(step.label);return {code:0,seconds:0,stdout:'',stderr:''};}});
  assert.equal(record.daily,false,'planned from the state the other run left, not from the empty one read earlier');
  assert.equal(record.leadRole,'search');
  assert.ok(!calls.includes('monitor'));
  const saved=JSON.parse(fs.readFileSync(path.join(directory,'state.json'),'utf8'));
  assert.equal(saved.runs,6,'and written back on top of it');assert.equal(saved.roleTurn,2);
  assert.deepEqual(order,['lock']);
  // a dry run only reads: it takes no lock
  assert.equal(runCycle({base:f.base,home:f.home,now:at(11),dryRun:true,lock:()=>assert.fail('no lock for a dry run'),run:()=>assert.fail('nothing runs')}).daily,false);
  // the pause and the Codex check come before the lock
  fs.writeFileSync(path.join(f.base,'cycle.pause'),'');
  assert.match(runCycle({base:f.base,home:f.home,now:at(11),lock:()=>assert.fail('paused: no lock'),notify:()=>{}}).skipped,/paused/);
});
test('the record carries the run id that ops/cycle-run.mjs gave this invocation, and only a plain id',t=>{
  const f=fixture(t);f.dailyDone();
  const run=()=>({code:0,seconds:0,stdout:'',stderr:''});
  const record=runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{},runId:'7f3a0c1e-0000-4000-8000-000000000001'});
  assert.equal(record.runId,'7f3a0c1e-0000-4000-8000-000000000001');assert.equal(f.latest().runId,record.runId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.base,'workflow-state','cycle','log','2026-10-13.jsonl'),'utf8').trim().split('\n').at(-1)).runId,record.runId);
  // every kind of receipt has it: a pause, a skip, a block
  fs.writeFileSync(path.join(f.base,'cycle.pause'),'');
  assert.equal(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{},runId:'run-2'}).runId,'run-2');assert.equal(f.latest().runId,'run-2');
  fs.rmSync(path.join(f.base,'cycle.pause'));
  const release=acquireLock(path.join(f.base,'workflow-state','cycle'));
  assert.equal(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{},runId:'run-3'}).skipped.length>0,true);assert.equal(f.latest().runId,'run-3');release();
  // without one, or with something that is not a plain id, there is none in the record
  for(const runId of [undefined,null,'','has space','x'.repeat(65),'a\nb'])assert.equal('runId' in runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{},runId}),false,JSON.stringify(runId));
});
test('the run id never comes from the environment of a step: QA runs the tests inside a cycle that has one',t=>{
  const f=fixture(t);f.dailyDone();const before=process.env.MINITANDEM_CYCLE_RUN_ID;
  process.env.MINITANDEM_CYCLE_RUN_ID='inherited-by-a-step';t.after(()=>{if(before===undefined)delete process.env.MINITANDEM_CYCLE_RUN_ID;else process.env.MINITANDEM_CYCLE_RUN_ID=before;});
  const record=runCycle({base:f.base,home:f.home,now:at(11),run:()=>({code:0,seconds:0,stdout:'',stderr:''}),notify:()=>{}});
  assert.equal('runId' in record,false);
});
test('a failed sync skips the batch, is reported, and still leaves a record',t=>{
  const f=fixture(t),calls=[],notes=[];f.dailyDone();
  const record=runCycle({base:f.base,home:f.home,now:at(11),notify:(...a)=>notes.push(a),
    run:(_root,step)=>{calls.push(step.label);return step.label==='sync'?{code:1,seconds:1,stdout:'',stderr:'Error: Unreviewed candidate address: x'}:{code:0,seconds:0,stdout:'',stderr:''};}});
  assert.deepEqual(calls,['sync']);assert.deepEqual(record.failedSteps,['sync']);
  assert.match(record.steps[0].error,/Unreviewed candidate address/);assert.equal(record.steps[1].skipped,'sync failed');
  assert.equal(notes.length,1);assert.deepEqual(f.latest().failedSteps,['sync']);
  assert.equal(fs.readdirSync(path.join(f.base,'workflow-state','cycle','log')).length,1);
});
test('the record names what changed since the previous cycle and stays silent otherwise',t=>{
  const f=fixture(t),notes=[];f.dailyDone();
  const good=f.queue.enqueue({kind:'verify',cardId:'card-a',inputRevision:'r'}),bad=f.queue.enqueue({kind:'integrate',cardId:'card-b',inputRevision:'r'});
  const run=(_root,step)=>{
    if(step.label==='batch'){
      const a=f.queue.claim('verify','runtime-verify');f.queue.finish(a.id,a.token,'verify',{receipt:true});
      const b=f.queue.claim('editor','runtime-editor');f.queue.db.prepare('UPDATE jobs SET attempt=3 WHERE id=?').run(b.id);
      f.queue.fail(b.id,b.token,'editor','Worker input exceeds budget; split the task without truncating evidence');
      fs.writeFileSync(path.join(f.base,'approved-updates.json'),JSON.stringify({updates:[{jobId:'j1',approvedOn:'2026-10-13',draft:{cardId:'card-a',patch:{address:'New'},practicalPatch:{booking:false}}}]}));
      return {code:0,seconds:2,stderr:'',stdout:JSON.stringify({stopReason:null,results:[{cardId:'card-a',kind:'verify',result:{state:'done'}},{cardId:'card-b',kind:'integrate',error:'Worker input exceeds budget'}]})};
    }
    return {code:0,seconds:0,stdout:'',stderr:''};
  };
  const record=runCycle({base:f.base,home:f.home,now:at(11),run,notify:(...a)=>notes.push(a)});
  assert.equal(record.changes.claimed,2);assert.deepEqual(record.changes.completed,{verify:1});
  assert.deepEqual(record.changes.attention.map(row=>[row.card,row.kind]),[['card-b','integrate']]);
  assert.match(record.changes.attention[0].error,/exceeds budget/);assert.equal(record.changes.open['integrate attention'],1);
  assert.deepEqual(record.approvedUpdates,[{card:'card-a',approvedOn:'2026-10-13',jobId:'j1',fields:['address','practical.booking']}]);
  assert.deepEqual(record.batch.jobs.map(job=>job.state||'error'),['done','error']);assert.equal(notes.length,1);assert.match(notes[0][1],/card-b/);
  assert.equal(good.id!==bad.id,true);
  const quiet=runCycle({base:f.base,home:f.home,now:at(15),run:(_r,step)=>({code:0,seconds:0,stderr:'',stdout:step.label==='batch'?'{"stopReason":null,"results":[]}':''}),notify:()=>assert.fail('nothing new')});
  assert.equal(quiet.changes.claimed,0);assert.deepEqual(quiet.changes.attention,[]);assert.deepEqual(quiet.approvedUpdates,[]);assert.equal(quiet.leadRole,'search');
  assert.equal(digest(path.join(f.base,'workflow-state','jobs.sqlite'),0).claimed,2);
});
test('a dry run shows the plan and changes nothing',t=>{
  const f=fixture(t);
  const record=runCycle({base:f.base,home:f.home,now:at(7),dryRun:true,run:()=>assert.fail('nothing runs'),notify:()=>assert.fail('no notice')});
  assert.equal(record.daily,true);assert.equal(record.steps[0],'node editorial/monitor.mjs');
  assert.equal(fs.existsSync(path.join(f.base,'workflow-state','cycle')),false);
});
test('claimed today is the day\'s total after the batch, not the count the cap was planned from',t=>{
  const f=fixture(t);f.dailyDone();
  for(const card of ['a','b','c'])f.queue.enqueue({kind:'verify',cardId:`card-${card}`,inputRevision:'r'});
  f.queue.claim('verify','runtime-verify');
  // A claim from another day must not count.
  f.queue.db.prepare("INSERT INTO events(job_id,kind,details,created_at) VALUES (NULL,'claimed','{}','2020-01-01T00:00:00.000Z')").run();
  const run=(_root,step)=>{
    if(step.label==='batch')for(let i=0;i<2;i++)f.queue.claim('verify','runtime-verify');
    return {code:0,seconds:0,stdout:'',stderr:''};
  };
  const record=runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{}});
  assert.equal(record.claimedBeforeRun,1);assert.equal(record.changes.claimed,2);assert.equal(record.claimedToday,3);
  assert.equal(f.latest().claimedToday,3);
  // The next run plans its cap from those three claims.
  assert.equal(runCycle({base:f.base,home:f.home,now:at(15),dryRun:true}).claimedToday,3);
});
test('the digest adds up the model use of this cycle only, as an estimate and in one line',t=>{
  const f=fixture(t),file=path.join(f.base,'workflow-state','jobs.sqlite');f.dailyDone();
  const earlier=f.queue.enqueue({kind:'verify',cardId:'card-old',inputRevision:'r'}),job=f.queue.enqueue({kind:'verify',cardId:'card-new',inputRevision:'r'});
  f.queue.event(earlier.id,'usage',{model:'m',input_tokens:900000,cached_input_tokens:800000,output_tokens:90000,modelSeconds:500,apiCostEstimateUsd:9});
  const run=(_root,step)=>{
    if(step.label==='batch'){
      f.queue.event(job.id,'usage',{model:'m',input_tokens:144402,cached_input_tokens:101526,output_tokens:15703,modelSeconds:141.4,apiCostEstimateUsd:0.03});
      f.queue.event(job.id,'usage',{model:'m',input_tokens:44518,cached_input_tokens:19393,output_tokens:2922,modelSeconds:52.2,apiCostEstimateUsd:0.13});
      f.queue.event(job.id,'usage',{model:'m',input_tokens:999999,replayed:true,artifact:'x'});
      f.queue.event(job.id,'usage',{model:'m',toolCalls:0,failed:true,modelSeconds:1.9});
    }
    return {code:0,seconds:0,stdout:'',stderr:''};
  };
  const record=runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{}});
  assert.deepEqual({...record.changes.usage,line:undefined},{modelCalls:3,inputTokens:188920,cacheReadTokens:120919,outputTokens:18625,modelSeconds:196,costEstimateUsd:0.16,line:undefined});
  assert.equal(record.changes.usage.line,'3 model calls, 189k input tokens (of which 121k cache reads), 19k output tokens, 3 min model time, CLI cost estimate $0.16 (not billing)');
  assert.equal(f.latest().changes.usage.line,record.changes.usage.line);
  // Nothing new in the next cycle: nothing is carried over from this one.
  const quiet=runCycle({base:f.base,home:f.home,now:at(15),run:()=>({code:0,seconds:0,stdout:'',stderr:''}),notify:()=>{}});
  assert.equal(quiet.changes.usage.modelCalls,0);assert.equal(quiet.changes.usage.costEstimateUsd,null);assert.equal(quiet.changes.usage.line,'no model calls');
  assert.equal(digest(file,0).usage.modelCalls,4);
});
test('the usage line scales its units and drops the cost when no event carries an estimate',()=>{
  assert.equal(usageSummary([{input_tokens:1_100_000,cached_input_tokens:800_000,output_tokens:24_000,modelSeconds:421}]).line,
    '1 model call, 1.1M input tokens (of which 800k cache reads), 24k output tokens, 7 min model time');
  assert.equal(usageSummary([{input_tokens:900,cached_input_tokens:0,output_tokens:5,modelSeconds:3.6}]).line,
    '1 model call, 900 input tokens (of which 0 cache reads), 5 output tokens, 4 s model time');
});
test('the digest distinguishes completed changes from open chains and reports the oldest urgent work',t=>{
  const f=fixture(t);f.dailyDone();
  f.queue.enqueue({kind:'facts',cardId:'urgent',inputRevision:'one',payload:{urgent:true}});
  const job=f.queue.claim('search','reader');f.queue.finish(job.id,job.token,'search',{}, {followups:[{kind:'verify-facts',cardId:'urgent',inputRevision:'next',payload:{chainId:job.id,urgent:true}}]});
  fs.writeFileSync(path.join(f.base,'approved-updates.json'),JSON.stringify({updates:[{jobId:'approved',approvedOn:'2026-10-13',draft:{cardId:'done',patch:{min:2}}}]}));
  const report=digest(path.join(f.base,'workflow-state','jobs.sqlite'),0,{now:at(11)});
  assert.equal(report.completedChangesToday.length,1);assert.equal(report.openChainCount,1);assert.equal(report.openChains[0].card,'urgent');
  assert.equal(report.oldestUrgent.card,'urgent');assert.ok(Number.isFinite(report.openChains[0].ageHours));
  fs.writeFileSync(path.join(f.base,'cycle.pause'),JSON.stringify({until:'2026-10-12T10:00:00Z'}));
  const paused=runCycle({base:f.base,home:f.home,now:at(11),notify:()=>{}});assert.equal(paused.pause.expired,true);
});
