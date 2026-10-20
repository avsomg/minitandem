import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS,readExternalReviewInputs} from './external-review.mjs';
import {pipelineReport,readPipelineInputs,validateCandidate,validateCorrection,venueGroups,assertEditorialReady,recordRevision} from './external-pipeline.mjs';
import {loadCatalog,root} from './quality.mjs';
import fs from 'node:fs';
import path from 'node:path';

// Private-only tests need the owner's external review receipts, which are not in the public repository (see docs/publication-scope.md).
// On a clean clone they are skipped with this message; in the owner's workspace they run.
const SKIP_RECEIPTS=fs.existsSync(path.join(root,'editorial','external-review-receipts.json'))?false:
  'private-only: editorial/external-review-receipts.json is not present (clean clone)';

// The number of published cards, from editorial/profile.json (counted by profile.mjs from the data files), not a literal.
const publishedCards=()=>JSON.parse(fs.readFileSync(path.join(root,'editorial','profile.json'),'utf8')).catalog;

const records=[
  {id:'a',name:'Event A',town:'Fribourg',address:'Main 1, Fribourg',status:'active',
    region:'sarine',category:'play',events:[],sources:[{url:'https://example.org/a'}]},
  {id:'b',name:'Event B',town:'Fribourg',address:'Main 1, Fribourg',status:'active',
    region:'sarine',category:'play',events:[],sources:[{url:'https://example.org/b'}]}
];
const registry={schema:1,groups:[{id:'main',label:'Main venue',cardIds:['a','b']}]};
const baseline={schema:1,cutoffOn:'2026-09-29',ids:[]};
const channel={status:'searched',queries:['Event A Fribourg reviews'],results:[],note:'No usable result in this search.'};
const candidate={schema:1,id:'a',revision:'v1',collectedOn:'2026-09-29',reviewAfter:'2026-10-29',
  identityUrl:'https://example.org/a',name:'Event A',town:'Fribourg',address:'Main 1, Fribourg',
  channels:Object.fromEntries(CHANNELS.map(name=>[name,{...channel}]))};
const receiptChannel={result:'no-usable-evidence',queries:['Event A Fribourg reviews'],urls:[],note:'No usable result.'};
const receipt={id:'a',candidateRevision:'v1',checkedOn:'2026-09-29',reviewAfter:'2026-10-29',
  identityUrl:'https://example.org/a',evidenceOutcome:'no-usable-external-evidence',
  conclusion:'External search did not find card-specific evidence.',conflicts:[],
  channels:Object.fromEntries(CHANNELS.map(name=>[name,{...receiptChannel}]))};
const dispute={schema:1,id:'a',candidateRevision:'v1',openedOn:'2026-09-29',
  questions:[{key:'address-1',topic:'address',issue:'Conflicting entrance addresses.',
    urls:['https://example.org/a','https://directory.example.org/a']}]};
const decision={schema:1,id:'a',candidateRevision:'v1',disputeOpenedOn:'2026-09-29',
  decidedOn:'2026-09-29',rulings:[{key:'address-1',verdict:'resolved',
    reason:'Official event page names the visitor entrance.',urls:['https://example.org/a']}]};
const report=(receipts=[],candidates=new Map(),disputes=new Map(),decisions=new Map(),date='2026-09-29',corrections=new Map())=>
  pipelineReport(records,receipts,baseline,registry,candidates,disputes,decisions,date,corrections);

test('separate search, verification and adjudication queues retain every card',()=>{
  assert.deepEqual(report().summary,{search:2,verify:0,adjudicate:0,'await-source':0,editorial:0,verified:0});
  assert.deepEqual(report([] ,new Map([['a',candidate]])).queues.verify,['a']);
  assert.deepEqual(report([],new Map([['a',candidate]]),new Map([['a',dispute]])).queues.adjudicate,['a']);
  assert.deepEqual(report([],new Map([['a',candidate]]),new Map([['a',dispute]]),
    new Map([['a',decision]])).queues.verify,['a']);
  assert.equal(report([receipt],new Map([['a',candidate]]),new Map([['a',dispute]]),
    new Map([['a',decision]])).summary.verified,1);
});

