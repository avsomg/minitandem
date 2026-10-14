import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {generatePublicPages,site} from './public-pages.mjs';
import {generateCaseStudy} from './case-study.mjs';
import {SCRIPTS,LAZY_SCRIPTS,STATIC,ASSETS,GENERATED} from './ui-files.mjs';
import {preparePublicOutput} from './public-output.mjs';
import {externalReviewReport,assertPublicationReviewed,readExternalReviewInputs} from './editorial/external-review.mjs';
import {pipelineReport,readPipelineInputs,assertEditorialReady} from './editorial/external-pipeline.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, '.publish');
// The generators are quiet when they succeed; when one fails, its own error output is shown, not only "Command failed".
const generate=(...parts)=>{
  try{execFileSync(process.execPath,[path.join(root,...parts)],{stdio:'pipe'});}
  catch(error){process.stderr.write(error.stderr||'');throw error;}
};
generate('editorial','compile-review.mjs');
generate('maintain.mjs');
generate('editorial','compile-geo.mjs');
const context = { window: {}, structuredClone };
for(const file of ['data.js','data-reviewed.js','data-practical.js','regions.js','data-geo.js']) vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'), context);
const records = context.window.ACTIVITIES;
if(context.window.STALE_UPDATES?.length)throw Error('Approved updates need reapproval against changed base: '+context.window.STALE_UPDATES.map(s=>s.id).join(', '));
const today=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
// The publication gates read private evidence (external review receipts, the visitor check) that is not in the public repository.
// Without it the gates cannot be evaluated. That is allowed only when asked for with --public, and the summary below says so.
const publicOnly=process.argv.includes('--public');
const evidenceFiles=['external-review-receipts.json','family-venues-visitor-check-2026-09-27.json'];
const privateEvidence=evidenceFiles.every(file=>fs.existsSync(path.join(root,'editorial',file)));
if(!privateEvidence&&!publicOnly)throw Error('Private editorial evidence is missing ('+evidenceFiles.join(', ')+'), so the publication gates cannot run. Use --public (npm run build) to build the site from the tracked files without them.');
if(privateEvidence){
  const {receipts,legacyRecords,baseline}=readExternalReviewInputs();
  assertPublicationReviewed(externalReviewReport(records,receipts,legacyRecords,baseline,today));
  const {receiptBaseline,registry,candidates,disputes,decisions,corrections}=readPipelineInputs();
  const pipeline=pipelineReport(records,receipts,receiptBaseline,registry,candidates,disputes,decisions,today,corrections);
  assertEditorialReady(pipeline);
}
const publicationGates=privateEvidence?'checked':'skipped: no private editorial evidence in this checkout';
const statuses = {active:'Current information available',check:'Needs confirmation',future:'For later; see age and conditions',closed:'Closed',excluded:'Archive / not included'};
const parent = {yes:'Together with an adult',no:'Separate format',unknown:'To be confirmed'};
const latestReview=records.reduce((latest,a)=>a.research?.date>latest?a.research.date:latest,'2026-09-27');
const lines = ['# Minitandem: catalogue with sources', '', `Catalogue updated ${latestReview}. The date of the in-depth check is shown on each card. Free places and future work are not guaranteed. All prices are in CHF; payment units are stated separately. Personal notes are not part of this file.`, ''];
for (const a of records) {
  lines.push(`## ${a.name}`, '', `- Status: ${statuses[a.status]}`, `- Place: ${a.town}`, `- District: ${context.window.CATALOG_REGIONS[a.region]}`, `- Checked: ${a.checked}`, `- Address: ${a.address || 'To be confirmed'}${a.addressPrecision==='area'?' (descriptive area, exact entrances not established)':''}`, `- Age: ${a.age}`, `- Adult: ${a.parentDetails || parent[a.parent]}`, `- Language: ${a.languages.join(', ') || 'To be confirmed'}`, `- Schedule: ${a.schedule}`, `- Price: ${a.price}`);
  for (const c of a.contacts) lines.push(`- Contact: ${[c.name,c.phone,c.email].filter(Boolean).join('; ')}`);
  for (const e of a.events) lines.push(`- Date: ${e.date} ${e.start || 'time to be confirmed'}${e.end ? '–'+e.end : ''}${e.title?' · '+e.title:''}${e.address?' · '+e.address:''}`);
  for (const note of a.notes) lines.push(`- ${note}`);
  if(a.research){
    lines.push('',`### Additional check: ${a.research.date}`,'');
    const kinds={official:'Organiser source',visitor:'Visitor experience',historical:'Historical information',inference:'Assessment from a source'};
    for(const f of a.research.findings) lines.push(`- **${f.field}** (${kinds[f.kind]}): ${f.text} [Source](${f.url})`);
    if(a.research.remaining.length) lines.push('','To confirm before visiting:',...a.research.remaining.map(q=>`- ${q}`),'');
  }
  for (const s of a.sources) lines.push(`- [${s.label}](${s.url})`);
  if(a.practical){
    lines.push('','### Visit conditions','');
    const labels={booking:'Booking',observe:'Observation',trial:'Trial',leave:'Leaving early',commitment:'Course payment',groupSize:'Group size',leader:'Leader',standardGerman:'Hochdeutsch',duration:'Duration',indoor:'Indoors',parking:'Parking',access:'Pushchair access',changing:'Changing table',toilet:'Toilet',feeding:'Feeding',playArea:'Play area',costNote:'Cost calculation'};
    for(const [key,label] of Object.entries(labels)){const f=a.practical[key];if(f)lines.push(`- ${label}: ${f.text} [Source](${f.source})`);}
    for(const warning of a.practical.warnings||[])lines.push(`- Important: ${warning}`);
    if(a.practical.tariff)lines.push(`- Family calculation: ${a.practical.tariff.note} [Tariff](${a.practical.tariff.source})`);
    if(a.practical.photo)lines.push(`- Photo: ${a.practical.photo.caption} [${a.practical.photo.credit}](${a.practical.photo.source})`);
    if(a.practical.gallery)lines.push(`- [Organiser's photographs](${a.practical.gallery})`);
  }
  if(a.geo)lines.push(`- Coordinates of the address (not the entrance): ${a.geo.lat}, ${a.geo.lon}. [Address register](${a.geo.source})`);
  lines.push('');
}
fs.writeFileSync(path.join(root, 'research.md'), lines.join('\n'));
// The catalogue as published: its layers and the German and French card texts that the app loads on demand.
const revisionInputs=['data.js','data-reviewed.js','data-practical.js','data-geo.js','regions.js',...LAZY_SCRIPTS];
const revision=crypto.createHash('sha256').update(revisionInputs.map(file=>fs.readFileSync(path.join(root,file))).join('\n')).digest('hex').slice(0,16);
const revisionDir=path.join(root,'editorial','catalog-versions',revision);
if(!fs.existsSync(revisionDir)){
  fs.mkdirSync(revisionDir,{recursive:true});
  for(const file of revisionInputs)fs.copyFileSync(path.join(root,file),path.join(revisionDir,file));
  fs.writeFileSync(path.join(revisionDir,'manifest.json'),JSON.stringify({revision,createdAt:new Date().toISOString(),records:records.length,files:revisionInputs},null,2)+'\n');
}
preparePublicOutput(output);
// Only these files may be published; local research, test output and backups stay outside.
// index.html, robots.txt and the manifest are static: they must name the one site origin from site.mjs.
for(const [file,needle] of [['index.html','rel="canonical" href="'+site+'/"'],['index.html','og:url" content="'+site+'/"'],['robots.txt','Sitemap: '+site+'/sitemap.xml']])
  if(!fs.readFileSync(path.join(root,file),'utf8').includes(needle))throw Error(file+' does not name the site origin '+site);
