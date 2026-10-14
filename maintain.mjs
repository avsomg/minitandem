import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {targetAgeFit,TARGET_AGE} from './editorial/age-policy.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const context={window:{},structuredClone};
for(const file of ['data.js','data-reviewed.js','data-practical.js','regions.js'])vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),context);
const records=context.window.ACTIVITIES;
const args=process.argv.slice(2);
const suppliedDate=args.find(x=>x.startsWith('--date='))?.slice(7);
const today=suppliedDate||new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const isDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
if(!isDate(today))throw Error('Use --date=YYYY-MM-DD');
const failures=[];
const warnings=[];
const ids=new Set();
for(const a of records){
  const fail=message=>failures.push(a.id+': '+message);
  if(ids.has(a.id))fail('duplicate id');ids.add(a.id);
  if(!Object.hasOwn(context.window.CATALOG_REGIONS,a.region))fail('unknown district');
  if(!isDate(a.checked)||!isDate(a.reviewAfter))fail('invalid review date');
  if(a.scheduleValidThrough&&!isDate(a.scheduleValidThrough))fail('invalid schedule end');
  if(a.min!==null&&a.max!==null&&a.min>a.max)fail('reversed age bounds');
  if(!a.sources.length){if(['closed','excluded'].includes(a.status))warnings.push(a.id+': archived record without a source');else fail('missing source');}
  if(a.sources.some(s=>!/^https:\/\//.test(s.url)))fail('source must use HTTPS');
  const dates=new Set();
  for(const e of a.events){
    if(!isDate(e.date))fail('invalid event date');
    const key=e.date+' '+e.start;if(dates.has(key))fail('duplicate event');dates.add(key);
    if(e.start&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.start)||e.end&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.end))fail('invalid event time');
    if(e.start&&e.end&&e.start>=e.end)fail('event end before start');
    if(a.scheduleValidThrough&&e.date>a.scheduleValidThrough)fail('event beyond published schedule');
  }
}
const active=records.filter(a=>!['closed','excluded'].includes(a.status));
const lastListedEvent=a=>a.events.reduce((last,e)=>e.date>last?e.date:last,'');
const nextListedEvent=a=>a.events.map(e=>e.date).filter(date=>date>=today).sort()[0]??null;
const nextWeek=new Date(Date.parse(today+'T12:00:00Z')+7*86400000).toISOString().slice(0,10);
const due=active.filter(a=>a.reviewAfter<=today||a.scheduleValidThrough&&a.scheduleValidThrough<today||a.events.length&&lastListedEvent(a)<today).map(a=>({id:a.id,name:a.name,region:a.region,checked:a.checked,reviewAfter:a.reviewAfter,scheduleValidThrough:a.scheduleValidThrough||null,reasons:[a.reviewAfter<=today?'review-date-passed':null,a.scheduleValidThrough&&a.scheduleValidThrough<today?'season-ended':null,a.events.length&&lastListedEvent(a)<today?'listed-events-ended':null].filter(Boolean),sources:a.sources.map(s=>s.url)}));
const needsConfirmation=active.filter(a=>a.status==='check').map(a=>{
  const nextEvent=nextListedEvent(a),ageFit=targetAgeFit(a);
  const urgent=due.some(item=>item.id===a.id)||nextEvent&&nextEvent<=nextWeek;
  const priority=urgent?'now':ageFit!=='outside'?'review':'later';
  const relevance=(ageFit==='confirmed'?4:ageFit==='possible'?1:-5)+(a.parent==='unknown'?2:0)+(!a.address?4:0);
  return {id:a.id,region:a.region,name:a.name,route:a.route,ageFit,nextEvent,lastEvent:lastListedEvent(a)||null,priority,relevance};
}).sort((a,b)=>({now:0,review:1,later:2}[a.priority]-{now:0,review:1,later:2}[b.priority])||b.relevance-a.relevance||(a.nextEvent??'9999').localeCompare(b.nextEvent??'9999')||a.id.localeCompare(b.id));
const result={date:today,targetAge:TARGET_AGE,records:records.length,catalog:active.length,archive:records.length-active.length,coverage:Object.fromEntries(Object.keys(context.window.CATALOG_COVERAGE).map(id=>[id,{state:context.window.CATALOG_COVERAGE[id],count:active.filter(a=>a.region===id).length}])),failures,warnings,due,needsConfirmation};
console.log(JSON.stringify(result,null,2));
if(failures.length)process.exitCode=1;
