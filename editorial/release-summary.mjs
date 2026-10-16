// Owner-facing evidence of what is approved locally. This report never authorises or performs publication.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {JobQueue,digest} from './jobs.mjs';
import {loadCatalog,root} from './quality.mjs';
import {publicManifest} from './agent-run.mjs';
import {assertReleaseCurrent,sourceRevision} from './release.mjs';
import {publicUrl} from './evidence.mjs';
import {PROJECT_ID} from './project-id.mjs';

const read=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;
const safe=value=>String(value??'unknown').replace(/\/(?:Users|home)\/[^\s"<>]+|\/private\/(?:tmp|var)\/[^\s"<>]+/g,'[private path removed]')
  .replace(/(?:sk-(?:ant-|proj-)?|ghp_)[A-Za-z0-9_-]{20,}/g,'[credential removed]').replace(/[\r\n]+/g,' ').replace(/[<>`]/g,'').slice(0,260);
const display=value=>value===undefined||value===null?'unknown':safe(typeof value==='object'?JSON.stringify(value):value);
const labels={min:'minimum age',max:'maximum age',parent:'adult participation',priceKind:'price type',amount:'published amount',days:'weekday facet',events:'published sessions',scheduleValidThrough:'schedule valid through',checked:'full review date'};
const source=value=>{try{return publicUrl(value);}catch{return null;}};
export function releaseSummary({journal,qa=null,qaCurrent=false,buildInfo=null,stale={de:[],fr:[]},generatedOn=new Date().toISOString().slice(0,10)}){
  if(journal?.schema!==1||journal.project!==PROJECT_ID||!Array.isArray(journal.updates))throw Error('Wrong release-summary journal');
  const updates=journal.updates.filter(update=>!update.supersededBy),checks=qaCurrent?(qa?.checks||[]):[];
  const lines=['# Release summary',`Generated: ${safe(generatedOn)}. Publication needs the owner\'s explicit approval.`,
    'Scope: all current approved journal entries. The deployed baseline is not recorded here; this is not a claim that every entry is new since the live version.',
    `Build: ${safe(buildInfo?.revision||'not built')}; ${buildInfo?.records??'unknown'} records.`,
    `QA: ${qaCurrent?'current receipt matches the public files and source version':qa?'receipt is stale or incomplete; run QA again':'no QA receipt; run QA before publication'}.`,
    `Checks passed for this version: ${checks.map(safe).join(', ')||'none established'}.`,
    `German needs translation: ${stale.de.map(safe).join(', ')||'none'}. French needs translation: ${stale.fr.map(safe).join(', ')||'none'}.`,''];
  if(!updates.length)lines.push('No approved journal changes.');
  for(const update of updates){
    const draft=update.draft,base=update.baseRecord||{},after={...base,...draft.patch,practical:{...base.practical,...draft.practicalPatch}};
    lines.push(`## ${safe(base.name||draft.cardId)} (${safe(draft.cardId)})`);
    const changes=[];
    for(const [field,value] of Object.entries(draft.patch||{}))if(digest(base[field]??null)!==digest(value))
      changes.push(field==='contacts'?'organisation contacts changed':`${safe(labels[field]||field)}: ${display(base[field])} → ${display(value)}`);
    for(const [field,fact] of Object.entries(draft.practicalPatch||{}))if(digest(base.practical?.[field]??null)!==digest(fact))
      changes.push(`${safe(field)}: ${display(base.practical?.[field]?.value)} → ${display(fact?.value)}`);
    if(draft.warnings)changes.push('practical warnings reviewed');
    lines.push(`Changes: ${changes.join('; ')||'research evidence and open questions updated'}.`);
    const urls=[...new Set([...(draft.findings||[]).map(row=>source(row.url)),...(draft.bindings||[]).map(row=>source(row.source))].filter(Boolean))];
    lines.push(`Why: ${safe(draft.findings?.[0]?.text||'independent review approved this change')}`,
      `Sources: ${urls.map(safe).join(', ')||'not supplied'}. Approved: ${safe(update.approvedOn)}.`);
    const unknown=[];
    if(after.min==null&&after.max==null&&!after.ageException)unknown.push('age');
    if(after.parent==='unknown')unknown.push('adult participation');
    if(!after.languages?.length&&after.format!=='self')unknown.push('session language');
    if(after.priceKind==='unknown')unknown.push('price');
    if(after.practical?.booking?.value==null&&after.format!=='self')unknown.push('advance registration');
    lines.push(`Still unknown: ${unknown.join(', ')||'no additional unknown primary fields identified'}.`);
    const questions=[...new Set([...(base.research?.remaining||[]).filter(question=>!draft.resolvedQuestions?.some(row=>row.question===question)),...(draft.remaining||[])])];
    if(questions.length)lines.push(`Open questions: ${questions.map(safe).join('; ')}.`);
    lines.push(`Checks: independent patch approval ${safe(update.approval?.verdict||'not recorded')}; QA ${qaCurrent?'passed for this version':'not current'}.`,
      `Translations: German ${stale.de.includes(draft.cardId)?'needs update':'current'}; French ${stale.fr.includes(draft.cardId)?'needs update':'current'}.`,'');
  }
  return lines.join('\n')+'\n';
}
export function staleTranslations(base,records){
  const context={window:{},structuredClone,TextEncoder};vm.createContext(context);
  for(const file of ['catalogue-i18n.js','views.js','data-de.js','data-fr.js'])vm.runInContext(fs.readFileSync(path.join(base,file),'utf8'),context,{filename:file});
  const helper=context.window.MinitandemCatalogueI18n,order=context.window.MinitandemViews.PRACTICAL_ORDER;
  return Object.fromEntries(['de','fr'].map(lang=>{
    const result=helper.overlay(records,context.window.MINITANDEM_CARDS?.[lang],order);
    return [lang,[...result.stale,...result.missing]];
  }));
}
export function writeReleaseSummary(base=root){
  const journal=read(path.join(base,'editorial','approved-updates.json'),null),buildInfo=read(path.join(base,'.publish','build-info.json'),null);
  const records=loadCatalog({base}).ACTIVITIES,stale=staleTranslations(base,records),queueFile=path.join(base,'editorial','workflow-state','jobs.sqlite');
  let qa=null,qaCurrent=false;
  if(fs.existsSync(queueFile)){
    const queue=new JobQueue(queueFile,{readOnly:true});
    try{const row=queue.db.prepare("SELECT manifest FROM releases ORDER BY created_at DESC LIMIT 1").get();qa=row?JSON.parse(row.manifest):null;}
    finally{queue.close();}
  }
  try{if(buildInfo&&qa){assertReleaseCurrent(qa,{manifest:publicManifest(path.join(base,'.publish')),source:sourceRevision(base)});
    qaCurrent=['public-audit','public-scan'].every(check=>qa.checks.includes(check));}}
  catch{qaCurrent=false;}
  const text=releaseSummary({journal,qa,qaCurrent,buildInfo,stale}),file=path.join(base,'editorial','workflow-state','release-summary.md');
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.tmp-'+process.pid;
  try{fs.writeFileSync(temporary,text,{mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
  return {file:'editorial/workflow-state/release-summary.md',changes:journal.updates.filter(update=>!update.supersededBy).length,qaCurrent,stale};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(writeReleaseSummary(),null,2));
