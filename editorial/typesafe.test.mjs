import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {snapshot} from './evidence.mjs';
import {readPolicy,validatePolicy,requestFor,judgeBatch,validateResponse,cardJobs,runShadow,semanticPackets,importCredential,evaluationReport} from './typesafe.mjs';
import {ageCohort,targetAgeFit} from './age-policy.mjs';

const policy=await readPolicy();
const now='2026-10-01T10:00:00Z';
const evidence=(time=now,text='Example course for children aged 3 to 6. A parent participates.')=>snapshot({url:'https://example.org/course',fetchedAt:time,text});
const job=(field='age')=>({target:{id:'example',name:'Example course',town:'Fribourg'},field,claim:'Published age range is 3 to 6 years.',quote:'children aged 3 to 6',kind:'official'});
const answer=(choice='supports',confidence=0.95)=>({type:'choice',choice,confidence,probabilities:Object.fromEntries(['supports','contradicts','not_stated'].map(key=>[key,key===choice?1:0]))});
const response=(request,choice='supports',confidence=0.95)=>({model:policy.model,answers:Object.fromEntries(Object.keys(request.questions).map(key=>[key,answer(choice,confidence)])),usage:{input_tokens:500,output_tokens:40}});
const client=(choice='supports',confidence=0.95)=>({systemOne:async request=>response(request,choice,confidence)});

