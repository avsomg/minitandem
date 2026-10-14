// Screenshots of the real app (not the mockup) for design/: node screenshots.mjs [APP_URL]
// Mobile ones are 393 x 852 CSS px at 2x (786 x 1704 files, like the mockup's), the desktop one is 1280 x 800.
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import {loadPlaywright} from './playwright-loader.mjs';
const {webkit}=loadPlaywright();
const root=path.dirname(fileURLToPath(import.meta.url));
const url=process.argv[2]||process.env.APP_URL||pathToFileURL(path.join(root,'.publish/index.html')).href;
const out=path.join(root,'design');
fs.mkdirSync(out,{recursive:true});
const browser=await webkit.launch();
try{
  const open=async(options,lang)=>{
    const context=await browser.newContext({locale:lang==='de'?'de-CH':lang==='fr'?'fr-CH':'en-GB',timezoneId:'Europe/Zurich',reducedMotion:'reduce',...options});
    const page=await context.newPage();
    await page.goto(url);await page.waitForSelector('#list .row');
    return {context,page};
  };
  const phone={viewport:{width:393,height:852},deviceScaleFactor:2,isMobile:true,hasTouch:true};
  {
    const {context,page}=await open(phone,'en');
    await page.screenshot({path:path.join(out,'app-list-mobile.png')});
    await page.evaluate(()=>window.scrollTo(0,640));
    await page.screenshot({path:path.join(out,'app-list-mobile-scrolled.png')});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.locator('#fpMore').click();
    await page.waitForTimeout(350);
    await page.screenshot({path:path.join(out,'app-filters-mobile.png')});
    await page.locator('#sheetClose').click();
    await page.locator('#q').fill('MEMO library');
    await page.locator('#list .row[data-id="memo-library"]').click();
    await page.waitForTimeout(350);
    await page.screenshot({path:path.join(out,'app-card-mobile.png')});
    await context.close();
  }
  for(const lang of ['de','fr']){
    const {context,page}=await open(phone,lang);
    await page.screenshot({path:path.join(out,`app-list-mobile-${lang}.png`)});
    await context.close();
  }
  {
    const {context,page}=await open({viewport:{width:1280,height:800},deviceScaleFactor:1},'en');
    await page.screenshot({path:path.join(out,'app-list-desktop.png')});
    await context.close();
  }
  console.log('Screenshots written to design/');
}finally{await browser.close();}
