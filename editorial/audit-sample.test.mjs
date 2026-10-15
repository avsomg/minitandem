import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {JobQueue} from './jobs.mjs';
import {snapshot,hash} from './evidence.mjs';
import {PROJECT_ID} from './project-id.mjs';
import {loadCatalog} from './quality.mjs';
import {FIELDS,TEXT_BUDGET,parseArgs,shuffled,drawSample,normalizeUrl,cardView,buildPrompt,fitOriginals,trimText,relevantTerms,judgeAnswer,summarize,
  claudeArguments,stopsRun,loadContext,main} from './audit-sample.mjs';

const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'audit-sample.mjs');
// Everything below is invented: places, organisers, pages and prices do not exist.
const card=(id,extra={})=>({id,name:`Fixture ${id}`,category:'play',town:'Teststadt',route:'local',format:'group',status:'active',min:2,max:4,age:'2 to 4 years',
  parent:'yes',languages:['DE'],schedule:'Wednesday 15:00-16:00',days:[3],events:[],address:'Probeweg 5, 9999 Teststadt',price:'CHF 8 per visit',priceKind:'visit',
  amount:8,contacts:[{name:'Fixture Verein',phone:'000 000 00 00',email:'info@example.org'}],sources:[{url:`https://fixture.example.org/${id}`,label:'Official source'}],
  notes:[],checked:'2026-09-30',practical:{booking:{value:false,text:'No registration needed',source:`https://fixture.example.org/${id}`,checked:'2026-09-30'}},...extra});
const CARDS=[card('fx-edited'),card('fx-checked'),card('fx-base-1'),card('fx-base-2'),
  card('fx-base-3'),card('fx-base-4'),card('fx-base-5'),card('fx-feed',{sources:[{url:'https://feed.example.org/ics',label:'Feed'},{url:'https://fixture.example.org/feed-event/7/2',label:'Event'}]}),
  card('fx-feed-b',{sources:[{url:'https://feed.example.org/ics',label:'Feed'}]}),card('fx-closed',{status:'closed'}),card('fx-excluded',{status:'excluded'})];
const PAGE=(place,price)=>`Programm ${place}\nJeden Mittwoch von 15:00 bis 16:00 Uhr treffen sich Kinder von 2 bis 4 Jahren in Teststadt.\nEintritt ${price} pro Besuch.\nKeine Anmeldung noetig.\nKontakt: info@example.org`;
const FEED_RAW='BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nURL:https://fixture.example.org/feed-event/7\nSUMMARY:Puppentheater in Teststadt\nDTSTART:20261104T140000Z\nEND:VEVENT\nBEGIN:VEVENT\nURL:https://fixture.example.org/feed-event/8\nSUMMARY:Anderes Treffen in Nirgendwo\nDTSTART:20261105T140000Z\nEND:VEVENT\nEND:VCALENDAR\n';
const FEED_SELECTED=JSON.stringify({events:[{url:'https://fixture.example.org/feed-event/7',title:'Puppentheater in Teststadt',start:'2026-11-04T15:00'}]},null,2);
const snap=(url,text,fetchedAt='2026-10-10T08:00:00.000Z',parser='cheerio-visible-body-v1')=>snapshot({url,fetchedAt,text,parser});

