import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {JobQueue,digest,failureCategory,urgentJob} from './jobs.mjs';
import {commitResult,validateClaims,validateDraft,applyDraftRecord,citationProblems,taskSpecs,registerCaptured,validateBindings,mergeResearch,today,unprocessedSpecs,assertFullReviewPermission,retireStaleReadyJobs,orderDraftEvents,resumeAwaitingSources} from './workflow.mjs';
import {resolveFromDispositions} from './review.mjs';
import {snapshot} from './evidence.mjs';
import {modelRoute,promptFor} from './agent-run.mjs';
import {fullReviewFields} from './field-contract.mjs';
import {assertReleaseCurrent,sourceRevision} from './release.mjs';

const card={id:'a',name:'Exact course',town:'Fribourg',status:'active',min:2,max:5,age:'2–5 years',
  parent:'yes',languages:[],days:[1],events:[],address:'Main 1',schedule:'Mon',priceKind:'unknown',price:'To be confirmed',amount:null,
  sources:[{url:'https://example.org/course'}],notes:[],contacts:[],practical:{},checked:'2026-09-29',reviewAfter:'2026-10-29'};
const evidence=snapshot({url:'https://example.org/course',fetchedAt:'2026-10-02T08:00:00.000Z',text:'This exact course accepts children aged 2 to 5. Admission is free.'});
const bundle={project:'vmeste',cardId:'a',snapshots:[evidence],claims:[{key:'age',field:'min',value:2,status:'supported',scope:'exact-card',kind:'official',source:evidence.url,quote:'children aged 2 to 5',snapshotId:evidence.id,note:'Explicit range for this course.'}]};
const input={records:[card],receipts:[],candidates:new Map(),disputes:new Map(),decisions:new Map(),corrections:new Map(),
  registry:{schema:1,groups:[]},receiptBaseline:{schema:1,cutoffOn:'2026-09-29',ids:[]},
  pipeline:{rows:[{id:'a',researchStage:'search',editorialStatus:'clear'}]}};
function fixture(t){
  const outputRoot=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-workflow-test-'));
  const queue=new JobQueue(path.join(outputRoot,'queue/jobs.sqlite'),{now:()=> '2026-10-02T09:00:00.000Z'});
  t.after(()=>{queue.close();fs.rmSync(outputRoot,{recursive:true,force:true});});
  return {queue,outputRoot,getInputs:()=>input};
}
const draft={cardId:'a',patch:{min:2,age:'2–5 years'},findings:[{field:'Age',kind:'official',text:'Admission for ages 2–5.',url:'https://example.org/course'}],remaining:['The language of the session is not established.'],
  snapshots:[evidence],bindings:['min','age','research.findings.0'].map(field=>({field,source:evidence.url,quote:'children aged 2 to 5',kind:'official',scope:'exact-card',snapshotId:evidence.id}))};
test('a practical fact without its checked date is refused with the field and the reason named',()=>{
  const fact={value:null,text:'The price covers the whole course.',source:'https://example.org/course',checked:'2026-10-01'};
  validateDraft({...draft,practicalPatch:{costNote:fact}},card);
  const {checked,...undated}=fact;
  assert.throws(()=>validateDraft({...draft,practicalPatch:{costNote:undated}},card),/Invalid practical patch: costNote: checked needs a YYYY-MM-DD date/);
  assert.throws(()=>validateDraft({...draft,practicalPatch:{nonsense:fact}},card),/Invalid practical patch: nonsense: not a practical field/);
});
test('a draft whose public text contains Cyrillic is rejected, and source quotes are exempt',()=>{
  const russian='\u043f\u0440\u0438\u0432\u0435'; // a Russian word, written as escapes
  validateDraft(draft,card);
  for(const bad of [{...draft,patch:{...draft.patch,age:russian}},{...draft,patch:{...draft.patch,notes:['Fine.',russian]}},
    {...draft,findings:[{...draft.findings[0],text:russian}]},{...draft,findings:[{...draft.findings[0],field:russian}]},
    {...draft,remaining:[russian]},{...draft,warnings:[russian]},
    {...draft,practicalPatch:{indoor:{value:true,text:russian,source:'https://example.org/course',checked:'2026-10-01'}}}])
    assert.throws(()=>validateDraft(bad,card),/Public text must be English/);
  validateDraft({...draft,bindings:draft.bindings.map(b=>({...b,quote:russian}))},card);
  assert.throws(()=>validateDraft({...draft,remaining:[russian]},card),(error)=>failureCategory(error.message)==='contract');
});
test('full-card review needs fresh coverage sources and an explicit independent coverage verdict',t=>{
  const f=fixture(t),base={...card,min:null,max:null,age:'Age to be confirmed',parent:'unknown',days:[],address:'Address to be confirmed',schedule:'Schedule to be confirmed',addressPrecision:'area',parentDetails:'To be confirmed'};
  const reviewCoverage={mode:'full',fields:fullReviewFields(base).map(field=>({field,value:field.startsWith('practical.')?null:base[field]??null,
    outcome:field==='status'?'confirmed':'unknown',snapshotIds:[evidence.id],reason:'Source inspected; unresolved filter facts cleared.'}))};
  const full={...draft,patch:{checked:today()},reviewCoverage,bindings:[draft.bindings[2],
    {field:'review.status',source:evidence.url,quote:'This exact course accepts children',kind:'official',scope:'exact-card',snapshotId:evidence.id}]};
  registerCaptured(f.queue,evidence);assert.deepEqual(validateBindings(f.queue,full),['research.findings.0','review.status','review.coverage']);
  assert.throws(()=>validateBindings(f.queue,{...full,reviewCoverage:{...reviewCoverage,fields:reviewCoverage.fields.map(row=>({...row,snapshotIds:['missing']}))}}),/missing or stale/);
  const context={...f,getInputs:()=>({...input,records:[base]})};
  f.queue.enqueue({kind:'integrate',cardId:'a',inputRevision:'full',payload:{card:base,cardRevision:digest(base),primaryReviewStatus:'complete'}});
  const editor=f.queue.claim('editor','editor');commitResult(f.queue,{jobId:editor.id,token:editor.token,role:'editor',result:{draft:full}},context);
  const reviewer=f.queue.claim('verify','independent'),result={verdict:'approve',reason:'Reviewed complete coverage.',draftHash:digest(full),
    checkedFields:['checked','research.findings','research.remaining'],approvedBindings:['research.findings.0','review.status','review.coverage']};
  assert.throws(()=>commitResult(f.queue,{jobId:reviewer.id,token:reviewer.token,role:'verify',result},context),/coverage approval/);
  commitResult(f.queue,{jobId:reviewer.id,token:reviewer.token,role:'verify',result:{...result,checkedCoverage:fullReviewFields(base)}},context);
  assert.equal(f.queue.summary().fullyReviewedCards,1);
});
test('an editor cannot renew full review when independent source inspection is missing or incomplete',()=>{
  const full={patch:{checked:today()},reviewCoverage:{mode:'full'}};
  assert.throws(()=>assertFullReviewPermission(full,{}),/independent complete/);
  assert.throws(()=>assertFullReviewPermission(full,{primaryReviewStatus:'incomplete'}),/independent complete/);
  assert.throws(()=>assertFullReviewPermission({patch:{},reviewCoverage:{mode:'full'}},{primaryReviewStatus:'partial'}),/independent complete/);
  assertFullReviewPermission(full,{primaryReviewStatus:'complete'});
  assertFullReviewPermission({patch:{age:'Age to be confirmed'}},{primaryReviewStatus:'incomplete'});
});
test('independent incomplete review and its source limitations reach the editor without renewing checked',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  f.queue.enqueue({kind:'verify-facts',cardId:'a',inputRevision:'verify-full',payload:{card,cardRevision:digest(card),bundle,requestedReview:'full'}});
  const job=f.queue.claim('verify','independent');
  const result={verdicts:[{key:'age',verdict:'approve',reason:'Exact published range.'}]};
  assert.throws(()=>commitResult(f.queue,{jobId:job.id,token:job.token,role:'verify',result},f),/source-inspection outcome/);
  commitResult(f.queue,{jobId:job.id,token:job.token,role:'verify',result:{...result,fullReviewStatus:'incomplete',reviewLimitations:['Poster unavailable.']}},f);
  const editor=f.queue.claim('editor','editor');
  assert.equal(editor.payload.primaryReviewStatus,'incomplete');assert.deepEqual(editor.payload.reviewLimitations,['Poster unavailable.']);
  assert.deepEqual(editor.payload.verdicts,result.verdicts);
  commitResult(f.queue,{jobId:editor.id,token:editor.token,role:'editor',result:{draft}},f);
  const reviewer=f.queue.claim('verify','independent-patch');assert.deepEqual(reviewer.payload.verdicts,result.verdicts);
  commitResult(f.queue,{jobId:reviewer.id,token:reviewer.token,role:'verify',result:{verdict:'reject',draftHash:digest(draft),reason:'Revise the public description.'}},f);
  assert.deepEqual(f.queue.claim('editor','rework-editor').payload.verdicts,result.verdicts);
});

