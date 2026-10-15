import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {IMAGE_BYTES,recognizeImage,validateImage,saveImage} from './image-evidence.mjs';
import https from 'node:https';
import {curlResponse,pinnedResponse} from './source-fetch.mjs';
import {PROJECT_ID} from './project-id.mjs';
import {decodeBytes,bodyText,monitorView,viewText,hostRules} from './page-text.mjs';
import {readRecord} from './page-record.mjs';

const runFile=promisify(execFile);
export const MAX_PDF_BYTES=20_000_000;
export const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
export const normalizeQuote=value=>String(value).normalize('NFC').replace(/\s+/gu,' ').trim();
export const validInstant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value);

export function publicUrl(value){
  const url=new URL(value);
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||
    net.isIP(host.replace(/^\[|\]$/g,''))||!host.includes('.')||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)||host.endsWith('.'))throw Error('Non-public source URL');
  url.hash='';
  return url.href;
}

function publicAddress(address){
  if(net.isIP(address)===6)return /^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:db8:/i.test(address);
  if(net.isIP(address)!==4)return false;
  const [a,b]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||
    a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19,51].includes(b)||a===203&&b===0);
}

export async function writeJsonAtomic(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try{await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);}
  finally{await fs.rm(temp,{force:true});}
}

// The visible body of a page (the shared step of page-text.mjs); bytes are decoded the way the monitor decodes them.
export const htmlText=(bytes,contentType='')=>bodyText(typeof bytes==='string'?bytes:decodeBytes(bytes,contentType));

async function pdfText(bytes){
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-evidence-'));
  try{
    const file=path.join(folder,'source.pdf');await fs.writeFile(file,bytes);
    const {stdout}=await runFile('pdftotext',['-layout','-enc','UTF-8',file,'-'],{maxBuffer:8_000_000,timeout:20000});
    return stdout.trim();
  }finally{await fs.rm(folder,{recursive:true,force:true});}
}

async function readBytes(response,maxBytes){
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw Error('Source exceeds byte limit');}
  const reader=response.body?.getReader();
  if(!reader){const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>maxBytes)throw Error('Source exceeds byte limit');return bytes;}
  const chunks=[];let size=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>maxBytes){await reader.cancel();throw Error('Source exceeds byte limit');}chunks.push(value);}
  }finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}

export function snapshot({url,finalUrl=url,fetchedAt,contentType='text/plain',parser='monitor-text-v1',text,rawHash=null,image=null}){
  url=publicUrl(url);finalUrl=publicUrl(finalUrl);
  if(!validInstant(fetchedAt)||typeof text!=='string'||text.trim().length<20)throw Error('Invalid evidence snapshot');
  const textHash=hash(text);
  if(image){validateImage(image,rawHash);if(parser!=='tesseract-eng-poster-v1')throw Error('Invalid image parser');}
  return {schema:1,project:PROJECT_ID,id:hash(JSON.stringify([url,finalUrl,fetchedAt,parser,textHash,...(image?[image]:[])])),
    url,finalUrl,fetchedAt,contentType,parser,textHash,rawHash,text,...(image?{image}:{})};
}

export function validateSnapshot(value){
  if(value?.schema!==1||value.project!==PROJECT_ID||value.textHash!==hash(value.text??''))throw Error('Invalid evidence hash or project');
  const expected=snapshot(value);
  if(value.id!==expected.id)throw Error('Invalid evidence identity');
  return value;
}

export function locateQuote(evidence,quote){
  validateSnapshot(evidence);
  const needle=normalizeQuote(quote),haystack=normalizeQuote(evidence.text);
  if(!needle)return null;
  const offset=haystack.indexOf(needle);
  return offset<0?null:{offset,length:needle.length,quote:needle};
}

export function evidenceProblem(evidence,now,maxAgeDays){
  try{validateSnapshot(evidence);}catch{return 'invalid-evidence';}
  const age=Date.parse(now)-Date.parse(evidence.fetchedAt);
  if(!Number.isFinite(age)||age<0)return 'future-evidence';
  return age>maxAgeDays*86400000?'stale-evidence':null;
}

