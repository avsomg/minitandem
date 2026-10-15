import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {JobQueue} from './jobs.mjs';
import {plan,runCycle,digest,acquireLock,codexSchedules,needsOwner,readPolicy} from './cycle.mjs';

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
  assert.deepEqual(labels(first.steps),['monitor','review','discover-events','canton-audit','work-packets','sync','batch','backup','external-pipeline','external-review','report']);
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
  const stale=path.join(f.base,'workflow-state','cycle','lock');fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale,'owner.json'),JSON.stringify({pid:process.pid,startedAt:'2026-10-12T00:00:00.000Z'}));
  assert.equal(runCycle({base:f.base,home:f.home,now:at(11),run,notify:()=>{}}).skipped,undefined);
  assert.equal(fs.existsSync(stale),false);assert.ok(calls.includes('sync'));
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