// Organisation contacts only (14 October 2026). The number is invented and joined at run time, so that no line of this file holds it.
const mobileNumber=['079','000','00','00'].join(' ');
test('a worker claim or an editor patch whose contact holds a Swiss mobile number is refused as a contract failure, by position only',()=>{
  const now='2026-10-02T09:00:00Z',office={name:'Course office',phone:'026 000 00 00',email:'info@example.org'};
  const contacts=[office,{name:'Course leader',phone:mobileNumber,email:''}];
  const claim={...bundle.claims[0],key:'contacts',field:'contacts',value:contacts};
  const refused=error=>error.message==='Invalid field value: contacts[1] holds a Swiss mobile number. Only organisation contacts are public (organisation name, landline, role address): leave this contact out, the source link leads families to it'&&
    failureCategory(error.message)==='contract';
  assert.throws(()=>validateClaims({...bundle,claims:[claim]},card,{now}),refused);
  assert.throws(()=>validateDraft({...draft,patch:{contacts}},card),refused);
  assert.equal(validateClaims({...bundle,claims:[{...claim,value:[office]}]},card,{now}).claims[0].value[0],office);
  validateDraft({...draft,patch:{contacts:[office]}},card);
});
test('claims require real matching fresh quotes and exact official scope for critical fields',()=>{
  assert.equal(validateClaims(bundle,card,{now:'2026-10-02T09:00:00Z'}),bundle);
  const change=patch=>({...bundle,claims:[{...bundle.claims[0],...patch}]});
  assert.throws(()=>validateClaims(change({quote:'fabricated'}),card,{now:'2026-10-02T09:00:00Z'}),/quote/);
  assert.throws(()=>validateClaims(change({scope:'venue-only'}),card,{now:'2026-10-02T09:00:00Z'}),/exact official/);
  assert.throws(()=>validateClaims(change({kind:'visitor'}),card,{now:'2026-10-02T09:00:00Z'}),/exact official/);
  assert.throws(()=>validateClaims(bundle,card,{now:'2026-10-20T09:00:00Z'}),/Stale/);
  assert.throws(()=>validateClaims({...bundle,project:'other-client'},card),/bundle/);
  const wrongType={...bundle,claims:[{...bundle.claims[0],field:'practical.booking',value:'No registration'}]};
  assert.throws(()=>validateClaims(wrongType,card,{now:'2026-10-02T09:00:00Z'}),/value type/);
});
test('a numeric claim must find its figure in its own quote, in digits or words, and a refusal is a contract failure',()=>{
  const now='2026-10-02T09:00:00Z',fetchedAt='2026-10-02T08:00:00.000Z';
  const page=snapshot({url:'https://example.org/atelier',fetchedAt,text:'Kinder von 2 bis 4 Jahren. Eintritt CHF 12.50. Maximal acht Personen. Dauer: 10:00 – 10:45. De deux à quatre ans.'});
  let count=0;
  const claim=(field,value,quote)=>({key:field+'-'+count++,field,value,status:'supported',scope:'exact-card',kind:'official',source:page.url,quote,snapshotId:page.id,note:'Published for this course.'});
  const check=(...claims)=>validateClaims({project:'vmeste',cardId:'a',snapshots:[page],claims},card,{now});
  check(claim('min',2,'Kinder von 2 bis 4 Jahren'),claim('max',4,'Kinder von 2 bis 4 Jahren'),claim('amount',12.5,'Eintritt CHF 12.50'),
    claim('practical.groupSize',8,'Maximal acht Personen'),claim('practical.duration',45,'Dauer: 10:00 – 10:45'),claim('min',2,'De deux à quatre ans'),claim('max',4,'De deux à quatre ans'));
  for(const wrong of [claim('amount',15,'Eintritt CHF 12.50'),claim('max',6,'Kinder von 2 bis 4 Jahren'),claim('practical.groupSize',9,'Maximal acht Personen'),
    claim('practical.duration',60,'Dauer: 10:00 – 10:45'),claim('min',3,'De deux à quatre ans')]){
    assert.throws(()=>check(wrong),error=>/^Invalid field claim: .* is not written in its quote/.test(error.message)&&failureCategory(error.message)==='contract');
  }
  // Fields that are not numbers, and claims without a value, are not affected.
  check({...claim('priceKind','free','Eintritt CHF 12.50')},{...claim('amount',null,'Eintritt CHF 12.50'),status:'unknown',scope:'uncertain'});
});
test('a patched number needs a binding quote that writes it, even without an approved claim',t=>{
  const f=fixture(t),page=snapshot({url:'https://example.org/atelier',fetchedAt:'2026-10-02T08:00:00.000Z',text:'Kinder ab drei Jahren. Gruppen von maximal 8 Kindern. Anmeldung bis Freitag.'});
  registerCaptured(f.queue,page);
  const bind=(field,quote)=>({field,source:page.url,quote,kind:'official',scope:'exact-card',snapshotId:page.id});
  const make=(patch,practicalPatch,...bindings)=>({...draft,snapshots:[page],findings:[{...draft.findings[0],url:page.url}],patch,practicalPatch,bindings:[...bindings,bind('research.findings.0','Anmeldung bis Freitag')]});
  assert.deepEqual(validateBindings(f.queue,make({min:3},{},bind('min','Kinder ab drei Jahren'))),['min','research.findings.0']);
  assert.deepEqual(validateBindings(f.queue,make({},{groupSize:{value:8,source:page.url}},bind('practical.groupSize','Gruppen von maximal 8 Kindern'))),['practical.groupSize','research.findings.0']);
  assert.throws(()=>validateBindings(f.queue,make({min:4},{},bind('min','Kinder ab drei Jahren'))),/Patch number not written in its evidence quote: min/);
  assert.throws(()=>validateBindings(f.queue,make({},{groupSize:{value:10,source:page.url}},bind('practical.groupSize','Gruppen von maximal 8 Kindern'))),/not written in its evidence quote: practical.groupSize/);
  // One quote among the field's bindings is enough; clearing a bound to null is not a figure.
  validateBindings(f.queue,make({min:3},{},bind('min','Anmeldung bis Freitag'),bind('min','Kinder ab drei Jahren')));
  assert.deepEqual(validateBindings(f.queue,make({max:null},{},{...bind('max','Kinder ab drei Jahren'),transformation:'clear-unconfirmed',reason:'No stated upper age.'})),['max','research.findings.0']);
});
test('draft validation rejects unsafe fields, reversed age and invalid calendar times',()=>{
  assert.equal(validateDraft(draft,card),draft);
  assert.throws(()=>validateDraft({...draft,patch:{min:6,max:2}},card),/patched card/);
  assert.throws(()=>validateDraft({...draft,patch:{privateFamilyData:{}}},card),/Unsupported/);
  assert.throws(()=>validateDraft({...draft,patch:{events:[{date:'2026-10-02',start:'12:00',end:'11:00'}]}},card),/field value type: events/);
  assert.throws(()=>validateDraft({...draft,patch:{scheduleValidThrough:null,events:[{date:'2026-10-28',start:'09:00',end:'11:00'}]}},card),/Cannot clear/);
});
test('research and editorial jobs coexist instead of hiding a correction',()=>{
  const data={...input,corrections:new Map([['fix',{id:'a',status:'proposed'}]]),
    pipeline:{rows:[{id:'a',researchStage:'verify',editorialStatus:'required'}]}};
  assert.deepEqual(taskSpecs(data).map(s=>s.kind),['verify','editorial']);
});
test('a stale approval creates a scoped reapproval job, not a silent bypass',()=>{
  const update={jobId:'old',draft,approvedOn:'2026-09-29'};
  const data={...input,pipeline:{rows:[{id:'a',researchStage:'verified',editorialStatus:'clear'}]},
    staleUpdates:[{id:'a',jobId:'old'}],approvedUpdates:[update]};
  const specs=taskSpecs(data);assert.equal(specs.length,1);assert.equal(specs[0].kind,'editorial');
  assert.equal(specs[0].payload.staleApprovedUpdates[0].revision,digest(update));
});
test('an approved card change does not restart the same fact-research signal',t=>{
  const f=fixture(t),quality={queue:[{id:'a',stale:true,sourceIssues:[],watched:[],critical:[],priority:120}]};
  const original=taskSpecs({...input,pipeline:{rows:[]}},{quality,date:'2026-10-02'});
  f.queue.enqueue(original[0]);const job=f.queue.claim('search','researcher');f.queue.finish(job.id,job.token,'search',{});
  const changed=taskSpecs({...input,records:[{...card,age:'Updated public text'}],pipeline:{rows:[]}},{quality,date:'2026-10-02'});
  assert.notEqual(original[0].inputRevision,changed[0].inputRevision);
  assert.equal(unprocessedSpecs(f.queue,changed).length,0);
  const nextWeek=taskSpecs({...input,pipeline:{rows:[]}},{quality,date:'2026-10-09'});
  assert.equal(unprocessedSpecs(f.queue,nextWeek).length,1);
});
test('stale cards request a full primary review, while source signals and family reports stay scoped',t=>{
  const f=fixture(t),row={id:'a',stale:false,sourceIssues:[{id:'signal',kind:'content-changed'}],watched:[],critical:[],priority:120};
  const data={...input,pipeline:{rows:[]}},date='2026-10-02';
  const partial=taskSpecs(data,{quality:{queue:[row]},date})[0];
  assert.equal(partial.payload.requestedReview,'partial');
  assert.equal(partial.payload.triggerRevision,digest(['facts','a',card.sources.map(s=>s.url),[],
    [{id:'signal',kind:'content-changed'}]]));
  f.queue.enqueue(partial);const job=f.queue.claim('search','researcher');f.queue.finish(job.id,job.token,'search',{});
  const full=taskSpecs(data,{quality:{queue:[{...row,stale:true}]},date})[0];
  assert.equal(full.payload.requestedReview,'full');
  assert.notEqual(full.payload.triggerRevision,partial.payload.triggerRevision);
  assert.equal(unprocessedSpecs(f.queue,[full]).length,1);
  const intake=taskSpecs({...data,intakeReports:new Map([['report',{status:'pending-review',report:{activity:'a',topic:'address'}}]])},{date})[0];
  assert.equal(intake.payload.requestedReview,'partial');
});
// Until 22 October 2026 a report reached the workers as its topic alone, so the editors could not hand over the contradictions their own
// review of the card texts had found. The researcher still gets no more than the topic and fields: the text would anchor its extraction.
test('a report reaches the editor and the reviewer whole, and the researcher as its topic and fields',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  const report={activity:'a',topic:'Address or closure',message:'notes[1] says second floor; practical.access says first floor.',source:'https://example.org/course',date:'2026-10-22'};
  const spec=taskSpecs({...input,pipeline:{rows:[]},intakeReports:new Map([['r',{status:'pending-review',report,fields:['address','practical.access']}]])},{date:'2026-10-22'})[0];
  assert.deepEqual(spec.payload.reportedIssue,{topic:report.topic,message:report.message,source:report.source,fields:['address','practical.access']});
  assert.equal(urgentJob(spec),true);
  f.queue.enqueue(spec);
  const search=f.queue.claim('search','search'),research=promptFor(search);
  assert.doesNotMatch(research,/second floor/);assert.match(research,/"reportedIssue":\{"topic":"Address or closure","fields":\["address","practical\.access"\]\}/);
  assert.match(research,/Research those fields as well/);
  commitResult(f.queue,{jobId:search.id,token:search.token,role:'search',result:{bundle}},f);
  const verify=f.queue.claim('verify','verify');assert.deepEqual(verify.payload.reportedIssue,spec.payload.reportedIssue);
  commitResult(f.queue,{jobId:verify.id,token:verify.token,role:'verify',result:{verdicts:[{key:'age',verdict:'approve',reason:'Published for this course.'}]}},f);
  const editor=f.queue.list().find(job=>job.kind==='integrate');
  assert.deepEqual(editor.payload.reportedIssue,spec.payload.reportedIssue);
  assert.match(promptFor(editor),/second floor/);assert.match(promptFor(editor),/so that no contradiction it names is left/);
  assert.doesNotMatch(promptFor({id:'j',kind:'integrate',input_revision:'r',payload:{card}}),/reportedIssue is/);
});
test('stale workers cannot change shared files',t=>{
  const f=fixture(t);const spec=taskSpecs(input)[0];f.queue.enqueue({...spec,payload:{...spec.payload,cardRevision:'old'}});
  const job=f.queue.claim('search','one');
  assert.throws(()=>commitResult(f.queue,{jobId:job.id,token:job.token,role:'search',result:{}},f),/stale/);
  assert.equal(f.queue.summary().artifacts,0);
});
test('a handled partial source signal stays handled across weeks and card edits, while a new version creates work',t=>{
  const {queue}=fixture(t),row={id:'a',stale:false,sourceIssues:[{id:'notice',sourceId:'source',kind:'content-changed'}],watched:['source'],critical:[],priority:120};
  const data={...input,pipeline:{rows:[]}},monitor={sources:{source:{hash:'v1'}}};
  const specs=date=>taskSpecs(data,{quality:{queue:[row]},monitor,date});
  const first=specs('2026-10-02')[0];queue.enqueue(first);const job=queue.claim('search','reader');queue.finish(job.id,job.token,'search',{});
  queue.recordDisposition(job,'done');
  assert.equal(unprocessedSpecs(queue,specs('2026-10-09')).length,0);
  monitor.sources.source.hash='v2';assert.equal(unprocessedSpecs(queue,specs('2026-10-09')).length,1);
  const stale=taskSpecs(data,{quality:{queue:[{...row,stale:true}]},monitor,date:'2026-10-09'});
  assert.equal(unprocessedSpecs(queue,stale).length,1);
});
test('await-source persists a resume condition and resumes once for a new source version without retrying old claims',t=>{
  const f=fixture(t),monitor={sources:{source:{hash:'v1'}},queue:[]};registerCaptured(f.queue,evidence);
  const row={kind:'verify-facts',cardId:'a',inputRevision:'blocked',payload:{card,cardRevision:digest(card),bundle,sourceVersions:[['source','v1']]}};
  f.queue.enqueue(row);const job=f.queue.claim('verify','reader');
  commitResult(f.queue,{jobId:job.id,token:job.token,role:'verify',result:{verdicts:[{key:'age',verdict:'await-source',reason:'Relevant source is missing.'}]}},f);
  const waiting=f.queue.get(job.id);assert.equal(waiting.state,'await-source');assert.equal(waiting.payload.resumeWhen.sources[0].version,'v1');
  assert.deepEqual(resumeAwaitingSources(f.queue,input,monitor),[]);
  monitor.sources.source.hash='v2';const ids=resumeAwaitingSources(f.queue,input,monitor);assert.equal(ids.length,1);
  const fresh=f.queue.get(ids[0]);assert.equal(fresh.kind,'facts');assert.equal(fresh.attempt,0);assert.equal(fresh.payload.sourceVersions[0][1],'v2');
  assert.equal(f.queue.get(job.id).attempt,1);assert.deepEqual(resumeAwaitingSources(f.queue,input,monitor),[]);
  f.queue.reconcile([]);assert.equal(f.queue.get(fresh.id).state,'ready');
});
test('date and source-restored resume events are explicit and do not repeat',t=>{
  const {queue}=fixture(t),monitor={sources:{source:{hash:'same',error:null,lastSuccess:'2026-10-04T10:00:00Z'}},queue:[]};
  for(const [id,resumeWhen] of [['date',{sources:[],date:'2026-10-04'}],['restored',{sources:[{id:'source',version:'same',unavailable:true,lastSuccess:'2026-10-01T10:00:00Z'}]}]]){
    const j=queue.enqueue({kind:'verify-facts',cardId:'a',inputRevision:id,payload:{card,resumeWhen}});
    queue.db.prepare("UPDATE jobs SET state='await-source' WHERE id=?").run(j.id);
  }
  const first=resumeAwaitingSources(queue,input,monitor,'2026-10-03');assert.equal(first.length,1);
  assert.equal(resumeAwaitingSources(queue,input,monitor,'2026-10-04').length,1);
  assert.equal(resumeAwaitingSources(queue,input,monitor,'2026-10-05').length,0);
});
test('a shared monitor task resolves only after all affected cards have approved the current version and signal',()=>{
  const task={id:'t',sourceId:'s',kind:'content-changed',recordIds:['a','b'],status:'open'},state={sources:{s:{hash:'v2'}},queue:[task]};
  const row={source_id:'s',source_version:'v2',signal:'content-changed:t:'+digest({}),state:'done'};
  assert.deepEqual(resolveFromDispositions(state,[{...row,card_id:'a'}]),[]);
  assert.deepEqual(resolveFromDispositions(state,[{...row,card_id:'a'},{...row,card_id:'b',state:'await-source'}]),[]);
  assert.deepEqual(resolveFromDispositions(state,[{...row,card_id:'a'},{...row,card_id:'b'}]),['t']);
});
test('the controller refuses an editor draft whose public text is not English, and nothing is written',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);f.queue.enqueue({kind:'integrate',cardId:'a',inputRevision:'russian',payload:{card,cardRevision:digest(card)}});
  const editor=f.queue.claim('editor','editor'),russian='\u043f\u0440\u0438\u0432\u0435';
  assert.throws(()=>commitResult(f.queue,{jobId:editor.id,token:editor.token,role:'editor',result:{draft:{...draft,findings:[{...draft.findings[0],text:russian}]}}},f),/Public text must be English/);
  assert.equal(f.queue.summary().artifacts,0);assert.equal(f.queue.list().filter(job=>job.kind==='review-patch').length,0);
  assert.equal(fs.existsSync(path.join(f.outputRoot,'editorial/approved-updates.json')),false);
});
test('editor draft requires an independent full-field approval before a catalogue update',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);f.queue.enqueue({kind:'integrate',cardId:'a',inputRevision:'v1',payload:{card,cardRevision:digest(card)}});
  const editor=f.queue.claim('editor','editor');
  commitResult(f.queue,{jobId:editor.id,token:editor.token,role:'editor',result:{draft}},f);
  assert.equal(fs.existsSync(path.join(f.outputRoot,'editorial/approved-updates.json')),false);
  const verifier=f.queue.claim('verify','editor');
  assert.throws(()=>commitResult(f.queue,{jobId:verifier.id,token:verifier.token,role:'verify',result:{verdict:'approve',reason:'OK',draftHash:digest(draft),checkedFields:['min','age']}},f),/own draft/);
  f.queue.db.prepare('UPDATE jobs SET owner=? WHERE id=?').run('independent',verifier.id);
  assert.throws(()=>commitResult(f.queue,{jobId:verifier.id,token:verifier.token,role:'verify',result:{verdict:'approve',reason:'OK',draftHash:digest(draft),checkedFields:['min']}},f),/omits/);
  commitResult(f.queue,{jobId:verifier.id,token:verifier.token,role:'verify',result:{verdict:'approve',reason:'All fields checked against exact source.',draftHash:digest(draft),
    checkedFields:['min','age','research.findings','research.remaining'],approvedBindings:['min','age','research.findings.0']}},f);
  const journal=JSON.parse(fs.readFileSync(path.join(f.outputRoot,'editorial/approved-updates.json'),'utf8'));
  assert.equal(journal.updates.length,1);assert.equal(journal.updates[0].draft.cardId,'a');
  assert.match(journal.updates[0].approvalArtifact,/^[a-f0-9]{64}$/);
  // The entry carries the approval summary that lets a clean clone check it without the private artifact.
  assert.deepEqual(journal.updates[0].approval,{role:'verify',verdict:'approve',draftHash:digest(draft),
    checkedFields:['min','age','research.findings','research.remaining'],approvedBindings:['min','age','research.findings.0']});
  // The next sync sees the card as the approval left it; the QA it requested must survive that.
  const pending=f.queue.list().find(j=>j.kind==='qa'),approvedCard={...card,name:card.name+' (as approved)'};
  assert.notEqual(digest(approvedCard),pending.payload.cardRevision);
  assert.deepEqual(retireStaleReadyJobs(f.queue,[approvedCard]),[]);
  assert.equal(f.queue.get(pending.id).state,'ready');assert.equal(f.queue.claim('qa','tester').id,pending.id);
});
test('internally consistent worker-supplied snapshots are not controller evidence',t=>{
  const f=fixture(t);f.queue.enqueue({kind:'facts',cardId:'a',inputRevision:'v1',payload:{card,cardRevision:digest(card)}});
  const job=f.queue.claim('search','researcher');
  assert.throws(()=>commitResult(f.queue,{jobId:job.id,token:job.token,role:'search',result:{bundle}},f),/controller capture provenance/);
  assert.equal(f.queue.summary().artifacts,0);
});
test('draft values and new price numbers cannot contradict approved evidence',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  assert.throws(()=>validateBindings(f.queue,{...draft,patch:{min:3,age:'2–5 years'}},bundle.claims),/contradicts approved value/);
  const price={...draft,patch:{price:'CHF 100'},bindings:[...draft.bindings,{field:'price',source:evidence.url,quote:'Admission is free.',kind:'official',scope:'exact-card',snapshotId:evidence.id}]};
  assert.throws(()=>validateBindings(f.queue,price),/New price numbers/);
});
test('partial enrichment retains prior findings and unresolved questions',()=>{
  const old={...card,research:{findings:[{field:'Visit',kind:'official',text:'Old independently supported fact',url:evidence.url}],remaining:['Lift unknown.']}};
  const merged=mergeResearch(old,draft,'2026-10-02');
  assert.equal(merged.findings.length,2);assert.deepEqual(merged.remaining,['Lift unknown.','The language of the session is not established.']);
});
test('prose may derive from an approved claim but practical booleans must preserve its value',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  const prose={...draft,patch:{notes:['Age 2–5 years.']},bindings:[
    {field:'notes',source:evidence.url,quote:'children aged 2 to 5',kind:'official',scope:'exact-card',snapshotId:evidence.id,claimKey:'age'},
    draft.bindings[2]]};
  assert.deepEqual(validateBindings(f.queue,prose,bundle.claims),['notes','research.findings.0']);
  const booking={...bundle.claims[0],key:'booking',field:'practical.booking',value:true};
  const conflict={...draft,patch:{},practicalPatch:{booking:{value:false}},bindings:[draft.bindings[2],
    {field:'practical.booking',source:evidence.url,quote:booking.quote,kind:'official',scope:'exact-card',snapshotId:evidence.id,claimKey:'booking'}]};
  assert.throws(()=>validateBindings(f.queue,conflict,[booking]),/contradicts approved value/);
  const clear={...draft,patch:{max:null},bindings:[draft.bindings[2],
    {field:'max',source:evidence.url,quote:bundle.claims[0].quote,kind:'official',scope:'exact-card',snapshotId:evidence.id,
      claimKey:'age',transformation:'clear-unconfirmed',reason:'No independently approved numeric upper limit.'}]};
  assert.deepEqual(validateBindings(f.queue,clear,bundle.claims),['max','research.findings.0']);
  assert.throws(()=>validateBindings(f.queue,{...clear,patch:{max:7}},bundle.claims),/match an approved claim/);
  const duration={...bundle.claims[0],key:'duration',field:'practical.duration',value:30};
  const wrongDuration={...draft,patch:{},practicalPatch:{duration:{value:300}},bindings:[draft.bindings[2],
    {field:'practical.duration',source:evidence.url,quote:duration.quote,kind:'official',scope:'exact-card',snapshotId:evidence.id,claimKey:'duration'}]};
  assert.throws(()=>validateBindings(f.queue,wrongDuration,[duration]),/contradicts approved value/);
});
// A page that lists dated sessions on separate lines: the search worker approves each as its own events claim.
const page=snapshot({url:'https://example.org/course',fetchedAt:'2026-10-02T08:00:00.000Z',
  text:'Playgroup, Main 1.\nTue 20.10.26 09:30-10:30\nTue 27.10.26 09:30-10:30\nTue 03.11.26 09:30-10:30\nEarly group Tue 20.10.26 08:00-10:30\nEvery Tuesday until 17.11.26.'});
