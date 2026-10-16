// Derived private provenance, never an input to the catalogue or the queue.
// node editorial/fact-ledger.mjs [--root=PATH] [--out=DIR] [--dry-run]
// Use a quiescent, checkpointed queue: immutable SQLite does not read a live WAL.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {loadCatalog,root as workspace} from './quality.mjs';
import {CLAIM_FIELDS,CRITICAL_FIELDS,FULL_REVIEW_UNKNOWN_TEXT,UNCONFIRMED_PROSE,validateFieldValue,validDate} from './field-contract.mjs';
import {catalogueFacts} from './catalogue-store.mjs';
import {digest} from './jobs.mjs';
import {approvalSummary} from './catalogue-journal.mjs';
import {validateSnapshot,locateQuote,hash,normalizeQuote} from './evidence.mjs';
import {readRecord} from './page-record.mjs';
import {normUrl} from './monitor.mjs';
import {PROJECT_ID} from './project-id.mjs';
import {applyDraftRecord} from './workflow.mjs';

export const LEDGER_DIRECTORY='editorial/fact-ledger';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const json=value=>JSON.parse(JSON.stringify(value));
const equal=(a,b)=>isDeepStrictEqual(json(a),json(b));
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]+$/.test(value);
const issue=(reason,details={})=>({reason,fatal:false,...details});
function fail(reason,message,details={}){const error=Error(message);error.verification=issue(reason,{...details,fatal:true});throw error;}

