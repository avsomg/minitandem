import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {snapshot,validateSnapshot,locateQuote,evidenceProblem,publicUrl,captureUrl,htmlText,saveSnapshot,hash,MAX_PDF_BYTES,monitorSnapshot,monitorRecord,capturedViews,capturedSet} from './evidence.mjs';
import {runMonitor,normalize} from './monitor.mjs';
import {writeRecord} from './page-record.mjs';

const now='2026-10-01T10:00:00Z';
const sample=()=>snapshot({url:'https://example.org/course',fetchedAt:now,text:'Kinder ab 3 Jahren. Teilnahme mit einer Bezugsperson. Anmeldung erforderlich.'});

test('HTML parser decodes entities and preserves table field boundaries',()=>{
  const text=htmlText(Buffer.from('<body><nav>menu</nav><script>secret()</script><p>Enfants d&egrave;s 6 mois</p><table><tr><td>PE2</td><td>2 &agrave; 4 ans</td><td>CHF 250</td></tr></table></body>'));
  assert.match(text,/Enfants dès 6 mois/);
  assert.match(text,/PE2\n2 à 4 ans\nCHF 250/);
  assert.doesNotMatch(text,/secret|menu/);
});
test('snapshots bind exact content, URL, project and retrieval instant',()=>{
  const evidence=sample();assert.equal(validateSnapshot(evidence),evidence);
  assert.throws(()=>validateSnapshot({...evidence,text:evidence.text+' change'}));
  assert.throws(()=>validateSnapshot({...evidence,url:'https://example.org/other'}));
  assert.throws(()=>validateSnapshot({...evidence,project:'angeline'}));
  assert.throws(()=>snapshot({...evidence,fetchedAt:'2026-10-01'}));
});
test('quote validation tolerates whitespace, not invented or paraphrased words',()=>{
  assert.ok(locateQuote(sample(),'Kinder  ab\n3 Jahren.'));
  assert.equal(locateQuote(sample(),'Kinder ab 2 Jahren.'),null);
  assert.equal(locateQuote(sample(),''),null);
});
test('stale and future evidence cannot be presented as a current check',()=>{
  assert.equal(evidenceProblem(sample(),'2026-10-02T10:00:00Z',7),null);
  assert.equal(evidenceProblem(sample(),'2026-10-09T10:00:00Z',7),'stale-evidence');
  assert.equal(evidenceProblem(sample(),'2026-09-30T10:00:00Z',7),'future-evidence');
});
test('source fetches reject credentials, local addresses and unsafe redirects',async()=>{
  for(const url of ['http://example.org','https://localhost','https://127.0.0.1','https://[::1]','https://x.local','https://user:pass@example.org'])assert.throws(()=>publicUrl(url));
  let calls=0;
  await assert.rejects(captureUrl('https://example.org',{lookupImpl:async()=>[{address:'10.0.0.4'}],fetchImpl:async()=>{calls++;}}),/non-public/);
  assert.equal(calls,0);
  await assert.rejects(captureUrl('https://example.org',{lookupImpl:async()=>[{address:'93.184.216.34'}],fetchImpl:async()=>new Response('',{status:302,headers:{location:'https://localhost/private'}})}),/Non-public/);
});
test('capture keeps provenance and blocks unsupported or oversized responses',async()=>{
  const options={now,lookupImpl:async()=>[{address:'93.184.216.34'}]};
  const evidence=await captureUrl('https://example.org',{...options,fetchImpl:async()=>new Response('<body><p>Children participate with a parent.</p></body>',{headers:{'content-type':'text/html'}})});
  assert.equal(evidence.parser,'cheerio-visible-body-v1');assert.equal(evidence.textHash,hash(evidence.text));
  await assert.rejects(captureUrl('https://example.org',{...options,fetchImpl:async()=>new Response('image',{headers:{'content-type':'image/gif'}})}),/Unsupported/);
  await assert.rejects(captureUrl('https://example.org',{...options,maxBytes:10,fetchImpl:async()=>new Response('a'.repeat(20),{headers:{'content-type':'text/plain'}})}),/byte limit/);
});
test('evidence snapshots are immutable',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-evidence-test-'));
  try{const file=await saveSnapshot(directory,sample());await saveSnapshot(directory,sample());assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),sample());}
  finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('large official PDFs use a bounded separate limit without relaxing HTML limits',async()=>{
  const options={now,lookupImpl:async()=>[{address:'93.184.216.34'}]};
  const bytes=Buffer.alloc(6_000_001);bytes.write('%PDF-1.7');
  const evidence=await captureUrl('https://example.org/programme.pdf',{...options,
    fetchImpl:async()=>new Response(bytes,{headers:{'content-type':'application/pdf'}}),
    pdfImpl:async input=>{assert.equal(input.length,bytes.length);return 'Full programme text: all activities are free.';}});
  assert.equal(evidence.parser,'pdftotext-layout-v1');assert.equal(evidence.rawHash,hash(bytes));
  await assert.rejects(captureUrl('https://example.org/programme.pdf',{...options,
    fetchImpl:async()=>new Response(null,{headers:{'content-type':'application/pdf','content-length':String(MAX_PDF_BYTES+1)}}),
    pdfImpl:async()=>{throw Error('Oversized PDF must never reach the parser');}}),/byte limit/);
  await assert.rejects(captureUrl('https://example.org',{...options,
    fetchImpl:async()=>new Response(null,{headers:{'content-type':'text/html','content-length':'2000001'}})}),/byte limit/);
});

