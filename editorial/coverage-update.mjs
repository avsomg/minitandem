import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),app=path.dirname(here);
const coveragePath=path.join(here,'coverage-see.json');
const coverage=JSON.parse(fs.readFileSync(coveragePath,'utf8'));
// New mandatory categories need visible, initially unresearched cells in every commune.
for(const commune of new Set(coverage.cells.map(cell=>cell.commune))){
  if(!coverage.cells.some(cell=>cell.commune===commune&&cell.category==='dining'))coverage.cells.push({commune,category:'dining',status:'not-started',catalogRecordIds:[],searchLogIds:[],targetedSearchIds:[]});
}
const log=JSON.parse(fs.readFileSync(path.join(here,'search-log-see.json'),'utf8'));
const secondPass=JSON.parse(fs.readFileSync(path.join(here,'search-pass2-see.json'),'utf8'));
const diningPass=JSON.parse(fs.readFileSync(path.join(here,'search-dining-see.json'),'utf8'));
const targetedQueries=[...secondPass.queries,...diningPass.queries];
const ctx={window:{},structuredClone};
for(const file of ['data.js','data-reviewed.js','data-practical.js','regions.js'])vm.runInNewContext(fs.readFileSync(path.join(app,file),'utf8'),ctx);
const records=ctx.window.ACTIVITIES.filter(a=>a.region==='see'&&!['closed','excluded'].includes(a.status));
const keys=new Set(coverage.cells.map(cell=>`${cell.commune}|${cell.category}`));
if(keys.size!==coverage.cells.length)throw Error('Duplicate coverage cell');
for(const entry of log.entries){
  if(!entry.id||!entry.query||!Array.isArray(entry.categories)||!Array.isArray(entry.sourceUrls))throw Error('Invalid search log entry');
  if(entry.sourceUrls.some(url=>!url.startsWith('https://')))throw Error('Non-HTTPS source in log');
  if(entry.commune&&!coverage.cells.some(c=>c.commune===entry.commune))throw Error('Unknown commune: '+entry.commune);
}
const passKeys=new Set();
for(const entry of targetedQueries){
  const key=`${entry.commune}|${entry.category}`;
  if(!entry.id||!entry.query||!Array.isArray(entry.topResults)||!keys.has(key)||passKeys.has(key))throw Error('Invalid or duplicate second-pass search: '+key);
  passKeys.add(key);
}
for(const cell of coverage.cells){
  cell.searchLogIds=log.entries.filter(e=>e.commune===cell.commune&&e.categories.includes(cell.category)).map(e=>e.id);
  cell.targetedSearchIds=targetedQueries.filter(e=>e.commune===cell.commune&&e.category===cell.category).map(e=>e.id);
  cell.catalogRecordIds=records.filter(a=>a.town===cell.commune&&a.category===cell.category).map(a=>a.id);
  cell.status=cell.searchLogIds.length?'partial':cell.targetedSearchIds.length?'search-only':'not-started';
}
coverage.asOf=log.asOf;
coverage.note='Partial means a source was reviewed and logged. Search-only means a category-specific web search was run but its leads still need local primary-source review. Neither status establishes completeness or absence. District expansion remains on hold.';
fs.writeFileSync(coveragePath,JSON.stringify(coverage,null,2)+'\n');
const counts=Object.fromEntries([...new Set(coverage.cells.map(c=>c.status))].map(status=>[status,coverage.cells.filter(c=>c.status===status).length]));
console.log(JSON.stringify({communes:new Set(coverage.cells.map(c=>c.commune)).size,cells:coverage.cells.length,status:counts,records:records.length,searchEntries:log.entries.length,targetedSearches:targetedQueries.length},null,2));
