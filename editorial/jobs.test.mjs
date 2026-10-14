import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {JobQueue,digest} from './jobs.mjs';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-queue-test-'));let now='2026-10-02T08:00:00.000Z';
  const file=path.join(directory,'state','jobs.sqlite'),queue=new JobQueue(file,{now:()=>now});
  t.after(()=>{queue.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {queue,directory,file,time:value=>now=value};
}
const spec=(kind='search',cardId='card',inputRevision='v1',priority=0)=>({kind,cardId,inputRevision,priority,payload:{cardRevision:'v1'}});

test('queue is project-scoped, private and idempotent',t=>{
  const {queue,file}=fixture(t),a=queue.enqueue(spec());
  assert.equal(queue.enqueue(spec()).id,a.id);assert.equal(queue.list().length,1);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  queue.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('other-client','project');
  assert.throws(()=>new JobQueue(file),/Wrong queue project/);
});
test('investigated circuit reset starts a new failure window without erasing history',t=>{
  const {queue}=fixture(t);
  for(const id of ['a','b','c']){
    queue.enqueue(spec('facts',id));const job=queue.claim('search','worker');queue.fail(job.id,job.token,'search','HTTP 429 quota');
  }
  assert.equal(queue.circuit().open,true);queue.resetCircuit('Provider limit investigated; resume a bounded probe.');
  for(const id of ['d','e']){
    queue.enqueue(spec('facts',id));const job=queue.claim('search','worker');queue.fail(job.id,job.token,'search','HTTP 429 quota');
    assert.equal(queue.circuit().open,false);
  }
  queue.enqueue(spec('facts','f'));const last=queue.claim('search','worker');queue.fail(last.id,last.token,'search','HTTP 429 quota');
  assert.equal(queue.circuit().open,true);
  assert.equal(queue.db.prepare("SELECT count(*) AS n FROM events WHERE kind='classified-failure'").get().n,6);
});
test('claims reserve one card across roles and reject wrong capabilities',t=>{
  const {queue}=fixture(t);queue.enqueue(spec());queue.enqueue(spec('verify','card','candidate'));
  const job=queue.claim('search','researcher');assert.equal(queue.claim('verify','verifier'),null);
  assert.throws(()=>queue.finish(job.id,job.token,'verify',{}),/wrong-role lease/);
  assert.throws(()=>queue.finish(job.id,'wrong','search',{}),/wrong-role lease/);
  queue.finish(job.id,job.token,'search',{ok:true});
  assert.ok(queue.claim('verify','verifier'));assert.equal(queue.claim('search','second'),null);
});
test('independent processes cannot claim the same task',t=>{
  const {queue,file}=fixture(t);queue.enqueue(spec());
  const run=spawnSync(process.execPath,['--input-type=module','-e',
    `import {JobQueue} from ${JSON.stringify(new URL('./jobs.mjs',import.meta.url).href)};
     const q=new JobQueue(${JSON.stringify(file)},{now:()=>"2026-10-02T08:00:00.000Z"});console.log(JSON.stringify(q.claim('search','other-process')));q.close();`],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.ok(JSON.parse(run.stdout));assert.equal(queue.claim('search','main-process'),null);
});
test('expired leases retry with backoff and stop after three failures',t=>{
  const {queue,time}=fixture(t);queue.enqueue(spec());
  const first=queue.claim('search','one',{leaseMs:1000});time('2026-10-02T08:00:02.000Z');
  assert.equal(queue.claim('search','two'),null);assert.equal(queue.get(first.id).state,'retry');
  assert.throws(()=>queue.finish(first.id,first.token,'search',{}),/lease/);
  time('2026-10-02T09:01:00.000Z');const second=queue.claim('search','two');queue.fail(second.id,second.token,'search','network');
  time('2026-10-02T12:00:00.000Z');const third=queue.claim('search','three');queue.fail(third.id,third.token,'search','network');
  assert.equal(queue.get(first.id).state,'attention');assert.equal(queue.claim('search','four'),null);
});
test('new revisions supersede stale leased results',t=>{
  const {queue}=fixture(t);queue.reconcile([spec()]);const old=queue.claim('search','one');
  queue.reconcile([spec('search','card','v2')]);assert.equal(queue.get(old.id).state,'superseded');
  assert.throws(()=>queue.finish(old.id,old.token,'search',{}),/lease/);
  assert.equal(queue.claim('search','two').input_revision,'v2');
});
test('reconciliation restores an unstarted exact revision but never resets an attempted job',t=>{
  const {queue}=fixture(t);const original=queue.reconcile([spec()])[0];
  queue.reconcile([]);assert.equal(queue.get(original.id).state,'superseded');
  const restored=queue.reconcile([spec()])[0];
  assert.equal(restored.id,original.id);assert.equal(restored.state,'ready');assert.equal(restored.attempt,0);
  const started=queue.claim('search','one');queue.reconcile([]);
  const attempted=queue.reconcile([spec()])[0];
  assert.equal(attempted.id,started.id);assert.equal(attempted.state,'superseded');assert.equal(attempted.attempt,1);
  assert.equal(queue.claim('search','two'),null);
});
test('backpressure holds ordinary discovery but allows urgent checks',t=>{
  const {queue}=fixture(t);queue.enqueue(spec('search','ordinary'));
  queue.enqueue(spec('facts','urgent','v1',120));queue.enqueue(spec('verify','other'));
  const job=queue.claim('search','worker',{backpressure:1});assert.equal(job.card_id,'urgent');
  queue.finish(job.id,job.token,'search',{});assert.equal(queue.claim('search','worker',{backpressure:1}),null);
});
test('facts re-checks wait only for double backlog unless urgent; discovery waits for single backlog',t=>{
  const {queue}=fixture(t);
  queue.enqueue(spec('facts','soft','v1',85));queue.enqueue(spec('search','plain','v1',85));
  queue.enqueue(spec('verify','b1'));
  assert.equal(queue.claim('search','w',{backpressure:1}).card_id,'soft');
  queue.enqueue(spec('facts','soft2','v1',85));queue.enqueue(spec('verify','b2'));
  assert.equal(queue.claim('search','w',{backpressure:1}),null);
  queue.enqueue(spec('facts','alarm','v1',400));
  assert.equal(queue.claim('search','w',{backpressure:1}).card_id,'alarm');
});
test('artifacts and outbox survive reopening; followups are ready immediately',t=>{
  const {queue,directory,file}=fixture(t);queue.enqueue(spec());const job=queue.claim('search','one');
  const result=queue.finish(job.id,job.token,'search',{found:true},{writes:[{file:'editorial/external-candidates/card.json',data:{found:true}}],
    followups:[spec('verify','card','candidate')]});
  const reopened=new JobQueue(file);try{
    assert.ok(reopened.claim('verify','two'));assert.equal(reopened.summary().pendingWrites,2);
    reopened.flush(directory);assert.equal(reopened.summary().pendingWrites,0);
    const artifact=JSON.parse(fs.readFileSync(path.join(directory,'editorial/agent-artifacts',result.artifact+'.json'),'utf8'));
    assert.equal(digest(artifact),result.artifact);assert.equal(artifact.role,'search');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,'editorial/external-candidates/card.json'),'utf8')),{found:true});
  }finally{reopened.close();}
});
test('outbox rejects arbitrary filesystem paths and immutable overwrites',t=>{
  const {queue,directory}=fixture(t);queue.enqueue(spec());const job=queue.claim('search','one');
  queue.finish(job.id,job.token,'search',{}, {writes:[{file:'../private.json',data:{}}]});
  assert.throws(()=>queue.flush(directory),/Unsafe outbox path/);assert.equal(fs.existsSync(path.join(directory,'../private.json')),false);
});
test('transaction failure does not lose job or partially approve it',t=>{
  const {queue}=fixture(t);queue.enqueue(spec());const job=queue.claim('search','one');
  assert.throws(()=>queue.transaction(()=>{queue.finish(job.id,job.token,'search',{});throw Error('rollback');}),/rollback/);
  assert.equal(queue.get(job.id).state,'leased');assert.equal(queue.summary().artifacts,0);
});
test('QA, patch approval and release reserve a global publication boundary',t=>{
  const {queue}=fixture(t);queue.enqueue(spec('qa','a'));queue.enqueue(spec('review-patch','b'));queue.enqueue(spec('release','catalogue'));queue.enqueue(spec('search','c'));
  const qa=queue.claim('qa','tester');assert.equal(queue.claim('verify','reviewer'),null);assert.equal(queue.claim('release','operator'),null);
  queue.finish(qa.id,qa.token,'qa',{});const release=queue.claim('release','operator');assert.ok(release);
  assert.equal(queue.claim('search','researcher'),null);queue.finish(release.id,release.token,'release',{});assert.ok(queue.claim('search','researcher'));
});
test('a rejected patch review is not counted as an applied update',t=>{
  const {queue}=fixture(t);queue.enqueue(spec('review-patch','a'));const rejected=queue.claim('verify','reviewer');
  queue.finish(rejected.id,rejected.token,'verify',{verdict:'reject'});assert.equal(queue.summary().appliedUpdates,0);
  queue.enqueue(spec('review-patch','b'));const approved=queue.claim('verify','reviewer');
  queue.finish(approved.id,approved.token,'verify',{verdict:'approve'});assert.equal(queue.summary().appliedUpdates,1);
});
test('repeat approvals of one card are distinct updates but one updated card',t=>{
  const {queue}=fixture(t);
  for(const revision of ['v1','v2']){
    queue.enqueue(spec('review-patch','a',revision));const job=queue.claim('verify','reviewer');
    queue.finish(job.id,job.token,'verify',{verdict:'approve'});
  }
  assert.equal(queue.summary().appliedUpdates,2);assert.equal(queue.summary().updatedCards,1);
  assert.equal(queue.summary().fullyReviewedCards,0);
});
test('systemic failures stop new model claims; one blocked venue does not stop the system',t=>{
  const {queue}=fixture(t);
  for(const id of ['a','b','c']){
    queue.enqueue(spec('facts',id));const job=queue.claim('search','worker');
    queue.fail(job.id,job.token,'search','Invalid field value type: notes');
  }
  assert.equal(queue.circuit().open,true);queue.enqueue(spec('facts','d'));
  assert.equal(queue.claim('search','worker'),null);queue.enqueue(spec('qa','catalogue'));assert.ok(queue.claim('qa','qa'));
  assert.throws(()=>queue.resetCircuit(''),/investigation/);
  queue.resetCircuit('Fixed notes normalization and added regression tests.');assert.ok(queue.claim('search','worker'));
});