const session=(date,start='09:30')=>({date,start,end:'10:30',title:'Playgroup',address:'Main 1'});
const sessionLines=['Tue 20.10.26 09:30-10:30','Tue 27.10.26 09:30-10:30','Tue 03.11.26 09:30-10:30'];
const sessions=[session('2026-10-20'),session('2026-10-27'),session('2026-11-03')];
const claimOf=(key,field,value,quote)=>({key,field,value,status:'supported',scope:'exact-card',kind:'official',source:page.url,quote,snapshotId:page.id,note:'Published on the course page.'});
const eventClaims=sessions.map((s,i)=>claimOf('event-'+i,'events',[s],sessionLines[i]));
const composedApproved=[...eventClaims,claimOf('days','days',[2],'Every Tuesday'),claimOf('until','scheduleValidThrough','2026-11-17','until 17.11.26')];
const bindingFor=(field,claim)=>({field,source:claim.source,quote:claim.quote,kind:'official',scope:'exact-card',snapshotId:page.id,claimKey:claim.key});
const composed={cardId:'a',patch:{events:sessions,days:[2],scheduleValidThrough:'2026-11-17'},
  findings:[{field:'Dates',kind:'official',text:'Three Tuesday sessions are published.',url:page.url}],remaining:[],snapshots:[page],
  bindings:[...eventClaims.map(c=>bindingFor('events',c)),bindingFor('days',composedApproved[3]),bindingFor('scheduleValidThrough',composedApproved[4]),
    {field:'research.findings.0',source:page.url,quote:sessionLines[0],kind:'official',scope:'exact-card',snapshotId:page.id}]};
