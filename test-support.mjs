// Shared by the unit tests: loads the real interface modules into a fake browser (no DOM) so that logic, markup builders,
// storage and exports can be tested against the real English catalogue. Not a test file itself.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {SCRIPTS} from './ui-files.mjs';

export const root=path.dirname(fileURLToPath(import.meta.url));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
// Modules that need no DOM and are not data layers, in load order.
const LOGIC=['planning.js','exchange.js','storage-migration.js','catalogue.js','catalogue-i18n.js','format.js','store.js','sync.js','exports.js','views.js','toast.js'];

export function fakeStorage(initial={}){
  const map=new Map(Object.entries(initial).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)]));
  let blocked=false;
  return {map,getItem:k=>map.has(k)?map.get(k):null,
    setItem:(k,v)=>{if(blocked)throw new DOMException('Quota','QuotaExceededError');map.set(k,String(v));},
    removeItem:k=>{map.delete(k);},blockWrites:value=>{blocked=value;},read:k=>JSON.parse(map.get(k))};
}
// today and nowHm fix the clock the catalogue sees; lang is the interface language; local and session are initial storage contents.
export function loadStack({today='2026-10-14',nowHm='10:00',lang='en',local={},session={},browserLanguages=null}={}){
  const localStorage=fakeStorage(local),sessionStorage=fakeStorage(session);
  const window={};
  const context={window,structuredClone,URL,URLSearchParams,Intl,Date,TextEncoder,localStorage,sessionStorage,location:{hash:'',hostname:'localhost',origin:'http://localhost:8787',href:'http://localhost:8787/'},
    navigator:{languages:browserLanguages||[lang],language:lang,onLine:true},DOMException,crypto:globalThis.crypto,setTimeout:()=>0,clearTimeout:()=>{}};
  window.window=window;
  vm.createContext(context);
  const run=file=>vm.runInContext(read(file),context,{filename:file});
  for(const file of ['strings-en.js','strings-de.js','strings-fr.js','i18n.js','data.js','data-reviewed.js','data-practical.js','regions.js','data-geo.js','data-towns.js'])run(file);
  for(const file of LOGIC)run(file);
  const W=window,I=W.MinitandemI18n,P=W.MinitandemPlanning,X=W.MinitandemExchange,K=W.MinitandemCatalogue;
  I.setLang(lang,{persist:false});
  const t=I.t;
  const C=K.create({activities:W.ACTIVITIES,venues:W.ACTIVITY_VENUES||[],regions:W.CATALOG_REGIONS,towns:W.CATALOG_TOWNS,coverage:W.CATALOG_COVERAGE,planning:P,clock:{today:()=>today,nowHm:()=>nowHm},t});
  const F=W.MinitandemFormat.create({t,locale:I.locale});
  const store=W.MinitandemStore.create({storage:localStorage,byId:C.byId,P,today:C.today,statusKeys:K.PERSONAL_KEYS,canonicalId:K.canonicalId});
  // The same state object the page keeps; tests change it directly.
  const state={view:'catalog',venueId:'',sharedIds:[],f:K.defaultFilters(),limit:24,openId:null,outingDate:today,near:null,nearStatus:'',weekOpen:new Set()};
  const V=W.MinitandemViews.create({t,C,P,X,F,store,state:()=>state});
  const EX=W.MinitandemExports.create({t,lang:I.lang,P,byId:C.byId,regions:W.CATALOG_REGIONS,today:C.today,format:F});
  return {window:W,context,I,t,P,X,K,C,F,store,V,EX,state,localStorage,sessionStorage,records:W.ACTIVITIES,byId:C.byId,regions:W.CATALOG_REGIONS,
    // the filtered list the page would show for the current state
    list:(extra={})=>C.filter(state.f,{age:store.personal.age,view:state.view,personal:store.personal,venueId:state.venueId,sharedIds:state.sharedIds,near:state.near,...extra})};
}
export const scripts=SCRIPTS;
