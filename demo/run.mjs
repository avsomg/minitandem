// npm run demo: the editorial pipeline rejecting a wrong result, on three invented training cards.
//
// What is real: the controller code (editorial/workflow.mjs commitResult and its checks), the job queue (editorial/jobs.mjs, a SQLite file),
// the evidence capture and quote matching (editorial/evidence.mjs), the worker output contract (editorial/worker-schema.mjs and the Claude
// adapter's envelope decoding) and the release gate (editorial/release.mjs). What is replaced: the web (a recorded page is served in place of
// the network) and the models (the answers in demo/fixtures are written by hand to follow the worker contract; no model produced them).
// Nothing leaves this process: no network, no model calls, and the real queue in editorial/workflow-state is never opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JobQueue,digest} from '../editorial/jobs.mjs';
import {commitResult,applyDraftRecord,today} from '../editorial/workflow.mjs';
import {captureClaims,captureDraft,prepareEvidence,modelRoute,promptFor,recordRejectedOutput} from '../editorial/agent-run.mjs';
import {captureUrl} from '../editorial/evidence.mjs';
import {decodeWorkerOutput} from '../editorial/worker-schema.mjs';
import {claudeEnvelope} from '../editorial/claude-worker.mjs';
import {pipelineReport} from '../editorial/external-pipeline.mjs';
import {assertEditorialReleaseReady,assertReleaseCurrent} from '../editorial/release.mjs';
import {PROJECT_ID} from '../editorial/project-id.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const fixture=name=>path.join(here,'fixtures',name);
const readJson=name=>JSON.parse(fs.readFileSync(fixture(name),'utf8'));
const PAGE='https://little-owls.example.org/playgroup';
const HOUR=3600000;

const style=(color,code)=>text=>color?`\u001b[${code}m${text}\u001b[0m`:text;

