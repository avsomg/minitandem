import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './jobs.mjs';
import {snapshot} from './evidence.mjs';
import {promptFor,workerEvidenceFiles} from './agent-run.mjs';

const size=value=>JSON.stringify(value).length;
const pad=(value,target,key='note')=>{
  value[key]='';const count=target-size(value);assert.ok(count>=0);value[key]='x'.repeat(count);return value;
};
// Invented text and padding reproduce sizes, not the private card's contents.
export function budgetFixture(){
  const url='https://example.org/course',fetchedAt='2026-10-16T08:00:00Z';
  const snapshots=[snapshot({url,fetchedAt,parser:'calendar-selected-zurich-v1',text:'C'.repeat(10784)}),
    snapshot({url,fetchedAt,text:'H'.repeat(1425)})];
  const claims=Array.from({length:26},(_,i)=>({key:`claim-${i}`,field:'notes',value:[`Condition ${i}`],status:'supported',
    source:url,quote:`Exact invented condition ${i}.`,snapshotId:snapshots[0].id,kind:'official',scope:'exact-card',note:'Synthetic condition.'}));
  const approved=claims.slice(0,12);claims[0].note+='x'.repeat(13964-size(approved));
  const bundle=pad({project:'vmeste',cardId:'example',claims,snapshots},51600);
  const card=pad({id:'example',name:'Invented course',town:'Example',sources:[{url}],research:{findings:[],remaining:[]}},3242,'intro');
  const rejectedDraft=pad({cardId:card.id,patch:{...card,age:'Changed age description'},practicalPatch:{},findings:[],remaining:[],
    bindings:claims.slice(0,12).map(c=>({field:'notes',source:c.source,quote:c.quote,claimKey:c.key,snapshotId:c.snapshotId,kind:c.kind,scope:c.scope})),snapshots},24463,'reviewLimitationsText');
  const verdicts=claims.map(c=>({key:c.key,verdict:'approve',reason:'Synthetic approval.'}));
  verdicts[0].reason+='x'.repeat(3372-size(verdicts));
  const payload={bundle,rejectedDraft,approved,verdicts,card,reviewFeedback:'F'.repeat(1306),reworkCount:1,cardRevision:digest(card)};
  pad(payload,98621,'fixtureContext');
  return {id:'fixture-job',kind:'integrate',card_id:card.id,input_revision:'fixture-rework',payload};
}

test('the rework fixture reproduces the reported input sizes without private data',t=>{
  const job=budgetFixture(),p=job.payload;
  for(const [key,expected] of Object.entries({bundle:51600,rejectedDraft:24463,approved:13964,verdicts:3372,card:3242}))assert.equal(size(p[key]),expected);
  assert.equal(p.reviewFeedback.length,1306);assert.equal(size(p),98621);assert.equal(p.bundle.claims.length,26);
  assert.deepEqual(p.bundle.snapshots.map(e=>e.text.length),[10784,1425]);
  const data=JSON.parse(promptFor(job).split('TASK DATA:\n')[1]);
  t.diagnostic(JSON.stringify({payload:size(p),prompt:promptFor(job).length,taskData:size(data),
    evidenceFiles:workerEvidenceFiles(job).length,evidenceBytes:workerEvidenceFiles(job).reduce((sum,row)=>sum+size(row.evidence),0),
    duplicateApprovedBytes:size(p.approved),duplicateSnapshotText:p.bundle.snapshots.reduce((sum,e)=>sum+e.text.length,0),
    unchangedDraftFields:Object.keys(p.rejectedDraft.patch).filter(key=>JSON.stringify(p.card[key])===JSON.stringify(p.rejectedDraft.patch[key]))}));
});

