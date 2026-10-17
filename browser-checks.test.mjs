import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import test from 'node:test';
import {engineName,targets,contextOptions,serveSite,prepareContext,expectFocus} from './scripts/browser-support.mjs';
import {assertAccessible,blockingViolations} from './scripts/axe-checks.mjs';
import {regressionFixtures} from './scripts/browser-fixtures.mjs';

test('browser engines are explicit; local WebKit remains the default',()=>{
  assert.equal(engineName({}),'webkit');
  for(const name of ['webkit','chromium'])assert.equal(engineName({BROWSER_ENGINE:name}),name);
  assert.throws(()=>engineName({BROWSER_ENGINE:'typo'}),/BROWSER_ENGINE/);
  assert.deepEqual(targets.map(target=>target.name),['phone','desktop']);
  assert.equal(contextOptions(targets[0]).serviceWorkers,'block');
});

test('axe blocks serious and critical violations and preserves lesser and incomplete findings',()=>{
  const item=impact=>({impact,id:'fixture-'+impact,nodes:[{target:['#fixture']}]});
  const clean={state:'catalogue',violations:[item('minor'),item('moderate')],incomplete:[item('serious')]};
  assert.doesNotThrow(()=>assertAccessible([clean]));
  assert.equal(clean.violations.length,2);assert.equal(clean.incomplete.length,1);
  for(const impact of ['serious','critical']){
    const report={...clean,violations:[...clean.violations,item(impact)]};
    assert.equal(blockingViolations(report).length,1);
    assert.throws(()=>assertAccessible([clean,report]),new RegExp('catalogue: '+impact+' fixture-'+impact));
  }
});

test('the regression response adds invented fixtures without altering its public base card',()=>{
  const base={id:'mpe',name:'Public fixture',min:0,max:4,ageUpperUncertainFrom:2,events:[],notes:[],ageException:{min:1}};
  const original=structuredClone(base),window={ACTIVITIES:[base]};
  vm.runInNewContext(regressionFixtures,{window,structuredClone});
  assert.deepEqual(base,original);
  const byId=new Map(window.ACTIVITIES.map(card=>[card.id,card]));
  assert.equal(Object.hasOwn(byId.get('browser-age-absent'),'ageUpperUncertainFrom'),false);
  assert.equal(Object.hasOwn(byId.get('browser-age-undefined'),'ageUpperUncertainFrom'),true);
  assert.equal(byId.get('browser-age-null').ageUpperUncertainFrom,null);
  assert.equal(byId.get('browser-age-zero').ageUpperUncertainFrom,0);
  assert.equal(byId.get('browser-age-positive').ageUpperUncertainFrom,4);
  assert.equal(byId.get('browser-date-event').events[0].date,'2026-10-20');
});

test('browser contexts freeze dates, report errors on every tab and prevent external requests',async()=>{
  const events=new Map(),pageEvents=new Map();let handler,init;
  const context={on:(name,fn)=>events.set(name,fn),addInitScript:async(fn,value)=>{init={fn,value};},route:async(pattern,fn)=>{handler=fn;}};
  const errors=await prepareContext(context,'http://127.0.0.1:1234/');
  assert.equal(init.value,'2026-10-14T08:00:00Z');
  events.get('page')({setDefaultTimeout:()=>{},on:(name,fn)=>pageEvents.set(name,fn)});
  pageEvents.get('pageerror')(new Error('fixture error'));
  pageEvents.get('console')({type:()=> 'error',text:()=> 'console fixture'});
  const route=url=>({request:()=>({url:()=>url}),continue:async()=> 'local',fulfill:async()=> 'tile',abort:async()=> 'blocked'});
  assert.equal(await handler(route('http://127.0.0.1:1234/app.js')),'local');
  assert.equal(await handler(route('https://wmts.geo.admin.ch/tile.jpeg')),'tile');
  await handler(route('https://example.org/unexpected'));
  assert.deepEqual(errors,['fixture error','console fixture','Unexpected external request: https://example.org']);
});

test('the snapshot server serves only the selected public directory and rejects private paths and symlinks',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-browser-server-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.writeFileSync(path.join(directory,'index.html'),'<h1>Public fixture</h1>');
  fs.writeFileSync(path.join(directory,'.private'),'private fixture');
  fs.symlinkSync(path.join(directory,'.private'),path.join(directory,'link.txt'));
  const {pathToFileURL}=await import('node:url');
  const site=await serveSite(pathToFileURL(path.join(directory,'index.html')).href);
  t.after(()=>site.close());
  assert.equal(await (await fetch(site.url)).text(),'<h1>Public fixture</h1>');
  for(const file of ['.private','link.txt','missing.js','%2e%2e%2fpackage.json','%ZZ']){
    const response=await fetch(site.url+file);
    assert([400,404].includes(response.status),file);
  }
  assert.equal((await fetch(site.url,{method:'POST'})).status,404);
  assert.equal(await (await fetch(site.url,{method:'HEAD'})).text(),'');
});

test('a focus check waits for focus that arrives late and names the element that has it when it never comes',async()=>{
  // Focus returns to a row in a microtask after the dialog's close event; reading it at once saw the body in 3 of 6 runs.
  let polls=0;
  const late={waitForFunction:async(check,selector,{timeout})=>{assert.equal(selector,'#row');assert.equal(timeout,3000);if(++polls<3)await new Promise(resolve=>setTimeout(resolve,5));},evaluate:async()=>'<body>'};
  await expectFocus(late,'#row','Detail returns focus to its row');
  const never={waitForFunction:async()=>{throw Error('Timeout');},evaluate:async()=>'<body>'};
  await assert.rejects(expectFocus(never,'#row','Detail returns focus to its row'),/Detail returns focus to its row \(focus is on <body>\)/);
  // The browser scripts wait for moved focus; only "focus stays where it was" is still read at once (the save button).
  const source=file=>fs.readFileSync(new URL('./'+file,import.meta.url),'utf8');
  assert.ok(!/document\.activeElement/.test(source('verify-accessibility.mjs')),'verify-accessibility.mjs reads the focus at once');
  assert.ok(!/document\.activeElement\.id/.test(source('verify-mobile.mjs')),'verify-mobile.mjs reads the focus at once');
  assert.ok(source('verify-accessibility.mjs').includes(`expectFocus(page,'#list .row[data-id="fritime-piccolo-bulle"]','Detail returns focus to its row')`));
});
