import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {loadStack,fakeStorage,root} from './test-support.mjs';

// The earlier key names come from the migration module itself: it is the only file allowed to contain them.
const {window:W,store,P,C,K}=loadStack();
const M=W.MinitandemMigration;
const [[oldFamily,newFamily],[oldSync,newSync],[oldCorrections,newCorrections]]=M.LOCAL_KEYS;
// Objects built inside the fake browser belong to another realm; compare them as plain data.
const plain=value=>JSON.parse(JSON.stringify(value));
const profile={version:1,favorites:['mpe'],notes:{mpe:'kept'},statuses:{mpe:'discuss'},age:3};

test('the three keys of the earlier version are moved to the Minitandem keys and the old ones are removed',()=>{
  const local=fakeStorage({[oldFamily]:profile,[oldSync]:{url:'https://family.example.ch',token:'t'.repeat(40),revision:3,dirty:false},[oldCorrections]:[{type:'vmeste-correction'}]});
  const result=M.run(local,fakeStorage());
  assert.deepEqual(plain(result.migrated).sort(),[newFamily,newSync,newCorrections].sort());
  assert.deepEqual(local.read(newFamily),profile);
  assert.equal(local.read(newSync).revision,3);
  assert.equal(local.read(newCorrections).length,1);
  for(const key of [oldFamily,oldSync,oldCorrections])assert.equal(local.getItem(key),null,key+' must be gone');
  assert.deepEqual(plain(M.run(local,fakeStorage()).migrated),[],'a second run changes nothing');
});
test('a visitor keeps favourites and notes: the store loads what the earlier version saved',()=>{
  const local=fakeStorage({[oldFamily]:{...profile,visits:{'v-one':{activity:'mpe',date:'2026-10-20'}}}});
  M.run(local,fakeStorage());
  const migrated=W.MinitandemStore.create({storage:local,byId:C.byId,P,today:C.today,statusKeys:K.PERSONAL_KEYS,canonicalId:K.canonicalId});
  assert.deepEqual(plain(migrated.personal.favorites),['mpe']);
  assert.equal(migrated.personal.notes.mpe,'kept');
  assert.equal(migrated.personal.visits['v-one'].date,'2026-10-20');
  assert.equal(migrated.personal.age,3);
});
test('a value already stored under a Minitandem key is never overwritten',()=>{
  const current={...profile,notes:{mpe:'newer'}};
  const local=fakeStorage({[oldFamily]:profile,[newFamily]:current});
  const result=M.run(local,fakeStorage());
  assert.deepEqual(plain(result.kept),[newFamily]);
  assert.deepEqual(local.read(newFamily),current);
  assert.equal(local.getItem(oldFamily),null);
});
test('nothing is lost when the storage cannot be written: the old key stays for the next try',()=>{
  const local=fakeStorage({[oldFamily]:profile});
  local.blockWrites(true);
  const result=M.run(local,fakeStorage());
  assert.deepEqual(plain(result.failed),[oldFamily]);
  assert.deepEqual(local.read(oldFamily),profile);
  local.blockWrites(false);
  assert.deepEqual(plain(M.run(local,fakeStorage()).migrated),[newFamily]);
});
test('without anything stored nothing happens, and a broken storage does not throw',()=>{
  const local=fakeStorage();
  assert.deepEqual(plain(M.run(local,fakeStorage())),{migrated:[],kept:[],failed:[],removed:[]});
  const broken={getItem:()=>{throw new Error('blocked');},setItem(){},removeItem(){}};
  assert.doesNotThrow(()=>M.run(broken,broken));
});
test('the one-off announcement and the old session filters are dropped',()=>{
  const [announcement]=M.LOCAL_DROPPED,[filters]=M.SESSION_DROPPED;
  const local=fakeStorage({[announcement]:'seen'}),session=fakeStorage({[filters]:{region:'sense'}});
  const result=M.run(local,session);
  assert.equal(result.removed.length,2);
  assert.equal(local.getItem(announcement),null);
  assert.equal(session.getItem(filters),null);
});
test('the earlier key names appear in the migration code only',()=>{
  const old=new RegExp([...M.LOCAL_KEYS.map(([from])=>from),...M.LOCAL_DROPPED,...M.SESSION_DROPPED].join('|'));
  const files=fs.readdirSync(root).filter(f=>/\.(?:js|mjs|html|css|json|webmanifest|md|txt)$/.test(f)&&!/^(?:data|research)/.test(f)&&f!=='storage-migration.js'&&f!=='storage-migration.test.mjs');
  assert.ok(files.includes('app.js')&&files.includes('store.js'));
  for(const file of files)assert.ok(!old.test(fs.readFileSync(path.join(root,file),'utf8')),file+' mentions an earlier storage key');
  assert.ok(old.test(fs.readFileSync(path.join(root,'storage-migration.js'),'utf8')));
  // The live code reads and writes only the new names.
  for(const key of Object.values(store.KEYS).filter(k=>k.startsWith('minitandem-')))assert.match(key,/^minitandem-/);
  assert.equal(store.KEYS.family,newFamily);assert.equal(store.KEYS.sync,newSync);assert.equal(store.KEYS.corrections,newCorrections);
});
test('the page runs the migration before it reads any record',()=>{
  const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  assert.ok(app.indexOf('MinitandemMigration.run')>0&&app.indexOf('MinitandemMigration.run')<app.indexOf('MinitandemStore.create'));
});