test('compact rework context preserves every distinct claim, snapshot and changed field',()=>{
  const job=budgetFixture(),original=structuredClone(job.payload),data=JSON.parse(promptFor(job).split('TASK DATA:\n')[1]);
  assert.equal(data.approved.length+data.bundle.claims.length,26);
  assert.deepEqual([...data.approved,...data.bundle.claims],original.bundle.claims);
  assert.deepEqual({...data.card,...data.rejectedDraft.patch},{...original.card,...original.rejectedDraft.patch});
  assert.deepEqual(data.rejectedDraft.bindings,original.rejectedDraft.bindings);
  assert.deepEqual(data.rejectedDraft.reviewLimitationsText,original.rejectedDraft.reviewLimitationsText);
  assert.equal(data.rejectedDraftHash,digest(original.rejectedDraft));
  const files=workerEvidenceFiles(job);assert.equal(files.length,2);assert.equal(data.evidence.length,2);
  assert.deepEqual(files.map(row=>row.evidence),original.bundle.snapshots);
  assert.deepEqual(data.bundle.snapshots,data.rejectedDraft.snapshots);
  for(const key of Object.keys(original.card))assert.ok(!Object.hasOwn(data.rejectedDraft.patch,key));
  assert.deepEqual(job.payload,original);
  // Conflicting content with a reused key or snapshot id must never disappear as a duplicate.
  job.payload.bundle.claims.push({...original.approved[0],quote:'A different exact quote.'});
  job.payload.rejectedDraft.snapshots.push({...original.bundle.snapshots[0],text:'A distinct capture with a reused id.'});
  const changed=JSON.parse(promptFor(job).split('TASK DATA:\n')[1]);
  assert.equal(changed.bundle.claims.length,15);assert.equal(changed.evidence.length,3);
  assert.equal(workerEvidenceFiles(job).length,3);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {JobQueue} from './jobs.mjs';
import {runJobs,runCodex,runClaude} from './agent-run.mjs';
import {inputLimit,workerInputSize,assertWorkerInput,canClaimWorker} from './worker-input.mjs';
const policy=JSON.parse(fs.readFileSync(new URL('./agent-policy.json',import.meta.url)));
function queueFixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-budget-')),queue=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{queue.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {queue,directory};
}

test('the whole rework fits the justified editor limit, with provider overhead reserved',()=>{
  const job=budgetFixture(),size=workerInputSize(job,policy);
  assert.ok(size.characters>60000);assert.equal(size.limit,90000);assert.equal(size.fits,true);
  assert.equal(inputLimit({...job,kind:'verify-facts'},policy),60000);
  assert.throws(()=>inputLimit(job,{roles:{editor:{maxInputChars:90000}}}),/Invalid worker input budget/);
  assert.throws(()=>inputLimit(job,{roles:{editor:{maxInputChars:120001,inputBudgetReason:'Reason'}}}),/Invalid worker input budget/);
  assert.doesNotThrow(()=>assertWorkerInput(job,policy,'x'.repeat(90000)));
  assert.throws(()=>assertWorkerInput(job,policy,'x'.repeat(90001)),error=>error.code==='INPUT_BUDGET');
});

test('oversized work blocks before a lease, retains evidence and does not starve fitting work',t=>{
  const {queue}=queueFixture(t),job=budgetFixture();job.payload.fixtureContext+='x'.repeat(100000);
  const oversized=queue.enqueue({kind:job.kind,cardId:job.card_id,inputRevision:'large',priority:100,payload:job.payload});
  const small=queue.enqueue({kind:'integrate',cardId:'small',inputRevision:'small',payload:{card:{id:'small'}}});
  const chosen=queue.claim('editor','editor',{canClaim:job=>canClaimWorker(queue,job,policy)});
  assert.equal(chosen.id,small.id);const blocked=queue.get(oversized.id);
  assert.equal(blocked.attempt,0);assert.equal(blocked.state,'await-source');assert.equal(blocked.token,null);
  assert.match(blocked.error,/evidence was not truncated/);assert.deepEqual(blocked.payload.bundle,job.payload.bundle);
  assert.deepEqual(blocked.payload.rejectedDraft,job.payload.rejectedDraft);assert.equal(queue.circuit(),null);
  assert.equal(queue.db.prepare("SELECT count(*) AS n FROM events WHERE job_id=? AND kind='claimed'").get(oversized.id).n,0);
});

test('source preparation that grows the input blocks once without calling a worker or committing',async t=>{
  const {queue,directory}=queueFixture(t),job=budgetFixture();let workers=0,commits=0;
  const added=queue.enqueue({kind:job.kind,cardId:job.card_id,inputRevision:'prepare',payload:job.payload});
  const result=await runJobs({queue,role:'editor',limit:1,syncImpl:()=>{},reportFile:path.join(directory,'report.json'),
    prepareImpl:async job=>({...job,payload:{...job.payload,freshContext:'x'.repeat(100000)}}),
    worker:async()=>{workers++;},commitImpl:()=>{commits++;}});
  assert.equal(workers,0);assert.equal(commits,0);assert.equal(queue.get(added.id).attempt,1);
  assert.equal(queue.get(added.id).state,'await-source');assert.equal(result.results[0].result.reason,'input-budget');
});

test('both worker adapters enforce the role limit before spawning a process',async()=>{
  const job=budgetFixture();job.payload.fixtureContext+='x'.repeat(100000);let spawned=0;
  const options={runImpl:()=>{spawned++;throw Error('Must not spawn');}};
  await assert.rejects(runCodex(job,policy,options),error=>error.code==='INPUT_BUDGET');
  await assert.rejects(runClaude(job,policy,{...options,authImpl:()=>{}}),error=>error.code==='INPUT_BUDGET');
  assert.equal(spawned,0);
});