function writeFixture(root,{limit=null}={}){
  const editorial=path.join(root,'editorial');
  fs.mkdirSync(path.join(editorial,'workflow-state'),{recursive:true});
  fs.writeFileSync(path.join(root,'data.js'),`(() => {\n  window.ACTIVITIES = [\n${CARDS.map(c=>JSON.stringify(c)).join(',\n')}\n  ];\n})();\n`);
  for(const file of ['data-reviewed.js','data-practical.js','regions.js','data-geo.js','planning.js','exchange.js'])fs.writeFileSync(path.join(root,file),'');
  fs.writeFileSync(path.join(editorial,'approved-updates.json'),JSON.stringify({schema:1,project:PROJECT_ID,updates:[
    {jobId:'job-edit',approvedOn:'2026-10-15',baseRecord:{},research:{},draft:{cardId:'fx-edited',patch:{},practicalPatch:{},warnings:null,findings:[]}}]}));
  // The queue: registered snapshots, and jobs that mention some of them.
  const queue=new JobQueue(path.join(editorial,'workflow-state','jobs.sqlite'));
  const put=evidence=>{queue.db.prepare('INSERT INTO captured_evidence VALUES (?,?,?)').run(evidence.id,JSON.stringify(evidence),evidence.fetchedAt);return evidence;};
  const edited=put(snap('https://fixture.example.org/fx-edited',PAGE('Edited','CHF 8')));
  // The same page captured twice, the page changed in between: the later capture is the original.
  put(snap('https://fixture.example.org/fx-base-1',PAGE('Base eins','CHF 6'),'2026-10-01T08:00:00.000Z'));
  put(snap('https://fixture.example.org/fx-base-1',PAGE('Base eins','CHF 9'),'2026-10-12T08:00:00.000Z'));
  put(snap('https://fixture.example.org/fx-base-2',PAGE('Base zwei','CHF 8')));
  put(snap('https://fixture.example.org/fx-base-5','too short for any check'.padEnd(40,'.')));
  put(snap('https://fixture.example.org/fx-closed',PAGE('Closed','CHF 8')));
  const checked=put(snap('https://fixture.example.org/elsewhere',PAGE('Checked','CHF 12')));
  const raw=put(snap('https://feed.example.org/ics',FEED_RAW,'2026-10-11T08:00:00.000Z','calendar-raw-v1'));
  const selected=put(snap('https://feed.example.org/ics',FEED_SELECTED.padEnd(FEED_SELECTED.length+120,' '),'2026-10-11T08:00:01.000Z','calendar-selected-zurich-v1'));
  const job=(kind,cardId,ids,state='done')=>{
    const row=queue.enqueue({kind,cardId,inputRevision:`rev-${kind}-${cardId}`,priority:1,payload:{bundle:{snapshots:ids.map(id=>({id})),claims:ids.map(id=>({snapshotId:id}))}}});
    queue.db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state,row.id);
  };
  job('verify-facts','fx-checked',[checked.id]);
  job('facts','fx-feed',[selected.id,raw.id]);
  job('facts','fx-base-4',[],'ready');
  job('integrate','fx-edited',[edited.id]);
  queue.close();
  // The source monitor's last copies: fx-base-3 has nothing else; fx-base-2 is also covered by a snapshot of the same page.
  const sources=[{id:'watch-3',url:'https://fixture.example.org/fx-base-3',recordIds:['fx-base-3']},{id:'watch-2',url:'https://fixture.example.org/fx-base-2',recordIds:['fx-base-2']}];
  fs.writeFileSync(path.join(editorial,'source-watch.json'),JSON.stringify({schema:1,sources}));
  const state={};
  for(const [source,text] of [[sources[0],PAGE('Monitor drei','CHF 5')],[sources[1],PAGE('Monitor zwei','CHF 99')]]){
    const digest=hash(text);fs.mkdirSync(path.join(editorial,'versions',source.id),{recursive:true});
    fs.writeFileSync(path.join(editorial,'versions',source.id,digest.slice(0,12)+'.txt'),text+'\n');
    state[source.id]={hash:digest,lastSuccess:'2026-10-14T05:00:00.000Z',finalUrl:source.url,parser:'v2'};
  }
  fs.writeFileSync(path.join(editorial,'monitor-state.json'),JSON.stringify({schema:1,sources:state,queue:[]}));
  // A fake claude on PATH. It answers from answers.json beside it, keyed by the card id in the prompt, and logs every card it was asked about.
  const bin=path.join(root,'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'claude'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('2.1.295 (Claude Code)');process.exit(0);}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));process.exit(0);}
let input='';process.stdin.on('data',chunk=>{input+=chunk;});
process.stdin.on('end',()=>{
  if(!args.includes('--json-schema')){console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK',modelUsage:{haiku:{}}}));return;}
  fs.appendFileSync(path.join(__dirname,'calls.log'),JSON.stringify({args,id:(/card id (\\S+):/.exec(input)||[])[1],chars:input.length})+'\\n');
  const answers=JSON.parse(fs.readFileSync(path.join(__dirname,'answers.json'),'utf8')),id=(/card id (\\S+):/.exec(input)||[])[1];
  if(answers[id]&&answers[id].__limit){
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"You have hit your usage limit"}}'}));
    process.exit(1);
  }
  const ok={verdict:'ok',source:'',line:'',should_say:'',note:''};
  const answer=answers[id]||Object.fromEntries(['schedule','age','price','address','booking','language','contact'].map(f=>[f,ok]));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:answer,usage:{input_tokens:1000,cache_read_input_tokens:200,cache_creation_input_tokens:0,output_tokens:150},
    modelUsage:{'claude-sonnet-5-5':{}},total_cost_usd:0.01,session_id:'fake'}));
});
`,{mode:0o755});
  setAnswers(root,{limit});
  return root;
}
const row=(verdict='ok',extra={})=>({verdict,source:'',line:'',should_say:'',note:'',...extra});
const allOk=()=>Object.fromEntries(FIELDS.map(field=>[field,row()]));
function setAnswers(root,{limit=null}={}){
  const answers={
    // a real line (the model changed the spacing), a wrong schedule
    'fx-edited':{...allOk(),schedule:row('wrong',{source:'S1',line:'Jeden  Mittwoch von 15:00 bis 16:00 Uhr treffen sich',should_say:'Wednesday 15:00-16:00',note:'time differs'})},
    // a made-up line cannot stay "wrong"
    'fx-checked':{...allOk(),price:row('wrong',{source:'S1',line:'Eintritt kostet immer CHF 3',should_say:'CHF 3'}),address:row('not-in-source')},
    // the later capture says CHF 9, and the model names the wrong source label: still found
    'fx-base-1':{...allOk(),price:row('wrong',{source:'S7',line:'Eintritt CHF 9 pro Besuch.',should_say:'CHF 9 per visit'}),contact:row('wrong',{source:'S1',line:'Kontakt: info@example.org',should_say:'a different address'})},
    'fx-feed':{...allOk(),language:row('unclear')}
  };
  if(limit)answers[limit]={__limit:true};
  fs.writeFileSync(path.join(root,'bin','answers.json'),JSON.stringify(answers));
}
function tree(root){
  const files=new Map();
  const walk=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
    const file=path.join(folder,entry.name);
    if(entry.isDirectory())walk(file);else files.set(path.relative(root,file),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  }};
  walk(root);
  return files;
}
const changedFiles=(before,after)=>[...after].filter(([file,sum])=>before.get(file)!==sum).map(([file])=>file).sort();
function temporary(t,options){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-audit-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return writeFixture(root,options);
}
function withClaude(t,root){
  const saved=process.env.PATH;
  process.env.PATH=path.join(root,'bin')+path.delimiter+saved;
  t.after(()=>{process.env.PATH=saved;});
}
const calls=root=>{const file=path.join(root,'bin','calls.log');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];};
const quiet=()=>{const lines=[];return {lines,log:line=>lines.push(line)};};
const reportOf=(root,model='claude-sonnet-5-5')=>{
  const name=fs.readdirSync(path.join(root,'editorial','audit')).find(file=>file.endsWith(`-${model}.json`));
  return JSON.parse(fs.readFileSync(path.join(root,'editorial','audit',name),'utf8'));
};

test('the sample is the same for the same seed, whatever order the cards come in, and a smaller sample is a prefix',()=>{
  const ids=Array.from({length:60},(_,i)=>`card-${i}`);
  assert.deepEqual(shuffled(ids,'a'),shuffled([...ids].reverse(),'a'));
  assert.notDeepEqual(shuffled(ids,'a'),shuffled(ids,'b'));
  assert.deepEqual([...shuffled(ids,'a')].sort(),[...ids].sort());
  const pools={pipeline:ids.slice(0,10),base:ids.slice(10)};
  const big=drawSample(pools,{size:40,seed:'7',share:0.25}),again=drawSample(pools,{size:40,seed:'7',share:0.25});
  assert.deepEqual(big,again);
  assert.equal(big.pipeline.length,10);assert.equal(big.base.length,30);
  const small=drawSample(pools,{size:20,seed:'7',share:0.25});
  assert.equal(small.pipeline.length,5);assert.equal(small.base.length,15);
  assert.deepEqual(small.base,big.base.slice(0,15));
  // a stratum that cannot give its share hands the rest to the other one, and a pool smaller than the size is drawn whole
  assert.equal(drawSample({pipeline:ids.slice(0,2),base:ids.slice(2,40)},{size:20,seed:'7',share:0.5}).base.length,18);
  assert.equal(drawSample({pipeline:[],base:ids.slice(0,6)},{size:20,seed:'7'}).base.length,6);
});

test('options are checked; the defaults are the agreed ones',()=>{
  const options=parseArgs([]);
  assert.deepEqual([options.size,options.seed,options.model,options.effort,options.parallel,options.originals,options.dryRun],[80,'11','claude-sonnet-5-5','medium',3,'snapshots',false]);
  assert.equal(options.out,path.join(options.root,'editorial','audit'));
  assert.equal(parseArgs(['--root=/somewhere/else']).out,path.join('/somewhere/else','editorial','audit'));
  for(const bad of [['--size=0'],['--size=x'],['--parallel=9'],['--effort=loud'],['--originals=live'],['--model=a b'],['--nonsense'],['--size'],['size=3'],['--dry-run=1']])
    assert.throws(()=>parseArgs(bad),undefined,bad.join(' '));
});

test('the call has no tools, no MCP, no settings and no session, and asks for the schema',()=>{
  const args=claudeArguments({model:'claude-sonnet-5-5',effort:'medium'});
  assert.equal(args[args.indexOf('--tools')+1],'');
  assert.equal(args[args.indexOf('--setting-sources')+1],'');
  for(const flag of ['--strict-mcp-config','--disable-slash-commands','--no-chrome','--no-session-persistence','--json-schema'])assert.ok(args.includes(flag),flag);
  assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
  assert.equal(args.includes('--allowedTools'),false);assert.equal(args.includes('--dangerously-skip-permissions'),false);
  assert.deepEqual(Object.keys(JSON.parse(args[args.indexOf('--json-schema')+1]).properties),FIELDS);
});

test('only a provider-wide failure stops the run',()=>{
  assert.ok(stopsRun('usage limit; API Error: 429'));assert.ok(stopsRun('authentication; exit 1; Please run /login'));
  assert.equal(stopsRun('timeout; the call took longer than 300 s'),false);assert.equal(stopsRun('bad-output; Answer does not fit the schema at price'),false);
});

test('a "wrong" must quote a line of an original; a made-up, too short or uncorrected one becomes "unclear"',()=>{
  const originals=[{text:'Alpha   Beispiel\nEintritt CHF 8 pro Besuch.\nTreffen jeden Mittwoch um 15:00 Uhr'},{text:'Zweite Seite\nTelefon 000 000 00 00'}];
  const fields=judgeAnswer({...allOk(),
    price:row('wrong',{source:'S1',line:'Eintritt  CHF 8 pro\nBesuch.',should_say:'CHF 9'}),             // whitespace differs only
    schedule:row('wrong',{source:'S1',line:'Treffen jeden Donnerstag um 15:00 Uhr',should_say:'Thursday'}), // not in any original
    contact:row('wrong',{source:'S1',line:'Telefon 000 000 00 00',should_say:'another number'}),         // named source wrong, found in S2
    age:row('wrong',{source:'S1',line:'CHF 8',should_say:'x'}),                                           // shorter than a real quote
    address:row('wrong',{source:'S2',line:'Zweite Seite',should_say:'  '}),                               // says nothing about the fix
    language:row('not-in-source')},originals);
  assert.equal(fields.price.verdict,'wrong');assert.equal(fields.price.matchedSource,'S1');
  assert.deepEqual([fields.schedule.verdict,fields.schedule.claimed,fields.schedule.downgraded],['unclear','wrong','quote-not-in-source']);
  assert.deepEqual([fields.contact.verdict,fields.contact.matchedSource],['wrong','S2']);
  assert.equal(fields.age.downgraded,'quote-too-short');assert.equal(fields.address.downgraded,'no-correction');
  assert.equal(fields.language.verdict,'not-in-source');assert.equal(fields.booking.verdict,'ok');
  assert.throws(()=>judgeAnswer({...allOk(),price:{verdict:'maybe',source:'',line:'',should_say:'',note:''}},originals),/schema at price/);
  assert.throws(()=>judgeAnswer({schedule:row()},originals),/schema/);
});

test('a long text is cut to its share, keeping the lines that mention the card, and says so',()=>{
  const subject=card('fx-long',{name:'Quillbrook puppets',town:'Quillbrook',address:'Nirgendwo 1, 8888 Quillbrook',amount:12});
  const filler=Array.from({length:6000},(_,i)=>`Allgemeine Zeile ${i} ohne Bezug zum Angebot`);
  filler[3000]='Quillbrook puppets spielen am 4.11. um 15:00';filler[4500]='Eintritt 12 Franken in Quillbrook';
  const text=filler.join('\n'),cut=trimText(text,5000,relevantTerms(subject));
  assert.ok(text.length>200000);assert.ok(cut.trimmed);assert.ok(cut.shown.length<=5000);
  assert.match(cut.shown,/Quillbrook puppets spielen am 4\.11\. um 15:00/);assert.match(cut.shown,/Eintritt 12 Franken in Quillbrook/);
  assert.match(cut.shown,/\[\.\.\. \d+ lines not shown \.\.\.\]/);assert.ok(cut.omittedLines>5000&&cut.omittedLines<cut.totalLines);
  assert.deepEqual(trimText('short',5000,[]),{shown:'short',trimmed:false,omittedLines:0,totalLines:1});
  // a short text keeps its whole share and the long one gets the rest
  const [small,large]=fitOriginals(subject,[{text:'x'.repeat(100)},{text}],20000);
  assert.equal(small.shown.length,100);assert.ok(large.shown.length<=19900);assert.ok(large.trimmed);
  const prompt=buildPrompt(subject,[{origin:'monitor',url:'https://fixture.example.org/long',finalUrl:'https://fixture.example.org/long',fetchedAt:'2026-10-14T05:00:00.000Z',parser:'monitor-text-v2',text}]);
  assert.ok(prompt.trimmed);assert.match(prompt.prompt,/Long text: only the lines that mention this card are shown/);
  assert.ok(prompt.prompt.indexOf('Quillbrook puppets spielen')>0);
  assert.ok(TEXT_BUDGET===60000&&prompt.promptChars<TEXT_BUDGET+12000);
});

test('a calendar feed is cut by event: the card keeps its own events',()=>{
  const event=(n,place)=>`BEGIN:VEVENT\nURL:https://feed.example.org/e/${n}\nSUMMARY:Treffen in ${place}\nDESCRIPTION:${'Fuelltext '.repeat(30)}\nEND:VEVENT\n`;
  const text='BEGIN:VCALENDAR\nVERSION:2.0\n'+Array.from({length:200},(_,i)=>event(i,i%50===7?'Quillbrook':'Anderswo')).join('')+'END:VCALENDAR\n';
  const subject=card('fx-ics',{name:'Treffen Quillbrook',town:'Quillbrook',sources:[{url:'https://feed.example.org/e/57/2',label:'Event'}]});
  const cut=trimText(text,20000,relevantTerms(subject));
  assert.ok(cut.trimmed&&cut.shown.length<=20000);
  assert.equal((cut.shown.match(/Treffen in Quillbrook/g)||[]).length,4);
  assert.equal(cut.shown.includes('Treffen in Anderswo'),false);
  assert.match(cut.shown,/^BEGIN:VCALENDAR/);
});

