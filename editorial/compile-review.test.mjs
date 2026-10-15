import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadCatalog,root} from './quality.mjs';
import {digest} from './jobs.mjs';
import {applyDraftRecord} from './workflow.mjs';
import {verifyJournal} from './compile-review.mjs';
import {migrateJournal} from './migrate-journal-approval-2026-10-15.mjs';

// The tracked journal is checked from its own entries; the private artifacts are built here, so these tests run on a clean clone.
const journal=()=>JSON.parse(fs.readFileSync(path.join(root,'editorial','approved-updates.json'),'utf8'));
const currentIds=new Set(loadCatalog().ACTIVITIES.map(card=>card.id));
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-compile-review-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');};
// A private checkout for the given journal: the approval artifact and the frozen applied record of every entry.
function privateCheckout(t,updates,{result=approval=>approval}={}){
  const dir=temp(t);
  for(const update of updates.updates){
    const {role,...summary}=update.approval;
    const artifact={project:updates.project,jobId:update.jobId,role,inputRevision:'test-input',result:result({...summary,reason:'Checked against the source.'})};
    update.approvalArtifact=digest(artifact);
    write(path.join(dir,'agent-artifacts',update.approvalArtifact+'.json'),artifact);
    write(path.join(dir,'correction-versions',update.appliedRecordRevision+'.json'),applyDraftRecord(update.baseRecord,update.draft,update.approvedOn));
  }
  return dir;
}

test('a clean clone (no private artifacts) builds the journal from its tracked entries and says the cross-check was skipped',t=>{
  const updates=journal();
  assert.ok(updates.updates.length,'the tracked journal holds an approved update');
  const empty=temp(t);
  assert.deepEqual(verifyJournal(updates,{currentIds,privateRoot:empty,publicOnly:true}),{privateCrossCheck:'skipped: no private approval artifacts in this checkout'});
  assert.throws(()=>verifyJournal(updates,{currentIds,privateRoot:empty}),/only a --public build may skip/);
});

test('without private artifacts the internal digests still bind approval, draft, base and applied record',t=>{
  const empty=temp(t),check=mutate=>{const updates=journal();mutate(updates.updates[0]);return ()=>verifyJournal(updates,{currentIds,privateRoot:empty,publicOnly:true});};
  assert.throws(check(u=>{delete u.approval;}),/lacks its approval summary/);
  assert.throws(check(u=>{u.approval.verdict='reject';}));
  assert.throws(check(u=>{u.approval.role='editor';}));
  assert.throws(check(u=>{u.draft.patch.schedule+=' (edited)';}),/does not match the draft/);
  assert.throws(check(u=>{u.approval.checkedFields=u.approval.checkedFields.filter(f=>f!=='schedule');}),/omits changed fields/);
  assert.throws(check(u=>{u.baseRecord.name+=' (edited)';}),/base revision/);
  assert.throws(check(u=>{u.research.remaining=[];}));
  assert.throws(check(u=>{u.appliedRecordRevision='0'.repeat(64);}),/Applied snapshot/);
});

test('with private artifacts every entry is also checked against them, and a missing or different one fails',t=>{
  const updates=journal(),dir=privateCheckout(t,updates);
  assert.deepEqual(verifyJournal(updates,{currentIds,privateRoot:dir}),{privateCrossCheck:'checked'});
  const differs=journal(),other=privateCheckout(t,differs,{result:r=>({...r,checkedFields:r.checkedFields.slice(1)})});
  assert.throws(()=>verifyJournal(differs,{currentIds,privateRoot:other}),/differs from the private approval artifact/);
  const missing=journal(),gone=privateCheckout(t,missing);
  fs.rmSync(path.join(gone,'correction-versions',missing.updates[0].appliedRecordRevision+'.json'));
  assert.throws(()=>verifyJournal(missing,{currentIds,privateRoot:gone,publicOnly:true}),/ENOENT/);
  const frozen=journal(),edited=privateCheckout(t,frozen);
  const file=path.join(edited,'correction-versions',frozen.updates[0].appliedRecordRevision+'.json');
  write(file,{...JSON.parse(fs.readFileSync(file,'utf8')),name:'Edited'});
  assert.throws(()=>verifyJournal(frozen,{currentIds,privateRoot:edited}));
});

test('the one-time migration adds the approval summary from the private artifact and leaves the approved content alone',t=>{
  const updates=journal(),dir=privateCheckout(t,updates),before=structuredClone(updates.updates[0]);
  delete updates.updates[0].approval;
  assert.deepEqual(migrateJournal(updates,{artifactsDir:path.join(dir,'agent-artifacts')}),[before.jobId]);
  assert.equal(digest(updates.updates[0]),digest(before));
  assert.deepEqual(migrateJournal(updates,{artifactsDir:path.join(dir,'agent-artifacts')}),[]);
});
