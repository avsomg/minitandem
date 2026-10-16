import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {root,loadCatalog} from './quality.mjs';
import {digest} from './jobs.mjs';
import {buildLedger,journalFields,ledgerCounts,validateLedger,summaryMarkdown,writeLedger,main} from './fact-ledger.mjs';
import {ledgerFixture,resealFixture,writeJson} from './fact-ledger-fixture.mjs';

// Copy the exact public entry at test time. Its private links below are synthetic,
// and do not claim to reproduce the owner's historical claims or verdicts.
const publicJournal=()=>{
  const journal=JSON.parse(fs.readFileSync(path.join(root,'editorial/approved-updates.json'),'utf8'));
  return {...journal,updates:journal.updates.filter(update=>update.jobId==='5d81def4-b10f-4018-b66f-8be6ad7c1612')};
};
const getRow=(ledger,field,id='fixture')=>ledger.cards.find(card=>card.id===id).fields.find(row=>row.field===field);
const queueFile=f=>path.join(f.editorial,'workflow-state/jobs.sqlite');
function mutateQueue(f,change){const db=new DatabaseSync(queueFile(f));try{change(db);}finally{db.close();}}
async function failedLedger(f){
  let failure;try{await buildLedger({root:f.root});}catch(error){failure=error;}
  assert.ok(failure?.ledger,'failure must keep per-field diagnostics');assert.equal(failure.ledger.complete,false);return failure;
}
function replayPublicDraft(t){
  const f=ledgerFixture(t),original=publicJournal().updates[0];
  f.base=original.baseRecord;f.draft=original.draft;f.setCards([f.base]);
  const eventBindings=f.draft.bindings.filter(binding=>binding.field==='events');
  f.claims.splice(0,f.claims.length,...f.draft.bindings.filter(binding=>['schedule','events'].includes(binding.field)).map(binding=>({
    key:binding.claimKey,field:binding.field,value:binding.field==='events'?[f.draft.patch.events[eventBindings.indexOf(binding)]]:f.draft.patch.schedule,
    status:'supported',kind:binding.kind,scope:binding.scope,source:binding.source,quote:binding.quote,snapshotId:binding.snapshotId,note:'Synthetic exact-value claim for the public draft regression.'})));
  f.bundle.cardId=f.draft.cardId;f.bundle.snapshots=f.draft.snapshots;
  f.payload.draft=f.draft;
  f.verdicts.splice(0,f.verdicts.length,...f.claims.map(claim=>({key:claim.key,verdict:'approve',reason:'Synthetic approval for the regression fixture.'})));
  f.update={...original,jobId:f.reviewer.id,editorJobId:'fixture-editor'};f.journal.updates=[f.update];
  mutateQueue(f,db=>{for(const job of [f.verifier,f.reviewer])db.prepare('UPDATE jobs SET card_id=? WHERE id=?').run(f.draft.cardId,job.id);});
  resealFixture(f);return f;
}

test('the exact committed journal covers schedule and events, independently of private verification',()=>{
  const journal=publicJournal(),committed=JSON.parse(fs.readFileSync(path.join(root,'editorial/approved-updates.json'),'utf8'));
  assert.deepEqual(journal.updates[0],committed.updates.find(update=>update.jobId===journal.updates[0].jobId),'the regression keeps the exact public entry, not a simplified shape');
  const update=journal.updates[0],fields=journalFields(journal);
  assert.equal(update.draft.cardId,'aef-estavayer-cafe');assert.equal(fields.size,2);
  assert.deepEqual([...fields.keys()],['aef-estavayer-cafe\nschedule','aef-estavayer-cafe\nevents']);
  assert.equal(update.approval.checkedFields.includes('status'),true);
  assert.equal(fields.has('aef-estavayer-cafe\nstatus'),false,'checking an unchanged field is not a journal patch');
  assert.equal(update.draft.patch.events[0].end,'');assert.equal(update.draft.patch.events[0].title,'');
  const cards=[{id:update.draft.cardId,fields:[...fields].map(([key,candidate])=>({field:key.split('\n')[1],origin:'inherited',
    journalCoverage:{jobId:update.jobId,approvedOn:update.approvedOn,bindingField:candidate.bindingField},verification:{reason:'claim-not-found',fatal:false}}))}];
  const counts=ledgerCounts(cards);assert.equal(counts.total.verified,0);assert.equal(counts.journalCovered,2);
  assert.equal(counts.journalUnverified,2);assert.deepEqual(counts.unverifiedReasons,{'claim-not-found':2});
});

