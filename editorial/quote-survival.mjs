// Quote survival: is a quote that was approved for a card still found in the stored copy of its source page? A read-only report.
// It is the zero-token recheck of a fact: quote still there, the fact is untouched by the page; quote gone, look at that fact only.
//
// node editorial/quote-survival.mjs [--root=DIR] [--json] [--misses]
//
// Approved quotes: the claims a verify-facts verdict approved (agent-artifacts, quote and source from the search bundle) and the bindings of
// the approval journal. One claim is one (field, source, quote). Stored copy: what the source monitor keeps for the pages it watches
// (editorial/versions/); the latest version is the one monitor-state.json points to. A quote counts as found when its whitespace-normalised
// form is part of the whitespace-normalised text (the rule of locateQuote). A quote that is not found is put in one of three classes:
//   page-changed          an older stored version of the page has it, the latest does not (or the raw hashes of the two fetches differ)
//   extraction-difference no stored version has it although the page may be unchanged: the monitor and the controller read it differently
//   no-stored-version     the page is not watched, or the monitor has no readable copy of it
// --root=DIR reads another checkout (the main one from a worktree). Nothing is written. The report names sources and fields, never quotes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {normalizeQuote} from './evidence.mjs';
import {normUrl} from './monitor.mjs';

export const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const readJson=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
const count=(list,pick)=>list.reduce((tally,item)=>{const key=pick(item);tally[key]=(tally[key]||0)+1;return tally;},{});

export function parseArgs(argv){
  const given={root:workspace,json:false,misses:false};
  for(const arg of argv){
    const match=/^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if(!match)throw Error(`Unknown argument: ${arg}`);
    const [,name,value]=match;
    if(name==='root'&&value)given.root=path.resolve(value);
    else if((name==='json'||name==='misses')&&value===undefined)given[name]=true;
    else throw Error(`Unknown or incomplete option: ${arg}`);
  }
  return given;
}

// ---------------------------------------------------------------- the approved quotes
// Every (field, source, quote) that a verifier approved or the journal bound, with the snapshot it was taken from.
export function approvedQuotes(root){
  const editorial=path.join(root,'editorial'),directory=path.join(editorial,'agent-artifacts');
  const claims=new Map(),snapshots=new Map(),approved=new Set();
  let unreadable=0;
  for(const name of fs.existsSync(directory)?fs.readdirSync(directory).filter(file=>file.endsWith('.json')).sort():[]){
    const artifact=readJson(path.join(directory,name),null);
    if(!artifact?.result){unreadable++;continue;}
    if(artifact.role==='search'&&artifact.result.bundle){
      const bundle=artifact.result.bundle;
      for(const snapshot of bundle.snapshots||[])snapshots.set(snapshot.id,snapshot);
      for(const claim of bundle.claims||[])if(claim.key&&!claims.has(claim.key))claims.set(claim.key,{...claim,cardId:bundle.cardId});
    }
    if(artifact.role==='verify'&&Array.isArray(artifact.result.verdicts))
      for(const verdict of artifact.result.verdicts)if(verdict.verdict==='approve')approved.add(verdict.key);
  }
  const units=new Map(),unresolved=[];
  const add=(origin,{field,source,quote,cardId,snapshot})=>{
    if(!field||!source||typeof quote!=='string'||!normalizeQuote(quote))return;
    const key=sha(JSON.stringify([field,source,normalizeQuote(quote)]));
    const unit=units.get(key)??{field,source,quote,cardIds:new Set(),origins:new Set(),snapshots:[]};
    unit.origins.add(origin);if(cardId)unit.cardIds.add(cardId);
    if(snapshot&&!unit.snapshots.some(item=>item.id===snapshot.id))unit.snapshots.push(snapshot);
    units.set(key,unit);
  };
  for(const key of approved){
    const claim=claims.get(key);
    if(!claim){unresolved.push(key);continue;}
    if(claim.status==='supported')add('verify',{...claim,snapshot:snapshots.get(claim.snapshotId)});
  }
  const journal=readJson(path.join(editorial,'approved-updates.json'),{updates:[]});
  for(const update of journal.updates||[]){
    const draft=update.draft||{},byId=new Map((draft.snapshots||[]).map(snapshot=>[snapshot.id,snapshot]));
    for(const binding of draft.bindings||[])add('journal',{...binding,cardId:draft.cardId,snapshot:byId.get(binding.snapshotId)});
  }
  return {units:[...units.values()].map(unit=>({...unit,cardIds:[...unit.cardIds],origins:[...unit.origins]})),unresolved:unresolved.length,unreadable};
}

