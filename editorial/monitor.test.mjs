import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {runMonitor,normalize,rebaseline,issue,decodeBytes,acceptLanguage,normUrl,redirectClass,isChallenge,due,main,htmlTextV1,htmlTextV2,fullPageText,sourceAnchors,hostRules,dropIgnored} from './monitor.mjs';

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

// Step 4: parser v2, alarm lines over the full page, the parser rebaseline pass and spread due dates.
const sha256=text=>crypto.createHash('sha256').update(text).digest('hex');
const filler=(n,label='Traktandum')=>Array.from({length:n},(_,i)=>`<p>${label} ${i+1}: Genehmigung der Jahresrechnung und Bericht der Revisionsstelle, Abstimmung und Beschluss.</p>`).join('');
test('htmlTextV2 keeps the content v1 lost: price and schedule outside a thin main, header hours, article headers',()=>{
  const cristina=`<html><head><title>Cristina Danse</title></head><body><header><nav><a>Accueil</a><a>Contact</a></nav></header><main><h1>Danse</h1></main>
    <div class="content"><h2>Eveil à la danse 3-5 ans</h2><p>Prix&nbsp;: CHF 180.- par trimestre</p><p>Mercredi 14:00 - 14:45, salle de la Prillaz</p>
    <p>Les enfants découvrent le mouvement, le rythme et l&rsquo;espace en petits groupes, accompagnés par une enseignante diplômée.</p></div>
    <footer><p>Ce site utilise des cookies pour mesurer l'audience.</p></footer><script>var x='Prix secret';</script></body></html>`;
  const v1=htmlTextV1(cristina),v2=htmlTextV2(cristina);
  assert.doesNotMatch(v1,/CHF 180/);
  assert.match(v2,/Prix : CHF 180\.- par trimestre/);assert.match(v2,/Mercredi 14:00 - 14:45/);assert.match(v2,/l’espace/);
  assert.doesNotMatch(v2,/cookies|Prix secret|Accueil/);
  const club=`<body><header><div class="logo">Club Café Kerzers</div><p>Öffnungszeiten</p><p>Montag Ruhetag</p><p>Di-Fr 08:30 - 18:00</p><nav><a>Home</a></nav></header>
    <main><h1>Club Café</h1><p>Spielecke für Kinder, Wickeltisch und Kinderstühle. Familien sind willkommen.</p></main><footer><p>Cookies akzeptieren</p><p>Sa 09:00 - 16:00</p></footer></body>`;
  const clubV2=htmlTextV2(club);
  assert.doesNotMatch(htmlTextV1(club),/Ruhetag/);
  assert.match(clubV2,/Spielecke/);assert.match(clubV2,/Montag Ruhetag/);assert.match(clubV2,/Di-Fr 08:30 - 18:00/);assert.match(clubV2,/Sa 09:00 - 16:00/);
  assert.doesNotMatch(clubV2,/Cookies|Öffnungszeiten|Club Café Kerzers/);
  const article='<body><header><a>Logo</a></header><main><article><header><h2>Kerzenziehen 2026</h2><p>Anmeldung bis 1.11.</p></header><p>Für Familien mit Kindern ab 3 Jahren.</p></article></main><footer><p>Datenschutz und Cookies</p></footer></body>';
  const articleV2=htmlTextV2(article);
  assert.match(articleV2,/Kerzenziehen 2026\nAnmeldung bis 1\.11\.\nFür Familien/);
  assert.doesNotMatch(htmlTextV1(article),/Kerzenziehen/);
  assert.doesNotMatch(articleV2,/Cookies|Logo/);
  const bare='<html><body><div><h1>Ludothèque</h1><p>Mercredi 15:00-17:00</p><p>Jeux pour les petits dès 2 ans.</p></div><div role="contentinfo">Politique des cookies</div></body></html>';
  assert.equal(htmlTextV2(bare),'Ludothèque\nMercredi 15:00-17:00\nJeux pour les petits dès 2 ans.');
});
test('fullPageText reads title, description, header, navigation and footer but no scripts',()=>{
  const html='<html><head><title>Ludothèque Romont</title><meta name="description" content="Fermée du 20.12. au 5.1."><style>.x{}</style></head><body><header><p>Fermeture annuelle</p></header><nav>Menu</nav><main><p>Jeux</p></main><footer>Contact</footer><script>alert(1)</script></body></html>';
  assert.equal(fullPageText(html),'Ludothèque Romont\nFermée du 20.12. au 5.1.\nFermeture annuelle\nMenu\nJeux\nContact');
});