const withEvents=(events,more={})=>({...composed,patch:{...composed.patch,events},...more});
test('events approved one session per claim can be listed together when every session and its claim binding are present',t=>{
  const f=fixture(t);registerCaptured(f.queue,page);
  assert.deepEqual(validateBindings(f.queue,composed,composedApproved),['events','days','scheduleValidThrough','research.findings.0']);
  validateDraft(composed,card);
  // Any subset of the approved sessions, with only the bindings of the claims it draws from; element key order does not matter.
  const reordered={address:'Main 1',title:'Playgroup',end:'10:30',start:'09:30',date:'2026-10-20'};
  validateBindings(f.queue,withEvents([reordered],{bindings:composed.bindings.filter(b=>b.field!=='events'||b.claimKey==='event-0')}),composedApproved);
});
test('a composed events list refuses an unapproved session, an altered session, a missing claim binding and an empty list',t=>{
  const f=fixture(t);registerCaptured(f.queue,page);
  const reject=(draft,pattern,approved=composedApproved)=>assert.throws(()=>validateBindings(f.queue,draft,approved),pattern);
  reject(withEvents([...sessions,session('2026-11-10')]),/contradicts approved value: events; no approved claim lists .*2026-11-10/);
  reject(withEvents([sessions[0],{...sessions[1],start:'09:45'},sessions[2]]),/no approved claim lists .*09:45/);
  reject(withEvents([sessions[0],{...sessions[1],end:'11:00'},sessions[2]]),/no approved claim lists .*11:00/);
  reject(withEvents([sessions[0],{...sessions[1],title:'Other group'},sessions[2]]),/no approved claim lists .*Other group/);
  reject(withEvents([sessions[0],{...sessions[1],address:'Side 9'},sessions[2]]),/no approved claim lists .*Side 9/);
  reject(withEvents([sessions[0],{date:'2026-10-27'},sessions[2]]),/no approved claim lists/);
  reject({...composed,bindings:composed.bindings.filter(b=>b.claimKey!=='event-1')},/Missing evidence binding for approved claim event-1: events/);
  // A supplementary quote without the claimKey does not stand in for the claim.
  reject({...composed,bindings:composed.bindings.map(b=>b.claimKey==='event-1'?{...b,claimKey:null}:b)},/Missing evidence binding for approved claim event-1: events/);
  // Clearing the list is not a composition of approved sessions.
  reject(withEvents([]),/contradicts approved value: events$/);
});
test('scalar exact fields and the other list fields still have to equal one whole approved claim',t=>{
  const f=fixture(t);registerCaptured(f.queue,page);
  const [days,until]=composedApproved.slice(3),thursday=claimOf('days-thu','days',[4],'Every Tuesday'),approved=[...composedApproved,thursday];
  const only=(patch,...claims)=>({...composed,patch,bindings:[...claims.map(c=>bindingFor(c.field,c)),composed.bindings.at(-1)]});
  const reject=(draft,pattern)=>assert.throws(()=>validateBindings(f.queue,draft,approved),pattern);
  assert.deepEqual(validateBindings(f.queue,only({scheduleValidThrough:'2026-11-17'},until),approved),['scheduleValidThrough','research.findings.0']);
  reject(only({scheduleValidThrough:'2026-11-24'},until),/contradicts approved value: scheduleValidThrough$/);
  // days: separately approved single-day claims do not add up to [2,4], and one claim still works as a whole.
  reject(only({days:[2,4]},days,thursday),/contradicts approved value: days$/);
  assert.deepEqual(validateBindings(f.queue,only({days:[4]},thursday),approved),['days','research.findings.0']);
});
test('a full review of a composed events list binds each session in review.events as well',t=>{
  const f=fixture(t);registerCaptured(f.queue,page);
  const row={field:'events',value:sessions,outcome:'confirmed',snapshotIds:[page.id],reason:'The dates are published.'};
  const review={...composed,patch:{},reviewCoverage:{mode:'full',fields:[row]},
    bindings:[composed.bindings.at(-1),...eventClaims.map(c=>bindingFor('review.events',c))]};
  assert.deepEqual(validateBindings(f.queue,review,composedApproved),['research.findings.0','review.events','review.coverage']);
  assert.throws(()=>validateBindings(f.queue,{...review,bindings:review.bindings.slice(0,-1)},composedApproved),/Missing evidence binding for approved claim event-2: review.events/);
  assert.throws(()=>validateBindings(f.queue,{...review,reviewCoverage:{mode:'full',fields:[{...row,value:[...sessions,session('2026-11-10')]}]}},composedApproved),/no approved claim lists .*2026-11-10/);
});
const composedJob=(t,payload={})=>{
  const f=fixture(t);registerCaptured(f.queue,page);
  f.queue.enqueue({kind:'integrate',cardId:'a',inputRevision:'composed',payload:{card,cardRevision:digest(card),approved:composedApproved,...payload}});
  return {...f,editor:f.queue.claim('editor','editor')};
};
test('a draft combining three separately approved single-session claims is accepted, reviewed and applied',t=>{
  const correction={schema:1,id:'a',proposedOn:today(),status:'proposed',source:page.url,issue:'Session dates are missing.',proposal:'List the published sessions.',requiredFields:['events']};
  const f=composedJob(t,{corrections:[{file:'fix',correction}]}),context={...f,getInputs:()=>({...input,corrections:new Map([['fix',correction]])})};
  commitResult(f.queue,{jobId:f.editor.id,token:f.editor.token,role:'editor',result:{draft:composed}},context);
  const review=f.queue.list().find(job=>job.kind==='review-patch'),reviewer=f.queue.claim('verify','independent');
  commitResult(f.queue,{jobId:reviewer.id,token:reviewer.token,role:'verify',result:{verdict:'approve',reason:'Every session matches the claim and quote of its binding.',
    draftHash:digest(review.payload.draft),checkedFields:['events','days','scheduleValidThrough','research.findings','research.remaining'],
    approvedBindings:['events','days','scheduleValidThrough','research.findings.0'],checkedCorrectionFiles:['fix']}},context);
  const read=file=>JSON.parse(fs.readFileSync(path.join(f.outputRoot,file),'utf8'));
  const [update]=read('editorial/approved-updates.json').updates;
  assert.deepEqual(update.draft.patch.events,sessions);
  assert.deepEqual(read(`editorial/correction-versions/${update.appliedRecordRevision}.json`).events,sessions);
  const closed=read('editorial/corrections/fix.json');
  assert.equal(closed.status,'applied');assert.deepEqual(closed.checks.find(check=>check.path[0]==='events').value,sessions);
  assert.equal(f.queue.list().filter(job=>job.kind==='qa').length,1);
});
test('the controller lists composed events once each, by date then start time, before the draft is reviewed',t=>{
  const early=session('2026-10-20','08:00'),extra=claimOf('event-3','events',[early],'Early group Tue 20.10.26 08:00-10:30'),approved=[...composedApproved,extra];
  const f=composedJob(t,{approved}),scrambled=[sessions[2],sessions[0],early,sessions[1],sessions[0]],ordered=[early,sessions[0],sessions[1],sessions[2]];
  const draft=withEvents(scrambled,{bindings:[...composed.bindings,bindingFor('events',extra)]});
  commitResult(f.queue,{jobId:f.editor.id,token:f.editor.token,role:'editor',result:{draft}},f);
  assert.deepEqual(f.queue.list().find(job=>job.kind==='review-patch').payload.draft.patch.events,ordered);
  // Full-review coverage carries the same list, so it still matches the resulting value.
  const covered=orderDraftEvents({patch:{events:scrambled},reviewCoverage:{fields:[{field:'events',value:scrambled},{field:'days',value:[2]}]}},approved);
  assert.deepEqual(covered.reviewCoverage.fields.map(row=>row.value),[ordered,[2]]);
  // Without an approved events claim the draft is left as the editor wrote it.
  assert.equal(orderDraftEvents(draft,[]),draft);
});
test('the controller refuses a composed events draft with an unapproved session and writes nothing',t=>{
  const f=composedJob(t);
  assert.throws(()=>commitResult(f.queue,{jobId:f.editor.id,token:f.editor.token,role:'editor',result:{draft:withEvents([...sessions,session('2026-11-10')])}},f),/no approved claim lists/);
  assert.equal(f.queue.summary().artifacts,0);assert.equal(f.queue.list().filter(job=>job.kind==='review-patch').length,0);
  assert.equal(fs.existsSync(path.join(f.outputRoot,'editorial/approved-updates.json')),false);
});
test('editor and reviewer instructions say how several approved events claims are combined and bound',()=>{
  const prompt=kind=>promptFor({id:'j',kind,input_revision:'r',payload:{card,approved:composedApproved,draft:composed}});
  for(const kind of ['integrate','editorial','review-patch']){
    assert.match(prompt(kind),/set patch\.events to the sessions you take from them/);assert.match(prompt(kind),/ordered by date then start time/);
    assert.match(prompt(kind),/EACH approved events claim you draw from its own binding \{field:'events',claimKey:/);assert.match(prompt(kind),/review\.events binding with the same claimKey/);
    assert.match(prompt(kind),/days, languages and contacts are not combined/);
  }
  assert.match(prompt('review-patch'),/check every listed session against the claim and quote of its binding/);
});
// The three refusals the Claude editor ran into on 13 and 14 October 2026. Each controller rule is kept; the instruction that led the editor into it is what changed.
test('an empty warnings list is a replacement that needs its own binding, and the editor is told to leave the key out',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  assert.throws(()=>validateBindings(f.queue,{...draft,warnings:[]}),/Missing evidence binding: practical\.warnings/);
  assert.deepEqual(validateBindings(f.queue,draft),['min','age','research.findings.0']);
  const bound={...draft,warnings:[],bindings:[...draft.bindings,{...draft.bindings[0],field:'practical.warnings'}]};
  assert.deepEqual(validateBindings(f.queue,bound),['min','age','research.findings.0','practical.warnings']);
  const prompt=kind=>promptFor({id:'j',kind,input_revision:'r',payload:{card}});
  for(const kind of ['integrate','editorial']){
    // The shape the editor copies must not list warnings as an ordinary key next to remaining.
    assert.doesNotMatch(prompt(kind).split('\n').find(line=>line.includes('Return {draft:')),/warnings:\[strings\]/);
    assert.match(prompt(kind),/A warnings key is added only under the warnings rule below/);
    assert.match(prompt(kind),/a draft has no warnings key at all unless a quoted source requires the card's visitor warnings to change/);
    assert.match(prompt(kind),/warnings:\[\] is not a neutral default/);
  }
  assert.match(prompt('review-patch'),/warnings:\[\] is not a neutral default/);
});
test('a finding binding is numbered within the draft, not after the findings the card already has',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  const existing=[1,2,3].map(n=>({field:'Old '+n,kind:'official',text:'Earlier finding '+n+'.',url:'https://example.org/course'}));
  const continued={...draft,bindings:draft.bindings.map(b=>b.field==='research.findings.0'?{...b,field:'research.findings.3'}:b)};
  assert.throws(()=>validateBindings(f.queue,continued),/Missing evidence binding: research\.findings\.0/);
  const prompt=promptFor({id:'j',kind:'integrate',input_revision:'r',payload:{card:{...card,research:{findings:existing,remaining:[]}}}});
  assert.equal(JSON.parse(prompt.split('TASK DATA:\n')[1]).existingFindings.length,3);
  assert.match(prompt,/research\.findings\.N for each new finding, where N is that finding's zero-based position in this draft's own findings array/);
  assert.match(prompt,/the first new finding is research\.findings\.0 however many findings the card or existingFindings already holds/);
  assert.doesNotMatch(prompt,/research\.findings\.INDEX/);
  // The reviewer refuses a finding whose single quote covers only part of what it says; the editor is told the same standard, and several bindings may share the field.
  assert.match(prompt,/A finding, note or intro states only what the quotes of its bindings support: bind every fact it states \(several bindings may share one field name\) or leave that fact out/);
  const twice={...draft,bindings:[...draft.bindings,{...draft.bindings[2],quote:'Admission is free.'}]};
  assert.deepEqual(validateBindings(f.queue,twice),['min','age','research.findings.0']);
});
// A public citation (a finding's url, the source of a practical fact) must be a page the controller captured for that very field.
test('a quote bound to source A cannot publish a link to an unrelated source B',t=>{
  const f=fixture(t),quote='No registration is required for this playgroup.',other='https://unrelated.example.org/notice';
  const source=snapshot({url:'https://example.org/playgroup',fetchedAt:'2026-10-02T08:00:00.000Z',text:quote});
  registerCaptured(f.queue,source);
  const bind=field=>({field,source:source.url,quote,kind:'official',scope:'exact-card',snapshotId:source.id});
  const make=(url,factSource)=>({...draft,snapshots:[source],patch:{},findings:[{field:'Booking',kind:'official',text:'No registration is required.',url}],
    practicalPatch:{booking:{value:false,text:'No registration is required.',source:factSource,checked:'2026-10-01'}},bindings:['practical.booking','research.findings.0'].map(bind)});
  const good=make(source.url,source.url);
  validateDraft(good,card);assert.deepEqual(validateBindings(f.queue,good),['practical.booking','research.findings.0']);
  assert.deepEqual(applyDraftRecord(card,good,'2026-10-02').sources.map(s=>s.url),['https://example.org/course',source.url]);
  for(const [bad,fields] of [[make(other,source.url),'research.findings.0'],[make(source.url,other),'practical.booking'],[make(other,other),'research.findings.0, practical.booking']]){
    validateDraft(bad,card); // well formed and https: only its links are not the captured source
    assert.deepEqual(citationProblems(bad),fields.split(', '));
    assert.throws(()=>validateBindings(f.queue,bad),error=>error.message==='Citation does not match its evidence binding: '+fields&&failureCategory(error.message)==='contract');
  }
  // The controller refuses the editor's answer and writes nothing: no review job, no artifact, no journal entry.
  f.queue.enqueue({kind:'integrate',cardId:'a',inputRevision:'mismatch',payload:{card,cardRevision:digest(card)}});
  const editor=f.queue.claim('editor','editor');
  assert.throws(()=>commitResult(f.queue,{jobId:editor.id,token:editor.token,role:'editor',result:{draft:make(other,other)}},f),/Citation does not match its evidence binding/);
  assert.equal(f.queue.summary().artifacts,0);assert.equal(f.queue.list().filter(job=>job.kind==='review-patch').length,0);
  assert.equal(fs.existsSync(path.join(f.outputRoot,'editorial/approved-updates.json')),false);
  // The editor is told the rule before it writes.
  assert.match(promptFor({id:'j',kind:'integrate',input_revision:'r',payload:{card}}),/A finding's url and a practicalPatch fact's source must each be a source you bound for that same field/);
});
test('a citation may be the requested address of its source or the address it redirected to, and no other address',t=>{
  const f=fixture(t),moved=snapshot({url:'https://example.org/old-page',finalUrl:'https://www.example.org/new/page/',fetchedAt:'2026-10-02T08:00:00.000Z',text:'Children aged 2 to 5 are welcome.'});
  registerCaptured(f.queue,moved);
  const make=url=>({...draft,snapshots:[moved],patch:{min:2},findings:[{...draft.findings[0],url}],
    bindings:['min','research.findings.0'].map(field=>({field,source:moved.url,quote:'Children aged 2 to 5',kind:'official',scope:'exact-card',snapshotId:moved.id}))});
  // Both addresses the controller recorded for the capture are the source; a fragment is not part of an address.
  for(const url of [moved.url,moved.finalUrl,moved.url+'#times',moved.finalUrl+'#top']){
    validateDraft(make(url),card);assert.deepEqual(validateBindings(f.queue,make(url)),['min','research.findings.0'],url);
  }
  // Nothing else is normalised: another path, a query, a trailing slash the server did not redirect to, or another host is another page.
  for(const url of ['https://example.org/old-page/','https://example.org/old-page?lang=fr','https://www.example.org/new/page','https://example.org/new/page/','https://www.example.org/'])
    assert.throws(()=>validateBindings(f.queue,make(url)),/Citation does not match its evidence binding: research\.findings\.0/,url);
  // A practical fact is held to the same rule through its own field.
  const fact=url=>({...make(moved.url),practicalPatch:{booking:{value:false,text:'No registration is required.',source:url,checked:'2026-10-01'}},
    bindings:[...make(moved.url).bindings,{...make(moved.url).bindings[1],field:'practical.booking'}]});
  assert.deepEqual(validateBindings(f.queue,fact(moved.finalUrl)),['min','practical.booking','research.findings.0']);
  assert.throws(()=>validateBindings(f.queue,fact('https://example.org/elsewhere')),/binding: practical\.booking$/);
});
test('each citation is held to the sources bound to its own field, and a field bound to two sources may cite either',t=>{
  const f=fixture(t),at='2026-10-02T08:00:00.000Z';
  const a=snapshot({url:'https://example.org/course',fetchedAt:at,text:'Children aged 2 to 5 are welcome.'});
  const b=snapshot({url:'https://tourism.example.net/offers/course',fetchedAt:at,text:'Admission is free for all visitors.'});
  registerCaptured(f.queue,a);registerCaptured(f.queue,b);
  const bind=(field,evidence,quote)=>({field,source:evidence.url,quote,kind:'official',scope:'exact-card',snapshotId:evidence.id});
  const make=(first,second,...extra)=>({...draft,snapshots:[a,b],patch:{min:2},
    findings:[{...draft.findings[0],url:first},{field:'Price',kind:'official',text:'Admission is free.',url:second}],
    bindings:[bind('min',a,'Children aged 2 to 5'),bind('research.findings.0',a,'Children aged 2 to 5'),bind('research.findings.1',b,'Admission is free'),...extra]});
  // Two independently bound sources: each finding cites its own.
  assert.deepEqual(validateBindings(f.queue,make(a.url,b.url)),['min','research.findings.0','research.findings.1']);
  // A source bound only to the other finding does not support this one.
  assert.throws(()=>validateBindings(f.queue,make(b.url,a.url)),/binding: research\.findings\.0, research\.findings\.1$/);
  assert.throws(()=>validateBindings(f.queue,make(a.url,a.url)),/binding: research\.findings\.1$/);
  // A field bound to both sources may cite either of them.
  const both=bind('research.findings.0',b,'Admission is free');
  for(const [first,second] of [[a.url,b.url],[b.url,b.url]])assert.deepEqual(citationProblems(make(first,second,both)),[]);
  assert.deepEqual(citationProblems(make(b.url,a.url,both)),['research.findings.1']);
});
test('an unchanged value restated in the patch still has to match the approved claim, so the editor is told to patch changes only',t=>{
  const f=fixture(t);registerCaptured(f.queue,page);
  const kept=[{name:'Course office',email:'office@example.org',phone:''}],published=claimOf('contacts','contacts',[{name:'',phone:'',email:'office@example.org'}],'Playgroup, Main 1.');
  const restated={...composed,patch:{contacts:kept},bindings:[bindingFor('contacts',published),composed.bindings.at(-1)]};
  assert.throws(()=>validateBindings(f.queue,restated,[published]),/Patch contradicts approved value: contacts/);
  assert.deepEqual(validateBindings(f.queue,{...restated,patch:{}},[published]),['research.findings.0']);
  const prompt=promptFor({id:'j',kind:'integrate',input_revision:'r',payload:{card:{...card,contacts:kept},approved:[published]}});
  assert.match(prompt,/patch and practicalPatch hold changes only: leave out every field whose value stays as the card has it, even when an approved claim confirms it/);
  // A full-review draft confirmed addressPrecision exact for a card that has no such field, without patching it; the coverage row then differs from the resulting value.
  assert.match(prompt,/A field the card object does not contain is unset, so giving it a value is a change and belongs in patch/);
  assert.match(prompt,/contacts is copied whole: a patch\.contacts, and a confirmed contacts row of a full review, must equal an approved contacts claim's value exactly, names included\. A partial draft keeps the card's contacts by leaving contacts out of patch/);
  // The same holds for the coverage row of a full review: the card's own contact name cannot be confirmed by a claim that does not publish it.
  const row=value=>({...restated,patch:{},reviewCoverage:{mode:'full',fields:[{field:'contacts',value,outcome:'confirmed',snapshotIds:[page.id],reason:'Published contact.'}]},
    bindings:[bindingFor('review.contacts',published),composed.bindings.at(-1)]});
  assert.throws(()=>validateBindings(f.queue,row(kept),[published]),/Patch contradicts approved value: review\.contacts/);
  assert.deepEqual(validateBindings(f.queue,row(published.value),[published]),['research.findings.0','review.contacts','review.coverage']);
});
test('a cleared value needs a quoted passage of its own; the key, empty quote and scope of an unapproved claim are no evidence',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  const cleared={...draft,patch:{},practicalPatch:{indoor:{value:null,text:'Not published',source:evidence.url,checked:'2026-10-01'}}};
  const bind=more=>({...cleared,bindings:[draft.bindings[2],{field:'practical.indoor',source:evidence.url,kind:'official',scope:'exact-card',snapshotId:evidence.id,...more}]});
  const passage='This exact course accepts children aged 2 to 5.';
  // What the editor returned in the rehearsal of 14 October 2026: the binding of an unknown claim, copied with its empty quote and its scope.
  assert.throws(()=>validateBindings(f.queue,bind({quote:'',scope:'uncertain',claimKey:'indoor-unknown'}),bundle.claims),/Invalid evidence binding: practical\.indoor/);
  assert.throws(()=>validateBindings(f.queue,bind({quote:passage,claimKey:'indoor-unknown'}),bundle.claims),/does not match an approved claim: practical\.indoor/);
  assert.throws(()=>validateBindings(f.queue,bind({quote:passage,scope:'uncertain',claimKey:null}),bundle.claims),/Critical patch requires exact official binding/);
  assert.deepEqual(validateBindings(f.queue,bind({quote:passage,claimKey:null,transformation:'clear-unconfirmed',reason:'The page describes the course without saying where it is held.'}),bundle.claims),
    ['practical.indoor','research.findings.0']);
  const prompt=kind=>promptFor({id:'j',kind,input_revision:'r',payload:{card}});
  for(const kind of ['integrate','editorial','review-patch']){
    assert.match(prompt(kind),/claimKey names approved claims only: an unknown, rejected or await-source claim is not evidence, so never use its key, its empty quote or its scope/);
    assert.match(prompt(kind),/bind the field with claimKey:null, kind official, scope exact-card and an exact quote of the passage that covers the point without stating the condition/);
    assert.match(prompt(kind),/No binding has an empty quote; if nothing can be quoted, keep the value and ask the question in remaining/);
  }
});
// A verifier asked for the same lead again because it never saw what following the lead produced.
test('the verifier after an extraction that followed leads is told which sources were already fetched for them',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  const lead=source=>({source,note:'Poster for this session; inspect age and language.'}),first=lead('https://example.org/poster-1.pdf'),second=lead('https://example.org/poster-2.pdf');
  const payload={card,cardRevision:digest(card)},verifierOf=id=>f.queue.list().find(job=>job.kind==='verify-facts'&&job.id!==id);
  f.queue.enqueue({kind:'facts',cardId:'a',inputRevision:'plain',payload});
  let search=f.queue.claim('search','search');commitResult(f.queue,{jobId:search.id,token:search.token,role:'search',result:{bundle}},f);
  let verify=f.queue.claim('verify','verify');assert.equal(Object.hasOwn(verify.payload,'followedLeads'),false);
  const verdicts=[{key:'age',verdict:'approve',reason:'The range is published for this course.'}];
  commitResult(f.queue,{jobId:verify.id,token:verify.token,role:'verify',result:{verdicts,researchLeads:[first]}},f);
  search=f.queue.claim('search','search');
  assert.deepEqual(search.payload.researchLeads,[first]);assert.equal(search.payload.reworkCount,1);assert.equal(Object.hasOwn(search.payload,'followedLeads'),false);
  commitResult(f.queue,{jobId:search.id,token:search.token,role:'search',result:{bundle}},f);
  verify=f.queue.claim('verify','verify');assert.deepEqual(verify.payload.followedLeads,[first]);assert.equal(verify.payload.reworkCount,1);
  assert.match(promptFor(verify),/"followedLeads":\[\{"source":"https:\/\/example\.org\/poster-1\.pdf"/);
  // A further lead is still followed, within the unchanged limit of two rounds, and the earlier one stays on record.
  commitResult(f.queue,{jobId:verify.id,token:verify.token,role:'verify',result:{verdicts,researchLeads:[second]}},f);
  search=f.queue.claim('search','search');
  assert.deepEqual(search.payload.researchLeads,[second]);assert.deepEqual(search.payload.followedLeads,[first]);assert.equal(search.payload.reworkCount,2);
  commitResult(f.queue,{jobId:search.id,token:search.token,role:'search',result:{bundle}},f);
  verify=f.queue.claim('verify','verify');assert.deepEqual(verify.payload.followedLeads,[first,second]);
  commitResult(f.queue,{jobId:verify.id,token:verify.token,role:'verify',result:{verdicts,researchLeads:[first]}},f);
  assert.equal(f.queue.list().filter(job=>job.kind==='facts').length,3);assert.equal(f.queue.list().filter(job=>job.kind==='integrate').length,1);
  const instructions=promptFor({id:'j',kind:'verify-facts',input_revision:'r',payload:{bundle:{claims:[],snapshots:[]}}});
  assert.match(instructions,/followedLeads, if present, are sources the controller already fetched for an earlier lead/);
  assert.match(instructions,/Do not return a followedLeads source in researchLeads again, with one exception/);
  assert.match(instructions,/A source in evidenceFailures, or one whose file adds nothing, is a reviewLimitations entry, never a repeated lead/);
});
test('approving one card cannot supersede another card stale update',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  const other={jobId:'old-b',draft:{cardId:'b'}};
  fs.mkdirSync(path.join(f.outputRoot,'editorial'),{recursive:true});
  fs.writeFileSync(path.join(f.outputRoot,'editorial/approved-updates.json'),JSON.stringify({schema:1,project:'vmeste',updates:[other]}));
  const data={...input,staleUpdates:[{id:'b',jobId:'old-b'}]};
  f.queue.enqueue({kind:'integrate',cardId:'a',inputRevision:'other-stale',payload:{card,cardRevision:digest(card)}});
  const editor=f.queue.claim('editor','editor');commitResult(f.queue,{jobId:editor.id,token:editor.token,role:'editor',result:{draft}},{...f,getInputs:()=>data});
  const reviewer=f.queue.claim('verify','independent');
  commitResult(f.queue,{jobId:reviewer.id,token:reviewer.token,role:'verify',result:{verdict:'approve',reason:'Independent verification.',draftHash:digest(draft),
    checkedFields:['min','age','research.findings','research.remaining'],approvedBindings:['min','age','research.findings.0']}},{...f,getInputs:()=>data});
  const journal=JSON.parse(fs.readFileSync(path.join(f.outputRoot,'editorial/approved-updates.json'),'utf8'));
  assert.equal(journal.updates[0].supersededBy,undefined);
});
const channels=['reviews','ratings','photos','community'];
const candidateFor=record=>({schema:1,id:record.id,revision:'v1',collectedOn:today(),reviewAfter:'2099-10-29',
  identityUrl:record.sources[0].url,name:record.name,town:record.town,address:record.address,
  channels:Object.fromEntries(channels.map(c=>[c,{status:'searched',queries:['Exact course reviews'],results:[],note:'No usable evidence.'}]))});
