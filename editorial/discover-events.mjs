import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ICAL from 'ical.js';
import {loadCatalog,root} from './quality.mjs';
import {swissStamp,withCalendarZones} from './calendar-time.mjs';
import {readCantonalCalendar} from './canton-calendar.mjs';
import {validDate} from './field-contract.mjs';

const feeds=[
  {id:'fribourg-city',url:'https://www.ville-fribourg.ch/agenda.ics?theme',hosts:['www.ville-fribourg.ch']},
  {id:'aef',url:'https://tockify.com/api/feeds/ics/educationfamiliale',hosts:['tockify.com']},
  {id:'fribourg-canton',type:'cantonal-agenda',url:'https://www.fr.ch/evenements',hosts:['www.fr.ch']}
];
const familyTerms=/famill|familie|enfant|kinder|baby|bébé|parent|eltern|ludo|biblio|histoire|geschicht|spiel|éveil|musik|musique|bastel|mini|tout-petit|kleinkind/i;
const workshopFamilyTerms=/famill|familie|enfant|kinder|baby|bébé|parent|eltern|tout-petit|kleinkind/i;
const swissDate=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
const titleKey=value=>value.trim().toLocaleLowerCase().replace(/\s+/g,' ');
const eventUrl=component=>component.getFirstPropertyValue('url')||
  (String(component.getFirstPropertyValue('description')||'').match(/https:\/\/[^\s]+/g)||[]).at(-1)?.replace(/[.,;)]*$/,'');
export function calendarTitles(ics){
  const calendar=new ICAL.Component(ICAL.parse(ics)),titles=new Map();
  for(const component of calendar.getAllSubcomponents('vevent')){
    const url=eventUrl(component),title=component.getFirstPropertyValue('summary');
    if(!url||!title)continue;
    if(!titles.has(url))titles.set(url,new Set());titles.get(url).add(titleKey(title));
  }
  return titles;
}

export function canonicalUrl(value){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:')return null;
    let pathname=url.pathname.replace(/\/+$/,'').toLowerCase();
    if(url.hostname==='tockify.com')pathname=pathname.replace(/(\/detail\/\d+)\/\d+(?:\/\d+)?$/,'$1');
    return url.origin.toLowerCase()+pathname;
  }catch{return null;}
}

export function extractEvents(ics,feed,today,days=180){
  const calendar=new ICAL.Component(ICAL.parse(ics));
  if(calendar.name!=='vcalendar')throw Error('Expected VCALENDAR');
  const horizon=new Date(Date.parse(`${today}T12:00:00Z`)+days*86400000).toISOString().slice(0,10);
  const events=[];
  withCalendarZones(calendar,()=>{for(const component of calendar.getAllSubcomponents('vevent')){
    if(String(component.getFirstPropertyValue('status')||'').toUpperCase()==='CANCELLED')continue;
    const event=new ICAL.Event(component);
    if(!event.startDate)continue;
    let start,end,timeUnresolved=false;
    try{start=swissStamp(event.startDate);end=component.hasProperty('dtend')?swissStamp(event.endDate):null;}
    catch{start={date:event.startDate.toString().slice(0,10),time:''};end=null;timeUnresolved=true;}
    const date=start.date;
    if(date<today||date>horizon)continue;
    const description=event.description||'';
    const rawUrl=eventUrl(component);
    const identity=canonicalUrl(rawUrl);
    if(!identity||!feed.hosts.includes(new URL(identity).hostname))continue;
    const url=new URL(rawUrl).href;
    const title=(event.summary||'').trim();
    if(!title)continue;
    events.push({feedId:feed.id,date,title,url,identity,uid:event.uid||null,start:start.time,end:end?.date===date?end.time:null,timeUnresolved,
      familyHint:familyTerms.test(title)||workshopFamilyTerms.test(description),
      recurrenceUnexpanded:component.hasProperty('rrule')});
  }});
  return [...new Map(events.map(event=>[`${event.feedId}|${event.identity}|${titleKey(event.title)}|${event.date}|${event.start}|${event.uid||''}`,event])).values()];
}

