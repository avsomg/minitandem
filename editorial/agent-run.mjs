import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {JobQueue,digest,ROLE_KINDS,failureCategory,DOWNSTREAM,urgentJob} from './jobs.mjs';
import {here,root,today,syncQueue,commitResult,currentInputs,validateClaims,CLAIM_FIELDS,registerCaptured} from './workflow.mjs';
import {captureUrl,saveSnapshot,writeJsonAtomic,locateQuote,hash,validateSnapshot,publicUrl,capturedSet} from './evidence.mjs';
import {normUrl} from './monitor.mjs';
import {sourceRevision} from './release.mjs';
import {readPolicy,createClient,judgeBatch} from './typesafe.mjs';
import {fieldDictionary,fullReviewFields,CRITICAL_FIELDS} from './field-contract.mjs';
import {calendarEvidence} from './calendar-evidence.mjs';
import {workerOutputSchema,decodeWorkerOutput} from './worker-schema.mjs';
import {imageFile} from './image-evidence.mjs';
import {runtimeContractRevision,assertRuntimeCurrent} from './runtime-contract.mjs';
import {runClaudeWorker,assertClaudeReady} from './claude-worker.mjs';
import {PROJECT_ID} from './project-id.mjs';
import {numberProblem} from './quote-numbers.mjs';
import {performance} from 'node:perf_hooks';

