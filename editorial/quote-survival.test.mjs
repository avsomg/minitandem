import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs,approvedQuotes,candidateSources,judgeQuote,storedCopy,survivalReport,formatReport,main,calendarExtract} from './quote-survival.mjs';
import {snapshot} from './evidence.mjs';
import {calendarEvidence} from './calendar-evidence.mjs';
import {writeRecord} from './page-record.mjs';

const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'quote-survival.mjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
// Everything below is invented: places, pages, prices and quotes do not exist.
const PAGE_A='Spielgruppe Teststadt\nJeden Mittwoch von 15:00 bis 16:00 Uhr.\nEintritt CHF 8 pro Besuch.\nKeine Anmeldung noetig.';
const PAGE_B_OLD='Krabbelrunde Beispielort\nJeden Dienstag um 09:30 Uhr.\nBeitrag CHF 5.';
const PAGE_B_NEW='Krabbelrunde Beispielort\nJeden Donnerstag um 09:30 Uhr.\nBeitrag CHF 5.';
const PAGE_C='Turnen Probeweg\nSamstag 10:00 Uhr.';

function writeVersion(editorial,id,text){
  const digest=sha(text);fs.mkdirSync(path.join(editorial,'versions',id),{recursive:true});
  fs.writeFileSync(path.join(editorial,'versions',id,digest.slice(0,12)+'.txt'),text+'\n');return digest;
}
const claim=(field,source,quote,extra={})=>({key:`${field}-${sha(source+quote).slice(0,12)}`,field,value:'x',source,quote,scope:'exact-card',kind:'official',status:'supported',...extra});
function writeFixture(root){
  const editorial=path.join(root,'editorial');
  fs.mkdirSync(path.join(editorial,'agent-artifacts'),{recursive:true});
  const snapshot=(id,url,parser)=>({id,url,finalUrl:url,fetchedAt:'2026-10-02T10:00:00.000Z',parser,rawHash:null,text:'unused'});
  const claims=[
    claim('schedule','https://fixture.example.org/a','Jeden  Mittwoch von 15:00\nbis 16:00 Uhr.',{snapshotId:'snap-a'}),
    claim('price','https://fixture.example.org/a','Eintritt CHF 8 pro Besuch.',{snapshotId:'snap-a'}),
    claim('schedule','https://fixture.example.org/b','Jeden Dienstag um 09:30 Uhr.',{snapshotId:'snap-b'}),
    claim('booking','https://fixture.example.org/c','Anmeldung bis zum Vortag.',{snapshotId:'snap-c'}),
    claim('address','https://fixture.example.org/elsewhere','Probeweg 5, 9999 Teststadt',{snapshotId:'snap-d'}),
    claim('age','https://fixture.example.org/a','Kinder ab 2 Jahren.',{snapshotId:'snap-a',status:'unknown',value:null}),
    claim('min','https://fixture.example.org/a','Nicht freigegeben im Text.',{snapshotId:'snap-a'})
  ];
  fs.writeFileSync(path.join(editorial,'agent-artifacts','search.json'),JSON.stringify({role:'search',jobId:'j1',result:{bundle:{cardId:'fx-a',claims,
    snapshots:[snapshot('snap-a','https://fixture.example.org/a','cheerio-visible-body-v1'),snapshot('snap-b','https://fixture.example.org/b','cheerio-visible-body-v1'),
      snapshot('snap-c','https://fixture.example.org/c','cheerio-visible-body-v1'),snapshot('snap-d','https://fixture.example.org/elsewhere','pdftotext-layout-v1')]}}}));
  // Approved: all but the last one (min); the unknown claim is approved as unknown and has no quote to keep.
  const verdicts=claims.slice(0,6).map(item=>({key:item.key,verdict:'approve',reason:'ok'})).concat([{key:claims[6].key,verdict:'reject',reason:'no'},{key:'missing-key',verdict:'approve',reason:'ok'}]);
  fs.writeFileSync(path.join(editorial,'agent-artifacts','verify.json'),JSON.stringify({role:'verify',jobId:'j2',result:{verdicts}}));
  fs.writeFileSync(path.join(editorial,'agent-artifacts','review.json'),JSON.stringify({role:'verify',jobId:'j3',result:{verdict:'approve',draftHash:'x',approvedBindings:[]}}));
  fs.writeFileSync(path.join(editorial,'agent-artifacts','broken.json'),'not json');
  fs.writeFileSync(path.join(editorial,'approved-updates.json'),JSON.stringify({schema:1,updates:[{draft:{cardId:'fx-b',
    bindings:[{field:'schedule',source:'https://fixture.example.org/b',quote:'Jeden Dienstag um 09:30 Uhr.',snapshotId:'snap-b'},
      {field:'research.findings.0',source:'https://fixture.example.org/b',quote:'Beitrag CHF 5.',snapshotId:'snap-b'}],
    snapshots:[snapshot('snap-b','https://fixture.example.org/b','cheerio-visible-body-v1')]}}]}));
  const sources=[{id:'watch-a',url:'https://www.fixture.example.org/a/',type:'html',recordIds:['fx-a']},
    {id:'watch-b',url:'https://fixture.example.org/b',type:'html',recordIds:['fx-b']},
    {id:'watch-c',url:'https://fixture.example.org/c',type:'html',recordIds:['fx-c']}];
  fs.writeFileSync(path.join(editorial,'source-watch.json'),JSON.stringify({schema:1,sources}));
  const state={'watch-a':{hash:writeVersion(editorial,'watch-a',PAGE_A),lastSuccess:'2026-10-14T05:00:00.000Z',finalUrl:'https://fixture.example.org/a'}};
  writeVersion(editorial,'watch-b',PAGE_B_OLD);
  state['watch-b']={hash:writeVersion(editorial,'watch-b',PAGE_B_NEW),lastSuccess:'2026-10-14T05:00:00.000Z'};
  state['watch-c']={hash:writeVersion(editorial,'watch-c',PAGE_C),lastSuccess:'2026-10-14T05:00:00.000Z'};
  fs.writeFileSync(path.join(editorial,'monitor-state.json'),JSON.stringify({schema:1,sources:state,queue:[]}));
  return {editorial,sources,state};
}
const withFixture=async body=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-survival-'));
  try{return await body(root,writeFixture(root));}finally{fs.rmSync(root,{recursive:true,force:true});}
};

