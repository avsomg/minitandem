// axe checks real UI states on both viewports. Regression cards are invented, never written to the catalogue.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright-loader.mjs';
import {engineName,artifactDirectory,serveSite,prepareContext,contextOptions,targets,expectFocus} from './scripts/browser-support.mjs';
import {scanPage,assertAccessible,blockingViolations} from './scripts/axe-checks.mjs';
import {regressionFixtures} from './scripts/browser-fixtures.mjs';

const engine=engineName(),directory=artifactDirectory('accessibility'),reports=[];
const fixture=await serveSite(),url=fixture.url;
let browser;
try{
  browser=await loadPlaywright()[engine].launch({headless:true});
  for(const target of targets){
    const context=await browser.newContext(contextOptions(target));
    try{
      const errors=await prepareContext(context,url),page=await context.newPage();
      const audit=async state=>{
        const name=target.name+'-'+state;
        reports.push(await scanPage(page,name));
        await page.screenshot({path:path.join(directory,name+'.png')});
      };
      const filters=async open=>{if(target.isMobile)await page.locator(open?'#fpMore':'#sheetDone').click();};
      const closeDetail=async()=>{await page.locator('#detail [data-close]').click();await page.waitForFunction(()=>!document.querySelector('#detail').open);};
      await page.goto(url);await page.waitForSelector('#list .row');
      await audit('catalogue');
      // Keyboard access to search, a modal and the save action complements axe's DOM checks.
      await page.keyboard.press('Tab');
      await expectFocus(page,'.skip','The first Tab reaches the skip link');
      await page.keyboard.press('Enter');
      await expectFocus(page,'#results','The skip link moves focus to the results');
      await filters(true);
      await page.locator('#place').selectOption('d:gruyere');
      await audit('filters');
      await filters(false);
      await page.locator('#q').fill('Fritime Piccolo');
      const row=page.locator('#list .row[data-id="fritime-piccolo-bulle"]');
      assert.equal(await row.count(),1);
      await audit('filtered-catalogue');
      await row.focus();await row.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#detail').open);
      await audit('detail');
      await page.locator('#detail-save [data-save]').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#detail-save [data-save]').getAttribute('aria-pressed'),'true');
      await page.keyboard.press('Escape');
      await page.waitForFunction(()=>!document.querySelector('#detail').open);
      await expectFocus(page,'#list .row[data-id="fritime-piccolo-bulle"]','Detail returns focus to its row');
      await page.locator('#q').fill('');
      await page.locator('.tab[data-view="saved"]').click();
      assert.equal(await page.locator('#list .row').count(),1);
      await page.reload();await row.waitFor();
      await audit('saved-after-reload');
      await page.locator('.tab[data-view="catalog"]').click();
      await page.locator('#resetTop').click();
      for(const lang of ['de','fr']){
        await page.locator(`#langSeg [data-lang="${lang}"]`).click();
        await page.waitForFunction(lang=>document.documentElement.lang===lang&&window.MINITANDEM_CARDS?.[lang],lang);
        await page.waitForFunction(()=>document.querySelector('#contentNote').hidden);
        await audit(lang+'-catalogue');
        await page.locator('#list .row').first().click();
        await audit(lang+'-detail');
        await closeDetail();
      }
      // The Daycare tab (in French, after the loop): its list, a place's page with a commune's rules and an application, the applications, the map.
      await page.locator('.tab[data-view="childcare"]').click();await page.waitForSelector('#childcareBox .row');
      await audit('daycare');
      await page.locator('#q').fill('Providence');
      const place=page.locator('#childcareBox .row[data-place="creche-la-providence-fribourg"]');
      await place.focus();await place.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#detail').open);
      await page.locator('#cc-commune').selectOption('fribourg');
      await page.locator('#cc-status').selectOption('waiting');
      await page.locator('#cc-registered').fill('2026-09-15');
      await audit('daycare-place');
      await page.keyboard.press('Escape');
      await page.waitForFunction(()=>!document.querySelector('#detail').open);
      await expectFocus(page,'#childcareBox .row[data-place="creche-la-providence-fribourg"]','The place\'s page returns focus to its row');
      await page.locator('#q').fill('');
      await page.locator('[data-cview="mine"]').click();await page.waitForSelector('.cc-app');
      await audit('daycare-applications');
      await page.locator('[data-cview="map"]').click();await page.waitForSelector('#places-map');
      await audit('daycare-map');
      await page.locator('[data-cview="list"]').click();
      // The plain pages that search engines find: the dark "go" button keeps a readable label and a focus ring, the title keeps "Web-App" whole.
      for(const [pathname,state] of [['places/fritime-piccolo-bulle/','place-page'],['places/fritime-piccolo-bulle/de/','place-page-de'],['places/fritime-piccolo-bulle/fr/','place-page-fr'],['projekt/','case-study']]){
        await page.goto(url+pathname);
        await audit(state);
        const go=page.locator('a.go').first();
        const look=await go.evaluate(el=>{const style=getComputedStyle(el);return {color:style.color,background:style.backgroundColor};});
        assert.notEqual(look.color,look.background,pathname+': the dark button has no visible label');
        await go.focus();
        const ring=await go.evaluate(el=>{const style=getComputedStyle(el);return {visible:el.matches(':focus-visible'),style:style.outlineStyle,width:parseFloat(style.outlineWidth),color:style.outlineColor};});
        assert(ring.visible&&ring.style==='solid'&&ring.width>=2&&ring.color!==look.color,pathname+': the dark button has no visible focus ring');
        const title=await page.locator('h1').evaluate(h=>({width:h.getBoundingClientRect().width,parts:[...h.querySelectorAll('.nb')].map(part=>part.getClientRects().length)}));
        assert(title.parts.every(lines=>lines===1),pathname+': a hyphenated word in the title breaks across lines');
        if(!target.isMobile)assert(title.width>=600,pathname+': the title is squeezed to '+title.width+' px');
      }
      assert.deepEqual(errors,[]);
    }finally{await context.close();}

    // F04 and F05 through the built UI, fixed on the third Tuesday of October 2026.
    const regression=await browser.newContext(contextOptions(target));
    try{
      const errors=await prepareContext(regression,url,{date:'2026-10-20T08:00:00Z'});
      await regression.route('**/data-practical.js',async route=>{
        const response=await route.fetch();
        await route.fulfill({response,body:await response.text()+regressionFixtures});
      });
      const page=await regression.newPage();
      const audit=async state=>{reports.push(await scanPage(page,target.name+'-'+state));};
      const filters=async open=>{if(target.isMobile)await page.locator(open?'#fpMore':'#sheetDone').click();};
      const ids=()=>page.locator('#list .row').evaluateAll(rows=>rows.map(row=>row.dataset.id).sort());
      await page.goto(url);await page.waitForSelector('#list .row');
      await page.locator('#q').fill('Browser age');
      await filters(true);await page.locator('#age').fill('3');await page.locator('#unk').click();await filters(false);
      assert.deepEqual(await ids(),['browser-age-absent','browser-age-null','browser-age-positive','browser-age-undefined']);
      assert.equal(await page.locator('#list .row .tick').count(),4);
      await audit('F04-confirmed-age');
      await page.locator('#list .row[data-id="browser-age-null"]').click();
      assert.equal(await page.locator('#detail-age-fit.unknown').count(),0);
      assert.equal(await page.locator('#detail-age-fit').count(),1);
      await audit('F04-null-bound-detail');
      await page.locator('#detail [data-close]').click();await page.waitForFunction(()=>!document.querySelector('#detail').open);
      await filters(true);await page.locator('#age').fill('4');await filters(false);
      assert.deepEqual(await ids(),['browser-age-absent','browser-age-null','browser-age-undefined']);
      await filters(true);await page.locator('#unk').click();await filters(false);
      assert.equal((await ids()).length,5);
      await audit('F04-unknown-included');
      await page.locator('#resetTop').click();
      const name=await page.evaluate(()=>ACTIVITIES.find(a=>a.id==='ludo-plaffeien').name);
      await page.locator('#q').fill(name);
      await filters(true);await page.locator('[data-kind="day"][data-val="2"]').click();await filters(false);
      assert.deepEqual(await ids(),['ludo-plaffeien'],'The ordinary Tuesday facet keeps the card');
      await audit('F05-weekday-facet');
      await filters(true);await page.locator('[data-kind="when"][data-val="today"]').click();await filters(false);
      assert.deepEqual(await ids(),[],'First Tuesday must not become a weekly opening on 20 October');
      await audit('F05-third-Tuesday-empty');
      await page.locator('#q').fill('Browser date');
      assert.deepEqual(await ids(),['browser-date-event','browser-date-weekly'],'Explicit events and weekly schedules remain; restricted recurrence stays out');
      await audit('F05-weekly-and-event');
      assert.deepEqual(errors,[]);
    }finally{await regression.close();}
  }
  // Prove that the actual axe gate detects a contrast fault, rather than trusting a green report.
  const context=await browser.newContext(contextOptions(targets[1]));
  try{
    const errors=await prepareContext(context,url),page=await context.newPage();
    await page.goto(url);await page.waitForSelector('#list .row');
    await page.setContent('<!doctype html><html lang="en"><head><title>Accessibility fixture</title></head><body><main><h1>Contrast fixture</h1><p style="color:#ccc;background:#fff;font-size:16px">This invented sentence has insufficient contrast.</p></main></body></html>');
    const fault=await scanPage(page,'injected-contrast-fixture');
    fs.writeFileSync(path.join(directory,'injected-fault.json'),JSON.stringify(fault,null,2)+'\n');
    assert(blockingViolations(fault).some(item=>item.id==='color-contrast'),'axe must detect the injected serious contrast fault');
    assert.throws(()=>assertAccessible([fault]),/color-contrast/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
  assertAccessible(reports);
  console.log(JSON.stringify({result:'PASS',engine,states:reports.map(item=>item.state)},null,2));
}finally{
  fs.writeFileSync(path.join(directory,'axe-results.json'),JSON.stringify({engine,reports},null,2)+'\n');
  if(browser)await browser.close();
  await fixture.close();
}
