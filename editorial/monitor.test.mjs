import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {runMonitor,normalize,rebaseline,issue,decodeBytes,acceptLanguage,normUrl,redirectClass,isChallenge,due,main} from './monitor.mjs';

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

const long='<main><h1>ElKi</h1><p>Mittwoch 10:00 im Gemeindesaal, Kosten CHF 20 pro Kurs.</p></main>';
const replyAt=(body,url)=>{const response=new Response(body,{headers:{'content-type':'text/html'}});Object.defineProperty(response,'url',{value:url});return response;};
test('decodeBytes honours header and meta charsets and falls back to windows-1252',()=>{
  const latin=Buffer.from('Ferm\xe9 le dimanche','latin1');
  assert.equal(decodeBytes(latin,'text/html; charset=iso-8859-1'),'Fermé le dimanche');
  assert.equal(decodeBytes(Buffer.concat([Buffer.from('<meta charset="windows-1252">'),latin]),'text/html').endsWith('Fermé le dimanche'),true);
  assert.equal(decodeBytes(latin,'text/html'),'Fermé le dimanche');
  assert.equal(decodeBytes(Buffer.from('Fermé','utf8'),'text/html'),'Fermé');
  assert.equal(decodeBytes(Buffer.from([0x80,0x41]),'text/html; charset=utf-8'),'€A');
  assert.equal(decodeBytes(latin,'text/html').includes('�'),false);
});
test('Accept-Language follows the language segment of the path',async()=>{
  assert.match(acceptLanguage('https://example.org/de/kurse'),/^de-CH,de;q=0.9,fr;q=0.5$/);
  assert.match(acceptLanguage('https://example.org/fr-ch/cours'),/^fr-CH,fr;q=0.9,de;q=0.5$/);
  assert.match(acceptLanguage('https://example.org/kurse'),/^de-CH,de;q=0\.9,fr-CH,fr;q=0\.8$/);
  let seen;const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[{...source,url:'https://example.org/fr/cours'}],state,now:'2026-09-24T00:00:00Z',fetchImpl:async(_u,o)=>{seen=o.headers['accept-language'];return reply(page());}});
  assert.equal(seen,'fr-CH,fr;q=0.9,de;q=0.5');
});
test('a challenge page is a source outage and never replaces the baseline',async()=>{
  assert.equal(isChallenge('Just a moment...'),true);
  assert.equal(isChallenge('Checking your browser before accessing'),true);
  assert.equal(isChallenge('Normale Seite',''),false);
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,now:'2026-09-24T00:00:00Z',fetchImpl:async()=>reply(page())});
  const before={...state.sources.course};
  await runMonitor({sources:[source],state,force:true,now:'2026-09-25T00:00:00Z',fetchImpl:async()=>reply('<html><body><main><p>Just a moment... Checking your browser before accessing the site, please wait a few seconds.</p></main></body></html>')});
  assert.equal(state.sources.course.hash,before.hash);assert.equal(state.sources.course.version,before.version);
  assert.deepEqual(state.queue.map(q=>q.kind),['source-unavailable']);
  const viaUrl={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state:viaUrl,now:'2026-09-24T00:00:00Z',fetchImpl:async()=>reply(page())});
  await runMonitor({sources:[source],state:viaUrl,force:true,now:'2026-09-25T00:00:00Z',fetchImpl:async()=>replyAt(page('CHF 99'),'https://example.org/js_challenge.html?redirect=/course')});
  assert.equal(viaUrl.sources.course.hash,before.hash);
  assert.equal(viaUrl.sources.course.finalUrl,'https://example.org/course');
  assert.deepEqual(viaUrl.queue.map(q=>q.kind),['source-unavailable']);
});
test('normUrl ignores www, trailing slash and hash but keeps the query',()=>{
  assert.equal(normUrl('https://www.haragati.com/'),normUrl('https://haragati.com'));
  assert.equal(normUrl('https://maison-petite-enfance.ch/infos'),normUrl('https://maison-petite-enfance.ch/infos/#top'));
  assert.notEqual(normUrl('https://example.org/a?x=1'),normUrl('https://example.org/a'));
});
test('the nine real redirects are classified as planned',()=>{
  const cases=[
    ['https://www.myswitzerland.com/de/erlebnisse/essen-trinken/restaurant/mcdonalds-restaurant-16/','https://www.myswitzerland.com/de-ch/erlebnisse/essen-trinken/restaurant/mcdonalds-restaurant-16/','path',true],
    ['https://fri-memoria.bcu-fribourg.ch/uploads/r/bcu-fribourg/3/e/0/3e01/Echo_Nr._09.pdf','https://fri-memoria.bcu-fribourg.ch/js_challenge.html?redirect=/uploads/r/bcu-fribourg/3/e/0/3e01/Echo_Nr._09.pdf','challenge',true],
    ['https://www.haragati.com/','https://haragati.com/',null,false],
    ['https://kaisereggbahnen-schwarzsee.ch/angebot/riggli-weg/','https://kaisereggbahnen-schwarzsee.ch/fr/angebot/riggli-weg/','language',true],
    ['https://kaisereggbahnen-schwarzsee.ch/angebot/kinderspielplatze/','https://kaisereggbahnen-schwarzsee.ch/fr/angebot/kinderspielplatze/','language',true],
    ['https://kaisereggbahnen-schwarzsee.ch/angebot/sommer-rodelbahn/','https://kaisereggbahnen-schwarzsee.ch/fr/angebot/sommer-rodelbahn/','language',true],
    ['https://laruche.fun/activites/kids-park/','https://laruche.fun/activites__trashed/kids-park/','trashed',true],
    ['https://maison-petite-enfance.ch/infos','https://maison-petite-enfance.ch/infos/',null,false],
    ['https://www.heitenried.ch/_doc/6343472','https://www.heitenried.ch/_docn/6343472/Botschaft_zur_Gemeindeversammlung.pdf','path',true]];
  for(const [from,to,klass,changed] of cases){
    assert.equal(normUrl(from)!==normUrl(to),changed,from);
    if(changed)assert.equal(redirectClass(from,to),klass,from);
  }
  assert.equal(redirectClass('https://a.ch/x','https://b.ch/x'),'domain');
  assert.equal(redirectClass('https://a.ch/x','https://a.ch/404'),'not-found');
});
test('a changed final URL creates one redirect-changed task, www and slash differences do not',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,now:'2026-09-24T00:00:00Z',fetchImpl:async()=>replyAt(page(),'https://example.org/course')});
  await runMonitor({sources:[source],state,force:true,now:'2026-09-25T00:00:00Z',fetchImpl:async()=>replyAt(page(),'https://www.example.org/course/')});
  assert.equal(state.queue.length,0);
  await runMonitor({sources:[source],state,force:true,now:'2026-09-26T00:00:00Z',fetchImpl:async()=>replyAt(page(),'https://example.org/course__trashed')});
  const task=state.queue.find(q=>q.kind==='redirect-changed');
  assert.equal(task.details.class,'trashed');assert.equal(task.details.from,'https://www.example.org/course/');
  assert.equal(state.sources.course.redirect.class,'trashed');
  await runMonitor({sources:[source],state,force:true,now:'2026-09-27T00:00:00Z',fetchImpl:async()=>replyAt(page(),'https://example.org/course__trashed')});
  assert.equal(state.queue.filter(q=>q.kind==='redirect-changed').length,1);
});
test('failing sources are retried after 1, 2 and 4 days, capped at the interval',()=>{
  const day=86400000,at=n=>new Date(Date.parse('2026-10-01T00:00:00Z')+n*day).toISOString();
  const entry=errorCount=>({lastAttempt:at(0),errorCount});
  const s30={intervalDays:30},s3={intervalDays:3};
  assert.equal(due(entry(1),s30,at(0.9)),false);assert.equal(due(entry(1),s30,at(1)),true);
  assert.equal(due(entry(2),s30,at(1.9)),false);assert.equal(due(entry(2),s30,at(2)),true);
  assert.equal(due(entry(3),s30,at(3.9)),false);assert.equal(due(entry(3),s30,at(4)),true);
  assert.equal(due(entry(9),s3,at(2.9)),false);assert.equal(due(entry(9),s3,at(3)),true);
  assert.equal(due(entry(0),s30,at(29)),false);assert.equal(due({},s30,at(0)),true);
});
test('parser-failed saves the extracted text and keeps the baseline',async()=>{
  const state={schema:1,sources:{},queue:[]},saved=[];
  await runMonitor({sources:[source],state,now:'2026-09-24T00:00:00Z',fetchImpl:async()=>reply(page())});
  const hash=state.sources.course.hash;
  await runMonitor({sources:[source],state,force:true,now:'2026-09-25T00:00:00Z',snapshotFailed:async(id,label,text)=>saved.push({id,label,text}),fetchImpl:async()=>reply(long.replace('ElKi','Other'))});
  assert.equal(state.queue[0].kind,'parser-failed');
  assert.equal(saved.length,1);assert.match(saved[0].label,/^failed-[0-9a-f]{12}$/);assert.match(saved[0].text,/Gemeindesaal/);
  assert.equal(state.sources.course.lastFailedText,saved[0].label);assert.equal(state.sources.course.hash,hash);
  await runMonitor({sources:[source],state,force:true,now:'2026-09-26T00:00:00Z',fetchImpl:async()=>reply(page())});
  assert.equal(state.sources.course.lastFailedText,null);
});
test('repeated issues merge: content-changed keeps the first baseline, alarm lines are appended once',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,now:'2026-09-24T00:00:00Z',fetchImpl:async()=>reply(page())});
  const first=state.sources.course;
  await runMonitor({sources:[source],state,force:true,now:'2026-09-25T00:00:00Z',fetchImpl:async()=>reply(page('CHF 35'))});
  await runMonitor({sources:[source],state,force:true,now:'2026-09-26T00:00:00Z',fetchImpl:async()=>reply(page('CHF 40'))});
  const task=state.queue[0];
  assert.equal(task.occurrences,2);
  assert.notEqual(task.details.firstFrom,task.details.from);
  assert.equal(task.details.firstFrom.slice(0,12),task.details.firstOldVersion);
  assert.equal(task.details.firstOldVersion,first.version);
  assert.equal(task.details.newVersion,state.sources.course.version);
});
test('flags: --dry-run writes nothing, a real run honours --state, --max and --host-delay-ms',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-cli-'));
  const hits=[];
  const server=http.createServer((req,res)=>{hits.push({url:req.url,at:Date.now(),lang:req.headers['accept-language']});res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page());});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const sources=['a','b','c'].map(id=>({id,url:`${base}/${id}`,type:'html',recordIds:[],intervalDays:1,minChars:10,required:['ElKi']}));
    await fs.writeFile(path.join(dir,'source-watch.json'),JSON.stringify({sources}));
    const out=await main(['--dry-run','--host-delay-ms=0'],dir);
    assert.equal(out.dryRun,true);assert.equal(out.results.length,3);
    assert.deepEqual(await fs.readdir(dir),['source-watch.json']);
    const custom=path.join(dir,'sub','state.json');
    hits.length=0;
    const real=await main([`--state=${custom}`,'--max=2','--host-delay-ms=150'],dir);
    assert.deepEqual(real.results.map(r=>r.result),['baseline','baseline','skipped-max']);
    assert.equal(hits.length,2);assert.ok(hits[1].at-hits[0].at>=120);
    const saved=JSON.parse(await fs.readFile(custom,'utf8'));
    assert.equal(saved.sources.a.version.length,12);
    await assert.rejects(fs.access(path.join(dir,'monitor-state.json')));
    assert.equal((await fs.readdir(path.join(dir,'versions'))).length,2);
  }finally{server.close();await fs.rm(dir,{recursive:true,force:true});}
});
