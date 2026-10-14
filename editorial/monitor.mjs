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
function issue(queue,source,kind,now,details){
  const existing=queue.find(q=>q.sourceId===source.id&&q.kind===kind&&q.status==='open');
  if(existing){existing.lastSeen=now;existing.occurrences++;existing.details=details;return existing;}
  const task={id:`task-${source.id}-${kind}-${sha(now+JSON.stringify(details)).slice(0,10)}`,sourceId:source.id,recordIds:source.recordIds??[],kind,status:'open',firstSeen:now,lastSeen:now,occurrences:1,details};
  queue.push(task);return task;
}
const due=(prior,source,now)=>!prior?.lastAttempt||Date.parse(now)-Date.parse(prior.lastAttempt)>=(source.intervalDays??7)*86400000;
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
export async function runMonitor({sources,state,fetchImpl=fetch,now=new Date().toISOString(),force=false,ids=null,snapshot=async()=>{}}){
  state??={schema:1,sources:{},queue:[]};
  state.sources??={};state.queue??=[];
  const results=[];
  for(const source of sources){
    if(ids&&!ids.has(source.id))continue;
    const prior=state.sources[source.id]??={};
    if(!force&&!due(prior,source,now)){results.push({id:source.id,result:'not-due'});continue;}
    const entry={...prior,lastAttempt:now,attempts:(prior.attempts??0)+1,httpStatus:null};
    state.sources[source.id]=entry;
    try{
      const headers={'user-agent':'MinitandemCatalogMonitor/1.0 (editorial source check; no indexing)','accept':'text/html, text/calendar, application/pdf;q=0.9, */*;q=0.5'};
      // Rolling next-event snapshots change as time passes, even if the feed bytes do not.
      if(entry.hash&&entry.etag&&!source.eventIds?.length)headers['if-none-match']=entry.etag;
      if(entry.hash&&entry.lastModified&&!source.eventIds?.length)headers['if-modified-since']=entry.lastModified;
      const response=await fetchImpl(source.url,{headers,signal:AbortSignal.timeout(source.timeoutMs??12000)});
      entry.httpStatus=response.status;entry.finalUrl=response.url||source.url;
      if(response.status===304){
        if(!entry.hash||!entry.lastSuccess)throw Error('304 without a valid previous source snapshot');
        entry.lastSuccess=now;entry.errorCount=0;entry.error=null;recovered(state.queue,source.id,now);results.push({id:source.id,result:'unchanged-304'});continue;
      }
      if(!response.ok)throw Error(`HTTP ${response.status}`);
      const type=response.headers.get('content-type')??'';
      if(source.type==='pdf'&&!/pdf|octet-stream/i.test(type))throw Error(`unexpected content type: ${type}`);
      if(source.type==='html'&&!/html|text\/plain/i.test(type))throw Error(`unexpected content type: ${type}`);
      if(source.type==='ics'&&!/calendar|text\/plain/i.test(type))throw Error(`unexpected content type: ${type}`);
      const bytes=await responseBytes(response,source.maxBytes??(source.type==='pdf'?6_000_000:2_000_000));
      const raw=source.type==='pdf'?await pdfText(bytes):bytes.toString('utf8');
      const text=normalize(raw,source,now),hash=sha(text);
      const previousHash=entry.hash;
      if(hash!==previousHash){
        await snapshot(source.id,hash,text);
        if(previousHash)issue(state.queue,source,'content-changed',now,{from:previousHash,to:hash,oldVersion:entry.version,newVersion:hash.slice(0,12),url:source.url});
        entry.hash=hash;entry.version=hash.slice(0,12);
      }
      entry.etag=response.headers.get('etag')??null;
      entry.lastModified=response.headers.get('last-modified')??null;
      entry.lastSuccess=now;entry.errorCount=0;entry.error=null;
      recovered(state.queue,source.id,now);
      results.push({id:source.id,result:!previousHash?'baseline':hash===previousHash?'unchanged':'changed',chars:text.length});
    }catch(error){
      entry.errorCount=(entry.errorCount??0)+1;entry.error=String(error.message??error);
      const code=entry.httpStatus;
      const kind=/missing start marker|required marker missing|extracted text too short|unexpected content type|invalid calendar feed|unsupported calendar datetime/.test(entry.error)?'parser-failed':'source-unavailable';
      if(code!==404||entry.errorCount>=2)issue(state.queue,source,kind,now,{error:entry.error,httpStatus:code??null,consecutiveErrors:entry.errorCount,url:source.url});
      results.push({id:source.id,result:'error',error:entry.error});
    }
  }
  state.lastRun=now;
  return {state,results,openTasks:state.queue.filter(q=>q.status==='open').length};
}
async function writeJsonAtomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.tmp-${process.pid}`;await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n');await fs.rename(tmp,file);}
async function cli(){
  const args=process.argv.slice(2),configPath=path.join(here,'source-watch.json'),statePath=path.join(here,'monitor-state.json');
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));
  let state;try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const ids=args.filter(a=>a.startsWith('--id=')).map(a=>a.slice(5));
  const rebaselineIds=args.filter(a=>a.startsWith('--rebaseline=')).map(a=>a.slice(13));
  if(rebaselineIds.length){
    if(ids.length)throw Error('use --rebaseline without --id');
    const known=new Set(config.sources.map(source=>source.id));
    for(const id of rebaselineIds)if(!known.has(id))throw Error(`unknown source: ${id}`);
    rebaseline(state,rebaselineIds,args.find(a=>a.startsWith('--note='))?.slice(7));
  }
  const selected=rebaselineIds.length?new Set(rebaselineIds):ids.length?new Set(ids):null;
  const report=await runMonitor({sources:config.sources,state,force:args.includes('--force')||!!rebaselineIds.length,ids:selected,snapshot:async(id,hash,text)=>{const file=path.join(here,'versions',id,hash.slice(0,12)+'.txt');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text+'\n');}});
  await writeJsonAtomic(statePath,report.state);
  console.log(JSON.stringify({results:report.results,openTasks:report.openTasks,state:statePath},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))cli().catch(error=>{console.error(error);process.exitCode=1;});
