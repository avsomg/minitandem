import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {loadCatalog,qualityReport,root} from './quality.mjs';
import {JobQueue,digest,ROLE_KINDS,sourceSignal} from './jobs.mjs';
import {pipelineReport,readPipelineInputs,validateCandidate,validateDecision,validateDispute,
  validateCorrection,recordRevision,venueGroups} from './external-pipeline.mjs';
import {readExternalReviewInputs,validateReceipt} from './external-review.mjs';
import {locateQuote,evidenceProblem,validateSnapshot,writeJsonAtomic,publicUrl} from './evidence.mjs';
import {PATCH_FIELDS,PRACTICAL_FIELDS,CLAIM_FIELDS,CRITICAL_FIELDS,validateFieldValue,validDate,fullReviewFields,FULL_REVIEW_UNKNOWN_TEXT,FULL_REVIEW_UNKNOWN_PRACTICAL_TEXT} from './field-contract.mjs';
import {PROJECT_ID} from './project-id.mjs';
import {approvalSummary} from './catalogue-journal.mjs';
import {NUMBER_FIELDS,numberProblem,writesNumber} from './quote-numbers.mjs';

export const here=path.join(root,'editorial');
export {root};
export const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
export {PATCH_FIELDS,PRACTICAL_FIELDS,CLAIM_FIELDS};
const CRITICAL=CRITICAL_FIELDS;
const EXACT_FIELDS=new Set(['min','max','ageUpperUncertainFrom','parent','languages','days','events','scheduleValidThrough','priceKind','amount','contacts','addressPrecision']);
const read=(file,fallback=null)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;
const safeId=id=>typeof id==='string'&&/^[a-z0-9][a-z0-9-]*$/.test(id);
const date=validDate;

export function currentInputs(){
  const catalog=loadCatalog(),records=catalog.ACTIVITIES,{receipts}=readExternalReviewInputs(),inputs=readPipelineInputs();
  const pipeline=pipelineReport(records,receipts,inputs.receiptBaseline,inputs.registry,inputs.candidates,inputs.disputes,inputs.decisions,today(),inputs.corrections,inputs.approvedUpdates);
  const approvedUpdates=read(path.join(here,'approved-updates.json'),{updates:[]}).updates;
  return {records,receipts,...inputs,pipeline,approvedUpdates,staleUpdates:catalog.STALE_UPDATES||[]};
}
export const dependencyRevision=(input,id)=>digest([input.candidates.get(id)||null,
  input.receipts.find(r=>r.id===id)||null,input.disputes.get(id)||null,input.decisions.get(id)||null]);