// ---------------------------------------------------------------- the stored copies
const versionFile=(editorial,id,version)=>path.join(editorial,'versions',id,version+'.txt');
const readText=file=>{try{return fs.readFileSync(file,'utf8').replace(/\n$/,'');}catch{return null;}};

// What the monitor keeps for one watched source: the text of the latest version, the texts of older ones.
export function storedCopy(editorial,source,entry){
  const copy={sourceId:source.id,type:source.type,latest:null,older:[],problem:null};
  if(!entry?.hash||!entry.lastSuccess){copy.problem='no-baseline';return copy;}
  const text=readText(versionFile(editorial,source.id,entry.hash.slice(0,12)));
  if(text==null)copy.problem='file-missing';
  else if(sha(text)!==entry.hash)copy.problem='hash-mismatch';
  else copy.latest={views:{monitor:text},fetchedAt:entry.lastSuccess,finalUrl:entry.finalUrl||source.url,rawHash:null};
  const directory=path.join(editorial,'versions',source.id);
  for(const name of fs.existsSync(directory)?fs.readdirSync(directory).filter(file=>/^[0-9a-f]{12}\.txt$/.test(file)):[]){
    if(name===entry.hash.slice(0,12)+'.txt')continue;
    const old=readText(path.join(directory,name));if(old!=null)copy.older.push(old);
  }
  return copy;
}

// The watched sources that can hold a claim's page: same address (or the address the monitor ended up on), preferably the card's own.
export function candidateSources(sources,state,unit){
  const wanted=normUrl(unit.source);
  const same=sources.filter(source=>normUrl(source.url)===wanted||state[source.id]?.finalUrlNorm===wanted);
  const own=same.filter(source=>(source.recordIds||[]).some(id=>unit.cardIds.includes(id)));
  return own.length?own:same;
}

const found=(text,quote)=>normalizeQuote(text).includes(normalizeQuote(quote));

// One claim against the stored copies of its page.
export function judgeQuote(unit,copies){
  const snapshot=unit.snapshots[0]??null;
  const usable=copies.filter(copy=>copy.latest);
  const base={field:unit.field,source:unit.source,origins:unit.origins,snapshotParser:snapshot?.parser??null,sourceIds:copies.map(copy=>copy.sourceId)};
  if(!copies.length)return {...base,found:false,reason:'no-stored-version',detail:'not-watched'};
  if(!usable.length)return {...base,found:false,reason:'no-stored-version',detail:copies.map(copy=>copy.problem).find(Boolean)||'no-baseline'};
  const views=[];
  for(const copy of usable)for(const [name,text] of Object.entries(copy.latest.views))if(found(text,unit.quote))views.push(name);
  if(views.length)return {...base,found:true,views:[...new Set(views)]};
  const changedBytes=snapshot?.rawHash&&usable.every(copy=>copy.latest.rawHash&&copy.latest.rawHash!==snapshot.rawHash);
  const earlier=usable.some(copy=>copy.older.some(text=>found(text,unit.quote)));
  return {...base,found:false,reason:earlier||changedBytes?'page-changed':'extraction-difference',detail:earlier?'older-version':changedBytes?'raw-hash':'same-or-unknown'};
}

