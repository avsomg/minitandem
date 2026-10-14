import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {load} from 'cheerio';
import {IMAGE_BYTES,recognizeImage,validateImage,saveImage} from './image-evidence.mjs';
import {curlResponse} from './source-fetch.mjs';
import {PROJECT_ID} from './project-id.mjs';

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

export function htmlText(bytes){
  const $=load(bytes.toString('utf8'));
  $('script,style,noscript,svg,nav,template').remove();
  const body=$('body');
  body.find('br').replaceWith('\n');
  body.find('p,div,section,article,h1,h2,h3,h4,h5,h6,li,tr,td,th').each((_,node)=>$(node).append('\n'));
  return body.text().replace(/\u00a0/g,' ').replace(/[\t ]+/g,' ').replace(/\s*\n\s*/g,'\n').trim();
}

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

export async function captureUrl(url,{now=new Date().toISOString(),fetchImpl=fetch,lookupImpl=lookup,type='html',required=[],timeoutMs=15000,maxBytes=2_000_000,ocrImpl=recognizeImage,pdfImpl=pdfText,fallbackImpl=curlResponse}={}){
  url=publicUrl(url);let destination=url;
  for(let redirects=0;redirects<=4;redirects++){
    const addresses=await lookupImpl(new URL(destination).hostname,{all:true});
    if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw Error('Source resolves to a non-public address');
    let response,method='node-fetch';
    try{response=await fetchImpl(destination,{redirect:'manual',signal:AbortSignal.timeout(timeoutMs),
      headers:{'user-agent':'MinitandemEvidence/1.0 (editorial verification)','accept':'text/html, text/plain, text/calendar, application/pdf;q=0.9, image/png;q=0.8, image/jpeg;q=0.8'}});}
    catch(error){
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
    const text=recognized?recognized.text:pdf?await pdfImpl(bytes):/html/i.test(contentType)?htmlText(bytes):bytes.toString('utf8').trim();
    if(required.some(marker=>!normalizeQuote(text).includes(normalizeQuote(marker))))throw Error('Source identity marker missing');
    if(/^(just a moment|access denied|verify you are human)/i.test(text.trim()))throw Error('Source access challenge');
    const result=snapshot({url,finalUrl:destination,fetchedAt:now,contentType,image:recognized?.image,
      parser:image?'tesseract-eng-poster-v1':pdf?'pdftotext-layout-v1':calendar?'calendar-raw-v1':/html/i.test(contentType)?'cheerio-visible-body-v1':'plain-text-v1',text,rawHash:hash(bytes)});
    if(image)Object.defineProperty(result,IMAGE_BYTES,{value:bytes});
    result.captureMethod=method;
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

export async function monitorSnapshot(source,entry,editorial){
  if(!entry?.hash||!entry.lastSuccess)return null;
  const text=(await fs.readFile(path.join(editorial,'versions',source.id,entry.hash.slice(0,12)+'.txt'),'utf8')).replace(/\n$/,'');
  if(hash(text)!==entry.hash)throw Error('Monitor snapshot hash mismatch');
  return snapshot({url:source.url,finalUrl:entry.finalUrl||source.url,fetchedAt:entry.lastSuccess,parser:entry.parser==='v2'?'monitor-text-v2':'monitor-text-v1',text});
}
