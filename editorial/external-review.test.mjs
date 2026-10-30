import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {externalReviewReport,assertPublicationReviewed,readExternalReviewInputs,newCardsUnreviewed} from './external-review.mjs';
import {loadCatalog,root} from './quality.mjs';

const record={id:'new-place',name:'New place',town:'Fribourg',region:'sarine',category:'play',
  status:'active',events:[],sources:[{url:'https://example.org/new-place'}]};
const channel={result:'no-usable-evidence',queries:['New place Fribourg reviews'],urls:[],note:'No relevant local result.'};
const receipt={id:'new-place',checkedOn:'2026-09-29',reviewAfter:'2026-10-29',
  identityUrl:'https://example.org/new-place',evidenceOutcome:'no-usable-external-evidence',
  conclusion:'No independent confirmation; keep practical claims unknown.',
  conflicts:[],channels:Object.fromEntries(['reviews','ratings','photos','community'].map(name=>[name,{...channel}]))};

// Private-only tests need the owner's external review receipts, which are not in the public repository (see docs/publication-scope.md).
// On a clean clone they are skipped with this message; in the owner's workspace they run.
const SKIP_RECEIPTS=fs.existsSync(path.join(root,'editorial','external-review-receipts.json'))?false:
  'private-only: editorial/external-review-receipts.json is not present (clean clone)';

test('without receipts every published card is queued and the tracked baseline already covers every current card',()=>{
  // This is what lets a public build run without the private receipts: no current card counts as new.
  const baseline=JSON.parse(fs.readFileSync(path.join(root,'editorial','external-review-baseline.json'),'utf8'));
  const records=loadCatalog().ACTIVITIES;
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
  const report=externalReviewReport(records,[],[],baseline,today);
  const published=records.filter(item=>!['closed','excluded'].includes(item.status)).length;
  assert.equal(report.records,published);
  assert.equal(report.summary.pending,published);
  assert.equal(report.queue.length,published);
  assert.deepEqual(Array.from(report.newIds),[]);
  assert.doesNotThrow(()=>assertPublicationReviewed(report));
});

test('every published card enters the external evidence queue without fabricated completion',{skip:SKIP_RECEIPTS},()=>{
  const {receipts,legacyRecords,baseline}=readExternalReviewInputs();
  const records=loadCatalog().ACTIVITIES;
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
  const report=externalReviewReport(records,receipts,legacyRecords,baseline,today);
  assert.equal(report.records,records.filter(item=>!['closed','excluded'].includes(item.status)).length);
  assert.equal(Object.values(report.summary).slice(0,5).reduce((sum,value)=>sum+value,0),report.records);
  assert.ok(report.summary.complete>=1);
  assert.equal(Object.values(report.summary.evidence).reduce((sum,value)=>sum+value,0),report.summary.complete);
  assert.equal(report.rows.find(row=>row.id==='cafe-marly').evidenceOutcome,'no-usable-external-evidence');
  assert.ok(report.summary['legacy-partial']<=16);
  assert.equal(report.queue.length,report.summary.backlog);
  assert.deepEqual(Array.from(report.newIds),[]);
  assert.ok(report.rows.every(row=>row.suggestedQueries.length===4&&row.decision==='research-only'));
});

test('new cards cannot publish without all four documented channel checks',()=>{
  const pending=externalReviewReport([record],[],[],{grandfatheredIds:[]},'2026-09-29');
  assert.deepEqual(pending.newIds,['new-place']);
  assert.throws(()=>assertPublicationReviewed(pending),/new-place/);
  const complete=externalReviewReport([record],[receipt],[],{grandfatheredIds:[]},'2026-09-29');
  assert.equal(complete.summary.complete,1);
  assert.doesNotThrow(()=>assertPublicationReviewed(complete));
  const missing={...receipt,channels:{...receipt.channels,photos:undefined}};
  assert.throws(()=>externalReviewReport([record],[missing],[],{grandfatheredIds:[]},'2026-09-29'),/Incomplete photos/);
});

test('blocked and stale checks return to the queue; URLs and place identity are validated',()=>{
  const blocked={...receipt,channels:{...receipt.channels,reviews:{...channel,result:'blocked'}}};
  assert.equal(externalReviewReport([record],[blocked],[],{grandfatheredIds:[]},'2026-09-29').summary.blocked,1);
  assert.equal(externalReviewReport([record],[receipt],[],{grandfatheredIds:[]},'2026-10-29').summary.stale,1);
  assert.throws(()=>externalReviewReport([record],[{...receipt,identityUrl:'https://other.example.org'}],[],{grandfatheredIds:[]},'2026-09-29'),/primary source/);
  const invented={...receipt,channels:{...receipt.channels,photos:{...channel,result:'found',urls:['javascript:alert(1)']}}};
  assert.throws(()=>externalReviewReport([record],[invented],[],{grandfatheredIds:[]},'2026-09-29'),/Incomplete photos/);
  const ownReviews={...receipt,channels:{...receipt.channels,reviews:{...channel,result:'found',urls:['https://example.org/reviews']}}};
  assert.throws(()=>externalReviewReport([record],[ownReviews],[],{grandfatheredIds:[]},'2026-09-29'),/Independent reviews/);
  assert.throws(()=>externalReviewReport([record],[{...receipt,evidenceOutcome:'card-supported'}],[],{grandfatheredIds:[]},'2026-09-29'),/independent testimony/);
});

test('README points to generated counts instead of retaining old public totals',()=>{
  const readme=fs.readFileSync(path.join(root,'README.md'),'utf8');
  assert.match(readme,/editorial\/profile\.json/);
  assert.match(readme,/editorial\/canton-coverage\.generated\.json/);
  assert.doesNotMatch(readme,/\d+ cards in the catalogue|of \d+ cards|The build creates \d+ separate pages/);
});

test('QA waits while a new card has no complete external review, and only then',()=>{
  const record={id:'new-card',name:'New',town:'Fribourg',status:'active',sources:[{url:'https://example.org/new'}]};
  const inputs=baselineIds=>()=>({receipts:[],legacyRecords:[],baseline:{schema:1,cutoffOn:'2026-09-29',grandfatheredIds:baselineIds}});
  assert.equal(newCardsUnreviewed([record],'2026-10-30',inputs([])),true);
  assert.equal(newCardsUnreviewed([record],'2026-10-30',inputs(['new-card'])),false);
  // Unreadable inputs say nothing about the gate: QA runs and the build answers for itself.
  assert.equal(newCardsUnreviewed([record],'2026-10-30',()=>{throw Error('no file');}),false);
});
