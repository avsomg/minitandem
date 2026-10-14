import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const sandbox={window:{},structuredClone};
for(const file of ['data.js','data-reviewed.js','data-practical.js','regions.js'])vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),sandbox);
const records=JSON.parse(JSON.stringify(sandbox.window.ACTIVITIES));
const ids=['sellenhof-wednesday','sellenhof-group','sellenhof-private','pony-entdecken','pony-spass','pferde-oberschrot','swim-tentlingen','swim-buissonnets','swim-duedingen','snowli-daily','snowli-weekly','ski-private'];
const get=id=>records.find(a=>a.id===id);
assert(records.length>=ids.length);
assert.equal(new Set(records.map(a=>a.id)).size,records.length);
for(const id of ids){
  const a=get(id);
  assert(a,`Missing ${id}`);
  assert(a.sources.length && a.contacts.length && a.notes.length,`Incomplete ${id}`);
  for(const e of a.events){
    assert.equal(new Date(`${e.date}T12:00:00Z`).toISOString().slice(0,10),e.date);
    assert(a.days.includes(new Date(`${e.date}T12:00:00Z`).getUTCDay()||7));
    assert(e.start<e.end);
  }
  assert.equal(new Set(a.events.map(e=>`${e.date} ${e.start}`)).size,a.events.length);
}
assert.equal(get('swim-tentlingen').events.length,15);
assert.equal(get('swim-buissonnets').events.length,14);
assert.equal(get('swim-tentlingen').amount/15,25);
assert.equal(get('swim-buissonnets').amount/14,25);
assert(!get('swim-tentlingen').events.some(e=>['2026-10-16','2026-10-23'].includes(e.date)));
assert(!get('swim-buissonnets').events.some(e=>['2026-10-17','2026-10-24'].includes(e.date)));
assert.equal(get('minimove-schonberg').events.length,18);
assert.equal(get('memo-buchstart').events.length,6);
assert.equal(get('lire-marly').events.length,7);
// The earlier version of this check pinned three sessions (1 Oct, 5 Nov, 3 Dec 2026); the catalogue now publishes the last two.
assert.deepEqual(get('verslimorgen-duedingen').events.map(e=>e.date),['2026-11-05','2026-12-03']);
assert.equal(get('verslimorgen-duedingen').status,'active');
assert(get('verslimorgen-duedingen').events.every(e=>e.start==='10:00'&&e.end==='10:30'));
assert.equal(get('ludo-marly').address,'Chemin des Epinettes 2, 1723 Marly');
assert.equal(get('swim-duedingen').events.length,0);
assert.equal(get('swim-duedingen').amount,null);
assert.equal(get('swim-duedingen').min,3);
for(const id of ['sellenhof-private','sellenhof-group','sellenhof-wednesday','ski-private']){
  assert.equal(get(id).min,null);
  assert.equal(get(id).parent,'unknown');
}
for(const a of records.filter(a=>a.id==='snowli'||a.id.startsWith('snowli-')||a.id==='ski-private'))assert.equal(a.events.length,0);

