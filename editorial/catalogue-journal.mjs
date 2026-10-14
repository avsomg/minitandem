import {PROJECT_ID} from './project-id.mjs';
export function publicApprovedUpdates(journal){
  if(journal?.schema!==1||journal.project!==PROJECT_ID||!Array.isArray(journal.updates))throw Error('Invalid catalogue journal identity');
  return journal.updates.filter(update=>!update.supersededBy).map(({jobId,draft,approvedOn,baseRecord,research})=>({
    jobId,approvedOn,baseRecord,research,draft:{patch:draft.patch,practicalPatch:draft.practicalPatch,
      warnings:draft.warnings,cardId:draft.cardId,findings:draft.findings,remaining:draft.remaining}
  }));
}