test('options: a root, flags, and nothing else',()=>{
  assert.equal(parseArgs(['--root=/tmp/x','--json','--misses']).root,'/tmp/x');
  assert.equal(parseArgs([]).json,false);
  assert.throws(()=>parseArgs(['--root']),/incomplete/);assert.throws(()=>parseArgs(['--size=3']),/Unknown/);assert.throws(()=>parseArgs(['x']),/Unknown argument/);
});
test('approved quotes: verdict approvals and journal bindings, each claim once, unknown claims left out',()=>withFixture(root=>{
  const {units,unresolved,unreadable}=approvedQuotes(root);
  assert.equal(unresolved,1);assert.equal(unreadable,1);
  // schedule a, price a, schedule b (verify + journal), booking c, address elsewhere, finding of b from the journal.
  assert.equal(units.length,6);
  const b=units.find(unit=>unit.field==='schedule'&&unit.source.endsWith('/b'));
  assert.deepEqual(b.origins.sort(),['journal','verify']);assert.deepEqual(b.cardIds.sort(),['fx-a','fx-b']);
  assert.ok(!units.some(unit=>unit.field==='min'||unit.field==='age'));
}));
test('survival: found, page changed, extraction difference and no stored version are told apart',()=>withFixture(async root=>{
  const report=await survivalReport(root);
  assert.equal(report.claims,6);
  // Found: both quotes of page a (whitespace differs) and the journal finding of b.
  const by=Object.fromEntries(report.rows.map(row=>[`${row.field}@${row.source.split('/').pop()}`,row]));
  assert.equal(by['schedule@a'].found,true);assert.equal(by['price@a'].found,true);
  // The old text of b has Dienstag, the latest has Donnerstag: the quote was there and is gone.
  assert.equal(by['schedule@b'].reason,'page-changed');
  // The finding quote is in both versions of b.
  assert.equal(by['research.findings.0@b'].found,true);
  assert.equal(by['booking@c'].reason,'extraction-difference');
  assert.equal(by['address@elsewhere'].reason,'no-stored-version');assert.equal(by['address@elsewhere'].detail,'not-watched');
  assert.equal(report.found,3);assert.equal(report.missed,3);
}));
test('a source without a readable latest copy is a stored-version miss with its reason',()=>withFixture(async(root,{editorial,sources,state})=>{
  const unit={field:'schedule',source:'https://fixture.example.org/a',quote:'Jeden Mittwoch',cardIds:['fx-a'],origins:['verify'],snapshots:[]};
  const missing=await storedCopy(editorial,sources[0],{...state['watch-a'],hash:sha('other')});
  assert.equal(missing.problem,'file-missing');
  assert.equal(judgeQuote(unit,[missing]).detail,'file-missing');
  fs.writeFileSync(path.join(editorial,'versions','watch-a',state['watch-a'].hash.slice(0,12)+'.txt'),'tampered\n');
  assert.equal((await storedCopy(editorial,sources[0],state['watch-a'])).problem,'hash-mismatch');
  assert.equal((await storedCopy(editorial,sources[0],{})).problem,'no-baseline');
  assert.equal(judgeQuote(unit,[await storedCopy(editorial,sources[0],{})]).detail,'no-baseline');
}));
test('raw hashes tell a changed page from a different reading when both are known',()=>{
  const unit={field:'schedule',source:'https://fixture.example.org/a',quote:'Quote that is not there',cardIds:[],origins:['verify'],snapshots:[{id:'s',parser:'cheerio-visible-body-v1',rawHash:'aa'}]};
  const copy=rawHash=>({sourceId:'w',latest:{views:{monitor:'other text'},rawHash},older:[]});
  assert.equal(judgeQuote(unit,[copy('bb')]).reason,'page-changed');
  assert.equal(judgeQuote(unit,[copy('aa')]).reason,'extraction-difference');
  assert.equal(judgeQuote(unit,[copy(null)]).reason,'extraction-difference');
});
test('candidates: the address with or without www and slash, the monitor final address, the card own source first',()=>{
  const sources=[{id:'one',url:'https://www.fixture.example.org/p/',recordIds:['c1']},{id:'two',url:'https://fixture.example.org/p',recordIds:['c2']},
    {id:'moved',url:'https://old.example.org/p',recordIds:['c3']},{id:'other',url:'https://fixture.example.org/q'}];
  const state={moved:{finalUrlNorm:'fixture.example.org/p'}};
  const unit=(cardIds)=>({source:'https://fixture.example.org/p',cardIds});
  assert.deepEqual(candidateSources(sources,state,unit(['c2'])).map(source=>source.id),['two']);
  assert.deepEqual(candidateSources(sources,state,unit(['zz'])).map(source=>source.id),['one','two','moved']);
  assert.deepEqual(candidateSources(sources,state,{source:'https://nowhere.example.org/',cardIds:[]}),[]);
});
test('the report names counts, sources and parsers and never a quote',()=>withFixture(async root=>{
  const report=await survivalReport(root),text=formatReport(report,{misses:true});
  assert.match(text,/Approved claims: 6 \(6 distinct quotes\)/);assert.match(text,/Found in the latest stored copy: 3 of 6 \(50 %\)/);
  assert.match(text,/page-changed: 1/);assert.match(text,/extraction-difference: 1/);assert.match(text,/no-stored-version: 1/);
  assert.match(text,/cheerio-visible-body-v1: 3 of 5 found/);
  assert.doesNotMatch(text,/Mittwoch|Dienstag|Donnerstag|Probeweg|CHF/);
  const lines=[];await main([`--root=${root}`,'--json','--misses'],line=>lines.push(line));
  const json=JSON.parse(lines[0]);assert.equal(json.rows.length,3);assert.ok(json.rows.every(row=>!('quote' in row)));
}));
test('the command reads another checkout and writes nothing',()=>withFixture(root=>{
  const before=fs.readdirSync(path.join(root,'editorial')).join();
  const run=spawnSync(process.execPath,[script,`--root=${root}`],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/Found in the latest stored copy: 3 of 6/);
  assert.equal(fs.readdirSync(path.join(root,'editorial')).join(),before);
  assert.equal(spawnSync(process.execPath,[script,'--bogus'],{encoding:'utf8'}).status,2);
}));
test('a root without private state reports nothing found and nothing to find',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-survival-empty-'));
  try{const report=await survivalReport(root);assert.equal(report.claims,0);assert.match(formatReport(report),/Approved claims: 0/);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
});

