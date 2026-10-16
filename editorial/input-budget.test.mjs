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