test('the catalogue can be read from another checkout',t=>{
  const root=temporary(t);
  const ids=loadCatalog({base:root}).ACTIVITIES.map(a=>a.id);
  assert.equal(ids.length,CARDS.length);assert.ok(ids.includes('fx-edited'));
});

test('stored originals: job-linked and URL-linked snapshots, the latest capture, extracts only through their job, nothing too short, closed cards left out',async t=>{
  const root=temporary(t),context=await loadContext(root,{originals:'snapshots'});
  assert.equal(context.published.length,9);                       // closed and excluded are not published
  const captured=id=>context.originalsFor(context.byId.get(id)).map(o=>`${o.parser}:${normalizeUrl(o.url)}`);
  assert.deepEqual(captured('fx-edited'),['cheerio-visible-body-v1:fixture.example.org/fx-edited']);
  assert.deepEqual(captured('fx-checked'),['cheerio-visible-body-v1:fixture.example.org/elsewhere']);     // reached through its job, not through a source URL
  const base1=context.originalsFor(context.byId.get('fx-base-1'));
  assert.equal(base1.length,1);assert.match(base1[0].text,/CHF 9/);                                      // the later capture of the changed page
  // the feed: the extract its job selected replaces the raw feed for fx-feed; fx-feed-b has only the raw feed, and never the other card's extract
  assert.deepEqual(captured('fx-feed'),['calendar-selected-zurich-v1:feed.example.org/ics']);
  assert.deepEqual(captured('fx-feed-b'),['calendar-raw-v1:feed.example.org/ics']);
  assert.deepEqual([captured('fx-base-3'),captured('fx-base-4'),captured('fx-base-5')],[[],[],[]]);        // monitor copy only, nothing, a text too short
  const {coverage}=context;
  assert.deepEqual([coverage.published,coverage.withCapturedSnapshots,coverage.withMonitorCopy,coverage.withEither],[9,6,2,7]);
  assert.deepEqual([coverage.pipelineEdited,coverage.pipelineChecked,coverage.snapshotsRegistered],[1,3,9]);
  assert.deepEqual([...context.published.filter(a=>context.stratum(a)==='pipeline').map(a=>a.id)].sort(),['fx-checked','fx-edited','fx-feed']);
  // both: the monitor's copy is added where no snapshot covers the page, and it is the only original of fx-base-3
  const both=await loadContext(root,{originals:'both'});
  assert.deepEqual(both.originalsFor(both.byId.get('fx-base-3')).map(o=>o.origin),['monitor']);
  assert.deepEqual(both.originalsFor(both.byId.get('fx-base-2')).map(o=>o.origin),['captured']);          // the monitor's copy of a page a snapshot covers is left out
  assert.equal(both.published.filter(a=>both.usable(a)).length,7);assert.equal(context.published.filter(a=>context.usable(a)).length,6);
  assert.deepEqual(cardView(both.byId.get('fx-edited')).price,{price:'CHF 8 per visit',priceKind:'visit',amount:8});
});

