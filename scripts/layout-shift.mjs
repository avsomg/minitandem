// Layout shift (Lighthouse's CLS) of the built home page. Chromium only: WebKit has no layout-shift entries.
// The scripts are held back for 300 ms, so the page paints before the list exists, as on a slow connection.
// The script gives no input, so every shift counts. The two Lighthouse sizes make the numbers comparable with its report.
// Usage: node scripts/layout-shift.mjs [runs]. Fails above 0.1, the limit for "good".
import {loadPlaywright} from '../playwright-loader.mjs';
import {serveSite,contextOptions,targets,worstShiftWindow} from './browser-support.mjs';

const LIMIT=0.1,DELAY=300,runs=Number(process.argv[2])||3;
const sizes=[...targets,
  {name:'lighthouse-phone',viewport:{width:412,height:823},isMobile:true,hasTouch:true,deviceScaleFactor:1.75},
  {name:'lighthouse-desktop',viewport:{width:1350,height:940},isMobile:false,hasTouch:false,deviceScaleFactor:1}];
const fixture=await serveSite();
let browser,failed=false;
try{
  browser=await loadPlaywright().chromium.launch({headless:true});
  for(const target of sizes){
    const scores=[],moved=new Set();
    for(let run=0;run<runs;run++){
      const context=await browser.newContext(contextOptions(target));
      try{
        await context.route(/\.js$/,async route=>{await new Promise(resolve=>setTimeout(resolve,DELAY));await route.continue();});
        const page=await context.newPage();
        await page.addInitScript(()=>{
          window.__shifts=[];
          new PerformanceObserver(list=>{
            for(const entry of list.getEntries())window.__shifts.push({startTime:entry.startTime,value:entry.value,
              nodes:entry.sources.map(source=>source.node?.nodeName.toLowerCase()+(source.node?.id?'#'+source.node.id:source.node?.className?'.'+String(source.node.className).split(' ')[0]:''))});
          }).observe({type:'layout-shift',buffered:true});
        });
        await page.goto(fixture.url);await page.waitForSelector('#list .row');await page.waitForTimeout(1500);
        const shifts=await page.evaluate(()=>window.__shifts);
        scores.push(Number(worstShiftWindow(shifts).toFixed(4)));
        for(const shift of shifts)for(const node of shift.nodes)moved.add(node);
      }finally{await context.close();}
    }
    const worst=Math.max(...scores);
    if(worst>LIMIT)failed=true;
    console.log(JSON.stringify({target:target.name,viewport:target.viewport,cls:scores,limit:LIMIT,moved:[...moved]}));
  }
}finally{if(browser)await browser.close();await fixture.close();}
process.exitCode=failed?1:0;
console.log(failed?'Layout shift above the limit.':'Layout shift within the limit.');
