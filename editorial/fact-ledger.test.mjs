import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildLedger,catalogueValues,summaryMarkdown,validateLedger,parseArgs,main} from './fact-ledger.mjs';
import {ledgerFixture,resealFixture,writeJson,fixtureCard} from './fact-ledger-fixture.mjs';
import {loadCatalog} from './quality.mjs';
import {CLAIM_FIELDS} from './field-contract.mjs';
import {snapshot,hash} from './evidence.mjs';
import {JobQueue,digest} from './jobs.mjs';
import {writeRecord} from './page-record.mjs';
import {applyDraftRecord} from './workflow.mjs';

const row=(ledger,field,id='fixture')=>ledger.cards.find(card=>card.id===id).fields.find(row=>row.field===field);
const queueFile=f=>path.join(f.editorial,'workflow-state/jobs.sqlite');
function mutateQueue(f,change){const db=new DatabaseSync(queueFile(f));try{change(db);}finally{db.close();}}
function fingerprint(folder){
  return Object.fromEntries(fs.readdirSync(folder,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>{
    const file=path.join(entry.parentPath,entry.name);return [path.relative(folder,file),hash(fs.readFileSync(file))];
  }).sort(([a],[b])=>a.localeCompare(b)));
}

test('the private ledger keeps compiled values and promotes only exactly supported approved claims',async t=>{
  const f=ledgerFixture(t),ledger=await buildLedger({root:f.root});
  const rows=new Map(ledger.cards[0].fields.map(row=>[row.field,row]));
  assert.equal(rows.size,CLAIM_FIELDS.size);
  assert.equal(rows.get('amount').origin,'verified');assert.equal(rows.get('amount').value,0);
  assert.equal(rows.get('practical.booking').origin,'verified');assert.equal(rows.get('practical.booking').value,false);
  assert.equal(rows.get('status').origin,'inherited');assert.equal(rows.get('age').origin,'unknown');assert.equal(rows.get('min').origin,'unknown');
  assert.equal(rows.get('practical.trial').present,false);assert.equal(rows.get('practical.trial').value,null);
  assert.equal(rows.get('amount').claimId,f.claims[0].key);assert.equal(rows.get('amount').jobId,f.verifier.id);
  assert.equal(rows.get('amount').snapshotId,f.evidence.id);assert.equal(rows.get('amount').pageRecordVersion,null);
  assert.deepEqual(ledger.cards[0].fields.map(({field,value,present})=>({field,value,present})),catalogueValues(loadCatalog({base:f.root}).ACTIVITIES[0]));
  assert.equal(ledger.counts.total.verified,2);assert.equal(ledger.counts.total.inherited,ledger.counts.filled-2);
  assert.ok(!summaryMarkdown(ledger).includes('No registration required.'));assert.ok(!JSON.stringify(ledger).includes('No registration required.'));
});

test('dry run validates evidence without writing and ordinary output is private',async t=>{
  const f=ledgerFixture(t),out=path.join(f.root,'editorial/fact-ledger'),logs=[];
  assert.equal((await main(['--root='+f.root,'--dry-run'],{log:line=>logs.push(line)})).code,0);
  assert.equal(fs.existsSync(out),false);
  assert.equal((await main(['--root='+f.root],{log:line=>logs.push(line)})).code,0);
  assert.equal(fs.statSync(out).mode&0o777,0o700);
  for(const name of ['ledger.json','summary.md'])assert.equal(fs.statSync(path.join(out,name)).mode&0o777,0o600);
});