// The other views of a capture, kept beside it and not part of it: the monitor's view of the very same bytes (the change text of parser v2 and
// the alarm lines it does not hold), for a page the source monitor watches. `watch` is {source, hostIgnore, records} of source-watch.json.
// A view is a snapshot of its own with the capture's fetchedAt, finalUrl and rawHash; the caller saves and registers it like the capture
// (capturedSet). Pages the monitor would not accept (wrong content type, marker missing, too short) have none, and so do identical texts.
export const VIEWS=Symbol('views');
export const capturedViews=evidence=>evidence?.[VIEWS]??[];
export const capturedSet=evidence=>[evidence,...capturedViews(evidence)];
const WATCH_TYPES={html:/html|text\/plain/i,pdf:/pdf|octet-stream/i,ics:/calendar|text\/plain/i};
function monitorViews(watch,{raw,text,contentType,url,finalUrl,now,rawHash}){
  const source=watch?.source;
  if(!source||!WATCH_TYPES[source.type]?.test(contentType))return [];
  try{
    const view=monitorView(raw,source,{now,rules:hostRules(watch.hostIgnore,source.url),records:watch.records??[]});
    if(normalizeQuote(view.text)===normalizeQuote(text))return [];
    return [snapshot({url,finalUrl,fetchedAt:now,contentType,parser:'monitor-view-v2',text:view.text,rawHash})];
  }catch{return [];}
}

// With the default fetchImpl the connection is pinned to the addresses checked here (see pinnedResponse): the name is not resolved a second time.
// A fetchImpl that is passed in (tests, demo) is the caller's own transport and is used as given.
export async function captureUrl(url,{now=new Date().toISOString(),fetchImpl=fetch,lookupImpl=lookup,requestImpl=https.request,type='html',required=[],timeoutMs=15000,maxBytes=2_000_000,ocrImpl=recognizeImage,pdfImpl=pdfText,fallbackImpl=curlResponse,watch=null}={}){
  url=publicUrl(url);let destination=url;
  for(let redirects=0;redirects<=4;redirects++){
    const addresses=await lookupImpl(new URL(destination).hostname,{all:true});
    if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw Error('Source resolves to a non-public address');
    let response,method=fetchImpl===fetch?'node-pinned-https':'node-fetch';
    const headers={'user-agent':'MinitandemEvidence/1.0 (editorial verification)','accept':'text/html, text/plain, text/calendar, application/pdf;q=0.9, image/png;q=0.8, image/jpeg;q=0.8'};
    try{
      const signal=AbortSignal.timeout(timeoutMs);
      response=fetchImpl===fetch?await pinnedResponse(destination,addresses,{headers,signal,request:requestImpl}):await fetchImpl(destination,{redirect:'manual',signal,headers});
    }catch(error){
      if(fetchImpl!==fetch)throw error;
      ({response,method}=await fallbackImpl(destination,addresses,{timeoutMs,maxBytes:Math.max(maxBytes,MAX_PDF_BYTES)}));
    }
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)throw Error('Redirect without location');
      destination=publicUrl(new URL(location,destination).href);continue;
    }
    if(!response.ok){await response.body?.cancel();throw Error(`Source HTTP ${response.status}`);}
    const contentType=response.headers.get('content-type')||'';
    const pdf=/application\/pdf/i.test(contentType)||type==='pdf'&&/octet-stream/i.test(contentType);
    const calendar=/text\/calendar/i.test(contentType)||type==='ics'&&/text\/plain/i.test(contentType);
    const image=/^image\/(png|jpeg)(?:;|$)/i.test(contentType);
    if(!pdf&&!calendar&&!image&&!/text\/(html|plain)|application\/xhtml\+xml/i.test(contentType)){
      await response.body?.cancel();throw Error('Unsupported source content type');
    }
    const bytes=await readBytes(response,pdf?MAX_PDF_BYTES:maxBytes);
    const recognized=image?await ocrImpl(bytes,contentType):null;
    const decoded=recognized||pdf?null:decodeBytes(bytes,contentType);
    const text=recognized?recognized.text:pdf?await pdfImpl(bytes):/html/i.test(contentType)?bodyText(decoded):decoded.trim();
    if(required.some(marker=>!normalizeQuote(text).includes(normalizeQuote(marker))))throw Error('Source identity marker missing');
    if(/^(just a moment|access denied|verify you are human)/i.test(text.trim()))throw Error('Source access challenge');
    const result=snapshot({url,finalUrl:destination,fetchedAt:now,contentType,image:recognized?.image,
      parser:image?'tesseract-eng-poster-v1':pdf?'pdftotext-layout-v1':calendar?'calendar-raw-v1':/html/i.test(contentType)?'cheerio-visible-body-v1':'plain-text-v1',text,rawHash:hash(bytes)});
    if(image)Object.defineProperty(result,IMAGE_BYTES,{value:bytes});
    result.captureMethod=method;
    const views=image?[]:monitorViews(watch,{raw:pdf?text:decoded,text,contentType,url,finalUrl:destination,now,rawHash:hash(bytes)});
    if(views.length)Object.defineProperty(result,VIEWS,{value:views});
    return result;
  }
  throw Error('Too many source redirects');
}

