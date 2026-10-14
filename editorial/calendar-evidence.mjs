import ICAL from 'ical.js';
import {canonicalUrl} from './discover-events.mjs';
import {snapshot,validateSnapshot} from './evidence.mjs';
import {swissStamp,withCalendarZones} from './calendar-time.mjs';

export function calendarEvidence(raw,record){
  validateSnapshot(raw);
  const calendar=new ICAL.Component(ICAL.parse(raw.text));
  if(calendar.name!=='vcalendar')throw Error('Expected VCALENDAR');
  return withCalendarZones(calendar,()=>{
    const links=new Set(record.sources.map(source=>source.url));
    const identities=new Set([...links].map(canonicalUrl).filter(Boolean));
    const events=calendar.getAllSubcomponents('vevent').map(component=>{
      const event=new ICAL.Event(component),url=component.getFirstPropertyValue('url');
      return {component,event,url,identity:canonicalUrl(url)};
    }).filter(item=>item.url&&identities.has(item.identity));
    // An exact occurrence anchors the series title: Tockify reuses IDs for different workshops.
    const anchors=events.filter(item=>links.has(item.url));
    const titles=new Set(anchors.map(item=>item.event.summary));
    if(titles.size!==1)throw Error('Calendar activity scope is unresolved');
    const selected=events.filter(item=>titles.has(item.event.summary)).map(({component,event,url})=>({
      url,title:event.summary,description:event.description||'',location:event.location||'',
      start:swissStamp(event.startDate),end:component.hasProperty('dtend')?swissStamp(event.endDate):null,
      cancelled:String(component.getFirstPropertyValue('status')||'').toUpperCase()==='CANCELLED',
      recurrenceUnexpanded:component.hasProperty('rrule')
    }));
    if(!selected.length)throw Error('No exact calendar events');
    const text=JSON.stringify({provenance:{sourceSnapshotId:raw.id,parser:'ical.js',timeZone:'Europe/Zurich',
      interpretation:'Selected source events; dates and times converted by code, not verbatim source quotations.'},events:selected},null,2);
    return {events:selected,evidence:snapshot({url:raw.url,finalUrl:raw.finalUrl,fetchedAt:raw.fetchedAt,
      parser:'calendar-selected-zurich-v1',contentType:'application/json',text,rawHash:raw.rawHash})};
  });
}

export function calendarSchedule(record,events){
  const comparisons=(record.events||[]).map(published=>{
    const dated=events.filter(event=>event.start?.date===published.date&&!event.recurrenceUnexpanded);
    const timed=published.start?dated.filter(event=>event.start.time===published.start):[];
    const found=timed.length?timed:dated;
    if(found.length!==1)return 'not_stated';
    const source=found[0];
    if(source.cancelled)return 'contradicts';
    if(published.start&&source.start.time!==published.start)return source.start.time?'contradicts':'not_stated';
    if(published.end&&(!source.end||!source.end.time))return 'not_stated';
    if(published.end&&(source.end.date!==published.date||source.end.time!==published.end))return 'contradicts';
    return 'supports';
  });
  return comparisons.includes('contradicts')?'contradicts':
    comparisons.length&&comparisons.every(value=>value==='supports')?'supports':'not_stated';
}
