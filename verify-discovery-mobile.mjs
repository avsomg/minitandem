// Cards found by the event discovery pass, on an iPhone 15 and at 320 px: every card page shows the published age, price,
// schedule and address, links to the published address for directions, and nothing overflows. The dated ones also show
// up under the "has upcoming dates" filter.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
import {loadPlaywright} from './playwright-loader.mjs';
const {webkit}=loadPlaywright();
const screenshots=path.join(root,'editorial/typesafe-runtime/discovery');
fs.mkdirSync(screenshots,{recursive:true});
const url=process.env.APP_URL||pathToFileURL(path.join(root,'index.html')).href;
const ids=['aef-villars','ne-pour-lire-estavayer','aef-vignettaz','aef-jura','aef-farvagny','aef-attalens','aef-attalens-alimentation'];
const browser=await webkit.launch({headless:true});
try{
  const context=await browser.newContext({viewport:{width:393,height:852},screen:{width:393,height:852},deviceScaleFactor:3,isMobile:true,hasTouch:true,locale:'en-GB',timezoneId:'Europe/Zurich',reducedMotion:'reduce'});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);await page.waitForSelector('#list .row');
  const noOverflow=async label=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,label+': overflow');
  for(const id of ids){
    const card=await page.evaluate(id=>JSON.parse(JSON.stringify(ACTIVITIES.find(a=>a.id===id))),id);
    assert.ok(card,id+' is in the catalogue');
    await page.locator('#q').fill(card.name);
    await page.locator(`#list .row[data-id="${id}"]`).click();
    const text=(await page.locator('#detail').innerText()).replace(/ /g,' ').replace(/\s+/g,' ');
    for(const field of ['age','price','schedule'])assert.ok(text.includes(card[field].replace(/\s+/g,' ')),`${id}: ${field} is shown as published`);
    const varying=card.events.some(e=>e.address&&e.address!==card.address);
    if(card.address&&!varying){
      assert.ok(text.includes(card.address),id+': address');
      const route=await page.locator('#detail a[href^="https://www.google.com/maps/dir/"]').first().getAttribute('href');
      assert.equal(new URL(route).searchParams.get('destination'),card.address,id+': directions go to the published address');
    }
    assert.equal(await page.locator('#detail a.go').count(),1,id+': one primary action');
    await noOverflow(id);
    await page.screenshot({path:path.join(screenshots,`iphone15-${id}.png`)});
    await page.locator('#detail [data-close]').click();
    await page.waitForFunction(()=>!document.querySelector('#detail').open);
  }
  // Dated cards appear under the date filter, with their next date on the row.
  await page.locator('#q').fill('parents-enfants');
  await page.locator('#fpMore').click();await page.locator('.chip[data-kind="when"][data-val="upcoming"]').click();await page.locator('#sheetDone').click();
  const dated=await page.evaluate(()=>[...document.querySelectorAll('#list .row')].map(r=>({id:r.dataset.id,when:r.querySelector('.r-when').textContent})));
  assert.ok(dated.length>0&&dated.every(row=>row.when.startsWith('Next: ')),'Only cards with published upcoming dates, each showing the next one');
  await page.locator('#q').fill('');
  await noOverflow('list');
  await page.setViewportSize({width:320,height:740});
  await noOverflow('320px');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',engine:'WebKit',target:'iPhone 15 and 320px',cards:ids.length,url:page.url(),screenshots},null,2));
}finally{await browser.close();}