export async function saveSnapshot(directory,evidence){
  validateSnapshot(evidence);
  if(evidence.image)await saveImage(directory,evidence);
  const file=path.join(directory,'snapshots',evidence.id+'.json');
  await fs.mkdir(path.dirname(file),{recursive:true});
  try{await fs.writeFile(file,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST')throw error;const existing=JSON.parse(await fs.readFile(file,'utf8'));validateSnapshot(existing);}
  return file;
}

// The monitor's stored copy as a snapshot. It is a copy, never a binding: nothing registers it, so assertCaptured refuses it.
export async function monitorSnapshot(source,entry,editorial){
  if(!entry?.hash||!entry.lastSuccess)return null;
  const text=(await fs.readFile(path.join(editorial,'versions',source.id,entry.hash.slice(0,12)+'.txt'),'utf8')).replace(/\n$/,'');
  if(hash(text)!==entry.hash)throw Error('Monitor snapshot hash mismatch');
  return snapshot({url:source.url,finalUrl:entry.finalUrl||source.url,fetchedAt:entry.lastSuccess,parser:entry.parser==='v2'?'monitor-text-v2':'monitor-text-v1',text});
}

/**
 * Every stored text of the monitor's latest version of a page, as snapshots with the provenance of the fetch that made them:
 * `watch` (the change text), `view` (the change text and its alarm lines, what a controller capture registers as monitor-view-v2) and
 * `full` (the visible body a controller capture of the same bytes holds). `view` and `full` exist when the page record does (fetches
 * made since the record was introduced). Like monitorSnapshot these are copies: they are never registered and never bindings.
 */
export async function monitorRecord(source,entry,editorial){
  const watch=await monitorSnapshot(source,entry,editorial);
  if(!watch)return null;
  const record=await readRecord(editorial,source.id,entry.hash.slice(0,12));
  if(!record||record.meta.hash!==entry.hash)return {watch,view:null,full:null,meta:null};
  const {meta}=record,common={url:source.url,finalUrl:meta.finalUrl||source.url,fetchedAt:meta.fetchedAt,contentType:meta.contentType||'text/plain',rawHash:meta.rawHash};
  const make=(parser,text)=>{try{return snapshot({...common,parser,text});}catch{return null;}};
  const text=viewText(watch.text,meta.alarm);
  return {watch,meta,view:text===watch.text?null:make(meta.viewParser,text),full:record.full==null?null:make(meta.full.parser,record.full)};
}
