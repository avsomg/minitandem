import {load} from 'cheerio';
import {validDate} from './field-contract.mjs';

const origin='https://www.fr.ch';
function sameHost(value,base){
  const url=new URL(value,base);
  if(url.origin!==origin)throw Error('Unexpected cantonal calendar host');
  return url;
}
export function agendaLinks(html,url){
  const $=load(html),events=new Set(),pages=new Set();
  const entries=$('.container__results .element-list a.article__embed');
  if(!entries.length)throw Error('Cantonal agenda structure unavailable; not an empty calendar');
  entries.each((_,element)=>{
    const link=sameHost($(element).attr('href'),url);
    if(!link.pathname.includes('/evenements/'))throw Error('Unexpected event identity');
    events.add(link.href);
  });
  $('a[href]').each((_,element)=>{
    const href=$(element).attr('href');
    if(!href?.includes('page='))return;
    const link=sameHost(href,url),page=link.searchParams.get('page');
    if(link.pathname!=='/evenements'||!/^\d+$/.test(page||''))return;
    if(Number(page)<=1)link.search='';
    else link.search='?page='+Number(page);
    pages.add(link.href);
  });
  return {events:[...events],pages:[...pages]};
}
export function calendarLink(html,url){
  const $=load(html),links=$('a[href]').map((_,element)=>$(element).attr('href')).get()
    .filter(href=>/^\/add-to-calendar\/\d+$/.test(href));
  if(new Set(links).size!==1)throw Error('Missing or ambiguous official calendar download');
  return sameHost(links[0],url).href;
}
export function microdataEvent(html,feed,url,today,{familyHint=()=>false}={}){
  const $=load(html),starts=$('meta[itemprop="startDate"]'),ends=$('meta[itemprop="endDate"]'),title=$('h1').text().trim();
  if(/(?:\/|#)EventCancelled$/.test($('meta[itemprop="eventStatus"]').attr('content')||''))return [];
  const named=$('meta[itemprop="name"]').toArray().some(element=>$(element).attr('content')===title);
  if(starts.length!==1||ends.length>1||!title||!named)throw Error('Missing or ambiguous structured event identity/date');
  const stamp=value=>{
    if(!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value||'')||!validDate(value.slice(0,10)))throw Error('Unsupported structured event date');
    return value;
  };
  const start=stamp(starts.attr('content')),end=ends.length?stamp(ends.attr('content')):null;
  if(end&&end<start)throw Error('Inverted structured event dates');
  const date=start.slice(0,10),horizon=new Date(Date.parse(today+'T12:00:00Z')+180*86400000).toISOString().slice(0,10);
  if(date<today||date>horizon)return [];
  const description=$('meta[itemprop="description"]').attr('content')||'';
  return [{feedId:feed.id,date,title,url,identity:url.replace(/\/+$/,'').toLowerCase(),uid:null,start:'',end:null,
    timeUnresolved:start.length>10,sourceStart:start,sourceEnd:end,sourceType:'cantonal-html-microdata-v1',
    familyHint:familyHint(title+' '+description),recurrenceUnexpanded:false}];
}
export async function readCantonalCalendar(feed,{fetchImpl=fetch,parseCalendar,titleAnchors,familyHint,today,maxPages=6,maxEvents=120}={}){
  const pending=[feed.url],visited=new Set(),details=new Set(),events=[],anchors=new Map(),issues=[],warnings=[];
  const read=async url=>{
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('HTTP '+response.status);
    if(response.url&&new URL(response.url).origin!==origin)throw Error('Unexpected calendar redirect');
    if(Number(response.headers.get('content-length'))>2_000_000)throw Error('Calendar response too large');
    const body=await response.text();if(body.length>2_000_000)throw Error('Calendar response too large');return body;
  };
  while(pending.length&&visited.size<maxPages){
    const url=pending.shift();if(visited.has(url))continue;visited.add(url);
    try{
      const links=agendaLinks(await read(url),url);
      for(const event of links.events)details.add(event);
      for(const page of links.pages)if(!visited.has(page)&&!pending.includes(page))pending.push(page);
    }catch(error){issues.push({url,error:error.message});}
  }
  if(pending.length)issues.push({url:feed.url,error:'Agenda pagination budget reached; coverage incomplete'});
  if(details.size>maxEvents)issues.push({url:feed.url,error:'Event download budget reached; coverage incomplete'});
  let inspected=0;
  for(const url of [...details].slice(0,maxEvents)){
    try{
      const html=await read(url);
      let selected,download=null;
      try{
        download=calendarLink(html,url);const ics=await read(download);selected=parseCalendar(ics,feed,today);
        if(selected.some(event=>event.url!==url))throw Error('Calendar download belongs to another event');
        for(const [identity,titles] of titleAnchors(ics))anchors.set(identity,titles);
      }catch(error){
        selected=microdataEvent(html,feed,url,today,{familyHint});
        warnings.push({url,calendarSource:download,error:error.message,fallback:'cantonal-html-microdata-v1'});
        for(const event of selected)anchors.set(url,new Set([event.title.toLocaleLowerCase().replace(/\s+/g,' ')]));
        download=null;
      }
      events.push(...selected.map(event=>({...event,calendarSource:download})));
      inspected++;
    }catch(error){issues.push({url,error:error.message});}
  }
  if(!inspected)throw Error('No cantonal event downloads could be inspected');
  return {events,anchors,issues,warnings,coverage:{pages:visited.size,listed:details.size,inspected,complete:issues.length===0}};
}
