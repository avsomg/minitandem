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