test('a dry run samples, gathers and sizes the prompts, calls nothing and writes only into --out',async t=>{
  const root=temporary(t),out=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-audit-out-'));
  t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
  const before=tree(root),sink=quiet();
  const {code,report}=await main([`--root=${root}`,`--out=${out}`,'--dry-run','--size=80'],{log:sink.log,now:new Date('2026-10-15T10:00:00Z'),
    readyImpl:()=>assert.fail('a dry run never asks Claude'),runImpl:()=>assert.fail('a dry run never starts a process')});
  assert.equal(code,0);assert.deepEqual(tree(root),before);
  assert.deepEqual(fs.readdirSync(out).sort(),['2026-10-15-claude-sonnet-5-5-dry-run.json','2026-10-15-claude-sonnet-5-5-dry-run.md']);
  assert.equal(report.sample.drawn,6);assert.deepEqual(report.sample.strata,{pipeline:{pool:3,drawn:3},base:{pool:3,drawn:3}});
  assert.equal(report.noStoredOriginal.length,3);assert.deepEqual(report.noStoredOriginal,['fx-base-3','fx-base-4','fx-base-5']);
  assert.equal(report.prompts.count,6);assert.ok(report.prompts.chars.min>1500&&report.prompts.chars.max>=report.prompts.chars.min);
  assert.match(sink.lines.join('\n'),/captured snapshots for 6 cards/);assert.match(sink.lines.join('\n'),/No stored original: 3/);
  assert.equal(JSON.stringify(report).includes('Eintritt'),false);                                          // sizes and addresses, not the texts
});