test('new receipts cannot bypass search or an unresolved dispute',()=>{
  assert.throws(()=>report([receipt]),/bypasses search/);
  const unrelated={...receipt,channels:{...receipt.channels,
    photos:{...receiptChannel,queries:['unrelated photo search']}}};
  assert.throws(()=>report([unrelated],new Map([['a',candidate]])),/bypasses search/);
  assert.throws(()=>report([receipt],new Map([['a',candidate]]),new Map([['a',dispute]])),
    /bypasses search or adjudication/);
  const unresolved={...decision,reviewAfter:'2026-10-01',
    rulings:[{...decision.rulings[0],verdict:'unresolved',reason:'No dated primary confirmation.',urls:[]}]};
  assert.deepEqual(report([],new Map([['a',candidate]]),new Map([['a',dispute]]),
    new Map([['a',unresolved]])).queues['await-source'],['a']);
  assert.throws(()=>report([receipt],new Map([['a',candidate]]),new Map([['a',dispute]]),
    new Map([['a',unresolved]])),/bypasses search or adjudication/);
});

test('a refreshed candidate invalidates the previous dispute and decision',()=>{
  const refreshed={...candidate,revision:'v2'};
  assert.deepEqual(report([],new Map([['a',refreshed]]),new Map([['a',dispute]]),
    new Map([['a',decision]])).queues.verify,['a']);
  assert.deepEqual(report([receipt],new Map([['a',{...refreshed,collectedOn:'2026-09-29'}]])).queues.verify,['a']);
  assert.deepEqual(report([receipt],new Map([['a',{...refreshed,collectedOn:'2026-10-30',
    reviewAfter:'2026-11-30'}]]),new Map(),new Map(),'2026-10-30').queues.verify,['a']);
  assert.throws(()=>report([],new Map([['a',{...candidate,reviewAfter:'2026-09-29'}]])),
    /Invalid external candidate/);
});

test('address wording needs a sourced equivalence assessment, not exact string equality',()=>{
  const variant={...candidate,address:'Main Street 1, Fribourg'};
  assert.throws(()=>report([receipt],new Map([['a',variant]])),/Unreviewed candidate address/);
  const assessed={...receipt,addressReview:{outcome:'same-place',reason:'Official page names the same entrance.',
    urls:['https://example.org/a']}};
  assert.equal(report([assessed],new Map([['a',variant]])).summary.verified,1);
  const blank=records.map(record=>({...record,address:''}));
  assert.throws(()=>pipelineReport(blank,[assessed],baseline,{schema:1,groups:[]},new Map([['a',variant]]),
    new Map(),new Map(),'2026-09-29'),/Unreviewed candidate address/);
});

test('material address changes require an editorial proposal and leave the verified count',()=>{
  const variant={...candidate,address:'Main Street 2, Fribourg'};
  const assessed={...receipt,addressReview:{outcome:'correction-needed',
    reason:'The organizer gives a different entrance.',urls:['https://example.org/a']}};
  const correction={schema:1,id:'a',proposedOn:'2026-09-29',status:'proposed',
    source:'https://example.org/a',issue:'Public address points to old entrance.',
    proposal:'Replace with Main Street 2, Fribourg.'};
  assert.throws(()=>report([assessed],new Map([['a',variant]])),/Unreviewed candidate address/);
  assert.deepEqual(report([assessed],new Map([['a',variant]]),new Map(),new Map(),
    '2026-09-29',new Map([['a-2026-09-29',correction]])).queues.editorial,['a']);
  assert.throws(()=>report([assessed],new Map([['a',variant]]),new Map(),new Map(),
    '2026-09-29',new Map([['a-2026-09-29',{...correction,status:'applied',appliedOn:'2026-09-29'}]])),
    /Applied correction lacks checks/);
  const applied={...correction,status:'applied',appliedOn:'2026-09-29',
    checks:[{path:['address'],value:'Main 1, Fribourg'}]};
  assert.equal(report([assessed],new Map([['a',variant]]),new Map(),new Map(),
    '2026-09-29',new Map([['a-2026-09-29',applied]])).summary.verified,1);
  assert.throws(()=>report([assessed],new Map([['a',variant]]),new Map(),new Map(),
    '2026-09-29',new Map([['a-2026-09-29',{...applied,checks:[{path:['address'],value:'Wrong'}]}]])),
    /differs from catalogue/);
});