export function catalogueValues(card){
  const practical=new Map(catalogueFacts(card));
  return [...CLAIM_FIELDS].map(field=>{
    const value=field.startsWith('practical.')?practical.get(field.slice(10))?.value:card[field];
    return {field,present:value!==undefined,value:json(value??null)};
  });
}
export function unknownValue(field,value){
  return value==null||value===''||Array.isArray(value)&&!value.length||value==='unknown'||field==='status'&&value==='check'||
    (FULL_REVIEW_UNKNOWN_TEXT[field]||[]).some(text=>text.toLowerCase()===String(value).trim().toLowerCase())||
    !!FULL_REVIEW_UNKNOWN_TEXT[field]&&typeof value==='string'&&!/\d/.test(value)&&UNCONFIRMED_PROSE.test(value);
}
function realTarget(file){
  if(fs.existsSync(file))return fs.realpathSync(file);
  return path.join(realTarget(path.dirname(file)),path.basename(file));
}
export function parseArgs(argv){
  const options={root:workspace,out:null,dryRun:false};
  for(const arg of argv){
    const match=/^--(root|out)=(.+)$/.exec(arg);
    if(match)options[match[1]]=path.resolve(match[2]);
    else if(arg==='--dry-run')options.dryRun=true;
    else throw Error('Unknown or incomplete option: '+arg);
  }
  options.out??=path.join(options.root,LEDGER_DIRECTORY);
  const relative=path.relative(realTarget(options.root),realTarget(options.out));
  if(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)&&
    relative!==LEDGER_DIRECTORY&&!relative.startsWith(LEDGER_DIRECTORY+path.sep))
    throw Error('--out inside the checkout must be under '+LEDGER_DIRECTORY);
  return options;
}
function openQueue(root){
  const file=path.join(root,'editorial/workflow-state/jobs.sqlite');
  if(!fs.existsSync(file))return null;
  if(fs.existsSync(file+'-wal')&&fs.statSync(file+'-wal').size)throw Error('Queue has a WAL; stop the controller and checkpoint it before reading immutable data');
  const db=new DatabaseSync(pathToFileURL(file).href+'?immutable=1',{readOnly:true});
  try{
    const metadata=Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row=>[row.key,row.value]));
    if(metadata.project!==PROJECT_ID||metadata.schema!=='1')throw Error('Wrong queue identity or schema');
    return db;
  }catch(error){db.close();throw error;}
}
function artifactAt(root,id,{jobId,role,inputRevision,kind='approval'}={}){
  if(!hex(id))throw Error('Invalid artifact digest');
  const relative='editorial/agent-artifacts/'+id+'.json',file=path.join(root,relative);
  if(!fs.existsSync(file))fail(kind+'-artifact-missing','Missing artifact: '+relative,{artifact:relative});
  const artifact=read(file);
  if(digest(artifact)!==id||artifact.project!==PROJECT_ID||artifact.rejected||artifact.jobId!==jobId||artifact.role!==role||
    inputRevision!==undefined&&artifact.inputRevision!==inputRevision)fail(kind+'-artifact-invalid','Invalid artifact: '+relative,{artifact:relative});
  return {artifact,path:relative};
}
function approvalFor(root,update,db){
  const {approval,draft}=update;
  if(!draft||!approval||approval.role!=='verify'||approval.verdict!=='approve'||approval.draftHash!==digest(draft)||
    !validDate(update.approvedOn)||draft.cardId!==update.baseRecord?.id||digest(update.baseRecord)!==update.cardRevision)
    throw Error('Invalid journal approval: '+update.jobId);
  const saved=artifactAt(root,update.approvalArtifact,{jobId:update.jobId,role:'verify'});
  if(!equal(approvalSummary(saved.artifact.role,saved.artifact.result),approval))throw Error('Approval artifact differs from journal: '+update.jobId);
  if(!db)fail('queue-missing','Missing private queue for journal approval: '+update.jobId);
  const job=db.prepare('SELECT * FROM jobs WHERE id=?').get(update.jobId);
  if(!job||job.kind!=='review-patch'||job.state!=='done'||job.card_id!==draft.cardId||job.input_revision!==saved.artifact.inputRevision)
    fail('approval-job-missing','Missing or mismatched approval job: '+update.jobId);
  const payload=JSON.parse(job.payload);
  if(!equal(payload.draft,draft))throw Error('Approval job differs from journal draft: '+update.jobId);
  const stored=db.prepare('SELECT data FROM artifacts WHERE hash=? AND job_id=?').get(update.approvalArtifact,job.id);
  if(!stored||!equal(JSON.parse(stored.data),saved.artifact))throw Error('Approval artifact differs from queue: '+update.jobId);
  const applied=applyDraftRecord(update.baseRecord,draft,update.approvedOn);
  if(digest(applied)!==update.appliedRecordRevision||!equal(applied.research,update.research))throw Error('Applied journal record differs from approved draft: '+update.jobId);
  return {update,job,payload,approvalArtifact:saved.path};
}
// Coverage comes from the journal's field slots, independently of private proof.
export function journalFields(journal){
  const latest=new Map();
  for(const update of journal.updates.filter(update=>!update.supersededBy)){
    const {draft}=update;
    const fields=new Map([...Object.entries(draft.patch||{}),...Object.entries(draft.practicalPatch||{}).map(([key,fact])=>['practical.'+key,fact.value])]);
    for(const row of draft.reviewCoverage?.fields||[])if(!fields.has(row.field))fields.set(row.field,row.value);
    for(const [field,value] of fields)if(CLAIM_FIELDS.has(field))latest.set(draft.cardId+'\n'+field,{update,value,bindingField:
      Object.hasOwn(draft.patch||{},field)||field.startsWith('practical.')&&Object.hasOwn(draft.practicalPatch||{},field.slice(10))?field:'review.'+field});
  }
  return latest;
}
function supportedClaims(candidate,field){
  const {payload,update,bindingField}=candidate;
  const stopped=reason=>({claims:[],problem:issue(reason)});
  if(!update.approval.approvedBindings?.includes(bindingField))return stopped('binding-not-approved');
  if(bindingField.startsWith('review.')&&!update.approval.checkedCoverage?.includes(field))return stopped('coverage-not-approved');
  const coverage=bindingField.startsWith('review.')?update.draft.reviewCoverage?.fields.find(row=>row.field===field):null;
  if(bindingField.startsWith('review.')&&coverage?.outcome!=='confirmed')return stopped('coverage-not-confirmed');
  if(!bindingField.startsWith('review.')&&!update.approval.checkedFields?.includes(field))return stopped('field-not-approved');
  // Keep the earlier integrity failure even if a binding has no usable key.
  for(const claim of payload.approved||[]){
    if(claim.field!==field||claim.status!=='supported'||!claim.key||!claim.note?.trim()||
      CRITICAL_FIELDS.has(field)&&(claim.kind!=='official'||claim.scope!=='exact-card'))continue;
    validateFieldValue(field,claim.value,{allowUnknown:false});
    if(!payload.bundle?.claims?.some(item=>equal(item,claim)))fail('claim-bundle-missing','Approved claim is absent from its bundle: '+claim.key,{claimId:claim.key});
  }
  const bindings=(update.draft.bindings||[]).filter(binding=>binding.field===bindingField);
  if(!bindings.length)return stopped('binding-missing');
  if(!bindings.some(binding=>binding.claimKey))return stopped('no-claim-key');
  const claims=[];let problem=null;
  for(const binding of bindings){
    if(!binding.claimKey)continue;
    const claim=(payload.approved||[]).find(claim=>claim.key===binding.claimKey);
    const reject=reason=>{problem??=issue(reason,{claimId:binding.claimKey});};
    if(!claim){reject('claim-not-found');continue;}
    if(claim.field!==field){reject('claim-field-differs');continue;}
    if(claim.status!=='supported'||!claim.note?.trim()){reject('claim-not-supported');continue;}
    if(CRITICAL_FIELDS.has(field)&&(claim.kind!=='official'||claim.scope!=='exact-card')){reject('claim-scope-differs');continue;}
    if(binding.transformation){reject('claim-transformed');continue;}
    if(binding.source!==claim.source||binding.quote!==claim.quote||binding.snapshotId!==claim.snapshotId){reject('binding-differs');continue;}
    if(CRITICAL_FIELDS.has(field)&&(binding.kind!=='official'||binding.scope!=='exact-card')){reject('binding-scope-differs');continue;}
    if(coverage&&!coverage.snapshotIds?.includes(binding.snapshotId)){reject('coverage-snapshot-differs');continue;}
    claims.push({claim,binding});
  }
  return {claims,problem};
}
function claimsForValue(field,value,claims){
  if(field!=='events')return claims.filter(({claim})=>equal(claim.value,value)).slice(0,1);
  const chosen=new Set();
  for(const event of value){
    const found=claims.find(item=>item.claim.value.some(row=>equal(row,event)));
    if(!found)return [];
    chosen.add(found);
  }
  return [...chosen];
}
function verdictFor(root,db,candidate){
  const {payload,job}=candidate;
  const rows=db.prepare(`SELECT a.hash,a.data,j.id,j.input_revision,j.payload FROM artifacts a JOIN jobs j ON j.id=a.job_id
    WHERE j.kind='verify-facts' AND j.state='done' AND j.card_id=? AND j.created_at<=? AND a.role='verify' ORDER BY a.created_at DESC,a.hash`).all(job.card_id,job.created_at);
  for(const row of rows){
    const artifact=JSON.parse(row.data),source=JSON.parse(row.payload);
    if(artifact.rejected||!equal(source.bundle??null,payload.bundle??null)||!equal(artifact.result?.verdicts??null,payload.verdicts??null))continue;
    const saved=artifactAt(root,row.hash,{jobId:row.id,role:'verify',inputRevision:row.input_revision,kind:'verdict'});
    if(!equal(saved.artifact,artifact))throw Error('Verdict artifact differs from queue: '+saved.path);
    return saved;
  }
  fail('verdict-artifact-missing','Missing claim verdict artifact for approval: '+job.id);
}
function capturedSnapshot(db,candidate,claim){
  const stored=db.prepare('SELECT data FROM captured_evidence WHERE id=?').get(claim.snapshotId);
  if(!stored)fail('snapshot-not-registered','Missing registered snapshot: '+claim.snapshotId,{snapshotId:claim.snapshotId,claimId:claim.key});
  const evidence=JSON.parse(stored.data);validateSnapshot(evidence);
  const bound=candidate.update.draft.snapshots?.find(item=>item.id===claim.snapshotId);
  const bundled=candidate.payload.bundle.snapshots?.find(item=>item.id===claim.snapshotId);
  if(!bound||!bundled||!equal(evidence,bound)||!equal(evidence,bundled)||evidence.url!==claim.source||!locateQuote(evidence,claim.quote))
    fail('snapshot-provenance-differs','Claim quote or snapshot provenance differs: '+claim.key,{snapshotId:claim.snapshotId,claimId:claim.key});
  return evidence;
}
async function pageVersion(editorial,evidence,watch){
  const matches=[];
  for(const source of watch){
    if(!safeId(source.id)||![evidence.url,evidence.finalUrl].map(normUrl).includes(normUrl(source.url)))continue;
    const dir=path.join(editorial,'page-records',source.id);
    for(const name of fs.existsSync(dir)?fs.readdirSync(dir).filter(name=>/^[a-f0-9]{12}\.json$/.test(name)).sort():[]){
      const version=name.slice(0,12),record=await readRecord(editorial,source.id,version);
      if(!record||record.meta.source!==source.id||!hex(record.meta.hash)||!record.meta.hash.startsWith(version)||normUrl(record.meta.finalUrl)!==normUrl(evidence.finalUrl))continue;
      const sameBytes=evidence.rawHash&&record.meta.rawHash===evidence.rawHash;
      const sameText=evidence.textHash===record.meta.full?.hash||evidence.textHash===record.meta.hash;
      if(!sameBytes&&!sameText)continue;
      if(record.problems.length)throw Error('Damaged matching page record: '+source.id+'/'+version);
      matches.push({sourceId:source.id,version,match:sameBytes&&record.meta.fetchedAt===evidence.fetchedAt?'same-fetch':'same-content'});
    }
  }
  const exact=matches.filter(item=>item.match==='same-fetch'),found=exact.length?exact:matches;
  return found.length===1?found[0]:null;
}
const originCounts=()=>({verified:0,inherited:0,unknown:0});
export function ledgerCounts(cards){
  const total=originCounts(),perField=Object.fromEntries([...CLAIM_FIELDS].map(field=>[field,originCounts()]));
  const unverifiedReasons={};let journalCovered=0,journalVerified=0;
  for(const card of cards)for(const row of card.fields){
    total[row.origin]++;perField[row.field][row.origin]++;
    if(row.journalCoverage){
      journalCovered++;
      if(row.origin==='verified')journalVerified++;
      else if(row.verification)unverifiedReasons[row.verification.reason]=(unverifiedReasons[row.verification.reason]||0)+1;
    }
  }
  return {total,perField,filled:total.verified+total.inherited,journalCovered,journalVerified,journalUnverified:journalCovered-journalVerified,
    unverifiedReasons,cardsWithVerified:cards.filter(card=>card.fields.some(row=>row.origin==='verified')).map(card=>card.id)};
}
export function validateLedger(ledger,records,{journal=null}={}){
  records=json(records);
  if(ledger.schema!==1||ledger.project!==PROJECT_ID||ledger.kind!=='derived-private-fact-ledger'||!Array.isArray(ledger.cards))throw Error('Invalid fact ledger identity');
  if(ledger.complete===false)throw Error('Incomplete fact ledger; required evidence checks failed');
  if(ledger.catalogueRevision!==digest(records)||journal&&ledger.journalRevision!==digest(journal))throw Error('Stale fact ledger; regenerate it for the current catalogue and journal');
  const cards=new Map(ledger.cards.map(card=>[card.id,card]));
  const covered=journal?journalFields(journal):null;
  if(cards.size!==ledger.cards.length||cards.size!==records.length)throw Error('Ledger card identities differ from catalogue');
  for(const card of records){
    const rows=cards.get(card.id)?.fields;
    if(!Array.isArray(rows)||rows.length!==CLAIM_FIELDS.size||new Set(rows.map(row=>row.field)).size!==CLAIM_FIELDS.size)throw Error('Ledger field coverage differs: '+card.id);
    const byField=new Map(rows.map(row=>[row.field,row]));
    for(const slot of catalogueValues(card)){
      const row=byField.get(slot.field);
      if(!row||row.present!==slot.present||!equal(row.value,slot.value))throw Error('Ledger round-trip mismatch: '+card.id+'/'+slot.field);
      if(!['verified','inherited','unknown'].includes(row.origin)||unknownValue(slot.field,slot.value)!==(row.origin==='unknown'))throw Error('Invalid ledger origin: '+card.id+'/'+slot.field);
      const expected=covered?.get(card.id+'\n'+slot.field);
      if(covered&&(!!expected!==!!row.journalCoverage||expected&&!equal(row.journalCoverage,{jobId:expected.update.jobId,approvedOn:expected.update.approvedOn,bindingField:expected.bindingField})))
        throw Error('Ledger journal coverage differs: '+card.id+'/'+slot.field);
      if(row.journalCoverage&&(!row.journalCoverage.jobId||!validDate(row.journalCoverage.approvedOn)||!row.journalCoverage.bindingField))throw Error('Invalid journal coverage: '+card.id+'/'+slot.field);
      if(row.journalCoverage&&row.origin!=='verified'&&(!row.verification?.reason||row.verification.fatal!==false))throw Error('Journal-covered field lacks a nonfatal reason: '+card.id+'/'+slot.field);
      if(!row.journalCoverage&&row.verification)throw Error('Uncovered field carries a verification reason: '+card.id+'/'+slot.field);
      if(row.origin==='verified'){
        if(row.drift||!row.journalCoverage||row.verification||row.approvalJobId!==row.journalCoverage.jobId||!/^editorial\/agent-artifacts\/[a-f0-9]{64}\.json$/.test(row.approvalArtifact)||!row.evidence?.length)throw Error('Verified field lacks approval provenance: '+card.id+'/'+slot.field);
        for(const proof of row.evidence)if(!proof.claimId||!proof.jobId||!hex(proof.snapshotId)||!hex(proof.quoteDigest)||!validDate(proof.approvedOn)||
          !/^editorial\/agent-artifacts\/[a-f0-9]{64}\.json$/.test(proof.verdictArtifact)||typeof proof.sourceUrl!=='string')throw Error('Verified field lacks claim provenance: '+card.id+'/'+slot.field);
      }
    }
  }
  if(!equal(ledger.counts,ledgerCounts(ledger.cards)))throw Error('Ledger counts differ from field origins');
  return ledger;
}
export async function buildLedger({root=workspace,generatedAt=new Date().toISOString()}={}){
  const editorial=path.join(root,'editorial'),records=json(loadCatalog({base:root}).ACTIVITIES);
  const journal=read(path.join(editorial,'approved-updates.json'));
  if(journal.schema!==1||journal.project!==PROJECT_ID||!Array.isArray(journal.updates))throw Error('Wrong approval journal identity');
  const ids=new Set(records.map(card=>card.id));
  if(ids.size!==records.length||records.some(card=>!safeId(card.id)))throw Error('Invalid catalogue card identities');
  if(new Set(journal.updates.map(update=>update.jobId)).size!==journal.updates.length||journal.updates.some(update=>!ids.has(update.draft?.cardId)))throw Error('Invalid journal card or job identities');
  let db=null,queueError=null;
  try{db=openQueue(root);}catch(error){queueError=error;}
  try{
    const updates=journal.updates.filter(update=>!update.supersededBy);
    const latest=journalFields(journal),approvals=new Map(),cards=[],drift=[],failures=[];
    const remember=(error,reason)=>{
      error.verification??=issue(reason,{fatal:true});failures.push(error);return error;
    };
    if(queueError)remember(queueError,'queue-not-readable');
    for(const update of updates){
      try{approvals.set(update.jobId,queueError?{error:queueError}:approvalFor(root,update,db));}
      catch(error){approvals.set(update.jobId,{error:remember(error,'approval-invalid')});}
    }
    const watchFile=path.join(editorial,'source-watch.json'),watch=fs.existsSync(watchFile)?read(watchFile).sources||[]:[];
    const pageCache=new Map(),verdictCache=new Map();
    for(const card of records){
      const fields=[];
      for(const slot of catalogueValues(card)){
        const row={...slot,origin:unknownValue(slot.field,slot.value)?'unknown':'inherited'},candidate=latest.get(card.id+'\n'+slot.field);
        if(candidate)row.journalCoverage={jobId:candidate.update.jobId,approvedOn:candidate.update.approvedOn,bindingField:candidate.bindingField};
        if(candidate&&!equal(slot.value,candidate.value??null)){
          row.drift=true;drift.push({cardId:card.id,field:slot.field,approvalJobId:candidate.update.jobId,approvedOn:candidate.update.approvedOn,
            approvedValue:json(candidate.value??null),currentValue:slot.value});
        }
        if(candidate){
          const approval=approvals.get(candidate.update.jobId);
          if(approval.error)row.verification=approval.error.verification;
          else if(row.drift)row.verification=issue('value-differs',{comparedWith:'journal'});
          else if(row.origin==='unknown')row.verification=issue('unknown-value');
          else try{
            Object.assign(candidate,approval);
            const supported=supportedClaims(candidate,slot.field),claims=claimsForValue(slot.field,slot.value,supported.claims);
            if(!claims.length){row.verification=supported.problem||issue('value-differs',{comparedWith:'claim'});fields.push(row);continue;}
            validateFieldValue(slot.field,slot.value,{allowUnknown:false});
            if(!verdictCache.has(candidate.job.id))verdictCache.set(candidate.job.id,verdictFor(root,db,candidate));
            const verdict=verdictCache.get(candidate.job.id),evidence=[];
            for(const {claim} of claims){
              if(!verdict.artifact.result.verdicts.some(row=>row.key===claim.key&&row.verdict==='approve'&&row.reason?.trim()))
                fail('claim-verdict-not-approved','Claim lacks an approving verdict: '+claim.key,{claimId:claim.key});
              const captured=capturedSnapshot(db,candidate,claim);
              if(!pageCache.has(captured.id))pageCache.set(captured.id,await pageVersion(editorial,captured,watch));
              const pageRecord=pageCache.get(captured.id);
              evidence.push({claimId:claim.key,jobId:verdict.artifact.jobId,verdictArtifact:verdict.path,snapshotId:captured.id,sourceUrl:claim.source,
                pageRecordVersion:pageRecord?.version??null,pageRecord,quoteDigest:hash(normalizeQuote(claim.quote)),approvedOn:candidate.update.approvedOn});
            }
            Object.assign(row,evidence[0],{origin:'verified',approvalJobId:candidate.job.id,approvalArtifact:candidate.approvalArtifact,evidence});
          }catch(error){row.verification=remember(error,'evidence-invalid').verification;}
        }
        fields.push(row);
      }
      cards.push({id:card.id,fields});
    }
    const ledger={schema:1,project:PROJECT_ID,kind:'derived-private-fact-ledger',complete:!failures.length,generatedAt,catalogueRevision:digest(records),journalRevision:digest(journal),
      cards,counts:ledgerCounts(cards),drift};
    if(failures.length){const error=Error(failures[0].message);error.ledger=ledger;throw error;}
    return validateLedger(ledger,records,{journal});
  }finally{db?.close();}
}
export function summaryMarkdown(ledger){
  const lines=['# Private fact provenance','',`Catalogue ${ledger.catalogueRevision}; generated ${ledger.generatedAt}.`,
    'Derived from the compiled catalogue and approval evidence. Inherited does not mean incorrect; verified describes the recorded pipeline approval, not current availability.','',
    '| Field | Verified | Inherited | Unknown |','| --- | ---: | ---: | ---: |',
    ...Object.entries(ledger.counts.perField).map(([field,n])=>`| ${field} | ${n.verified} | ${n.inherited} | ${n.unknown} |`),'',
    `Filled values: ${ledger.counts.filled}; journal-covered: ${ledger.counts.journalCovered}; verified among covered: ${ledger.counts.journalVerified}; unverified among covered: ${ledger.counts.journalUnverified}; inherited: ${ledger.counts.total.inherited}.`,
    'Coverage counts the latest nonsuperseded journal entry for each claimable card field, independently of verification.','',
    '## Journal-covered fields without verification','',
    '| First missing link | Fields |','| --- | ---: |',...Object.entries(ledger.counts.unverifiedReasons).map(([reason,n])=>`| ${reason} | ${n} |`),
    ...unverifiedFields(ledger).map(row=>`- ${row.cardId}: ${row.field} — ${row.reason}${row.fatal?' (required input failed)':''} (approval ${row.jobId})`),'',
    '## Per card','',...ledger.cards.map(card=>{const n=originCounts();for(const row of card.fields)n[row.origin]++;
      return `- ${card.id}: verified ${n.verified}, inherited ${n.inherited}, unknown ${n.unknown}`;}),'',
    '## Cards with a verified field','',...(ledger.counts.cardsWithVerified.length?ledger.counts.cardsWithVerified.map(id=>'- '+id):['None.']),'',
    '## Values changed after approval','',...(ledger.drift.length?ledger.drift.map(row=>`- ${row.cardId}: ${row.field} (approval ${row.approvalJobId}, ${row.approvedOn})`):['None.']),''];
  return lines.join('\n');
}
export function writeLedger(ledger,out){
  if(ledger.complete===false)throw Error('Cannot write an incomplete fact ledger');
  fs.mkdirSync(out,{recursive:true,mode:0o700});
  if(fs.lstatSync(out).isSymbolicLink()||fs.statSync(out).mode&0o077)throw Error('Ledger output directory must be private (mode 0700), not a symlink');
  for(const [name,text] of [['ledger.json',JSON.stringify(ledger,null,2)+'\n'],['summary.md',summaryMarkdown(ledger)]]){
    const temporary=path.join(out,name+'.tmp-'+process.pid);
    try{fs.writeFileSync(temporary,text,{mode:0o600,flag:'wx'});fs.renameSync(temporary,path.join(out,name));}
    finally{fs.rmSync(temporary,{force:true});}
  }
}
export function unverifiedFields(ledger){
  return ledger.cards.flatMap(card=>card.fields.filter(row=>row.journalCoverage&&row.origin!=='verified').map(row=>({cardId:card.id,field:row.field,
    ...row.journalCoverage,...row.verification})));
}
const consoleSummary=ledger=>({complete:ledger.complete,cards:ledger.cards.length,...ledger.counts,drift:ledger.drift.length,unverifiedFields:unverifiedFields(ledger)});
export async function main(argv=process.argv.slice(2),{log=console.log}={}){
  try{
    const options=parseArgs(argv),ledger=await buildLedger(options);
    if(!options.dryRun)writeLedger(ledger,options.out);
    log(JSON.stringify({dryRun:options.dryRun,...consoleSummary(ledger),...(!options.dryRun&&{out:options.out})}));
    return {code:0,ledger};
  }catch(error){
    log('Fact ledger failed: '+error.message);
    if(error.ledger)log(JSON.stringify(consoleSummary(error.ledger)));
    return {code:1,...(error.ledger&&{ledger:error.ledger})};
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=(await main()).code;
