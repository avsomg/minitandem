import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalUrl,extractEvents,compareEvents,groupSeries,discover} from './discover-events.mjs';

const feed={id:'city',url:'https://www.ville-fribourg.ch/agenda.ics',hosts:['www.ville-fribourg.ch']};
const ics=`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:music-1\r\nDTSTART;VALUE=DATE:20260929\r\nDTEND;VALUE=DATE:20260930\r\nSUMMARY:Musik entdecken\r\nDESCRIPTION:Für Kinder und Eltern - https://www.ville-fribourg.ch/agenda/musik-\r\n entdecken-2\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:other-1\r\nDTSTART;VALUE=DATE:20260930\r\nSUMMARY:Adult meeting\r\nDESCRIPTION:https://www.ville-fribourg.ch/agenda/adult-meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

test('official calendar parser unfolds URLs and retains uncertain events',()=>{
  const events=extractEvents(ics,feed,'2026-09-28');
  assert.equal(events.length,2);
  assert.equal(events[0].url,'https://www.ville-fribourg.ch/agenda/musik-entdecken-2');
  assert.equal(events[0].date,'2026-09-29');
  assert.equal(events[0].familyHint,true);
  assert.equal(events[1].familyHint,false);
});
test('explicit parent-child description flags a family lead even without an age-related title',()=>{
  const source=ics.replace('SUMMARY:Musik entdecken','SUMMARY:C’est quoi grandir ?');
  assert.equal(extractEvents(source,feed,'2026-09-28')[0].familyHint,true);
});
test('first inspection after incomplete coverage is not a newly published event',()=>{
  const events=extractEvents(ics,feed,'2026-09-28');
  const state={schema:1,feeds:{city:{lastSuccess:'2026-09-27T00:00:00Z',coverage:{complete:false}}},seen:{}};
  assert.equal(compareEvents(events,[],state,'2026-09-28').candidates[0].status,'baseline');
});
test('cancelled events are ignored and an adult atelier is not assumed to be for children',()=>{
  const source=`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:cancelled\r\nDTSTART;VALUE=DATE:20261001\r\nSUMMARY:Musik für Kinder\r\nSTATUS:CANCELLED\r\nURL:https://www.ville-fribourg.ch/agenda/cancelled\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:adult\r\nDTSTART;VALUE=DATE:20261002\r\nSUMMARY:Atelier fiscalité\r\nURL:https://www.ville-fribourg.ch/agenda/adult\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:family\r\nDTSTART;VALUE=DATE:20261003\r\nSUMMARY:Atelier créatif\r\nDESCRIPTION:Pour enfants accompagnés de leurs parents\r\nURL:https://www.ville-fribourg.ch/agenda/family\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const events=extractEvents(source,feed,'2026-09-28');
  assert.deepEqual(events.map(event=>event.uid),['adult','family']);
  assert.equal(events[0].familyHint,false);
  assert.equal(events[1].familyHint,true);
});

test('known event dates are not candidates but new occurrences are',()=>{
  const events=extractEvents(ics,feed,'2026-09-28');
  const record={id:'music',sources:[{url:events[0].url}],events:[{date:'2026-09-29'}]};
  const state={schema:1,feeds:{city:{lastSuccess:'2026-09-27T00:00:00Z'}},seen:{}};
  const result=compareEvents(events,[record],state,'2026-09-28T00:00:00Z');
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].status,'new');
  const next={...events[0],date:'2026-10-06'};
  const later=compareEvents([next],[record],state,'2026-09-29T00:00:00Z');
  assert.deepEqual(later.candidates[0].matchedRecordIds,['music']);
});
test('an already listed self-guided exhibition is not a new calendar meeting',()=>{
  const event={feedId:'city',date:'2026-09-29',title:'Exhibition',url:'https://www.ville-fribourg.ch/agenda/exhibition',
    identity:'https://www.ville-fribourg.ch/agenda/exhibition',familyHint:true};
  const record={id:'exhibition',format:'self',scheduleValidThrough:'2026-10-17',events:[],sources:[{url:event.url}]};
  const result=compareEvents([event],[record],{schema:1,feeds:{},seen:{}},'2026-09-28');
  assert.equal(result.candidates.length,0);
});
test('a curated alias matches another official calendar without hiding a new date',()=>{
  const url='https://tockify.com/educationfamiliale/detail/785/1791012600000';
  const event={feedId:'aef',date:'2026-10-03',title:'Museum workshop',url,identity:canonicalUrl(url),familyHint:true};
  const record={id:'museum',events:[{date:'2026-10-03'}],sources:[{url:'https://www.fr.ch/mhnf/ateliers-parents-enfants'}]};
  const aliases=[{feedId:'aef',url,recordId:'museum'}];
  const first=compareEvents([event],[record],{schema:1,feeds:{},seen:{}},'2026-09-28',aliases);
  assert.equal(first.candidates.length,0);
  const later=compareEvents([{...event,date:'2026-10-10'}],[record],first.state,'2026-09-29',aliases);
  assert.deepEqual(later.candidates[0].matchedRecordIds,['museum']);
  assert.throws(()=>compareEvents([event],[record],first.state,'2026-09-29',[{...aliases[0],recordId:'missing'}]),/Invalid discovery alias/);
});

