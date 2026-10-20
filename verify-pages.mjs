// The plain pages (the legal notices, the case study, the directory of places and a place, each in its languages): every page has a description, the language switch of a
// notice or a place page is one row with a gap between the links and marks the page's own language, and no page is wider than the screen or cuts a label
// off at 320, 375 and 1280 px, also with the text spacing of WCAG 1.4.12.
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright-loader.mjs';
import {engineName,artifactDirectory,serveSite,prepareContext,contextOptions,clippedLabels,spacingStyle} from './scripts/browser-support.mjs';
const engine=engineName(),playwright=loadPlaywright();
const screenshots=artifactDirectory('pages');
const fixture=await serveSite(),url=fixture.url;
const NOTICES=['/impressum/','/impressum/fr/','/impressum/en/','/datenschutz/','/datenschutz/fr/','/datenschutz/en/'];
// The directory and a place in each of its three languages (English at /places/, German and French in a folder beside it).
const PLACES=['/places/','/places/de/','/places/fr/','/places/beo-funpark/','/places/beo-funpark/de/','/places/beo-funpark/fr/'];
const PAGES=[...NOTICES,'/projekt/','/projekt/en/',...PLACES];
const SWITCHED=[...NOTICES,...PLACES];
const WIDTHS=[320,375,1280];
const problems=[];
let browser;
try{
  browser=await playwright[engine].launch({headless:true});
  for(const width of WIDTHS){
    const phone=width<768;
    const context=await browser.newContext(contextOptions({name:'pages',viewport:{width,height:800},isMobile:phone,hasTouch:phone,deviceScaleFactor:phone?2:1}));
    const errors=await prepareContext(context,url),page=await context.newPage();
    for(const route of PAGES){
      await page.goto(url+route.slice(1));
      const where=`${width}px ${route}`;
      assert.ok((await page.locator('meta[name="description"]').getAttribute('content'))?.trim().length>=50,where+': a meta description');
      if(SWITCHED.includes(route)){
        const switcher=await page.evaluate(()=>{
          const links=[...document.querySelectorAll('nav.langnav a')],boxes=links.map(a=>a.getBoundingClientRect());
          const paint=a=>{const style=getComputedStyle(a);return {background:style.backgroundColor,color:style.color};};
          return {count:links.length,tops:boxes.map(box=>Math.round(box.top)),gaps:boxes.slice(1).map((box,i)=>Math.round(box.left-boxes[i].right)),
            current:links.filter(a=>a.getAttribute('aria-current')==='page').map(a=>a.getAttribute('hreflang')),pageLanguage:document.documentElement.lang,
            paints:links.map(paint),currents:links.map(a=>a.getAttribute('aria-current')==='page')};
        });
        assert.equal(switcher.count,3,where);
        assert.equal(new Set(switcher.tops).size,1,where+': the three links stand in one row');
        assert.ok(switcher.gaps.every(gap=>gap>=2),where+': the links do not touch, gaps '+switcher.gaps);
        assert.deepEqual(switcher.current,[switcher.pageLanguage],where+': the page\'s own language is marked');
        const own=switcher.paints[switcher.currents.indexOf(true)],others=switcher.paints.filter((_,i)=>!switcher.currents[i]);
        const dark=colour=>colour.match(/\d+/g).slice(0,3).reduce((a,b)=>a+Number(b),0)<150;
        assert.ok(dark(own.background)&&!dark(own.color),where+': the current language is white on black');
        assert.ok(others.every(other=>other.background!==own.background&&other.color!==own.color),where+': the other languages are not painted like it');
      }
      for(const spacing of [false,true]){
        if(spacing)await page.addStyleTag({content:spacingStyle()});
        for(const item of await clippedLabels(page))problems.push(`${where}${spacing?' with text spacing':''}: ${item}`);
      }
      if(route==='/datenschutz/fr/'||route==='/impressum/')await page.screenshot({path:path.join(screenshots,`${width}-${route.replaceAll('/','_')}.png`)});
    }
    assert.deepEqual(errors,[],'page errors at '+width);
    await context.close();
  }
  assert.deepEqual(problems,[],'A page is wider than the screen or cuts text off:\n'+problems.join('\n'));
  console.log(JSON.stringify({result:'PASS',engine,pages:PAGES.length,widths:WIDTHS,checks:['meta description','language switch: one row, a gap, own language marked','no overflow or cut-off label','the same with WCAG 1.4.12 text spacing']},null,2));
}finally{if(browser)await browser.close();await fixture.close();}
