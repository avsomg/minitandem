// Counts what in the product still ties it to one family, to its working title or to Russian.
// Without arguments it reports the built site in .publish/. With --source it reports the workspace by group:
//   data       catalogue layers, journal, geocode cache and the other configuration the pipeline reads
//   editorial  pipeline code and its tests
//   ui         interface, server, admin panel and their tests (rebuilt by the interface task)
//   docs       written documentation
// --strict exits 1 when a group listed in STRICT_GROUPS has a hit, when a private path is not gitignored or is tracked by git, or when the
// private-contacts group below fails. --root=DIR audits another checkout than this one (the tests use it; the default is this workspace).
// Nothing here reads private state, so the same command runs on a clean clone after the build; CI runs it there (.github/workflows/test.yml)
// and so does the local QA (qaRun in agent-run.mjs).
// Which checks apply: the wording checks (the reference child's age, mother wording) look at what families read, so they run on data, ui and the
// built site. In code and documentation only Cyrillic and the old name count; a test that quotes an organiser's own "from 2.5 years" is not a leak.
// Private state is never audited; it must be listed in .gitignore, which the audit checks.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CONTACT_RULE,contactDigest,swissMobileCount} from './contact-rule.mjs';
import {loadCatalog} from './quality.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),workspace=path.dirname(here);
// Kept on purpose, and the only exemptions: the stored format ids of plan and correction files would need a data migration,
// and the internal project identifier is written into the queue, snapshots, artifacts and worker envelopes.
// The names of the browser storage keys of the earlier version may appear in one file only, the one-time migration.
// Escapes keep this file free of Cyrillic.
const KEPT_IDENTIFIERS=/vmeste-plan|vmeste-correction|(["'])vmeste\1/giu;
export const MIGRATION_FILE='storage-migration.js';
const OLD_STORAGE_KEYS=/vmeste-(?:family|sync|pending-corrections)-v1[\w-]*/giu;
const CHECKS={
  referenceChildAge:/2[,.]5\s?(?:\u0433\u043e\u0434\u0430|\u043b\u0435\u0442|\u0433\.|years?\b|Jahre?n?\b|ans?\b)/giu,
  motherWording:/(?<![\u0430-\u044f\u0451])\u043c\u0430\u043c(?:\u0430|\u044b|\u0435|\u0443|\u043e\u0439|\u0430\u043c|\u043e\u0447\u043a)/giu,
  workingTitle:/\u0412\u043c\u0435\u0441\u0442\u0435|vmeste/giu,
  cyrillicWords:/[\u0410-\u042f\u0430-\u044f\u0401\u0451]+/gu
};
// Groups that must be clean for --strict to pass. With --strict the built site must be clean as well.
export const STRICT_GROUPS=['data','editorial','ui','docs'];
export function auditText(text,file=''){
  const cleaned=(path.basename(file)===MIGRATION_FILE?text.replace(OLD_STORAGE_KEYS,''):text).replace(KEPT_IDENTIFIERS,'');
  return Object.fromEntries(Object.entries(CHECKS).map(([name,pattern])=>[name,(cleaned.match(pattern)||[]).length]));
}
const TEXT_FILE=/\.(?:html|js|mjs|json|md|txt|xml|css|webmanifest)$/;
export function auditDirectory(directory){
  const files=[],totals=Object.fromEntries(Object.keys(CHECKS).map(name=>[name,0]));
  const walk=folder=>{
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
      const file=path.join(folder,entry.name);
      if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
      if(entry.isDirectory()){walk(file);continue;}
      if(!TEXT_FILE.test(entry.name))continue;
      const counts=auditText(fs.readFileSync(file,'utf8'),path.relative(directory,file));
      for(const [name,count] of Object.entries(counts))totals[name]+=count;
      if(Object.values(counts).some(Boolean))files.push({file:path.relative(directory,file),...counts});
    }
  };
  walk(directory);
  return {totals,files};
}

// Private state: search and verification records, queue, artifacts, caches. Gitignored and not audited.
export const PRIVATE=['archive-ru/','translation/','node_modules/','editorial/node_modules/','server-state/',
  'editorial/workflow-state/','editorial/agent-artifacts/','editorial/external-candidates/','editorial/external-disputes/','editorial/external-decisions/',
  'editorial/corrections/','editorial/correction-versions/','editorial/versions/','editorial/page-records/','editorial/typesafe-runtime/','editorial/calibration-runtime/',
  'editorial/catalogue-runtime/','editorial/fact-ledger/','editorial/catalog-versions/','editorial/audit/','editorial/experiments/out/',
  'editorial/external-review-receipts.json','editorial/family-venues-visitor-check-2026-09-27.json','editorial/monitor-state.json',
  'editorial/discovery-state.json','editorial/discovery-report.json','editorial/heartbeat-state.json',
  // Generated snapshots of private state, dated working papers of the first rollout, and the release account identity.
  'editorial/external-review-report.json','editorial/external-pipeline-report.json','editorial/operations-report.json','editorial/workflow-report.json',
  'editorial/quality-report.json','editorial/work-packets.json','editorial/catalogue-shape-audit-2026-10-02.json','editorial/dependency-audit-2026-10-02.json',
  'editorial/memo-booking-browser-check-2026-10-02.json','editorial/workflow-rollout-2026-10-02.json','editorial/release-identity.json'];
const UI=[/^(?:app|i18n|catalogue|format|store|sync|exports|views|toast|map|planning|exchange|storage-migration|sw|server|public-pages|test-support|verify-support|screenshots|ui-files|site)\.m?js$/,/^strings-[a-z]{2}\.js$/,
  /^(?:index\.html|styles\.css|manifest\.webmanifest|vercel\.json|robots\.txt|sitemap\.xml)$/,
  /^verify[\w-]*\.mjs$/,/^[\w-]+\.test\.mjs$/,/^design\//,/^places\//,
  /^editorial\/(?:admin\.(?:html|js|css)|admin-session\.test\.mjs|intake\.mjs)$/];
const DOCS=[/\.md$/];
const DATA=[/^data[\w-]*\.js$/,/^regions\.js$/,/^research\.md$/,/^editorial\/[\w.-]+\.json$/];
// The audit has to name what it looks for, so its own source and test are not audited.
const SELF=['editorial/public-audit.mjs','editorial/public-audit.test.mjs'];
export const GROUP_CHECKS={data:Object.keys(CHECKS),ui:Object.keys(CHECKS),editorial:['workingTitle','cyrillicWords'],docs:['workingTitle','cyrillicWords']};
export function groupOf(relative){
  const rel=relative.split(path.sep).join('/');
  if(PRIVATE.some(prefix=>rel.startsWith(prefix)))return 'private';
  if(SELF.includes(rel))return 'skip';
  if(rel.startsWith('assets/')||rel.startsWith('.'))return 'skip';
  if(UI.some(pattern=>pattern.test(rel)))return 'ui';
  if(DATA.some(pattern=>pattern.test(rel)))return 'data';
  if(DOCS.some(pattern=>pattern.test(rel)))return 'docs';
  return 'editorial';
}
// Mentions of the reference age inside cards whose own min or max is 2.5: data.js (one JSON object per line), the generated research.md (one section
// per card) and the German and French card texts data-de.js and data-fr.js (one card per line, "id":{...}).
// A card that publishes 2.5 as its age bound may say so; the same words on another card would be a leak.
function publishedBoundCards(root){
  const names=new Set(),ids=new Set(),lines=[];
  let text='';
  try{text=fs.readFileSync(path.join(root,'data.js'),'utf8');}catch{return {names,ids,lines};}
  for(const line of text.split('\n')){
    const card=line.trim().replace(/,$/,'');
    if(!card.startsWith('{"'))continue;
    let parsed;try{parsed=JSON.parse(card);}catch{continue;}
    if(parsed.id&&(parsed.min===2.5||parsed.max===2.5)){names.add(parsed.name);ids.add(parsed.id);lines.push(card);}
  }
  return {names,ids,lines};
}
function publishedBoundMentions(root,rel,text){
  const count=part=>auditText(part).referenceChildAge;
  if(rel==='data.js')return publishedBoundCards(root).lines.reduce((n,card)=>n+count(card),0);
  if(rel==='research.md'){
    const {names}=publishedBoundCards(root);
    return text.split('\n## ').slice(1).filter(section=>names.has(section.split('\n')[0].trim())).reduce((n,section)=>n+count(section),0);
  }
  if(/^data-(?:de|fr)\.js$/.test(rel)){
    const {ids}=publishedBoundCards(root);
    return text.split('\n').filter(line=>ids.has((line.match(/^"([^"]+)":\{/)||[])[1])).reduce((n,line)=>n+count(line),0);
  }
  return 0;
}
export function auditWorkspace(root=workspace){
  const groups={data:[],editorial:[],ui:[],docs:[]};
  const walk=folder=>{
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
      const file=path.join(folder,entry.name),rel=path.relative(root,file);
      if(entry.isSymbolicLink()||entry.name.startsWith('.')||entry.name==='.DS_Store')continue;
      const group=groupOf(entry.isDirectory()?rel+'/':rel);
      if(group==='private'||group==='skip')continue;
      if(entry.isDirectory()){walk(file);continue;}
      if(!TEXT_FILE.test(entry.name))continue;
      const posix=rel.split(path.sep).join('/'),text=fs.readFileSync(file,'utf8'),counts=auditText(text,posix);
      counts.referenceChildAge-=publishedBoundMentions(root,posix,text);
      for(const name of Object.keys(CHECKS))if(!GROUP_CHECKS[group].includes(name))counts[name]=0;
      if(Object.values(counts).some(Boolean))groups[group].push({file:posix,...counts});
    }
  };
  walk(root);
  const total=rows=>Object.fromEntries(Object.keys(CHECKS).map(name=>[name,rows.reduce((n,row)=>n+row[name],0)]));
  // Every private path has to be ignored, or private state could reach a public repository.
  const ignore=fs.existsSync(path.join(root,'.gitignore'))?fs.readFileSync(path.join(root,'.gitignore'),'utf8').split('\n').map(line=>line.trim()):[];
  const unignored=PRIVATE.filter(item=>!ignore.includes(item)&&!ignore.includes(item.replace(/\/$/,''))&&fs.existsSync(path.join(root,item))&&
    !item.startsWith('editorial/node_modules'));
  return {groups:Object.fromEntries(Object.entries(groups).map(([name,files])=>[name,{totals:total(files),files}])),privateNotIgnored:unignored};
}
// Private paths that git tracks. .gitignore only keeps untracked files out, so a private file that was added by force, or before its rule
// existed, is public all the same. On a clean clone no private file exists unless it is tracked, so this is the form of the private-path rule
// that CI can check. Without git (a plain copy of the files) nothing can be told and the list is empty.
export function trackedFiles(root=workspace){
  try{return execFileSync('git',['ls-files','-z','--cached'],{cwd:root,encoding:'utf8',maxBuffer:64_000_000,stdio:['ignore','pipe','ignore']}).split('\0').filter(Boolean);}
  catch{return [];}
}
export const trackedPrivateFiles=(root=workspace,files=trackedFiles(root))=>files.filter(file=>groupOf(file)==='private');
function strictFailure(report){
  const dirty=name=>Object.values(report.groups[name].totals).some(Boolean);
  return STRICT_GROUPS.filter(dirty);
}
// Private contacts. The owner decided on 14 October 2026 that the public catalogue lists organisation contacts only (docs/publication-scope.md).
// a. No written-out Swiss mobile number (contact-rule.mjs) in the public catalogue files or the built site; digits in web addresses do not count.
// b. Every contact of the assembled catalogue, approved updates included, is on the list of contacts a person has reviewed,
//    public-contacts-reviewed.json. The list holds sha256 digests only. review-contacts.mjs shows what is missing (values in the terminal only)
//    and records it with --accept; only the main chat or the owner runs --accept, after checking each contact is an organisation contact.
// The report names files, cards and contact positions, never a contact value.
export const CONTACT_FILES=['data.js','data-reviewed.js','data-practical.js','research.md'];
export const REVIEWED_CONTACTS='editorial/public-contacts-reviewed.json';
export function mobileNumberFiles(root=workspace){
  const rows=[];
  const count=(file,rel)=>{const mobileNumbers=swissMobileCount(fs.readFileSync(file,'utf8'));if(mobileNumbers)rows.push({file:rel,mobileNumbers});};
  for(const file of CONTACT_FILES)if(fs.existsSync(path.join(root,file)))count(path.join(root,file),file);
  // The built site: every page and script, not the third-party bundles in assets/.
  const walk=folder=>{
    for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const file=path.join(folder,entry.name),rel=path.relative(root,file).split(path.sep).join('/');
      if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
      if(entry.isDirectory()){if(rel!=='.publish/assets')walk(file);continue;}
      if(TEXT_FILE.test(entry.name))count(file,rel);
    }
  };
  if(fs.existsSync(path.join(root,'.publish')))walk(path.join(root,'.publish'));
  return rows;
}
export function readReviewedContacts(file=path.join(workspace,REVIEWED_CONTACTS)){
  let list;
  try{list=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return {reviewedOn:null,rule:CONTACT_RULE,digests:[]};throw error;}
  if(!Array.isArray(list?.digests)||!list.digests.every(digest=>typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest)))
    throw Error(REVIEWED_CONTACTS+' must hold {reviewedOn,rule,digests:[sha256 hex]}');
  return list;
}
// Every contact of the catalogue with its card id, position (contacts[0] is a card's first contact) and digest.
export function contactRows(records){
  return records.flatMap(card=>(card.contacts||[]).map((contact,index)=>({card:card.id,position:`contacts[${index}]`,contact,digest:contactDigest(contact)})));
}
// The contacts that are not on the reviewed list, by card id and position only. A missing list counts as empty, so the audit fails closed.
export function unreviewedContacts(records,reviewed){
  const known=new Set(reviewed.digests);
  return contactRows(records).filter(row=>!known.has(row.digest)).map(({card,position})=>({card,position}));
}
// records defaults to the assembled catalogue of the root (loadCatalog); a test passes its own.
export function privateContactsReport(root=workspace,{records=loadCatalog({base:root}).ACTIVITIES,reviewed=readReviewedContacts(path.join(root,REVIEWED_CONTACTS))}={}){
  const mobileNumbers=mobileNumberFiles(root),unreviewed=unreviewedContacts(records,reviewed);
  return {contacts:contactRows(records).length,mobileNumbers,unreviewed,failing:mobileNumbers.length>0||unreviewed.length>0};
}
export const UNREVIEWED_ADVICE='A contact that is not on the reviewed list: check that it is an organisation contact first (organisation name, landline, role address), '+
  'with node editorial/review-contacts.mjs. Only the main chat or the owner records it, with --accept. A private contact is removed from the card instead.';