export function survivalReport(root){
  const editorial=path.join(root,'editorial');
  const watch=readJson(path.join(editorial,'source-watch.json'),{sources:[]}).sources||[];
  const state=readJson(path.join(editorial,'monitor-state.json'),{sources:{}}).sources||{};
  const {units,unresolved,unreadable}=approvedQuotes(root);
  const copies=new Map();
  const copyOf=source=>{if(!copies.has(source.id))copies.set(source.id,storedCopy(editorial,source,state[source.id]));return copies.get(source.id);};
  const rows=units.map(unit=>judgeQuote(unit,candidateSources(watch,state,unit).map(copyOf)));
  const missed=rows.filter(row=>!row.found);
  const quotes=new Set(units.map(unit=>unit.source+'\n'+normalizeQuote(unit.quote)));
  return {root,claims:rows.length,distinctQuotes:quotes.size,unresolvedVerdicts:unresolved,unreadableArtifacts:unreadable,
    found:rows.length-missed.length,missed:missed.length,
    byReason:count(missed,row=>row.reason),byDetail:count(missed,row=>`${row.reason}/${row.detail}`),
    foundIn:count(rows.filter(row=>row.found).flatMap(row=>row.views),view=>view),
    bySnapshotParser:Object.fromEntries(Object.entries(count(rows,row=>row.snapshotParser||'none')).map(([parser,total])=>
      [parser,{claims:total,found:rows.filter(row=>(row.snapshotParser||'none')===parser&&row.found).length}])),
    bySource:Object.entries(count(rows,row=>row.sourceIds.join('+')||'(not watched)')).map(([id,total])=>
      ({source:id,claims:total,missed:rows.filter(row=>(row.sourceIds.join('+')||'(not watched)')===id&&!row.found).length})).filter(item=>item.missed).sort((a,b)=>b.missed-a.missed),
    rows};
}

const percent=(part,whole)=>whole?`${Math.round(part/whole*1000)/10} %`:'n/a';
export function formatReport(report,{misses=false}={}){
  const lines=[`Quote survival in ${report.root}`,
    `Approved claims: ${report.claims} (${report.distinctQuotes} distinct quotes); verdicts without a claim: ${report.unresolvedVerdicts}; unreadable artifacts: ${report.unreadableArtifacts}`,
    `Found in the latest stored copy: ${report.found} of ${report.claims} (${percent(report.found,report.claims)})`+
      (Object.keys(report.foundIn).length?`  [${Object.entries(report.foundIn).map(([view,total])=>`${view} ${total}`).join(', ')}]`:''),
    `Not found: ${report.missed}`];
  for(const [reason,total] of Object.entries(report.byReason))lines.push(`  ${reason}: ${total}`);
  for(const [detail,total] of Object.entries(report.byDetail))lines.push(`    ${detail}: ${total}`);
  lines.push('By the parser of the snapshot the claim was taken from:');
  for(const [parser,item] of Object.entries(report.bySnapshotParser))lines.push(`  ${parser}: ${item.found} of ${item.claims} found`);
  if(report.bySource.length){
    lines.push('Sources with misses:');
    for(const item of report.bySource.slice(0,15))lines.push(`  ${item.source}: ${item.missed} of ${item.claims}`);
  }
  if(misses)for(const row of report.rows.filter(row=>!row.found))lines.push(`miss ${row.reason}/${row.detail} ${row.field} ${row.sourceIds.join('+')||'(not watched)'} ${row.snapshotParser}`);
  return lines.join('\n');
}

export function main(argv=process.argv.slice(2),write=text=>console.log(text)){
  const options=parseArgs(argv),report=survivalReport(options.root);
  write(options.json?JSON.stringify({...report,rows:options.misses?report.rows.filter(row=>!row.found):undefined},null,2):formatReport(report,options));
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main();}catch(error){console.error(error.message);process.exitCode=2;}
}
