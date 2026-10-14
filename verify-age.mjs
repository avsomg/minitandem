// The child's age on an iPhone 15 and on a desktop screen in WebKit: the release check "mobile-ages".
// One age, remembered in the family profile: a fresh profile has none, ages 0-6 filter, the unknown-age switch works,
// a wrong entry is refused, the age survives a reload and clearing it removes the filter.
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
const familyKey='minitandem-family-v1',filterKey=familyKey+'-filters';
const browser=await webkit.launch();
try{
  for(const [name,viewport,mobile] of [['iphone15',{width:393,height:852},true],['desktop',{width:1440,height:1000},false]]){
    const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,timezoneId:'Europe/Zurich',locale:'en-GB',reducedMotion:'reduce'});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);await page.waitForSelector('#list .row');
    const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+': horizontal overflow');
    // On a phone the age lives in the filter sheet, on a wide screen in the left column.
    const filters=async open=>{if(mobile){if(open)await page.locator('#fpAge').click();else await page.locator('#sheetDone').click();}};
    const age=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'null')?.age??null,familyKey);
    const count=async()=>Number((await page.locator('#count b').textContent()));
    const total=await page.evaluate(()=>ACTIVITIES.filter(a=>!['closed','excluded'].includes(a.status)).length);

    // A fresh profile has no assumed age and no age filter.
    assert.equal(await age(),null);
    assert.equal(await count(),total);
    assert.equal(await page.locator('#fpAgeV').textContent(),'Any');
    assert.equal(await page.locator('#fcount').isVisible(),false);
    await filters(true);
    assert.equal(await page.locator('#age').inputValue(),'');
    assert.equal(await page.locator('#unkRow').isHidden(),true,'The unknown-age switch appears only with an age');
    const stepper=await page.locator('.agebox').boundingBox();assert(stepper.width<=viewport.width-40);
    const placeholderFits=await page.locator('#age').evaluate(input=>{
      const style=getComputedStyle(input),context=document.createElement('canvas').getContext('2d');context.font=style.font;
      return context.measureText(input.placeholder).width<=input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    });
    assert.equal(placeholderFits,true,'The empty age field must not have a clipped placeholder');
    await page.screenshot({path:path.join(screenshots,name+'-age-before.png')});

    // Every age 0-6 through its chip: stored, shown, counted, and nothing overflows.
    const seen=[];
    for(const selected of [0,1,2,3,4,5,6]){
      await page.locator(`.chip.age[data-age="${selected}"]`).click();
      assert.equal(await age(),selected);
      assert.equal(await page.locator(`.chip.age[data-age="${selected}"]`).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('#age').inputValue(),String(selected));
      assert.equal(await page.locator('#unkRow').isVisible(),true);
      seen.push(await count());
      assert(seen.at(-1)<=total);
      await noOverflow();
    }
    assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('minitandem-family-v1-filters')).age),undefined,'The age is not part of the session filters');
    // Tapping the pressed chip again clears the age.
    await page.locator('.chip.age[data-age="6"]').click();
    assert.equal(await age(),null);assert.equal(await count(),total);

    // Boundaries: 'Under 1' and the published limits of two cards.
    await page.locator('.chip.age[data-age="0"]').click();
    await filters(false);
    assert.equal(await page.locator('#fpAgeV').textContent(),'Under 1');
    await page.locator('#q').fill('Maison de la Petite Enfance');
    assert.equal(await page.locator('#list .row[data-id="mpe"]').count(),1,'A card for 0-4 fits under 1');
    assert.equal(await page.locator('#list .row[data-id="mpe"] .tick').count(),1,'...and shows the tick');
    await page.locator('#q').fill('Heim Linde');
    assert.equal(await page.locator('#list .row[data-id="swim-tentlingen"]').count(),0,'A card for 18-36 months does not fit under 1');
    await page.locator('#q').fill('');

    // Unknown ages: included by default, then only cards with a published limit that fits.
    await filters(true);
    const withUnknown=await count();
    await page.locator('#unk').click();
    const confirmedOnly=await count();
    assert(confirmedOnly<withUnknown,'Switching off unknown ages removes cards');
    assert.equal(await page.locator('#list .row .tick').count()>0,true);
    await page.locator('#unk').click();
    assert.equal(await count(),withUnknown);

    // A wrong entry is refused and does not change the stored age.
    await page.locator('#age').fill('8');
    assert.match(await page.locator('#ageHint').textContent(),/whole number from 0 to 6/);
    assert.equal(await age(),0);
    await page.locator('#age').fill('3');
    assert.equal(await age(),3);
    assert.doesNotMatch(await page.locator('#ageHint').textContent(),/Enter a whole number/);
    await filters(false);

    // The age survives a reload; clearing it removes the filter.
    await page.reload();await page.waitForSelector('#list .row');
    assert.equal(await age(),3);
    assert.equal(await page.locator('#fpAgeV').textContent(),'3 years');
    assert.match(await page.locator('#fcount').textContent(),/1 filter active/);
    await filters(true);
    assert.equal(await page.locator('#age').inputValue(),'3');
    await page.locator('#age').fill('');
    assert.equal(await age(),null);assert.equal(await count(),total);
    await filters(false);
    assert.equal(await page.locator('#fpAgeV').textContent(),'Any');
    await page.screenshot({path:path.join(screenshots,name+'-age-after.png')});
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log(JSON.stringify({result:'PASS',engine:'WebKit',checks:['fresh profile has no assumed age','ages 0-6 through chips','tapping a chosen age clears it','Under 1 and published limits','unknown-age switch','wrong entry refused','age remembered across reload','clearing removes the filter','no overflow or JS errors'],screenshots},null,2));
}finally{await browser.close();}
