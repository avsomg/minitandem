import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runMonitor,normalize,rebaseline} from './monitor.mjs';

const source={id:'course',url:'https://example.org/course',type:'html',recordIds:['card-a','card-b'],intervalDays:1,minChars:10,required:['ElKi']};
const page=(price='CHF 20',schedule='Mittwoch 10:00')=>`<html><nav>Changing menu</nav><main><h1>ElKi</h1><p>${price}</p><p>${schedule}</p></main><footer>Counter ${Math.random()}</footer></html>`;
const reply=(body,status=200)=>new Response(body,{status,headers:{'content-type':'text/html'}});
test('a baseline and unchanged page do not refresh editorial review or create tasks',async()=>{
  const state={schema:1,sources:{},queue:[]};
  const first=await runMonitor({sources:[source],state,now:'2026-09-24T00:00:00Z',fetchImpl:async()=>reply(page())});
  assert.equal(first.results[0].result,'baseline');
  const again=await runMonitor({sources:[source],state,force:true,now:'2026-09-25T00:00:00Z',fetchImpl:async()=>reply(page())});
  assert.equal(again.results[0].result,'unchanged');
  assert.equal(again.openTasks,0);
  assert.equal(state.sources.course.lastSuccess,'2026-09-25T00:00:00Z');
  assert.equal(state.sources.course.lastEditorialReview,undefined);
});
test('an unexpected 304 without a baseline does not pretend to restore the source',async()=>{
  const state={schema:1,sources:{},queue:[]};
  const report=await runMonitor({sources:[source],state,now:'2026-09-24T00:00:00Z',fetchImpl:async()=>reply(null,304)});
  assert.equal(report.results[0].result,'error');assert.equal(state.sources.course.lastSuccess,undefined);
  assert.equal(state.queue[0].status,'open');
});
test('price and removed schedule create one deduplicated editorial task linked to both cards',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,fetchImpl:async()=>reply(page()),now:'2026-09-24T00:00:00Z'});
  await runMonitor({sources:[source],state,force:true,fetchImpl:async()=>reply(page('CHF 35','Mittwoch 10:00')),now:'2026-09-25T00:00:00Z'});
  await runMonitor({sources:[source],state,force:true,fetchImpl:async()=>reply(page('CHF 35','')),now:'2026-09-26T00:00:00Z'});
  assert.equal(state.queue.length,1);
  assert.equal(state.queue[0].occurrences,2);
  assert.deepEqual(state.queue[0].recordIds,['card-a','card-b']);
  assert.equal(state.queue[0].status,'open');
});
test('two 404 failures open a task without altering the last good version',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,fetchImpl:async()=>reply(page()),now:'2026-09-24T00:00:00Z'});
  const hash=state.sources.course.hash;
  await runMonitor({sources:[source],state,force:true,fetchImpl:async()=>reply('missing',404),now:'2026-09-25T00:00:00Z'});
  assert.equal(state.queue.length,0);
  await runMonitor({sources:[source],state,force:true,fetchImpl:async()=>reply('missing',404),now:'2026-09-26T00:00:00Z'});
  assert.equal(state.queue[0].kind,'source-unavailable');
  assert.equal(state.sources.course.hash,hash);
});
test('a network failure after one 404 is reported without reusing the stale HTTP status',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,fetchImpl:async()=>reply('missing',404),now:'2026-09-24T00:00:00Z'});
  assert.equal(state.queue.length,0);
  await runMonitor({sources:[source],state,force:true,fetchImpl:async()=>{throw Error('network offline');},now:'2026-09-25T00:00:00Z'});
  assert.equal(state.queue[0].kind,'source-unavailable');
  assert.equal(state.queue[0].details.httpStatus,null);
});
test('empty extraction opens parser task, not a false content change',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,fetchImpl:async()=>reply(page()),now:'2026-09-24T00:00:00Z'});
  await runMonitor({sources:[source],state,force:true,fetchImpl:async()=>reply('<html><main></main></html>'),now:'2026-09-25T00:00:00Z'});
  assert.equal(state.queue[0].kind,'parser-failed');
  assert.equal(state.queue.filter(q=>q.kind==='content-changed').length,0);
});
test('source recovery resolves transport issues but never approves changed catalogue facts',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,fetchImpl:async()=>reply(page()),now:'2026-09-24T00:00:00Z'});
  await runMonitor({sources:[source],state,force:true,fetchImpl:async()=>reply(page('CHF 35')),now:'2026-09-25T00:00:00Z'});
  for(const now of ['2026-09-26T00:00:00Z','2026-09-27T00:00:00Z'])await runMonitor({sources:[source],state,force:true,fetchImpl:async()=>reply('missing',404),now});
  await runMonitor({sources:[source],state,force:true,fetchImpl:async()=>reply(page('CHF 35')),now:'2026-09-28T00:00:00Z'});
  assert.equal(state.queue.find(q=>q.kind==='source-unavailable').status,'resolved');
  assert.equal(state.queue.find(q=>q.kind==='content-changed').status,'open');
  assert.equal(state.sources.course.lastEditorialReview,undefined);
});
test('calendar transport stamps are ignored while event fields are watched',()=>{
  const a='BEGIN:VEVENT\nDTSTAMP:20260924T100000Z\nSUMMARY:ElKi\nDTSTART:20261001T100000\nEND:VEVENT';
  const b=a.replace('20260924T100000Z','20260925T100000Z');
  assert.equal(normalize(a,{type:'ics',minChars:10}),normalize(b,{type:'ics',minChars:10}));
  assert.notEqual(normalize(a,{type:'ics',minChars:10}),normalize(b.replace('DTSTART:20261001','DTSTART:20261002'),{type:'ics',minChars:10}));
});
test('AEF calendar watches only the next occurrence of selected programmes',async()=>{
  const watched={id:'aef',url:'https://example.org/aef.ics',type:'ics',recordIds:['aef-centre'],calendarName:'Agenda AEF',eventIds:['754'],minChars:20};
  const entry=(id,date,end,title)=>`BEGIN:VEVENT\nDTSTAMP:20260924T000000Z\nDTSTART:${date}\nDTEND:${end}\nSUMMARY:${title}\nURL:https://tockify.com/educationfamiliale/detail/${id}/1790000000000\nEND:VEVENT`;
  const feed=other=>`BEGIN:VCALENDAR\nX-WR-CALNAME:Agenda AEF\n${entry('754','20260924T070000Z','20260924T090000Z','Café Centre')}\n${entry('754','20261001T070000Z','20261001T090000Z','Café Centre')}\n${entry('999','20260925T070000Z','20260925T090000Z',other)}\nEND:VCALENDAR`;
  const replyIcs=value=>new Response(value,{headers:{'content-type':'text/calendar',etag:'"aef-version"'}});
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[watched],state,now:'2026-09-24T08:00:00Z',fetchImpl:async()=>replyIcs(feed('Other event'))});
  const first=state.sources.aef.hash;
  await runMonitor({sources:[watched],state,force:true,now:'2026-09-24T08:30:00Z',fetchImpl:async(_url,options)=>{assert.equal(options.headers['if-none-match'],undefined);return replyIcs(feed('Changed unrelated event'));}});
  assert.equal(state.sources.aef.hash,first);
  assert.equal(state.queue.length,0);
  await runMonitor({sources:[watched],state,force:true,now:'2026-09-24T09:30:00Z',fetchImpl:async()=>replyIcs(feed('Changed unrelated event'))});
  assert.notEqual(state.sources.aef.hash,first);
  assert.deepEqual(state.queue[0].recordIds,['aef-centre']);
  assert.equal(state.queue[0].kind,'content-changed');
});
test('parser scope changes require a documented rebaseline while preserving the previous version',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,fetchImpl:async()=>reply(page()),now:'2026-09-24T00:00:00Z'});
  const oldHash=state.sources.course.hash;
  assert.throws(()=>rebaseline(state,['course'],''),/requires --note/);
  rebaseline(state,['course'],'Narrowed the extractor to the course block','2026-09-25T00:00:00Z');
  assert.equal(state.sources.course.hash,undefined);
  assert.equal(state.sources.course.baselineHistory[0].hash,oldHash);
  const report=await runMonitor({sources:[{...source,start:'ElKi',end:'Mittwoch'}],state,force:true,fetchImpl:async()=>reply(page()),now:'2026-09-25T00:00:00Z'});
  assert.equal(report.results[0].result,'baseline');
  assert.equal(report.openTasks,0);
});