test('all cards round-trip and inherited equals filled values minus verified values',async t=>{
  const f=ledgerFixture(t),extra=fixtureCard('old-card');extra.practical.booking.value=false;
  f.setCards([f.base,extra]);const before=fingerprint(f.root),ledger=await buildLedger({root:f.root});
  const records=loadCatalog({base:f.root}).ACTIVITIES;
  assert.equal(records[0].practical.booking.value,false,'the fixture must compile the approved patch over the earlier true value');
  for(const card of records)assert.deepEqual(ledger.cards.find(row=>row.id===card.id).fields.map(({field,value,present})=>({field,value,present})),catalogueValues(card));
  assert.equal(ledger.counts.journalCovered,2);assert.equal(ledger.counts.total.inherited,ledger.counts.filled-ledger.counts.total.verified);
  assert.equal(row(ledger,'practical.booking','old-card').origin,'inherited','matching a verified value on another card is not provenance');
  assert.deepEqual(fingerprint(f.root),before,'immutable reads must not change inputs or create SQLite sidecars');
});

for(const type of ['approval artifact','verdict artifact','snapshot'])test('a missing '+type+' fails loudly instead of downgrading to inherited',async t=>{
  const f=ledgerFixture(t);
  if(type==='snapshot')mutateQueue(f,db=>db.prepare('DELETE FROM captured_evidence WHERE id=?').run(f.evidence.id));
  else fs.rmSync(path.join(f.editorial,'agent-artifacts',(type==='approval artifact'?f.approvalArtifact:f.verdictArtifact)+'.json'));
  await assert.rejects(buildLedger({root:f.root}),type==='snapshot'?/Missing registered snapshot/:/Missing artifact/);
  const logs=[];assert.equal((await main(['--root='+f.root],{log:line=>logs.push(line)})).code,1);
  assert.match(logs[0],/Fact ledger failed: Missing/);assert.equal(fs.existsSync(path.join(f.editorial,'fact-ledger')),false);
});

test('tampering with a verdict or a located quote cannot create a verified row',async t=>{
  const f=ledgerFixture(t),file=path.join(f.editorial,'agent-artifacts',f.verdictArtifact+'.json'),artifact=JSON.parse(fs.readFileSync(file,'utf8'));
  artifact.result.verdicts[0].reason+=' Changed';writeJson(file,artifact);
  await assert.rejects(buildLedger({root:f.root}),/Invalid artifact/);
  resealFixture(f);f.claims[0].quote='This line does not occur in the invented source.';f.draft.bindings[0].quote=f.claims[0].quote;resealFixture(f);
  await assert.rejects(buildLedger({root:f.root}),/quote or snapshot provenance differs/);
});