const receiptFor=record=>({id:record.id,candidateRevision:'v1',checkedOn:today(),reviewAfter:'2099-10-29',
  identityUrl:record.sources[0].url,evidenceOutcome:'no-usable-external-evidence',conclusion:'No usable independent evidence.',conflicts:[],
  channels:Object.fromEntries(channels.map(c=>[c,{result:'no-usable-evidence',queries:['Exact course reviews'],urls:[],note:'No usable evidence.'}]))});
test('same revision labels cannot conceal changed dependency content',t=>{
  const f=fixture(t),candidate=candidateFor(card);
  const original={...input,candidates:new Map([['a',candidate]]),pipeline:{rows:[{id:'a',researchStage:'verify',editorialStatus:'clear'}]}};
  f.queue.enqueue(taskSpecs(original)[0]);const job=f.queue.claim('verify','checker');
  const changed={...original,candidates:new Map([['a',{...candidate,address:'Other 2'}]])};
  assert.throws(()=>commitResult(f.queue,{jobId:job.id,token:job.token,role:'verify',result:{receipt:receiptFor(card)}},
    {...f,getInputs:()=>changed}),/dependencies changed/);
});
test('reopening a dispute removes the previous decision and receipt',t=>{
  const f=fixture(t),candidate=candidateFor(card),oldQuestion={key:'old',topic:'address',issue:'Old entrance question.',urls:[evidence.url]};
  const oldDispute={schema:1,id:'a',candidateRevision:'v1',openedOn:today(),questions:[oldQuestion]};
  const decision={schema:1,id:'a',candidateRevision:'v1',disputeOpenedOn:today(),decidedOn:today(),
    rulings:[{key:'old',verdict:'resolved',reason:'Previously resolved.',urls:[evidence.url]}]};
  const original={...input,candidates:new Map([['a',candidate]]),receipts:[receiptFor(card)],disputes:new Map([['a',oldDispute]]),
    decisions:new Map([['a',decision]]),pipeline:{rows:[{id:'a',researchStage:'verify',editorialStatus:'clear'}]}};
  f.queue.enqueue(taskSpecs(original)[0]);const job=f.queue.claim('verify','checker');
  const dispute={...oldDispute,questions:[{...oldQuestion,key:'new',issue:'New source conflict.'}]};
  commitResult(f.queue,{jobId:job.id,token:job.token,role:'verify',result:{dispute}},{...f,getInputs:()=>original});
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.outputRoot,'editorial/external-decisions/a.json'),'utf8')),null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.outputRoot,'editorial/external-review-receipts.json'),'utf8')).receipts,[]);
});
test('receipt committed between outer flush and transaction is retained',t=>{
  const f=fixture(t),b={...card,id:'b',name:'Other course'},candidates=new Map([['a',candidateFor(card)],['b',candidateFor(b)]]);
  const original={...input,records:[card,b],candidates,pipeline:{rows:[{id:'a',researchStage:'verify',editorialStatus:'clear'}]}};
  f.queue.enqueue(taskSpecs(original)[0]);const job=f.queue.claim('verify','checker');
  const flush=f.queue.flush.bind(f.queue);let calls=0;
  f.queue.flush=root=>{
    const result=flush(root);
    if(++calls===1)f.queue.db.prepare('INSERT INTO outbox(file,data) VALUES (?,?)').run('editorial/external-review-receipts.json',JSON.stringify({schema:1,receipts:[receiptFor(b)]}));
    return result;
  };
  const file=path.join(f.outputRoot,'editorial/external-review-receipts.json');
  const getInputs=()=>({...original,receipts:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).receipts:[]});
  commitResult(f.queue,{jobId:job.id,token:job.token,role:'verify',result:{receipt:receiptFor(card)}},{...f,getInputs});
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).receipts.map(r=>r.id).sort(),['a','b']);
});
test('an unrelated edit cannot close a correction whose scoped field did not change',t=>{
  const f=fixture(t);registerCaptured(f.queue,evidence);
  const correction={schema:1,id:'a',proposedOn:today(),status:'proposed',source:evidence.url,issue:'Wrong address.',proposal:'Check entrance.',requiredFields:['address']};
  const original={...input,corrections:new Map([['fix',correction]])};
  f.queue.enqueue({kind:'integrate',cardId:'a',inputRevision:'scope-test',payload:{card,cardRevision:digest(card),corrections:[{file:'fix',correction}]}});
  const editor=f.queue.claim('editor','editor');
  commitResult(f.queue,{jobId:editor.id,token:editor.token,role:'editor',result:{draft}},{...f,getInputs:()=>original});
  const reviewer=f.queue.claim('verify','independent');
  assert.throws(()=>commitResult(f.queue,{jobId:reviewer.id,token:reviewer.token,role:'verify',result:{verdict:'approve',reason:'Fields checked.',draftHash:digest(draft),
    checkedFields:['min','age','research.findings','research.remaining'],approvedBindings:['min','age','research.findings.0'],checkedCorrectionFiles:['fix']}},
    {...f,getInputs:()=>original}),/Correction not resolved/);
  assert.equal(fs.existsSync(path.join(f.outputRoot,'editorial/approved-updates.json')),false);
});
test('a correction closes with a bound change plus a bound confirmation of a field that was right, never with confirmations alone',t=>{
  const review=(patch,requiredFields)=>{
    const f=fixture(t);registerCaptured(f.queue,evidence);
    const correction={schema:1,id:'a',proposedOn:today(),status:'proposed',source:evidence.url,issue:'Price and ages may be wrong.',proposal:'Check the page.',requiredFields};
    const original={...input,corrections:new Map([['fix',correction]])},bound=Object.keys(patch);
    const quote=field=>['price','priceKind'].includes(field)?'Admission is free.':'children aged 2 to 5';
    const fixed={...draft,patch,bindings:[...bound,'research.findings.0'].map(field=>({field,source:evidence.url,quote:quote(field),kind:'official',scope:'exact-card',snapshotId:evidence.id}))};
    f.queue.enqueue({kind:'integrate',cardId:'a',inputRevision:'confirm',payload:{card,cardRevision:digest(card),corrections:[{file:'fix',correction}]}});
    const editor=f.queue.claim('editor','editor');
    commitResult(f.queue,{jobId:editor.id,token:editor.token,role:'editor',result:{draft:fixed}},{...f,getInputs:()=>original});
    const reviewer=f.queue.claim('verify','independent');
    const approve=()=>commitResult(f.queue,{jobId:reviewer.id,token:reviewer.token,role:'verify',result:{verdict:'approve',reason:'Fields checked.',draftHash:digest(fixed),
      checkedFields:[...bound,'research.findings','research.remaining'],approvedBindings:[...bound,'research.findings.0'],checkedCorrectionFiles:['fix']}},{...f,getInputs:()=>original});
    return {approve,journal:path.join(f.outputRoot,'editorial/approved-updates.json')};
  };
  // min was right (2) and is confirmed with its quote; the price changes. The correction closes.
  const closed=review({min:2,price:'Free',priceKind:'free'},['min','price','priceKind']);
  closed.approve();assert.equal(fs.existsSync(closed.journal),true);
  // Confirmations alone, or a required field the draft does not address, leave the correction open.
  const unchanged=review({min:2,age:'2–5 years'},['min','age']);
  assert.throws(unchanged.approve,/every required field is unchanged/);assert.equal(fs.existsSync(unchanged.journal),false);
  const missing=review({price:'Free',priceKind:'free'},['price','days']);
  assert.throws(missing.approve,/Correction not resolved by draft: days/);assert.equal(fs.existsSync(missing.journal),false);
});
test('runtime will not replay an approved patch over a newer catalogue base',()=>{
  const text=fs.readFileSync(new URL('../regions.js',import.meta.url),'utf8');
  const block=text.slice(text.indexOf('  // Reviewed updates apply after'),text.lastIndexOf('})();'));
  const run=base=>{
    const context={window:{ACTIVITIES:[structuredClone(base)],APPROVED_UPDATES:[{jobId:'j',baseRecord:card,draft:{cardId:'a',patch:{price:'Free'},findings:[]},research:{}}]}};
    vm.runInNewContext(block,context);return context.window;
  };
  assert.equal(run({...card,geo:{lat:1}}).ACTIVITIES[0].price,'Free');
  const stale=run({...card,price:'New tariff'});assert.equal(stale.ACTIVITIES[0].price,'New tariff');
  assert.equal(stale.STALE_UPDATES[0].jobId,'j');
});
test('model routing raises effort only for critical work and keeps bulk evidence out of prompts',()=>{
  const policy=JSON.parse(fs.readFileSync(new URL('./agent-policy.json',import.meta.url),'utf8'));
  const job={id:'x',kind:'facts',input_revision:'v1',payload:{card}};
  assert.deepEqual(modelRoute(job,policy),{role:'search',model:'claude-haiku-5-5',effort:'medium'});
  // The earlier Codex route stays in the policy, so a provider rollback needs one field.
  assert.deepEqual(modelRoute(job,{...policy,workerProvider:'codex'}),{role:'search',model:'gpt-6-luna',effort:'medium'});
  assert.equal(modelRoute({...job,kind:'review-patch'},policy).effort,'medium');
  const prompt=promptFor({...job,kind:'verify-facts',payload:{bundle}});
  assert.ok(prompt.includes('children aged 2 to 5'));assert.ok(!prompt.includes('Admission is free.'));
});
test('release is bound to tested public files and source revision',()=>{
  const manifest={revision:'rev',files:{'index.html':'hash'}};
  const tested={manifest,sourceRevision:'source',checks:['unit','build','mobile-ages','mobile-flow']};
  assert.equal(assertReleaseCurrent(tested,{manifest,source:'source'}),true);
  assert.throws(()=>assertReleaseCurrent(tested,{manifest:{...manifest,files:{'index.html':'changed'}},source:'source'}),/changed after QA/);
  assert.throws(()=>assertReleaseCurrent(tested,{manifest,source:'changed'}),/Source files/);
  assert.throws(()=>assertReleaseCurrent({...tested,checks:['build']},{manifest,source:'source'}),/required QA/);
  assert.throws(()=>assertReleaseCurrent({...tested,checks:['unit','build','mobile-ages']},{manifest,source:'source'}),/required QA/);
});
test('source revision changes when a source receipt changes',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-release-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  fs.mkdirSync(path.join(base,'editorial/geo'),{recursive:true});
  fs.writeFileSync(path.join(base,'editorial/geo','a.json'),'{}');const before=sourceRevision(base);
  fs.writeFileSync(path.join(base,'editorial/geo','a.json'),'{"updated":true}');assert.notEqual(sourceRevision(base),before);
});
test('changing the worker schema or locked dependencies invalidates tested source revision',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-dependency-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  fs.mkdirSync(path.join(base,'editorial'));
  for(const file of ['agent-output.schema.json','package-lock.json']){
    const before=sourceRevision(base);
    fs.writeFileSync(path.join(base,'editorial',file),'{}');
    assert.notEqual(sourceRevision(base),before,file);
  }
});
