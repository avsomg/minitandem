import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ledgerFixture,writeJson} from './fact-ledger-fixture.mjs';
import {buildLedger,writeLedger} from './fact-ledger.mjs';
import {loadCatalog} from './quality.mjs';
import {hash} from './evidence.mjs';
import {FIELDS,PROMPT_VERSION,readFactLedger,factOriginsFor,loadContext,buildPrompt,cardView,judgeAnswer,summarize,faultList,main} from './audit-sample.mjs';

const noModel={readyImpl:()=>assert.fail('no real model is allowed'),runImpl:()=>assert.fail('no worker process is allowed'),log:()=>{},now:new Date('2026-10-16T10:00:00Z')};
const originsDirectory=f=>path.join(f.editorial,'fact-ledger');
const currentRecords=f=>loadCatalog({base:f.root}).ACTIVITIES;
const allOk=()=>Object.fromEntries(FIELDS.map(field=>[field,{verdict:'ok',source:'',line:'',should_say:'',note:''}]));

test('the audit distinguishes fact provenance from captured or monitor originals and keeps mixed groups separate',async t=>{
  const f=ledgerFixture(t);writeLedger(await buildLedger({root:f.root}),originsDirectory(f));
  const context=await loadContext(f.root),card=context.byId.get('fixture'),origins=factOriginsFor(card,context.factLedger);
  assert.equal(context.factLedger.status,'current');assert.equal(origins.booking.origin,'verified');
  assert.equal(origins.address.origin,'inherited');assert.equal(origins.age.origin,'unknown');assert.equal(origins.price.origin,'mixed');
  assert.deepEqual(origins.price.fields,{price:'inherited',priceKind:'inherited',amount:'verified'});
  const fields=allOk();for(const field of ['booking','address','price'])fields[field]={verdict:'wrong',matchedSource:'S1',line:'An invented fault.',shouldSay:'Correct fixture value',note:''};
  const result={id:'fixture',name:card.name,stratum:'pipeline',origin:'captured',factOrigins:origins,fields,cardValue:cardView(card),
    originals:[{url:f.evidence.url}],tokens:{input:0,cached:0,output:0},seconds:0};
  const summary=summarize([result]);assert.equal(summary.byFactOrigin.verified.wrong,1);assert.equal(summary.byFactOrigin.inherited.wrong,1);
  assert.equal(summary.byFactOrigin.mixed.wrong,1);assert.equal(summary.byFactOrigin.unknown.wrong,0);
  assert.equal(Object.values(summary.byFactOrigin).reduce((n,row)=>n+row.wrong,0),summary.wrongFields);
  assert.equal(Object.values(summary.byFactOrigin).reduce((n,row)=>n+row.fields,0),FIELDS.length);
  const faults=faultList([result])[0].fields;
  assert.deepEqual(faults.find(row=>row.field==='price').fieldOrigins,origins.price.fields);
  assert.equal(faults.find(row=>row.field==='booking').factOrigin,'verified');assert.equal(result.origin,'captured');
});

test('absent, stale and invalid ledgers are explicit and never guessed from pipeline history',async t=>{
  const f=ledgerFixture(t),records=currentRecords(f),file=path.join(originsDirectory(f),'ledger.json');
  assert.equal(readFactLedger(f.root,records,f.journal).status,'absent');
  const ledger=await buildLedger({root:f.root});writeLedger(ledger,originsDirectory(f));
  assert.equal(readFactLedger(f.root,[{...records[0],amount:8}],f.journal).status,'stale');
  assert.equal(readFactLedger(f.root,records,{...f.journal,extra:'new journal revision'}).status,'stale');
  const invalid=structuredClone(ledger);invalid.cards[0].fields.find(row=>row.field==='amount').value=8;writeJson(file,invalid);
  const bad=readFactLedger(f.root,records,f.journal);assert.equal(bad.status,'invalid');assert.match(bad.note,/round-trip mismatch/);
  assert.equal(factOriginsFor(records[0],bad).booking.origin,'unavailable');
  fs.writeFileSync(file,'not JSON');assert.equal(readFactLedger(f.root,records,f.journal).status,'invalid');
});

test('audit dry run reports missing and current provenance without asking a model',async t=>{
  const f=ledgerFixture(t),args=['--root='+f.root,'--ids=fixture','--dry-run'];
  const missing=await main(args,noModel);assert.equal(missing.code,0);assert.equal(missing.report.factLedger.status,'absent');
  assert.equal(missing.report.cards[0].factOrigins.booking.origin,'unavailable');
  const file=path.join(f.editorial,'audit/2026-10-16-claude-sonnet-5-5-dry-run.md');
  assert.match(fs.readFileSync(file,'utf8'),/No fact ledger found/);
  writeLedger(await buildLedger({root:f.root}),originsDirectory(f));
  const current=await main(args,noModel);assert.equal(current.code,0);assert.equal(current.report.factLedger.status,'current');
  assert.equal(current.report.cards[0].factOrigins.booking.origin,'verified');
  assert.match(fs.readFileSync(file,'utf8'),/Current fact ledger/);
});

test('cached audit answers pick up fresh origins without another model call and persist the split report',async t=>{
  const f=ledgerFixture(t),context=await loadContext(f.root),card=context.byId.get('fixture'),originals=context.originalsFor(card),built=buildPrompt(card,originals);
  const answer=allOk();answer.booking={verdict:'wrong',source:'S1',line:'No registration required.',should_say:'Fixture correction',note:'Fixture fault'};
  const fields=judgeAnswer(answer,built.originals),savedFile=path.join(f.editorial,'audit/cards/claude-sonnet-5-5/fixture.json');
  const saved={schema:1,id:card.id,name:card.name,stratum:'pipeline',origin:'captured',model:'claude-sonnet-5-5',effort:'medium',promptVersion:PROMPT_VERSION,
    inputDigest:hash(JSON.stringify([PROMPT_VERSION,'claude-sonnet-5-5','medium',built.prompt])),askedAt:'2026-10-15T10:00:00Z',
    originals:originals.map(original=>({url:original.url,origin:original.origin})),cardValue:cardView(card),fields,tokens:{input:100,cached:0,output:20},seconds:1};
  writeJson(savedFile,saved);
  const args=['--root='+f.root,'--ids=fixture'];
  const missing=await main(args,noModel);assert.equal(missing.code,0);assert.equal(missing.report.summary.byFactOrigin.unavailable.wrong,1);
  writeLedger(await buildLedger({root:f.root}),originsDirectory(f));
  const current=await main(args,noModel);assert.equal(current.code,0);assert.equal(current.report.run.asked,0);assert.equal(current.report.run.reused,1);
  assert.equal(current.report.summary.byFactOrigin.verified.wrong,1);assert.equal(current.report.summary.byFactOrigin.unavailable.wrong,0);
  assert.equal(current.report.faulty[0].fields[0].factOrigin,'verified');
  assert.equal(JSON.parse(fs.readFileSync(savedFile,'utf8')).factOrigins.booking.origin,'verified');
  const text=fs.readFileSync(path.join(f.editorial,'audit/2026-10-16-claude-sonnet-5-5.md'),'utf8');
  assert.match(text,/\| verified \| 1 \| 1 \|/);assert.match(text,/booking \[verified\]/);
  assert.match(text,/mixed groups contain both verified and inherited/);
});