test('applied contact and source corrections check the final catalogue and reject unsafe paths',()=>{
  const record={...records[0],contacts:[{phone:'026 000 00 00'}],sources:[{url:'https://example.org/correct'}]};
  const applied={schema:1,id:'a',proposedOn:'2026-09-29',status:'applied',appliedOn:'2026-10-02',
    source:'https://example.org/correct',issue:'Wrong contact and source.',proposal:'Replace with official values.',
    checks:[{path:['contacts',0,'phone'],value:'026 000 00 00'},
      {path:['sources',0,'url'],value:'https://example.org/correct'}]};
  assert.equal(validateCorrection(applied,record),applied);
  assert.throws(()=>validateCorrection({...applied,checks:[{path:['contacts',0,'phone'],value:'old'}]},record),/differs from catalogue/);
  assert.throws(()=>validateCorrection({...applied,checks:[{path:['sources',1,'url'],value:'missing'}]},record),/differs from catalogue/);
  for(const path of [['contacts',-1,'phone'],['contacts','__proto__'],['sources','constructor']])
    assert.throws(()=>validateCorrection({...applied,checks:[{path,value:'unsafe'}]},record),/Invalid correction check path/);
});

test('venue context is explicit and cannot be inherited from an unchecked or different venue',()=>{
  const second={...candidate,id:'b',identityUrl:'https://example.org/b',name:'Event B',
    venueContextFrom:'a'};
  assert.throws(()=>report([],new Map([['b',second]])),/Unverified shared venue context/);
  assert.equal(report([receipt],new Map([['a',candidate],['b',second]])).summary.verify,1);
  const groups=venueGroups(records,registry);
  assert.throws(()=>validateCandidate({...candidate,venueContextFrom:'not-same'},records[0],groups),
    /Unsafe shared venue context/);
});
test('venue address grouping tolerates typography and an added postcode, not a different place',()=>{
  const group={schema:1,groups:[{id:'memo',label:'MEMO',cardIds:['a','b']}]};
  const pair=address=>[{id:'a',address:'Rue de l’Hôpital 2, Fribourg'},{id:'b',address}];
  assert.equal(venueGroups(pair("Rue de l'Hôpital 2, 1700 Fribourg"),group).get('b'),'memo');
  for(const address of ["Rue de l'Hôpital 4, Fribourg","Rue de l'Hôpital 2, Marly",'Spitalgasse 2, Freiburg',''])
    assert.throws(()=>venueGroups(pair(address),group),/spans addresses/);
  assert.throws(()=>venueGroups([{id:'a',address:"Rue de l'Hôpital 2, 1700 Fribourg"},
    {id:'b',address:"Rue de l'Hôpital 2, 1752 Fribourg"}],group),/spans addresses/);
});

test('a pending correction blocks release independently of a refreshed candidate or incomplete protocol',()=>{
  const correction={schema:1,id:'a',proposedOn:'2026-09-29',status:'proposed',source:'https://example.org/a',issue:'Wrong address.',proposal:'Check entrance.'};
  for(const receipts of [[],[receipt]]){
    const result=report(receipts,new Map([['a',{...candidate,revision:'v2'}]]),new Map(),new Map(),'2026-09-29',new Map([['fix',correction]]));
    assert.equal(result.rows.find(r=>r.id==='a').researchStage,'verify');
    assert.deepEqual(result.queues.editorial,['a']);assert.deepEqual(result.queues.verify,['a']);
    assert.throws(()=>assertEditorialReady(result),/corrections required/);
  }
});

test('applied historical corrections validate against an immutable application revision',()=>{
  const original={...records[0],price:'CHF 10'},revision=recordRevision(original);
  const correction={schema:1,id:'a',proposedOn:'2026-09-29',status:'applied',appliedOn:'2026-10-02',
    source:'https://example.org/a',issue:'Old tariff.',proposal:'Use current tariff.',appliedRecordRevision:revision,
    checks:[{path:['price'],value:'CHF 10'}]};
  assert.equal(validateCorrection(correction,{...original,price:'CHF 12'},{readVersion:()=>original}),correction);
  assert.throws(()=>validateCorrection(correction,original,{readVersion:()=>({...original,price:'wrong'})}),/snapshot/);
  assert.throws(()=>validateCorrection({...correction,checks:[{path:['price'],value:'wrong'}]},original,{readVersion:()=>original}),/differs from catalogue/);
});

test('closed cards retain historical evidence without entering the live pipeline',()=>{
  const closed=records.map(record=>record.id==='a'?{...record,status:'closed'}:record);
  const result=pipelineReport(closed,[receipt],baseline,registry,
    new Map([['a',candidate]]),new Map(),new Map(),'2026-09-29');
  assert.equal(result.records,1);
  assert.deepEqual(result.queues.search,['b']);
});