test('monitor snapshots are labelled by the parser that produced the stored text',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-snap-'));
  const text='Open every Saturday from nine to noon for families.';
  const h=hash(text);
  await fs.mkdir(path.join(dir,'versions','s1'),{recursive:true});
  await fs.writeFile(path.join(dir,'versions','s1',h.slice(0,12)+'.txt'),text+'\n');
  const source={id:'s1',url:'https://example.org/p'};
  const entry={hash:h,lastSuccess:'2026-10-01T10:00:00.000Z'};
  assert.equal((await monitorSnapshot(source,entry,dir)).parser,'monitor-text-v1');
  assert.equal((await monitorSnapshot(source,{...entry,parser:'v2'},dir)).parser,'monitor-text-v2');
});

// F11: the name is resolved once per hop, checked, and the connection is pinned to what was checked. No DNS, no network.
const wire=(log,answers)=>(target,options,callback)=>{
  log.push({host:target.hostname,path:target.pathname,options});
  const req=new EventEmitter();
  req.end=()=>setImmediate(()=>{const answer=answers.shift();if(answer instanceof Error)req.emit('error',answer);else callback(answer);});
  return req;
};
const wireReply=(status,headers,body)=>Object.assign(Readable.from(body==null?[]:[Buffer.from(body)]),{statusCode:status,statusMessage:'x',headers});
const connectTo=(call,name,options={all:true})=>new Promise(resolve=>call.options.lookup(name,options,(error,address)=>resolve(error?error:address)));
test('a name that answers public for the check and private for the connection cannot move the connection',async()=>{
  const log=[],asked=[];
  // The fake resolver: public the first time a name is asked, private every time after. A second resolution would be caught here.
  const lookupImpl=async name=>{asked.push(name);return [{address:asked.length===1?'93.184.216.34':'10.0.0.5',family:4}];};
  const requestImpl=wire(log,[wireReply(200,{'content-type':'text/html'},'<body><p>Children participate with a parent, every Wednesday morning.</p></body>')]);
  const evidence=await captureUrl('https://example.org/offer',{now,lookupImpl,requestImpl});
  assert.deepEqual(asked,['example.org']);
  assert.equal(log.length,1);assert.equal(log[0].host,'example.org');assert.equal(log[0].options.agent,false);
  assert.deepEqual(await connectTo(log[0],'example.org'),[{address:'93.184.216.34',family:4}]);
  assert.match((await connectTo(log[0],'internal.example.org')).message,/another host/);
  assert.equal(evidence.captureMethod,'node-pinned-https');assert.match(evidence.text,/Children participate/);
});
test('every redirect hop is resolved, checked and pinned on its own',async()=>{
  const log=[],answers={'a.example.org':['93.184.216.1','10.0.0.1'],'b.example.org':['93.184.216.2','10.0.0.2'],'c.example.org':['93.184.216.3','10.0.0.3']},asked=[];
  const lookupImpl=async name=>{asked.push(name);return [{address:answers[name].shift(),family:4}];};
  const requestImpl=wire(log,[wireReply(302,{location:'https://b.example.org/next'}),wireReply(301,{location:'https://c.example.org/last'}),
    wireReply(200,{'content-type':'text/plain'},'Plain text at the end of two redirects, long enough to keep.')]);
  const evidence=await captureUrl('https://a.example.org/start',{now,lookupImpl,requestImpl});
  assert.deepEqual(asked,['a.example.org','b.example.org','c.example.org']);
  assert.deepEqual(log.map(call=>call.host+call.path),['a.example.org/start','b.example.org/next','c.example.org/last']);
  assert.deepEqual(await Promise.all(log.map((call,index)=>connectTo(call,call.host))),
    [[{address:'93.184.216.1',family:4}],[{address:'93.184.216.2',family:4}],[{address:'93.184.216.3',family:4}]]);
  assert.equal(evidence.finalUrl,'https://c.example.org/last');
});
test('a private answer at a later hop is refused before a connection is made',async()=>{
  const log=[],asked=[];
  const lookupImpl=async name=>{asked.push(name);return [{address:name==='a.example.org'?'93.184.216.1':'192.168.1.20',family:4}];};
  const requestImpl=wire(log,[wireReply(302,{location:'https://b.example.org/'})]);
  await assert.rejects(captureUrl('https://a.example.org/',{now,lookupImpl,requestImpl}),/non-public/);
  assert.equal(log.length,1);
});
test('one private address among public ones refuses the whole answer',async()=>{
  const log=[];
  await assert.rejects(captureUrl('https://example.org/',{now,requestImpl:wire(log,[]),lookupImpl:async()=>[{address:'93.184.216.34',family:4},{address:'169.254.169.254',family:4}]}),/non-public/);
  assert.equal(log.length,0);
});
test('when the pinned native connection fails, the curl fallback gets the same checked addresses',async()=>{
  const log=[],checked=[{address:'93.184.216.34',family:4}];let given;
  const evidence=await captureUrl('https://example.org/',{now,lookupImpl:async()=>checked,requestImpl:wire(log,[Error('socket hang up')]),
    fallbackImpl:async(url,addresses)=>{given=addresses;return {method:'curl-pinned-ipv4',response:new Response('Fallback page text that is long enough to keep.',{headers:{'content-type':'text/plain'}})};}});
  assert.deepEqual(given,checked);assert.equal(evidence.captureMethod,'curl-pinned-ipv4');
});