// Stage 2: the page records add the full body and the alarm lines, and a calendar extract is derived from the stored raw calendar.
const FEED='https://feed.example.org/ics',EVENT='https://fixture.example.org/feed-event/7';
const RAW_ICS=`BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:7\nURL:${EVENT}\nSUMMARY:Puppentheater in Teststadt\nDTSTART:20261104T140000Z\nDTEND:20261104T150000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:8\nURL:https://fixture.example.org/feed-event/8\nSUMMARY:Anderes Treffen in Nirgendwo\nDTSTART:20261105T140000Z\nEND:VEVENT\nEND:VCALENDAR\n`;
const FX_CARD={id:'fx-feed',name:'Fixture feed card',category:'play',town:'Teststadt',status:'active',sources:[{url:EVENT,label:'Event'}]};
function recordFixture(root,{storeRaw=true}={}){
  const editorial=path.join(root,'editorial');
  fs.mkdirSync(path.join(editorial,'agent-artifacts'),{recursive:true});fs.mkdirSync(path.join(editorial,'typesafe-runtime','snapshots'),{recursive:true});
  fs.writeFileSync(path.join(root,'data.js'),`(() => {\n  window.ACTIVITIES = [\n${JSON.stringify(FX_CARD)}\n  ];\n})();\n`);
  for(const file of ['data-reviewed.js','data-practical.js','regions.js','data-geo.js','planning.js','exchange.js'])fs.writeFileSync(path.join(root,file),'');
  // A page the controller captured on 2 October: body text, and the calendar the extract was derived from.
  const page='https://fixture.example.org/page';
  const body=snapshot({url:page,fetchedAt:'2026-10-02T10:00:00.000Z',parser:'cheerio-visible-body-v1',rawHash:'aa',text:'Spielgruppe Teststadt\nJeden Mittwoch 15:00 bis 16:00 Uhr.\nKontakt: Fixture Verein, Probeweg 5'});
  const rawSnapshot=snapshot({url:FEED,fetchedAt:'2026-10-02T10:00:00.000Z',parser:'calendar-raw-v1',contentType:'text/calendar',text:RAW_ICS});
  const extract=calendarEvidence(rawSnapshot,FX_CARD).evidence;
  const claims=[claim('schedule',page,'Jeden Mittwoch 15:00 bis 16:00 Uhr.',{snapshotId:body.id}),claim('address',page,'Kontakt: Fixture Verein, Probeweg 5',{snapshotId:body.id}),
    claim('status',page,'Wegen Umbau bis 30.11.2099 geschlossen',{snapshotId:body.id}),claim('events',FEED,'"title": "Puppentheater in Teststadt"',{snapshotId:extract.id})];
  fs.writeFileSync(path.join(editorial,'agent-artifacts','search.json'),JSON.stringify({role:'search',result:{bundle:{cardId:'fx-feed',claims,snapshots:[body,extract]}}}));
  fs.writeFileSync(path.join(editorial,'agent-artifacts','verify.json'),JSON.stringify({role:'verify',result:{verdicts:claims.map(item=>({key:item.key,verdict:'approve'}))}}));
  if(storeRaw)fs.writeFileSync(path.join(editorial,'typesafe-runtime','snapshots',rawSnapshot.id+'.json'),JSON.stringify(rawSnapshot));
  fs.writeFileSync(path.join(editorial,'source-watch.json'),JSON.stringify({schema:1,sources:[{id:'page',url:page,type:'html',recordIds:['fx-feed']},{id:'feed',url:FEED,type:'ics',recordIds:['fx-feed']}]}));
  const pageText='Spielgruppe Teststadt\nJeden Mittwoch 15:00 bis 16:00 Uhr.',feedText='SUMMARY:Puppentheater in Teststadt\nDTSTART:20261104T140000Z';
  const state={page:{hash:writeVersion(editorial,'page',pageText),lastSuccess:'2026-10-14T05:00:00.000Z'},feed:{hash:writeVersion(editorial,'feed',feedText),lastSuccess:'2026-10-14T05:00:00.000Z'}};
  fs.writeFileSync(path.join(editorial,'monitor-state.json'),JSON.stringify({schema:1,sources:state,queue:[]}));
  return {editorial,state,pageText,feedText,body,extract};
}
const record=(editorial,id,hash,over)=>writeRecord(editorial,id,{version:hash.slice(0,12),hash,fetchedAt:'2026-10-14T05:00:00.000Z',finalUrl:'https://fixture.example.org/x',contentType:'text/html',status:200,parser:'v2',
  rawHash:'bb',rawBytes:2,raw:null,full:null,alarm:[],...over});

