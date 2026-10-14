import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {snapshot} from './evidence.mjs';
import {calendarEvidence,calendarSchedule} from './calendar-evidence.mjs';
import {readPolicy,runShadow} from './typesafe.mjs';

const now='2026-10-01T12:00:00Z',feed='https://tockify.com/api/feeds/ics/example';
const link='https://tockify.com/example/detail/697/1791012600000/2';
const record={id:'example',name:'Café · Farvagny',town:'Farvagny',status:'active',format:'event',address:'',
  min:null,parent:'unknown',priceKind:'unknown',languages:[],events:[{date:'2026-10-03',start:'09:30',end:'11:00'}],
  sources:[{url:feed},{url:link}]};
const event=(url=link,title='Café Parents-Enfants',start='20261003T073000Z',end='20261003T090000Z',extra='')=>
  `BEGIN:VEVENT\r\nUID:${url}\r\nURL:${url}\r\nSUMMARY:${title}\r\nDTSTART:${start}\r\nDTEND:${end}\r\nLOCATION:Farvagny\r\n${extra}END:VEVENT\r\n`;
const raw=(events=event(),fetchedAt=now)=>snapshot({url:feed,fetchedAt,parser:'calendar-raw-v1',contentType:'text/calendar',
  text:'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'+events+'END:VCALENDAR\r\n'});

test('calendar scoping keeps the exact series and converts UTC to Swiss time before judgment',()=>{
  const other='https://tockify.com/example/detail/697/1800000000000/3';
  const unrelated='https://tockify.com/example/detail/999/1800000000000';
  const source=raw(event()+event(other,'Atelier Alimentation')+event(unrelated,'Another town'));
  const result=calendarEvidence(source,record);
  assert.equal(result.events.length,1);assert.deepEqual(result.events[0].start,{date:'2026-10-03',time:'09:30'});
  assert.equal(calendarSchedule(record,result.events),'supports');assert.doesNotMatch(result.evidence.text,/Another town|Atelier Alimentation/);
  assert.match(result.evidence.text,new RegExp(source.id));assert.match(result.evidence.text,/not verbatim/);
});
test('calendar comparison distinguishes changed times, missing dates and cancellations',()=>{
  const events=calendarEvidence(raw(),record).events;
  assert.equal(calendarSchedule({...record,events:[{date:'2026-10-03',start:'09:00',end:'11:00'}]},events),'contradicts');
  assert.equal(calendarSchedule({...record,events:[...record.events,{date:'2026-11-03',start:'09:30'}]},events),'not_stated');
  assert.equal(calendarSchedule(record,calendarEvidence(raw(event(link,undefined,undefined,undefined,'STATUS:CANCELLED\r\n')),record).events),'contradicts');
});
test('Swiss winter time is converted explicitly and unanchored or floating calendars are refused',()=>{
  const result=calendarEvidence(raw(event(link,undefined,'20261025T083000Z','20261025T100000Z')),record);
  assert.deepEqual(result.events[0].start,{date:'2026-10-25',time:'09:30'});
  assert.throws(()=>calendarEvidence(raw(event()),{...record,sources:[{url:feed}]}),/scope/);
  assert.throws(()=>calendarEvidence(raw(event(link,undefined,'20261003T073000','20261003T090000')),record),/timezone/);
});
test('two sessions on one date match their own times; unexpanded recurrence is not confirmed',()=>{
  const second='https://tockify.com/example/detail/697/1791016200000/2';
  const events=calendarEvidence(raw(event()+event(second,undefined,'20261003T084500Z','20261003T094500Z')),record).events;
  assert.equal(calendarSchedule(record,events),'supports');
  assert.equal(calendarSchedule({...record,events:[{date:'2026-10-03',start:'10:45',end:'11:45'}]},events),'supports');
  assert.equal(calendarSchedule(record,calendarEvidence(raw(event(link,undefined,undefined,undefined,'RRULE:FREQ=WEEKLY\r\n')),record).events),'not_stated');
});
test('calendar schedule rows use code, remain advisory and cannot bypass freshness',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-calendar-shadow-'));
  const policy={...await readPolicy(),maxSourcesPerRun:1};
  let calls=0;const client={systemOne:async()=>{calls++;throw Error('Must not call for a calendar-only schedule');}};
  try{
    const args={records:[record],sources:[],monitor:{},policy,client,directory,now,acquireImpl:async()=>raw()};
    const report=await runShadow(args),row=report.rows[0];
    assert.equal(row.answer.choice,'supports');assert.equal(row.engine,'deterministic-calendar-v1');
    assert.equal(row.route,'editor-review');assert.equal(row.automaticPublication,false);assert.equal(row.answer.confidence,null);
    const stale=await runShadow({...args,ids:new Set(['example']),acquireImpl:async()=>raw(event(),'2026-09-01T12:00:00Z')});
    assert.equal(stale.rows[0].status,'stale-evidence');assert.equal(calls,0);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
