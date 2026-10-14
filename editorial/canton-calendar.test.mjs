import test from 'node:test';
import assert from 'node:assert/strict';
import {agendaLinks,calendarLink,readCantonalCalendar,microdataEvent} from './canton-calendar.mjs';
import {extractEvents,calendarTitles,discover} from './discover-events.mjs';

const feed={id:'canton',type:'cantonal-agenda',url:'https://www.fr.ch/evenements',hosts:['www.fr.ch']};
const url='https://www.fr.ch/mhnf/evenements/workshop';
const agenda='<div class="container__results"><div class="element-list"><a class="article__embed" href="/mhnf/evenements/workshop">Atelier</a></div></div>';
const detail='<a href="/add-to-calendar/42">Calendrier</a>';
const ics=`BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART:20261003T093000\nSUMMARY:Atelier parents-enfants\nURL:${url}\nEND:VEVENT\nEND:VCALENDAR\n`;
const response=text=>({ok:true,headers:new Headers(),text:async()=>text});
const fetchImpl=async target=>response(target===feed.url?agenda:target===url?detail:ics);
test('cantonal agenda keeps only official event and pagination identities',()=>{
  assert.deepEqual(agendaLinks(agenda+'<a href="?page=1">1</a><a href="?page=2">2</a>',feed.url),{events:[url],pages:[feed.url,feed.url+'?page=2']});
  assert.equal(calendarLink(detail,url),'https://www.fr.ch/add-to-calendar/42');
  assert.throws(()=>agendaLinks('<p>Blocked</p>',feed.url),/not an empty/);
  assert.throws(()=>agendaLinks(agenda.replace('/mhnf/evenements/workshop','https://example.org/evenements/wrong'),feed.url),/host/);
});
test('cantonal calendar records unresolved floating time and exact download provenance',async()=>{
  const result=await readCantonalCalendar(feed,{fetchImpl,today:'2026-10-02',parseCalendar:extractEvents,titleAnchors:calendarTitles});
  assert.equal(result.events[0].timeUnresolved,true);assert.equal(result.events[0].start,'');
  assert.equal(result.events[0].calendarSource,'https://www.fr.ch/add-to-calendar/42');
  assert.equal(result.coverage.complete,true);assert.equal(result.coverage.inspected,1);
  const report=await discover({feedList:[feed],fetchImpl,today:'2026-10-02',records:[]});
  assert.equal(report.report.candidates[0].status,'baseline');assert.equal(report.report.feedResults.canton.status,'success');
});
test('partial detail failures cannot be reported as complete coverage or erase valid candidates',async()=>{
  const more=agenda.replace('</div></div>','<a class="article__embed" href="/mhnf/evenements/blocked">Blocked</a></div></div>');
  const result=await readCantonalCalendar(feed,{today:'2026-10-02',parseCalendar:extractEvents,titleAnchors:calendarTitles,
    fetchImpl:async target=>{if(target.endsWith('/blocked'))throw Error('offline');return target===feed.url?response(more):fetchImpl(target);}});
  assert.equal(result.coverage.complete,false);assert.equal(result.issues.length,1);assert.equal(result.events.length,1);
});
test('calendar downloads cannot silently switch offer identity',async()=>{
  await assert.rejects(()=>readCantonalCalendar(feed,{today:'2026-10-02',parseCalendar:extractEvents,titleAnchors:calendarTitles,
    fetchImpl:async target=>target.endsWith('/42')?response(ics.replace(url,'https://www.fr.ch/mhnf/evenements/other')):fetchImpl(target)}),/No cantonal/);
});
const structured=detail+'<h1>Atelier parents-enfants</h1><meta itemprop="name" content="Atelier parents-enfants"><meta itemprop="startDate" content="2026-10-03T09:30"><meta itemprop="endDate" content="2026-10-03T11:45">';
test('malformed ICS uses structured HTML without repairing quotes or guessing a local timezone',async()=>{
  const result=await readCantonalCalendar(feed,{today:'2026-10-02',parseCalendar:extractEvents,titleAnchors:calendarTitles,
    familyHint:text=>/parents/.test(text),fetchImpl:async target=>response(target===feed.url?agenda:target===url?structured:'malformed calendar')});
  assert.equal(result.events[0].date,'2026-10-03');assert.equal(result.events[0].sourceStart,'2026-10-03T09:30');
  assert.equal(result.events[0].start,'');assert.equal(result.events[0].timeUnresolved,true);
  assert.equal(result.events[0].calendarSource,null);assert.equal(result.events[0].familyHint,true);
  assert.equal(result.warnings.length,1);assert.equal(result.coverage.complete,true);
});
test('structured fallback rejects invalid dates and cannot read dates from navigation',()=>{
  assert.throws(()=>microdataEvent(structured.replace('2026-10-03T09:30','2026-02-30T09:30'),feed,url,'2026-10-02'),/date/);
  assert.throws(()=>microdataEvent(structured+'<meta itemprop="startDate" content="2026-10-05T12:00">',feed,url,'2026-10-02'),/ambiguous/);
  assert.throws(()=>microdataEvent(structured.replace('<h1>Atelier parents-enfants</h1>','<h1>Other page</h1>'),feed,url,'2026-10-02'),/identity/);
  assert.deepEqual(microdataEvent(structured+'<meta itemprop="eventStatus" content="https://schema.org/EventCancelled">',feed,url,'2026-10-02'),[]);
});
