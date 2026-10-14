// Desktop flow in WebKit (1440 x 1000): filters in the left column, rows as a table, search, filters, the card page,
// notes and favourites, downloads, import with hostile text, the archive, the empty state and the narrow layouts.
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

import {loadPlaywright} from './playwright-loader.mjs';
const {webkit}=loadPlaywright();
const root=path.dirname(fileURLToPath(import.meta.url));
const url=process.env.APP_URL||pathToFileURL(path.join(root,'index.html')).href;
const screenshots=path.join(root,'editorial/typesafe-runtime');
fs.mkdirSync(screenshots,{recursive:true});
const browser=await webkit.launch();
const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Europe/Zurich',locale:'en-GB',acceptDownloads:true,reducedMotion:'reduce'});
const page=await context.newPage();
page.setDefaultTimeout(5000);
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(url);
  await page.waitForSelector('#list .row');
  await page.evaluate(()=>localStorage.clear());
  await page.reload();await page.waitForSelector('#list .row');
  const rows=()=>page.locator('#list .row').count();
  const row=id=>page.locator(`#list .row[data-id="${id}"]`).count();
  const catalogTotal=await page.evaluate(()=>ACTIVITIES.filter(a=>!['closed','excluded'].includes(a.status)).length);
  assert.equal(await rows(),24,'The list mounts one bounded batch');
  assert.match(await page.locator('#moreBtn').textContent(),new RegExp(`24 of ${catalogTotal}`));
  // On a wide screen the filters are a left column, the rows are a table and no phone filter row is shown.
  assert.equal(await page.locator('#col').isVisible(),true);
  assert.equal(await page.locator('#fbar').isVisible(),false);
  assert.equal(await page.locator('#listhead').isVisible(),true);
  assert.equal(await page.locator('#colBody #age').isVisible(),true);
  const validation=await page.evaluate(()=>{
    const ids=ACTIVITIES.map(a=>a.id);
    return {total:ids.length,unique:new Set(ids).size,invalid:ACTIVITIES.filter(a=>!a.name||(!a.notes.length&&!a.research?.findings?.length&&!a.intro)||!['local','fribourg','schwarzsee','detour','outside','unknown'].includes(a.route)).map(a=>a.id),excluded:ACTIVITIES.filter(a=>a.status==='excluded'&&!a.exclusionReason&&false).length};
  });
  assert.equal(validation.total,validation.unique);assert.deepEqual(validation.invalid,[]);
  await page.screenshot({path:path.join(screenshots,'desktop-list.png')});

  // Search, district, filters.
  await page.locator('#q').fill('swimming');
  assert(await rows()>0);
  await page.locator('#resetTop').click();
  await page.locator('#place').selectOption('d:sense');
  await page.locator('#q').fill('Hostellerie');
  assert.equal(await row('hostellerie'),1);
  assert.equal(await row('fritime-piccolo-bulle'),0);
  await page.locator('#resetTop').click();
  await page.locator('#place').selectOption('d:gruyere');
  await page.locator('#q').fill('Fritime Piccolo');
  assert.equal(await row('fritime-piccolo-bulle'),1);
  assert.equal(await row('krabbel-plaffeien'),0);
  await page.locator('#resetTop').click();
  await page.locator('.chip.age[data-age="6"]').click();
  await page.locator('#q').fill('Snowli');
  assert.equal(await row('snowli'),0);
  await page.locator('#q').fill('Rodelbahn');
  assert.equal(await row('rodelbahn'),1);
  await page.locator('#q').fill('Watercolour');
  assert.equal(await row('aquarell'),1,'An unconfirmed minimum age stays in the list while unknown ages are included');
  await page.locator('#resetTop').click();

  // Card page: notes, status, favourites, sources and the calendar entry.
  await page.locator('#q').fill('krabbel');
  await page.locator('#list .row[data-id="krabbel-plaffeien"]').click();
  assert.equal(await page.locator('#detail').evaluate(el=>el.open),true);
  await page.locator('#personal-note').fill('Ask about a short first visit.');
  await page.locator('#personal-status').selectOption('contact');
  await page.locator('#detail-save [data-save]').click();
  await page.locator('#detail [data-close]').click();
  await page.waitForFunction(()=>document.activeElement?.dataset.id==='krabbel-plaffeien');
  await page.reload();await page.waitForSelector('#list .row');
  await page.locator('.tab[data-view="saved"]').click();
  assert.equal(await rows(),1);
  await page.locator('#list .row[data-id="krabbel-plaffeien"]').click();
  assert.equal(await page.locator('#personal-note').inputValue(),'Ask about a short first visit.');
  assert.equal(await page.locator('#personal-status').inputValue(),'contact');
  assert.match(await page.locator('#detail a[href^="mailto:"]').first().getAttribute('href'),/elternverein/);
  const icsPromise=page.waitForEvent('download');
  await page.locator('#detail [data-ics]').first().click();
  const ics=fs.readFileSync(await (await icsPromise).path(),'utf8');
  assert.match(ics,/DTSTART;TZID=Europe\/Zurich:\d{8}T\d{6}/);assert.match(ics,/BEGIN:VCALENDAR/);
  await page.screenshot({path:path.join(screenshots,'desktop-card.png')});
  await page.locator('#detail [data-close]').click();
  await page.locator('.tab[data-view="catalog"]').click();

  // Language and parent filters.
  await page.locator('#q').fill('');
  await page.locator('.chip[data-kind="lang"][data-val="FR"]').click();
  await page.locator('#q').fill('Buchstart');
  assert.equal(await row('memo-buchstart'),1,'German and French cards belong to the French filter');
  await page.locator('#resetTop').click();
  await page.locator('#adult').click();
  await page.locator('#q').fill('Kerzenziehen');
  assert.equal(await row('candles-giffers'),0,'Unknown joint participation must not pass');
  await page.locator('#q').fill('Fritime Piccolo');
  assert.equal(await row('fritime-piccolo-bulle'),1,'A card that states joint participation passes');
  await page.locator('#q').fill('krabbel');
  assert.equal(await row('krabbel-plaffeien'),0,'Krabbelgruppe Plaffeien does not state it (parent: unknown in the catalogue)');
  await page.locator('#resetTop').click();

  // Archive, reachable from the "About the data" dialog; an archived favourite stays visible in the saved view.
  await page.locator('#openAbout').click();
  await page.locator('#utility [data-view="archive"]').click();
  assert.equal(await row('eispalaeste'),1);
  await page.locator('#list .row[data-id="eispalaeste"]').click();
  await page.locator('#detail-save [data-save]').click();
  await page.locator('#detail [data-close]').click();
  await page.locator('.tab[data-view="saved"]').click();
  assert.equal(await row('eispalaeste'),1,'An archived favourite must remain visible');
  await page.locator('#list .row[data-id="eispalaeste"]').click();
  await page.locator('#detail-save [data-save]').click();
  await page.locator('#detail [data-close]').click();
  await page.locator('.tab[data-view="catalog"]').click();

  // Downloads and import with hostile text.
  await page.locator('#openData').click();
  const backupPromise=page.waitForEvent('download');
  await page.locator('[data-action="backup-export"]').click();
  const backupData=JSON.parse(fs.readFileSync(await (await backupPromise).path(),'utf8'));
  assert(backupData.favorites.includes('krabbel-plaffeien'));
  assert.equal(backupData.notes['krabbel-plaffeien'],'Ask about a short first visit.');
  const csvPromise=page.waitForEvent('download');
  await page.locator('[data-action="csv"]').click();
  const csvText=fs.readFileSync(await (await csvPromise).path(),'utf8');
  assert.match(csvText,/"Name";"Category"/);
  assert.doesNotMatch(csvText,/Ask about a short first visit/);
  await page.locator('#utility [data-close-utility]').first().click();
  await page.locator('#importFile').setInputFiles({name:'restore.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,favorites:['hostellerie'],notes:{hostellerie:'<img src=x onerror=alert(1)>'},statuses:{hostellerie:'waiting'},age:null}))});
  await page.locator('#confirm-import').click();
  await page.locator('#q').fill('hostellerie');
  await page.locator('#list .row[data-id="hostellerie"]').click();
  assert.equal(await page.locator('#personal-note').inputValue(),'<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#detail img').count(),0,'Imported text is never markup');
  await page.locator('#detail [data-close]').click();
  await page.locator('#q').fill('zzzz-no-matches');
  assert.equal(await page.locator('#empty').isVisible(),true);
  await page.locator('#empty [data-reset]').click();
  assert.equal(await rows(),24);

  // Narrow layouts: the phone filter row appears, nothing overflows.
  await page.evaluate(()=>localStorage.clear());
  await page.reload();
  const noOverflow=async label=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,label);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#fbar').isVisible(),true);
  await page.locator('#fpPlace').click();
  await page.locator('#place').selectOption('d:sense');
  await page.locator('#sheetDone').click();
  assert(await rows()>0);
  await noOverflow('390px');
  await page.setViewportSize({width:320,height:740});await noOverflow('320px');
  await page.setViewportSize({width:1024,height:768});await noOverflow('tablet');
  assert.deepEqual(errors,[],'Browser exceptions');
  console.log(JSON.stringify({result:'PASS',engine:'WebKit',catalog:catalogTotal,records:validation.total,checks:['wide layout: left filters and table rows','source schema','search','district and age filters','notes persistence','favourites','contacts','ICS timezone','language and adult filters','archive','backup, CSV and hostile import','empty state','narrow layouts without overflow']},null,2));
}finally{await browser.close();}
