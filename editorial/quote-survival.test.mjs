import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs,approvedQuotes,candidateSources,judgeQuote,storedCopy,survivalReport,formatReport,main} from './quote-survival.mjs';

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
test('survival: found, page changed, extraction difference and no stored version are told apart',()=>withFixture(root=>{
  const report=survivalReport(root);
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
test('a source without a readable latest copy is a stored-version miss with its reason',()=>withFixture((root,{editorial,sources,state})=>{
  const unit={field:'schedule',source:'https://fixture.example.org/a',quote:'Jeden Mittwoch',cardIds:['fx-a'],origins:['verify'],snapshots:[]};
  const missing=storedCopy(editorial,sources[0],{...state['watch-a'],hash:sha('other')});
  assert.equal(missing.problem,'file-missing');
  assert.equal(judgeQuote(unit,[missing]).detail,'file-missing');
  fs.writeFileSync(path.join(editorial,'versions','watch-a',state['watch-a'].hash.slice(0,12)+'.txt'),'tampered\n');
  assert.equal(storedCopy(editorial,sources[0],state['watch-a']).problem,'hash-mismatch');
  assert.equal(storedCopy(editorial,sources[0],{}).problem,'no-baseline');
  assert.equal(judgeQuote(unit,[storedCopy(editorial,sources[0],{})]).detail,'no-baseline');
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
test('the report names counts, sources and parsers and never a quote',()=>withFixture(root=>{
  const report=survivalReport(root),text=formatReport(report,{misses:true});
  assert.match(text,/Approved claims: 6 \(6 distinct quotes\)/);assert.match(text,/Found in the latest stored copy: 3 of 6 \(50 %\)/);
  assert.match(text,/page-changed: 1/);assert.match(text,/extraction-difference: 1/);assert.match(text,/no-stored-version: 1/);
  assert.match(text,/cheerio-visible-body-v1: 3 of 5 found/);
  assert.doesNotMatch(text,/Mittwoch|Dienstag|Donnerstag|Probeweg|CHF/);
  const lines=[];main([`--root=${root}`,'--json','--misses'],line=>lines.push(line));
  const json=JSON.parse(lines[0]);assert.equal(json.rows.length,3);assert.ok(json.rows.every(row=>!('quote' in row)));
}));
test('the command reads another checkout and writes nothing',()=>withFixture(root=>{
  const before=fs.readdirSync(path.join(root,'editorial')).join();
  const run=spawnSync(process.execPath,[script,`--root=${root}`],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/Found in the latest stored copy: 3 of 6/);
  assert.equal(fs.readdirSync(path.join(root,'editorial')).join(),before);
  assert.equal(spawnSync(process.execPath,[script,'--bogus'],{encoding:'utf8'}).status,2);
}));
test('a root without private state reports nothing found and nothing to find',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-survival-empty-'));
  try{const report=survivalReport(root);assert.equal(report.claims,0);assert.match(formatReport(report),/Approved claims: 0/);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
});