export function compareEvents(events,records,state,now,aliases=[],anchors=null){
  if(!anchors){anchors=new Map();for(const event of events){
    if(!anchors.has(event.url))anchors.set(event.url,new Set());anchors.get(event.url).add(titleKey(event.title));
  }}
  const byUrl=new Map();
  const recordsById=new Map(records.map(record=>[record.id,record]));
  for(const record of records)for(const source of record.sources||[]){
    const url=canonicalUrl(source.url);
    if(!url)continue;
    if(!byUrl.has(url))byUrl.set(url,[]);
    byUrl.get(url).push(record);
  }
  const byAlias=new Map();
  for(const alias of aliases){
    const identity=canonicalUrl(alias.url);
    const record=recordsById.get(alias.recordId);
    if(!identity||!record||!alias.feedId)throw Error(`Invalid discovery alias: ${alias.recordId||'unknown'}`);
    const key=`${alias.feedId}|${identity}`;
    if(!byAlias.has(key))byAlias.set(key,[]);
    byAlias.get(key).push({record,url:alias.url});
  }
  state??={schema:1,feeds:{},seen:{}};
  state.feeds??={};state.seen??={};
  const candidates=[];
  for(const event of events){
    const oldKey=`${event.feedId}|${event.identity}|${event.date}`;
    const key=`${oldKey}|${titleKey(event.title)}|${event.start||''}`;
    const aliasMatches=byAlias.get(`${event.feedId}|${event.identity}`)||[];
    const matched=[...new Map([...(byUrl.get(event.identity)||[]),...aliasMatches.map(item=>item.record)]
      .map(record=>[record.id,record])).values()];
    const exact=matched.filter(record=>{
      const urls=[...(record.sources||[]).map(s=>s.url),...aliasMatches.filter(item=>item.record.id===record.id).map(item=>item.url)];
      return urls.some(url=>anchors.get(url)?.size===1&&anchors.get(url).has(titleKey(event.title)));
    });
    const published=!event.timeUnresolved&&!event.recurrenceUnexpanded&&exact.some(record=>record.events?.some(item=>item.date===event.date&&
      (!event.start||item.start===event.start)&&(!event.end||item.end===event.end))||
      (record.format==='self'&&record.scheduleValidThrough&&record.events?.length===0&&event.date<=record.scheduleValidThrough));
    const original=new URL(event.url);
    const legacyKey=`${event.feedId}|${original.origin.toLowerCase()+original.pathname.replace(/\/+$/,'').toLowerCase()}|${event.date}`;
    const seen=state.seen[key]||state.seen[oldKey]||state.seen[legacyKey];
    if(seen)state.seen[key]={...seen,lastSeen:now};
    if(seen&&legacyKey!==oldKey)delete state.seen[legacyKey];
    if(!seen)state.seen[key]={firstSeen:now,lastSeen:now};
    else seen.lastSeen=now;
    if(published)continue;
    candidates.push({...event,matchedRecordIds:matched.map(record=>record.id),
      status:seen?'pending':state.feeds[event.feedId]?.lastSuccess&&state.feeds[event.feedId]?.coverage?.complete!==false?'new':'baseline',firstSeen:state.seen[key].firstSeen});
  }
  candidates.sort((a,b)=>Number(b.familyHint)-Number(a.familyHint)||a.date.localeCompare(b.date)||a.title.localeCompare(b.title));
  return {state,candidates};
}