test('the whole run through a fake claude: counts per field, code-checked quotes, nothing written outside editorial/audit',async t=>{
  const root=temporary(t);withClaude(t,root);
  const before=tree(root),sink=quiet();
  const {code,report}=await main([`--root=${root}`,'--parallel=2'],{log:sink.log,now:new Date('2026-10-15T10:00:00Z')});
  assert.equal(code,0);
  const after=tree(root);
  assert.deepEqual(changedFiles(before,after).filter(file=>!file.startsWith('editorial/audit/')&&!file.startsWith('bin/')),[]);
  assert.deepEqual([...before.keys()].filter(file=>!after.has(file)),[]);
  assert.ok(changedFiles(before,after).filter(file=>file.startsWith('editorial/audit/')).length>=8);       // report, summary, six cards
  assert.equal(before.get('editorial/workflow-state/jobs.sqlite'),after.get('editorial/workflow-state/jobs.sqlite'));
  assert.equal(before.get('data.js'),after.get('data.js'));
  assert.deepEqual(calls(root).map(c=>c.id).sort(),['fx-base-1','fx-base-2','fx-checked','fx-edited','fx-feed','fx-feed-b']);
  for(const call of calls(root)){assert.equal(call.args[call.args.indexOf('--tools')+1],'');assert.ok(call.args.includes('--no-session-persistence'));}
  const {summary}=report;
  assert.deepEqual([summary.cardsChecked,summary.cardsWithWrongField,summary.wrongFields,summary.downgradedToUnclear],[6,2,3,1]);
  assert.deepEqual(summary.faultsPerField,{schedule:1,age:0,price:1,address:0,booking:0,language:0,contact:1});
  assert.deepEqual(summary.perField.price,{ok:4,wrong:1,'not-in-source':0,unclear:1,downgraded:1});
  assert.deepEqual(summary.perField.address,{ok:5,wrong:0,'not-in-source':1,unclear:0,downgraded:0});
  assert.deepEqual(summary.perField.language,{ok:5,wrong:0,'not-in-source':0,unclear:1,downgraded:0});
  assert.deepEqual(summary.byStratum,{pipeline:{cards:3,withWrongField:1},base:{cards:3,withWrongField:1}});
  assert.deepEqual(summary.byOrigin,{captured:{cards:6,withWrongField:2}});
  assert.deepEqual(summary.tokens,{input:7200,cached:1200,output:900});
  assert.deepEqual(report.faulty.map(f=>[f.id,f.fields.map(x=>x.field)]),[['fx-base-1',['price','contact']],['fx-edited',['schedule']]]);
  const edited=report.faulty.find(f=>f.id==='fx-edited').fields[0];
  assert.deepEqual([edited.cardValue.schedule,edited.sourceUrl,edited.shouldSay],['Wednesday 15:00-16:00','https://fixture.example.org/fx-edited','Wednesday 15:00-16:00']);
  assert.equal(report.faulty.find(f=>f.id==='fx-base-1').fields[0].sourceLine,'Eintritt CHF 9 pro Besuch.');
  assert.equal(report.complete,true);assert.deepEqual(report.noStoredOriginal,['fx-base-3','fx-base-4','fx-base-5']);
  // the saved report is the returned one, and the summary names the faults
  const saved=reportOf(root);assert.deepEqual(saved.summary,summary);assert.equal(saved.cards.length,6);
  const md=fs.readFileSync(path.join(root,'editorial','audit','2026-10-15-claude-sonnet-5-5.md'),'utf8');
  assert.match(md,/with at least one wrong field: 2 \(33\.3 %\)/);assert.match(md,/\*\*fx-edited\*\*/);assert.match(md,/Eintritt CHF 9 pro Besuch\./);
  assert.ok(md.split('\n').length<60);
  // the made-up quote of fx-checked is in the record as a claim and not as a fault
  const checked=saved.cards.find(c=>c.id==='fx-checked').fields.price;
  assert.deepEqual([checked.verdict,checked.claimed,checked.downgraded],['unclear','wrong','quote-not-in-source']);
});