import {loadPlaywright} from './playwright-loader.mjs';
const {webkit}=loadPlaywright();
const browser=await webkit.launch({headless:true});
const url=process.env.APP_URL||pathToFileURL(path.join(root,'index.html')).href;
const screenshots=path.join(root,'editorial/typesafe-runtime/additions');
fs.mkdirSync(screenshots,{recursive:true});
try{
  const context=await browser.newContext({viewport:{width:393,height:852},screen:{width:393,height:852},deviceScaleFactor:3,isMobile:true,hasTouch:true,locale:'en-GB',timezoneId:'Europe/Zurich',acceptDownloads:true,reducedMotion:'reduce'});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('#list .row');
  const rows=()=>page.locator('#list .row').count();
  const row=id=>page.locator(`#list .row[data-id="${id}"]`).count();
  const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(await page.locator('#g-fmt .chip').evaluateAll(els=>els.map(el=>el.dataset.val)),['group','individual','event','self']);
  const reset=async()=>{await page.locator('#resetTop').click().catch(async()=>{await page.locator('#fpMore').click();await page.locator('#sheet [data-reset]').click();await page.locator('#sheetDone').click();});};
  const sheet=async fn=>{await page.locator('#fpMore').click();await fn();await page.locator('#sheetDone').click();};

  // Swimming for a two-year-old with an adult, German-speaking.
  await page.locator('#q').fill('swimming');
  await sheet(async()=>{
    await page.locator('.chip.age[data-age="2"]').click();
    await page.locator('#adult').click();
    await page.locator('.chip[data-kind="lang"][data-val="DE"]').click();
  });
  for(const id of ['swim-tentlingen','swim-buissonnets'])assert.equal(await row(id),1);
  assert.equal(await row('swim-duedingen'),0,'A card from age 3 is outside age 2');
  await noOverflow();
  await page.screenshot({path:path.join(screenshots,'iphone15-swimming.png')});
  await page.locator('#list .row[data-id="swim-tentlingen"]').click();
  assert.match(await page.locator('#detail').innerText(),/Booking commits you to payment/);
  assert.match(await page.locator('#detail .facts').innerText(),/CHF 375/);
  assert.equal(await page.locator('#detail .drow').count(),15);
  await noOverflow();
  await page.screenshot({path:path.join(screenshots,'iphone15-swim-detail.png')});
  await page.locator('#detail-save [data-save]').click();
  await page.locator('#personal-note').fill('Test note in a disposable browser profile.');
  // The calendar entry of the next upcoming session (past sessions have no button).
  const next=await page.evaluate(()=>{
    const card=ACTIVITIES.find(a=>a.id==='swim-tentlingen'),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich'}).format(new Date());
    const index=card.events.findIndex(e=>e.date>=today),e=card.events[index];
    return {index,start:e.date.replaceAll('-','')+'T'+e.start.replace(':','')+'00',end:e.date.replaceAll('-','')+'T'+e.end.replace(':','')+'00'};
  });
  assert(next.index>=0);
  const downloadPromise=page.waitForEvent('download');
  await page.locator(`[data-event="${next.index}"][data-ics="swim-tentlingen"]`).click();
  const ics=await downloadPromise;
  const text=fs.readFileSync(await ics.path(),'utf8');
  assert(text.includes('DTSTART;TZID=Europe/Zurich:'+next.start));
  assert(text.includes('DTEND;TZID=Europe/Zurich:'+next.end));
  assert.match(text,/SUMMARY:Course · /);
  await page.locator('#detail [data-close]').click();
  await reset();

  // Horses: six cards, none with a confirmed age for a two-year-old when unknown ages are switched off.
  await sheet(()=>page.locator('.chip[data-kind="cat"][data-val="horses"]').click());
  assert.equal(await rows(),6);
  assert.equal(await page.locator('#list .row .r-cat').evaluateAll(els=>els.every(el=>el.textContent==='Horses and ponies')),true);
  await noOverflow();
  await page.screenshot({path:path.join(screenshots,'iphone15-horses.png')});
  await sheet(async()=>{await page.locator('.chip.age[data-age="2"]').click();await page.locator('#unk').click();});
  assert.equal(await rows(),0,'No horse card publishes an age for a two-year-old; unknowns are excluded explicitly');
  await sheet(()=>page.locator('#unk').click());
  assert.equal(await rows(),3,'With unknown ages included only the three Sellenhof cards remain for age 2: the pony groups state higher minimums');
  assert.equal(await row('sellenhof-group'),1);
  await sheet(()=>page.locator('.chip.age[data-age="2"]').click());
  assert.equal(await rows(),6);
  await page.locator('#list .row[data-id="pony-entdecken"]').click();
  assert.match(await page.locator('#detail').textContent(),/Getting to know ponies, grooming, feeding/);
  await page.locator('#detail [data-close]').click();
  await reset();

  // Format: individual sessions, kept through a reload.
  await sheet(()=>page.locator('.chip[data-kind="fmt"][data-val="individual"]').click());
  assert.equal(await rows(),3);
  assert.equal(await row('ferme-verte-vallee-vuisternens'),1);
  await page.reload();await page.waitForSelector('#list .row');
  assert.equal(await rows(),3,'The format filter must survive a reload');
  await sheet(async()=>{await page.locator('.chip[data-kind="fmt"][data-val="individual"]').click();await page.locator('.chip[data-kind="fmt"][data-val="group"]').click();});
  await page.locator('#q').fill('private');
  assert.equal(await row('ski-private'),0,'An individual session is not a group');
  await page.locator('#q').fill('Heim Linde');
  assert.equal(await row('swim-tentlingen'),1);
  await reset();

  // Search by the other-language name of a place and by an organiser.
  await page.locator('#q').fill('Guin');
  assert.equal(await row('swim-duedingen'),1,'Düdingen is also found as Guin');
  await page.locator('#q').fill('Sellenhof');
  assert.equal(await rows(),3);
  await page.locator('#q').fill('');

  // Saved records and the date filter.
  await page.locator('.tab[data-view="saved"]').click();
  assert.equal(await rows(),1);
  await page.locator('#list .row[data-id="swim-tentlingen"]').click();
  assert.match(await page.locator('#personal-note').inputValue(),/disposable/);
  await page.locator('#detail [data-close]').click();
  await page.locator('.tab[data-view="catalog"]').click();
  await page.locator('#q').fill('Heim Linde');
  await sheet(()=>page.locator('.chip[data-kind="when"][data-val="upcoming"]').click());
  assert.equal(await row('swim-tentlingen'),1,'A card with published upcoming dates passes the date filter');
  assert.match(await page.locator('#list .row[data-id="swim-tentlingen"] .r-when').textContent(),/^Next: /);
  await noOverflow();
  await page.screenshot({path:path.join(screenshots,'iphone15-swim-dates.png')});
  await reset();
  for(const width of [320,852,1440]){
    await page.setViewportSize({width,height:width===852?393:1000});
    await noOverflow();
  }
  await page.screenshot({path:path.join(screenshots,'desktop-swimming.png')});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',url,added:ids.length,records:records.length,checks:['source fields','exact dates and breaks','price units','age filter','parent presence','language filter','horses category','format filter and reload','search by other-language place names','saved note','date filter and next date','overflow at 320, landscape and desktop','no JS errors']},null,2));
}finally{await browser.close();}
