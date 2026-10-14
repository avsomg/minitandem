import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadCatalog,root} from './quality.mjs';
import {publicApprovedUpdates} from './catalogue-journal.mjs';

test('editorial catalogue sees an approved revision before generated JS is rebuilt',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-live-journal-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const journal=JSON.parse(fs.readFileSync(path.join(root,'editorial','approved-updates.json'),'utf8'));
  const current=structuredClone(loadCatalog().ACTIVITIES.find(card=>card.id==='mpe'));
  const file=path.join(directory,'journal.json'),generated=fs.readFileSync(path.join(root,'data-reviewed.js'),'utf8');
  journal.updates.push({jobId:'test-pending',approvedOn:'2026-10-02',baseRecord:current,research:current.research,
    draft:{cardId:current.id,patch:{intro:'Fresh pending approved revision'},findings:[],remaining:[]}});
  fs.writeFileSync(file,JSON.stringify(journal));
  const next=loadCatalog({updatesFile:file});
  assert.equal(next.ACTIVITIES.find(card=>card.id===current.id).intro,'Fresh pending approved revision');
  assert.equal(next.STALE_UPDATES.some(update=>update.jobId==='test-pending'),false);
  assert.equal(fs.readFileSync(path.join(root,'data-reviewed.js'),'utf8'),generated);
});

test('live journal shares the public projection and still rejects changed bases and wrong project identity',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-journal-base-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const journal=JSON.parse(fs.readFileSync(path.join(root,'editorial','approved-updates.json'),'utf8'));
  const current=structuredClone(loadCatalog().ACTIVITIES.find(card=>card.id==='mpe'));
  const file=path.join(directory,'journal.json');
  journal.updates.push({jobId:'test-stale',approvedOn:'2026-10-02',baseRecord:{...current,age:'Wrong base'},research:current.research,
    draft:{cardId:current.id,patch:{intro:'Must not apply'},findings:[],remaining:[]}});
  fs.writeFileSync(file,JSON.stringify(journal));
  const next=loadCatalog({updatesFile:file});
  assert.equal(next.ACTIVITIES.find(card=>card.id===current.id).intro,current.intro);
  assert.ok(next.STALE_UPDATES.some(update=>update.jobId==='test-stale'));
  assert.throws(()=>publicApprovedUpdates({...journal,project:'another-client'}),/identity/);
  const projected=publicApprovedUpdates({schema:1,project:'vmeste',updates:[{...journal.updates.at(-1),approvalArtifact:'private-marker',supersededBy:'later'}]});
  assert.deepEqual(projected,[]);
});