const krabbel={id:'krabbel',url:'https://example.org/krabbelgruppe',type:'html',recordIds:['krabbel-card'],intervalDays:7,minChars:10,required:['ElKi']};
const notice=(...lines)=>`<html><head><title>Krabbelgruppe</title></head><body><header><nav>Menu</nav></header><main><h1>ElKi</h1><p>CHF 20 pro Treffen</p><p>Mittwoch 10:00</p></main><footer>${lines.map(l=>`<p>${l}</p>`).join('')}<p>Kontakt</p></footer></body></html>`;
const at=day=>`2026-10-${String(day).padStart(2,'0')}T06:00:00.000Z`;
test('alarm lines: the first run stores a baseline, a new line opens a task with context, a repeat appends',async()=>{
  const state={schema:1,sources:{},queue:[]};
  const first=await runMonitor({sources:[krabbel],state,now:at(14),fetchImpl:async()=>reply(notice('Am 9.12.2026 fällt die Gruppe aus.'))});
  assert.equal(first.results[0].alarm,'baseline');
  assert.deepEqual(state.sources.krabbel.alarm.keys,['am 9.12.2026 fällt die gruppe aus.']);
  assert.equal(state.sources.krabbel.alarm.parser,'alarm-v1');assert.equal(state.sources.krabbel.parser,'v2');
  assert.equal(state.queue.length,0);
  await runMonitor({sources:[krabbel],state,force:true,now:at(15),fetchImpl:async()=>reply(notice('Am 9.12.2026 fällt die Gruppe aus.'))});
  assert.equal(state.queue.length,0);
  await runMonitor({sources:[krabbel],state,force:true,now:at(16),fetchImpl:async()=>reply(notice('Am 9.12.2026 fällt die Gruppe aus.','Die Krabbelgruppe ist bis auf Weiteres sistiert.'))});
  const task=state.queue.find(q=>q.kind==='possible-closure');
  assert.equal(task.details.parser,'alarm-v1');assert.equal(task.details.url,krabbel.url);
  assert.equal(task.details.lines.length,1);
  const line=task.details.lines[0];
  assert.equal(line.text,'Die Krabbelgruppe ist bis auf Weiteres sistiert.');assert.deepEqual(line.cats,['suspend']);assert.equal(line.strength,'strong');
  assert.ok(line.context.includes('Am 9.12.2026 fällt die Gruppe aus.')&&line.context.includes('Kontakt'));
  assert.deepEqual(task.recordIds,['krabbel-card']);
  await runMonitor({sources:[krabbel],state,force:true,now:at(17),fetchImpl:async()=>reply(notice('Die Krabbelgruppe ist bis auf Weiteres sistiert.','Neuer Termin: 16.12.2026'))});
  const again=state.queue.filter(q=>q.kind==='possible-closure');
  assert.equal(again.length,1);assert.equal(again[0].occurrences,2);
  assert.deepEqual(again[0].details.lines.map(l=>l.text),['Die Krabbelgruppe ist bis auf Weiteres sistiert.','Neuer Termin: 16.12.2026']);
  await runMonitor({sources:[krabbel],state,force:true,now:at(18),fetchImpl:async()=>reply(notice('Wiedereröffnung der Gruppe am 13. Januar'))});
  const reopen=state.queue.find(q=>q.kind==='possible-reopen');
  assert.deepEqual(reopen.details.lines.map(l=>l.cats),[['reopen']]);
  assert.equal(state.queue.filter(q=>q.kind==='possible-closure')[0].occurrences,2);
});
test('alarm lines are not compared on a challenge page or an HTTP error, and still checked when the parser fails',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[krabbel],state,now:at(14),fetchImpl:async()=>reply(notice())});
  await runMonitor({sources:[krabbel],state,force:true,now:at(15),fetchImpl:async()=>reply('<html><body>Just a moment... Die Gruppe ist bis auf Weiteres sistiert.</body></html>')});
  await runMonitor({sources:[krabbel],state,force:true,now:at(16),fetchImpl:async()=>reply('Die Gruppe ist bis auf Weiteres sistiert.',500)});
  assert.equal(state.queue.filter(q=>q.kind==='possible-closure').length,0);
  assert.deepEqual(state.sources.krabbel.alarm.keys,[]);
  await runMonitor({sources:[krabbel],state,force:true,now:at(17),fetchImpl:async()=>reply(notice('Die Gruppe ist bis auf Weiteres sistiert.').replace('ElKi','Treff'))});
  assert.deepEqual(state.queue.filter(q=>q.status==='open'&&q.kind!=='source-unavailable').map(q=>q.kind).sort(),['parser-failed','possible-closure']);
});
test('a line new on three pages of one host is rolled up as site-wide, and the fuse withholds a flood',async()=>{
  const sources=['a','b','c','d'].map(id=>({...krabbel,id,url:`https://www.portal.example/${id}`,recordIds:[id]}));
  const banner='Die Geschäftsstelle bleibt vom 24.12.2026 bis 2.1.2027 geschlossen.';
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources,state,now:at(14),fetchImpl:async()=>reply(notice())});
  const report=await runMonitor({sources:sources.slice(0,3),state,force:true,now:at(15),fetchImpl:async()=>reply(notice(banner))});
  const tasks=state.queue.filter(q=>q.kind==='possible-closure');
  assert.equal(tasks.length,3);
  for(const task of tasks)assert.deepEqual(task.details.siteWide,{host:'portal.example',sourceIds:['a','b','c'],keys:[banner.toLowerCase()]});
  assert.deepEqual(report.siteWide,[{host:'portal.example',key:banner.toLowerCase(),sourceIds:['a','b','c']}]);
  const fused={schema:1,sources:{},queue:[]};
  await runMonitor({sources,state:fused,now:at(14),fetchImpl:async()=>reply(notice())});
  const before=structuredClone(fused.sources);
  const tripped=await runMonitor({sources,state:fused,force:true,alarmFuse:3,now:at(15),fetchImpl:async(url)=>reply(notice(url.endsWith('/d')?'Saisonende am 30.11.2026':banner))});
  assert.equal(tripped.fuse.tripped,true);assert.equal(tripped.fuse.count,4);assert.equal(tripped.fuse.limit,3);
  assert.deepEqual(tripped.fuse.alarms.map(a=>[a.sourceId,a.kind,a.lines.length]),[['a','possible-closure',1],['b','possible-closure',1],['c','possible-closure',1],['d','possible-closure',1]]);
  assert.equal(fused.queue.filter(q=>q.kind.startsWith('possible-')).length,0);
  for(const id of ['a','b','c','d'])assert.deepEqual(fused.sources[id].alarm,before[id].alarm);
  const next=await runMonitor({sources,state:fused,force:true,now:at(16),fetchImpl:async(url)=>reply(notice(url.endsWith('/d')?'Saisonende am 30.11.2026':banner))});
  assert.equal(next.fuse.tripped,false);
  assert.equal(fused.queue.filter(q=>q.kind==='possible-closure').length,4);
});
test('long documents keep only alarm lines near anchors in the source language (German and French)',async()=>{
  const records=[
    {id:'krabbel-card',name:'Krabbelgruppe Sonnenschein · playgroup for toddlers',town:'Plaffeien',sources:[{url:'https://example.org/protokoll',label:'Official source'}]},
    {id:'ludo-card',name:'Ludothèque La Toupie · toy library',town:'Romont',sources:[{url:'https://example.org/bulletin',label:'Toupie Romont · organiser'}]}];
  const de={id:'protokoll',url:'https://example.org/protokoll',type:'html',recordIds:['krabbel-card'],intervalDays:30,required:['Traktandum 1:']};
  const fr={id:'bulletin',url:'https://example.org/bulletin',type:'html',recordIds:['ludo-card'],intervalDays:30,required:['Bulletin']};
  assert.deepEqual(sourceAnchors(de,records),['Traktandum 1:','Krabbelgruppe Sonnenschein','Plaffeien']);
  assert.deepEqual(sourceAnchors(fr,records),['Bulletin','Ludothèque La Toupie','Romont','Toupie Romont']);
  const deDoc=(extra='')=>`<main>${filler(120)}<p>Krabbelgruppe Sonnenschein</p><p>Treffen jeden Mittwoch im Pfarreisaal.</p>${extra?'<p>Die Gruppe fällt im ganzen November aus.</p>':''}${filler(40,'Punkt')}${extra?'<p>Die Turnhalle bleibt wegen Umbau ab 1.12.2026 geschlossen.</p>':''}${filler(40,'Absatz')}</main>`;
  const frDoc=(extra='')=>`<main><p>Bulletin communal</p>${filler(150,'Point')}<p>Ludothèque La Toupie</p><p>Jeux et jouets pour les familles.</p>${extra?'<p>La ludothèque sera fermée du 20.12.2026 au 5.1.2027.</p>':''}${filler(40,'Article')}${extra?'<p>Fermeture exceptionnelle de la déchetterie le 3.11.2026.</p><p>toy library</p>':''}${filler(40,'Divers')}</main>`;
  assert.ok(htmlTextV2(deDoc()).length>20000&&htmlTextV2(frDoc()).length>20000);
  const state={schema:1,sources:{},queue:[]};
  const pages={protokoll:deDoc,bulletin:frDoc};
  await runMonitor({sources:[de,fr],records,state,now:at(14),fetchImpl:async url=>reply(pages[url.split('/').pop()]())});
  await runMonitor({sources:[de,fr],records,state,force:true,now:at(15),fetchImpl:async url=>reply(pages[url.split('/').pop()](true))});
  const lines=Object.fromEntries(state.queue.filter(q=>q.kind==='possible-closure').map(q=>[q.sourceId,q.details.lines.map(l=>l.text)]));
  assert.deepEqual(lines,{protokoll:['Die Gruppe fällt im ganzen November aus.'],bulletin:['La ludothèque sera fermée du 20.12.2026 au 5.1.2027.']});
});
test('content-changed carries significance and the changed lines',async()=>{
  const versions=new Map(),state={schema:1,sources:{},queue:[]};
  const io={snapshot:async(id,hash,text)=>versions.set(`${id}/${hash.slice(0,12)}`,text),readVersion:async(id,version)=>versions.get(`${id}/${version}`)??null};
  const body=(price,extra='')=>`<main><h1>ElKi</h1><p>${price}</p><p>Wir freuen uns auf euch.</p>${extra}</main>`;
  await runMonitor({sources:[source],state,...io,now:at(14),fetchImpl:async()=>reply(body('CHF 20'))});
  await runMonitor({sources:[source],state,...io,force:true,now:at(15),fetchImpl:async()=>reply(body('CHF 20','<p>Diese Seite verwendet Cookies.</p>'))});
  let task=state.queue[0];
  assert.equal(task.details.significance,'low');assert.deepEqual(task.details.changedLines,{added:['Diese Seite verwendet Cookies.'],removed:[]});
  await runMonitor({sources:[source],state,...io,force:true,now:at(16),fetchImpl:async()=>reply(body('CHF 35','<p>Diese Seite verwendet Cookies.</p>'))});
  assert.equal(state.queue.length,1);task=state.queue[0];
  assert.equal(task.details.significance,'high');assert.deepEqual(task.details.changedLines,{added:['CHF 35'],removed:['CHF 20']});
  await runMonitor({sources:[source],state,...io,force:true,now:at(17),fetchImpl:async()=>reply(body('CHF 35','<p>Diese Seite verwendet Cookies und Statistik.</p>'))});
  assert.equal(state.queue[0].details.significance,'high');
});