test('a value changed since approval stays inherited and appears as drift, including a later unknown',async t=>{
  const f=ledgerFixture(t),changed={...f.base,amount:12};f.setCards([changed]);
  const ledger=await buildLedger({root:f.root});assert.equal(row(ledger,'amount').value,12);assert.equal(row(ledger,'amount').origin,'inherited');
  assert.equal(row(ledger,'amount').drift,true);assert.deepEqual(ledger.drift.find(row=>row.field==='amount'),{
    cardId:'fixture',field:'amount',approvalJobId:f.reviewer.id,approvedOn:'2026-10-15',approvedValue:0,currentValue:12});
  assert.match(summaryMarkdown(ledger),/fixture: amount \(approval/);
  f.setCards([{...changed,amount:null}]);const unknown=await buildLedger({root:f.root});
  assert.equal(row(unknown,'amount').origin,'unknown');assert.equal(row(unknown,'amount').drift,true);
});

test('a journal binding without an exact claim, a rejected claim or another field never verifies a value',async t=>{
  const f=ledgerFixture(t);delete f.draft.bindings[0].claimKey;resealFixture(f);
  assert.equal(row(await buildLedger({root:f.root}),'amount').origin,'inherited');
  f.draft.bindings[0].claimKey=f.claims[0].key;f.verdicts[0].verdict='reject';resealFixture(f);
  await assert.rejects(buildLedger({root:f.root}),/lacks an approving verdict/);
  f.verdicts[0].verdict='approve';f.claims[0].field='min';resealFixture(f);
  assert.equal(row(await buildLedger({root:f.root}),'amount').origin,'inherited');
});

test('later unproven approval and superseded history never borrow an older verified label',async t=>{
  const f=ledgerFixture(t),originalBase=f.base;
  f.base=applyDraftRecord(f.base,f.draft,'2026-10-15');f.draft=structuredClone(f.draft);delete f.draft.bindings[0].claimKey;
  f.payload={...f.payload,draft:f.draft};
  const queue=new JobQueue(queueFile(f),{now:()=> '2026-10-15T10:00:00.000Z'});
  try{f.reviewer=queue.enqueue({kind:'review-patch',cardId:'fixture',inputRevision:'fixture-later-review',payload:f.payload});
    queue.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(f.reviewer.id);}finally{queue.close();}
  f.update={...f.update,jobId:f.reviewer.id,baseRecord:f.base,draft:f.draft};f.journal.updates.push(f.update);resealFixture(f);f.setCards([originalBase]);
  assert.equal(row(await buildLedger({root:f.root}),'amount').origin,'inherited');
  f.journal.updates.forEach(update=>{update.supersededBy='later-history';});f.save();
  const ledger=await buildLedger({root:f.root});assert.equal(ledger.counts.total.verified,0);
});

test('events retain every supporting claim and refuse a session not covered by any of them',async t=>{
  const f=ledgerFixture(t),events=[{date:'2026-11-02',start:'09:00',end:'10:00'},{date:'2026-11-09',start:'09:00',end:'10:00'}];
  const evidence=snapshot({...f.evidence,text:'Fixture dates: 2026-11-02 09:00-10:00 and 2026-11-09 09:00-10:00.'});
  f.bundle.snapshots=[evidence];f.draft.snapshots=[evidence];
  f.claims.splice(0,f.claims.length,...events.map((event,index)=>({...f.claims[0],key:'events-'+index,field:'events',value:[event],snapshotId:evidence.id,quote:evidence.text})));
  f.verdicts.splice(0,f.verdicts.length,...f.claims.map(claim=>({key:claim.key,verdict:'approve',reason:'The fixture lists this session.'})));
  f.draft.patch={events,scheduleValidThrough:'2026-11-09'};f.draft.practicalPatch={};
  f.draft.bindings=f.claims.map(claim=>({field:'events',claimKey:claim.key,source:claim.source,quote:claim.quote,snapshotId:claim.snapshotId,kind:claim.kind,scope:claim.scope}));resealFixture(f);
  const ledger=await buildLedger({root:f.root});assert.equal(row(ledger,'events').origin,'verified');assert.equal(row(ledger,'events').evidence.length,2);
  f.draft.patch.events=[...events,{date:'2026-11-08',start:'09:00',end:'10:00'}];resealFixture(f);
  assert.equal(row(await buildLedger({root:f.root}),'events').origin,'inherited');
});

test('full-review bindings can verify a retained field only against its exact approved value',async t=>{
  const f=ledgerFixture(t);delete f.draft.patch.amount;f.draft.reviewCoverage={mode:'full',fields:[{field:'amount',value:0,outcome:'confirmed',snapshotIds:[f.evidence.id]}]};
  f.draft.bindings[0].field='review.amount';resealFixture(f);
  assert.equal(row(await buildLedger({root:f.root}),'amount').origin,'verified');
  f.draft.reviewCoverage.fields[0].value=8;resealFixture(f);
  assert.equal(row(await buildLedger({root:f.root}),'amount').origin,'inherited');
});

test('page-record version is linked by recorded bytes or text, never by quote survival alone',async t=>{
  const f=ledgerFixture(t),version=f.evidence.textHash.slice(0,12);
  writeJson(path.join(f.editorial,'source-watch.json'),{sources:[{id:'fixture-source',url:'https://www.fixture.example.org/meeting/',recordIds:['fixture']}]});
  await writeRecord(f.editorial,'fixture-source',{version,hash:f.evidence.textHash,fetchedAt:f.evidence.fetchedAt,finalUrl:f.evidence.finalUrl,
    contentType:'text/plain',status:200,parser:'v2',rawHash:null,rawBytes:0,raw:null,full:{parser:f.evidence.parser,text:f.evidence.text},alarm:[]});
  const ledger=await buildLedger({root:f.root});assert.equal(row(ledger,'amount').pageRecordVersion,version);
  assert.equal(row(ledger,'amount').pageRecord.match,'same-content');
  fs.writeFileSync(path.join(f.editorial,'page-records/fixture-source',version+'.full.txt.gz'),'damaged');
  await assert.rejects(buildLedger({root:f.root}),/Damaged matching page record/);
  fs.rmSync(path.join(f.editorial,'page-records/fixture-source'),{recursive:true});
  const text='A different page body with the old quotes still present. '+f.evidence.text,changed=hash(text);
  await writeRecord(f.editorial,'fixture-source',{version:changed.slice(0,12),hash:changed,fetchedAt:f.evidence.fetchedAt,finalUrl:f.evidence.finalUrl,
    contentType:'text/plain',status:200,parser:'v2',rawHash:null,rawBytes:0,raw:null,full:{parser:f.evidence.parser,text},alarm:[]});
  assert.equal(row(await buildLedger({root:f.root}),'amount').pageRecordVersion,null);
});

test('unknown placeholders stay unknown and a checkout without journal evidence remains inherited',async t=>{
  const f=ledgerFixture(t);f.journal.updates=[];f.save();fs.rmSync(path.dirname(queueFile(f)),{recursive:true});
  const base={...f.base,age:'Age limits are not published.',schedule:'Opening hours are not published',amount:0};f.setCards([base]);
  const ledger=await buildLedger({root:f.root});assert.equal(row(ledger,'age').origin,'unknown');assert.equal(row(ledger,'schedule').origin,'unknown');
  assert.equal(row(ledger,'amount').origin,'inherited');assert.equal(ledger.counts.total.verified,0);
});

test('a live WAL or a foreign queue is refused without changing it',async t=>{
  const f=ledgerFixture(t);fs.writeFileSync(queueFile(f)+'-wal','not a checkpointed queue');
  await assert.rejects(buildLedger({root:f.root}),/Queue has a WAL/);fs.rmSync(queueFile(f)+'-wal');
  mutateQueue(f,db=>db.prepare("UPDATE metadata SET value='foreign-project' WHERE key='project'").run());
  await assert.rejects(buildLedger({root:f.root}),/Wrong queue identity/);
});

test('validation rejects changed ledger values, counts and stale catalogue revisions',async t=>{
  const f=ledgerFixture(t),ledger=await buildLedger({root:f.root}),records=loadCatalog({base:f.root}).ACTIVITIES;
  const changed=structuredClone(ledger);row(changed,'amount').value=7;assert.throws(()=>validateLedger(changed,records),/round-trip mismatch/);
  const counts=structuredClone(ledger);counts.counts.total.inherited++;assert.throws(()=>validateLedger(counts,records),/counts differ/);
  assert.throws(()=>validateLedger(ledger,[{...records[0],amount:9}]),/Stale fact ledger/);
});

test('output cannot enter public files, follow a public symlink or relax a shared directory',async t=>{
  const f=ledgerFixture(t),publish=path.join(f.root,'.publish');fs.mkdirSync(publish);fs.writeFileSync(path.join(publish,'index.html'),'unchanged public build');
  assert.throws(()=>parseArgs(['--root='+f.root,'--out='+publish]),/must be under/);
  fs.symlinkSync(publish,path.join(f.editorial,'fact-ledger'));assert.throws(()=>parseArgs(['--root='+f.root]),/must be under/);fs.unlinkSync(path.join(f.editorial,'fact-ledger'));
  const before=fingerprint(publish),logs=[];await main(['--root='+f.root],{log:line=>logs.push(line)});assert.deepEqual(fingerprint(publish),before);
  const shared=path.join(f.root,'editorial/fact-ledger/shared');fs.mkdirSync(shared,{mode:0o755});
  assert.equal((await main(['--root='+f.root,'--out='+shared],{log:()=>{}})).code,1);assert.equal(fs.statSync(shared).mode&0o777,0o755);
});