export function groupSeries(candidates){
  const groups=new Map();
  for(const item of candidates){
    // Tockify can reuse a programme ID for differently named sessions.
    const key=`${item.feedId}|${item.identity}|${item.title.trim().toLocaleLowerCase()}`;
    if(!groups.has(key))groups.set(key,{feedId:item.feedId,identity:item.identity,title:item.title,url:item.url,
      familyHint:item.familyHint,matchedRecordIds:item.matchedRecordIds,dates:[],occurrences:[],newDates:[],statuses:new Set(),recurrenceUnexpanded:false});
    const group=groups.get(key);
    group.familyHint ||= item.familyHint;
    group.recurrenceUnexpanded ||= item.recurrenceUnexpanded;
    group.dates.push(item.date);
    group.occurrences.push({date:item.date,start:item.start||null,end:item.end||null,timeUnresolved:item.timeUnresolved||false});
    if(item.status==='new')group.newDates.push(item.date);
    group.statuses.add(item.status);
  }
  return [...groups.values()].map(group=>({feedId:group.feedId,identity:group.identity,title:group.title,url:group.url,
    familyHint:group.familyHint,recurrenceUnexpanded:group.recurrenceUnexpanded,
    matchedRecordIds:group.matchedRecordIds,dates:[...new Set(group.dates)].sort(),occurrences:group.occurrences,
    newDates:[...new Set(group.newDates)].sort(),status:group.statuses.has('new')?'new':group.statuses.has('baseline')?'baseline':'pending'
  })).sort((a,b)=>Number(b.familyHint)-Number(a.familyHint)||a.dates[0].localeCompare(b.dates[0])||a.title.localeCompare(b.title));
}

async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
async function atomicJson(file,value){const temp=`${file}.tmp-${process.pid}`;await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);}

export async function discover({fetchImpl=fetch,today=swissDate(new Date()),now=new Date().toISOString(),state,records,feedList=feeds,aliases=[]}){
  const next=structuredClone(state||{schema:1,feeds:{},seen:{}});
  const candidates=[],errors=[],feedResults={};
  for(const feed of feedList){
    try{
      let events,anchors,coverage=null,issues=[],warnings=[];
      if(feed.type==='cantonal-agenda'){
        ({events,anchors,coverage,issues,warnings}=await readCantonalCalendar(feed,{fetchImpl,today,parseCalendar:extractEvents,titleAnchors:calendarTitles,familyHint:text=>familyTerms.test(text)}));
      }else{
      const response=await fetchImpl(feed.url,{signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error(`HTTP ${response.status}`);
      const length=Number(response.headers.get('content-length'));
      if(length>2_000_000)throw Error('Feed too large');
      const ics=await response.text();
      if(ics.length>2_000_000)throw Error('Feed too large');
      events=extractEvents(ics,feed,today);anchors=calendarTitles(ics);
      }
      const result=compareEvents(events,records,next,now,aliases,anchors);
      candidates.push(...result.candidates);
      next.feeds[feed.id]={url:feed.url,lastSuccess:now,events:events.length,...(coverage?{coverage}:{})};
      feedResults[feed.id]={status:issues.length?'partial':'success',events:events.length,...(coverage?{coverage}:{}),...(warnings.length?{warnings}:{})};
      if(issues.length)errors.push({feedId:feed.id,error:'Incomplete source inspection',issues});
    }catch(error){errors.push({feedId:feed.id,error:String(error.message||error)});feedResults[feed.id]={status:'failed'};}
  }
  candidates.sort((a,b)=>Number(b.familyHint)-Number(a.familyHint)||a.date.localeCompare(b.date)||a.title.localeCompare(b.title));
  const series=groupSeries(candidates);
  return {state:next,report:{generatedFor:today,feeds:next.feeds,feedResults,errors,
    summary:{candidates:candidates.length,new:candidates.filter(item=>item.status==='new').length,
      familyHints:candidates.filter(item=>item.familyHint).length,series:series.length,
      familySeries:series.filter(item=>item.familyHint).length},series,candidates}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const date=process.argv.find(arg=>arg.startsWith('--date='))?.slice(7)||swissDate(new Date());
  const catalog=loadCatalog();
  if(!validDate(date))throw Error('Use --date=YYYY-MM-DD');
  const stateFile=path.join(root,'editorial/discovery-state.json');
  const state=await readJson(stateFile,{schema:1,feeds:{},seen:{}});
  const aliases=(await readJson(path.join(root,'editorial/discovery-aliases.json'),{aliases:[]})).aliases;
  const result=await discover({today:date,state,records:catalog.ACTIVITIES,aliases});
  if(Object.values(result.report.feedResults).every(feed=>feed.status==='failed'))throw Error('All discovery feeds failed');
  await atomicJson(stateFile,result.state);
  const output=path.join(root,'editorial/discovery-report.json');
  await atomicJson(output,result.report);
  console.log(JSON.stringify({output,...result.report.summary,errors:result.report.errors},null,2));
}
