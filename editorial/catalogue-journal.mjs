import {PROJECT_ID} from './project-id.mjs';
// What a journal entry keeps of the independent approval, so that a clean clone (no private agent artifacts) can check the entry
// on its own. The verifier's reasons stay in the private artifact; where it exists, compile-review.mjs checks this copy against it.
export const APPROVAL_FIELDS=['verdict','draftHash','checkedFields','approvedBindings','checkedCoverage'];
export function approvalSummary(role,result){
  return {role,...Object.fromEntries(APPROVAL_FIELDS.filter(key=>result?.[key]!==undefined).map(key=>[key,result[key]]))};
}
export function publicApprovedUpdates(journal){
  if(journal?.schema!==1||journal.project!==PROJECT_ID||!Array.isArray(journal.updates))throw Error('Invalid catalogue journal identity');
  return journal.updates.filter(update=>!update.supersededBy).map(({jobId,draft,approvedOn,baseRecord,research})=>({
    jobId,approvedOn,baseRecord,research,draft:{patch:draft.patch,practicalPatch:draft.practicalPatch,
      warnings:draft.warnings,cardId:draft.cardId,findings:draft.findings,remaining:draft.remaining}
  }));
}
