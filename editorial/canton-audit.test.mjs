import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {loadCatalog} from './quality.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));

test('canton boundary and municipality audit stay aligned with the live catalogue',()=>{
  const report=JSON.parse(execFileSync(process.execPath,[path.join(here,'canton-audit.mjs'),'--stdout'],{encoding:'utf8'}));
  const records=loadCatalog().ACTIVITIES;
  const active=records.filter(a=>!['closed','excluded'].includes(a.status));
  assert.equal(report.municipalities,119);
  assert.equal(report.catalogueCards,active.length);
  assert.equal(report.municipalitiesList.reduce((sum,m)=>sum+Object.values(m.categoryCounts).reduce((a,b)=>a+b,0),0),active.length-report.unmatched.length);
  assert.equal(report.categoryPresence.dining.cards,active.filter(a=>a.category==='dining').length);
  assert.equal(report.municipalitiesList.find(m=>m.name==='Massonnens').categoryCounts.dining,1);
  assert.deepEqual(Object.fromEntries(Object.entries(report.districts).map(([key,d])=>[key,d.municipalities])),
    {broye:17,glane:14,gruyere:25,sarine:25,see:14,sense:15,veveyse:9});
  assert.deepEqual(report.unmatched.map(a=>a.id).sort(),['candles-giffers','conservatoire','rabel-giffers']);
  assert.equal(records.find(a=>a.id==='plage-chevroux').status,'excluded');
  assert.ok(!active.some(a=>/häxewääg/i.test(a.name)));
  assert.ok(!active.some(a=>/gypsera/i.test(a.name)&&a.category==='play'));
  assert.ok(Object.values(report.districts).every(d=>d.withMappedCard>0));
  assert.ok(Object.values(report.districts).some(d=>d.withMappedCard<d.municipalities),
    'presence of one card must not be mistaken for complete municipal coverage');
});