test('coverage counts unique card fields and uses the latest nonsuperseded patch for each one',()=>{
  const journal=publicJournal(),first=journal.updates[0],later=structuredClone(first);
  later.jobId='later-public-shape';delete later.draft.patch.events;journal.updates.push(later);
  const fields=journalFields(journal);assert.equal(fields.size,2);
  assert.equal(fields.get('aef-estavayer-cafe\nschedule').update.jobId,later.jobId);
  assert.equal(fields.get('aef-estavayer-cafe\nevents').update.jobId,first.jobId);
  first.supersededBy=later.jobId;const remaining=journalFields(journal);
  assert.equal(remaining.size,1);assert.equal(remaining.has('aef-estavayer-cafe\nevents'),false);
});

test('the exact public entry still fails on missing private evidence but prints both covered fields',async t=>{
  const f=ledgerFixture(t),journal=publicJournal(),update=journal.updates[0];f.setCards([update.baseRecord]);
  writeJson(path.join(f.editorial,'approved-updates.json'),journal);
  const before=digest(journal),failure=await failedLedger(f),ledger=failure.ledger;
  assert.match(failure.message,/Missing artifact/);assert.equal(ledger.counts.journalCovered,2);assert.equal(ledger.counts.total.verified,0);
  assert.deepEqual(ledger.counts.unverifiedReasons,{'approval-artifact-missing':2});
  for(const field of ['schedule','events']){
    const row=getRow(ledger,field,update.draft.cardId);assert.equal(row.journalCoverage.jobId,update.jobId);
    assert.equal(row.verification.reason,'approval-artifact-missing');assert.equal(row.verification.fatal,true);
  }
  const lines=[],result=await main(['--root='+f.root,'--dry-run'],{log:line=>lines.push(line)});
  assert.equal(result.code,1);assert.match(lines[0],/Fact ledger failed: Missing artifact/);
  const output=JSON.parse(lines[1]);assert.equal(output.journalCovered,2);assert.equal(output.complete,false);
  assert.deepEqual(output.unverifiedFields.map(row=>row.field),['schedule','events']);
  assert.equal(lines.join('\n').includes('Vos prochains rendez-vous'),false,'diagnostics must not print quotes');
  assert.match(summaryMarkdown(ledger),/\| approval-artifact-missing \| 2 \|/);
  assert.throws(()=>writeLedger(ledger,path.join(f.editorial,'fact-ledger')),/Cannot write an incomplete/);
  assert.equal(fs.existsSync(path.join(f.editorial,'fact-ledger')),false);
  assert.equal(digest(JSON.parse(fs.readFileSync(path.join(f.editorial,'approved-updates.json'),'utf8'))),before);
});

test('the copied public draft format reaches verified when synthetic exact claims and all private links exist',async t=>{
  const f=replayPublicDraft(t),ledger=await buildLedger({root:f.root}),id='aef-estavayer-cafe';
  assert.deepEqual(f.draft,publicJournal().updates[0].draft,'retain the actual bindings, snapshots, empty event strings and prose');
  assert.equal(ledger.counts.journalCovered,2);assert.equal(ledger.counts.journalVerified,2);assert.equal(ledger.counts.journalUnverified,0);
  assert.equal(getRow(ledger,'schedule',id).origin,'verified');assert.equal(getRow(ledger,'events',id).origin,'verified');
  assert.equal(getRow(ledger,'events',id).evidence.length,3);assert.deepEqual(ledger.counts.unverifiedReasons,{});
});

