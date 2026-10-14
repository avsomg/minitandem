import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import {SITE_ORIGIN} from './site.mjs';
import {SCRIPTS,LAZY_SCRIPTS,LAZY_ASSETS} from './ui-files.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const origin=SITE_ORIGIN;

function worker({existing=[]}={}){
  const handlers={},stored=new Map(),calls=[],deleted=[];
  let offline=false;
  const caches={
    open:async()=>({addAll:async paths=>{for(const path of paths)stored.set(path,{body:'precache:'+path,ok:true});},put:async(request,response)=>{stored.set(new URL(request.url).pathname,response);}}),
    keys:async()=>existing,delete:async key=>{deleted.push(key);return true;},
    match:async request=>stored.get(typeof request==='string'?request:new URL(request.url).pathname)
  };
  const self={location:{origin},clients:{claim:async()=>{}},skipWaiting:async()=>{},addEventListener:(name,handler)=>{handlers[name]=handler;}};
  const fetch=async request=>{calls.push(request.url);if(offline)throw Error('offline');return {ok:true,body:'fresh:'+request.url,clone(){return this;}};};
  const context={self,caches,fetch,URL,Promise,Response:{error:()=>({type:'error'})}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'sw.js'),'utf8')+';this.CACHE_NAME=CACHE;',context);
  return {handlers,stored,calls,deleted,cacheName:context.CACHE_NAME,setOffline:value=>{offline=value;}};
}

test('offline shell contains only published files and installable icons',async()=>{
  const {handlers,stored}=worker();
  let work;handlers.install({waitUntil:promise=>{work=promise;}});await work;
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.webmanifest'),'utf8'));
  for(const icon of manifest.icons){assert.ok(stored.has(icon.src),icon.src);}
  assert.ok(stored.has('/assets/apple-touch-icon.png'));
  for(const pathname of stored.keys())assert.ok(fs.existsSync(path.join(root,'.publish',pathname==='/'?'index.html':pathname.slice(1))),pathname+' is not in the built site');
  assert.equal([...stored.keys()].some(pathname=>pathname.startsWith('/api/')),false);
});

test('the shell is exactly the page, its styles, manifest, every script and the map files; the card texts of a language are not in it',async()=>{
  const {handlers,stored}=worker();
  let work;handlers.install({waitUntil:promise=>{work=promise;}});await work;
  const expected=new Set(['/','/index.html','/styles.css','/manifest.webmanifest',...SCRIPTS.map(f=>'/'+f),'/assets/favicon.svg','/assets/icon-512.png','/assets/apple-touch-icon.png',...LAZY_ASSETS.map(f=>'/assets/'+f)]);
  assert.deepEqual([...stored.keys()].sort(),[...expected].sort());
});

test('the cache has the new name and every cache of an earlier version is removed on activation',async()=>{
  const {handlers,deleted,cacheName}=worker({existing:['earlier-version-cache','minitandem-shell-2026-01-01-1','another-name']});
  assert.match(cacheName,/^minitandem-shell-/);
  let work;handlers.activate({waitUntil:promise=>{work=promise;}});await work;
  assert.deepEqual(deleted.sort(),['another-name','earlier-version-cache','minitandem-shell-2026-01-01-1']);
  const current=worker({existing:[cacheName]});
  current.handlers.activate({waitUntil:promise=>{work=promise;}});await work;
  assert.deepEqual(current.deleted,[],'the current cache is kept');
});

test('a language’s card texts are cached the first time they load and served offline from then on; never loaded, they fail offline',async()=>{
  const {handlers,stored,setOffline}=worker();
  let work;handlers.install({waitUntil:promise=>{work=promise;}});await work;
  for(const file of LAZY_SCRIPTS)assert.equal(stored.has('/'+file),false,file+' is not precached');
  const fetchOf=async file=>{let response,write;handlers.fetch({request:{method:'GET',url:origin+'/'+file},respondWith:promise=>{response=promise;},waitUntil:promise=>{write=promise;}});const result=await response;await write;return result;};
  assert.equal((await fetchOf('data-de.js')).body,'fresh:'+origin+'/data-de.js');
  assert.equal(stored.has('/data-de.js'),true,'cached after the first load');
  setOffline(true);
  assert.equal((await fetchOf('data-de.js')).body,'fresh:'+origin+'/data-de.js','offline: the cached copy');
  let response;handlers.fetch({request:{method:'GET',url:origin+'/data-fr.js'},respondWith:promise=>{response=promise;},waitUntil:()=>{}});
  assert.equal((await response).type,'error','offline and never loaded: a network error, not the page');
});

test('same-origin shell is refreshed online and served offline, API is never intercepted',async()=>{
  const {handlers,stored,calls,setOffline}=worker();
  let work;handlers.install({waitUntil:promise=>{work=promise;}});await work;
  const request={method:'GET',url:origin+'/app.js'};
  let response,cacheWrite;
  handlers.fetch({request,respondWith:promise=>{response=promise;},waitUntil:promise=>{cacheWrite=promise;}});
  assert.equal((await response).body,'fresh:'+origin+'/app.js');
  await cacheWrite;
  assert.equal(stored.get('/app.js').body,'fresh:'+origin+'/app.js');
  setOffline(true);
  handlers.fetch({request,respondWith:promise=>{response=promise;},waitUntil:()=>{}});
  assert.equal((await response).body,'fresh:'+origin+'/app.js');
  assert.equal(calls.length,2);
  let intercepted=false;
  handlers.fetch({request:{method:'GET',url:origin+'/api/v1/family'},respondWith:()=>{intercepted=true;},waitUntil:()=>{}});
  assert.equal(intercepted,false);
  handlers.fetch({request:{method:'GET',url:'https://elsewhere.example/app.js'},respondWith:()=>{intercepted=true;},waitUntil:()=>{}});
  assert.equal(intercepted,false,'other origins are not intercepted');
});