export function taskSpecs(input,{quality=null,monitor=null,date=today()}={}){
  const byId=new Map(input.records.map(r=>[r.id,r]));
  const priority=new Map((quality?.queue||[]).map(row=>[row.id,row.priority]));
  const jobs=[];
  const staleIds=new Set((input.staleUpdates||[]).map(s=>s.id));
  const addEditorial=id=>{
    const card=byId.get(id);if(!card)return;
    const cardRevision=digest(card);
    const corrections=[...input.corrections].filter(([,c])=>c.id===id&&c.status==='proposed').map(([file,correction])=>({file,correction}));
    const staleApprovedUpdates=(input.approvedUpdates||[]).filter(update=>update.draft.cardId===id&&
      input.staleUpdates?.some(s=>s.jobId===update.jobId)).map(update=>({jobId:update.jobId,revision:digest(update),draft:update.draft}));
    jobs.push({kind:'editorial',cardId:id,inputRevision:digest(['editorial',cardRevision,corrections,staleApprovedUpdates]),
      priority:500+(priority.get(id)||0),payload:{card,cardRevision,corrections,staleApprovedUpdates,date}});
  };
  for(const row of input.pipeline.rows){
    const card=byId.get(row.id),cardRevision=digest(card),candidate=input.candidates.get(row.id);
    const receipt=input.receipts.find(r=>r.id===row.id);
    if(['search','verify','adjudicate'].includes(row.researchStage)){
      const kind=row.researchStage==='adjudicate'?'adjudicate':row.researchStage;
      const dispute=input.disputes.get(row.id),decision=input.decisions.get(row.id);
      const payload={card,cardRevision,candidate:candidate||null,receipt:receipt||null,
        dispute:dispute||null,decision:decision||null,date,dependencyRevision:dependencyRevision(input,row.id)};
      jobs.push({kind,cardId:row.id,inputRevision:digest([kind,cardRevision,candidate,receipt,dispute,decision]),
        priority:(priority.get(row.id)||0)+(kind==='search'?0:60),payload});
    }
    if(row.editorialStatus==='required'||staleIds.has(row.id))addEditorial(row.id);
  }
  for(const id of staleIds)if(!input.pipeline.rows.some(row=>row.id===id))addEditorial(id);
  for(const row of quality?.queue||[]){
    if(!row.stale&&!row.sourceIssues.length&&!(row.nextEvent&&row.critical.length))continue;
    const card=byId.get(row.id),cardRevision=digest(card);
    const sourceRevisions=(row.watched||[]).map(id=>[id,monitor?.sources?.[id]?.hash||null]);
    const sourceSignals=row.sourceIssues.map(({id,sourceId,kind,status,details})=>({id,sourceId,kind,status,details}));
    const requestedReview=row.stale?'full':'partial';
    const sourceTasks=row.sourceIssues.map(issue=>{
      const version=monitor?.sources?.[issue.sourceId]?.hash||issue.details?.to||'unavailable';
      const signal=sourceSignal(issue);
      return {key:digest([row.id,issue.sourceId,version,signal]),sourceId:issue.sourceId,version,signal,taskId:issue.id};
    });
    const trigger=['facts',row.id,card.sources.map(s=>s.url),sourceRevisions,sourceSignals];
    if(requestedReview==='full')trigger.push('full-review-v1',card.reviewAfter,card.checked,Math.floor(Date.parse(date+'T12:00:00Z')/(7*86400000)));
    const triggerRevision=digest(trigger);
    jobs.push({kind:'facts',cardId:row.id,inputRevision:digest(['facts',cardRevision,triggerRevision]),
      priority:row.priority,payload:{card,cardRevision,triggerRevision,requestedReview,critical:row.critical,sourceIssues:row.sourceIssues,sourceTasks,sourceVersions:sourceRevisions,
        urgent:row.sourceIssues.some(issue=>issue.kind==='possible-closure'||issue.details?.fields?.includes('address'))||Boolean(row.nextEvent&&row.nextEvent>=date&&row.nextEvent<=new Date(Date.parse(date+'T12:00:00Z')+14*86400000).toISOString().slice(0,10)),date}});
  }
  for(const [file,intake] of input.intakeReports||[]){
    if(intake.status!=='pending-review')continue;
    const card=byId.get(intake.report.activity);if(!card)continue;
    jobs.push({kind:'facts',cardId:card.id,inputRevision:digest(['intake',file,intake,card]),priority:450,
      payload:{card,cardRevision:digest(card),triggerRevision:digest(['intake',file,intake]),requestedReview:'partial',date,intakeReference:file,reportedTopic:intake.report.topic}});
  }
  return jobs;
}
export function unprocessedSpecs(queue,specs){
  const processed=new Set(queue.list().filter(job=>job.kind==='facts'&&job.state==='done'&&job.payload.triggerRevision)
    .map(job=>job.payload.triggerRevision));
  const dispositions=new Set(queue.dispositions().map(row=>row.key));
  const blocked=queue.list().filter(job=>job.state==='await-source'&&!job.payload.resumeWhen?.resumedBy);
  const resumed=new Set(queue.list().filter(job=>job.payload.resumeJob&&['ready','leased','retry'].includes(job.state)).map(job=>job.card_id));
  return specs.filter(spec=>{
    if(spec.kind==='facts'&&resumed.has(spec.cardId))return false;
    if(spec.kind==='facts'&&blocked.some(job=>job.card_id===spec.cardId))return false;
    if(spec.payload.requestedReview==='partial'&&spec.payload.sourceTasks?.length&&spec.payload.sourceTasks.every(row=>dispositions.has(row.key)))return false;
    return !spec.payload.triggerRevision||!processed.has(spec.payload.triggerRevision);
  });
}
export function resumeCondition(payload,monitor=null,reviewDate=null){
  const sources=(payload.sourceVersions||payload.sourceTasks?.map(row=>[row.sourceId,row.version])||[]).map(([id,version])=>({id,version,
    unavailable:Boolean(payload.sourceIssues?.some(issue=>issue.sourceId===id&&issue.kind==='source-unavailable')),
    lastSuccess:monitor?.sources?.[id]?.lastSuccess||null}));
  return {sources,...(reviewDate&&reviewDate>today()?{date:reviewDate}:{}),...(!sources.length&&!reviewDate?{manual:'A new official source must be supplied after investigation.'}:{})};
}
export function resumeAwaitingSources(queue,input,monitor,date=today(),sources=[]){
  const resumed=[];
  for(const job of queue.list().filter(job=>job.state==='await-source'&&!job.payload.resumeWhen?.resumedBy)){
    if(!job.payload.sourceVersions)job.payload.sourceVersions=sources.filter(source=>source.recordIds?.includes(job.card_id)).map(source=>[source.id,monitor?.sources?.[source.id]?.hash||null]);
    const condition=job.payload.resumeWhen||resumeCondition(job.payload,monitor),changed=condition.sources.filter(source=>{
      const current=monitor?.sources?.[source.id];
      return current&&(current.hash!==source.version&&current.hash||source.unavailable&&!current.error&&current.lastSuccess&&current.lastSuccess!==source.lastSuccess);
    });
    const restored=(job.payload.sourceTasks||[]).some(source=>monitor?.queue?.some(task=>task.id===source.taskId&&task.status==='resolved'&&task.resolution?.decision==='source-restored'));
    const signals=(job.payload.sourceTasks||[]).map(source=>monitor?.queue?.find(task=>task.id===source.taskId)).filter(task=>task&&(job.payload.sourceTasks||[]).some(source=>source.taskId===task.id&&source.signal!==sourceSignal(task)));
    if(changed.length||restored||signals.length||condition.date&&date>=condition.date){
      const card=input.records.find(card=>card.id===job.card_id);if(!card)continue;
      const versions=(job.payload.sourceVersions||[]).map(([id])=>[id,monitor?.sources?.[id]?.hash||null]);
      const reason={changed:changed.map(row=>[row.id,monitor.sources[row.id].hash,monitor.sources[row.id].lastSuccess]),restored,signals:signals.map(sourceSignal),date:condition.date||null};
      const triggerRevision=digest(['resume',job.id,reason]);
      const next=queue.enqueue({kind:'facts',cardId:card.id,inputRevision:digest([card,triggerRevision]),priority:job.priority,
        payload:{card,cardRevision:digest(card),date,triggerRevision,requestedReview:job.payload.requestedReview||'partial',resumeJob:true,resumedFrom:job.id,
          sourceVersions:versions,sourceTasks:(job.payload.sourceTasks||[]).map(row=>{const version=monitor?.sources?.[row.sourceId]?.hash||row.version;
            const task=monitor?.queue?.find(task=>task.id===row.taskId),signal=task?sourceSignal(task):row.signal;return {...row,version,signal,key:digest([card.id,row.sourceId,version,signal])};}),
          sourceIssues:job.payload.sourceIssues||[],urgent:job.payload.urgent}});
      condition.resumedBy=next.id;queue.event(job.id,'source-work-resumed',{jobId:next.id,reason});resumed.push(next.id);
    }
    queue.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify({...job.payload,resumeWhen:condition}),job.id);
  }
  return resumed;
}
export function retireStaleReadyJobs(queue,records){
  const revisions=new Map(records.map(card=>[card.id,digest(card)])),retired=[];
  queue.transaction(()=>{
    // QA tests the built catalogue at a source revision of its own. The approval that
    // requests it always changes its card, so card staleness must not retire it.
    for(const job of queue.list())if(['ready','retry'].includes(job.state)&&job.kind!=='qa'&&job.payload.cardRevision&&
      revisions.get(job.card_id)!==job.payload.cardRevision){
      queue.db.prepare("UPDATE jobs SET state='superseded',updated_at=? WHERE id=?").run(queue.now(),job.id);
      queue.event(job.id,'stale-card-input-retired',{previousRevision:job.payload.cardRevision,currentRevision:revisions.get(job.card_id)||null});
      retired.push(job.id);
    }
  });return retired;
}
export function syncQueue(queue){
  queue.flush(root);
  const input=currentInputs();
  retireStaleReadyJobs(queue,input.records);
  const sources=read(path.join(here,'source-watch.json')).sources;
  const monitor=read(path.join(here,'monitor-state.json'));
  const quality=qualityReport(input.records,sources,today(),monitor);
  queue.transaction(()=>resumeAwaitingSources(queue,input,monitor,today(),sources));
  queue.reconcile(unprocessedSpecs(queue,taskSpecs(input,{quality,monitor})));
  return {input,summary:queue.summary()};
}
export function validateClaims(bundle,card,{now=new Date().toISOString()}={}){
  if(bundle?.project!==PROJECT_ID||bundle.cardId!==card.id||!Array.isArray(bundle.claims)||!Array.isArray(bundle.snapshots))throw Error('Invalid claim bundle');
  const snapshots=new Map();
  for(const evidence of bundle.snapshots){
    validateSnapshot(evidence);if(evidenceProblem(evidence,now,7))throw Error('Stale or future evidence');
    if(snapshots.has(evidence.id))throw Error('Duplicate snapshot');snapshots.set(evidence.id,evidence);
  }
  const keys=new Set();
  for(const claim of bundle.claims){
    if(!claim.key||keys.has(claim.key)||!CLAIM_FIELDS.has(claim.field)||!['supported','unknown','conflicting'].includes(claim.status)||
      !['exact-card','venue-only','uncertain'].includes(claim.scope)||!claim.note?.trim())throw Error(`Invalid field claim: ${claim.field||'(missing field)'}`);
    keys.add(claim.key);
    if(claim.status==='supported'){
      validateFieldValue(claim.field,claim.value,{allowUnknown:false});
      const evidence=snapshots.get(claim.snapshotId);
      if(!evidence||claim.source!==evidence.url||!locateQuote(evidence,claim.quote))throw Error('Claim quote missing from snapshot');
      const slip=numberProblem(claim.field,claim.value,claim.quote);
      if(slip)throw Error(`Invalid field claim: ${slip}`);
      if((CRITICAL.has(claim.field)||claim.field.startsWith('practical.'))&&(claim.kind!=='official'||claim.scope!=='exact-card'))throw Error('Critical claim requires exact official evidence');
    }else if(claim.value!==null)throw Error('Unknown/conflicting claim must have null value');
  }
  return bundle;
}
export function assertConsistentClaims(claims){
  const values=new Map();
  for(const claim of claims){
    if(!EXACT_FIELDS.has(claim.field)&&!claim.field.startsWith('practical.'))continue;
    if(Array.isArray(claim.value)||typeof claim.value==='object'||typeof claim.value==='string'&&claim.field.startsWith('practical.'))continue;
    const value=digest(claim.value);
    if(values.has(claim.field)&&values.get(claim.field)!==value)throw Error('Conflicting approved scalar claims: '+claim.field);
    values.set(claim.field,value);
  }
}
export function registerCaptured(queue,evidence){
  validateSnapshot(evidence);
  const old=queue.db.prepare('SELECT data FROM captured_evidence WHERE id=?').get(evidence.id);
  if(old&&digest(JSON.parse(old.data))!==digest(evidence))throw Error('Captured evidence conflict');
  queue.db.prepare('INSERT OR IGNORE INTO captured_evidence VALUES (?,?,?)').run(evidence.id,JSON.stringify(evidence),queue.now());
}
export function assertCaptured(queue,bundle){
  for(const evidence of bundle.snapshots){
    const stored=queue.db.prepare('SELECT data FROM captured_evidence WHERE id=?').get(evidence.id);
    if(!stored||digest(JSON.parse(stored.data))!==digest(evidence))throw Error('Snapshot lacks controller capture provenance');
  }
}
const orderEvents=list=>Array.isArray(list)&&list.every(e=>typeof e?.date==='string')?
  list.filter((e,i)=>list.findIndex(f=>isDeepStrictEqual(e,f))===i).sort((a,b)=>a.date.localeCompare(b.date)||(a.start||'').localeCompare(b.start||'')):list;