for (const file of [...STATIC,...GENERATED,...new Set(SCRIPTS),...LAZY_SCRIPTS,'.vercelignore']) fs.copyFileSync(path.join(root,file),path.join(output,file));
// German and French card texts: a card whose English changed after it was translated is shown in English. Reported, never a failure.
const i18n={window:{},structuredClone,TextEncoder};
for(const file of ['catalogue-i18n.js','views.js',...LAZY_SCRIPTS])vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),i18n,{filename:file});
const translations=Object.fromEntries(i18n.window.MinitandemCatalogueI18n.LANGS.map(lang=>{
  const shown=i18n.window.MinitandemCatalogueI18n.overlay(records,i18n.window.MINITANDEM_CARDS?.[lang],i18n.window.MinitandemViews.PRACTICAL_ORDER);
  return [lang,{translated:shown.count,stale:shown.stale.length,missing:shown.missing.length,unmapped:shown.unmapped.length,...(shown.stale.length?{staleCards:shown.stale}:{})}];
}));
fs.mkdirSync(path.join(output,'assets'),{recursive:true});
for (const file of ASSETS) fs.copyFileSync(path.join(root,'assets',file),path.join(output,'assets',file));
const publicPages=generatePublicPages(records,context.window.CATALOG_REGIONS,output,new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'}));
generateCaseStudy(root,output);
console.log(JSON.stringify({output,revision,records:records.length,publicationGates,translations,publicPages,files:fs.readdirSync(output)},null,2));
