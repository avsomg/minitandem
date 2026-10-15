import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {snapshot,captureUrl,capturedViews,monitorRecord,hash} from './evidence.mjs';
import {writeRecord} from './page-record.mjs';
import {JobQueue,digest} from './jobs.mjs';
import {retireStaleReadyJobs,assertCaptured,registerCaptured} from './workflow.mjs';
import {captureClaims,prepareEvidence,captureDraft,watchFor,promptFor,failJob,runRoles,runCodex,workerEvidenceFiles,normalizePilotSources,upgradeInputBudgetJob,upgradeInvestigatedJob,requestQa,timedWorker} from './agent-run.mjs';

const now=new Date().toISOString(),url='https://example.org/course';
const first=snapshot({url,fetchedAt:now,text:'Official source: admission is free. Course is on Monday.'});
const second=snapshot({url,fetchedAt:now,parser:'calendar-selected-zurich-v1',text:'Derived official calendar: 2026-10-03 starts at 09:30 in Zurich.'});
const card={id:'course',name:'Meeting',format:'event',sources:[{url}],checked:'2026-09-01',min:5};
const claim=(field,value,quote)=>({key:field,field,value,quote,source:url,status:'supported',scope:'exact-card',kind:'official',note:'Published exact condition.'});
test('operator can request version-bound QA for code changes without a card approval',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-qa-request-')),q=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{q.close();fs.rmSync(directory,{recursive:true,force:true});});
  fs.writeFileSync(path.join(directory,'app.js'),'original');const first=requestQa(q,directory);
  assert.equal(first.kind,'qa');assert.equal(first.card_id,'catalogue');assert.equal(requestQa(q,directory).id,first.id);
  q.db.prepare("UPDATE jobs SET state='superseded' WHERE id=?").run(first.id);
  const repeated=requestQa(q,directory);assert.notEqual(repeated.id,first.id);assert.equal(requestQa(q,directory).id,repeated.id);
  q.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(repeated.id);
  assert.notEqual(requestQa(q,directory).id,repeated.id);
  fs.writeFileSync(path.join(directory,'app.js'),'changed');assert.notEqual(requestQa(q,directory).id,first.id);
});
test('obsolete ready and retry inputs are retired before model calls, without clearing unresolved or leased work',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-stale-input-')),q=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{q.close();fs.rmSync(directory,{recursive:true,force:true});});
  for(const [index,state] of ['ready','retry','await-source','leased'].entries()){
    const j=q.enqueue({kind:'integrate',cardId:card.id,inputRevision:String(index),payload:{cardRevision:digest(card)}});
    q.db.prepare('UPDATE jobs SET state=?,attempt=2 WHERE id=?').run(state,j.id);
  }
  assert.equal(retireStaleReadyJobs(q,[{...card,min:6}]).length,2);
  assert.deepEqual(q.list().map(j=>j.state).sort(),['await-source','leased','superseded','superseded']);
  assert.ok(q.list().every(j=>j.attempt===2));
});
test('a provider outage leaves the attempt unchanged, a contract failure or a refused answer still counts',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-fail-job-')),q=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{q.close();fs.rmSync(directory,{recursive:true,force:true});});
  const run=(kind,role,message,options)=>{
    q.enqueue({kind,cardId:message.slice(0,8)+kind,inputRevision:'r',payload:{}});
    const job=q.claim(role,'runtime-'+role);failJob(q,job,role,Error(message),options);return q.get(job.id);
  };
  const limit=run('facts','search',"Claude worker did not complete successfully: usage limit; You've hit your limit");
  assert.equal(limit.attempt,0);assert.equal(limit.state,'retry');
  const login=run('verify-facts','verify','Claude worker did not complete successfully: authentication; API Error: 401');
  assert.equal(login.attempt,0);assert.equal(login.state,'retry');
  const contract=run('integrate','editor','Invalid field value type: notes');
  assert.equal(contract.attempt,1);assert.equal(contract.state,'retry');
  // The model did answer and the controller refused it: a provider-looking message in that answer is not an outage.
  assert.equal(run('review-patch','verify','Missing evidence binding for HTTP 429 quota',{answered:true}).attempt,1);
  assert.equal(run('facts','search','HTTP 429 quota in the quoted text',{answered:true}).attempt,1);
  // QA output can mention a rate limit without any provider being down.
  assert.equal(run('qa','qa','Command failed: node --test\nHTTP 429 too many requests').attempt,1);
});
test('an open systemic circuit leaves deterministic QA available even in a verify-first chain',()=>{
  assert.deepEqual(runRoles({role:'verify',chain:true,circuitOpen:true}),['qa']);
  assert.deepEqual(runRoles({role:'qa',chain:false,circuitOpen:true}),['qa']);
  assert.equal(runRoles({role:'verify',chain:true,circuitOpen:false})[0],'verify');
});
test('capture resolves each quote in its own controller snapshot, including derived calendar evidence',async()=>{
  const bundle={project:'vmeste',cardId:card.id,claims:[claim('priceKind','free','admission is free'),claim('events',[{date:'2026-10-03',start:'09:30'}],'2026-10-03 starts at 09:30')]};
  await captureClaims(bundle,card,{prepared:[first,second],saveImpl:async()=>{},captureImpl:async()=>{throw Error('Must not refetch prepared evidence');}});
  assert.equal(bundle.snapshots.length,2);assert.equal(bundle.claims[0].snapshotId,first.id);assert.equal(bundle.claims[1].snapshotId,second.id);
});
test('a scope-limited critical claim stays unknown without discarding separately supported facts',async()=>{
  const bundle={project:'vmeste',cardId:card.id,claims:[claim('priceKind','free','admission is free'),{...claim('parent','yes','admission is free'),kind:'inference',scope:'uncertain'}]};
  await captureClaims(bundle,card,{prepared:[first],saveImpl:async()=>{}});
  assert.equal(bundle.claims[0].status,'supported');assert.equal(bundle.claims[1].status,'unknown');
  assert.equal(bundle.claims[1].value,null);assert.equal(bundle.claims[1].rejectedValue,'yes');
  assert.match(bundle.claims[1].controllerRejection,/Critical claim/);
});
test('identical facts merge losslessly but distinct values and quotes still require independent verification',async()=>{
  const duplicate={...claim('priceKind','free','admission is free'),key:'another-key',note:'Another explanation.'};
  const bundle={project:'vmeste',cardId:card.id,claims:[claim('priceKind','free','admission is free'),duplicate,claim('priceKind','visit','Official source')]};
  await captureClaims(bundle,card,{prepared:[first],saveImpl:async()=>{}});
  assert.equal(bundle.claims.length,2);
  assert.deepEqual(bundle.claims[0].mergedDuplicates,[{submittedKey:'another-key',note:'Another explanation.'}]);
  assert.equal(bundle.claims[1].value,'visit');
});
test('a figure the quote does not write leaves a claim unknown with the proposal kept, and the other claims continue',async()=>{
  const page=snapshot({url,fetchedAt:now,text:'Children aged 2 to 4 join the course. Admission is free.'});
  const bundle={project:'vmeste',cardId:card.id,claims:[claim('min',2,'aged 2 to 4'),claim('max',6,'aged 2 to 4'),claim('amount',0,'Admission is free'),claim('amount',12,'Admission is free')]};
  await captureClaims(bundle,card,{prepared:[page],saveImpl:async()=>{}});
  const [min,max,free,price]=bundle.claims;
  assert.equal(min.status,'supported');assert.equal(min.value,2);assert.equal(free.status,'supported');assert.equal(free.value,0);
  for(const [row,proposed] of [[max,6],[price,12]]){
    assert.equal(row.status,'unknown');assert.equal(row.value,null);assert.equal(row.rejectedValue,proposed);
    assert.match(row.controllerRejection,/is not written in its quote.*not approved/);assert.match(row.note,/not written in its quote/);
  }
  assert.equal(bundle.snapshots.length,1);
});
test('a draft preserves inspection evidence for unknown coverage even when no binding uses it',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-agent-test-')),queue=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{queue.close();fs.rmSync(directory,{recursive:true,force:true});});
  const draft={bindings:[{field:'priceKind',source:url,quote:'admission is free'}],reviewCoverage:{fields:[{field:'min',outcome:'unknown',snapshotIds:[second.id]}]}};
  await captureDraft(draft,[first,second],queue,{saveImpl:async()=>{}});
  assert.equal(draft.snapshots.length,2);assert.equal(queue.db.prepare('SELECT count(*) AS n FROM captured_evidence').get().n,2);
});
test('prepared calendar evidence is scoped to the exact title, never the whole neighboring programme',async()=>{
  const feed='https://example.org/calendar.ics',link='https://tockify.com/example/detail/123/1790000000000';
  const event=(title,start)=>`BEGIN:VEVENT\nUID:${title}\nURL:${link}\nSUMMARY:${title}\nDTSTART:${start}\nDTEND:20261003T100000Z\nEND:VEVENT\n`;
  const raw=snapshot({url:feed,fetchedAt:now,parser:'calendar-raw-v1',contentType:'text/calendar',text:'BEGIN:VCALENDAR\nVERSION:2.0\n'+event('Exact meeting','20261003T070000Z')+'END:VCALENDAR\n'});
  const record={...card,sources:[{url:link}]},saved=[];
  const job={kind:'facts',payload:{card:record}};
  const prepared=await prepareEvidence(job,{sources:[{type:'ics',url:feed,recordIds:[card.id]}],
    saveImpl:async(_,e)=>saved.push(e),captureImpl:async u=>{if(u===feed)return raw;throw Error('Empty JS page');}});
  assert.equal(saved.length,2);assert.equal(prepared.payload.preparedEvidence.length,1);
  assert.equal(prepared.payload.preparedEvidence[0].parser,'calendar-selected-zurich-v1');
  assert.match(prepared.payload.preparedEvidence[0].text,/09:00/);assert.match(prepared.payload.preparedEvidence[0].text,new RegExp(raw.id));
});
test('sources fetched for earlier leads are captured again for the verifier, ahead of the claim sources',async()=>{
  const poster='https://example.org/poster.pdf',fetched=[];
  const captureImpl=async u=>{fetched.push(u);if(u===poster)throw Error('Invalid evidence snapshot');return {...first,url:u};};
  const payload={card:{...card,sources:[{url}]},bundle:{claims:[],snapshots:[]},followedLeads:[{source:poster,note:'Poster'},{source:url+'/lead',note:'Second'}]};
  const prepared=await prepareEvidence({kind:'verify-facts',payload},{sources:[],saveImpl:async()=>{},captureImpl});
  assert.deepEqual(fetched,[poster,url+'/lead',url]);
  assert.deepEqual(prepared.payload.preparedEvidence.map(e=>e.url),[url+'/lead',url]);
  assert.deepEqual(prepared.payload.evidenceFailures,[{url:poster,status:'capture-unavailable'}]);
  // Only the verifier of claims gets them; an extraction keeps fetching just the leads it was given.
  fetched.length=0;await prepareEvidence({kind:'facts',payload:{...payload,researchLeads:[]}},{sources:[],saveImpl:async()=>{},captureImpl});
  assert.deepEqual(fetched,[url]);
});
test('a source issue URL is captured first and facts contracts carry the notice rule',async()=>{
  const alarm='https://example.org/alarm',fetched=[];
  const captureImpl=async u=>{fetched.push(u);return {...first,url:u};};
  const payload={card:{...card,sources:[{url}]},sourceIssues:[{kind:'possible-closure',details:{url:alarm,lines:[{text:'Closed for works',context:['a','b']}]}}]};
  await prepareEvidence({kind:'facts',payload},{sources:[],saveImpl:async()=>{},captureImpl});
  assert.deepEqual(fetched,[alarm,url]);
  for(const kind of ['facts','verify-facts']){
    const prompt=promptFor({id:'job',kind,input_revision:'revision',payload});
    assert.match(prompt,/verify the quoted notice on the live official page first/);
    assert.match(prompt,/a notice about another offer on the same page does not apply/);
    assert.match(prompt,/an outage is not closure/);
    assert.match(prompt,/never set a status without an exact binding/);
  }
});
test('primary extraction is not anchored on old field values or unrelated public copy',()=>{
  const prompt=promptFor({id:'job',kind:'facts',input_revision:'revision',payload:{card:{...card,notes:['Unrelated old prose'],practical:{commitment:{value:true}}}}});
  assert.doesNotMatch(prompt,/Unrelated old prose|"min":5|"commitment":\{"value":true/);
  assert.match(prompt,/example.org/);
});
test('editor context preserves evidence while omitting duplicate approved claims and model advisory',()=>{
  const one=claim('priceKind','free','admission is free');
  const prompt=promptFor({id:'job',kind:'integrate',input_revision:'r',payload:{card,approved:[one],
    bundle:{project:'vmeste',cardId:card.id,claims:[one],snapshots:[first],semanticAdvisory:{secretMarker:'Repeated advisory'}}}});
  assert.equal(prompt.split('"key":"priceKind"').length-1,1);assert.doesNotMatch(prompt,/Repeated advisory/);
  assert.match(prompt,/admission is free/);assert.match(prompt,new RegExp(first.id));
});
// An editor or reviewer job for a card with about thirty claims sits at the 60,000-character input limit; what cannot apply to the job is left out.
test('editor and reviewer prompts carry full-review reference data, the stale-update rule and the OCR rule only when the job can use them',()=>{
  const one={...claim('priceKind','free','admission is free'),submittedKey:'price-free'},open={...claim('languages',null,''),status:'unknown',submittedKey:'language-unknown'};
  const payload={card,approved:[one],bundle:{project:'vmeste',cardId:card.id,claims:[one,open],snapshots:[first]},staleApprovedUpdates:[]};
  const read=job=>{const prompt=promptFor({id:'j',input_revision:'r',...job});return {prompt,data:JSON.parse(prompt.split('TASK DATA:\n')[1])};};
  for(const kind of ['integrate','review-patch']){
    const partial=read({kind,payload:{...payload,primaryReviewStatus:'partial'}}),complete=read({kind,payload:{...payload,primaryReviewStatus:'complete'}});
    for(const status of ['incomplete',undefined])assert.doesNotMatch(read({kind,payload:{...payload,primaryReviewStatus:status}}).prompt,/"fullReviewUnknownText"|"fullReviewFields"/);
    assert.doesNotMatch(partial.prompt,/"submittedKey"|"fullReviewUnknownText"|"fullReviewFields"/);
    assert.doesNotMatch(partial.prompt,/If staleApprovedUpdates are supplied|A tesseract-eng-poster-v1 snapshot is OCR/);
    // Every field keeps its meaning and type; the claims keep their key, value, source, quote and note.
    assert.deepEqual(Object.keys(partial.data.fieldDictionary),Object.keys(complete.data.fieldDictionary));
    assert.match(partial.data.fieldDictionary['practical.indoor'].meaning,/indoors/);assert.equal(partial.data.fieldDictionary.min.type,'number');
    assert.deepEqual(partial.data.approved,[claim('priceKind','free','admission is free')]);assert.equal(partial.data.bundle.claims[0].note,open.note);
    assert.ok(complete.data.fieldDictionary.age.fullReviewUnknownText.length);assert.ok(complete.data.fieldDictionary['practical.indoor'].fullReviewUnknownText.length);
    assert.ok(Array.isArray(complete.data.fullReviewFields));assert.ok(complete.prompt.length-partial.prompt.length>2500);
    // The rules for building full coverage go with them; a partial job is told in one sentence what it may not contain.
    assert.match(complete.prompt,/covering EVERY fullReviewFields entry with its resulting value/);assert.doesNotMatch(partial.prompt,/covering EVERY fullReviewFields entry/);
    assert.match(partial.prompt,/A partial review preserves checked: this draft has no patch\.checked, no reviewCoverage and no review\.FIELD binding\. reviewAfter is an internal future target/);
    for(const prompt of [partial.prompt,complete.prompt])assert.match(prompt,/The editor may renew checked or supply reviewCoverage ONLY when primaryReviewStatus is complete/);
  }
  const stale=read({kind:'review-patch',payload:{...payload,staleApprovedUpdates:[{jobId:'old',draft:{snapshots:[first]}}]}});
  assert.match(stale.prompt,/If staleApprovedUpdates are supplied, reconcile EACH previous patch/);assert.match(stale.prompt,/checkedStaleUpdates\. No approval can supersede/);
  // Extraction and claim verification are not at the limit and keep everything they had.
  const verify=read({kind:'verify-facts',payload:{card,requestedReview:'full',bundle:payload.bundle}});
  assert.match(verify.prompt,/"submittedKey":"price-free"/);assert.ok(verify.data.fieldDictionary.age.fullReviewUnknownText);assert.ok(Array.isArray(verify.data.fullReviewFields));
  assert.ok(Array.isArray(read({kind:'facts',payload:{card}}).data.fullReviewFields));
  for(const prompt of [verify.prompt,read({kind:'facts',payload:{card}}).prompt])assert.match(prompt,/covering EVERY fullReviewFields entry with its resulting value/);
});
test('rejected draft context retains bindings and snapshot hashes without duplicating whole source texts',()=>{
  const rejectedDraft={patch:{age:'To be confirmed'},bindings:[{field:'age',quote:'Exact excerpt'}],snapshots:[{...first,text:'Long repeated body '.repeat(3000)}]};
  const prompt=promptFor({id:'job',kind:'integrate',input_revision:'r',payload:{card,rejectedDraft}});
  assert.doesNotMatch(prompt,/Long repeated body/);assert.match(prompt,/Exact excerpt/);assert.match(prompt,new RegExp(first.id));
  assert.match(prompt,new RegExp(digest(rejectedDraft)));assert.ok(prompt.length<60000);
});
test('every original snapshot remains readable in a worker file, independently of a fresh capture',async()=>{
  const job={id:'job',kind:'review-patch',input_revision:'r',payload:{card,preparedEvidence:[second],
    bundle:{claims:[],snapshots:[first]},draft:{snapshots:[first]},rejectedDraft:{snapshots:[second]},
    staleApprovedUpdates:[{draft:{snapshots:[first]}}]}};
  const policy={roles:{verify:{model:'test-model',effort:'low',criticalEffort:'medium'}},maxToolCallsPerJob:50};
  const data=JSON.parse(promptFor(job).split('TASK DATA:\n')[1]);
  const references=[...data.preparedEvidence,...data.bundle.snapshots,...data.draft.snapshots,...data.rejectedDraft.snapshots,...data.staleApprovedUpdates[0].draft.snapshots];
  assert.deepEqual(references.map(e=>e.evidenceFile),workerEvidenceFiles(job).map(e=>e.file));
  let directory;
  const output=await runCodex(job,policy,{runImpl:(_command,args)=>{
    directory=args[args.indexOf('--cd')+1];
    for(const {file,evidence} of workerEvidenceFiles(job)){
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,file),'utf8')),evidence);
      assert.equal(fs.statSync(path.join(directory,file)).mode&0o777,0o600);
    }
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
    child.stdin={end:()=>{
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({project:'vmeste',jobId:job.id,inputRevision:'r',resultJson:JSON.stringify({verdict:'await-source'})}));
      queueMicrotask(()=>child.emit('close',0));
    }};
    return child;
  }});
  assert.equal(output.result.verdict,'await-source');assert.equal(fs.existsSync(directory),false);
});
test('an investigated input-budget repair preserves attempts and immutable failure history',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-input-repair-')),q=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{q.close();fs.rmSync(directory,{recursive:true,force:true});});
  q.enqueue({kind:'integrate',cardId:card.id,inputRevision:'old',payload:{card,cardRevision:digest(card)}});
  const old=q.claim('editor','editor');q.fail(old.id,old.token,'editor','Worker input exceeds budget; split the task without truncating evidence');
  const result=upgradeInputBudgetJob(q,old.id,'Removed repeated advisory and duplicated approved claims.',{getInputs:()=>({records:[card]})});
  assert.equal(q.get(old.id).state,'superseded');assert.equal(q.get(old.id).attempt,1);assert.equal(q.get(result.jobId).attempt,1);
  assert.equal(q.claim('editor','editor').attempt,2);assert.match(q.get(old.id).error,/input exceeds/);
  assert.throws(()=>upgradeInputBudgetJob(q,old.id,'Again',{getInputs:()=>({records:[card]})}),/Only a retryable/);
});
test('supplementary pilot documents remain unapproved, public and bounded',()=>{
  assert.deepEqual(normalizePilotSources([url+'#page=2',url],{pilot:true}),[url]);
  assert.throws(()=>normalizePilotSources([url]),/explicit pilot/);
  assert.throws(()=>normalizePilotSources(Array(4).fill(url),{pilot:true}),/At most three/);
  assert.throws(()=>normalizePilotSources(['https://localhost/private'],{pilot:true}),/Non-public/);
  const prompt=promptFor({id:'j',kind:'verify-facts',input_revision:'r',payload:{bundle:{claims:[],snapshots:[]}}});
  assert.match(prompt,/controller can extract PDFs up to 20 MB locally/);
});
test('full primary verification receives all field meanings and the controller quote rules',()=>{
  const payload={card,requestedReview:'full',bundle:{claims:[claim('min',2,'Course is on Monday')],snapshots:[first]}};
  const job={id:'job',kind:'verify-facts',input_revision:'r',payload};
  const prompt=promptFor(job),data=JSON.parse(prompt.split('TASK DATA:\n')[1]);
  assert.ok(data.fieldDictionary.contacts);assert.ok(data.fieldDictionary.status);assert.ok(data.fieldDictionary['practical.indoor']);
  const partial=JSON.parse(promptFor({...job,payload:{...payload,requestedReview:'partial'}}).split('TASK DATA:\n')[1]);
  assert.equal(partial.fieldDictionary.contacts,undefined);assert.ok(partial.fieldDictionary.min);
  assert.match(prompt,/normalizes Unicode NFC and collapses whitespace/);
});
test('an incomplete full-review prompt repair requires the rejected draft, preserves attempts and cannot renew checked',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-coverage-repair-')),q=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{q.close();fs.rmSync(directory,{recursive:true,force:true});});
  q.enqueue({kind:'integrate',cardId:card.id,inputRevision:'old',payload:{card,cardRevision:digest(card),requestedReview:'full'}});
  const old=q.claim('editor','editor');q.fail(old.id,old.token,'editor','checked requires a current full-card review');
  const inputs={getInputs:()=>({records:[card]})};
  assert.throws(()=>upgradeInvestigatedJob(q,old.id,'Corrected downgrade instructions.',inputs),/intact rejected partial draft/);
  const artifact={rejected:true,result:{draft:{patch:{},reviewCoverage:{mode:'full'},reviewLimitations:['Library source unavailable.']}}};
  q.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(digest(artifact),old.id,'editor',JSON.stringify(artifact),q.now());
  assert.throws(()=>upgradeInputBudgetJob(q,old.id,'Wrong repair route.',inputs),/Only a retryable/);
  const upgraded=upgradeInvestigatedJob(q,old.id,'Corrected partial fallback; no coverage or checked renewal.',inputs);
  assert.equal(q.get(old.id).state,'superseded');assert.equal(q.get(upgraded.jobId).attempt,1);
  assert.equal(q.claim('editor','editor').attempt,2);
  assert.match(promptFor(old),/Omit BOTH patch.checked and reviewCoverage entirely/);
});
test('the usage of a worker answer or failure carries the wall time of the model call',async()=>{
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const done=await timedWorker(async(a,b)=>{await pause(30);return {result:{a,b},usage:{model:'m'}};},1,2);
  assert.deepEqual(done.result,{a:1,b:2});assert.equal(done.usage.model,'m');assert.ok(done.usage.modelSeconds>=0&&done.usage.modelSeconds<5);
  const failure=Object.assign(Error('Worker time limit'),{usage:{model:'m',toolCalls:1}});
  await assert.rejects(timedWorker(async()=>{await pause(30);throw failure;}),error=>error===failure&&typeof failure.usage.modelSeconds==='number');
  await assert.rejects(timedWorker(async()=>{throw Error('no usage on this one');}),/no usage/);
});

