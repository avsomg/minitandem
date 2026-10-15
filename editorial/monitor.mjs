import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {newAlarms,significance,ALARM_PARSER} from './alarm.mjs';
import {writeRecord,hasRecord as hasPageRecord} from './page-record.mjs';
import {compact,htmlTextV1,htmlTextV2,fullPageText,sourceAnchors,hostOf,hostRules,validateHostIgnore,dropIgnored,normalize,decodeBytes,pageAlarms,fullView} from './page-text.mjs';
// The text functions moved to page-text.mjs (the controller's capture uses them too); the names stay importable from here.
export {htmlTextV1,htmlTextV2,fullPageText,sourceAnchors,hostRules,validateHostIgnore,dropIgnored,normalize,decodeBytes};

const here=path.dirname(fileURLToPath(import.meta.url));
const DAY=86400000;
const runFile=promisify(execFile);
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
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
const RANK={low:0,normal:1,high:2};
/** Lines added and removed between two texts (multiset difference, in text order). */
export function lineDiff(oldText,newText){
  const oldLines=String(oldText).split('\n'),newLines=String(newText).split('\n');
  const left=new Map();for(const line of oldLines)left.set(line,(left.get(line)??0)+1);
  const added=[];for(const line of newLines){const n=left.get(line)??0;if(n>0)left.set(line,n-1);else added.push(line);}
  const right=new Map();for(const line of newLines)right.set(line,(right.get(line)??0)+1);
  const removed=[];for(const line of oldLines){const n=right.get(line)??0;if(n>0)right.set(line,n-1);else removed.push(line);}
  return {added:added.filter(Boolean),removed:removed.filter(Boolean)};
}
const readOld=(readVersion,id,version)=>version?Promise.resolve().then(()=>readVersion(id,version)).catch(()=>null):Promise.resolve(null);
// The stored text gets the host rules too: a baseline written before a rule existed still holds the ignored lines.
async function changeDetails(readVersion,id,oldVersion,text,rules=null){
  const old=await readOld(readVersion,id,oldVersion);
  if(old==null)return {significance:'normal'};
  const {added,removed}=lineDiff(dropIgnored(old,rules),text);
  return {significance:significance(added,removed),changedLines:{added:added.slice(0,20),removed:removed.slice(0,20)}};
}
/** Days to move the last attempt back with --spread-days=N: 0..N from the source id, never a full interval. */
export function spreadOffset(id,days,intervalDays=7){
  return Math.min(parseInt(sha(id).slice(0,2),16)%(days+1),Math.max(0,intervalDays-1));
}
const HIGH_REDIRECT=['trashed','not-found','challenge','domain'];
const REPLACEMENT_CHAR=String.fromCodePoint(0xfffd);
export function issue(queue,source,kind,now,details){
  const existing=queue.find(q=>q.sourceId===source.id&&q.kind===kind&&q.status==='open');
  if(kind==='content-changed')details={...details,firstFrom:existing?.details?.firstFrom??existing?.details?.from??details.from,firstOldVersion:existing?.details?.firstOldVersion??existing?.details?.oldVersion??details.oldVersion};
  if(existing){
    // A repeated change keeps the highest significance seen since the first one.
    if(kind==='content-changed'&&RANK[existing.details?.significance]>(RANK[details.significance]??-1))details={...details,significance:existing.details.significance};
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
// A withheld alarm must come back at a later run, so the source keeps what it had before this run for everything that could hide the
// notice: the alarm keys it is compared with, the validators of the page that carried it (else the next request answers 304 and the notice
// is lost for good, a title-only change leaves no content task to rescue it) and, after a good fetch, the attempt time (it is due again;
// a failed fetch keeps its backoff). The hash stays: a content change of the same run was issued, and a repeat would only merge into it.
function holdBack(entry,prior){
  for(const key of ['alarm','alarmHistory','etag','lastModified',...entry.error==null?['lastAttempt']:[]])
    if(key in prior)entry[key]=prior[key];else delete entry[key];
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
/**
 * One monitor pass. Alarm lines (alarm.mjs) are compared on the full page of every HTML and PDF source that was fetched and decoded
 * (not on 304, challenge pages or HTTP errors; still on a parser failure). A first comparison stores the keys and issues nothing.
 * New lines become possible-closure / possible-reopen tasks after the pass: lines new on three or more sources of one host are
 * marked siteWide, and more than `alarmFuse` alarm tasks issue none: those sources are put back for alarm keys, validators and attempt
 * time (see holdBack), so they are due again, their page is read again and not answered with 304, and the alarm is found again.
 * `rebaselineParser:{note}` moves v1 HTML baselines to parser v2: content-changed only where v1 itself sees a change, the alarm
 * keys become a baseline, high redirect classes are issued once. `spreadDays` moves the last attempt back by spreadOffset() days.
 * A run-wide outage fuse covers source-unavailable the way `alarmFuse` covers alarms: when more than `outageFuse` percent of the sources
 * fetched in one run (at least `outageMin` of them) are unavailable, the check broke, not the market (a network down on this Mac). No
 * source-unavailable task is issued, and the failed sources are put back as they were before the run (validators included: a failed
 * fetch never stored new ones), so they are due again next time.
 * `hostIgnore` (see hostRules) applies to the compared text and the alarm lines; when the stored text, with the same rules applied,
 * equals the new text, the hash moves without a task (noted in baselineHistory). A v1 baseline stays on v1 outside the parser pass.
 */
export async function runMonitor({sources,state,fetchImpl=fetch,now=new Date().toISOString(),force=false,ids=null,snapshot=async()=>{},snapshotFailed=async()=>{},record=async()=>{},hasRecord=async()=>true,max=Infinity,hostDelayMs=0,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  records=[],readVersion=async()=>null,rebaselineParser=null,spreadDays=0,alarmFuse=Infinity,outageFuse=Infinity,outageMin=1,hostIgnore={}}){
  state??={schema:1,sources:{},queue:[]};
  state.sources??={};state.queue??=[];
  const results=[],lastRequest=new Map(),pending=[],unavailable=[];let fetched=0;
  for(const source of sources){
    if(ids&&!ids.has(source.id))continue;
    const prior=state.sources[source.id]??={};
    const rebuild=Boolean(rebaselineParser)&&source.type==='html';
    if(rebuild&&prior.parser==='v2'){results.push({id:source.id,result:'already-v2'});continue;}
    if(!force&&!rebuild&&!due(prior,source,now)){results.push({id:source.id,result:'not-due'});continue;}
    if(fetched>=max){results.push({id:source.id,result:'skipped-max'});continue;}
    fetched++;
    const entry={...prior,lastAttempt:now,attempts:(prior.attempts??0)+1,httpStatus:null};
    state.sources[source.id]=entry;
    const parser=!rebuild&&entry.hash&&entry.parser!=='v2'?'v1':'v2';
    const rules=hostRules(hostIgnore,source.url),remove=rules?.selectors??[];
    // Same text once the host rules are applied to the stored version: not a change, only the hash moves.
    const sameAfterIgnore=async(version,text)=>{if(!rules)return false;const old=await readOld(readVersion,source.id,version);return old!=null&&dropIgnored(old,rules)===text;};
    let failedRaw=null,alarmNote=null;
    const succeed=()=>{
      entry.lastSuccess=now;entry.errorCount=0;entry.error=null;entry.nextRetry=null;entry.lastFailedText=null;
      if(spreadDays>0)entry.lastAttempt=new Date(Date.parse(now)-spreadOffset(source.id,spreadDays,source.intervalDays??7)*DAY).toISOString();
      recovered(state.queue,source.id,now);
    };
    try{
      const headers={'user-agent':'MinitandemCatalogMonitor/1.0 (editorial source check; no indexing)','accept':'text/html, text/calendar, application/pdf;q=0.9, */*;q=0.5','accept-language':acceptLanguage(source.url)};
      // Rolling next-event snapshots change as time passes, even if the feed bytes do not. A parser rebaseline needs the full body.
      // A version that has no page record yet is fetched in full once (no validators), so that the record of this fetch can be written.
      const conditional=!rebuild&&entry.hash&&!source.eventIds?.length&&await hasRecord(source.id,entry.version??entry.hash.slice(0,12));
      if(conditional&&entry.etag)headers['if-none-match']=entry.etag;
      if(conditional&&entry.lastModified)headers['if-modified-since']=entry.lastModified;
      const host=(()=>{try{return new URL(source.url).hostname;}catch{return source.url;}})();
      if(hostDelayMs>0&&lastRequest.has(host)){const wait=hostDelayMs-(Date.now()-lastRequest.get(host));if(wait>0)await sleep(wait);}
      lastRequest.set(host,Date.now());
      const response=await fetchImpl(source.url,{headers,signal:AbortSignal.timeout(source.timeoutMs??12000)});
      lastRequest.set(host,Date.now());
      entry.httpStatus=response.status;
      const finalUrl=response.url||source.url;
      if(CHALLENGE_URL.test(finalUrl)&&!CHALLENGE_URL.test(source.url))throw Error('source challenge page');
      const priorFinal=prior.finalUrl??source.url;
      if(response.status===304){
        if(!entry.hash||!entry.lastSuccess)throw Error('304 without a valid previous source snapshot');
        entry.finalUrl=finalUrl;entry.error=null;succeed();results.push({id:source.id,result:'unchanged-304'});continue;
      }
      if(!response.ok)throw Error(`HTTP ${response.status}`);
      const type=response.headers.get('content-type')??'';
      if(source.type==='pdf'&&!/pdf|octet-stream/i.test(type))throw Error(`unexpected content type: ${type}`);
      if(source.type==='html'&&!/html|text\/plain/i.test(type))throw Error(`unexpected content type: ${type}`);
      if(source.type==='ics'&&!/calendar|text\/plain/i.test(type))throw Error(`unexpected content type: ${type}`);
      const bytes=await responseBytes(response,source.maxBytes??(source.type==='pdf'?6_000_000:2_000_000));
      const raw=source.type==='pdf'?await pdfText(bytes):decodeBytes(bytes,type);
      failedRaw=raw;
      if(source.type!=='pdf'&&isChallenge(source.type==='html'?htmlTextV1(raw):raw,''))throw Error('source challenge page');
      // The final URL moves only with a real page: a challenge or error page leaves it, so the recovery raises no redirect.
      entry.finalUrl=finalUrl;
      let redirectNow=null;
      if(normUrl(finalUrl)!==normUrl(priorFinal)){
        redirectNow=redirectClass(priorFinal,finalUrl);
        if(prior.hash||prior.finalUrl)issue(state.queue,source,'redirect-changed',now,{from:priorFinal,to:finalUrl,class:redirectNow,httpStatus:response.status});
      }
      entry.finalUrlNorm=normUrl(finalUrl);
      entry.redirect=normUrl(finalUrl)===normUrl(source.url)?null:{from:source.url,to:finalUrl,class:redirectClass(source.url,finalUrl),at:now};
      const current=pageAlarms(raw,source,{now,rules,records});
      // The record of this fetch (provenance, full view, alarm lines, raw bytes of an HTML page). A failure to write it never fails the pass.
      const keep=async(hash,parserUsed)=>{
        try{
          await record(source.id,{version:hash.slice(0,12),hash,fetchedAt:now,finalUrl,contentType:type,status:response.status,parser:parserUsed,
            rawHash:sha(bytes),rawBytes:bytes.length,raw:source.type==='html'?bytes:null,full:fullView(raw,source.type),alarm:(current??[]).map(line=>line.text)});
          return null;
        }catch(error){return String(error.message??error);}
      };
      if(rebuild){
        let textV1=null,v1Error=null;
        try{textV1=normalize(raw,source,now,'v1',rules);}catch(error){v1Error=String(error.message??error);}
        const textV2=normalize(raw,source,now,'v2',rules),hashV2=sha(textV2);
        const languageSwitch=redirectNow==='language'||entry.redirect?.class==='language';
        const row={id:source.id,result:'rebaselined',chars:{v1:textV1?.length??0,v2:textV2.length},v1Changed:false,significance:null,redirect:entry.redirect?.class??null,alarmKeys:0,
          encodingErrors:raw.split(REPLACEMENT_CHAR).length-1};
        if(v1Error)row.v1Error=v1Error;
        if(prior.hash){
          const hashV1=textV1==null?null:sha(textV1);
          if(hashV1!==prior.hash&&!(textV1!=null&&await sameAfterIgnore(prior.version,textV1))){
            row.v1Changed=true;
            let details;
            if(textV1!=null){
              await snapshot(source.id,hashV1,textV1);
              details={from:prior.hash,to:hashV1,oldVersion:prior.version,newVersion:hashV1.slice(0,12),url:source.url,parser:'v1',...await changeDetails(readVersion,source.id,prior.version,textV1,rules)};
            }else details={from:prior.hash,to:hashV2,oldVersion:prior.version,newVersion:hashV2.slice(0,12),url:source.url,parser:'v1',v1Error,significance:'normal'};
            if(languageSwitch){details.languageSwitch=true;details.significance='low';}
            row.significance=details.significance;
            issue(state.queue,source,'content-changed',now,details);
          }
          entry.baselineHistory=[...(prior.baselineHistory??[]),{at:now,hash:prior.hash,version:prior.version,note:rebaselineParser.note.trim(),parser:'v1'}];
        }
        await snapshot(source.id,hashV2,textV2);
        entry.hash=hashV2;entry.version=hashV2.slice(0,12);entry.parser='v2';
        const rebuildRecordError=await keep(hashV2,'v2');if(rebuildRecordError)row.recordError=rebuildRecordError;
        if(current){const base=newAlarms(null,current,prior.alarmHistory,now);entry.alarm={keys:base.keys,at:now,parser:ALARM_PARSER};entry.alarmHistory=base.history;row.alarmKeys=base.keys.length;}
        if(entry.redirect&&HIGH_REDIRECT.includes(entry.redirect.class)&&!state.queue.some(q=>q.sourceId===source.id&&q.kind==='redirect-changed'&&q.status==='open'))
          issue(state.queue,source,'redirect-changed',now,{from:source.url,to:finalUrl,class:entry.redirect.class,httpStatus:response.status});
        entry.etag=response.headers.get('etag')??null;entry.lastModified=response.headers.get('last-modified')??null;
        succeed();results.push(row);continue;
      }
      if(current){
        const compared=newAlarms(prior.alarm?.keys,current,prior.alarmHistory,now);
        entry.alarm={keys:compared.keys,at:now,parser:ALARM_PARSER};entry.alarmHistory=compared.history;
        if(compared.baseline)alarmNote='baseline';
        else{
          const strip=({index,...line})=>line,reopenOnly=line=>line.cats.every(cat=>cat==='reopen');
          for(const [kind,lines] of [['possible-closure',compared.added.filter(line=>!reopenOnly(line))],['possible-reopen',compared.added.filter(reopenOnly)]])
            if(lines.length)pending.push({source,kind,lines:lines.map(strip),finalUrl,entry,prior});
          if(compared.added.length||compared.muted.length)alarmNote={added:compared.added.length,muted:compared.muted.map(line=>line.key)};
        }
      }
      const text=normalize(raw,source,now,parser,rules),hash=sha(text);
      const previousHash=entry.hash;
      let ignoredOnly=false;
      if(hash!==previousHash){
        await snapshot(source.id,hash,text);
        if(previousHash&&await sameAfterIgnore(entry.version,text)){
          ignoredOnly=true;
          entry.baselineHistory=[...(entry.baselineHistory??[]),{at:now,hash:previousHash,version:entry.version,note:'host ignore rules applied to the stored text',parser}];
        }else if(previousHash){
          const details={from:previousHash,to:hash,oldVersion:entry.version,newVersion:hash.slice(0,12),url:source.url,parser,...await changeDetails(readVersion,source.id,entry.version,text,rules)};
          if(redirectNow==='language'){details.languageSwitch=true;details.significance='low';}
          issue(state.queue,source,'content-changed',now,details);
        }else if(source.type==='html')entry.parser='v2';
        entry.hash=hash;entry.version=hash.slice(0,12);
      }
      entry.etag=response.headers.get('etag')??null;
      entry.lastModified=response.headers.get('last-modified')??null;
      const recordError=await keep(hash,parser);
      succeed();
      results.push({id:source.id,result:!previousHash?'baseline':hash===previousHash||ignoredOnly?'unchanged':'changed',chars:text.length,...(alarmNote?{alarm:alarmNote}:{}),...(recordError?{recordError}:{})});
    }catch(error){
      entry.errorCount=(entry.errorCount??0)+1;entry.error=String(error.message??error);
      const code=entry.httpStatus;
      const kind=/missing start marker|required marker missing|extracted text too short|unexpected content type|invalid calendar feed|unsupported calendar datetime/.test(entry.error)?'parser-failed':'source-unavailable';
      if(kind==='parser-failed'&&failedRaw!=null){
        const failed=compact(source.type==='html'?(parser==='v1'?htmlTextV1(failedRaw):htmlTextV2(failedRaw,{remove})):failedRaw);
        if(failed){const label='failed-'+sha(failed).slice(0,12);await snapshotFailed(source.id,label,failed);entry.lastFailedText=label;}
      }
      entry.nextRetry=new Date(Date.parse(now)+Math.min(source.intervalDays??7,2**Math.min(entry.errorCount-1,20))*DAY).toISOString();
      const details={error:entry.error,httpStatus:code??null,consecutiveErrors:entry.errorCount,url:source.url},open=code!==404||entry.errorCount>=2;
      const row={id:source.id,result:'error',error:entry.error,...(alarmNote?{alarm:alarmNote}:{})};
      results.push(row);
      // An unavailable source is judged after the pass, once it is known how many others failed with it.
      if(kind==='source-unavailable')unavailable.push({source,prior,entry,details,open,row});
      else if(open)issue(state.queue,source,kind,now,details);
    }
  }
  // Site-wide rollup: the same new line on three or more sources of one host in this run.
  const byHostKey=new Map();
  for(const item of pending)for(const line of item.lines){
    const id=`${hostOf(item.source.url)}\n${line.key}`;
    if(!byHostKey.has(id))byHostKey.set(id,{host:hostOf(item.source.url),key:line.key,sourceIds:[]});
    const roll=byHostKey.get(id);if(!roll.sourceIds.includes(item.source.id))roll.sourceIds.push(item.source.id);
  }
  const siteWide=[...byHostKey.values()].filter(roll=>roll.sourceIds.length>=3);
  for(const item of pending){
    const rolls=siteWide.filter(roll=>roll.sourceIds.includes(item.source.id)&&item.lines.some(line=>line.key===roll.key));
    if(rolls.length)item.siteWide={host:rolls[0].host,sourceIds:[...new Set(rolls.flatMap(roll=>roll.sourceIds))],keys:rolls.map(roll=>roll.key)};
  }
  const fuse={tripped:pending.length>alarmFuse,limit:alarmFuse,count:pending.length};
  if(fuse.tripped){
    fuse.alarms=pending.map(item=>({sourceId:item.source.id,kind:item.kind,lines:item.lines.map(line=>line.text)}));
    for(const item of pending){
      holdBack(item.entry,item.prior);
      const row=results.find(result=>result.id===item.source.id);if(row)row.withheld='alarm-fuse';
    }
  }else for(const item of pending)issue(state.queue,item.source,item.kind,now,{url:item.source.url,finalUrl:item.finalUrl,parser:ALARM_PARSER,lines:item.lines,...(item.siteWide?{siteWide:item.siteWide}:{})});
  const share=fetched?Math.round(unavailable.length/fetched*1000)/10:0;
  const outage={tripped:fetched>=outageMin&&unavailable.length*100>fetched*outageFuse,limit:outageFuse,min:outageMin,fetched,failed:unavailable.length,share};
  if(outage.tripped){
    outage.sources=unavailable.map(({source,entry})=>({sourceId:source.id,error:entry.error,httpStatus:entry.httpStatus}));
    for(const item of unavailable){state.sources[item.source.id]=item.prior;item.row.withheld='outage-fuse';}
  }else for(const item of unavailable)if(item.open)issue(state.queue,item.source,'source-unavailable',now,item.details);
  state.lastRun=now;
  return {state,results,openTasks:state.queue.filter(q=>q.status==='open').length,fuse,outageFuse:outage,siteWide};
}
async function writeJsonAtomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.tmp-${process.pid}`;await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n');await fs.rename(tmp,file);}
const flag=(args,name)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
export async function main(args,baseDir=here,{records}={}){
  const configPath=path.join(baseDir,'source-watch.json'),statePath=flag(args,'state')?path.resolve(flag(args,'state')):path.join(baseDir,'monitor-state.json');
  const dryRun=args.includes('--dry-run');
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));
  validateHostIgnore(config.hostIgnore);
  let state;try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const ids=args.filter(a=>a.startsWith('--id=')).map(a=>a.slice(5));
  const rebaselineIds=args.filter(a=>a.startsWith('--rebaseline=')).map(a=>a.slice(13));
  const parserArg=args.find(a=>a==='--rebaseline-parser'||a.startsWith('--rebaseline-parser='));
  let rebaselineParser=null,parserIds=null;
  if(parserArg){
    if(ids.length)throw Error('use --rebaseline-parser without --id');
    if(rebaselineIds.length)throw Error('use --rebaseline-parser without --rebaseline');
    const note=flag(args,'note');
    if(!note?.trim())throw Error('a parser rebaseline requires --note');
    const value=parserArg.includes('=')?parserArg.slice(parserArg.indexOf('=')+1):'all-html';
    const byId=new Map(config.sources.map(source=>[source.id,source]));
    if(value==='all-html')parserIds=new Set(config.sources.filter(source=>source.type==='html').map(source=>source.id));
    else{
      parserIds=new Set(value.split(',').map(id=>id.trim()).filter(Boolean));
      for(const id of parserIds){if(!byId.has(id))throw Error(`unknown source: ${id}`);if(byId.get(id).type!=='html')throw Error(`not an HTML source: ${id}`);}
    }
    rebaselineParser={note};
  }
  const max=flag(args,'max')===undefined?Infinity:Number(flag(args,'max'));
  if(!(max>=0))throw Error('--max must be a non-negative number');
  const hostDelayMs=flag(args,'host-delay-ms')===undefined?1200:Number(flag(args,'host-delay-ms'));
  if(!(hostDelayMs>=0))throw Error('--host-delay-ms must be a non-negative number');
  const spreadDays=flag(args,'spread-days')===undefined?0:Number(flag(args,'spread-days'));
  if(!(Number.isInteger(spreadDays)&&spreadDays>=0))throw Error('--spread-days must be a non-negative integer');
  const alarmFuse=flag(args,'alarm-fuse')===undefined?15:Number(flag(args,'alarm-fuse'));
  if(!(alarmFuse>=0))throw Error('--alarm-fuse must be a non-negative number');
  const outageFuse=flag(args,'outage-fuse')===undefined?20:Number(flag(args,'outage-fuse'));
  if(!(outageFuse>=0))throw Error('--outage-fuse must be a non-negative number (percent of fetched sources)');
  const outageMin=flag(args,'outage-min')===undefined?10:Number(flag(args,'outage-min'));
  if(!(outageMin>=1))throw Error('--outage-min must be a number of sources, at least 1');
  if(rebaselineIds.length){
    if(ids.length)throw Error('use --rebaseline without --id');
    const known=new Set(config.sources.map(source=>source.id));
    for(const id of rebaselineIds)if(!known.has(id))throw Error(`unknown source: ${id}`);
    rebaseline(state,rebaselineIds,flag(args,'note'));
  }
  const selected=rebaselineIds.length?new Set(rebaselineIds):parserIds??(ids.length?new Set(ids):null);
  // Card names and towns anchor alarm lines in long documents; the catalogue is read only for the project's own source list.
  records??=baseDir===here?(await import('./quality.mjs')).loadCatalog().ACTIVITIES:[];
  const write=async(id,name,text)=>{if(dryRun)return;const file=path.join(baseDir,'versions',id,name+'.txt');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text+'\n');};
  const readVersion=async(id,version)=>{try{return (await fs.readFile(path.join(baseDir,'versions',id,version+'.txt'),'utf8')).replace(/\n$/,'');}catch{return null;}};
  const now=new Date().toISOString();
  const report=await runMonitor({sources:config.sources,state,now,force:args.includes('--force')||!!rebaselineIds.length,ids:selected,max,hostDelayMs,records,readVersion,rebaselineParser,spreadDays,alarmFuse,outageFuse,outageMin,hostIgnore:config.hostIgnore??{},
    snapshot:(id,hash,text)=>write(id,hash.slice(0,12),text),snapshotFailed:(id,label,text)=>write(id,label,text),
    record:async(id,info)=>{if(!dryRun)await writeRecord(baseDir,id,info);},hasRecord:(id,version)=>hasPageRecord(baseDir,id,version)});
  if(!dryRun)await writeJsonAtomic(statePath,report.state);
  const out={results:report.results,openTasks:report.openTasks,state:statePath};
  if(report.siteWide.length)out.siteWide=report.siteWide;
  if(report.fuse.tripped){out.fuse=report.fuse;out.exitCode=2;}
  if(report.outageFuse.tripped){out.outageFuse=report.outageFuse;out.exitCode=2;}
  if(dryRun){out.dryRun=true;out.wouldIssue=report.state.queue.filter(q=>q.status==='open'&&q.lastSeen===now).map(q=>({sourceId:q.sourceId,kind:q.kind}));}
  return out;
}
async function cli(){
  const out=await main(process.argv.slice(2));
  console.log(JSON.stringify(out,null,2));
  if(out.fuse?.tripped){console.error(`alarm fuse: ${out.fuse.count} alarm tasks exceed --alarm-fuse=${out.fuse.limit}; none were issued (listed under "fuse"); those sources stay due and are read again at the next run, so raise the limit or fix the cause and run again.`);process.exitCode=2;}
  if(out.outageFuse?.tripped){console.error(`outage fuse: ${out.outageFuse.failed} of ${out.outageFuse.fetched} fetched sources were unavailable (${out.outageFuse.share} %, limit --outage-fuse=${out.outageFuse.limit} %); no source-unavailable task was issued and those sources stay due (listed under "outageFuse").`);process.exitCode=2;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))cli().catch(error=>{console.error(error);process.exitCode=1;});
