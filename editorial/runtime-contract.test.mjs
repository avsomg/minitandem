import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runtimeContractRevision,assertRuntimeCurrent} from './runtime-contract.mjs';

test('running editorial workers detect code or policy changes, but not normal queue and card updates',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-runtime-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  fs.writeFileSync(path.join(base,'workflow.mjs'),'export const version=1;');
  fs.writeFileSync(path.join(base,'agent-policy.json'),'{}');
  const revision=runtimeContractRevision(base);
  fs.writeFileSync(path.join(base,'approved-updates.json'),'{"updates":[{}]}');
  fs.writeFileSync(path.join(base,'workflow-report.json'),'{}');
  fs.writeFileSync(path.join(base,'workflow.test.mjs'),'new test');
  assert.equal(runtimeContractRevision(base),revision);assertRuntimeCurrent(revision,base);
  fs.writeFileSync(path.join(base,'workflow.mjs'),'export const version=2;');
  assert.throws(()=>assertRuntimeCurrent(revision,base),/runtime changed/);
  const next=runtimeContractRevision(base);
  fs.writeFileSync(path.join(base,'agent-policy.json'),'{"maxJobsPerRun":2}');
  assert.throws(()=>assertRuntimeCurrent(next,base),/runtime changed/);
});
