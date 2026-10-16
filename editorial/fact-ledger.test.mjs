import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {buildLedger,catalogueValues,summaryMarkdown,main} from './fact-ledger.mjs';
import {ledgerFixture} from './fact-ledger-fixture.mjs';
import {loadCatalog} from './quality.mjs';
import {CLAIM_FIELDS} from './field-contract.mjs';

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