test('with --originals=both a card that has only the monitor\'s copy is read, and its origin is recorded',async t=>{
  const root=temporary(t);withClaude(t,root);
  const {code,report}=await main([`--root=${root}`,'--originals=both','--ids=fx-base-3,fx-base-4','--parallel=1'],{log:()=>{},now:new Date('2026-10-15T10:00:00Z')});
  assert.equal(code,0);
  assert.deepEqual(calls(root).map(c=>c.id),['fx-base-3']);                                                  // fx-base-4 has no original at all
  assert.deepEqual(report.sample.skippedWithoutOriginal,['fx-base-4']);
  assert.equal(report.cards[0].origin,'monitor');assert.equal(report.cards[0].originals[0].origin,'monitor');
  assert.equal((await main([`--root=${root}`,'--ids=fx-nowhere'],{log:()=>{}})).code,2);
  assert.equal((await main([`--root=${root}`,'--ids=fx-closed'],{log:()=>{}})).code,2);                     // closed cards are not published
});

test('a usage limit stops the run cleanly, keeps the finished cards, and the next start asks only for the rest',t=>{
  const root=temporary(t,{limit:'fx-checked'});
  const run=()=>spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',script,`--root=${root}`,'--parallel=1'],
    {encoding:'utf8',env:{...process.env,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH}});
  const before=tree(root);
  const first=run();
  assert.equal(first.status,3,first.stdout+first.stderr);assert.match(first.stdout,/STOPPED: usage limit/);
  assert.deepEqual(calls(root).map(c=>c.id),['fx-base-1','fx-base-2','fx-checked']);                          // fx-edited, fx-feed and fx-feed-b were never asked
  const partial=reportOf(root);
  assert.equal(partial.complete,false);assert.match(partial.halted,/^usage limit/);assert.equal(partial.summary.cardsChecked,2);
  assert.deepEqual(partial.notStarted,['fx-edited','fx-feed','fx-feed-b']);assert.deepEqual(partial.failed.map(f=>f.id),['fx-checked']);
  assert.deepEqual(changedFiles(before,tree(root)).filter(file=>!file.startsWith('editorial/audit/')&&!file.startsWith('bin/')),[]);
  setAnswers(root);                                                                                          // the limit is over
  const second=run();
  assert.equal(second.status,0,second.stdout+second.stderr);
  assert.deepEqual(calls(root).map(c=>c.id).slice(3).sort(),['fx-checked','fx-edited','fx-feed','fx-feed-b']);   // the two finished cards are not asked again
  assert.match(second.stdout,/2 already read, 4 to ask/);
  const done=reportOf(root);
  assert.equal(done.complete,true);assert.equal(done.summary.cardsChecked,6);assert.deepEqual([done.run.reused,done.run.asked],[2,4]);
  assert.equal(done.summary.cardsWithWrongField,2);
  // --redo asks for every card again
  const third=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',script,`--root=${root}`,'--parallel=3','--redo'],
    {encoding:'utf8',env:{...process.env,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH}});
  assert.equal(third.status,0,third.stdout+third.stderr);assert.equal(calls(root).length,13);
});

test('an answer that does not fit the schema fails that card only; the others are kept and the exit code says so',async t=>{
  const root=temporary(t);withClaude(t,root);
  const file=path.join(root,'bin','answers.json'),answers=JSON.parse(fs.readFileSync(file,'utf8'));
  answers['fx-base-2']={...allOk(),price:{verdict:'wrong'}};
  fs.writeFileSync(file,JSON.stringify(answers));
  const {code,report}=await main([`--root=${root}`,'--parallel=1'],{log:()=>{},now:new Date('2026-10-15T10:00:00Z')});
  assert.equal(code,4);assert.equal(report.summary.cardsChecked,5);assert.equal(report.complete,false);
  assert.deepEqual(report.failed.map(f=>f.id),['fx-base-2']);assert.match(report.failed[0].error,/^bad-output/);
});