test('the venue registry reconciles with the current published catalogue',()=>{
  // Needs no receipts: without them every card is simply still to be searched. Candidates, disputes and decisions are read when present.
  const inputs=readPipelineInputs();
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
  const current=pipelineReport(loadCatalog().ACTIVITIES,[],inputs.receiptBaseline,
    inputs.registry,new Map(),new Map(),new Map(),today,new Map(),inputs.approvedUpdates);
  assert.equal(current.records,publishedCards());
  assert.equal(Object.values(current.summary).reduce((sum,value)=>sum+value,0),current.records,'every published card is in exactly one stage');
});

test('the real receipts reconcile with the current published catalogue',{skip:SKIP_RECEIPTS},()=>{
  const {receipts}=readExternalReviewInputs(),inputs=readPipelineInputs();
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
  const current=pipelineReport(loadCatalog().ACTIVITIES,receipts,inputs.receiptBaseline,
    inputs.registry,inputs.candidates,inputs.disputes,inputs.decisions,today,inputs.corrections,inputs.approvedUpdates);
  assert.equal(current.records,publishedCards());
  // Every receipt of a published card is current, held for editorial work, or explicitly
  // stale and back in verification. Closed cards keep their receipt as history only.
  const stageOf=new Map(current.rows.map(row=>[row.id,row.stage]));
  // A card can also be in editorial work without a receipt (a proposed correction, for example from the accuracy audit of 16 October
  // 2026), so only the editorial rows that hold a receipt are counted here.
  const withReceipt=new Set(receipts.map(receipt=>receipt.id));
  const staleAwaitingReview=current.staleAddressReceipts.filter(id=>stageOf.get(id)!=='editorial');
  const editorialWithReceipt=current.rows.filter(row=>row.stage==='editorial'&&withReceipt.has(row.id)).length;
  assert.equal(current.summary.verified+editorialWithReceipt+staleAwaitingReview.length,
    receipts.filter(receipt=>stageOf.has(receipt.id)).length);
});

test('the build reads the approval journal: it calls the one report that loads it, never pipelineReport directly',()=>{
  const build=fs.readFileSync(path.join(root,'build.mjs'),'utf8');
  assert.match(build,/assertEditorialReady\(currentPipelineReport\(records,receipts,today\)\)/);
  assert.doesNotMatch(build,/\bpipelineReport\(|readPipelineInputs\(/);
});

test('an approved later address update makes the earlier receipt stale instead of halting the queue',()=>{
  const moved=records.map(record=>record.id==='a'?{...record,address:'Main 1, building C, Fribourg'}:record);
  const update={approvedOn:'2026-10-03',baseRecord:{id:'a',address:'Main 1, Fribourg'},
    draft:{cardId:'a',patch:{address:'Main 1, building C, Fribourg'}}};
  const run=(updates,{date='2026-10-08',receipts=[receipt],reviewed=candidate}={})=>pipelineReport(moved,receipts,baseline,
    {schema:1,groups:[]},new Map([['a',reviewed]]),new Map(),new Map(),date,new Map(),updates);
  assert.throws(()=>run([]),/Unreviewed candidate address/);
  const stale=run([update]);
  assert.deepEqual(stale.staleAddressReceipts,['a']);assert.deepEqual(stale.queues.verify,['a']);assert.equal(stale.summary.verified,0);
  // Only the controller's own later address change excuses the old receipt.
  for(const unrelated of [{...update,approvedOn:'2026-09-28'},{...update,baseRecord:{id:'a',address:'Other 5, Fribourg'}},
    {...update,draft:{...update.draft,cardId:'b'}},{...update,draft:{cardId:'a',patch:{parentDetails:'With an adult.'}}}])
    assert.throws(()=>run([unrelated]),/Unreviewed candidate address/);
  // A stale receipt never counts as verified, even once its candidate is due for a new search.
  const expiring=run([update],{reviewed:{...candidate,reviewAfter:'2026-10-05'}});
  assert.deepEqual(expiring.queues.search,['a','b']);assert.equal(expiring.summary.verified,0);
  // A receipt written after the update must carry the address review itself.
  const later={...receipt,checkedOn:'2026-10-08',reviewAfter:'2026-11-08'};
  assert.throws(()=>run([update],{receipts:[later]}),/Unreviewed candidate address/);
  const reviewed=run([update],{receipts:[{...later,addressReview:{outcome:'same-place',
    reason:'Official page names building C at the same street address.',urls:['https://example.org/a']}}]});
  assert.deepEqual(reviewed.staleAddressReceipts,[]);assert.equal(reviewed.summary.verified,1);
});
