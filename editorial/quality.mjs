import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {relevantPracticalFields,practicalFieldApplies,validDate} from './field-contract.mjs';
import {publicApprovedUpdates} from './catalogue-journal.mjs';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function loadCatalog({updatesFile=path.join(root,'editorial','approved-updates.json')}={}){
  const context={window:{},structuredClone,URL};
  for(const file of ['data.js','data-reviewed.js'])vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),context);
  if(updatesFile&&fs.existsSync(updatesFile))context.window.APPROVED_UPDATES=publicApprovedUpdates(JSON.parse(fs.readFileSync(updatesFile,'utf8')));
  for(const file of ['data-practical.js','regions.js','data-geo.js','planning.js','exchange.js'])vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),context);
  return context.window;
}
const KIND_WEIGHT={'possible-closure':400,'redirect-changed':150,'content-changed':80,'parser-failed':80,'possible-reopen':80,'source-unavailable':60};
const SIGNIFICANCE_WEIGHT={high:150,normal:80,low:20};
export function issueWeight(issue){
  const d=issue.details||{};
  if(issue.kind==='content-changed')return SIGNIFICANCE_WEIGHT[d.significance]??80;
  if(issue.kind==='redirect-changed')return ['language','path'].includes(d.class)?80:150;
  if(issue.kind==='possible-closure'&&Array.isArray(d.lines)&&d.lines.length&&d.lines.every(l=>l.office||l.strength==='info'))return 80;
  return KIND_WEIGHT[issue.kind]??80;
}
export function qualityReport(records,sources,date,monitorState){
  const fields=['booking','observe','trial','leave','commitment','groupSize','leader','standardGerman','access','changing'];
  const active=records.filter(a=>!['closed','excluded'].includes(a.status));
  const watchedByRecord=new Map();
  for(const source of sources)for(const id of source.recordIds||[]){
    if(!watchedByRecord.has(id))watchedByRecord.set(id,[]);
    watchedByRecord.get(id).push(source.id);
  }
  const openBySource=new Map();
  for(const task of monitorState?.queue||[]){
    if(task.status!=='open')continue;
    if(!openBySource.has(task.sourceId))openBySource.set(task.sourceId,[]);
    openBySource.get(task.sourceId).push({id:task.id,sourceId:task.sourceId,kind:task.kind,status:task.status,details:task.details});
  }
  const horizon=new Date(Date.parse(`${date}T12:00:00Z`)+14*86400000).toISOString().slice(0,10);
  const rows=active.map(a=>{
    const critical=[];
    if(a.min===null&&!a.ageException)critical.push('age');
    if(a.parent==='unknown')critical.push('parent');
    if(a.priceKind==='unknown'&&a.category!=='dining')critical.push('price');
    if(!a.address||a.addressPrecision==='area')critical.push('address');
    if(a.format!=='self'&&!a.languages.length)critical.push('language');
    if(a.format!=='self'&&a.practical?.booking?.value==null)critical.push('booking');
    const relevant=relevantPracticalFields(a);
    const missing=relevant.filter(key=>a.practical?.[key]?.value==null);
    const stale=Boolean(a.reviewAfter&&a.reviewAfter<=date||a.scheduleValidThrough&&a.scheduleValidThrough<date||a.events.length&&a.events.every(e=>e.date<date));
    const watched=watchedByRecord.get(a.id)||[];
    const sourceIssues=watched.flatMap(id=>openBySource.get(id)||[]);
    const nextEvent=a.events.map(e=>e.date).filter(value=>value>=date).sort()[0]||null;
    const imminent=Boolean(nextEvent&&nextEvent<=horizon);
    const weights={age:8,parent:6,price:4,address:10,language:5,booking:5};
    const signal=sourceIssues.reduce((max,issue)=>Math.max(max,issueWeight(issue)),0);
    const staleWeight=stale?(a.format==='self'&&!imminent?60:120):0;
    const imminentWeight=imminent?(sourceIssues.length?100:(a.status==='check'||critical.length?55:10)):0;
    const priority=staleWeight+signal+(a.status==='check'?25:0)+imminentWeight+
      critical.reduce((sum,key)=>sum+weights[key],0)+(watched.length?0:15);
    return {id:a.id,name:a.name,region:a.region,checked:a.checked,reviewAfter:a.reviewAfter||null,stale,nextEvent,critical,missing,watched,sourceIssues,owner:null,priority,source:a.sources[0]?.url||null};
  }).sort((a,b)=>b.priority-a.priority||(a.nextEvent||'9999').localeCompare(b.nextEvent||'9999')||a.id.localeCompare(b.id));
  return {generatedFor:date,records:active.length,unassigned:rows.length,stale:rows.filter(a=>a.stale).length,withoutMonitor:rows.filter(a=>!a.watched.length).length,
    sourceAffected:rows.filter(a=>a.sourceIssues.length).length,imminent:rows.filter(a=>a.nextEvent&&a.nextEvent<=horizon).length,
    coverage:Object.fromEntries(fields.map(key=>{
      const applicable=active.filter(a=>practicalFieldApplies(a,key)||a.practical?.[key]?.value!=null);
      return [key,{known:applicable.filter(a=>a.practical?.[key]?.value!=null).length,
        unknown:applicable.filter(a=>a.practical?.[key]?.value==null).length,applicable:applicable.length,notApplicable:active.length-applicable.length}];
    })),queue:rows};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const catalog=loadCatalog();
  const date=process.argv[2]||new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
  if(!validDate(date))throw Error('Date must be YYYY-MM-DD');
  const sources=JSON.parse(fs.readFileSync(path.join(root,'editorial/source-watch.json'),'utf8')).sources;
  const monitorPath=path.join(root,'editorial/monitor-state.json');
  const monitor=fs.existsSync(monitorPath)?JSON.parse(fs.readFileSync(monitorPath,'utf8')):null;
  const report=qualityReport(catalog.ACTIVITIES,sources,date,monitor);
  const output=path.join(root,'editorial/quality-report.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,records:report.records,stale:report.stale,withoutMonitor:report.withoutMonitor,coverage:report.coverage},null,2));
}