for(const [reason,change] of [
  ['no-claim-key',f=>{delete f.draft.bindings[0].claimKey;}],
  ['claim-not-found',f=>{f.payload.approved=[f.claims[1]];}],
  ['claim-field-differs',f=>{f.claims[0].field='min';}],
  ['binding-differs',f=>{f.draft.bindings[0].snapshotId='0'.repeat(64);}],
  ['value-differs',f=>{f.claims[0].value=8;}],
  ['unknown-value',f=>{f.draft.patch.amount=null;}]
])test('a legitimately absent link keeps coverage and reports '+reason,async t=>{
  const f=ledgerFixture(t);change(f);resealFixture(f);const ledger=await buildLedger({root:f.root}),row=getRow(ledger,'amount');
  assert.notEqual(row.origin,'verified');assert.equal(row.verification.reason,reason);assert.equal(row.verification.fatal,false);
  assert.equal(ledger.complete,true);assert.equal(ledger.counts.journalCovered,2);assert.equal(ledger.counts.journalVerified,1);
  assert.equal(ledger.counts.total.inherited,ledger.counts.filled-ledger.counts.total.verified);
  assert.notEqual(ledger.counts.total.inherited,ledger.counts.filled-ledger.counts.journalCovered);
  assert.deepEqual(ledger.counts.unverifiedReasons,{[reason]:1});
  assert.match(summaryMarkdown(ledger),new RegExp('\\| '+reason+' \\| 1 \\|'));
});

test('a real-shaped journal event with an altered approved claim stays inherited with value-differs',async t=>{
  const f=replayPublicDraft(t);f.claims[1].value[0]={...f.claims[1].value[0],start:'10:00'};resealFixture(f);
  const ledger=await buildLedger({root:f.root}),row=getRow(ledger,'events','aef-estavayer-cafe');
  assert.equal(row.origin,'inherited');assert.equal(row.verification.reason,'value-differs');assert.equal(ledger.counts.journalCovered,2);
});

for(const [reason,remove] of [
  ['verdict-artifact-missing',f=>fs.rmSync(path.join(f.editorial,'agent-artifacts',f.verdictArtifact+'.json'))],
  ['verdict-artifact-missing',f=>mutateQueue(f,db=>db.prepare('DELETE FROM artifacts WHERE job_id=?').run(f.verifier.id))],
  ['snapshot-not-registered',f=>mutateQueue(f,db=>db.prepare('DELETE FROM captured_evidence').run())]
])test('required private evidence still fails loudly with per-field '+reason,async t=>{
  const f=ledgerFixture(t);remove(f);const failure=await failedLedger(f);
  assert.equal(failure.ledger.counts.journalCovered,2);assert.deepEqual(failure.ledger.counts.unverifiedReasons,{[reason]:2});
  for(const row of failure.ledger.cards[0].fields.filter(row=>row.journalCoverage)){
    assert.equal(row.verification.reason,reason);assert.equal(row.verification.fatal,true);
  }
  const lines=[];assert.equal((await main(['--root='+f.root],{log:line=>lines.push(line)})).code,1);
  assert.equal(JSON.parse(lines[1]).unverifiedFields.length,2);assert.equal(fs.existsSync(path.join(f.editorial,'fact-ledger')),false);
});

test('drift remains journal-covered and coverage metadata cannot be removed from a saved ledger',async t=>{
  const f=ledgerFixture(t);f.setCards([{...f.base,amount:12}]);const ledger=await buildLedger({root:f.root}),row=getRow(ledger,'amount');
  assert.equal(row.origin,'inherited');assert.equal(row.drift,true);assert.equal(row.verification.reason,'value-differs');
  assert.equal(row.verification.comparedWith,'journal');assert.equal(ledger.counts.journalCovered,2);
  const changed=structuredClone(ledger);delete getRow(changed,'amount').journalCoverage;changed.counts=ledgerCounts(changed.cards);
  assert.throws(()=>validateLedger(changed,loadCatalog({base:f.root}).ACTIVITIES,{journal:f.journal}),/journal coverage differs/);
});

test('a missing required claim bundle remains fatal even when a binding also lacks a key',async t=>{
  const f=ledgerFixture(t);f.bundle.claims=[];delete f.draft.bindings[0].claimKey;resealFixture(f);
  const failure=await failedLedger(f);assert.equal(getRow(failure.ledger,'amount').verification.reason,'claim-bundle-missing');
  assert.equal(getRow(failure.ledger,'amount').verification.fatal,true);assert.equal(failure.ledger.counts.journalCovered,2);
});