const v1State=(sources,pages,now)=>{
  const state={schema:1,sources:{},queue:[]};
  for(const s of sources){const text=normalize(pages[s.id],s,now,'v1'),hash=sha256(text);state.sources[s.id]={hash,version:hash.slice(0,12),lastAttempt:now,lastSuccess:now,attempts:1,errorCount:0,finalUrl:s.url};}
  return state;
};
const club=(price='CHF 4.50 pro Kind')=>`<body><header><p>Montag Ruhetag</p><p>Betriebsferien vom 21.12.2026 bis 4.1.2027</p></header><main><h1>Club Café</h1><p>Spielecke für Kinder</p><p>${price}</p></main><footer>Cookies</footer></body>`;
test('rebaseline-parser: unchanged v1 text issues nothing, a v1 change issues one content-changed, both move to v2 with an alarm baseline',async()=>{
  const sources=[{id:'same',url:'https://example.org/same',type:'html',recordIds:['x'],intervalDays:30,required:['Club Café']},
    {id:'moved',url:'https://example.org/moved',type:'html',recordIds:['y'],intervalDays:30,required:['Club Café']}];
  const old='2026-09-28T06:00:00.000Z',state=v1State(sources,{same:club(),moved:club()},old);
  const prior=structuredClone(state.sources);
  const snaps=[];
  const report=await runMonitor({sources,state,now:at(20),rebaselineParser:{note:'Parser v2'},snapshot:async(id,hash,text)=>snaps.push({id,version:hash.slice(0,12),text}),
    readVersion:async()=>normalize(club(),sources[0],old,'v1'),
    fetchImpl:async url=>reply(url.endsWith('/moved')?club('CHF 5.50 pro Kind'):club())});
  const rows=Object.fromEntries(report.results.map(r=>[r.id,r]));
  assert.equal(rows.same.v1Changed,false);assert.equal(rows.moved.v1Changed,true);assert.equal(rows.moved.significance,'high');
  assert.ok(rows.same.chars.v2>rows.same.chars.v1);assert.equal(rows.same.alarmKeys,1);assert.equal(rows.same.encodingErrors,0);
  assert.deepEqual(state.queue.map(q=>[q.sourceId,q.kind]),[['moved','content-changed']]);
  const task=state.queue[0];
  assert.equal(task.details.oldVersion,prior.moved.version);assert.equal(task.details.parser,'v1');
  assert.equal(task.details.newVersion,sha256(normalize(club('CHF 5.50 pro Kind'),sources[1],old,'v1')).slice(0,12));
  assert.deepEqual(task.details.changedLines,{added:['CHF 5.50 pro Kind'],removed:['CHF 4.50 pro Kind']});
  for(const s of sources){
    const entry=state.sources[s.id];
    assert.equal(entry.parser,'v2');
    assert.equal(entry.hash,sha256(normalize(s.id==='moved'?club('CHF 5.50 pro Kind'):club(),s,old,'v2')));
    assert.deepEqual(entry.baselineHistory,[{at:at(20),hash:prior[s.id].hash,version:prior[s.id].version,note:'Parser v2',parser:'v1'}]);
    assert.deepEqual(entry.alarm.keys,['betriebsferien vom 21.12.2026 bis 4.1.2027']);
  }
  assert.deepEqual(snaps.map(s=>s.id),['same','moved','moved']);
  assert.match(snaps[0].text,/Montag Ruhetag/);
  const after=await runMonitor({sources,state,force:true,now:at(21),fetchImpl:async url=>reply(url.endsWith('/moved')?club('CHF 5.50 pro Kind'):club())});
  assert.deepEqual(after.results.map(r=>r.result),['unchanged','unchanged']);assert.equal(state.queue.length,1);
  const again=await runMonitor({sources,state,now:at(22),rebaselineParser:{note:'again'},fetchImpl:async()=>{throw Error('no fetch expected');}});
  assert.deepEqual(again.results.map(r=>r.result),['already-v2','already-v2']);
});
test('rebaseline-parser: a language redirect marks the v1 change low, high redirect classes are issued once',async()=>{
  const s={id:'kaiseregg',url:'https://example.org/angebot/rodelbahn',type:'html',recordIds:['k'],intervalDays:30,required:['Club Café']};
  const t={id:'ruche',url:'https://example.org/activites/kids',type:'html',recordIds:['r'],intervalDays:30,required:['Club Café']};
  const state=v1State([s,t],{kaiseregg:club(),ruche:club()},'2026-09-28T06:00:00.000Z');
  state.sources.ruche.finalUrl='https://example.org/activites__trashed/kids';
  await runMonitor({sources:[s,t],state,now:at(20),rebaselineParser:{note:'Parser v2'},fetchImpl:async url=>url.endsWith('rodelbahn')?replyAt(club('Fr. 9'),'https://example.org/fr/angebot/rodelbahn'):replyAt(club(),'https://example.org/activites__trashed/kids')});
  const change=state.queue.find(q=>q.kind==='content-changed');
  assert.equal(change.details.significance,'low');assert.equal(change.details.languageSwitch,true);
  assert.deepEqual(state.queue.filter(q=>q.kind==='redirect-changed').map(q=>[q.sourceId,q.details.class]),[['kaiseregg','language'],['ruche','trashed']]);
});
test('spread-days moves the last attempt back by a deterministic 0 to N days',async()=>{
  const ids=Array.from({length:12},(_,i)=>`source-${i}`);
  const sources=ids.map(id=>({id,url:`https://example.org/${id}`,type:'html',recordIds:[],intervalDays:30,required:['Club Café']}));
  const run=async()=>{const state=v1State(sources,Object.fromEntries(ids.map(id=>[id,club()])),'2026-09-28T06:00:00.000Z');
    await runMonitor({sources,state,now:at(20),rebaselineParser:{note:'v2'},spreadDays:4,fetchImpl:async()=>reply(club())});return state;};
  const a=await run(),b=await run();
  const offsets=ids.map(id=>(Date.parse(at(20))-Date.parse(a.sources[id].lastAttempt))/86400000);
  assert.deepEqual(offsets,ids.map(id=>parseInt(sha256(id).slice(0,2),16)%5));
  assert.deepEqual(ids.map(id=>b.sources[id].lastAttempt),ids.map(id=>a.sources[id].lastAttempt));
  assert.ok(new Set(offsets).size>=3);
  assert.equal(a.sources[ids[0]].lastSuccess,at(20));
  const short={...sources[0],id:'daily',intervalDays:1},state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[short],state,now:at(20),spreadDays:4,fetchImpl:async()=>reply(club())});
  assert.equal(state.sources.daily.lastAttempt,at(20));
});
test('main: --rebaseline-parser --dry-run writes nothing and reports per source; flags are validated',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-rebase-'));
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(req.url==='/b'?club('CHF 9 pro Kind'):club());});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const sources=['a','b'].map(id=>({id,url:`${base}/${id}`,type:'html',recordIds:[id],intervalDays:30,required:['Club Café']}));
    await fs.writeFile(path.join(dir,'source-watch.json'),JSON.stringify({sources:[...sources,{id:'p',url:`${base}/p.pdf`,type:'pdf',recordIds:[],intervalDays:30}]}));
    const statePath=path.join(dir,'state.json'),saved=JSON.stringify(v1State(sources,{a:club(),b:club()},'2026-09-28T06:00:00.000Z'),null,2);
    await fs.writeFile(statePath,saved);
    const out=await main(['--rebaseline-parser','--note=Parser v2','--dry-run','--spread-days=4','--host-delay-ms=0',`--state=${statePath}`],dir);
    assert.equal(out.dryRun,true);
    assert.equal(await fs.readFile(statePath,'utf8'),saved);
    assert.deepEqual((await fs.readdir(dir)).sort(),['source-watch.json','state.json']);
    assert.deepEqual(out.results.map(r=>[r.id,r.v1Changed]),[['a',false],['b',true]]);
    assert.ok(out.results.every(r=>r.chars.v1>0&&r.chars.v2>r.chars.v1&&r.alarmKeys===1&&r.encodingErrors===0));
    assert.deepEqual(out.wouldIssue,[{sourceId:'b',kind:'content-changed'}]);
    await assert.rejects(main(['--rebaseline-parser','--dry-run'],dir),/requires --note/);
    await assert.rejects(main(['--rebaseline-parser=p','--note=x','--dry-run'],dir),/not an HTML source: p/);
    await assert.rejects(main(['--rebaseline-parser=a','--id=a','--note=x','--dry-run'],dir),/without --id/);
    await assert.rejects(main(['--spread-days=-1','--dry-run'],dir),/--spread-days/);
    await assert.rejects(main(['--alarm-fuse=x','--dry-run'],dir),/--alarm-fuse/);
    const real=await main(['--rebaseline-parser=b','--note=Parser v2','--host-delay-ms=0',`--state=${statePath}`],dir);
    assert.deepEqual(real.results.map(r=>r.id),['b']);
    const written=JSON.parse(await fs.readFile(statePath,'utf8'));
    assert.equal(written.sources.b.parser,'v2');assert.equal(written.sources.a.parser,undefined);
    assert.equal((await fs.readdir(path.join(dir,'versions','b'))).length,2);
  }finally{server.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('main: a tripped alarm fuse returns exit code 2 and lists the withheld alarms',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-fuse-'));
  let body=notice();
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(body);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    await fs.writeFile(path.join(dir,'source-watch.json'),JSON.stringify({sources:['a','b'].map(id=>({...krabbel,id,url:`${base}/${id}`}))}));
    await main(['--host-delay-ms=0'],dir);
    body=notice('Der Kurs ist ab sofort ausgebucht.');
    const out=await main(['--force','--alarm-fuse=1','--host-delay-ms=0'],dir);
    assert.equal(out.exitCode,2);assert.equal(out.fuse.tripped,true);assert.equal(out.fuse.alarms.length,2);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'monitor-state.json'),'utf8')).queue,[]);
    const ok=await main(['--force','--host-delay-ms=0'],dir);
    assert.equal(ok.exitCode,undefined);assert.equal(ok.openTasks,2);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'monitor-state.json'),'utf8')).queue.map(q=>q.kind),['possible-closure','possible-closure']);
  }finally{server.close();await fs.rm(dir,{recursive:true,force:true});}
});
// F02: a withheld alarm must survive the validators. A site that answers like a real one: 304 only for the validator of the page it serves.
const titled=title=>`<html><head><title>${title}</title></head><body><main><h1>ElKi</h1><p>CHF 20 pro Treffen</p><p>Mittwoch 10:00</p></main></body></html>`;
function honestSite(title='Krabbelgruppe',etag='v1'){
  const site={title,etag,sent:[],set(nextTitle,nextEtag){site.title=nextTitle;site.etag=nextEtag;},
    fetch:async(url,options)=>{
      const sent=options.headers['if-none-match']??null;site.sent.push(sent);
      return sent===site.etag?new Response(null,{status:304}):new Response(titled(site.title),{status:200,headers:{'content-type':'text/html',etag:site.etag}});
    }};
  return site;
}
const restart=state=>JSON.parse(JSON.stringify(state));
test('a withheld alarm survives restarts and a later 304: the next requests carry the old validator, release creates one task, no repeat after',async()=>{
  const sources=['a','b'].map(id=>({...krabbel,id,url:`https://${id}.example.org/course`,recordIds:[id],intervalDays:1}));
  const site=honestSite();
  let state={schema:1,sources:{},queue:[]};
  await runMonitor({sources,state,now:at(13),alarmFuse:1,fetchImpl:site.fetch});
  const before=restart(state.sources);
  // The title alone changes to a closure notice; the main text, and with it the hash, stays: no content task can rescue the notice.
  site.set('Dauerhaft geschlossen','v2');
  const tripped=await runMonitor({sources,state,now:at(14),alarmFuse:1,fetchImpl:site.fetch});
  assert.equal(tripped.fuse.tripped,true);assert.equal(tripped.fuse.count,2);assert.deepEqual(tripped.results.map(row=>[row.id,row.result,row.withheld]),[['a','unchanged','alarm-fuse'],['b','unchanged','alarm-fuse']]);
  for(const id of ['a','b'])for(const key of ['alarm','alarmHistory','etag','lastModified','lastAttempt','hash'])assert.deepEqual(state.sources[id][key],before[id][key],`${id}.${key}`);
  assert.equal(state.sources.a.attempts,before.a.attempts+1);assert.deepEqual(state.queue,[]);
  state=restart(state);
  // Day 15, still too many alarms: both sources are due again, asked with the validator of the page they knew, and the page is read again.
  site.sent.length=0;
  const again=await runMonitor({sources,state,now:at(15),alarmFuse:1,fetchImpl:site.fetch});
  assert.deepEqual(site.sent,['v1','v1']);assert.equal(again.fuse.tripped,true);assert.deepEqual(state.queue,[]);
  state=restart(state);
  // Day 16: the owner raises the limit. Exactly one task per source, each with the notice.
  site.sent.length=0;
  const released=await runMonitor({sources,state,now:at(16),alarmFuse:5,fetchImpl:site.fetch});
  assert.deepEqual(site.sent,['v1','v1']);assert.equal(released.fuse.tripped,false);
  assert.deepEqual(state.queue.map(q=>[q.sourceId,q.kind,q.occurrences,q.details.lines.map(line=>line.text)]),[['a','possible-closure',1,['Dauerhaft geschlossen']],['b','possible-closure',1,['Dauerhaft geschlossen']]]);
  assert.equal(state.sources.a.etag,'v2');
  state=restart(state);
  // Day 17: the page is known now, the server answers 304, and nothing is issued twice.
  site.sent.length=0;
  const after=await runMonitor({sources,state,now:at(17),alarmFuse:5,fetchImpl:site.fetch});
  assert.deepEqual(site.sent,['v2','v2']);assert.deepEqual(after.results.map(row=>row.result),['unchanged-304','unchanged-304']);
  assert.equal(state.queue.length,2);assert.deepEqual(state.queue.map(q=>q.occurrences),[1,1]);
});
test('a withheld alarm is also found again when the page changed in content: one content task, one alarm task',async()=>{
  const sources=['a','b'].map(id=>({...krabbel,id,url:`https://${id}.example.org/course`,recordIds:[id],intervalDays:1}));
  const body=(price,extra='')=>titled('Krabbelgruppe').replace('CHF 20',price).replace('</main>',`${extra}</main>`);
  let price='CHF 20',extra='',etag='v1';
  const fetchImpl=async(url,options)=>options.headers['if-none-match']===etag?new Response(null,{status:304}):new Response(body(price,extra),{status:200,headers:{'content-type':'text/html',etag}});
  let state={schema:1,sources:{},queue:[]};
  await runMonitor({sources,state,now:at(13),alarmFuse:1,fetchImpl});
  price='CHF 25';extra='<p>Die Gruppe ist bis auf Weiteres sistiert.</p>';etag='v2';
  await runMonitor({sources,state,now:at(14),alarmFuse:1,fetchImpl});
  assert.deepEqual(state.queue.map(q=>[q.sourceId,q.kind]),[['a','content-changed'],['b','content-changed']]);
  state=restart(state);
  await runMonitor({sources,state,now:at(15),alarmFuse:5,fetchImpl});
  await runMonitor({sources,state,now:at(16),alarmFuse:5,fetchImpl});
  assert.deepEqual(state.queue.filter(q=>q.kind==='content-changed').map(q=>q.occurrences),[1,1],'the held back run does not repeat the content task');
  assert.deepEqual(state.queue.filter(q=>q.kind==='possible-closure').map(q=>[q.sourceId,q.occurrences]),[['a',1],['b',1]]);
});
test('in a run, an ongoing closure since a past date opens a task and an expired temporary closure does not',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[krabbel],state,now:at(14),fetchImpl:async()=>reply(notice())});
  await runMonitor({sources:[krabbel],state,force:true,now:at(15),fetchImpl:async()=>reply(notice('Geschlossen bis 01.10.2026'))});
  const alarms=()=>state.queue.filter(q=>q.kind.startsWith('possible-')).map(q=>[q.kind,q.details.lines.map(line=>line.text)]);
  assert.deepEqual(alarms(),[]);
  await runMonitor({sources:[krabbel],state,force:true,now:at(16),fetchImpl:async()=>reply(notice('Geschlossen bis 01.10.2026','Dauerhaft geschlossen seit 01.10.2026'))});
  assert.deepEqual(alarms(),[['possible-closure',['Dauerhaft geschlossen seit 01.10.2026']]]);
});
test('a withheld alarm of a source whose fetch failed keeps its backoff, and the alarm is found again when it is read',async()=>{
  const sources=[{...krabbel,id:'a',url:'https://a.example.org/course',intervalDays:7,required:['Marker']}];
  const state={schema:1,sources:{},queue:[]};
  const withMarker=notice().replace('ElKi','Marker');
  await runMonitor({sources,state,now:at(13),fetchImpl:async()=>reply(withMarker)});
  // The page lost its marker (parser-failed) and carries a notice: the alarm is withheld by the fuse at 0.
  const report=await runMonitor({sources,state,force:true,now:at(14),alarmFuse:0,fetchImpl:async()=>reply(notice('Die Gruppe ist bis auf Weiteres sistiert.'))});
  assert.equal(report.fuse.tripped,true);assert.equal(report.results[0].result,'error');assert.equal(report.results[0].withheld,'alarm-fuse');
  const entry=state.sources.a;
  assert.equal(entry.lastAttempt,at(14),'a failed fetch is not made due again at once');assert.equal(entry.errorCount,1);assert.equal(entry.nextRetry,new Date(Date.parse(at(14))+86400000).toISOString());
  assert.equal(due(entry,sources[0],at(14)),false);assert.equal(due(entry,sources[0],at(15)),true);
  assert.deepEqual(entry.alarm.keys,[]);
  await runMonitor({sources,state,now:at(15),fetchImpl:async()=>reply(withMarker.replace('</footer>','<p>Die Gruppe ist bis auf Weiteres sistiert.</p></footer>'))});
  assert.deepEqual(state.queue.filter(q=>q.kind==='possible-closure').map(q=>q.occurrences),[1]);
});
test('main: a withheld alarm survives a restart through monitor-state.json and is released by a plain later run',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-held-'));
  let title='Krabbelgruppe',etag='"v1"';const sent=[];
  const server=http.createServer((req,res)=>{
    sent.push(req.headers['if-none-match']??null);
    if(req.headers['if-none-match']===etag){res.writeHead(304);res.end();return;}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8',etag});res.end(titled(title));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`,statePath=path.join(dir,'monitor-state.json'),read=async()=>JSON.parse(await fs.readFile(statePath,'utf8'));
    // intervalDays 0: every source is due at every run, so no --force is needed and the held back sources are picked up by a plain run.
    await fs.writeFile(path.join(dir,'source-watch.json'),JSON.stringify({sources:['a','b'].map(id=>({...krabbel,id,url:`${base}/${id}`,intervalDays:0}))}));
    await main(['--host-delay-ms=0'],dir);
    title='Dauerhaft geschlossen';etag='"v2"';sent.length=0;
    const out=await main(['--alarm-fuse=1','--host-delay-ms=0'],dir);
    assert.equal(out.exitCode,2);assert.equal(out.fuse.alarms.length,2);
    assert.deepEqual(sent,[ '"v1"','"v1"']);
    assert.deepEqual((await read()).queue,[]);assert.equal((await read()).sources.a.etag,'"v1"');
    sent.length=0;
    const still=await main(['--alarm-fuse=1','--host-delay-ms=0'],dir);
    assert.equal(still.exitCode,2);assert.deepEqual(sent,['"v1"','"v1"']);
    sent.length=0;
    const ok=await main(['--host-delay-ms=0'],dir);
    assert.equal(ok.exitCode,undefined);assert.equal(ok.openTasks,2);assert.deepEqual(sent,['"v1"','"v1"']);
    const next=await main(['--host-delay-ms=0'],dir);
    assert.equal(next.openTasks,2);assert.deepEqual(next.results.map(row=>row.result),['unchanged-304','unchanged-304']);
    assert.deepEqual((await read()).queue.map(q=>[q.sourceId,q.kind,q.occurrences]),[['a','possible-closure',1],['b','possible-closure',1]]);
  }finally{server.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('a challenge page or an HTTP error never moves the stored final URL, so the recovery raises no redirect',async()=>{
  const state={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[source],state,now:at(10),fetchImpl:async()=>replyAt(page(),'https://example.org/course')});
  const challenge='<html><body><main><p>Just a moment... Checking your browser before accessing the site, please wait.</p></main></body></html>';
  await runMonitor({sources:[source],state,force:true,now:at(11),fetchImpl:async()=>replyAt(challenge,'https://example.org/verify?return=/course')});
  assert.equal(state.sources.course.finalUrl,'https://example.org/course');assert.equal(state.sources.course.redirect,null);
  await runMonitor({sources:[source],state,force:true,now:at(12),fetchImpl:async()=>{const r=new Response('Wartung',{status:503,headers:{'content-type':'text/html'}});Object.defineProperty(r,'url',{value:'https://example.org/maintenance'});return r;}});
  assert.equal(state.sources.course.finalUrl,'https://example.org/course');
  assert.deepEqual(state.queue.map(q=>q.kind),['source-unavailable']);
  const back=await runMonitor({sources:[source],state,force:true,now:at(13),fetchImpl:async()=>replyAt(page(),'https://example.org/course')});
  assert.equal(back.results[0].result,'unchanged');
  assert.equal(state.queue.filter(q=>q.kind==='redirect-changed').length,0);
  assert.deepEqual(state.queue.map(q=>[q.kind,q.status]),[['source-unavailable','resolved']]);
});
test('a v1 baseline stays on v1 in a normal run: unchanged issues nothing, a v1 change issues content-changed with parser v1',async()=>{
  const s={id:'club',url:'https://example.org/club',type:'html',recordIds:['c'],intervalDays:30,required:['Club Café']};
  const old='2026-09-28T06:00:00.000Z',state=v1State([s],{club:club()},old),prior={...state.sources.club};
  assert.notEqual(sha256(normalize(club(),s,old,'v2')),prior.hash);
  const same=await runMonitor({sources:[s],state,force:true,now:at(20),fetchImpl:async()=>reply(club())});
  assert.equal(same.results[0].result,'unchanged');assert.equal(state.queue.length,0);
  assert.equal(state.sources.club.hash,prior.hash);assert.equal(state.sources.club.parser,undefined);
  const changed=await runMonitor({sources:[s],state,force:true,now:at(21),readVersion:async()=>normalize(club(),s,old,'v1'),fetchImpl:async()=>reply(club('CHF 5.50 pro Kind'))});
  assert.equal(changed.results[0].result,'changed');
  assert.deepEqual(state.queue.map(q=>q.kind),['content-changed']);
  const task=state.queue[0],v1Text=normalize(club('CHF 5.50 pro Kind'),s,old,'v1');
  assert.equal(task.details.parser,'v1');assert.equal(task.details.from,prior.hash);assert.equal(task.details.to,sha256(v1Text));
  assert.deepEqual(task.details.changedLines,{added:['CHF 5.50 pro Kind'],removed:['CHF 4.50 pro Kind']});
  assert.equal(state.sources.club.hash,sha256(v1Text));assert.equal(state.sources.club.parser,undefined);
});

// Host rules: a portal menu that rotates its links, a footer link list and a town news menu are not card content.
const hostIgnore={'portal.example':{selectors:['#side-menu','#footer ul.links'],ranges:[{from:'^Aller au menu principal$',to:'^A propos$'}],lines:['^Médias$']},
  'www.town.example':{selectors:['nav.mmenu']}};
const pool={id:'portal-pool',url:'https://www.portal.example/fr/pool/',type:'html',recordIds:['pool-card'],intervalDays:30,required:['Piscine du lac']};
const portal=({menu=['Pétanque sur glace','L’aventure fondue'],links=['Qui sommes-nous','Médias'],price='CHF 5 par enfant',extra=''}={})=>`<html><head><title>Piscine</title></head><body>
  <div id="side-menu"><p>Aller au menu principal</p><ul>${menu.map(item=>`<li>${item}</li>`).join('')}</ul><p>A propos</p></div>
  <div id="content"><h1>Piscine du lac</h1><p>Bassin pour les petits, ouvert de mai à septembre.</p><p>${price}</p>${extra}</div>
  <div id="footer"><ul class="links">${links.map(item=>`<li>${item}</li>`).join('')}</ul><p>Office du tourisme, Place 1</p></div></body></html>`;
test('host rules drop a block by selector in parser v2 and by line range or pattern in both parsers; card content still counts',()=>{
  const rules=hostRules(hostIgnore,pool.url);
  assert.equal(hostRules(hostIgnore,'https://other.example/x'),null);
  assert.deepEqual(hostRules(hostIgnore,'https://town.example/a').selectors,['nav.mmenu']);
  assert.throws(()=>hostRules({'portal.example':{lines:['(']}},pool.url),/hostIgnore portal\.example/);
  const v2=normalize(portal(),pool,at(1),'v2',rules),v1=normalize(portal(),pool,at(1),'v1',rules);
  assert.equal(v2,'Piscine du lac\nBassin pour les petits, ouvert de mai à septembre.\nCHF 5 par enfant\nOffice du tourisme, Place 1');
  assert.equal(v1,'Piscine du lac\nBassin pour les petits, ouvert de mai à septembre.\nCHF 5 par enfant\nQui sommes-nous\nOffice du tourisme, Place 1');
  assert.match(normalize(portal(),pool,at(1),'v1'),/Pétanque sur glace/);
  assert.equal(dropIgnored('A\nAller au menu principal\nB\nC',rules),'A\nAller au menu principal\nB\nC');
  assert.equal(dropIgnored('A\nAller au menu principal\nB\nA propos\nC\nMédias',rules),'A\nC');
});
test('host rules: a rotating portal menu is unchanged in a normal run, also against a v1 baseline stored before the rule',async()=>{
  const versions=new Map(),io={snapshot:async(id,hash,text)=>versions.set(`${id}/${hash.slice(0,12)}`,text),readVersion:async(id,version)=>versions.get(`${id}/${version}`)??null};
  const v2State={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[pool],state:v2State,hostIgnore,...io,now:at(1),fetchImpl:async()=>reply(portal())});
  const rotated=portal({menu:['Activités en intérieur','Visites guidées'],links:['Qui sommes-nous']});
  const quiet=await runMonitor({sources:[pool],state:v2State,hostIgnore,...io,force:true,now:at(2),fetchImpl:async()=>reply(rotated)});
  assert.equal(quiet.results[0].result,'unchanged');assert.equal(v2State.queue.length,0);
  await runMonitor({sources:[pool],state:v2State,hostIgnore,...io,force:true,now:at(3),fetchImpl:async()=>reply(portal({menu:['Visites guidées'],price:'CHF 7 par enfant'}))});
  assert.deepEqual(v2State.queue.map(q=>[q.kind,q.details.significance]),[['content-changed','high']]);
  assert.deepEqual(v2State.queue[0].details.changedLines,{added:['CHF 7 par enfant'],removed:['CHF 5 par enfant']});
  // A v1 baseline written before the rule existed still holds the menu: the rule is applied to the stored text as well.
  versions.clear();
  const v1Text=normalize(portal(),pool,at(1),'v1'),v1Hash=sha256(v1Text);versions.set(`portal-pool/${v1Hash.slice(0,12)}`,v1Text);
  const v1Entry={hash:v1Hash,version:v1Hash.slice(0,12),lastAttempt:at(1),lastSuccess:at(1),attempts:1,errorCount:0,finalUrl:pool.url};
  const state={schema:1,sources:{'portal-pool':{...v1Entry}},queue:[]};
  const report=await runMonitor({sources:[pool],state,hostIgnore,...io,force:true,now:at(2),fetchImpl:async()=>reply(rotated)});
  assert.equal(report.results[0].result,'unchanged');assert.equal(state.queue.length,0);
  const entry=state.sources['portal-pool'];
  assert.equal(entry.parser,undefined);assert.equal(entry.hash,sha256(normalize(rotated,pool,at(2),'v1',hostRules(hostIgnore,pool.url))));
  assert.deepEqual(entry.baselineHistory,[{at:at(2),hash:v1Hash,version:v1Hash.slice(0,12),note:'host ignore rules applied to the stored text',parser:'v1'}]);
  await runMonitor({sources:[pool],state,hostIgnore,...io,force:true,now:at(3),fetchImpl:async()=>reply(portal({menu:['Ski de fond'],price:'CHF 7 par enfant'}))});
  assert.deepEqual(state.queue.map(q=>[q.kind,q.details.parser]),[['content-changed','v1']]);
  assert.deepEqual(state.queue[0].details.changedLines,{added:['CHF 7 par enfant'],removed:['CHF 5 par enfant']});
});
test('host rules: the parser rebaseline compares v1 without the ignored blocks and reports only card lines',async()=>{
  const v1Text=normalize(portal(),pool,at(1),'v1'),v1Hash=sha256(v1Text);
  const make=()=>({schema:1,sources:{'portal-pool':{hash:v1Hash,version:v1Hash.slice(0,12),lastAttempt:at(1),lastSuccess:at(1),attempts:1,errorCount:0,finalUrl:pool.url}},queue:[]});
  const readVersion=async()=>v1Text;
  const menuOnly=make();
  const quiet=await runMonitor({sources:[pool],state:menuOnly,hostIgnore,readVersion,now:at(5),rebaselineParser:{note:'Parser v2'},fetchImpl:async()=>reply(portal({menu:['Activités en intérieur'],links:['Médias','Qui sommes-nous']}))});
  assert.equal(quiet.results[0].v1Changed,false);assert.equal(menuOnly.queue.length,0);
  assert.equal(menuOnly.sources['portal-pool'].parser,'v2');
  const card=make();
  const loud=await runMonitor({sources:[pool],state:card,hostIgnore,readVersion,now:at(5),rebaselineParser:{note:'Parser v2'},fetchImpl:async()=>reply(portal({menu:['Ski de fond'],price:'CHF 7 par enfant'}))});
  assert.equal(loud.results[0].v1Changed,true);
  assert.deepEqual(card.queue[0].details.changedLines,{added:['CHF 7 par enfant'],removed:['CHF 5 par enfant']});
});
test('host rules: a town news menu raises no alarm lines, a notice in the page content still does',async()=>{
  const town={id:'town-pool',url:'https://www.town.example/fr/piscine',type:'html',recordIds:['town-card'],intervalDays:30,required:['Piscine communale']};
  const html=(news,notice='')=>`<html><body><nav class="mmenu"><ul><li><a>Actualités communales</a><ul>${news.map(n=>`<li><a>${n}</a></li>`).join('')}</ul></li></ul></nav>
    <div id="main-container"><h1>Piscine communale</h1><p>Bassin non-nageurs, lundi 17:30 - 21:00.</p>${notice?`<p>${notice}</p>`:''}</div></body></html>`;
  assert.equal(hostRules(hostIgnore,town.url).selectors[0],'nav.mmenu');
  const state={schema:1,sources:{},queue:[]};
  const first=await runMonitor({sources:[town],state,hostIgnore,now:at(1),fetchImpl:async()=>reply(html(['Fermeture temporaire de la route du Perry']))});
  assert.equal(first.results[0].alarm,'baseline');assert.deepEqual(state.sources['town-pool'].alarm.keys,[]);
  await runMonitor({sources:[town],state,hostIgnore,force:true,now:at(2),fetchImpl:async()=>reply(html(['La Fondue suspendue','Travaux - Réfection de la rampe du cimetière']))});
  assert.equal(state.queue.length,0);
  await runMonitor({sources:[town],state,hostIgnore,force:true,now:at(3),fetchImpl:async()=>reply(html(['La Fondue suspendue'],"La piscine est fermée jusqu'à nouvel avis."))});
  assert.deepEqual(state.queue.map(q=>q.kind).sort(),['content-changed','possible-closure']);
  assert.deepEqual(state.queue.find(q=>q.kind==='possible-closure').details.lines.map(l=>l.text),["La piscine est fermée jusqu'à nouvel avis."]);
  const without={schema:1,sources:{},queue:[]};
  await runMonitor({sources:[town],state:without,now:at(1),fetchImpl:async()=>reply(html(['Fermeture temporaire de la route du Perry']))});
  assert.deepEqual(without.sources['town-pool'].alarm.keys,['fermeture temporaire de la route du perry']);
});
test('main: hostIgnore from source-watch.json is validated before any request',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-host-'));
  try{
    await fs.writeFile(path.join(dir,'source-watch.json'),JSON.stringify({sources:[{...krabbel,url:'http://127.0.0.1:9/x'}],hostIgnore:{'127.0.0.1':{ranges:[{from:'^a$'}]}}}));
    await assert.rejects(main(['--dry-run','--host-delay-ms=0'],dir),/hostIgnore 127\.0\.0\.1/);
    await fs.writeFile(path.join(dir,'source-watch.json'),JSON.stringify({sources:[{...krabbel,url:'http://127.0.0.1:9/x'}],hostIgnore:{'127.0.0.1':{selectors:[42]}}}));
    await assert.rejects(main(['--dry-run','--host-delay-ms=0'],dir),/hostIgnore 127\.0\.0\.1/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

// The run-wide outage fuse: more than a share of the sources fetched in one run unavailable means the check broke (a network down), not the market.
const grid=count=>Array.from({length:count},(_,index)=>({...krabbel,id:`s${index}`,url:`https://site${index}.example/page`,recordIds:[`card-${index}`]}));
const unreachable=ids=>async url=>{if(ids.some(id=>url.startsWith(`https://site${id}.example/`)))throw Error('network offline');return reply(notice());};
// Eight sources with an HTTP error or a challenge page tripped the fuse every morning from 21 October 2026, and their tasks never reached the editors.
test('a source that answers with an error is no outage: the fuse stays off with a working network, and in a real outage its task is still issued',async()=>{
  const failing=(gone,offline)=>async url=>{
    if(gone.some(id=>url.startsWith(`https://site${id}.example/`)))return new Response('gone',{status:404});
    return unreachable(offline)(url);
  };
  const state={schema:1,sources:{},queue:[]};
  const answered=await runMonitor({sources:grid(10),state,now:at(14),outageFuse:20,fetchImpl:failing([0,1,2,3],[])});
  assert.deepEqual({tripped:answered.outageFuse.tripped,failed:answered.outageFuse.failed,share:answered.outageFuse.share},{tripped:false,failed:0,share:0});
  assert.equal(state.sources.s0.error,'HTTP 404');assert.equal(state.sources.s0.errorCount,1);
  const down={schema:1,sources:{},queue:[]};
  const report=await runMonitor({sources:grid(10),state:down,now:at(14),outageFuse:20,fetchImpl:failing([0],[1,2,3,4])});
  assert.equal(report.outageFuse.tripped,true);assert.deepEqual(report.outageFuse.sources.map(row=>row.sourceId),['s1','s2','s3','s4']);
  assert.deepEqual(down.sources.s1,{});assert.equal(down.sources.s0.error,'HTTP 404');
  assert.equal(report.results.find(row=>row.id==='s0').withheld,undefined);assert.equal(report.results.find(row=>row.id==='s1').withheld,'outage-fuse');
});
test('the outage fuse withholds every source-unavailable task of a run in which too many sources failed, and puts those sources back',async()=>{
  const sources=grid(10),state={schema:1,sources:{},queue:[]};
  // Source s9 answers, but without the page content: a parser failure, which is not an outage and is still issued.
  const fetchImpl=async url=>url.startsWith('https://site9.example/')?reply('<html><main></main></html>'):unreachable([0,1,2])(url);
  const report=await runMonitor({sources,state,now:at(14),outageFuse:20,fetchImpl});
  assert.deepEqual({tripped:report.outageFuse.tripped,fetched:report.outageFuse.fetched,failed:report.outageFuse.failed,share:report.outageFuse.share,limit:report.outageFuse.limit},
    {tripped:true,fetched:10,failed:3,share:30,limit:20});
  assert.deepEqual(report.outageFuse.sources.map(row=>row.sourceId),['s0','s1','s2']);assert.match(report.outageFuse.sources[0].error,/network offline/);
  assert.equal(state.queue.some(q=>q.kind==='source-unavailable'),false);
  assert.deepEqual(state.queue.map(q=>[q.sourceId,q.kind]),[['s9','parser-failed']]);
  for(const id of ['s0','s1','s2']){assert.deepEqual(state.sources[id],{});assert.equal(report.results.find(r=>r.id===id).withheld,'outage-fuse');}
  assert.equal(state.sources.s3.lastSuccess,at(14));assert.equal(state.sources.s9.errorCount,1);
  // The network is back: the three sources are due again at once, no backoff was recorded, and nothing is raised.
  const next=await runMonitor({sources,state,now:at(14),outageFuse:20,fetchImpl:unreachable([])});
  assert.equal(next.outageFuse.tripped,false);assert.deepEqual(next.results.filter(r=>['s0','s1','s2'].includes(r.id)).map(r=>r.result),['baseline','baseline','baseline']);
});
test('a failure rate of exactly the limit, or a run smaller than the minimum, still raises its source-unavailable tasks',async()=>{
  const state={schema:1,sources:{},queue:[]};
  const edge=await runMonitor({sources:grid(10),state,now:at(14),outageFuse:20,fetchImpl:unreachable([0,1])});
  assert.equal(edge.outageFuse.tripped,false);assert.equal(edge.outageFuse.share,20);
  assert.deepEqual(state.queue.map(q=>[q.sourceId,q.kind]),[['s0','source-unavailable'],['s1','source-unavailable']]);assert.equal(state.sources.s0.errorCount,1);
  const small={schema:1,sources:{},queue:[]};
  const few=await runMonitor({sources:grid(3),state:small,now:at(14),outageFuse:20,outageMin:5,fetchImpl:unreachable([0,1,2])});
  assert.equal(few.outageFuse.tripped,false);assert.equal(few.outageFuse.failed,3);assert.equal(small.queue.length,3);
  // Without the option the fuse is off, as the alarm fuse is.
  const off={schema:1,sources:{},queue:[]};
  assert.equal((await runMonitor({sources:grid(4),state:off,now:at(14),fetchImpl:unreachable([0,1,2,3])})).outageFuse.tripped,false);assert.equal(off.queue.length,4);
});
test('a source that answers 304 or is not due is not counted as fetched; a first 404 raises no task and no alarm, and a 503 counts for the fuse',async()=>{
  const sources=grid(5),state={schema:1,sources:{},queue:[]};
  await runMonitor({sources,state,now:at(14),fetchImpl:unreachable([])});
  const answering=status=>async url=>url.startsWith('https://site0.')?reply('no page',status):reply(null,304);
  const report=await runMonitor({sources,state,ids:new Set(['s0','s1']),force:true,now:at(15),outageFuse:20,fetchImpl:answering(404)});
  assert.deepEqual([report.outageFuse.fetched,report.outageFuse.failed,report.outageFuse.tripped],[2,0,false]);
  assert.equal(state.sources.s0.errorCount,1);assert.equal(state.queue.length,0);
  const tripped=await runMonitor({sources,state,ids:new Set(['s0','s1']),force:true,now:at(16),outageFuse:20,fetchImpl:answering(503)});
  assert.equal(tripped.outageFuse.tripped,true);assert.equal(state.sources.s0.errorCount,1);assert.equal(state.queue.length,0);
});
test('the outage fuse puts an established source back whole, validators included, so the next request asks about the page it knew',async()=>{
  const sources=grid(10).map(item=>({...item,intervalDays:7})),state={schema:1,sources:{},queue:[]};
  const stamp='Tue, 13 Oct 2026 05:00:00 GMT',sent=new Map();
  const site=down=>async(url,options)=>{
    const id=new URL(url).hostname.match(/^site(\d+)/)[1],header=options.headers['if-none-match']??null;sent.set(id,header);
    if(down.includes(Number(id)))return new Response('Maintenance',{status:503,headers:{'content-type':'text/html',etag:'"maintenance"','last-modified':'Thu, 15 Oct 2026 05:00:00 GMT'}});
    return header===`"page-${id}"`?new Response(null,{status:304}):new Response(notice(),{status:200,headers:{'content-type':'text/html',etag:`"page-${id}"`,'last-modified':stamp}});
  };
  await runMonitor({sources,state,now:at(14),outageFuse:20,fetchImpl:site([])});
  const before=structuredClone(state.sources);
  for(const id of ['s0','s1','s2'])assert.deepEqual([before[id].etag,before[id].lastModified,before[id].alarm.keys],[`"page-${id.slice(1)}"`,stamp,[]]);
  const report=await runMonitor({sources,state,now:at(22),outageFuse:20,fetchImpl:site([0,1,2])});
  assert.equal(report.outageFuse.tripped,true);assert.deepEqual(report.outageFuse.sources.map(row=>row.httpStatus),[503,503,503]);
  for(const id of ['s0','s1','s2'])assert.deepEqual(state.sources[id],before[id],`${id} is exactly as before the run, the maintenance page's own validators were never kept`);
  assert.equal(state.queue.length,0);
  sent.clear();
  const next=await runMonitor({sources,state,now:at(22),outageFuse:20,fetchImpl:site([])});
  assert.deepEqual(['0','1','2'].map(id=>sent.get(id)),['"page-0"','"page-1"','"page-2"']);
  assert.deepEqual(next.results.filter(row=>['s0','s1','s2'].includes(row.id)).map(row=>row.result),['unchanged-304','unchanged-304','unchanged-304']);
});
test('main: a tripped outage fuse returns exit code 2 and lists the sources; the options are validated and can switch it off',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-outage-'));
  let down=new Set();
  const server=http.createServer((req,res)=>{
    if(down.has(req.url.slice(1))){res.writeHead(503,{'content-type':'text/html'});res.end('Maintenance');return;}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(notice());
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`,statePath=path.join(dir,'monitor-state.json'),read=async()=>JSON.parse(await fs.readFile(statePath,'utf8'));
    await fs.writeFile(path.join(dir,'source-watch.json'),JSON.stringify({sources:grid(10).map(source=>({...source,url:`${base}/${source.id}`}))}));
    down=new Set(['s0','s1','s2']);
    const out=await main(['--host-delay-ms=0'],dir);
    assert.equal(out.exitCode,2);assert.equal(out.outageFuse.tripped,true);assert.equal(out.outageFuse.failed,3);assert.equal(out.outageFuse.limit,20);assert.equal(out.outageFuse.min,10);
    assert.deepEqual(out.outageFuse.sources.map(row=>[row.sourceId,row.httpStatus]),[['s0',503],['s1',503],['s2',503]]);
    assert.deepEqual((await read()).queue,[]);assert.equal((await read()).sources.s0.lastAttempt,undefined);
    await assert.rejects(main(['--outage-fuse=x','--dry-run'],dir),/--outage-fuse/);
    await assert.rejects(main(['--outage-min=0','--dry-run'],dir),/--outage-min/);
    // The owner can raise the limit: the three tasks are then issued, and no exit code is set.
    const forced=await main(['--force','--outage-fuse=50','--host-delay-ms=0'],dir);
    assert.equal(forced.exitCode,undefined);assert.equal(forced.outageFuse,undefined);
    assert.deepEqual((await read()).queue.map(q=>q.kind),['source-unavailable','source-unavailable','source-unavailable']);
  }finally{server.close();await fs.rm(dir,{recursive:true,force:true});}
});

// Stage 2: every successful fetch leaves a page record (provenance, the full body, the alarm lines, the raw bytes of an HTML page).
const recorder=()=>{const rows=[];return {rows,record:async(id,info)=>{rows.push({id,info});}};};
const titledPage=(title,price='CHF 20')=>`<html><head><title>${title}</title></head><body><header><p>Montag Ruhetag</p></header><nav>Menu</nav><main><h1>ElKi</h1><p>${price} pro Treffen</p><p>Mittwoch 10:00</p></main><footer><p>Kontakt Verein</p></footer></body></html>`;
test('each 200 hands the record callback the provenance of the fetch and the texts of the same bytes',async()=>{
  const state={schema:1,sources:{},queue:[]},{rows,record}=recorder();
  const body=titledPage('Krabbelgruppe: vorübergehend geschlossen bis 30.11.2099');
  const fetchImpl=async()=>new Response(body,{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
  const report=await runMonitor({sources:[krabbel],state,now:at(13),fetchImpl,record});
  assert.equal(report.results[0].result,'baseline');assert.equal(rows.length,1);
  const {id,info}=rows[0],entry=state.sources.krabbel;
  assert.equal(id,'krabbel');assert.equal(info.hash,entry.hash);assert.equal(info.version,entry.version);
  assert.equal(info.fetchedAt,at(13));assert.equal(info.parser,'v2');assert.equal(info.status,200);assert.equal(info.contentType,'text/html; charset=utf-8');
  assert.equal(info.rawHash,sha256(Buffer.from(body)));assert.equal(info.rawBytes,Buffer.byteLength(body));assert.deepEqual(info.raw,Buffer.from(body));
  assert.equal(info.full.parser,'cheerio-visible-body-v1');assert.match(info.full.text,/Kontakt Verein/);assert.doesNotMatch(info.full.text,/Menu/);
  assert.deepEqual(info.alarm,['Krabbelgruppe: vorübergehend geschlossen bis 30.11.2099']);
  // The same version fetched again records again; a new price is a new version and a new record.
  await runMonitor({sources:[krabbel],state,force:true,now:at(14),fetchImpl,record});
  assert.equal(rows[1].info.version,rows[0].info.version);assert.equal(rows[1].info.fetchedAt,at(14));
  await runMonitor({sources:[krabbel],state,force:true,now:at(15),fetchImpl:async()=>new Response(titledPage('Krabbelgruppe','CHF 35'),{headers:{'content-type':'text/html'}}),record});
  assert.notEqual(rows[2].info.version,rows[0].info.version);assert.equal(state.queue.filter(q=>q.kind==='content-changed').length,1);
});
test('a PDF and a calendar record their text as the full view and no raw bytes',async()=>{
  const state={schema:1,sources:{},queue:[]},{rows,record}=recorder();
  const ics={id:'cal',url:'https://example.org/cal.ics',type:'ics',recordIds:[],intervalDays:1,minChars:10};
  const calendar='BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Fixture meeting with a long\r\n  folded title\r\nDTSTART:20261104T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  await runMonitor({sources:[ics],state,now:at(13),fetchImpl:async()=>new Response(calendar,{headers:{'content-type':'text/calendar'}}),record});
  assert.equal(rows[0].info.raw,null);assert.deepEqual(rows[0].info.full,{parser:'calendar-raw-v1',text:calendar.trim()});
  assert.deepEqual(rows[0].info.alarm,[]);assert.equal(rows[0].info.rawHash,sha256(Buffer.from(calendar)));
});
test('a version without a page record is fetched in full once; with a record the validators go out as before',async()=>{
  const state={schema:1,sources:{},queue:[]},seen=[];
  let has=false;
  const fetchImpl=async(url,options)=>{seen.push(options.headers['if-none-match']??null);return new Response(titledPage('Krabbelgruppe'),{headers:{'content-type':'text/html',etag:'v1'}});};
  const run=day=>runMonitor({sources:[krabbel],state,force:true,now:at(day),fetchImpl,hasRecord:async()=>has});
  await run(13);await run(14);
  assert.deepEqual(seen,[null,null]);                 // no record yet: no validator even though the page sent an etag
  has=true;await run(15);
  assert.deepEqual(seen,[null,null,'v1']);            // a record exists: the conditional request is back
});
test('a 304, a failed fetch and a parser failure leave no record, and a record that cannot be written does not fail the pass',async()=>{
  const state={schema:1,sources:{},queue:[]},{rows,record}=recorder();
  await runMonitor({sources:[krabbel],state,now:at(13),fetchImpl:async()=>new Response(titledPage('Krabbelgruppe'),{headers:{'content-type':'text/html',etag:'v1'}}),record});
  assert.equal(rows.length,1);
  await runMonitor({sources:[krabbel],state,force:true,now:at(14),fetchImpl:async()=>new Response(null,{status:304}),record});
  await runMonitor({sources:[krabbel],state,force:true,now:at(15),fetchImpl:async()=>new Response('gone',{status:500}),record});
  await runMonitor({sources:[krabbel],state,force:true,now:at(16),fetchImpl:async()=>new Response('<html><main></main></html>',{headers:{'content-type':'text/html'}}),record});
  assert.equal(rows.length,1);
  const hash=state.sources.krabbel.hash;
  const broken=await runMonitor({sources:[krabbel],state,force:true,now:at(17),fetchImpl:async()=>new Response(titledPage('Krabbelgruppe','CHF 40'),{headers:{'content-type':'text/html'}}),
    record:async()=>{throw Error('disk full');}});
  assert.equal(broken.results[0].result,'changed');assert.equal(broken.results[0].recordError,'disk full');
  assert.notEqual(state.sources.krabbel.hash,hash);assert.equal(state.sources.krabbel.errorCount,0);
});
test('main: the first full pass writes page records beside the versions, a dry run writes none, and the versions folder is untouched',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-records-'));
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8',etag:'"e1"'});res.end(titledPage('Krabbelgruppe'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/krabbel`;
    await fs.writeFile(path.join(dir,'source-watch.json'),JSON.stringify({sources:[{...krabbel,url}]}));
    await main(['--dry-run','--host-delay-ms=0'],dir);
    assert.deepEqual(await fs.readdir(dir),['source-watch.json']);
    await main(['--host-delay-ms=0'],dir);
    const state=JSON.parse(await fs.readFile(path.join(dir,'monitor-state.json'),'utf8')),version=state.sources.krabbel.version;
    assert.deepEqual(await fs.readdir(path.join(dir,'versions','krabbel')),[version+'.txt']);
    assert.deepEqual((await fs.readdir(path.join(dir,'page-records','krabbel'))).sort(),[version+'.full.txt.gz',version+'.json',version+'.raw.gz']);
    const {readRecord}=await import('./page-record.mjs');
    const record=await readRecord(dir,'krabbel',version,{raw:true});
    assert.deepEqual(record.problems,[]);assert.equal(record.meta.hash,state.sources.krabbel.hash);assert.equal(record.meta.finalUrl,url);
    assert.match(record.full,/Kontakt Verein/);assert.equal(record.raw.toString(),titledPage('Krabbelgruppe'));
    // A second pass, forced: the record exists now, the page is the same version, and the first fetch time stays.
    await main(['--force','--host-delay-ms=0'],dir);
    const again=await readRecord(dir,'krabbel',version);
    assert.equal(again.meta.firstFetchedAt,record.meta.firstFetchedAt);assert.ok(again.meta.fetchedAt>=record.meta.fetchedAt);
    assert.deepEqual(await fs.readdir(path.join(dir,'versions','krabbel')),[version+'.txt']);
  }finally{server.close();await fs.rm(dir,{recursive:true,force:true});}
});