export async function runDemo({write=line=>console.log(line),color=false}={}){
  const bold=style(color,1),green=style(color,32),red=style(color,31),dim=style(color,2);
  const out=(text='')=>write(text);
  const step=(number,title)=>{out('');out(bold(`${number}  ${title}`));};
  const ok=text=>out(`   ${green('[ok]')}      ${text}`);
  const stop=text=>out(`   ${red('[stopped]')} ${text}`);
  const info=text=>out(`   ${text}`);
  const quote=text=>`"${text}"`;

  // The demo never reaches the network. Any attempt is counted, and fails.
  const realFetch=globalThis.fetch;
  let networkCalls=0;
  globalThis.fetch=async()=>{networkCalls++;throw Error('The demo has no network.');};

  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-demo-'));
  const outputRoot=path.join(folder,'files');
  // A clock the demo can move forward: the retry wait of a failed job is one hour.
  let offset=0;
  const now=()=>new Date(Date.now()+offset).toISOString();
  const queue=new JobQueue(path.join(folder,'queue','jobs.sqlite'),{now});
  const result={networkCalls:0};

  try{
    const policy=JSON.parse(fs.readFileSync(path.join(here,'..','editorial','agent-policy.json'),'utf8'));
    const records=readJson('training-cards.json');
    const baseline=structuredClone(records);
    const card=records.find(record=>record.id==='training-little-owls');
    const page=fs.readFileSync(fixture('source-little-owls.html'));
    const getInputs=()=>({records,receipts:[],candidates:new Map(),disputes:new Map(),decisions:new Map(),corrections:new Map(),
      registry:{schema:1,groups:[]},receiptBaseline:{schema:1,cutoffOn:'2026-09-29',ids:[]},approvedUpdates:[],staleUpdates:[]});
    // The recorded web: the real capture code runs, but its fetch returns the saved page and its DNS lookup a public address.
    const capture=async url=>{
      if(url!==PAGE)throw Error('Source not available in the demo: '+url);
      return captureUrl(url,{now:now(),fetchImpl:async()=>new Response(page,{headers:{'content-type':'text/html; charset=utf-8'}}),
        lookupImpl:async()=>[{address:'93.184.216.34',family:4}]});
    };
    const save=async()=>{};  // the real runner saves snapshots under editorial/typesafe-runtime; the demo keeps them in memory
    const journal=()=>{
      const file=path.join(outputRoot,'editorial','approved-updates.json');
      return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).updates:[];
    };

    // One worker run, the way editorial/agent-run.mjs does it: claim, capture sources, ask the worker, decode with the contract,
    // let the controller commit. The worker's answer is a recorded one.
    const run=async({role,owner,answer,expectKind})=>{
      const job=queue.claim(role,owner,{leaseMs:policy.leaseMinutes*60000,backpressure:policy.backpressure});
      if(!job||job.kind!==expectKind)throw Error(`Expected a ${expectKind} job for ${role}, got ${job?.kind||'none'}`);
      const route=modelRoute(job,policy);
      const prepared=await prepareEvidence(job,{captureImpl:capture,saveImpl:save,queue,sources:[]});
      const recorded=typeof answer==='function'?answer(job):answer;
      const structured={project:PROJECT_ID,jobId:job.id,inputRevision:job.input_revision,result:recorded};
      const output={result:decodeWorkerOutput(claudeEnvelope(structured,job),job),usage:{provider:'claude',model:route.model,effort:route.effort,recorded:true}};
      return {job,route,prepared,output};
    };
    const commit=(job,output)=>commitResult(queue,{jobId:job.id,token:job.token,role:job.kind==='facts'?'search':job.kind==='verify-facts'||job.kind==='review-patch'?'verify':'editor',result:output.result},{getInputs,outputRoot});
    const routeText=route=>`${route.model}, effort ${route.effort}`;

    out(bold('Minitandem editorial pipeline: a wrong result is stopped'));
    out(dim('Three invented training cards, recorded worker answers, a temporary queue.'));
    out(dim('No network, no model calls; the real queue is not opened. The answers are fixtures written by hand to follow the worker contract.'));

    step(0,'Setup');
    info(`training catalogue: ${records.length} invented cards (${records.map(record=>record.id).join(', ')})`);
    info(`card to work on: ${card.name}: age "${card.age}", adult "${card.parent}", price "${card.price}"`);
    info('queue: a new, temporary SQLite file (deleted at the end)');

    // 1. Search worker
    step(1,'Search worker: extract claims with exact quotes from a captured source');
    queue.enqueue({kind:'facts',cardId:card.id,inputRevision:digest(['demo-facts',card]),priority:1000,
      payload:{card,cardRevision:digest(card),date:today(),pilot:true,requestedReview:'partial',
        researchLeads:[{source:PAGE,note:'Source supplied for the demo; not an approved fact.'}]}});
    const search=await run({role:'search',owner:'runtime-search',expectKind:'facts',
      answer:()=>{const recorded=readJson('search-answer.json');recorded.bundle.project=PROJECT_ID;return recorded;}});
    const captured=search.prepared.payload.preparedEvidence[0];
    info(`worker: ${routeText(search.route)} (recorded answer)`);
    info(`source captured by the controller: ${PAGE} (${captured.text.length} characters of page text)`);
    info('the answer matches the worker contract (output schema)');
    await captureClaims(search.output.result.bundle,card,{prepared:search.prepared.payload.preparedEvidence,queue,captureImpl:capture,saveImpl:save});
    const claims=search.output.result.bundle.claims;
    for(const claim of claims){
      info(`  claim ${claim.field.padEnd(9)} = ${String(claim.value).padEnd(5)} ${claim.status==='supported'?quote(claim.quote):dim('(no quote: the page does not say)')}`);
    }
    commit(search.job,search.output);
    ok('controller: every quote is found word for word in the captured text; 5 claims go to an independent verifier');
    result.claims=claims.length;

    // 2. Verifier
    step(2,'Independent verifier: does the quote support the claim?');
    const verify=await run({role:'verify',owner:'runtime-verify',expectKind:'verify-facts',answer:()=>readJson('verify-answer.json')});
    info(`verifier: ${routeText(verify.route)} (recorded answer), a fresh run that did not write the claims`);
    const verdicts=verify.output.result.verdicts;
    const byKey=new Map(verify.job.payload.bundle.claims.map(claim=>[claim.key,claim]));
    for(const verdict of verdicts){
      const claim=byKey.get(verdict.key);
      const label=verdict.verdict==='approve'?green('approve'):verdict.verdict==='reject'?red('REJECT '):'wait   ';
      info(`  ${label} ${claim.field.padEnd(9)} ${verdict.reason}`);
    }
    commit(verify.job,verify.output);
    const approvedClaims=verdicts.filter(verdict=>verdict.verdict==='approve').length;
    ok(`controller: ${approvedClaims} claims approved, ${verdicts.filter(v=>v.verdict==='reject').length} rejected, ${verdicts.filter(v=>v.verdict==='await-source').length} waiting for a source. The editor receives only the approved claims.`);
    result.approvedClaims=approvedClaims;
    result.rejectedClaims=verdicts.filter(verdict=>verdict.verdict==='reject').length;

    // 3. Editor, first attempt: depends on the rejected claim
    step(3,'Editor, first draft: it builds on the rejected claim');
    const first=await run({role:'editor',owner:'runtime-editor',expectKind:'integrate',answer:()=>readJson('editor-answer-1.json')});
    info(`editor: ${routeText(first.route)} (recorded answer)`);
    info(`draft changes: ${Object.entries(first.output.result.draft.patch).map(([field,value])=>`${field}=${JSON.stringify(value)}`).join(', ')}`);
    info('the price line is bound to the claim the verifier rejected');
    await captureDraft(first.output.result.draft,first.prepared.payload.preparedEvidence,queue,{captureImpl:capture,saveImpl:save});
    let refusal=null;
    try{commit(first.job,first.output);}
    catch(error){
      refusal=error;
      recordRejectedOutput(queue,first.job,'editor',first.output,error,outputRoot);
      if(queue.get(first.job.id)?.state==='leased')queue.fail(first.job.id,first.job.token,'editor',error.message);
    }
    if(!refusal)throw Error('The controller accepted a draft that depends on a rejected claim.');
    stop(`controller refuses the draft: ${refusal.message}`);
    const failed=queue.get(first.job.id);
    const classified=queue.db.prepare("SELECT details FROM events WHERE kind='classified-failure' AND job_id=?").all(first.job.id).map(row=>JSON.parse(row.details));
    info(`job state: ${failed.state}, attempt ${failed.attempt} of ${policy.maxAttempts}; the next attempt is allowed after one hour`);
    info(`failure classified as "${classified[0]?.category}"; circuit breaker: ${queue.circuit()?.open?'OPEN':'closed'} (it opens at the same failure on 3 different cards within an hour)`);
    info(`the refused answer is kept as a rejected artifact; approved updates written: ${journal().length}`);
    result.refusal=refusal.message;
    result.firstAttempt={state:failed.state,attempt:failed.attempt,category:classified[0]?.category,circuitOpen:Boolean(queue.circuit()?.open)};

    // 4. Editor, second attempt, after the wait
    step(4,'Editor, second draft (one hour later on the demo clock): only approved claims');
    offset+=HOUR+60000;
    const second=await run({role:'editor',owner:'runtime-editor',expectKind:'integrate',answer:()=>readJson('editor-answer-2.json')});
    info(`the next prompt carries the refusal: ${promptFor(second.job).includes('Patch binding does not match an approved claim')?'yes':'NO'}`);
    info(`draft changes: ${Object.entries(second.output.result.draft.patch).map(([field,value])=>`${field}=${JSON.stringify(value)}`).join(', ')}; the price stays unknown`);
    await captureDraft(second.output.result.draft,second.prepared.payload.preparedEvidence,queue,{captureImpl:capture,saveImpl:save});
    commit(second.job,second.output);
    ok('controller: the draft is valid, every changed field has a quote that it found in a captured source. A review job is created.');
    result.secondAttempt={attempt:second.job.attempt};

    // 5. Review and apply
    step(5,'Second verifier approves; the controller applies the draft');
    const review=await run({role:'verify',owner:'runtime-verify',expectKind:'review-patch',
      answer:job=>({...readJson('review-answer.json'),draftHash:digest(job.payload.draft)})});
    info(`reviewer: ${routeText(review.route)} (recorded answer); the editor and the reviewer are different workers`);
    commit(review.job,review.output);
    const updates=journal();
    const update=updates[0];
    ok(`controller: draft approved by hash and appended to the update journal (${updates.length} update)`);
    const after=applyDraftRecord(card,update.draft,today());
    for(const field of Object.keys(update.draft.patch))info(`  ${field.padEnd(7)} ${JSON.stringify(card[field])} -> ${JSON.stringify(after[field])}`);
    info(`  price   ${JSON.stringify(after.price)} (unchanged: missing evidence stays unknown)`);
    info(`next stage queued: ${queue.list().filter(job=>job.kind==='qa').length} QA job (tests and browser checks on the built site)`);
    result.updates=updates.length;
    result.changedFields=Object.keys(update.draft.patch);
    result.priceUnchanged=after.price===card.price&&after.priceKind===card.priceKind;

    // 6. Release check
    step(6,'Release check');
    const date=today();
    // The same test the browser layer applies: an update whose base record differs from the current card is stale and blocks the build.
    const stale=updates.filter(item=>JSON.stringify(item.baseRecord)!==JSON.stringify(baseline.find(record=>record.id===item.draft.cardId))).map(item=>({id:item.draft.cardId,jobId:item.jobId}));
    const published=records.map(record=>record.id===card.id?after:record);
    const inputs=getInputs();
    const pipeline=pipelineReport(published,[],inputs.receiptBaseline,inputs.registry,new Map(),new Map(),new Map(),date,new Map(),updates);
    const gate=assertEditorialReleaseReady({input:{pipeline,staleUpdates:stale,records:published},
      external:{receipts:[],legacyRecords:[],baseline:{grandfatheredIds:published.map(record=>record.id)}},date});
    ok(`editorial gates pass: no open correction, ${stale.length} stale approvals, external review baseline covers all ${published.length} training cards`);
    let qaRefusal='';
    try{assertReleaseCurrent(null);}catch(error){qaRefusal=error.message;}
    info(`the full release check also needs a tested build: "${qaRefusal}" until the queued QA job has run. The demo does not run it.`);
    result.gate=gate===true?'passed':'failed';
    result.qaRefusal=qaRefusal;

    result.networkCalls=networkCalls;
    result.queue=queue.summary().counts.map(row=>`${row.kind}:${row.state}:${row.count}`).sort();
    out('');
    out(bold('Result'));
    info(`${green('A wrong claim was caught at the verifier and again at the controller.')} Nothing wrong reached the catalogue.`);
    info(`network calls: ${networkCalls}; model calls: 0; real queue opened: no`);
    return result;
  }finally{
    globalThis.fetch=realFetch;
    queue.close();
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const color=Boolean(process.stdout.isTTY)&&!process.env.NO_COLOR;
  try{await runDemo({color});}
  catch(error){console.error('\nThe demo failed: '+error.message);process.exitCode=1;}
}