test('Tockify occurrence URLs share a stable programme identity',()=>{
  assert.equal(canonicalUrl('https://tockify.com/educationfamiliale/detail/755/1790665200000'),
    canonicalUrl('https://tockify.com/educationfamiliale/detail/755/1791270000000'));
  assert.equal(canonicalUrl('https://tockify.com/educationfamiliale/detail/755/1791270000000/2'),
    canonicalUrl('https://tockify.com/educationfamiliale/detail/755/1790665200000'));
  assert.equal(canonicalUrl('https://tockify.com/educationfamiliale/detail/755/1790665200000'),
    'https://tockify.com/educationfamiliale/detail/755');
});

test('previously seen Tockify occurrences keep their first-seen date after key normalization',()=>{
  const url='https://tockify.com/educationfamiliale/detail/755/1790665200000';
  const event={feedId:'aef',date:'2026-09-29',title:'Café',url,identity:canonicalUrl(url),familyHint:true};
  const oldKey=`aef|${url}|2026-09-29`;
  const state={schema:1,feeds:{aef:{lastSuccess:'2026-09-27'}},seen:{[oldKey]:{firstSeen:'2026-09-27',lastSeen:'2026-09-27'}}};
  const result=compareEvents([event],[],state,'2026-09-28');
  assert.equal(result.candidates[0].status,'pending');
  assert.equal(result.candidates[0].firstSeen,'2026-09-27');
  assert.equal(result.state.seen[oldKey],undefined);
});

test('first successful fetch is a baseline and failures do not advance a feed',async()=>{
  const response={ok:true,headers:new Headers({'content-length':String(ics.length)}),text:async()=>ics};
  const first=await discover({today:'2026-09-28',now:'2026-09-28T00:00:00Z',records:[],feedList:[feed],fetchImpl:async()=>response});
  assert.equal(first.report.summary.new,0);
  assert.equal(first.report.candidates[0].status,'baseline');
  const failed=await discover({today:'2026-09-28',state:first.state,records:[],feedList:[feed],fetchImpl:async()=>{throw Error('offline');}});
  assert.equal(failed.report.errors.length,1);
  assert.equal(failed.state.feeds.city.lastSuccess,'2026-09-28T00:00:00Z');
});

test('repeated dates form one research series without losing any occurrence',()=>{
  const base={feedId:'aef',identity:'https://tockify.com/educationfamiliale/detail/755',title:'Cafe',
    url:'https://tockify.com/educationfamiliale/detail/755/100',familyHint:true,matchedRecordIds:['aef-mpe']};
  const series=groupSeries([{...base,date:'2026-10-06',status:'pending'},
    {...base,date:'2026-10-13',status:'new'}]);
  assert.equal(series.length,1);
  assert.deepEqual(series[0].dates,['2026-10-06','2026-10-13']);
  assert.deepEqual(series[0].newDates,['2026-10-13']);
  assert.equal(series[0].status,'new');
});
test('different event names under one Tockify programme remain separate series',()=>{
  const base={feedId:'aef',identity:'https://tockify.com/educationfamiliale/detail/751',
    url:'https://tockify.com/educationfamiliale/detail/751/100',familyHint:true,matchedRecordIds:[],status:'pending'};
  const series=groupSeries([
    {...base,title:' Café Parents-Enfants à Attalens',date:'2026-10-07'},
    {...base,title:'Atelier Alimentation à Attalens',date:'2026-10-28'},
    {...base,title:'Café Parents-Enfants à Attalens ',date:'2026-11-04'}
  ]);
  assert.equal(series.length,2);
  assert.deepEqual(series.find(item=>item.title.includes('Café')).dates,['2026-10-07','2026-11-04']);
  assert.deepEqual(series.find(item=>item.title.includes('Atelier')).dates,['2026-10-28']);
});
test('same programme and date do not hide a different activity or a second session',()=>{
  const url='https://tockify.com/educationfamiliale/detail/751/1791356400000';
  const base={feedId:'aef',date:'2026-10-07',url,identity:canonicalUrl(url),familyHint:true};
  const events=[{...base,title:'Café parents',start:'09:00',end:'11:00'},
    {...base,title:'Atelier alimentation',start:'14:00',end:'15:00'}];
  const record={id:'cafe',events:[{date:'2026-10-07',start:'09:00',end:'11:00'}],sources:[{url}]};
  const result=compareEvents(events,[record],null,'2026-10-02');
  assert.equal(result.candidates.length,2,'Ambiguous identity must not suppress either event');
  const later={...events[0],start:'13:00',end:'15:00'};
  assert.equal(compareEvents([later],[record],null,'2026-10-02').candidates.length,1);
});
test('extraction retains simultaneous titles and unresolved floating dates',()=>{
  const source=`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261007T090000Z\r\nSUMMARY:Café parents\r\nURL:https://www.ville-fribourg.ch/agenda/shared\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261007T090000Z\r\nSUMMARY:Atelier enfants\r\nURL:https://www.ville-fribourg.ch/agenda/shared\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261008T100000\r\nSUMMARY:Floating time\r\nURL:https://www.ville-fribourg.ch/agenda/floating\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const events=extractEvents(source,feed,'2026-10-02');assert.equal(events.length,3);
  assert.equal(events[0].start,'11:00');assert.equal(events[2].timeUnresolved,true);
});
