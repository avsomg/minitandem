import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readPipelineInputs} from './editorial/external-pipeline.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
import {loadPlaywright} from './playwright-loader.mjs';
const {webkit}=loadPlaywright();
const url=process.env.APP_URL||pathToFileURL(path.join(root,'.publish/index.html')).href;
const corrections=[...readPipelineInputs().corrections.values()].filter(c=>c.appliedOn==='2026-10-02');
assert.equal(corrections.length,13);
const screenshots=path.join(root,'editorial/typesafe-runtime/corrections-2026-10-02');
fs.mkdirSync(screenshots,{recursive:true});
const browser=await webkit.launch();
try{
  const context=await browser.newContext({viewport:{width:393,height:852},screen:{width:393,height:852},
    deviceScaleFactor:3,isMobile:true,hasTouch:true,locale:'en-GB',timezoneId:'Europe/Zurich',reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[];
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));
  for(const correction of corrections){
    await page.goto(url+'#activity='+correction.id);
    await page.waitForSelector('#detail[open]');
    const card=await page.evaluate(id=>JSON.parse(JSON.stringify(window.ACTIVITIES.find(a=>a.id===id))),correction.id);
    const text=(await page.locator('#detail').textContent()).replace(/ /g,' ');
    assert.ok(text.includes(card.schedule),correction.id+': visible schedule');
    const varying=card.events.some(e=>e.address&&e.address!==card.address);
    if(card.address&&!varying)assert.ok(text.includes(card.address),correction.id+': address');
    if(varying)for(const e of card.events.filter(e=>e.address))assert.ok(text.includes(e.address),correction.id+': address of a dated session');
    const links=await page.locator('#detail a').evaluateAll(links=>links.map(a=>a.getAttribute('href')));
    for(const source of card.sources)assert.ok(links.includes(source.url),correction.id+': source link');
    // The directions link points at the published address; cards with dated or area-only addresses offer a map search instead.
    if(card.address&&!varying&&card.addressPrecision!=='area'){
      const route=links.find(href=>href?.startsWith('https://www.google.com/maps/dir/'));
      assert.ok(route,correction.id+': directions link');
      assert.equal(new URL(route).searchParams.get('destination'),card.address);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,correction.id+': page overflow');
    assert.equal(await page.locator('#detail .d-body').evaluate(el=>el.scrollWidth>el.clientWidth),false,correction.id+': detail overflow');
    if(['conservatoire','elki-heitenried','montsalvens-lakeside-walk'].includes(correction.id))
      await page.screenshot({path:path.join(screenshots,correction.id+'.png')});
  }
  await page.goto(url);await page.waitForSelector('#list .row');
  await page.locator('#q').fill('Fritime Piccolo');
  await page.locator('#fpMore').click();
  await page.locator('.chip[data-kind="day"][data-val="6"]').click();
  await page.locator('#sheetDone').click();
  assert.equal(await page.locator('#list .row[data-id="fritime-piccolo-bulle"]').count(),0,'Piccolo runs on Thursdays only');
  await page.locator('#fpMore').click();
  await page.locator('.chip[data-kind="day"][data-val="6"]').click();
  await page.locator('.chip[data-kind="day"][data-val="4"]').click();
  await page.locator('#sheetDone').click();
  assert.equal(await page.locator('#list .row[data-id="fritime-piccolo-bulle"]').count(),1);
  await page.locator('#fpMore').click();await page.locator('#sheet [data-reset]').click();await page.locator('#sheetDone').click();
  await page.locator('#q').fill('Familienkonzert');
  await page.locator('#list .row[data-id="familienkonzert-kerzers-2026"]').click();
  assert.ok((await page.locator('#detail').textContent()).includes('16:00–17:00'));
  assert.deepEqual(errors,[]);
  await context.close();
  console.log(JSON.stringify({result:'PASS',engine:'WebKit',viewport:'iPhone 15',cards:corrections.length,
    checks:['compiled schedules and addresses','source links','directions destination','no horizontal overflow',
      'Piccolo Thursday-only filter','Kerzers dated entry and end time'],screenshots},null,2));
}finally{await browser.close();}
