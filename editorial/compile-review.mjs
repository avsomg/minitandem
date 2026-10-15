import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadCatalog} from './quality.mjs';
import {digest} from './jobs.mjs';
import {validateDraft,validateFullReview,applyDraftRecord} from './workflow.mjs';
import {fullReviewFields} from './field-contract.mjs';
import {publicApprovedUpdates,approvalSummary} from './catalogue-journal.mjs';
import {PROJECT_ID} from './project-id.mjs';

// The English base in data.js already holds everything the old deep-review receipts and the old update journal contributed
// (migration/rebase-manifest.json lists them per card). This compiles only the journal of approvals made on top of that base.
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);
const PRIVATE_DIRS=['agent-artifacts','correction-versions'];
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));

// Every journal entry carries what is needed to apply and check it: the approved draft, the base record, the verifier's
// approval summary and the digests of the approval artifact and of the applied record. That check runs everywhere.
// The private agent artifacts and frozen records are not in the public repository. Where they exist (owner's machine, QA, release),
// each entry is also checked against them and a missing or different file fails. Without them (clean clone, Docker) the
// cross-check is skipped, which is allowed only for a public build and is reported.
export function verifyJournal(updates,{currentIds,privateRoot=here,publicOnly=false}={}){
  assert.equal(updates.schema,1);assert.equal(updates.project,PROJECT_ID);assert.ok(Array.isArray(updates.updates));
  const privateAvailable=PRIVATE_DIRS.every(dir=>fs.existsSync(path.join(privateRoot,dir)));
  if(!privateAvailable&&!publicOnly&&updates.updates.length)
    throw Error('Private approval artifacts are missing ('+PRIVATE_DIRS.map(d=>'editorial/'+d).join(', ')+'); only a --public build may skip the cross-check');
  for(const update of updates.updates){
    assert.match(update.approvalArtifact,/^[a-f0-9]{64}$/);
    assert.match(update.appliedRecordRevision,/^[a-f0-9]{64}$/);
    const approval=update.approval;
    assert.ok(approval,`Journal entry ${update.jobId} lacks its approval summary`);
    assert.equal(approval.role,'verify');assert.equal(approval.verdict,'approve');
    assert.equal(approval.draftHash,digest(update.draft),'Approval does not match the draft');
    assert.equal(digest(update.baseRecord),update.cardRevision,'Approved base revision mismatch');
    assert.ok(currentIds.has(update.draft.cardId),'Unknown approved card');
    validateDraft(update.draft,update.baseRecord,{historical:true});
    const changed=['research.findings','research.remaining',...Object.keys(update.draft.patch),
      ...Object.keys(update.draft.practicalPatch||{}).map(k=>'practical.'+k),...(update.draft.warnings?['practical.warnings']:[])];
    assert.ok(changed.every(field=>approval.checkedFields?.includes(field)),'Approval omits changed fields');
    if(update.draft.reviewCoverage){
      validateFullReview(update.draft,update.baseRecord,{date:update.approvedOn});
      assert.ok(fullReviewFields(update.baseRecord).every(field=>approval.checkedCoverage?.includes(field)),'Full review lacks independent coverage approval');
      assert.ok(approval.approvedBindings?.includes('review.coverage'),'Full review lacks coverage binding approval');
    }
    const applied=applyDraftRecord(update.baseRecord,update.draft,update.approvedOn);
    assert.equal(digest(applied),update.appliedRecordRevision,'Applied snapshot differs from approved patch');
    assert.deepEqual(applied.research,update.research);
    if(privateAvailable){
      const artifact=readJson(path.join(privateRoot,'agent-artifacts',update.approvalArtifact+'.json'));
      assert.equal(digest(artifact),update.approvalArtifact);assert.equal(artifact.project,PROJECT_ID);
      assert.equal(artifact.jobId,update.jobId);
      assert.deepEqual(approvalSummary(artifact.role,artifact.result),approval,'Journal approval differs from the private approval artifact');
      const frozen=readJson(path.join(privateRoot,'correction-versions',update.appliedRecordRevision+'.json'));
      assert.equal(digest(frozen),update.appliedRecordRevision);
      assert.deepEqual(frozen,applied,'Frozen applied record differs from the journal');
    }
  }
  return {privateCrossCheck:privateAvailable?'checked':updates.updates.length?'skipped: no private approval artifacts in this checkout':'nothing to check'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const updatesFile=path.join(here,'approved-updates.json');
  const updates=fs.existsSync(updatesFile)?readJson(updatesFile):{schema:1,project:PROJECT_ID,updates:[]};
  const currentIds=new Set(loadCatalog().ACTIVITIES.map(a=>a.id));
  const {privateCrossCheck}=verifyJournal(updates,{currentIds,publicOnly:process.argv.includes('--public')});
  const approved=publicApprovedUpdates(updates);
  const runtime=`/* Generated by editorial/compile-review.mjs from editorial/approved-updates.json. Approve changes through the controller, not in this file. */
(() => {
  window.APPROVED_UPDATES = ${JSON.stringify(approved,null,2)};
})();
`;
  fs.writeFileSync(path.join(root,'data-reviewed.js'),runtime);
  console.log(JSON.stringify({journalUpdates:updates.updates.length,applied:approved.length,superseded:updates.updates.length-approved.length,privateCrossCheck},null,2));
}
