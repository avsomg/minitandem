// One-time migration of 15 October 2026, kept as the record of it. Journal entries written before commitResult stored the
// approval summary get it from their private approval artifact, so that compile-review.mjs can check them on a clean clone.
// Run on the owner's machine only (it needs editorial/agent-artifacts/). Entries that already have the summary are left alone;
// the approved content (draft, base record, research, digests) is not touched. Run it while no editorial cycle is running.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './jobs.mjs';
import {approvalSummary} from './catalogue-journal.mjs';
import {PROJECT_ID} from './project-id.mjs';

export function migrateJournal(journal,{artifactsDir}){
  assert.equal(journal.schema,1);assert.equal(journal.project,PROJECT_ID);
  const migrated=[];
  journal.updates=journal.updates.map(update=>{
    if(update.approval)return update;
    const artifact=JSON.parse(fs.readFileSync(path.join(artifactsDir,update.approvalArtifact+'.json'),'utf8'));
    assert.equal(digest(artifact),update.approvalArtifact);assert.equal(artifact.project,PROJECT_ID);assert.equal(artifact.jobId,update.jobId);
    migrated.push(update.jobId);
    // Same key order as commitResult writes: the summary follows the artifact digest.
    const {jobId,editorJobId,approvalArtifact,...rest}=update;
    return {jobId,editorJobId,approvalArtifact,approval:approvalSummary(artifact.role,artifact.result),...rest};
  });
  return migrated;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const here=path.dirname(fileURLToPath(import.meta.url)),file=path.join(here,'approved-updates.json');
  const journal=JSON.parse(fs.readFileSync(file,'utf8'));
  const migrated=migrateJournal(journal,{artifactsDir:path.join(here,'agent-artifacts')});
  if(migrated.length){
    const temp=file+'.tmp-migrate';fs.writeFileSync(temp,JSON.stringify(journal,null,2)+'\n');fs.renameSync(temp,file);
  }
  console.log(JSON.stringify({migrated},null,2));
}
