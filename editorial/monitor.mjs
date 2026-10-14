import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const runFile=promisify(execFile);
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const compact=text=>text.replace(/\u00a0/g,' ').replace(/[\t ]+/g,' ').replace(/\s*\n\s*/g,'\n').replace(/\n{2,}/g,'\n').trim();
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',eacute:'é',auml:'ä',ouml:'ö',uuml:'ü'};
function decode(text){return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(_,key)=>key[0]==='#'?String.fromCodePoint(key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10)):entities[key.toLowerCase()]??`&${key};`);}
function htmlText(html){
  let value=html.replace(/<(script|style|noscript|svg|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
  const main=value.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
  if(main)value=main[1];
  else value=value.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1]??value;
  value=value.replace(/<\/(?:p|div|section|article|h[1-6]|li|tr|br)\s*>/gi,'\n').replace(/<br\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,' ');
  return compact(decode(value));
}
function calendarText(value,source={},now=new Date().toISOString()){
  const unfolded=value.replace(/\r?\n[ \t]/g,'').split(/\r?\n/);
  const significant=/^(BEGIN:VEVENT|END:VEVENT|UID|SUMMARY|DESCRIPTION|LOCATION|DTSTART|DTEND|STATUS|RRULE|EXDATE)(;[^:]*)?:/i;
  if(source.eventIds?.length){
    if(!unfolded.includes('BEGIN:VCALENDAR')||!unfolded.includes('BEGIN:VEVENT')||source.calendarName&&!unfolded.includes('X-WR-CALNAME:'+source.calendarName))throw Error('invalid calendar feed');
    const blocks=[...value.replace(/\r?\n[ \t]/g,'').matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)].map(match=>match[1].split(/\r?\n/));
    const instant=line=>{
      const stamp=line?.split(':').slice(1).join(':');
      const match=stamp?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if(!match)throw Error('unsupported calendar datetime');
      return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
    };
    return source.eventIds.map(id=>{
      const matches=blocks.filter(lines=>lines.some(line=>line.startsWith('URL:https://tockify.com/educationfamiliale/detail/'+id+'/')));
      const future=matches.map(lines=>({lines,start:instant(lines.find(line=>line.startsWith('DTSTART'))),end:instant(lines.find(line=>line.startsWith('DTEND')))})).filter(event=>event.end>Date.parse(now)).sort((a,b)=>a.start-b.start);
      if(!future.length)return `EVENT_ID:${id}\nNO_FUTURE_EVENT`;
      return [`EVENT_ID:${id}`,...future[0].lines.filter(line=>/^(SUMMARY|DESCRIPTION|LOCATION|DTSTART|DTEND|STATUS|URL)(;[^:]*)?:/i.test(line))].join('\n');
    }).join('\n');
  }
  return unfolded.filter(line=>significant.test(line)).map(line=>line.trim()).join('\n');
}
export function normalize(value,source,now){
  let text=source.type==='html'?htmlText(value):source.type==='ics'?calendarText(value,source,now):compact(value);
  if(source.start){const index=text.indexOf(source.start);if(index<0)throw Error(`missing start marker: ${source.start}`);text=text.slice(index);}
  if(source.end){const index=text.indexOf(source.end);if(index>=0)text=text.slice(0,index);}
  text=compact(text);
  if(source.ignoreLines?.length){const patterns=source.ignoreLines.map(value=>new RegExp(value));text=text.split('\n').filter(line=>!patterns.some(pattern=>pattern.test(line))).join('\n');}
  if(text.length<(source.minChars??40))throw Error(`extracted text too short (${text.length} chars)`);
  for(const term of source.required??[])if(!text.includes(term))throw Error(`required marker missing: ${term}`);
  return text;
}
const CP1252_C1=[...'\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178'];
export function decodeBytes(bytes,contentType=''){
  const buffer=Buffer.from(bytes);
  const label=value=>{try{return new TextDecoder(String(value).trim().toLowerCase()).encoding;}catch{return null;}};
  const declared=label(/charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1]??'')
    ??label(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(buffer.subarray(0,4096).toString('latin1'))?.[1]??'');
  for(const encoding of [declared??'utf-8','utf-8']){
    try{return new TextDecoder(encoding,{fatal:true}).decode(buffer);}catch{}
    if(declared)break;
  }
  // Some Node builds decode windows-1252 as latin-1; map the C1 range explicitly.
  return new TextDecoder('windows-1252').decode(buffer).replace(/[\u0080-\u009f]/g,char=>CP1252_C1[char.charCodeAt(0)-0x80]);
}
export function acceptLanguage(url){
  const segment=/^\/(de|fr)(?:-ch)?(?=\/|$)/i.exec((()=>{try{return new URL(url).pathname;}catch{return '';}})())?.[1]?.toLowerCase();
  if(segment==='de')return 'de-CH,de;q=0.9,fr;q=0.5';
  if(segment==='fr')return 'fr-CH,fr;q=0.9,de;q=0.5';
  return 'de-CH,de;q=0.9,fr-CH,fr;q=0.8';
}
export function normUrl(value){
  try{const url=new URL(value);return url.hostname.toLowerCase().replace(/^www\./,'')+url.pathname.replace(/\/+$/,'')+url.search;}
  catch{return String(value??'').trim().toLowerCase();}
}
const CHALLENGE_URL=/js_challenge|cf-chl|captcha|challenge/i;
export function redirectClass(from,to){
  const parse=value=>{try{return new URL(value);}catch{return null;}};
  const a=parse(from),b=parse(to);
  if(!a||!b)return 'path';
  if(/__trashed/i.test(b.pathname))return 'trashed';
  if(/\/404(?:\/|\.|$)/i.test(b.pathname))return 'not-found';
  if(CHALLENGE_URL.test(b.href))return 'challenge';
  const host=url=>url.hostname.toLowerCase().replace(/^www\./,'');
  if(host(a)!==host(b))return 'domain';
  const lang=url=>/\/(de|fr|en|it)(?:-ch)?(?=\/|$)/i.exec(url.pathname)?.[1]?.toLowerCase()??null;
  if(lang(a)!==lang(b))return 'language';
  return 'path';
}
export function isChallenge(text,finalUrl=''){
  return CHALLENGE_URL.test(finalUrl)||/^(just a moment|access denied|verify you are human)/i.test(String(text).trim())||/checking your browser|enable javascript and cookies/i.test(text);
}
async function responseBytes(response,maxBytes){
  const declared=Number(response.headers.get('content-length'));
  if(declared>maxBytes)throw Error(`body too large (${declared} bytes)`);
  const reader=response.body?.getReader();
  if(!reader){const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>maxBytes)throw Error('body too large');return buffer;}
  const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw Error('body too large');chunks.push(value);}}finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}
