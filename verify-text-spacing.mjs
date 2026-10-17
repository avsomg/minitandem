// WCAG 1.4.12 (text spacing) on the app: with line height 1.5, paragraph spacing 2em, letter spacing 0.12em and word spacing 0.16em,
// no label in the list, the filters, the card or the "Your data" dialog may be cut off (a status read "Angaben prü" instead of
// "Angaben prüfen" from 1200 px). Every state is read at the widths where the layout changes, in all three languages.
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright-loader.mjs';
import {engineName,artifactDirectory,serveSite,prepareContext,contextOptions,clippedLabels,spacingStyle} from './scripts/browser-support.mjs';
const engine=engineName(),playwright=loadPlaywright();
const screenshots=artifactDirectory('text-spacing');
const fixture=await serveSite(),url=fixture.url;
const VIEWPORTS=[
  {name:'phone-320',viewport:{width:320,height:740},isMobile:true,hasTouch:true,deviceScaleFactor:2},
  {name:'phone-393',viewport:{width:393,height:852},isMobile:true,hasTouch:true,deviceScaleFactor:2},
  {name:'desktop-1200',viewport:{width:1200,height:900},isMobile:false,hasTouch:false,deviceScaleFactor:1},
  {name:'desktop-1440',viewport:{width:1440,height:1000},isMobile:false,hasTouch:false,deviceScaleFactor:1}];
const problems=[],states=[];
let browser;
try{
  browser=await playwright[engine].launch({headless:true});
  for(const target of VIEWPORTS)for(const lang of ['en','de','fr']){
    const context=await browser.newContext({...contextOptions(target),locale:{en:'en-GB',de:'de-CH',fr:'fr-CH'}[lang]});
    const errors=await prepareContext(context,url),page=await context.newPage();
    const phone=target.isMobile;
    const check=async state=>{
      // Layout settles after the dialog animation; the check reads the finished page.
      await page.waitForTimeout(150);
      // The search placeholder is read from 360 px: at 320 px the German and French ones are still longer than the field with this spacing (design review of 17 October, point 10).
      const found=(await clippedLabels(page)).filter(item=>!(target.viewport.width<360&&/ of input#q /.test(item)));
      states.push(`${target.name} ${lang} ${state}`);
      for(const item of found)problems.push(`${target.name} ${lang} ${state}: ${item}`);
      if(found.length)await page.screenshot({path:path.join(screenshots,`${target.name}-${lang}-${state}.png`)});
    };
    const closeDialog=async selector=>{await page.keyboard.press('Escape');await page.waitForFunction(selector=>!document.querySelector(selector).open,selector);};
    await page.goto(url+'?lang='+lang);await page.waitForSelector('#list .row');
    await page.addStyleTag({content:spacingStyle()});
    await check('list');
    // Filters: a sheet on a phone, a column beside the list on a desktop (read with the list). A long district name is the longest pill text.
    if(phone){
      await page.locator('#fpMore').click();await page.waitForFunction(()=>document.querySelector('#sheet').open);
      await check('filters');
      await page.locator('#place').selectOption({label:await page.locator('#place option',{hasText:'Vuisternens-devant-Romont'}).first().textContent()});
      await page.locator('#sheetDone').click();await page.waitForFunction(()=>!document.querySelector('#sheet').open);
      await check('pills');
      await page.locator('#resetTop').click();
    }
    // The card of a row that is not the first, then the dialog with the data (the addresses button is off while nothing is saved).
    await page.locator('#list .row').nth(2).click();await page.waitForFunction(()=>document.querySelector('#detail').open);
    await check('card');
    await page.locator('#detail-save [data-save]').click();
    await closeDialog('#detail');
    await page.locator('#openData').click();await page.waitForFunction(()=>document.querySelector('#utility').open);
    await check('data');
    await closeDialog('#utility');
    // The week and the saved list.
    await page.locator('.tab[data-view="week"]').click();await page.waitForSelector('.wday');
    await check('week');
    await page.locator('.tab[data-view="saved"]').click();await page.waitForSelector('#list .row');
    await check('saved');
    assert.deepEqual(errors,[],target.name+' '+lang);
    await context.close();
  }
  assert.deepEqual(problems,[],'Text is cut off with the text spacing of WCAG 1.4.12:\n'+problems.join('\n'));
  console.log(JSON.stringify({result:'PASS',engine,states:states.length,spacing:spacingStyle(),viewports:VIEWPORTS.map(v=>v.name)},null,2));
}finally{if(browser)await browser.close();await fixture.close();}