export const orderDraftEvents=(draft,approved=[])=>!approved.some(c=>c.field==='events')||!Array.isArray(draft?.patch?.events)?draft:
  {...draft,patch:{...draft.patch,events:orderEvents(draft.patch.events)},...(Array.isArray(draft.reviewCoverage?.fields)&&{reviewCoverage:{...draft.reviewCoverage,
    fields:draft.reviewCoverage.fields.map(row=>row?.field==='events'?{...row,value:orderEvents(row.value)}:row)}})};
// A public citation is a link families can open: a finding's url and the source of a practical fact. Each must be a page the controller
// captured for that very field, so a quote bound to source A cannot publish a link to an unrelated source B.
// The cited address must be the source of one of the field's own bindings, or the address that source finally redirected to
// (the snapshot's url and finalUrl, which evidence.mjs records side by side). Both sides are compared as publicUrl writes them:
// https, no fragment, nothing else normalised, so another path, query or trailing slash is another page unless the server redirected there.
// A field bound to several sources may cite any of them, never a source that is bound only to another field. A link that is only context
// is cited by capturing it and binding a quote from it. The findings are research.findings.N, a practical fact is practical.KEY.
const citedAddress=value=>{try{return publicUrl(value);}catch{return null;}};
export function citationProblems(draft){
  const snapshots=new Map((draft.snapshots||[]).map(evidence=>[evidence.id,evidence]));
  const supported=field=>new Set((draft.bindings||[]).filter(b=>b.field===field).flatMap(b=>{
    const evidence=snapshots.get(b.snapshotId);return evidence?[evidence.url,evidence.finalUrl]:[];
  }));
  const citations=[...draft.findings.map((finding,index)=>['research.findings.'+index,finding.url]),
    ...Object.entries(draft.practicalPatch||{}).map(([key,fact])=>['practical.'+key,fact.source])];
  return citations.filter(([field,url])=>{const address=citedAddress(url);return !address||!supported(field).has(address);}).map(([field])=>field);
}
export function validateBindings(queue,draft,approved=[]){
  if(!Array.isArray(draft.bindings)||!Array.isArray(draft.snapshots))throw Error('Draft needs captured evidence bindings');
  assertCaptured(queue,{snapshots:draft.snapshots});
  const snapshots=new Map(draft.snapshots.map(e=>[e.id,e]));
  const fields=[...Object.keys(draft.patch).filter(k=>!['checked','reviewAfter'].includes(k)),...Object.keys(draft.practicalPatch||{}).map(k=>'practical.'+k),
    ...draft.findings.map((_,index)=>'research.findings.'+index),...(draft.warnings?['practical.warnings']:[])];
  if(draft.reviewCoverage){
    for(const row of draft.reviewCoverage.fields){
      if(row.snapshotIds.some(id=>!snapshots.has(id)||evidenceProblem(snapshots.get(id),queue.now(),7)))throw Error('Full review uses missing or stale evidence');
      if(row.outcome==='confirmed')fields.push('review.'+row.field);
    }
  }
  for(const field of fields){
    const targetField=field.startsWith('review.')?field.slice(7):field;
    const bindings=draft.bindings.filter(b=>b.field===field);
    if(!bindings.length)throw Error(`Missing evidence binding: ${field}`);
    for(const binding of bindings){
      const evidence=snapshots.get(binding.snapshotId);
      if(!evidence||binding.source!==evidence.url||evidenceProblem(evidence,queue.now(),7)||!locateQuote(evidence,binding.quote))throw Error(`Invalid evidence binding: ${field}`);
      if((CRITICAL.has(targetField)||targetField.startsWith('practical.'))&&(binding.kind!=='official'||binding.scope!=='exact-card'))throw Error('Critical patch requires exact official binding');
      if(field.startsWith('review.')&&!draft.reviewCoverage.fields.find(r=>r.field===targetField).snapshotIds.includes(binding.snapshotId))throw Error('Review binding is outside reviewed snapshots');
      if(binding.claimKey){
        const claim=approved.find(c=>c.key===binding.claimKey);
        const derivedProse=field==='notes'||field==='intro'||field.startsWith('research.findings.');
        const conservativeClear=binding.transformation==='clear-unconfirmed'&&binding.reason?.trim()&&
          (!approved.some(c=>c.field===field))&&
          (['min','max','ageUpperUncertainFrom'].includes(field)&&draft.patch[field]===null||field==='languages'&&draft.patch.languages?.length===0);
        if(!claim||!derivedProse&&!conservativeClear&&claim.field!==targetField||claim.source!==binding.source||claim.quote!==binding.quote)throw Error(`Patch binding does not match an approved claim: ${field}`);
      }
    }
    const claims=approved.filter(c=>c.field===targetField);
    const value=field.startsWith('review.')?draft.reviewCoverage.fields.find(r=>r.field===targetField).value:
      field.startsWith('practical.')?draft.practicalPatch?.[field.slice(10)]?.value:draft.patch[field];
    const exactPractical=targetField.startsWith('practical.')&&targetField!=='practical.warnings';
    // events is the one exact field built from many claims: the search worker approves each dated session on its own, so a draft may list any of them,
    // once each, by date then start time (orderDraftEvents sets that form). Every listed session must deeply equal a session of an approved events claim,
    // and this field's bindings must name that claim by claimKey. An unapproved or altered session, or a claim used without its binding, is rejected.
    // Every other exact field, scalar or list, must still equal the whole value of one approved claim.
    if((EXACT_FIELDS.has(targetField)||exactPractical)&&claims.length){
      if(targetField==='events'&&Array.isArray(value)&&value.length)for(const session of value){
        const from=claims.filter(c=>Array.isArray(c.value)&&c.value.some(e=>isDeepStrictEqual(e,session)));
        if(!from.length)throw Error(`Patch contradicts approved value: ${field}; no approved claim lists ${JSON.stringify(session)}`);
        if(!from.some(c=>bindings.some(b=>b.claimKey===c.key)))throw Error(`Missing evidence binding for approved claim ${from[0].key}: ${field}`);
      }else if(!claims.some(c=>digest(c.value)===digest(value)))throw Error(`Patch contradicts approved value: ${field}`);
    }
    // A number the card is about to carry must be written in a quote that binds it, as for a claim (supplementary quotes included).
    // An approved claim already did; this catches a value that has none, or whose own quote was replaced.
    if(NUMBER_FIELDS.has(targetField)&&typeof value==='number'&&!bindings.some(b=>writesNumber(targetField,value,b.quote)))
      throw Error(`Patch number not written in its evidence quote: ${field}`);
    if(field==='price'){
      const numbers=String(draft.patch.price).match(/\d+(?:[.,]\d+)?/g)||[];
      const quoted=bindings.flatMap(b=>b.quote.match(/\d+(?:[.,]\d+)?/g)||[]);
      if(numbers.some(n=>!quoted.includes(n)))throw Error('New price numbers require explicit source evidence, not a translation of another claim');
    }
  }
  const unbound=citationProblems(draft);
  if(unbound.length)throw Error(`Citation does not match its evidence binding: ${unbound.join(', ')}`);
  if(draft.reviewCoverage)fields.push('review.coverage');
  return fields;
}
export function validateFullReview(draft,card,{date=today()}={}){
  const review=draft.reviewCoverage;
  if(!review||review.mode!=='full'||!Array.isArray(review.fields)||draft.patch.checked!==date)throw Error('checked requires a current full-card review');
  const required=fullReviewFields(card),seen=new Set(),updated={...card,...draft.patch,practical:{...card.practical,...draft.practicalPatch}};
  for(const row of review.fields){
    if(!required.includes(row.field)||seen.has(row.field)||!['confirmed','unknown','not-applicable'].includes(row.outcome)||
      !row.reason?.trim()||!Array.isArray(row.snapshotIds)||!row.snapshotIds.length)throw Error('Invalid full-review coverage row');
    seen.add(row.field);
    const value=row.field.startsWith('practical.')?updated.practical[row.field.slice(10)]?.value??null:updated[row.field]??null;
    if(digest(value)!==digest(row.value))throw Error(`Full review does not match resulting value: ${row.field}`);
    if(row.outcome==='confirmed')validateFieldValue(row.field,value,{allowUnknown:false});
    if(row.outcome==='unknown'&&FULL_REVIEW_UNKNOWN_TEXT[row.field]&&!FULL_REVIEW_UNKNOWN_TEXT[row.field].includes(value))throw Error(`Unconfirmed field retains unsupported public prose: ${row.field}`);
    if(row.outcome==='unknown'&&row.field.startsWith('practical.')){
      const fact=updated.practical[row.field.slice(10)];
      if(value!==null||fact&&!FULL_REVIEW_UNKNOWN_PRACTICAL_TEXT.includes(fact.text))throw Error('Unconfirmed practical condition retains unsupported value or prose: '+row.field);
    }
    if(row.outcome==='unknown'&&row.field==='status'&&value!=='check')throw Error('Unknown availability must remain check');
    if(row.outcome!=='confirmed'&&
      (['min','max','ageUpperUncertainFrom','amount','practical.booking','scheduleValidThrough'].includes(row.field)&&value!==null||
      ['languages','days','events','contacts'].includes(row.field)&&value.length||
      row.field==='parent'&&value!=='unknown'||row.field==='priceKind'&&value!=='unknown'||
      row.field==='addressPrecision'&&value==='exact'))throw Error(`Unconfirmed field retains a positive filter value: ${row.field}`);
    if(row.outcome==='not-applicable'&&!['days','events','scheduleValidThrough','ageUpperUncertainFrom'].includes(row.field))throw Error('Invalid not-applicable review field');
  }
  if(required.some(field=>!seen.has(field)))throw Error('Full review omits required primary fields');
  return review;
}
// The catalogue is English. A draft whose public text is not English never reaches review: the model is told to write English,
// and this keeps a slip (or a source quoted in Russian) out of the catalogue. Quotes in bindings and evidence are verbatim source text and exempt.
const CYRILLIC=/[\u0400-\u04FF]/;
export function assertEnglishPublicText(draft){
  const walk=(value,where)=>{
    if(typeof value==='string'){if(CYRILLIC.test(value))throw Error('Public text must be English: '+where);}
    else if(Array.isArray(value))value.forEach((item,index)=>walk(item,`${where}[${index}]`));
    else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))walk(item,`${where}.${key}`);
  };
  for(const part of ['patch','practicalPatch','warnings','findings','remaining'])walk(draft?.[part],part);
  return draft;
}
export function validateDraft(draft,card,{historical=false}={}){
  if(draft?.cardId!==card.id||!draft.patch||Array.isArray(draft.patch)||typeof draft.patch!=='object'||
    !Array.isArray(draft.findings)||!draft.findings.length||!Array.isArray(draft.remaining)||!draft.remaining.every(x=>typeof x==='string'))throw Error('Invalid editor draft');
  for(const field of Object.keys(draft.patch))if(!PATCH_FIELDS.has(field))throw Error('Unsupported patch field');
  if(!historical){
    assertEnglishPublicText(draft);
    for(const [field,value] of Object.entries(draft.patch))validateFieldValue(field,value);
    if(Object.hasOwn(draft.patch,'checked')||draft.reviewCoverage)validateFullReview(draft,card);
    if(draft.patch.reviewAfter!==undefined&&(!date(draft.patch.reviewAfter)||draft.patch.reviewAfter<=today()))throw Error('Next review must be in the future');
  }
  const updated={...card,...draft.patch};
  if(!['active','check','future','closed','excluded'].includes(updated.status)||
    ['age','schedule','address','price'].some(field=>typeof updated[field]!=='string')||
    [updated.min,updated.max].some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0))||
    updated.min!==null&&updated.max!==null&&updated.min>updated.max||
    !['yes','no','unknown'].includes(updated.parent)||!Array.isArray(updated.languages)||
    !Array.isArray(updated.days)||updated.days.some(d=>!Number.isInteger(d)||d<1||d>7)||
    !['unknown','free','donation','visit','course','year'].includes(updated.priceKind)||
    updated.amount!==null&&(typeof updated.amount!=='number'||!Number.isFinite(updated.amount)||updated.amount<0)||
    !Array.isArray(updated.contacts)||updated.contacts.some(c=>!c||typeof c!=='object')||
    !Array.isArray(updated.notes)||!updated.notes.every(n=>typeof n==='string')||
    !Array.isArray(updated.events)||updated.events.some(e=>!date(e.date)||e.start&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.start)||
      e.end&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.end)||e.start&&e.end&&e.end<=e.start))throw Error('Invalid patched card');
  for(const finding of draft.findings){
    if(!finding.field||!finding.text||!['official','visitor','historical','inference'].includes(finding.kind)||new URL(finding.url).protocol!=='https:')throw Error('Invalid patch evidence');
  }
  if(draft.practicalPatch){
    const allowed=new Set(PRACTICAL_FIELDS);
    for(const [key,fact] of Object.entries(draft.practicalPatch)){
      if(!allowed.has(key)||!fact?.text||new URL(fact.source).protocol!=='https:'||!date(fact.checked)||fact.checked>today()||!Object.hasOwn(fact,'value'))throw Error('Invalid practical patch');
      if(!historical)validateFieldValue('practical.'+key,fact.value);
    }
  }
  if(draft.warnings&&!draft.warnings.every(w=>typeof w==='string'))throw Error('Invalid warnings');
  if(draft.patch.scheduleValidThrough!==undefined&&draft.patch.scheduleValidThrough!==null&&!date(draft.patch.scheduleValidThrough))throw Error('Invalid published schedule horizon');
  if(!historical&&draft.patch.scheduleValidThrough===null&&updated.events.length)throw Error('Cannot clear the published schedule horizon while dated events remain');
  if(updated.scheduleValidThrough&&updated.events.some(e=>e.date>updated.scheduleValidThrough))throw Error('Event beyond published schedule horizon');
  const findingHashes=new Set((card.research?.findings||[]).map(digest));
  if(draft.supersededFindings?.some(hash=>!findingHashes.has(hash)))throw Error('Unknown superseded finding');
  for(const resolved of draft.resolvedQuestions||[]){
    if(!card.research?.remaining.includes(resolved.question)||!resolved.reason||new URL(resolved.source).protocol!=='https:')throw Error('Invalid resolved question');
  }
  return draft;
}
export function mergeResearch(card,draft,date){
  const findings=[...(card.research?.findings||[]).filter(f=>!draft.supersededFindings?.includes(digest(f))),...draft.findings];
  const distinct=[...new Map(findings.map(f=>[digest(f),f])).values()];
  const remaining=[...(card.research?.remaining||[]).filter(q=>!draft.resolvedQuestions?.some(r=>r.question===q)),...draft.remaining];
  return {date,outcome:'rechecked',findings:distinct,remaining:[...new Set(remaining)]};
}
export function applyDraftRecord(card,draft,date){
  const updated={...card,...draft.patch,practical:{...card.practical,...draft.practicalPatch}};
  if(draft.warnings)updated.practical.warnings=draft.warnings;
  updated.research=mergeResearch(card,draft,date);
  for(const finding of draft.findings)if(!updated.sources.some(s=>s.url===finding.url))
    updated.sources=[...updated.sources,{url:finding.url,label:'Additional check: '+finding.field}];
  return updated;
}
export function assertFullReviewPermission(draft,payload){
  if((draft.reviewCoverage||Object.hasOwn(draft.patch||{},'checked'))&&payload.primaryReviewStatus!=='complete')
    throw Error('Full review requires independent complete primary source inspection');
}
export function commitResult(queue,{jobId,token,role,result},{getInputs=currentInputs,outputRoot=root}={}){
  queue.flush(outputRoot);
  const outcome=queue.transaction(()=>{
    queue.flush(outputRoot);
    if(queue.db.prepare("SELECT id FROM jobs WHERE kind='release' AND state='leased'").get())throw Error('Release reserved; result must wait');
    const job=queue.requireLease(jobId,token,role),input=getInputs();
    const card=input.records.find(r=>r.id===job.card_id);
    if(!card||digest(card)!==job.payload.cardRevision)throw Error('Card changed; result is stale');
    if(['search','verify','adjudicate'].includes(job.kind)&&job.payload.dependencyRevision!==dependencyRevision(input,card.id))throw Error('Job dependencies changed; result is stale');
    const writes=[],followups=[];
    const chainId=job.payload.chainId||queue.openChains().find(chain=>chain.card===card.id)?.chainId||job.id;
    const next=(kind,payload,priority=job.priority)=>{
      const nextPayload={chainId,sourceTasks:job.payload.sourceTasks||[],sourceVersions:job.payload.sourceVersions||[],
        sourceIssues:job.payload.sourceIssues||[],urgent:job.payload.urgent,triggerRevision:job.payload.triggerRevision,
        ...payload,requestedReview:job.payload.requestedReview||'partial',card,cardRevision:digest(card),date:today()};
      followups.push({kind,cardId:card.id,inputRevision:digest([kind,nextPayload]),priority,payload:nextPayload});
    };
    let state='done';
    if(job.kind==='search'){
      const candidate=result.candidate;
      if(!safeId(candidate?.id)||candidate.revision===input.candidates.get(card.id)?.revision)throw Error('Candidate must have a new revision');
      validateCandidate(candidate,card,venueGroups(input.records,input.registry));
      if(candidate.collectedOn!==today())throw Error('Candidate must use the current date');
      writes.push({file:`editorial/external-candidates/${card.id}.json`,data:candidate});
    }else if(job.kind==='verify'){
      if(input.candidates.get(card.id)?.revision!==job.payload.candidate?.revision)throw Error('Candidate changed; result is stale');
      if(result.dispute){
        validateDispute(result.dispute,card);
        if(result.dispute.candidateRevision!==job.payload.candidate.revision)throw Error('Wrong dispute candidate');
        if(result.dispute.openedOn!==today())throw Error('Dispute must use the current date');
        const disputes=new Map(input.disputes).set(card.id,result.dispute),decisions=new Map(input.decisions);decisions.delete(card.id);
        const receipts=input.receipts.filter(r=>r.id!==card.id);
        pipelineReport(input.records,receipts,input.receiptBaseline,input.registry,input.candidates,disputes,decisions,today(),input.corrections,input.approvedUpdates);
        writes.push({file:`editorial/external-disputes/${card.id}.json`,data:result.dispute});
        writes.push({file:`editorial/external-decisions/${card.id}.json`,data:null});
        writes.push({file:'editorial/external-review-receipts.json',data:{schema:1,receipts}});
      }else{
        validateReceipt(result.receipt,card);
        if(result.receipt.checkedOn!==today()||result.receipt.candidateRevision!==job.payload.candidate.revision)throw Error('Wrong receipt revision or date');
        const receipts=input.receipts.filter(r=>r.id!==card.id).concat(result.receipt);
        const corrections=new Map(input.corrections);
        for(const [index,correction] of (result.corrections||[]).entries()){
          if(correction.status!=='proposed')throw Error('Verifier cannot apply corrections');
          if(!Array.isArray(correction.requiredFields)||!correction.requiredFields.length||
            correction.requiredFields.some(field=>!CLAIM_FIELDS.has(field)&&field!=='practical.warnings'))throw Error('Correction needs explicit affected fields');
          validateCorrection(correction,card);
          const file=`${card.id}-${today()}-${digest([job.id,index,correction]).slice(0,12)}`;
          corrections.set(file,correction);writes.push({file:`editorial/corrections/${file}.json`,data:correction});
        }
        // The receipt being written must review the card's present address itself; only earlier receipts can be stale.
        if(pipelineReport(input.records,receipts,input.receiptBaseline,input.registry,input.candidates,input.disputes,input.decisions,today(),corrections,input.approvedUpdates)
          .staleAddressReceipts.includes(card.id))throw Error(`Unreviewed candidate address: ${card.id}`);
        writes.push({file:'editorial/external-review-receipts.json',data:{schema:1,receipts}});
      }
    }else if(job.kind==='adjudicate'){
      if(input.candidates.get(card.id)?.revision!==job.payload.candidate?.revision)throw Error('Candidate changed; result is stale');
      validateDecision(result.decision,input.disputes.get(card.id));
      if(result.decision.decidedOn!==today())throw Error('Decision must use the current date');
      pipelineReport(input.records,input.receipts,input.receiptBaseline,input.registry,input.candidates,input.disputes,
        new Map(input.decisions).set(card.id,result.decision),today(),input.corrections,input.approvedUpdates);
      writes.push({file:`editorial/external-decisions/${card.id}.json`,data:result.decision});
    }else if(job.kind==='facts'){
      validateClaims(result.bundle,card,{now:queue.now()});
      assertCaptured(queue,result.bundle);
      // The verifier that asked for a lead never saw what following it produced, and asked again. The next verifier is therefore told
      // which sources were already fetched for a lead (the latest note per source); the controller captures them for it as evidence.
      const followedLeads=[...new Map([...(job.payload.followedLeads||[]),...(job.payload.researchLeads||[])].map(lead=>[lead.source,lead])).values()];
      next('verify-facts',{bundle:result.bundle,reworkCount:job.payload.reworkCount||0,...(followedLeads.length&&{followedLeads})},job.priority+60);
    }else if(job.kind==='verify-facts'){
      validateClaims(job.payload.bundle,card,{now:queue.now()});
      assertCaptured(queue,job.payload.bundle);
      if(job.payload.requestedReview==='full'&&!['complete','incomplete'].includes(result.fullReviewStatus))
        throw Error('Full primary review needs an explicit source-inspection outcome');
      if(result.reviewLimitations!==undefined&&(!Array.isArray(result.reviewLimitations)||result.reviewLimitations.some(note=>typeof note!=='string'||!note.trim())))
        throw Error('Invalid primary review limitations');
      if(!Array.isArray(result.verdicts)||result.verdicts.length!==job.payload.bundle.claims.length)throw Error('Missing claim verdicts');
      const claims=new Map(job.payload.bundle.claims.map(c=>[c.key,c]));
      for(const verdict of result.verdicts){
        if(!claims.delete(verdict.key)||!['approve','reject','await-source'].includes(verdict.verdict)||!verdict.reason?.trim())throw Error('Invalid claim verdict');
      }
      const approved=job.payload.bundle.claims.filter(c=>result.verdicts.some(v=>v.key===c.key&&v.verdict==='approve'));
      if(approved.some(c=>c.status!=='supported'))throw Error('Cannot approve an unsupported claim');
      assertConsistentClaims(approved);
      if(result.dispute&&(job.payload.arbitrations||0)<1){
        validateDispute(result.dispute,card);
        if(result.dispute.candidateRevision!==job.input_revision)throw Error('Wrong fact dispute revision');
        next('adjudicate-facts',{bundle:job.payload.bundle,dispute:result.dispute,arbitrations:1},job.priority+60);
      }else if(result.researchLeads?.length&&(job.payload.reworkCount||0)<2){
        for(const lead of result.researchLeads)if(new URL(lead.source).protocol!=='https:'||!lead.note?.trim())throw Error('Invalid research lead');
        next('facts',{researchLeads:result.researchLeads,...(job.payload.followedLeads?.length&&{followedLeads:job.payload.followedLeads}),
          reviewLimitations:result.reviewLimitations||[],reworkCount:(job.payload.reworkCount||0)+1,pilot:true},job.priority+60);
      }else if(approved.length)next('integrate',{approved,bundle:job.payload.bundle,verdicts:result.verdicts,
        primaryReviewStatus:job.payload.requestedReview==='full'?result.fullReviewStatus:'partial',reviewLimitations:result.reviewLimitations||[]},job.priority+60);
      else state=result.dispute?'attention':'await-source';
    }else if(job.kind==='adjudicate-facts'){
      validateDecision(result.decision,job.payload.dispute);
      if(result.decision.decidedOn!==today())throw Error('Fact decision must use the current date');
      if(result.decision.rulings.some(r=>r.verdict==='unresolved'))state='await-source';
      else{
        validateClaims(result.bundle,card,{now:queue.now()});
        assertCaptured(queue,result.bundle);
        next('verify-facts',{bundle:result.bundle,arbitrations:1,decision:result.decision},job.priority+60);
      }
    }else if(['editorial','integrate'].includes(job.kind)){
      const draft=orderDraftEvents(result.draft,job.payload.approved);
      validateDraft(draft,card);
      assertFullReviewPermission(draft,job.payload);
      validateBindings(queue,draft,job.payload.approved||[]);
      next('review-patch',{draft,editorJobId:job.id,editorOwner:job.owner,
        verdicts:job.payload.verdicts||[],
        primaryReviewStatus:job.payload.primaryReviewStatus,reviewLimitations:job.payload.reviewLimitations||[],
        corrections:job.payload.corrections||[],approved:job.payload.approved||[],bundle:job.payload.bundle||null,
        staleApprovedUpdates:job.payload.staleApprovedUpdates||[],
        reworkCount:job.payload.reworkCount||0},job.priority+60);
    }else if(job.kind==='review-patch'){
      if(job.owner===job.payload.editorOwner)throw Error('Editor cannot approve its own draft');
      if(!['approve','reject','await-source'].includes(result.verdict)||!result.reason?.trim())throw Error('Invalid patch verdict');
      if(result.draftHash!==digest(job.payload.draft))throw Error('Review does not match draft');
      if(result.verdict==='approve'){
        validateDraft(job.payload.draft,card);
        assertFullReviewPermission(job.payload.draft,job.payload);
        const boundFields=validateBindings(queue,job.payload.draft,job.payload.approved||[]);
        const fields=['research.findings','research.remaining',...Object.keys(job.payload.draft.patch),...Object.keys(job.payload.draft.practicalPatch||{}).map(k=>'practical.'+k),
          ...(job.payload.draft.warnings?['practical.warnings']:[])];
        if(!Array.isArray(result.checkedFields)||fields.some(field=>!result.checkedFields.includes(field)))throw Error('Patch review omits changed fields');
        if(boundFields.some(field=>!result.approvedBindings?.includes(field)))throw Error('Patch review omits evidence binding approval');
        if(job.payload.draft.reviewCoverage&&fullReviewFields(card).some(field=>!result.checkedCoverage?.includes(field)))throw Error('Patch review omits full-card coverage approval');
        if((job.payload.corrections||[]).some(c=>!result.checkedCorrectionFiles?.includes(c.file)))throw Error('Patch review omits correction resolution');
        if((job.payload.staleApprovedUpdates||[]).some(old=>!result.checkedStaleUpdates?.includes(old.jobId)))throw Error('Patch review omits stale update resolution');
        const journal=read(path.join(outputRoot,'editorial','approved-updates.json'),{schema:1,project:PROJECT_ID,updates:[]});
        if(journal.schema!==1||journal.project!==PROJECT_ID)throw Error('Wrong update journal');
        const draft=job.payload.draft;
        const updated=applyDraftRecord(card,draft,today());
        const revision=recordRevision(updated);
        const approvalArtifact=digest({project:PROJECT_ID,jobId:job.id,role,inputRevision:job.input_revision,result});
        for(const reviewed of job.payload.staleApprovedUpdates||[]){
          const old=journal.updates.find(update=>update.jobId===reviewed.jobId);
          if(!old||old.draft.cardId!==card.id||digest(old)!==reviewed.revision)throw Error('Stale update changed or belongs to another card');
          old.supersededBy=job.id;
        }
        journal.updates.push({jobId:job.id,editorJobId:job.payload.editorJobId,approvalArtifact,approval:approvalSummary(role,result),approvedOn:today(),cardRevision:digest(card),
          baseRecord:card,appliedRecordRevision:revision,research:updated.research,draft});
        writes.push({file:'editorial/approved-updates.json',data:journal});
        writes.push({file:`editorial/correction-versions/${revision}.json`,data:updated});
        for(const {file,correction} of job.payload.corrections){
          if(input.corrections.get(file)?.status!=='proposed'||digest(input.corrections.get(file))!==digest(correction))throw Error('Correction changed');
          if(!correction.requiredFields?.length)throw Error('Legacy correction needs an explicit reviewed scope before automatic application');
          for(const field of correction.requiredFields){
            const keys=field.split('.'),before=keys.reduce((value,key)=>value?.[key],card),after=keys.reduce((value,key)=>value?.[key],updated);
            if(!boundFields.includes(field)||after===undefined||digest(before??null)===digest(after))throw Error(`Correction not resolved by draft: ${field}`);
          }
          const applied={...correction,status:'applied',appliedOn:today(),appliedRecordRevision:revision,
            checks:[...Object.entries(draft.patch).map(([key,value])=>({path:[key],value})),
              ...Object.entries(draft.practicalPatch||{}).map(([key,value])=>({path:['practical',key],value})),
              ...(draft.warnings?[{path:['practical','warnings'],value:draft.warnings}]:[])]};
          if(!applied.checks.length)throw Error('Cannot close a correction without field changes');
          validateCorrection(applied,updated,{readVersion:()=>updated});
          writes.push({file:`editorial/corrections/${file}.json`,data:applied});
        }
        next('qa',{approvedJobId:job.id},1000);
      }else if(result.verdict==='reject'&&(job.payload.reworkCount||0)<2){
        next('integrate',{corrections:job.payload.corrections,approved:job.payload.approved,bundle:job.payload.bundle,
          verdicts:job.payload.verdicts||[],
          primaryReviewStatus:job.payload.primaryReviewStatus,reviewLimitations:job.payload.reviewLimitations||[],
          staleApprovedUpdates:job.payload.staleApprovedUpdates,
          rejectedDraft:job.payload.draft,reviewFeedback:result.reason,reworkCount:(job.payload.reworkCount||0)+1},job.priority+60);
      }else state=result.verdict==='reject'?'attention':'await-source';
    }else throw Error('Use the deterministic QA/release command for this job');
    if(state==='await-source'){
      const resumeWhen=resumeCondition(job.payload,null,result.decision?.reviewAfter);
      queue.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify({...job.payload,resumeWhen}),job.id);
    }
    return queue.finish(job.id,token,role,result,{writes,followups,state});
  });
  queue.flush(outputRoot);
  return outcome;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const command=process.argv[2]||'status';
  const queue=new JobQueue(path.join(here,'workflow-state','jobs.sqlite'));
  try{
    if(command==='sync')console.log(JSON.stringify(syncQueue(queue).summary,null,2));
    else if(command==='status')console.log(JSON.stringify(queue.summary(),null,2));
    else if(command==='claim'){
      syncQueue(queue);const role=process.argv[3],owner=process.argv[4];
      console.log(JSON.stringify(queue.claim(role,owner),null,2));
    }else if(command==='commit'){
      const file=process.argv[3];if(!file||fs.statSync(file).size>2000000)throw Error('Missing or oversized result');
      const envelope=read(file);console.log(JSON.stringify(commitResult(queue,envelope),null,2));syncQueue(queue);
    }else if(command==='migrate-corrections'){
      queue.transaction(()=>{
        const input=currentInputs();
        for(const [file,correction] of input.corrections)if(correction.status==='applied'&&!correction.appliedRecordRevision){
          const card=input.records.find(r=>r.id===correction.id);validateCorrection(correction,card);
          const revision=recordRevision(card);
          const writes=[{file:`editorial/correction-versions/${revision}.json`,data:card},
            {file:`editorial/corrections/${file}.json`,data:{...correction,appliedRecordRevision:revision}}];
          for(const write of writes)queue.db.prepare('INSERT INTO outbox(file,data) VALUES (?,?)').run(write.file,JSON.stringify(write.data));
          queue.event(null,'correction-migrated',{file,revision});
        }
      });queue.flush(root);console.log(JSON.stringify({migrated:true,...queue.summary()},null,2));
    }else if(command==='backup'){
      queue.flush(root);
      const directory=path.join(here,'workflow-state','backups');fs.mkdirSync(directory,{recursive:true,mode:0o700});
      const file=path.join(directory,new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
      queue.db.prepare('VACUUM INTO ?').run(file);fs.chmodSync(file,0o600);
      for(const old of fs.readdirSync(directory).filter(f=>f.endsWith('.sqlite')).sort().slice(0,-20))fs.rmSync(path.join(directory,old));
      console.log(JSON.stringify({backup:file,scope:'editorial-queue-only'},null,2));
    }else if(command==='report'){
      const summary=queue.summary();await writeJsonAtomic(path.join(here,'workflow-report.json'),{...summary,jobs:queue.list().map(({token,...job})=>job)});
      console.log(JSON.stringify(summary,null,2));
    }else if(command==='reset-circuit')console.log(JSON.stringify(queue.resetCircuit(process.argv.find(a=>a.startsWith('--note='))?.slice(7)),null,2));
    else throw Error('Use sync, status, claim ROLE OWNER, commit FILE, migrate-corrections, backup, report or reset-circuit --note=REASON');
  }finally{queue.close();}
}
