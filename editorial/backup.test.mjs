import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {JobQueue} from './jobs.mjs';
import {createBackup,verifyBackup,restoreBackup} from './backup.mjs';

test('editorial backup restores files and queue without family data, keys or installed dependencies',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-backup-test-'));
  const source=path.join(base,'app');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'app.js'),'const version = 1;');
  for(const dir of ['server-state','node_modules','.vercel']){
    fs.mkdirSync(path.join(source,dir));fs.writeFileSync(path.join(source,dir,'private.json'),'private');
  }
  fs.writeFileSync(path.join(source,'.env.local'),'PRIVATE=secret');
  const queue=new JobQueue(path.join(source,'editorial/workflow-state/jobs.sqlite'));
  fs.mkdirSync(path.join(source,'editorial/corrections'),{recursive:true});
  fs.writeFileSync(path.join(source,'editorial/corrections/user-report.json'),JSON.stringify({status:'pending-review',report:{type:'vmeste-correction',message:'Private family note'}}));
  t.after(()=>{queue.close();fs.rmSync(base,{recursive:true,force:true});});
  queue.enqueue({kind:'facts',cardId:'a',inputRevision:'v1'});
  const backup=path.join(base,'backup');const created=createBackup({source,destination:backup,queue});
  assert.deepEqual(Object.keys(created.files),['app.js']);assert.equal(created.familyDataIncluded,false);
  verifyBackup(backup);
  const restored=path.join(base,'restored');const result=await restoreBackup(backup,restored);assert.equal(result.verified,true);
  const reopened=new JobQueue(path.join(restored,'editorial/workflow-state/jobs.sqlite'),{readOnly:true});
  try{assert.equal(reopened.list()[0].card_id,'a');assert.throws(()=>reopened.enqueue({kind:'facts',cardId:'b',inputRevision:'v1'}),/readonly/);}
  finally{reopened.close();}
  assert.equal(fs.existsSync(path.join(restored,'server-state')),false);
  assert.equal(fs.existsSync(path.join(restored,'editorial/corrections/user-report.json')),false);
  fs.appendFileSync(path.join(backup,'project/app.js'),'corruption');assert.throws(()=>verifyBackup(backup),/hash mismatch/);
});
test('backup does not snapshot in-progress worker writes or overwrite a restoration',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-backup-active-')),source=path.join(base,'app');fs.mkdirSync(source);
  const queue=new JobQueue(path.join(source,'editorial/workflow-state/jobs.sqlite'));
  t.after(()=>{queue.close();fs.rmSync(base,{recursive:true,force:true});});
  queue.enqueue({kind:'facts',cardId:'a',inputRevision:'v1'});queue.claim('search','worker');
  assert.throws(()=>createBackup({source,destination:path.join(base,'backup'),queue}),/active workers/);
  assert.equal(fs.existsSync(path.join(base,'backup')),false);
});