const withRecordFixture=async(options,body)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-survival-records-'));
  try{return await body(root,recordFixture(root,options));}finally{fs.rmSync(root,{recursive:true,force:true});}
};
test('without page records only the change text is searched, and the calendar extract cannot be derived',()=>withRecordFixture({},async root=>{
  const report=await survivalReport(root);
  assert.equal(report.claims,4);assert.equal(report.found,1);assert.deepEqual(report.foundIn,{monitor:1});
  assert.deepEqual(report.byReason,{'extraction-difference':3});
  // Ceiling: all four claims are on watched pages and were taken from texts a new record keeps.
  assert.deepEqual(report.ceiling,{watched:4,notWatched:0,reproducible:4,notReproducible:0});
}));
test('with page records the footer line is found in the full body, the notice in the alarm lines and the extract by deriving it',()=>withRecordFixture({},async(root,{editorial,state,pageText})=>{
  await record(editorial,'page',state.page.hash,{full:{parser:'cheerio-visible-body-v1',text:pageText+'\nKontakt: Fixture Verein, Probeweg 5'},alarm:['Wegen Umbau bis 30.11.2099 geschlossen']});
  await record(editorial,'feed',state.feed.hash,{contentType:'text/calendar',full:{parser:'calendar-raw-v1',text:RAW_ICS.trim()}});
  const report=await survivalReport(root);
  assert.equal(report.found,4);assert.equal(report.missed,0);assert.deepEqual(report.foundIn,{monitor:2,full:2,derived:1});
  const by=Object.fromEntries(report.rows.map(row=>[row.field,row.views]));
  assert.deepEqual(by.schedule,['monitor','full']);assert.deepEqual(by.address,['full']);assert.deepEqual(by.status,['monitor']);assert.deepEqual(by.events,['derived']);
  assert.match(formatReport(report),/Found in the latest stored copy: 4 of 4 \(100 %\)/);
}));
test('a record that does not belong to the stored version, or whose full body is damaged, is not used',()=>withRecordFixture({},async(root,{editorial,state,pageText})=>{
  await record(editorial,'page',state.page.hash,{full:{parser:'cheerio-visible-body-v1',text:pageText+'\nKontakt: Fixture Verein, Probeweg 5'}});
  const file=path.join(editorial,'page-records','page',state.page.hash.slice(0,12)+'.full.txt.gz');
  fs.writeFileSync(file,fs.readFileSync(file).subarray(0,10));
  const damaged=await survivalReport(root);
  assert.equal(damaged.rows.find(row=>row.field==='address').found,false);
  const other=JSON.parse(fs.readFileSync(path.join(editorial,'page-records','page',state.page.hash.slice(0,12)+'.json'),'utf8'));
  fs.writeFileSync(path.join(editorial,'page-records','page',state.page.hash.slice(0,12)+'.json'),JSON.stringify({...other,hash:'f'.repeat(64)}));
  assert.equal((await survivalReport(root)).rows.find(row=>row.field==='address').found,false);
}));
test('raw hashes of the record and of the claim snapshot decide between a changed page and a different reading',()=>withRecordFixture({},async(root,{editorial,state})=>{
  await record(editorial,'page',state.page.hash,{rawHash:'aa',full:{parser:'cheerio-visible-body-v1',text:'Spielgruppe Teststadt\nSomething else entirely'}});
  assert.equal((await survivalReport(root)).rows.find(row=>row.field==='address').reason,'extraction-difference');
  await record(editorial,'page',state.page.hash,{rawHash:'cc',full:{parser:'cheerio-visible-body-v1',text:'Spielgruppe Teststadt\nSomething else entirely'}});
  assert.equal((await survivalReport(root)).rows.find(row=>row.field==='address').reason,'page-changed');
}));
test('the simulation derives the extract again from the raw calendar of the same fetch, when it is stored',()=>withRecordFixture({},async root=>{
  const report=await survivalReport(root,{simulate:true});
  assert.deepEqual(report.simulation,{claims:1,rawAvailable:1,reproduced:1});
  assert.match(formatReport(report),/Simulation .*: 1 of 1 reproduced, raw calendar stored for 1/);
  assert.equal((await survivalReport(root)).simulation,undefined);
}));
test('the simulation reports a calendar whose raw snapshot is gone as not available',()=>withRecordFixture({storeRaw:false},async root=>{
  assert.deepEqual((await survivalReport(root,{simulate:true})).simulation,{claims:1,rawAvailable:0,reproduced:0});
}));
test('a calendar extract is derived by the same code that made it, and not for a card the feed does not mention',()=>{
  const text=calendarExtract(RAW_ICS,{url:FEED},FX_CARD,{fetchedAt:'2026-10-14T05:00:00.000Z'});
  assert.match(text,/"title": "Puppentheater in Teststadt"/);
  assert.throws(()=>calendarExtract(RAW_ICS,{url:FEED},{...FX_CARD,sources:[{url:'https://fixture.example.org/nowhere'}]},{fetchedAt:'2026-10-14T05:00:00.000Z'}));
});