const loadedRuntimeRevision=runtimeContractRevision();
import {promptFor,workerEvidenceFiles,CONTRACTS} from './worker-prompt.mjs';
export {promptFor,workerEvidenceFiles} from './worker-prompt.mjs';
export function modelRoute(job,policy){
  const role=Object.keys(ROLE_KINDS).find(role=>ROLE_KINDS[role].includes(job.kind));
  const config=policy.roles[role];
  if(!config?.model)throw Error('Deterministic role does not need a model');
  const critical=['editorial','integrate','review-patch'].includes(job.kind)||
    ['adjudicate','adjudicate-facts'].includes(job.kind)&&job.payload.dispute?.questions.length>3||
    job.kind==='verify-facts'&&job.payload.bundle?.claims.some(c=>c.status==='supported');
  const model=policy.workerProvider==='claude'?config.claudeModel:config.model;
  if(!model)throw Error('Missing configured worker model');
  return {role,model,effort:critical?config.criticalEffort:config.effort};
}
export function copyWorkerImages(job,directory,evidenceDirectory=path.join(here,'typesafe-runtime')){
  const images=new Map();
  for(const {evidence} of workerEvidenceFiles(job)){
    if(!evidence.image||images.has(evidence.image.hash))continue;
    validateSnapshot(evidence);
    const source=imageFile(evidenceDirectory,evidence.image);
    if(fs.lstatSync(source).isSymbolicLink())throw Error('Symlink in source image evidence');
    const bytes=fs.readFileSync(source);
    if(bytes.length>2000000||hash(bytes)!==evidence.rawHash)throw Error('Source image changed or exceeds worker limit');
    const file=path.join(directory,evidence.image.hash+'.'+evidence.image.extension);
    fs.writeFileSync(file,bytes,{mode:0o600});images.set(evidence.image.hash,file);
    if(images.size>5)throw Error('Worker image budget exceeded; split the task');
  }
  return [...images.values()];
}
export async function runCodex(job,policy,{runImpl=spawn,timeoutMs=720000,promptImpl=promptFor,signal}={}){
  signal?.throwIfAborted();
  const route=modelRoute(job,policy),directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-worker-'));
  const output=path.join(directory,'result.json');
  const schema=path.join(directory,'output-schema.json');
  const args=['exec','--ignore-user-config','--ignore-rules','--sandbox','read-only','--skip-git-repo-check','--ephemeral',
    '--model',route.model,'-c',`model_reasoning_effort="${route.effort}"`,'-c','web_search="live"',
    '--cd',directory,'--output-schema',schema,'--output-last-message',output,'--json','-'];
  const usage={model:route.model,effort:route.effort,toolCalls:0};
  try{
    fs.writeFileSync(schema,JSON.stringify(workerOutputSchema(job)),{mode:0o600});
    for(const file of copyWorkerImages(job,directory))args.splice(1,0,'--image',file);
    for(const {file,evidence} of workerEvidenceFiles(job)){
      validateSnapshot(evidence);
      fs.writeFileSync(path.join(directory,file),JSON.stringify(evidence),{mode:0o600,flag:'wx'});
    }
    const prompt=promptImpl(job);
    if(prompt.length>60000)throw Error('Worker input exceeds budget; split the task without truncating evidence');
    await new Promise((resolve,reject)=>{
      const env=Object.fromEntries(['PATH','HOME','TMPDIR','USER','LOGNAME','SHELL','CODEX_HOME','LANG','LC_ALL','TZ'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
      const child=runImpl('codex',args,{stdio:['pipe','pipe','pipe'],env});
      let pending='',stderr='',settled=false,failure=null;
      const stop=reason=>{
        if(failure)return;failure=reason;child.kill('SIGTERM');setTimeout(()=>{if(!settled)child.kill('SIGKILL');},2000).unref();
      };
      const timeout=setTimeout(()=>stop('Worker time limit'),timeoutMs);
      const aborted=()=>stop('Job cancelled');signal?.addEventListener('abort',aborted,{once:true});
      child.stdout.on('data',chunk=>{
        pending+=chunk.toString();const lines=pending.split('\n');pending=lines.pop();
        for(const line of lines){try{
          const event=JSON.parse(line);if(event.type==='turn.completed')Object.assign(usage,event.usage||{});
          if(event.type==='item.completed'&&['web_search','command_execution','mcp_tool_call'].includes(event.item?.type))usage.toolCalls++;
          if(usage.toolCalls>policy.maxToolCallsPerJob)stop('Worker tool-call budget exceeded');
        }catch{}}
        if(pending.length>2000000)stop('Oversized worker event');
      });
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-3000);});
      child.on('error',error=>{clearTimeout(timeout);signal?.removeEventListener('abort',aborted);reject(error);});
      child.on('close',code=>{
        clearTimeout(timeout);signal?.removeEventListener('abort',aborted);if(settled)return;settled=true;
        if(failure)reject(Error(failure));else if(code===0)resolve();else reject(Error(`Worker exited ${code}: ${stderr.replace(/(?:sk-|ts_)[A-Za-z0-9_-]+/g,'[redacted]')}`));
      });
      child.stdin.end(prompt);
    });
    if(fs.statSync(output).size>2000000)throw Error('Oversized worker output');
    const envelope=JSON.parse(fs.readFileSync(output,'utf8'));
    return {result:decodeWorkerOutput(envelope,job),usage};
  }catch(error){error.usage=usage;throw error;}
  finally{fs.rmSync(directory,{recursive:true,force:true});}
}
// The source monitor's entry for a page, so that a capture also registers the monitor's view of the very same bytes (evidence.mjs, VIEWS).
// `sources` and `hostIgnore` are those of source-watch.json (read from the file when not given); null for a page the monitor does not watch.
export function watchFor(url,{sources=null,hostIgnore=null,records=[]}={}){
  if(!sources){
    let config;try{config=JSON.parse(fs.readFileSync(path.join(here,'source-watch.json'),'utf8'));}catch{return null;}
    sources=config.sources;hostIgnore??=config.hostIgnore;
  }
  const wanted=normUrl(url),source=sources.find(item=>normUrl(item.url)===wanted);
  return source?{source,hostIgnore:hostIgnore??{},records}:null;
}
export async function captureClaims(bundle,card,{captureImpl=captureUrl,prepared=[],saveImpl=saveSnapshot,queue=null,signal,assertActive=()=>{}}={}){
  assertActive();
  if(!bundle||!Array.isArray(bundle.claims))throw Error('Missing claims');
  const snapshots=new Map(),bySource=new Map();
  for(const claim of bundle.claims){
    claim.submittedKey=claim.key;
    if(claim.status==='supported'&&CRITICAL_FIELDS.has(claim.field)&&(claim.kind!=='official'||claim.scope!=='exact-card')){
      claim.rejectedValue=claim.value;claim.value=null;claim.status='unknown';
      claim.controllerRejection='Critical claim lacks exact-offer official scope; other valid claims may continue to independent verification.';
      claim.note=(claim.note||'')+' '+claim.controllerRejection;
    }
    // A figure the quote does not write (a sum, a school grade turned into an age, "babies" as 0) is the model's own work out, not the page's.
    const slip=claim.status==='supported'&&numberProblem(claim.field,claim.value,claim.quote);
    if(slip){
      claim.rejectedValue=claim.value;claim.value=null;claim.status='unknown';
      claim.controllerRejection=slip+'; the proposed value is not approved.';claim.note=(claim.note||'')+' '+claim.controllerRejection;
    }
    if(claim.field==='notes'&&claim.status==='supported'&&typeof claim.value==='string'){
      claim.value=[claim.value];claim.normalization='single-note-to-array';
    }
    claim.key=claim.field+'-'+digest([claim.field,claim.source,claim.value,claim.quote]).slice(0,12);
    if(claim.status!=='supported'&&claim.value!==null){claim.rejectedValue=claim.value;claim.value=null;}
  }
  const unique=new Map();
  for(const claim of bundle.claims){
    const signature=digest([claim.field,claim.source,claim.value,claim.status,claim.scope,claim.kind,claim.quote,claim.rejectedValue??null]);
    const existing=unique.get(signature);
    if(existing){
      existing.mergedDuplicates??=[];
      existing.mergedDuplicates.push({submittedKey:claim.submittedKey,note:claim.note});
    }else unique.set(signature,claim);
  }
  bundle.claims=[...unique.values()];
  for(const claim of bundle.claims.filter(c=>c.status==='supported')){
    if(!bySource.has(claim.source)){
      try{
        const evidence=prepared.filter(e=>e.url===claim.source);
        if(!evidence.length)evidence.push(await captureImpl(claim.source,{watch:watchFor(claim.source,{records:[card]}),signal}));
        // A capture and the other views of it (the monitor's) are all saved and registered; a quote may be found in any of them, the capture first.
        const set=evidence.flatMap(capturedSet);
        for(const item of set){assertActive();await saveImpl(path.join(here,'typesafe-runtime'),item);assertActive();if(queue)registerCaptured(queue,item);}
        bySource.set(claim.source,set);
      }catch{assertActive();bySource.set(claim.source,[]);}
    }
    const evidence=bySource.get(claim.source).find(e=>locateQuote(e,claim.quote));
    if(!evidence||!locateQuote(evidence,claim.quote)){
      claim.rejectedValue=claim.value;claim.value=null;claim.status='unknown';claim.snapshotId=evidence?.id||null;
      claim.note=(claim.note||'')+' Controller could not establish the supplied quote in a current captured source; the proposed value is not approved.';
    }else{snapshots.set(evidence.id,evidence);claim.snapshotId=evidence.id;claim.note||='Captured official excerpt; exact offer semantics require independent verification.';}
  }
  bundle.snapshots=[...snapshots.values()].filter(Boolean);validateClaims(bundle,card);return bundle;
}
export function runClaude(job,policy,options={}){
  return runClaudeWorker(job,policy,{route:modelRoute(job,policy),promptImpl:promptFor,
    evidenceFilesImpl:workerEvidenceFiles,copyImagesImpl:copyWorkerImages,...options});
}
// The wall time of the model process goes into its usage event, so a cycle can add up model seconds.
export async function timedWorker(worker,...args){
  const started=performance.now(),stamp=usage=>{if(usage&&typeof usage==='object')usage.modelSeconds=Math.round((performance.now()-started)/100)/10;};
  try{const output=await worker(...args);stamp(output.usage);return output;}
  catch(error){stamp(error.usage);throw error;}
}
export function runModel(job,policy,options={}){
  if(policy.workerProvider==='claude')return runClaude(job,policy,options);
  if(!policy.workerProvider||policy.workerProvider==='codex')return runCodex(job,policy,options);
  throw Error('Unknown worker provider; no automatic fallback');
}
const CLAUDE_EFFORTS=new Set(['low','medium','high','max']);
export function assertWorkerPolicy(policy){
  const provider=policy.workerProvider??'codex';
  if(!['codex','claude'].includes(provider))throw Error('Unknown worker provider; no automatic fallback');
  if(provider==='claude')for(const [role,config] of Object.entries(policy.roles||{})){
    if(config.model===null)continue;
    if(typeof config.claudeModel!=='string'||!config.claudeModel.trim()||
      !CLAUDE_EFFORTS.has(config.effort)||!CLAUDE_EFFORTS.has(config.criticalEffort))
      throw Error(`Invalid worker policy: Claude route for ${role} needs claudeModel and a supported effort`);
  }
  return provider;
}
export function modelPreflight(policy,options={}){
  return assertWorkerPolicy(policy)==='claude'?assertClaudeReady(options):null;
}
// A claim spends one of a job's three attempts. Model work is therefore claimed
// only after the provider answered in this run; deterministic QA stays available.
export async function gatedRoles(roles,priorities,gate){
  if(!gate.preflight)return roles;
  if(gate.ready===null&&roles.some(role=>role!=='qa'&&priorities.has(role))){
    // One slow or failed login check must not lose the whole batch: ask once more after a pause (injectable, so tests do not wait).
    gate.tries=0;
    while(gate.ready!==true&&gate.tries<2){
      if(gate.tries)await (gate.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(gate.retryMs??60000);
      gate.tries++;
      try{await gate.preflight();gate.ready=true;}
      catch(error){gate.ready=false;gate.reason=String(error.message).slice(0,500);}
    }
  }
  return gate.ready===true?roles:roles.filter(role=>role==='qa');
}
// A provider outage (usage limit, login) is not the job's fault, so the job keeps its attempt; every other failure counts, including a
// refused model answer and any QA failure (test output can mention "429" without any provider being down).
export function failJob(queue,job,role,error,{answered=false}={}){
  const outage=role!=='qa'&&!answered&&/^provider-/.test(failureCategory(error.message)||'');
  return queue.failOwned(job.id,job.token,role,error.message,{uncounted:outage});
}
// The deadline covers capture and preparation too. Persistent lease time is only for ownership/restart recovery.
export async function withJobLease(queue,job,role,work,{leaseMs=900000,timeoutMs=1800000,monotonic=()=>performance.now(),renewEveryMs=Math.min(30000,leaseMs/3)}={}){
  const controller=new AbortController(),started=monotonic();let active=true;
  const cancel=error=>{if(!controller.signal.aborted)controller.abort(error);};
  const check=()=>{
    controller.signal.throwIfAborted();
    if(!active)throw Object.assign(Error('Job no longer active'),{code:'LEASE_LOST'});
    if(monotonic()-started>=timeoutMs){cancel(Object.assign(Error('Whole job time limit'),{code:'JOB_TIMEOUT'}));controller.signal.throwIfAborted();}
    try{queue.requireLease(job.id,job.token,role);}catch(error){cancel(error);throw error;}
  };
  const pulse=()=>{try{check();queue.renew(job.id,job.token,role,leaseMs);}catch(error){cancel(error);}};
  let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',rejectAbort,{once:true});});
  const renew=setInterval(pulse,renewEveryMs),deadline=setTimeout(()=>cancel(Object.assign(Error('Whole job time limit'),{code:'JOB_TIMEOUT'})),timeoutMs);
  try{return await Promise.race([aborted,Promise.resolve().then(()=>{check();return work({signal:controller.signal,check,renew:pulse,
    remaining:()=>Math.max(1,timeoutMs-(monotonic()-started)),blockingBudget:()=>Math.max(1,Math.min(leaseMs/2,timeoutMs-(monotonic()-started)))});})]);}
  finally{active=false;clearInterval(renew);clearTimeout(deadline);controller.signal.removeEventListener('abort',rejectAbort);}
}
export async function prepareEvidence(job,{captureImpl=captureUrl,saveImpl=saveSnapshot,queue=null,sources=null,hostIgnore=null,signal,assertActive=()=>{}}={}){
  assertActive();
  // A verifier also receives the sources fetched for leads of an earlier round; otherwise it cannot see what following its lead produced.
  const urls=[...(job.payload.sourceIssues||[]).map(i=>i.details?.url),...(job.payload.researchLeads||[]).map(l=>l.source),...(job.kind==='verify-facts'?job.payload.followedLeads||[]:[]).map(l=>l.source),
    ...(job.payload.draft?.bindings||[]).map(b=>b.source),
    ...(job.payload.draft?.findings||[]).map(f=>f.url),...(job.payload.corrections||[]).map(c=>c.correction.source),
    ...(job.payload.rejectedDraft?.findings||[]).map(f=>f.url),
    ...(job.payload.bundle?.claims||[]).map(c=>c.source),...(job.payload.card?.sources||[]).map(s=>s.url)];
  const evidence=[],failures=[];
  if(!sources){const config=JSON.parse(fs.readFileSync(path.join(here,'source-watch.json'),'utf8'));sources=config.sources;hostIgnore??=config.hostIgnore;}
  const records=[job.payload.card].filter(Boolean),watch=url=>watchFor(url,{sources,hostIgnore:hostIgnore??{},records});
  // Everything a capture holds is saved and registered (the capture and the monitor's view of it); only the capture goes to the worker.
  const keep=async item=>{for(const part of capturedSet(item)){await saveImpl(path.join(here,'typesafe-runtime'),part);if(queue)registerCaptured(queue,part);}};
  const feeds=sources.filter(source=>source.type==='ics'&&source.recordIds.includes(job.payload.card?.id));
  for(const source of feeds){
    try{
      const raw=await captureImpl(source.url,{type:'ics',watch:watch(source.url),signal});assertActive();await keep(raw);assertActive();
      const selected=calendarEvidence(raw,job.payload.card).evidence;
      await saveImpl(path.join(here,'typesafe-runtime'),selected);assertActive();if(queue)registerCaptured(queue,selected);evidence.push(selected);
    }catch(error){assertActive();failures.push({url:source.url,status:'calendar-capture-unavailable',reason:String(error.message).slice(0,200)});}
  }
  for(const url of [...new Set(urls)].filter(Boolean).slice(0,5)){
    if(feeds.some(source=>source.url===url))continue;
    try{assertActive();const snapshot=await captureImpl(url,{watch:watch(url),signal});assertActive();await keep(snapshot);assertActive();evidence.push(snapshot);}
    catch{assertActive();failures.push({url,status:'capture-unavailable'});}
  }
  if(queue)for(const previous of job.payload.bundle?.snapshots||[]){
    if(evidence.some(current=>current.url===previous.url&&current.textHash===previous.textHash))registerCaptured(queue,previous);
  }
  return {...job,payload:{...job.payload,preparedEvidence:evidence,evidenceFailures:failures}};
}
export async function captureDraft(draft,prepared,queue,{captureImpl=captureUrl,saveImpl=saveSnapshot,signal,assertActive=()=>{}}={}){
  assertActive();
  if(!Array.isArray(draft.bindings))throw Error('Editor did not provide evidence bindings');
  const snapshots=new Map(),fetched=new Map();
  for(const binding of draft.bindings){
    let evidence=prepared.flatMap(capturedSet).find(e=>e.url===binding.source&&locateQuote(e,binding.quote));
    if(!evidence){
      if(!fetched.has(binding.source))fetched.set(binding.source,await captureImpl(binding.source,{watch:watchFor(binding.source),signal}));
      const set=capturedSet(fetched.get(binding.source));
      evidence=set.find(e=>locateQuote(e,binding.quote))??set[0];
    }
    assertActive();await saveImpl(path.join(here,'typesafe-runtime'),evidence);assertActive();registerCaptured(queue,evidence);snapshots.set(evidence.id,evidence);
    binding.snapshotId=evidence.id;
  }
  const reviewed=new Set((draft.reviewCoverage?.fields||[]).flatMap(row=>row.snapshotIds));
  for(const evidence of prepared.filter(e=>reviewed.has(e.id))){registerCaptured(queue,evidence);snapshots.set(evidence.id,evidence);}
  draft.snapshots=[...snapshots.values()];return draft;
}
export async function semanticClaims(bundle,card,{judgeImpl=judgeBatch}={}){
  if(!bundle.claims.some(c=>c.status==='supported'))return {status:'not-needed',rows:[],requests:0,automaticPublication:false};
  try{
    const policy=await readPolicy();if(!policy.enabled)return {status:'disabled',automaticPublication:false};
    const client=await createClient(),rows=[];let requests=0,estimatedCostUsd=0;
    for(const evidence of bundle.snapshots){
      const claims=bundle.claims.filter(c=>c.status==='supported'&&c.snapshotId===evidence.id);
      for(let offset=0;offset<claims.length;offset+=policy.maxQuestionsPerRequest){
        if(requests>=policy.maxRequestsPerRun)return {status:'budget-limited',rows,automaticPublication:false};
        const jobs=claims.slice(offset,offset+policy.maxQuestionsPerRequest).map(claim=>({
          target:{id:card.id,name:card.name,town:card.town,address:card.address},field:claim.field,
          claim:`${claim.field}: ${JSON.stringify(claim.value)}. ${claim.note}`,quote:claim.quote,kind:claim.kind}));
        const judged=await judgeImpl({evidence,jobs,policy,client,cacheDirectory:path.join(here,'typesafe-runtime','judgments')});
        rows.push(...judged.rows);requests+=judged.requests;estimatedCostUsd+=judged.estimatedCostUsd||0;
      }
    }
    return {status:rows.some(r=>r.status==='service-unavailable')?'unavailable':'completed',rows,requests,estimatedCostUsd,automaticPublication:false};
  }catch{return {status:'unavailable',automaticPublication:false};}
}
// The public gates CI runs on a clean clone (npm run audit:public and scan:public in .github/workflows/test.yml), run here on the site QA has just built.
// A contact that no person has reviewed, a Swiss mobile number, a private path that git tracks, a secret or a personal path fails QA, so no release job follows.
export const PUBLIC_GATES=[['public-audit',['editorial/public-audit.mjs','--strict']],['public-scan',['scripts/scan-public.mjs']]];
export function qaRun(queue,job,{check=()=>{},renew=()=>{},blockingBudget=()=>180000,runImpl=execFileSync}={}){
  const checks=[],inputRevision=sourceRevision(root,{generated:false});let testedManifest=null,snapshot=null,compiledRevision=null;
  for(const [label,args] of [
    ['compile',['editorial/compile-review.mjs']],['catalogue',['maintain.mjs']],
    ['build',['build.mjs']],['profile',['editorial/profile.mjs']],...PUBLIC_GATES,
    ['unit',['--test',...fs.readdirSync(root).filter(f=>f.endsWith('.test.mjs')),
      ...fs.readdirSync(here).filter(f=>f.endsWith('.test.mjs')).map(f=>'editorial/'+f)]],
    ['mobile-ages',['verify-age.mjs']],['mobile-flow',['verify-mobile.mjs']]]){
    check();renew();check();
    if(label==='unit'){
      if(inputRevision!==sourceRevision(root,{generated:false}))throw Error('Build inputs changed during compilation');
      compiledRevision=sourceRevision();testedManifest=publicManifest();
      snapshot=path.join(here,'workflow-state','release-snapshots',testedManifest.revision);
      if(!fs.existsSync(snapshot))fs.cpSync(path.join(root,'.publish'),snapshot,{recursive:true,errorOnExist:true,force:false});
      if(publicManifest(snapshot).revision!==testedManifest.revision)throw Error('Release snapshot differs from built files');
    }
    try{runImpl(process.execPath,args,{cwd:root,timeout:Math.max(1,Math.floor(Math.min(180000,blockingBudget()))),maxBuffer:12000000,stdio:'pipe',
      env:{...process.env,APP_URL:pathToFileURL(path.join(snapshot||path.join(root,'.publish'),'index.html')).href}});}
    catch(error){check();throw error;}
    check();checks.push(label);
  }
  check();
  if(compiledRevision!==sourceRevision()||inputRevision!==sourceRevision(root,{generated:false})||testedManifest.revision!==publicManifest().revision)throw Error('Sources or built files changed while QA was running');
  const manifest=testedManifest;
  queue.transaction(()=>{
    queue.requireLease(job.id,job.token,'qa');
    queue.db.prepare("UPDATE jobs SET state='superseded',updated_at=? WHERE kind='qa' AND state IN ('ready','retry') AND id<>?").run(queue.now(),job.id);
    queue.db.prepare("UPDATE jobs SET state='superseded',updated_at=? WHERE kind='release' AND state IN ('ready','retry') AND input_revision<>?").run(queue.now(),manifest.revision);
    queue.db.prepare(`INSERT INTO releases VALUES (?,?,?,?) ON CONFLICT(revision) DO UPDATE SET
      state=CASE WHEN releases.state='published' THEN 'published' ELSE 'tested' END,
      manifest=excluded.manifest,created_at=excluded.created_at`).run(manifest.revision,'tested',JSON.stringify({manifest,checks,sourceRevision:compiledRevision}),queue.now());
    queue.finish(job.id,job.token,'qa',{checks,manifest,sourceRevision:compiledRevision},{followups:[{kind:'release',cardId:'catalogue',
      inputRevision:manifest.revision,priority:1000,payload:{manifest,checks}}]});
  });queue.flush(root);return {checks,revision:manifest.revision,publication:'manual'};
}
export function publicManifest(directory=path.join(root,'.publish')){
  const files={};
  const walk=(base,relative='')=>{
    for(const entry of fs.readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.name==='.vercel')continue;
      const name=path.posix.join(relative,entry.name),file=path.join(base,entry.name);
      if(entry.isSymbolicLink())throw Error('Symlink in public build');
      if(entry.isDirectory())walk(file,name);else files[name]=digest(fs.readFileSync(file).toString('base64'));
    }
  };walk(directory);return {revision:digest(files),files};
}
export function normalizePilotSources(sources,{pilot=false}={}){
  if(!Array.isArray(sources)||sources.length>3||sources.length&&!pilot)throw Error('At most three supplementary sources require an explicit pilot');
  return [...new Set(sources.map(publicUrl))];
}
// A worker answer the controller refused is kept as an immutable artifact marked rejected; it never reaches the catalogue.
export function recordRejectedOutput(queue,job,role,workerOutput,error,outputRoot=root){
  const rejected={project:PROJECT_ID,jobId:job.id,role,inputRevision:job.input_revision,rejected:true,result:workerOutput.result};
  const hash=digest(rejected);
  queue.transaction(()=>{
    queue.db.prepare('INSERT OR IGNORE INTO artifacts VALUES (?,?,?,?,?)').run(hash,job.id,role,JSON.stringify(rejected),queue.now());
    queue.db.prepare('INSERT INTO outbox(job_id,file,data) VALUES (?,?,?)').run(job.id,`editorial/agent-artifacts/${hash}.json`,JSON.stringify(rejected));
    queue.event(job.id,'rejected-output',{hash,reason:error.message});
    queue.event(job.id,'usage',workerOutput.usage);
  });queue.flush(outputRoot);
  return hash;
}
export async function runJobs({role=null,limit=4,chain=false,queue=null,worker=runModel,cardId=null,pilot=false,fullReview=false,sources=[],preflight,preflightRetryMs=60000,sleep,
  monotonic=()=>performance.now(),syncImpl=syncQueue,prepareImpl=prepareEvidence,commitImpl=commitResult,reportFile=path.join(here,'workflow-report.json'),leaseOptions={}}={}){
  assertRuntimeCurrent(loadedRuntimeRevision);
  sources=normalizePilotSources(sources,{pilot});
  const policy=JSON.parse(fs.readFileSync(path.join(here,'agent-policy.json'),'utf8'));
  const maxOpenChains=JSON.parse(fs.readFileSync(path.join(here,'cycle-policy.json'),'utf8')).maxOpenChains??8;
  if(policy.project!==PROJECT_ID||policy.schema!==1||!Number.isInteger(limit)||limit<1||limit>policy.maxJobsPerRun||
    !Number.isInteger(policy.maxToolCallsPerJob)||policy.maxToolCallsPerJob<1||policy.maxToolCallsPerJob>200||
    !Number.isFinite(policy.maxRunMinutes)||policy.maxRunMinutes<=0||policy.maxRunMinutes>60||
    role&&!['search','verify','arbitrate','editor','qa'].includes(role))throw Error('Invalid worker policy, role or limit');
  const provider=assertWorkerPolicy(policy);
  if(preflight===undefined)preflight=worker===runModel&&provider==='claude'?modelPreflight:null;
  const gate={preflight:preflight&&(()=>preflight(policy)),ready:null,reason:null,retryMs:preflightRetryMs,sleep};
  const owned=!queue;queue??=new JobQueue(path.join(here,'workflow-state','jobs.sqlite'));
  const results=[];
  const startedAt=monotonic();let stopReason=null,runError=null;
  try{
    if(pilot){
      const card=currentInputs().records.find(r=>r.id===cardId);if(!card)throw Error('Unknown pilot card');
      const inputRevision=digest(['pilot',card,today(),policy,CONTRACTS,fieldDictionary(),promptFor.toString(),captureClaims.toString(),fullReview,sources]);
      queue.transaction(()=>{
        for(const job of queue.list())if(job.card_id===cardId&&job.payload.pilot&&job.input_revision!==inputRevision&&['ready','retry'].includes(job.state)){
          queue.db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE id=?').run('superseded',queue.now(),job.id);queue.event(job.id,'pilot-contract-updated');
        }
      });
      queue.enqueue({kind:'facts',cardId,inputRevision,priority:1000,
        payload:{card,cardRevision:digest(card),date:today(),pilot:true,requestedReview:fullReview?'full':'partial',
          researchLeads:sources.map(source=>({source,note:'Operator-supplied public document for independent exact-offer inspection; not an approved fact.'}))}});
    }
    for(let i=0;i<limit;i++){
      if(runtimeContractRevision()!==loadedRuntimeRevision){stopReason='editorial-runtime-changed';break;}
      if(monotonic()-startedAt>=policy.maxRunMinutes*60000){stopReason='run-time-budget';break;}
      const circuitOpen=Boolean(queue.circuit()?.open);
      if(circuitOpen&&!chain&&role!=='qa'){stopReason='systemic-failure-circuit';break;}
      syncImpl(queue);
      const priorities=new Map(),downstream=new Map(),urgent=new Map();
      for(const job of queue.list().filter(j=>(j.state==='ready'||j.state==='retry'&&j.retry_after<=queue.now())&&(!cardId||j.card_id===cardId))){
        const assigned=Object.keys(ROLE_KINDS).find(r=>ROLE_KINDS[r].includes(job.kind));
        priorities.set(assigned,Math.max(priorities.get(assigned)||0,job.priority));
        if(DOWNSTREAM.includes(job.kind))downstream.set(assigned,Math.max(downstream.get(assigned)||0,job.priority));
        if(urgentJob(job,queue.now()))urgent.set(assigned,Math.max(urgent.get(assigned)||0,job.priority));
      }
      const blocked=gate.ready===false;
      const roles=await gatedRoles(runRoles({role,chain,circuitOpen,priorities,downstream,first:i===0}),priorities,gate);let job,assignedRole;
      if(gate.ready===false&&!blocked)queue.event(null,'worker-preflight-failed',{provider,reason:gate.reason,tries:gate.tries});
      for(const selection of [...(i===0?[{urgentOnly:true}]:[]),...(chain?[{kinds:DOWNSTREAM}]:[]),{}]){
        const order=selection.urgentOnly?[...roles].sort((a,b)=>(urgent.get(b)??-Infinity)-(urgent.get(a)??-Infinity)):roles;
        for(const possible of order){
          job=queue.claim(possible,`runtime-${possible}`,{leaseMs:policy.leaseMinutes*60000,backpressure:policy.backpressure,cardId,maxOpenChains,...selection});
          if(job){assignedRole=possible;break;}
        }
        if(job)break;
      }
      if(!job){stopReason=gate.ready===false?'worker-login-unavailable':circuitOpen?'systemic-failure-circuit':stopReason;break;}
      let workerOutput=null;
      try{
        const result=await withJobLease(queue,job,assignedRole,async active=>{
          if(assignedRole==='qa')return qaRun(queue,job,active);
          const evidenceOptions={queue,signal:active.signal,assertActive:active.check};
          const prepared=await prepareImpl(job,evidenceOptions);active.check();
          const output=await timedWorker(worker,prepared,policy,{timeoutMs:Math.min(720000,active.remaining()),signal:active.signal});active.check();workerOutput=output;
          assertRuntimeCurrent(loadedRuntimeRevision);
          if(job.kind==='facts'||job.kind==='adjudicate-facts'&&output.result.bundle){
            await captureClaims(output.result.bundle,job.payload.card,{prepared:prepared.payload.preparedEvidence,...evidenceOptions});active.check();
            if(policy.semanticPrecheck)output.result.bundle.semanticAdvisory=await semanticClaims(output.result.bundle,job.payload.card);
          }
          if(['editorial','integrate'].includes(job.kind))await captureDraft(output.result.draft,prepared.payload.preparedEvidence,queue,evidenceOptions);
          active.check();
          assertRuntimeCurrent(loadedRuntimeRevision);
          const result=commitImpl(queue,{jobId:job.id,token:job.token,role:assignedRole,result:output.result});
          queue.event(job.id,'usage',output.usage);
          return result;
        },{leaseMs:policy.leaseMinutes*60000,timeoutMs:Math.max(1,policy.maxRunMinutes*60000-(monotonic()-startedAt)),monotonic,...leaseOptions});
        results.push({jobId:job.id,cardId:job.card_id,kind:job.kind,result});
      }catch(error){
        const cleanupErrors=[];
        try{
          if(!workerOutput&&error.usage)queue.event(job.id,'usage',{...error.usage,failed:true});
          if(workerOutput&&error.code!=='LEASE_LOST')recordRejectedOutput(queue,job,assignedRole,workerOutput,error);
        }catch(cleanup){cleanupErrors.push(cleanup.message);}
        try{failJob(queue,job,assignedRole,error,{answered:Boolean(workerOutput)});}catch(cleanup){cleanupErrors.push(cleanup.message);}
        results.push({jobId:job.id,cardId:job.card_id,kind:job.kind,error:error.message,...(error.code&&{code:error.code}),...(cleanupErrors.length&&{cleanupErrors})});
        if(['LEASE_LOST','JOB_TIMEOUT'].includes(error.code)){stopReason=error.code==='LEASE_LOST'?'lease-lost':'run-time-budget';break;}
        // A subscription outage or limit would otherwise spend an attempt on every remaining job of the run.
        if(provider==='claude'&&/^provider-/.test(failureCategory(error.message)||'')){stopReason='worker-provider-failure';break;}
      }
    }
    return {results,stopReason,summary:queue.summary()};
  }catch(error){runError=error.message;throw error;}
  finally{
    try{await writeJsonAtomic(reportFile,{...queue.summary(),recentRun:results,stopReason,...(runError&&{runError})});}
    finally{if(owned)queue.close();}
  }
}
export function runRoles({role,chain,circuitOpen=false,priorities=new Map(),downstream=new Map(),first=true}){
  const roles=chain?(circuitOpen?['qa']:['qa','verify','arbitrate','editor','search'].sort((a,b)=>(priorities.get(b)||0)-(priorities.get(a)||0))):[role];
  if(chain&&downstream.size)roles.sort((a,b)=>Number(downstream.has(b))-Number(downstream.has(a))||(downstream.get(b)||0)-(downstream.get(a)||0));
  else if(chain&&first&&role&&roles.includes(role)){roles.splice(roles.indexOf(role),1);roles.unshift(role);}
  return roles;
}
export function upgradeInvestigatedJob(queue,id,note,{getInputs=currentInputs,expectedFailure=null}={}){
  if(!note?.trim())throw Error('Contract repair needs an investigation note');
  return queue.transaction(()=>{
    const old=queue.get(id);
    const failure=/^Worker input exceeds budget/.test(old?.error||'')?'input-budget':
      old?.error==='checked requires a current full-card review'?'incomplete-full-review':null;
    if(old?.state!=='retry'||!failure||expectedFailure&&failure!==expectedFailure||old.attempt>=3)throw Error('Only a retryable diagnosed contract failure may be upgraded');
    if(failure==='incomplete-full-review'){
      const artifact=queue.db.prepare("SELECT data FROM artifacts WHERE job_id=? AND json_extract(data,'$.rejected')=1 ORDER BY created_at DESC LIMIT 1").get(id);
      const draft=artifact?JSON.parse(artifact.data).result?.draft:null;
      if(!['editorial','integrate'].includes(old.kind)||old.payload.requestedReview!=='full'||!draft?.reviewLimitations?.length||
        !draft.reviewCoverage||Object.hasOwn(draft.patch,'checked'))throw Error('Incomplete full review repair needs the intact rejected partial draft and its source limitations');
    }
    const card=getInputs().records.find(record=>record.id===old.card_id);
    if(!card||digest(card)!==old.payload.cardRevision)throw Error('Card changed; synchronize instead of upgrading this job');
    const revision=digest(promptFor.toString());
    if(old.payload.workerPromptRevision===revision)throw Error('Worker prompt did not change');
    const payload={...old.payload,workerPromptRevision:revision,previousJobId:old.id};
    const next=queue.enqueue({kind:old.kind,cardId:old.card_id,inputRevision:digest([old.input_revision,payload]),priority:old.priority,payload});
    queue.db.prepare('UPDATE jobs SET attempt=? WHERE id=?').run(old.attempt,next.id);
    queue.db.prepare("UPDATE jobs SET state='superseded',updated_at=? WHERE id=?").run(queue.now(),old.id);
    queue.event(old.id,'worker-contract-upgraded',{nextJobId:next.id,note,failure,attemptsRetained:old.attempt});
    return {previousJobId:old.id,jobId:next.id,attemptsRetained:old.attempt};
  });
}
export function upgradeInputBudgetJob(queue,id,note,options={}){
  return upgradeInvestigatedJob(queue,id,note,{...options,expectedFailure:'input-budget'});
}
export function requestQa(queue,base=root){
  const revision=sourceRevision(base,{generated:false});
  return queue.transaction(()=>{
    const pending=queue.list().find(job=>job.kind==='qa'&&['ready','retry','leased'].includes(job.state)&&
      job.payload.requestedBy==='operator'&&job.payload.sourceRevision===revision);
    if(pending)return pending;
    return queue.enqueue({kind:'qa',cardId:'catalogue',inputRevision:digest(['operator-qa',revision,randomUUID()]),priority:1000,
      payload:{requestedBy:'operator',sourceRevision:revision}});
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const upgradeId=process.argv.find(x=>x.startsWith('--upgrade-input-job='))?.split('=')[1];
  const repairId=process.argv.find(x=>x.startsWith('--repair-contract-job='))?.split('=')[1];
  if(upgradeId||repairId){
    const queue=new JobQueue(path.join(here,'workflow-state','jobs.sqlite'));
    try{console.log(JSON.stringify((upgradeId?upgradeInputBudgetJob:upgradeInvestigatedJob)(queue,upgradeId||repairId,process.argv.find(x=>x.startsWith('--note='))?.slice(7)),null,2));}
    finally{queue.close();}
    process.exit(0);
  }
  if(process.argv.includes('--check-worker')){
    const policy=JSON.parse(fs.readFileSync(path.join(here,'agent-policy.json'),'utf8'));
    console.log(JSON.stringify({provider:assertWorkerPolicy(policy),ready:modelPreflight(policy)}));
    process.exit(0);
  }
  const role=process.argv.find(x=>x.startsWith('--role='))?.slice(7);
  const limit=Number(process.argv.find(x=>x.startsWith('--limit='))?.slice(8)||1);
  if(process.argv.includes('--request-qa')){
    if(role!=='qa')throw Error('--request-qa requires --role=qa');
    const queue=new JobQueue(path.join(here,'workflow-state','jobs.sqlite'));
    try{requestQa(queue);}finally{queue.close();}
  }
  if(process.argv.includes('--publish'))throw Error('Use editorial/release.mjs publish after explicit release authorization');
  const replayId=process.argv.find(x=>x.startsWith('--replay-rejected='))?.slice(18);
  if(!role&&!process.argv.includes('--chain')&&!replayId)throw Error('Use --role=search|verify|arbitrate|editor|qa or --chain');
  const cardId=process.argv.find(x=>x.startsWith('--card='))?.slice(7);
  if(replayId){
    const queue=new JobQueue(path.join(here,'workflow-state','jobs.sqlite'));
    try{
      const job=queue.get(replayId);
      if(job?.kind!=='facts'||!['retry','attention'].includes(job.state))throw Error('Only rejected fact extraction can be replayed');
      const artifact=queue.db.prepare('SELECT hash,data FROM artifacts WHERE job_id=? ORDER BY created_at DESC LIMIT 1').get(job.id);
      const saved=artifact&&JSON.parse(artifact.data);
      if(!saved?.rejected||digest(saved)!==artifact.hash)throw Error('No intact rejected artifact');
      if(digest(currentInputs().records.find(r=>r.id===job.card_id))!==job.payload.cardRevision)throw Error('Replay card changed');
      queue.transaction(()=>{
        queue.db.prepare("UPDATE jobs SET state='ready',priority=5000 WHERE id=?").run(job.id);
        queue.event(job.id,'operator-replay',{artifact:artifact.hash,reason:'Revalidate existing research after controller contract repair; no attempt reset.'});
      });
      console.log(JSON.stringify(await runJobs({role:'search',limit:1,cardId:job.card_id,queue,
        worker:async()=>({result:structuredClone(saved.result),usage:{replayed:true,artifact:artifact.hash}})}),null,2));
    }finally{queue.close();}
  }else{
    if(process.argv.includes('--full-review')&&!process.argv.includes('--pilot'))throw Error('Explicit full-review pilot requires --pilot and --card');
    console.log(JSON.stringify(await runJobs({role,limit,chain:process.argv.includes('--chain'),cardId,pilot:process.argv.includes('--pilot'),fullReview:process.argv.includes('--full-review'),
      sources:process.argv.filter(x=>x.startsWith('--source=')).map(x=>x.slice(9))}),null,2));
  }
}