// Stage 2: the capture of a watched page also holds the monitor's view of the same bytes; the monitor's record holds the capture's text.
const WATCHED='https://example.org/spielgruppe',watchSource={id:'fx',url:WATCHED,type:'html',minChars:10};
const WATCHED_PAGE=`<html><head><title>Spielgruppe Teststadt: vorübergehend geschlossen bis 30.11.2099</title></head><body><header><p>Montag Ruhetag</p></header><nav>Startseite</nav>
<main><h1>Spielgruppe Teststadt</h1><p>Jeden Mittwoch 15:00 bis 16:00 Uhr fuer Kinder von 2 bis 4 Jahren.</p></main><footer><p>Kontakt: Fixture Verein, Probeweg 5</p></footer></body></html>`;
const watchOptions={now,lookupImpl:async()=>[{address:'93.184.216.34'}],fetchImpl:async()=>new Response(WATCHED_PAGE,{headers:{'content-type':'text/html; charset=utf-8'}})};
test('a capture of a watched page holds the monitor view of the same bytes as a snapshot of its own, kept beside it',async()=>{
  const evidence=await captureUrl(WATCHED,{...watchOptions,watch:{source:watchSource,hostIgnore:{},records:[]}});
  const [view,...more]=capturedViews(evidence);
  assert.equal(more.length,0);assert.equal(view.parser,'monitor-view-v2');validateSnapshot(view);
  for(const key of ['url','finalUrl','fetchedAt','rawHash','contentType'])assert.equal(view[key],evidence[key],key);
  assert.notEqual(view.id,evidence.id);assert.deepEqual(capturedSet(evidence).map(item=>item.id),[evidence.id,view.id]);
  // The footer is in the capture only, the title notice in the view only, the main text in both.
  assert.ok(locateQuote(evidence,'Kontakt: Fixture Verein, Probeweg 5'));assert.equal(locateQuote(view,'Kontakt: Fixture Verein, Probeweg 5'),null);
  assert.ok(locateQuote(view,'vorübergehend geschlossen bis 30.11.2099'));assert.equal(locateQuote(evidence,'vorübergehend geschlossen bis 30.11.2099'),null);
  assert.ok(locateQuote(evidence,'Jeden Mittwoch 15:00 bis 16:00 Uhr'));assert.ok(locateQuote(view,'Jeden Mittwoch 15:00 bis 16:00 Uhr'));
  // The capture itself is what it was: same parser, no extra field, nothing of the view in its JSON.
  assert.equal(evidence.parser,'cheerio-visible-body-v1');
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)),JSON.parse(JSON.stringify({...evidence})));assert.equal(Object.keys(evidence).includes('views'),false);
  assert.equal(capturedViews(JSON.parse(JSON.stringify(evidence))).length,0);
});
test('no watch entry, a page the monitor would refuse, another content type or an identical text give no view',async()=>{
  const view=watch=>captureUrl(WATCHED,{...watchOptions,watch}).then(capturedViews);
  assert.equal((await view(null)).length,0);assert.equal((await view(undefined)).length,0);
  assert.equal((await view({source:{...watchSource,required:['Nicht vorhanden']}})).length,0);
  assert.equal((await view({source:{...watchSource,type:'pdf'}})).length,0);
  assert.equal((await view({source:{...watchSource,minChars:100000}})).length,0);
  // A plain text page: the monitor's text and the body are the same words, so a second snapshot would add nothing.
  const plain=await captureUrl(WATCHED,{...watchOptions,fetchImpl:async()=>new Response('Spielgruppe jeden Mittwoch von 15:00 bis 16:00 Uhr.',{headers:{'content-type':'text/plain'}}),watch:{source:watchSource}});
  assert.equal(capturedViews(plain).length,0);assert.equal(plain.parser,'plain-text-v1');
});
test('host rules of the watch entry apply to the view, not to the capture',async()=>{
  const watch={source:watchSource,hostIgnore:{'example.org':{selectors:['footer','header']}}};
  const evidence=await captureUrl(WATCHED,{...watchOptions,watch});
  assert.ok(locateQuote(evidence,'Probeweg 5'));
  assert.equal(locateQuote(capturedViews(evidence)[0],'Probeweg 5'),null);
});
test('the same bytes give the same texts from the monitor record and from a controller capture',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-views-')),state={schema:1,sources:{},queue:[]},fetchedAt='2026-10-14T05:00:00.000Z';
  try{
    const fetchImpl=async()=>new Response(WATCHED_PAGE,{headers:{'content-type':'text/html; charset=utf-8'}});
    await runMonitor({sources:[watchSource],state,now:fetchedAt,fetchImpl,record:(id,info)=>writeRecord(dir,id,info),
      snapshot:async(id,digest,text)=>{await fs.mkdir(path.join(dir,'versions',id),{recursive:true});await fs.writeFile(path.join(dir,'versions',id,digest.slice(0,12)+'.txt'),text+'\n');}});
    const stored=await monitorRecord(watchSource,{...state.sources.fx,parser:'v2'},dir);
    const captured=await captureUrl(WATCHED,{...watchOptions,now:fetchedAt,watch:{source:watchSource,hostIgnore:{},records:[]}});
    const [view]=capturedViews(captured);
    assert.equal(stored.full.text,captured.text);assert.equal(stored.full.parser,captured.parser);assert.equal(stored.full.rawHash,captured.rawHash);
    assert.equal(stored.view.text,view.text);assert.equal(stored.view.parser,view.parser);
    assert.equal(stored.watch.text,normalize(WATCHED_PAGE,watchSource,fetchedAt,'v2'));assert.equal(stored.watch.parser,'monitor-text-v2');
    // With the same fetch instant the stored copies and the capture even share identities; none of them is registered anywhere by this.
    assert.equal(stored.full.id,captured.id);assert.equal(stored.view.id,view.id);
    // A quote from either view is found in the other's record.
    for(const quote of ['Kontakt: Fixture Verein','vorübergehend geschlossen bis 30.11.2099','Jeden Mittwoch 15:00 bis 16:00 Uhr']){
      assert.ok(locateQuote(stored.full,quote)||locateQuote(stored.view,quote),quote);
      assert.ok(locateQuote(captured,quote)||locateQuote(view,quote),quote);
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a source without a page record reads as before, and with one it also gives the full view and the monitor view',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-views-old-'));
  try{
    const text='Open every Saturday from nine to noon for families.',h=hash(text);
    await fs.mkdir(path.join(dir,'versions','fx'),{recursive:true});await fs.writeFile(path.join(dir,'versions','fx',h.slice(0,12)+'.txt'),text+'\n');
    const entry={hash:h,lastSuccess:'2026-10-01T10:00:00.000Z',parser:'v2'};
    const old=await monitorRecord(watchSource,entry,dir);
    assert.equal(old.watch.text,text);assert.equal(old.view,null);assert.equal(old.full,null);assert.equal(old.meta,null);
    assert.equal(await monitorRecord(watchSource,{},dir),null);
    // With a record the same entry reads the full view, the view and the provenance of that fetch.
    await writeRecord(dir,'fx',{version:h.slice(0,12),hash:h,fetchedAt:'2026-10-02T10:00:00.000Z',finalUrl:WATCHED,contentType:'text/html',status:200,parser:'v2',rawHash:hash('x'),rawBytes:1,raw:null,
      full:{parser:'cheerio-visible-body-v1',text:'Open every Saturday from nine to noon for families. Footer address.'},alarm:['Closed on 24 December']});
    const fresh=await monitorRecord(watchSource,entry,dir);
    assert.equal(fresh.full.text,'Open every Saturday from nine to noon for families. Footer address.');assert.equal(fresh.view.text,text+'\nClosed on 24 December');
    assert.equal(fresh.full.fetchedAt,'2026-10-02T10:00:00.000Z');assert.equal(fresh.full.rawHash,hash('x'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