// Stage 2: a capture of a watched page is saved and registered together with the monitor's view of the same bytes.
const WATCHED='https://example.org/spielgruppe',watchSource={id:'fx',url:WATCHED,type:'html',recordIds:['course'],minChars:10};
const WATCHED_PAGE=`<html><head><title>Spielgruppe Teststadt: vorübergehend geschlossen bis 30.11.2099</title></head><body><nav>Startseite</nav>
<main><h1>Spielgruppe Teststadt</h1><p>Jeden Mittwoch 15:00 bis 16:00 Uhr fuer Kinder von 2 bis 4 Jahren.</p></main><footer><p>Kontakt: Fixture Verein, Probeweg 5</p></footer></body></html>`;
const realCapture=(u,options={})=>captureUrl(u,{...options,now,lookupImpl:async()=>[{address:'93.184.216.34'}],fetchImpl:async()=>new Response(WATCHED_PAGE,{headers:{'content-type':'text/html'}})});
const memoryQueue=t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-views-queue-')),queue=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{queue.close();fs.rmSync(directory,{recursive:true,force:true});});return queue;
};
test('watchFor finds the monitor entry of a page by its address, with or without www and slash',()=>{
  const sources=[watchSource],hostIgnore={'example.org':{selectors:['footer']}};
  assert.equal(watchFor('https://www.example.org/spielgruppe/',{sources,hostIgnore}).source,watchSource);
  assert.deepEqual(watchFor(WATCHED,{sources,hostIgnore,records:[card]}).hostIgnore,hostIgnore);
  assert.equal(watchFor('https://example.org/other',{sources}),null);
});
test('prepare saves and registers the monitor view beside the capture and gives the worker only the capture',async t=>{
  const queue=memoryQueue(t),saved=[];
  const prepared=await prepareEvidence({kind:'facts',payload:{card:{...card,sources:[{url:WATCHED}]}}},{sources:[watchSource],queue,saveImpl:async(_,e)=>saved.push(e),captureImpl:realCapture});
  const [capture]=prepared.payload.preparedEvidence,[view]=capturedViews(capture);
  assert.equal(prepared.payload.preparedEvidence.length,1);assert.equal(capture.parser,'cheerio-visible-body-v1');
  assert.deepEqual(saved.map(e=>e.parser),['cheerio-visible-body-v1','monitor-view-v2']);
  assert.equal(queue.db.prepare('SELECT count(*) AS n FROM captured_evidence').get().n,2);
  assertCaptured(queue,{snapshots:[capture,view]});
  assert.equal(JSON.stringify(prepared.payload.preparedEvidence).includes('monitor-view-v2'),false);
});
test('a claim quoting the notice in the title is bound to the registered monitor view, a claim from the body stays on the capture',async t=>{
  const queue=memoryQueue(t),prepared=await prepareEvidence({kind:'facts',payload:{card:{...card,sources:[{url:WATCHED}]}}},{sources:[watchSource],queue,saveImpl:async()=>{},captureImpl:realCapture});
  const [capture]=prepared.payload.preparedEvidence,[view]=capturedViews(capture);
  const on=(field,value,quote)=>({...claim(field,value,quote),source:WATCHED});
  const bundle={project:'vmeste',cardId:card.id,claims:[on('status','closed','vorübergehend geschlossen bis 30.11.2099'),on('priceKind','unknown','Jeden Mittwoch 15:00 bis 16:00 Uhr')]};
  await captureClaims(bundle,card,{prepared:prepared.payload.preparedEvidence,queue,saveImpl:async()=>{}});
  assert.equal(bundle.claims[0].status,'supported');assert.equal(bundle.claims[0].snapshotId,view.id);
  assert.equal(bundle.claims[1].snapshotId,capture.id);
  assert.deepEqual(bundle.snapshots.map(e=>e.parser).sort(),['cheerio-visible-body-v1','monitor-view-v2']);
  assertCaptured(queue,bundle);
});
test('a quote that is in neither view is still refused, and a fresh capture brings its views along',async t=>{
  const queue=memoryQueue(t),captured=[];
  const bundle={project:'vmeste',cardId:card.id,claims:[{...claim('priceKind','free','CHF 99 pro Kind'),source:WATCHED},{...claim('status','closed','vorübergehend geschlossen bis 30.11.2099'),source:WATCHED}]};
  await captureClaims(bundle,card,{queue,saveImpl:async(_,e)=>captured.push(e.parser),captureImpl:async(u,options)=>{
    assert.equal(options.watch,null);return realCapture(u,{watch:{source:watchSource,hostIgnore:{},records:[card]}});}});
  assert.equal(bundle.claims[0].status,'unknown');assert.match(bundle.claims[0].note,/could not establish the supplied quote/);
  assert.equal(bundle.claims[1].status,'supported');assert.deepEqual(captured,['cheerio-visible-body-v1','monitor-view-v2']);
});
test('a draft binding quoting the title notice is bound to the registered view too',async t=>{
  const queue=memoryQueue(t),capture=await realCapture(WATCHED,{watch:{source:watchSource,hostIgnore:{},records:[card]}}),[view]=capturedViews(capture);
  const draft={bindings:[{field:'status',source:WATCHED,quote:'vorübergehend geschlossen bis 30.11.2099'},{field:'priceKind',source:WATCHED,quote:'Jeden Mittwoch 15:00 bis 16:00 Uhr'}]};
  await captureDraft(draft,[capture],queue,{saveImpl:async()=>{}});
  assert.equal(draft.bindings[0].snapshotId,view.id);assert.equal(draft.bindings[1].snapshotId,capture.id);
  assertCaptured(queue,draft);
  // A fresh capture of the same page, no prepared evidence: the binding finds its quote in the view of the new capture.
  const second={bindings:[{field:'status',source:WATCHED,quote:'vorübergehend geschlossen bis 30.11.2099'}]};
  await captureDraft(second,[],queue,{saveImpl:async()=>{},captureImpl:async u=>realCapture(u,{watch:{source:watchSource,hostIgnore:{},records:[card]}})});
  assert.equal(second.snapshots[0].parser,'monitor-view-v2');assertCaptured(queue,second);
});
test('a stored monitor copy is never a controller capture, even when the controller holds the very same page',async t=>{
  const queue=memoryQueue(t),directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-copy-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const capture=await realCapture(WATCHED,{watch:{source:watchSource,hostIgnore:{},records:[card]}});
  registerCaptured(queue,capture);
  // The monitor stored the same page earlier in the day: its copies carry another fetch time, so none of them is the registered capture.
  const text=capture.text,storedText='Stored change text of the watched fixture page.',entry={hash:hash(storedText),lastSuccess:'2026-10-14T04:00:00.000Z',parser:'v2'};
  fs.mkdirSync(path.join(directory,'versions','fx'),{recursive:true});fs.writeFileSync(path.join(directory,'versions','fx',entry.hash.slice(0,12)+'.txt'),storedText+'\n');
  await writeRecord(directory,'fx',{version:entry.hash.slice(0,12),hash:entry.hash,fetchedAt:entry.lastSuccess,finalUrl:WATCHED,contentType:'text/html',status:200,parser:'v2',rawHash:capture.rawHash,rawBytes:1,raw:null,
    full:{parser:'cheerio-visible-body-v1',text},alarm:[]});
  const stored=await monitorRecord(watchSource,entry,directory);
  for(const copy of [stored.watch,stored.full])assert.throws(()=>assertCaptured(queue,{snapshots:[copy]}),/lacks controller capture provenance/);
  assertCaptured(queue,{snapshots:[capture]});
});