test('shadow policy cannot enable automatic publication or drifting model aliases',()=>{
  assert.throws(()=>validatePolicy({...policy,automaticPublication:true}));
  assert.throws(()=>validatePolicy({...policy,model:'jev-latest'}));
  assert.throws(()=>validatePolicy({...policy,project:'angeline'}));
  assert.throws(()=>validatePolicy({...policy,targetAge:{min:2.5,max:6}}));
  assert.throws(()=>validatePolicy({...policy,advisoryConfidence:2}));
});
test('all target age cohorts include their exact boundaries',()=>{
  for(const [age,cohort] of [[0,'infants'],[0.5,'infants'],[1,'toddlers'],[2.5,'toddlers'],[3,'preschool'],[4.5,'preschool'],[5,'older-preschool'],[6,'older-preschool']])assert.equal(ageCohort(age),cohort);
  assert.equal(ageCohort(6.5),null);assert.equal(ageCohort(-1),null);assert.equal(ageCohort(null),null);
  assert.equal(targetAgeFit({min:5,max:6}),'confirmed');assert.equal(targetAgeFit({min:null,max:null}),'possible');
  assert.equal(targetAgeFit({min:7,max:10}),'outside');
});
test('one batch asks complete independent questions about one target',()=>{
  const request=requestFor(evidence(),[job(),{...job('parent'),claim:'A parent participates.'}],policy);
  assert.match(request.questions.q0.instructions.claim,/3 to 6/);
  assert.equal(request.questions.q1.instructions.field,'parent');assert.equal(request.model,'jev-1.13.0');
  assert.ok(request.questions.q0.criteria.not_stated);
  assert.throws(()=>requestFor(evidence(),[job(),{...job(),target:{name:'Other',town:'Bulle'}}],policy),/one exact target/);
});
test('missing quote, old evidence and oversized input do not invoke the model',async()=>{
  let calls=0;const forbidden={systemOne:async()=>{calls++;throw Error('Must not call');}};
  const absent=await judgeBatch({evidence:evidence(),jobs:[{...job(),quote:'Children aged 2'}],policy,client:forbidden,now});
  assert.equal(absent.rows[0].status,'quote-not-found');
  assert.equal(absent.rows[0].sourceUrl,evidence().url);assert.equal(absent.rows[0].snapshotId,evidence().id);
  const stale=await judgeBatch({evidence:evidence('2026-09-01T10:00:00Z'),jobs:[job()],policy,client:forbidden,now});
  assert.equal(stale.rows[0].status,'stale-evidence');
  assert.equal(stale.rows[0].sourceFetchedAt,'2026-09-01T10:00:00Z');
  const large=await judgeBatch({evidence:evidence(now,'Children aged 3 to 6. '+'x'.repeat(33000)),jobs:[{...job(),quote:''}],policy,client:forbidden,now});
  assert.equal(large.rows[0].status,'input-limit');assert.equal(calls,0);
});
test('high-confidence critical answers never bypass editorial review',async()=>{
  const result=await judgeBatch({evidence:evidence(),jobs:[job()],policy,client:client(),now});
  assert.equal(result.rows[0].route,'editor-review');assert.equal(result.rows[0].automaticPublication,false);
  assert.equal(result.rows[0].decision,'research-only');
  const conflict=await judgeBatch({evidence:evidence(),jobs:[job()],policy,client:client('contradicts'),now});
  assert.equal(conflict.rows[0].route,'conflict-review');
  const unknown=await judgeBatch({evidence:evidence(),jobs:[job()],policy,client:client('not_stated'),now});
  assert.equal(unknown.rows[0].route,'more-evidence');
});
test('invalid model answers and service failures fail closed without logging secrets',async()=>{
  const request=requestFor(evidence(),[job()],policy);
  assert.throws(()=>validateResponse({...response(request),model:'jev-latest'},request));
  assert.throws(()=>validateResponse({...response(request),answers:{}},request));
  const invalid=response(request);invalid.answers.q0.probabilities.supports=2;
  assert.throws(()=>validateResponse(invalid,request));
  const result=await judgeBatch({evidence:evidence(),jobs:[job()],policy,now,client:{systemOne:async()=>{throw Error('PRIVATE TOKEN BODY');}}});
  assert.equal(result.rows[0].status,'service-unavailable');assert.doesNotMatch(JSON.stringify(result),/PRIVATE TOKEN/);
});
test('cache requires matching state and rubric, never refreshes stale evidence',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-typesafe-cache-'));let calls=0;
  const spy={systemOne:async request=>{calls++;return response(request);}};
  try{
    const args={evidence:evidence(),jobs:[job()],policy,client:spy,now,cacheDirectory:directory};
    await judgeBatch(args);
    const replay=await judgeBatch({...args,evidence:evidence('2026-10-02T10:00:00Z'),now:'2026-10-02T10:00:00Z'});
    assert.equal(replay.requests,0);assert.equal(replay.rows[0].cached,true);assert.equal(replay.rows[0].sourceFetchedAt,'2026-10-02T10:00:00Z');
    await judgeBatch({...args,policy:{...policy,rubricVersion:policy.rubricVersion+'-changed'}});assert.equal(calls,2);
    const old=await judgeBatch({...args,now:'2026-10-20T10:00:00Z'});assert.equal(old.rows[0].status,'stale-evidence');assert.equal(calls,2);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('credential import refuses a different client before reading any file',async()=>{
  await assert.rejects(importCredential('/does/not/exist/Angeline-1-typesafe.rtf'),/ensemble/);
});
test('language options do not silently claim every multilingual offering is bilingual',()=>{
  const jobs=cardJobs({id:'example',name:'Example',town:'Fribourg',languages:['DE','FR'],format:'group',parent:'unknown',priceKind:'unknown'});
  assert.equal(jobs.some(item=>item.field==='age'),false);
  assert.match(jobs.find(item=>item.field==='language').claim,/separate groups/);
});
test('evaluation separates real and synthetic checks, cohorts and false supports',()=>{
  const result=evaluationReport([
    {status:'judged',answer:answer(),expected:'not_stated',childAge:0.5,provenance:'synthetic',language:'DE'},
    {status:'judged',answer:answer('contradicts'),expected:'contradicts',childAge:6,provenance:'real-source',language:'FR'}
  ]);
  assert.equal(result.overall.falseSupports,1);assert.equal(result.byProvenance['real-source'].correct,1);
  assert.equal(result.byCohort['older-preschool'].cases,1);
});
test('worker lock prevents concurrent runs and does not delete another process lock',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-typesafe-lock-'));
  try{await fs.writeFile(path.join(directory,'worker.lock'),'owned by another worker');
    const report=await runShadow({records:[],sources:[],monitor:{},policy,client:client(),directory,now});
    assert.equal(report.busy,true);assert.equal(await fs.readFile(path.join(directory,'worker.lock'),'utf8'),'owned by another worker');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('semantic packets reject old reports and changed catalogue facts',async()=>{
  const record={id:'example',name:'Example course',town:'Fribourg',address:'',status:'active',min:3,max:6,age:'3–6 years',parent:'yes',priceKind:'unknown',languages:[],format:'group',schedule:'To be confirmed',sources:[]};
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-typesafe-report-'));
  try{
    const report=await runShadow({records:[record],sources:[],monitor:{},policy,client:client(),directory,now});
    report.rows=[{...job(),status:'judged',answer:answer(),route:'editor-review',automaticPublication:false}];
    assert.equal(semanticPackets(report,[record],'2026-10-01').length,1);
    assert.equal(semanticPackets(report,[{...record,age:'4–6 years'}],'2026-10-01').length,0);
    assert.equal(semanticPackets(report,[record],'2026-10-02').length,0);
    assert.ok(cardJobs(record).every(item=>item.target.id===record.id));
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('per-field packets do not mistake an unrelated tariff page for missing age evidence',async()=>{
  const record={id:'example',name:'Example course',town:'Fribourg',address:'',status:'active',min:3,max:6,age:'3–6 years',parent:'unknown',priceKind:'unknown',languages:[],format:'group',schedule:'To be confirmed',sources:[]};
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-typesafe-aggregate-'));
  try{
    const report=await runShadow({records:[record],sources:[],monitor:{},policy,client:client(),directory,now});
    report.rows=[
      {...job(),status:'judged',sourceUrl:'https://example.org/course',answer:answer(),route:'editor-review',automaticPublication:false},
      {...job(),status:'judged',sourceUrl:'https://example.org/tariff',answer:answer('not_stated'),route:'more-evidence',automaticPublication:false}
    ];
    const packets=semanticPackets(report,[record],'2026-10-01');
    assert.equal(packets.length,1);assert.equal(packets[0].relation,'supports');assert.equal(packets[0].sources.length,2);
    report.rows[1].answer=answer('contradicts');
    assert.equal(semanticPackets(report,[record],'2026-10-01')[0].relation,'mixed');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('request budget leaves unfinished cards in rotation and external snippets are not used as evidence',async()=>{
  const record={id:'example',name:'Example course',town:'Fribourg',address:'',status:'active',min:3,max:6,age:'3–6 years',parent:'unknown',priceKind:'unknown',languages:[],format:'group',schedule:'To be confirmed',sources:[{url:'https://example.org/course'}]};
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-typesafe-budget-'));
  const externalCandidates=new Map([['example',{schema:1,id:'example',revision:'rev1',collectedOn:'2026-09-30',reviewAfter:'2026-10-10',channels:{reviews:{results:[{url:'https://example.org/review',snippet:'Never use this search snippet as proof.'}]}}}]]);
  const received=[];
  const spy={systemOne:async request=>{received.push(request);return response(request);}};
  const acquireImpl=async url=>snapshot({url,fetchedAt:now,text:'Example course in Fribourg. Children aged 3 to 6 participate in the activity.'});
  try{
    const args={records:[record],sources:[],monitor:{},policy:{...policy,maxRequestsPerRun:1},client:spy,directory,now,externalCandidates,acquireImpl};
    const first=await runShadow(args);
    assert.deepEqual(first.deferredIds,['example']);assert.equal(first.completedIds.length,0);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory,'cursor.json'),'utf8')).cursor,0);
    const second=await runShadow(args);assert.deepEqual(second.completedIds,['example']);
    assert.ok(second.rows.some(row=>row.field==='external-identity'&&row.candidateRevision==='rev1'));
    assert.doesNotMatch(JSON.stringify(received),/Never use this search snippet/);
    assert.equal(received[1].questions.q0.instructions.sourceKind,'visitor');
    assert.equal(semanticPackets(second,[record],'2026-10-01',externalCandidates).filter(row=>row.field.startsWith('external-')).length,2);
    externalCandidates.set('example',{...externalCandidates.get('example'),revision:'rev2'});
    assert.equal(semanticPackets(second,[record],'2026-10-01',externalCandidates).filter(row=>row.field.startsWith('external-')).length,0);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('source-page budget resumes inside a large card and resets when its source set changes',async()=>{
  const record={id:'example',name:'Example course',town:'Fribourg',address:'',status:'active',min:3,max:6,age:'3–6 years',parent:'unknown',priceKind:'unknown',languages:[],format:'group',schedule:'To be confirmed',
    sources:['first','second','third'].map(name=>({url:'https://example.org/'+name}))};
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-typesafe-pages-')),opened=[];
  const acquireImpl=async url=>{opened.push(url);return snapshot({url,fetchedAt:now,text:'Children aged 3 to 6 participate in this example course.'});};
  try{
    const args={records:[record],sources:[],monitor:{},policy:{...policy,maxSourcesPerRun:1},client:client(),directory,now,acquireImpl};
    assert.equal((await runShadow(args)).summary.sourcePages,1);
    assert.equal((await runShadow(args)).summary.sourcePages,1);
    const third=await runShadow(args);assert.deepEqual(third.completedIds,['example']);
    assert.deepEqual(opened,record.sources.map(item=>item.url));
    await runShadow(args);
    const changed={...record,sources:[{url:'https://example.org/new'},...record.sources]};
    await runShadow({...args,records:[changed]});assert.equal(opened.at(-1),'https://example.org/new');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