async function pdfText(bytes){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-source-'));
  try{const input=path.join(temp,'source.pdf');await fs.writeFile(input,bytes);const {stdout}=await runFile('pdftotext',['-layout','-enc','UTF-8',input,'-'],{maxBuffer:8_000_000});return stdout;}
  finally{await fs.rm(temp,{recursive:true,force:true});}
}
export function issue(queue,source,kind,now,details){
  const existing=queue.find(q=>q.sourceId===source.id&&q.kind===kind&&q.status==='open');
  if(kind==='content-changed')details={...details,firstFrom:existing?.details?.firstFrom??existing?.details?.from??details.from,firstOldVersion:existing?.details?.firstOldVersion??existing?.details?.oldVersion??details.oldVersion};
  if(existing){
    if(Array.isArray(existing.details?.lines)&&Array.isArray(details.lines)){
      const seen=new Set(existing.details.lines.map(line=>line.key));
      details={...details,lines:[...existing.details.lines,...details.lines.filter(line=>!seen.has(line.key))]};
    }
    existing.lastSeen=now;existing.occurrences++;existing.details=details;return existing;
  }
  const task={id:`task-${source.id}-${kind}-${sha(now+JSON.stringify(details)).slice(0,10)}`,sourceId:source.id,recordIds:source.recordIds??[],kind,status:'open',firstSeen:now,lastSeen:now,occurrences:1,details};
  queue.push(task);return task;
}
export function due(prior,source,now){
  if(!prior?.lastAttempt)return true;
  const interval=source.intervalDays??7;
  const days=prior.errorCount>0?Math.min(interval,2**Math.min(prior.errorCount-1,20)):interval;
  return Date.parse(now)-Date.parse(prior.lastAttempt)>=days*86400000;
}
function recovered(queue,sourceId,now){
  for(const task of queue)if(task.sourceId===sourceId&&task.status==='open'&&['source-unavailable','parser-failed'].includes(task.kind)){
    task.status='resolved';task.resolvedAt=now;task.resolution='Source fetched and parsed successfully; this does not verify catalogue facts.';
  }
}
export function rebaseline(state,ids,note,now=new Date().toISOString()){
  if(!note?.trim())throw Error('a rebaseline requires --note');
  for(const id of ids){
    const entry=state.sources?.[id];
    if(!entry?.hash)throw Error(`no baseline for source: ${id}`);
    (entry.baselineHistory??=[]).push({at:now,hash:entry.hash,version:entry.version,note:note.trim()});
    delete entry.hash;delete entry.version;delete entry.etag;delete entry.lastModified;
  }
}
export async function runMonitor({sources,state,fetchImpl=fetch,now=new Date().toISOString(),force=false,ids=null,snapshot=async()=>{},snapshotFailed=async()=>{},max=Infinity,hostDelayMs=0,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  state??={schema:1,sources:{},queue:[]};
  state.sources??={};state.queue??=[];
  const results=[],lastRequest=new Map();let fetched=0;
  for(const source of sources){
    if(ids&&!ids.has(source.id))continue;
    const prior=state.sources[source.id]??={};
    if(!force&&!due(prior,source,now)){results.push({id:source.id,result:'not-due'});continue;}
    if(fetched>=max){results.push({id:source.id,result:'skipped-max'});continue;}
    fetched++;
    const entry={...prior,lastAttempt:now,attempts:(prior.attempts??0)+1,httpStatus:null};
    state.sources[source.id]=entry;
    let failedRaw=null;
    try{
      const headers={'user-agent':'MinitandemCatalogMonitor/1.0 (editorial source check; no indexing)','accept':'text/html, text/calendar, application/pdf;q=0.9, */*;q=0.5','accept-language':acceptLanguage(source.url)};
      // Rolling next-event snapshots change as time passes, even if the feed bytes do not.
      if(entry.hash&&entry.etag&&!source.eventIds?.length)headers['if-none-match']=entry.etag;
      if(entry.hash&&entry.lastModified&&!source.eventIds?.length)headers['if-modified-since']=entry.lastModified;
      const host=(()=>{try{return new URL(source.url).hostname;}catch{return source.url;}})();
      if(hostDelayMs>0&&lastRequest.has(host)){const wait=hostDelayMs-(Date.now()-lastRequest.get(host));if(wait>0)await sleep(wait);}
      lastRequest.set(host,Date.now());
      const response=await fetchImpl(source.url,{headers,signal:AbortSignal.timeout(source.timeoutMs??12000)});
      lastRequest.set(host,Date.now());
      entry.httpStatus=response.status;
      const finalUrl=response.url||source.url;
      if(CHALLENGE_URL.test(finalUrl)&&!CHALLENGE_URL.test(source.url))throw Error('source challenge page');
      const priorFinal=prior.finalUrl??source.url;
      entry.finalUrl=finalUrl;
      if(response.status===304){
        if(!entry.hash||!entry.lastSuccess)throw Error('304 without a valid previous source snapshot');
        entry.lastSuccess=now;entry.errorCount=0;entry.error=null;recovered(state.queue,source.id,now);results.push({id:source.id,result:'unchanged-304'});continue;
      }
      if(!response.ok)throw Error(`HTTP ${response.status}`);
      const type=response.headers.get('content-type')??'';
      if(source.type==='pdf'&&!/pdf|octet-stream/i.test(type))throw Error(`unexpected content type: ${type}`);
      if(source.type==='html'&&!/html|text\/plain/i.test(type))throw Error(`unexpected content type: ${type}`);
      if(source.type==='ics'&&!/calendar|text\/plain/i.test(type))throw Error(`unexpected content type: ${type}`);
      if(normUrl(finalUrl)!==normUrl(priorFinal)){
        const klass=redirectClass(priorFinal,finalUrl);
        if(prior.hash||prior.finalUrl)issue(state.queue,source,'redirect-changed',now,{from:priorFinal,to:finalUrl,class:klass,httpStatus:response.status});
      }
      entry.finalUrlNorm=normUrl(finalUrl);
      entry.redirect=normUrl(finalUrl)===normUrl(source.url)?null:{from:source.url,to:finalUrl,class:redirectClass(source.url,finalUrl),at:now};
      const bytes=await responseBytes(response,source.maxBytes??(source.type==='pdf'?6_000_000:2_000_000));
      const raw=source.type==='pdf'?await pdfText(bytes):decodeBytes(bytes,type);
      failedRaw=raw;
      if(source.type!=='pdf'&&isChallenge(source.type==='html'?htmlText(raw):raw,''))throw Error('source challenge page');
      const text=normalize(raw,source,now),hash=sha(text);
      const previousHash=entry.hash;
      if(hash!==previousHash){
        await snapshot(source.id,hash,text);
        if(previousHash)issue(state.queue,source,'content-changed',now,{from:previousHash,to:hash,oldVersion:entry.version,newVersion:hash.slice(0,12),url:source.url});
        entry.hash=hash;entry.version=hash.slice(0,12);
      }
      entry.etag=response.headers.get('etag')??null;
      entry.lastModified=response.headers.get('last-modified')??null;
      entry.lastSuccess=now;entry.errorCount=0;entry.error=null;entry.nextRetry=null;entry.lastFailedText=null;
      recovered(state.queue,source.id,now);
      results.push({id:source.id,result:!previousHash?'baseline':hash===previousHash?'unchanged':'changed',chars:text.length});
    }catch(error){
      entry.errorCount=(entry.errorCount??0)+1;entry.error=String(error.message??error);
      const code=entry.httpStatus;
      const kind=/missing start marker|required marker missing|extracted text too short|unexpected content type|invalid calendar feed|unsupported calendar datetime/.test(entry.error)?'parser-failed':'source-unavailable';
      if(kind==='parser-failed'&&failedRaw!=null){
        const failed=compact(source.type==='html'?htmlText(failedRaw):failedRaw);
        if(failed){const label='failed-'+sha(failed).slice(0,12);await snapshotFailed(source.id,label,failed);entry.lastFailedText=label;}
      }
      entry.nextRetry=new Date(Date.parse(now)+Math.min(source.intervalDays??7,2**Math.min(entry.errorCount-1,20))*86400000).toISOString();
      if(code!==404||entry.errorCount>=2)issue(state.queue,source,kind,now,{error:entry.error,httpStatus:code??null,consecutiveErrors:entry.errorCount,url:source.url});
      results.push({id:source.id,result:'error',error:entry.error});
    }
  }
  state.lastRun=now;
  return {state,results,openTasks:state.queue.filter(q=>q.status==='open').length};
}
async function writeJsonAtomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.tmp-${process.pid}`;await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n');await fs.rename(tmp,file);}
const flag=(args,name)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
export async function main(args,baseDir=here){
  const configPath=path.join(baseDir,'source-watch.json'),statePath=flag(args,'state')?path.resolve(flag(args,'state')):path.join(baseDir,'monitor-state.json');
  const dryRun=args.includes('--dry-run');
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));
  let state;try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const ids=args.filter(a=>a.startsWith('--id=')).map(a=>a.slice(5));
  const rebaselineIds=args.filter(a=>a.startsWith('--rebaseline=')).map(a=>a.slice(13));
  if(rebaselineIds.length){
    if(ids.length)throw Error('use --rebaseline without --id');
    const known=new Set(config.sources.map(source=>source.id));
    for(const id of rebaselineIds)if(!known.has(id))throw Error(`unknown source: ${id}`);
    rebaseline(state,rebaselineIds,flag(args,'note'));
  }
  const selected=rebaselineIds.length?new Set(rebaselineIds):ids.length?new Set(ids):null;
  const max=flag(args,'max')===undefined?Infinity:Number(flag(args,'max'));
  if(!(max>=0))throw Error('--max must be a non-negative number');
  const hostDelayMs=flag(args,'host-delay-ms')===undefined?1200:Number(flag(args,'host-delay-ms'));
  if(!(hostDelayMs>=0))throw Error('--host-delay-ms must be a non-negative number');
  const write=async(id,name,text)=>{if(dryRun)return;const file=path.join(baseDir,'versions',id,name+'.txt');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text+'\n');};
  const now=new Date().toISOString();
  const report=await runMonitor({sources:config.sources,state,now,force:args.includes('--force')||!!rebaselineIds.length,ids:selected,max,hostDelayMs,
    snapshot:(id,hash,text)=>write(id,hash.slice(0,12),text),snapshotFailed:(id,label,text)=>write(id,label,text)});
  if(!dryRun)await writeJsonAtomic(statePath,report.state);
  const out={results:report.results,openTasks:report.openTasks,state:statePath};
  if(dryRun){out.dryRun=true;out.wouldIssue=report.state.queue.filter(q=>q.status==='open'&&q.lastSeen===now).map(q=>({sourceId:q.sourceId,kind:q.kind}));}
  return out;
}
async function cli(){console.log(JSON.stringify(await main(process.argv.slice(2)),null,2));}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))cli().catch(error=>{console.error(error);process.exitCode=1;});
