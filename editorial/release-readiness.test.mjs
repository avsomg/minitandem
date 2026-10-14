import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertEditorialReleaseReady,releaseIdentity} from './release.mjs';

const fixture=()=>({date:'2026-10-02',input:{pipeline:{publication:{blockedIds:[]}},staleUpdates:[],records:[]},
  external:{receipts:[],legacyRecords:[],baseline:{grandfatheredIds:[]}}});

test('release check and publication share editorial and external evidence gates',()=>{
  const ready=fixture();assert.equal(assertEditorialReleaseReady(ready),true);
  const correction=fixture();correction.input.pipeline.publication.blockedIds=['open-correction'];
  assert.throws(()=>assertEditorialReleaseReady(correction),/Editorial corrections required/);
  const stale=fixture();stale.input.staleUpdates=[{jobId:'old'}];
  assert.throws(()=>assertEditorialReleaseReady(stale),/reapproval/);
  const newCard=fixture();newCard.input.records=[{id:'new',status:'active',sources:[]}];
  assert.throws(()=>assertEditorialReleaseReady(newCard),/External review required/);
});

test('the release identity comes from a private file, not from the tracked policy',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-identity-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'release-identity.json');
  assert.throws(()=>releaseIdentity(file),/Release identity missing/);
  fs.writeFileSync(file,JSON.stringify({projectId:'prj_x',orgId:'team_x'}));
  assert.throws(()=>releaseIdentity(file),/needs projectId, orgId and scope/);
  fs.writeFileSync(file,JSON.stringify({projectId:'prj_x',orgId:'team_x',scope:'scope-x'}));
  assert.deepEqual(releaseIdentity(file),{projectId:'prj_x',orgId:'team_x',scope:'scope-x'});
  const policy=JSON.parse(fs.readFileSync(new URL('./agent-policy.json',import.meta.url),'utf8'));
  assert.equal('vercel' in policy,false,'the tracked policy holds no account identifiers');
  const example=JSON.parse(fs.readFileSync(new URL('./release-identity.example.json',import.meta.url),'utf8'));
  assert.ok(Object.values(example).every(value=>/REPLACE/.test(value)),'the example holds placeholders only');
});