// The built site: Cyrillic, the old name and the mother wording must be absent. Mentions of the reference age stay in the report only:
// the generated pages repeat cards whose own published age bound is that number.
export const BUILT_SITE_CHECKS=['cyrillicWords','workingTitle','motherWording'];
export function builtSiteFailure(report){return BUILT_SITE_CHECKS.filter(name=>report.totals[name]>0);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const strict=process.argv.includes('--strict');
  const rootArgument=process.argv.find(argument=>argument.startsWith('--root='));
  const root=rootArgument?path.resolve(rootArgument.slice(7)):workspace;
  const directory=path.join(root,'.publish');
  if(process.argv.includes('--source')||strict){
    const report=auditWorkspace(root);
    const contacts=privateContactsReport(root);
    const tracked=trackedPrivateFiles(root);
    const failing=[...strictFailure(report),...(contacts.failing?['private contacts']:[])];
    const built=fs.existsSync(directory)?auditDirectory(directory):null;
    const builtFailing=strict&&built?builtSiteFailure(built):[];
    const builtMissing=strict&&!built;
    console.log(JSON.stringify({scope:'workspace',strictGroups:[...STRICT_GROUPS,'private contacts'],failingGroups:failing,builtSite:built?{totals:built.totals,failing:builtFailing}:'not built',privateNotIgnored:report.privateNotIgnored,trackedPrivateFiles:tracked,
      groups:Object.fromEntries(Object.entries(report.groups).map(([name,group])=>[name,{totals:group.totals,files:name==='ui'||name==='docs'?group.files.length+' files':group.files}])),
      'private contacts':{contacts:contacts.contacts,filesWithMobileNumbers:contacts.mobileNumbers,unreviewedContacts:contacts.unreviewed,
        ...(contacts.unreviewed.length&&{advice:UNREVIEWED_ADVICE})}},null,2));
    process.exit(strict&&(failing.length||report.privateNotIgnored.length||tracked.length||builtFailing.length||builtMissing)?1:0);
  }
  const report=auditDirectory(directory);
  // Generated place pages repeat the card texts; one line for the group keeps the report readable.
  const pages=report.files.filter(row=>row.file.startsWith('places'+path.sep));
  const rest=report.files.filter(row=>!row.file.startsWith('places'+path.sep));
  console.log(JSON.stringify({directory:'.publish',totals:report.totals,files:rest,
    placePages:{files:pages.length,referenceChildAge:pages.reduce((n,row)=>n+row.referenceChildAge,0),motherWording:pages.reduce((n,row)=>n+row.motherWording,0)}},null,2));
}
