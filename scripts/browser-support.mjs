// Shared by the browser checks; no browser download or public service request happens here.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function engineName(env=process.env){
  const name=env.BROWSER_ENGINE||'webkit';
  if(!['webkit','chromium'].includes(name))throw Error('BROWSER_ENGINE must be webkit or chromium');
  return name;
}
export const targets=[
  {name:'phone',viewport:{width:393,height:852},isMobile:true,hasTouch:true,deviceScaleFactor:3},
  {name:'desktop',viewport:{width:1440,height:1000},isMobile:false,hasTouch:false,deviceScaleFactor:1}
];
export const contextOptions=({name,...target})=>({...target,locale:'en-GB',timezoneId:'Europe/Zurich',acceptDownloads:true,reducedMotion:'reduce',serviceWorkers:'block'});
// The app moves focus in a microtask after a dialog's close event, so a check waits for it instead of reading it at once.
export async function expectFocus(page,selector,message,timeout=3000){
  const onIt=selector=>document.activeElement===document.querySelector(selector);
  try{await page.waitForFunction(onIt,selector,{timeout});}
  catch{assert.fail(`${message} (focus is on ${await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,90))})`);}
}
// WCAG 1.4.12 (text spacing): the values a reader may set, as the success criterion names them. Applied to a page, no label may be cut off.
export const TEXT_SPACING='*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}';
// What a box cuts off: a box that hides its overflow (also by an ellipsis or a line clamp) and holds more than it shows, a search field whose
// placeholder is longer than the field, and anything that makes the page wider than the screen. Scroll containers are not cutting anything off.
// Left out on purpose: text that is visually hidden (the word beside an icon), and the two columns of the list that hold the organiser's own
// text, clamped to two lines or one line on purpose because the card page holds the whole text: the schedule and a price that says something.
// A price that is only "not published" is a label (the interface phrase) and is checked like one.
export function clippedLabels(page){
  return page.evaluate(()=>{
    const out=[],phrase=window.MinitandemI18n?.t('price.notPublished');
    const describe=el=>el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\s+/).slice(0,2).join('.'):'')+' «'+(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,40)+'»';
    for(const el of document.querySelectorAll('body *')){
      const box=el.getBoundingClientRect(),style=getComputedStyle(el);
      if(!box.width||!box.height||style.visibility==='hidden'||el.closest('svg,.sr,.skip,.leaflet-container')||el.clientWidth<=1||!(el.textContent||'').trim())continue;
      if(el.matches('.r-when')||el.matches('.r-price')&&el.textContent.trim()!==phrase)continue;
      const hides=axis=>!['visible','auto','scroll'].includes(axis);
      const wide=(hides(style.overflowX)||style.textOverflow==='ellipsis')&&el.scrollWidth>el.clientWidth+1;
      const tall=(hides(style.overflowY)||(style.webkitLineClamp&&style.webkitLineClamp!=='none'))&&el.scrollHeight>el.clientHeight+1;
      if(wide||tall)out.push(describe(el)+` [${wide?`${el.scrollWidth} > ${el.clientWidth} wide`:''}${wide&&tall?', ':''}${tall?`${el.scrollHeight} > ${el.clientHeight} high`:''}]`);
    }
    // The measure of a placeholder is its text laid out like the field's own: font, letter and word spacing.
    for(const input of document.querySelectorAll('input[placeholder]')){
      if(!input.getBoundingClientRect().width)continue;
      const style=getComputedStyle(input),probe=document.createElement('span');
      probe.style.cssText=`position:absolute;visibility:hidden;white-space:nowrap;font:${style.font};letter-spacing:${style.letterSpacing};word-spacing:${style.wordSpacing}`;
      probe.textContent=input.placeholder;document.body.append(probe);
      const room=input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
      if(probe.getBoundingClientRect().width>room+1)out.push('placeholder «'+input.placeholder+'» of '+describe(input)+` [${Math.ceil(probe.getBoundingClientRect().width)} > ${Math.floor(room)}]`);
      probe.remove();
    }
    if(document.documentElement.scrollWidth>innerWidth)out.push(`the page is wider than the screen [${document.documentElement.scrollWidth} > ${innerWidth}]`);
    return out;
  });
}
// The Lighthouse way to total layout shifts: the worst run of shifts, each less than 1 s after the last, within 5 s.
export function worstShiftWindow(entries){
  let worst=0,total=0,first=0,last=0;
  for(const {startTime,value} of entries){
    if(!total||startTime-last>=1000||startTime-first>=5000){total=0;first=startTime;}
    total+=value;last=startTime;worst=Math.max(worst,total);
  }
  return worst;
}
export function artifactDirectory(check){
  const directory=path.join(root,'editorial/typesafe-runtime/browser-checks',engineName(),check);
  fs.mkdirSync(directory,{recursive:true});
  return directory;
}
export async function serveSite(input=process.env.APP_URL||pathToFileURL(path.join(root,'.publish/index.html')).href){
  if(!input.startsWith('file:'))return {url:input,close:async()=>{}};
  const directory=path.dirname(fileURLToPath(input));
  if(!fs.existsSync(fileURLToPath(input)))throw Error('No built site. Run npm run build first, or set APP_URL.');
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.md':'text/markdown','.jpg':'image/jpeg'};
  const server=http.createServer((request,response)=>{
    let pathname;
    try{pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);}catch{response.writeHead(400).end();return;}
    const asked=path.resolve(directory,'.'+(pathname==='/'?'/index.html':pathname));
    // A folder serves its index.html, like the real server does for /projekt/ and /places/…/.
    const file=fs.existsSync(asked)&&fs.statSync(asked).isDirectory()?path.join(asked,'index.html'):asked;
    const relative=path.relative(directory,file),segments=relative.split(path.sep);
    if(!['GET','HEAD'].includes(request.method)||relative.startsWith('..')||path.isAbsolute(relative)||segments.some(part=>part.startsWith('.'))||
      segments.some((_,index)=>fs.existsSync(path.join(directory,...segments.slice(0,index+1)))&&fs.lstatSync(path.join(directory,...segments.slice(0,index+1))).isSymbolicLink())||
      !fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
    response.end(request.method==='HEAD'?undefined:fs.readFileSync(file));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port+'/',close:()=>new Promise(resolve=>server.close(resolve))};
}
export async function prepareContext(context,url,{date='2026-10-14T08:00:00Z'}={}){
  const errors=[],origin=new URL(url).origin;
  context.on('page',page=>{
    page.setDefaultTimeout(10000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  });
  // Keep timers running while dates and local storage timestamps stay reproducible.
  await context.addInitScript(value=>{
    const OriginalDate=Date,now=OriginalDate.parse(value);
    window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  },date);
  await context.route('**/*',async route=>{
    const request=new URL(route.request().url());
    if(request.origin===origin)return route.continue();
    if(request.hostname==='wmts.geo.admin.ch')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>'});
    errors.push('Unexpected external request: '+request.origin);
    await route.abort('blockedbyclient');
  });
  return errors;
}
