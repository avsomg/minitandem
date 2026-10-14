// Shared by the browser scripts. WebKit does not deliver cross-tab storage events for file: URLs, so a snapshot given as a
// file URL is served from a throw-away local server for the duration of a script.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';

const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.md':'text/markdown','.jpg':'image/jpeg'};
export async function serve(url){
  if(!url.startsWith('file:'))return {url,close:async()=>{}};
  const directory=path.dirname(fileURLToPath(url));
  const server=http.createServer((request,response)=>{
    let pathname;
    try{pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);}catch{response.writeHead(400).end();return;}
    const file=path.resolve(directory,'.'+(pathname==='/'?'/index.html':pathname));
    const segments=path.relative(directory,file).split(path.sep);
    if(!['GET','HEAD'].includes(request.method)||segments.some(part=>part.startsWith('.'))||!file.startsWith(directory+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
    response.end(request.method==='HEAD'?undefined:fs.readFileSync(file));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port+'/',close:()=>new Promise(resolve=>server.close(resolve))};
}
