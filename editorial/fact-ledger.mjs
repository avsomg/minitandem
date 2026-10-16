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
function artifactAt(root,id,{jobId,role,inputRevision}={}){
  if(!hex(id))throw Error('Invalid artifact digest');
  const relative='editorial/agent-artifacts/'+id+'.json',file=path.join(root,relative);
  if(!fs.existsSync(file))throw Error('Missing artifact: '+relative);
  const artifact=read(file);
  if(digest(artifact)!==id||artifact.project!==PROJECT_ID||artifact.rejected||artifact.jobId!==jobId||artifact.role!==role||
    inputRevision!==undefined&&artifact.inputRevision!==inputRevision)throw Error('Invalid artifact: '+relative);
  return {artifact,path:relative};
}
function approvalFor(root,update,db){
  const {approval,draft}=update;
  if(!draft||!approval||approval.role!=='verify'||approval.verdict!=='approve'||approval.draftHash!==digest(draft)||
    !validDate(update.approvedOn)||draft.cardId!==update.baseRecord?.id||digest(update.baseRecord)!==update.cardRevision)
    throw Error('Invalid journal approval: '+update.jobId);
  const saved=artifactAt(root,update.approvalArtifact,{jobId:update.jobId,role:'verify'});
  if(!equal(approvalSummary(saved.artifact.role,saved.artifact.result),approval))throw Error('Approval artifact differs from journal: '+update.jobId);
  if(!db)throw Error('Missing private queue for journal approval: '+update.jobId);
  const job=db.prepare('SELECT * FROM jobs WHERE id=?').get(update.jobId);
  if(!job||job.kind!=='review-patch'||job.state!=='done'||job.card_id!==draft.cardId||job.input_revision!==saved.artifact.inputRevision)
    throw Error('Missing or mismatched approval job: '+update.jobId);
  const payload=JSON.parse(job.payload);
  if(!equal(payload.draft,draft))throw Error('Approval job differs from journal draft: '+update.jobId);
  const stored=db.prepare('SELECT data FROM artifacts WHERE hash=? AND job_id=?').get(update.approvalArtifact,job.id);
  if(!stored||!equal(JSON.parse(stored.data),saved.artifact))throw Error('Approval artifact differs from queue: '+update.jobId);
  const applied=applyDraftRecord(update.baseRecord,draft,update.approvedOn);
  if(digest(applied)!==update.appliedRecordRevision||!equal(applied.research,update.research))throw Error('Applied journal record differs from approved draft: '+update.jobId);
  return {update,job,payload,approvalArtifact:saved.path};
}
function latestFields(approvals){
  const latest=new Map();
  for(const approval of approvals){
    const {draft}=approval.update;
    const fields=new Map([...Object.entries(draft.patch||{}),...Object.entries(draft.practicalPatch||{}).map(([key,fact])=>['practical.'+key,fact.value])]);
    for(const row of draft.reviewCoverage?.fields||[])if(!fields.has(row.field))fields.set(row.field,row.value);
    for(const [field,value] of fields)if(CLAIM_FIELDS.has(field))latest.set(draft.cardId+'\n'+field,{...approval,value,bindingField:
      Object.hasOwn(draft.patch||{},field)||field.startsWith('practical.')&&Object.hasOwn(draft.practicalPatch||{},field.slice(10))?field:'review.'+field});
  }
  return latest;
}
function supportedClaims(candidate,field){
  const {payload,update,bindingField}=candidate;
  if(!update.approval.approvedBindings?.includes(bindingField))return [];
  if(bindingField.startsWith('review.')&&!update.approval.checkedCoverage?.includes(field))return [];
  const coverage=bindingField.startsWith('review.')?update.draft.reviewCoverage?.fields.find(row=>row.field===field):null;
  if(bindingField.startsWith('review.')&&coverage?.outcome!=='confirmed')return [];
  if(!bindingField.startsWith('review.')&&!update.approval.checkedFields?.includes(field))return [];
  return (payload.approved||[]).flatMap(claim=>{
    if(claim.field!==field||claim.status!=='supported'||!claim.key||!claim.note?.trim())return [];
    if(CRITICAL_FIELDS.has(field)&&(claim.kind!=='official'||claim.scope!=='exact-card'))return [];
    validateFieldValue(field,claim.value,{allowUnknown:false});
    if(!payload.bundle?.claims?.some(item=>equal(item,claim)))throw Error('Approved claim is absent from its bundle: '+claim.key);
    const binding=(update.draft.bindings||[]).find(b=>b.field===bindingField&&b.claimKey===claim.key&&b.source===claim.source&&
      b.quote===claim.quote&&b.snapshotId===claim.snapshotId&&!b.transformation);
    if(binding&&(CRITICAL_FIELDS.has(field)&&(binding.kind!=='official'||binding.scope!=='exact-card')||coverage&&!coverage.snapshotIds?.includes(binding.snapshotId)))return [];
    return binding?[{claim,binding}]:[];
  });
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
    const saved=artifactAt(root,row.hash,{jobId:row.id,role:'verify',inputRevision:row.input_revision});
    if(!equal(saved.artifact,artifact))throw Error('Verdict artifact differs from queue: '+saved.path);
    return saved;
  }
  throw Error('Missing claim verdict artifact for approval: '+job.id);
}
function capturedSnapshot(db,candidate,claim){
  const stored=db.prepare('SELECT data FROM captured_evidence WHERE id=?').get(claim.snapshotId);
  if(!stored)throw Error('Missing registered snapshot: '+claim.snapshotId);
  const evidence=JSON.parse(stored.data);validateSnapshot(evidence);
  const bound=candidate.update.draft.snapshots?.find(item=>item.id===claim.snapshotId);
  const bundled=candidate.payload.bundle.snapshots?.find(item=>item.id===claim.snapshotId);
  if(!bound||!bundled||!equal(evidence,bound)||!equal(evidence,bundled)||evidence.url!==claim.source||!locateQuote(evidence,claim.quote))
    throw Error('Claim quote or snapshot provenance differs: '+claim.key);
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
  for(const card of cards)for(const row of card.fields){total[row.origin]++;perField[row.field][row.origin]++;}
  return {total,perField,filled:total.verified+total.inherited,journalCovered:total.verified,cardsWithVerified:cards.filter(card=>card.fields.some(row=>row.origin==='verified')).map(card=>card.id)};
}
export function validateLedger(ledger,records,{journal=null}={}){
  records=json(records);
  if(ledger.schema!==1||ledger.project!==PROJECT_ID||ledger.kind!=='derived-private-fact-ledger'||!Array.isArray(ledger.cards))throw Error('Invalid fact ledger identity');
  if(ledger.catalogueRevision!==digest(records)||journal&&ledger.journalRevision!==digest(journal))throw Error('Stale fact ledger; regenerate it for the current catalogue and journal');
  const cards=new Map(ledger.cards.map(card=>[card.id,card]));
  if(cards.size!==ledger.cards.length||cards.size!==records.length)throw Error('Ledger card identities differ from catalogue');
  for(const card of records){
    const rows=cards.get(card.id)?.fields;
    if(!Array.isArray(rows)||rows.length!==CLAIM_FIELDS.size||new Set(rows.map(row=>row.field)).size!==CLAIM_FIELDS.size)throw Error('Ledger field coverage differs: '+card.id);
    const byField=new Map(rows.map(row=>[row.field,row]));
    for(const slot of catalogueValues(card)){
      const row=byField.get(slot.field);
      if(!row||row.present!==slot.present||!equal(row.value,slot.value))throw Error('Ledger round-trip mismatch: '+card.id+'/'+slot.field);
      if(!['verified','inherited','unknown'].includes(row.origin)||unknownValue(slot.field,slot.value)!==(row.origin==='unknown'))throw Error('Invalid ledger origin: '+card.id+'/'+slot.field);
      if(row.origin==='verified'){
        if(row.drift||!row.approvalJobId||!/^editorial\/agent-artifacts\/[a-f0-9]{64}\.json$/.test(row.approvalArtifact)||!row.evidence?.length)throw Error('Verified field lacks approval provenance: '+card.id+'/'+slot.field);
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
  const db=openQueue(root);
  try{
    const updates=journal.updates.filter(update=>!update.supersededBy);
    const approvals=updates.map(update=>approvalFor(root,update,db)),latest=latestFields(approvals),cards=[],drift=[];
    const watchFile=path.join(editorial,'source-watch.json'),watch=fs.existsSync(watchFile)?read(watchFile).sources||[]:[];
    const pageCache=new Map(),verdictCache=new Map();
    for(const card of records){
      const fields=[];
      for(const slot of catalogueValues(card)){
        const row={...slot,origin:unknownValue(slot.field,slot.value)?'unknown':'inherited'},candidate=latest.get(card.id+'\n'+slot.field);
        if(candidate&&!equal(slot.value,candidate.value??null)){
          row.drift=true;drift.push({cardId:card.id,field:slot.field,approvalJobId:candidate.job.id,approvedOn:candidate.update.approvedOn,
            approvedValue:json(candidate.value??null),currentValue:slot.value});
        }else if(candidate&&row.origin!=='unknown'){
          const claims=claimsForValue(slot.field,slot.value,supportedClaims(candidate,slot.field));
          if(claims.length){
            validateFieldValue(slot.field,slot.value,{allowUnknown:false});
            if(!verdictCache.has(candidate.job.id))verdictCache.set(candidate.job.id,verdictFor(root,db,candidate));
            const verdict=verdictCache.get(candidate.job.id),evidence=[];
            for(const {claim} of claims){
              if(!verdict.artifact.result.verdicts.some(row=>row.key===claim.key&&row.verdict==='approve'&&row.reason?.trim()))
                throw Error('Claim lacks an approving verdict: '+claim.key);
              const captured=capturedSnapshot(db,candidate,claim);
              if(!pageCache.has(captured.id))pageCache.set(captured.id,await pageVersion(editorial,captured,watch));
              const pageRecord=pageCache.get(captured.id);
              evidence.push({claimId:claim.key,jobId:verdict.artifact.jobId,verdictArtifact:verdict.path,snapshotId:captured.id,sourceUrl:claim.source,
                pageRecordVersion:pageRecord?.version??null,pageRecord,quoteDigest:hash(normalizeQuote(claim.quote)),approvedOn:candidate.update.approvedOn});
            }
            Object.assign(row,evidence[0],{origin:'verified',approvalJobId:candidate.job.id,approvalArtifact:candidate.approvalArtifact,evidence});
          }
        }
        fields.push(row);
      }
      cards.push({id:card.id,fields});
    }
    return validateLedger({schema:1,project:PROJECT_ID,kind:'derived-private-fact-ledger',generatedAt,catalogueRevision:digest(records),journalRevision:digest(journal),
      cards,counts:ledgerCounts(cards),drift},records,{journal});
  }finally{db?.close();}
}
export function summaryMarkdown(ledger){
  const lines=['# Private fact provenance','',`Catalogue ${ledger.catalogueRevision}; generated ${ledger.generatedAt}.`,
    'Derived from the compiled catalogue and approval evidence. Inherited does not mean incorrect; verified describes the recorded pipeline approval, not current availability.','',
    '| Field | Verified | Inherited | Unknown |','| --- | ---: | ---: | ---: |',
    ...Object.entries(ledger.counts.perField).map(([field,n])=>`| ${field} | ${n.verified} | ${n.inherited} | ${n.unknown} |`),'',
    `Filled values: ${ledger.counts.filled}; journal-covered: ${ledger.counts.journalCovered}; inherited: ${ledger.counts.total.inherited}.`,'',
    '## Per card','',...ledger.cards.map(card=>{const n=originCounts();for(const row of card.fields)n[row.origin]++;
      return `- ${card.id}: verified ${n.verified}, inherited ${n.inherited}, unknown ${n.unknown}`;}),'',
    '## Cards with a verified field','',...(ledger.counts.cardsWithVerified.length?ledger.counts.cardsWithVerified.map(id=>'- '+id):['None.']),'',
    '## Values changed after approval','',...(ledger.drift.length?ledger.drift.map(row=>`- ${row.cardId}: ${row.field} (approval ${row.approvalJobId}, ${row.approvedOn})`):['None.']),''];
  return lines.join('\n');
}
export function writeLedger(ledger,out){
  fs.mkdirSync(out,{recursive:true,mode:0o700});
  if(fs.lstatSync(out).isSymbolicLink()||fs.statSync(out).mode&0o077)throw Error('Ledger output directory must be private (mode 0700), not a symlink');
  for(const [name,text] of [['ledger.json',JSON.stringify(ledger,null,2)+'\n'],['summary.md',summaryMarkdown(ledger)]]){
    const temporary=path.join(out,name+'.tmp-'+process.pid);
    try{fs.writeFileSync(temporary,text,{mode:0o600,flag:'wx'});fs.renameSync(temporary,path.join(out,name));}
    finally{fs.rmSync(temporary,{force:true});}
  }
}
export async function main(argv=process.argv.slice(2),{log=console.log}={}){
  try{
    const options=parseArgs(argv),ledger=await buildLedger(options);
    if(!options.dryRun)writeLedger(ledger,options.out);
    log(JSON.stringify({dryRun:options.dryRun,cards:ledger.cards.length,...ledger.counts,drift:ledger.drift.length,...(!options.dryRun&&{out:options.out})}));
    return {code:0,ledger};
  }catch(error){log('Fact ledger failed: '+error.message);return {code:1};}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=(await main()).code;
