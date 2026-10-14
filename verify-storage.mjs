// Records kept in the browser, with two tabs: an explicit backup import wins even when its values equal the old baseline,
// a queued stale storage event must not overwrite what is typed now, a change made in another tab shows up live, an
// over-age child does not grow into a card, the Swiss time zone decides what is past, and the one-time move of the data
// stored under the earlier key names.
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {serve} from './verify-support.mjs';

import {loadPlaywright} from './playwright-loader.mjs';
const {webkit}=loadPlaywright();
const root=path.dirname(fileURLToPath(import.meta.url));
const served=await serve(process.env.APP_URL||pathToFileURL(path.join(root,'index.html')).href);
const url=served.url;
const key='minitandem-family-v1';
// The earlier key names are read from the migration module, the only file that may contain them.
const migrationWindow={};vm.runInNewContext(fs.readFileSync(path.join(root,'storage-migration.js'),'utf8'),{window:migrationWindow});
const [[oldFamily],,[oldCorrections]]=migrationWindow.MinitandemMigration.LOCAL_KEYS;
const browser=await webkit.launch();
try{
  const c=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-GB'});
  await c.addInitScript(k=>{if(!localStorage.getItem(k))localStorage.setItem(k,JSON.stringify({version:1,favorites:[],notes:{},statuses:{},age:3}));},key);
  const a=await c.newPage(),b=await c.newPage();
  await a.goto(url);await a.waitForSelector('#list .row');
  await b.addInitScript(()=>window.addEventListener('storage',e=>e.stopImmediatePropagation(),true));
  await b.goto(url);await b.waitForSelector('#list .row');
  await a.locator('.chip.age[data-age="5"]').click();
  assert.equal(await a.evaluate(k=>JSON.parse(localStorage.getItem(k)).age,key),5);
  await b.locator('#importFile').setInputFiles({name:'restore.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,favorites:[],notes:{museum:'Explicit backup'},statuses:{museum:'waiting'},age:3}))});
  await b.locator('#confirm-import').click();
  assert.equal(await b.evaluate(k=>JSON.parse(localStorage.getItem(k)).age,key),3,'A backup age must override a newer age even when it equals the old baseline');
  assert.equal(await b.evaluate(k=>JSON.parse(localStorage.getItem(k)).notes.museum,key),'Explicit backup');
  await a.reload();await a.waitForSelector('#list .row');
  await a.locator('#q').fill('museum');
  await a.locator('#list .row[data-id="museum"]').click();
  await a.locator('#personal-note').fill('Latest note');
  await a.evaluate(k=>window.dispatchEvent(new StorageEvent('storage',{key:k,newValue:JSON.stringify({version:1,favorites:[],notes:{museum:'Stale note'},statuses:{},age:3})})),key);
  assert.equal(await a.locator('#personal-note').inputValue(),'Latest note','A queued stale storage event must read the current storage');
  await b.evaluate(k=>{const v=JSON.parse(localStorage.getItem(k));v.age=6;localStorage.setItem(k,JSON.stringify(v));},key);
  await a.waitForFunction(()=>document.querySelector('#detail-age-fit')?.textContent.includes('6'));
  await a.locator('#detail [data-close]').click();await a.waitForFunction(()=>!document.querySelector('#detail').open);
  assert.equal(await a.locator('#fpAgeV').textContent(),'6 years','The list follows the age changed in the other tab');
  await a.locator('#q').fill('Snowli');
  assert.equal(await a.locator('#list .row[data-id="snowli"]').count(),0,'An over-age child does not grow into Snowli');
  await c.close();

  for(const timezoneId of ['Europe/Zurich','America/New_York']){
    const zone=await browser.newContext({timezoneId,locale:'en-GB'});const p=await zone.newPage();await p.clock.setFixedTime(new Date('2026-09-22T09:30:00Z'));
    await p.goto(url+'#view=catalog&activity=memo-buchstart');
    await p.waitForSelector('#detail[open]');
    assert.match(await p.locator('#detail .drow.past').first().textContent(),/22 Sep.*passed/,'A Swiss event of 09:30-11:00 on 22 September is past at 11:30 Swiss time whatever the device zone');
    await zone.close();
  }

  // The earlier key names are moved once: data kept, old keys removed, an existing new key never overwritten.
  const migration=await browser.newContext({locale:'en-GB'});
  await migration.addInitScript(([family,corrections])=>{
    if(localStorage.getItem('migrated-once'))return;
    localStorage.setItem('migrated-once','1');
    localStorage.setItem(family,JSON.stringify({version:1,favorites:['museum'],notes:{museum:'From the earlier version'},statuses:{},age:4}));
    localStorage.setItem(corrections,'[]');
  },[oldFamily,oldCorrections]);
  const m=await migration.newPage();
  await m.goto(url);await m.waitForSelector('#list .row');
  const moved=await m.evaluate(old=>({family:JSON.parse(localStorage.getItem('minitandem-family-v1')),oldKeys:Object.keys(localStorage).filter(k=>old.includes(k))}),[oldFamily,oldCorrections]);
  assert.equal(moved.family.notes.museum,'From the earlier version');assert.equal(moved.family.age,4);assert.deepEqual(moved.oldKeys,[]);
  assert.equal(await m.locator('#fpAgeV').textContent(),'4 years','The remembered age is applied');
  await m.reload();await m.waitForSelector('#list .row');
  assert.equal(await m.evaluate(()=>JSON.parse(localStorage.getItem('minitandem-family-v1')).notes.museum),'From the earlier version','The move runs once and does not repeat');
  await migration.close();
  console.log(JSON.stringify({result:'PASS',checks:['explicit import overrides','stale storage events','live age from another tab','over-age card','Swiss timezone in New York and Zurich','one-time storage key migration']}));
}finally{await browser.close();await served.close();}
