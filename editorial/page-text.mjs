// One text step for every reader of a page. The source monitor (change text, alarm lines), the controller's capture (the visible body that
// quotes are taken from) and the stored copies all call the functions here, so the same bytes give the same texts wherever they are read.
// Pure: no files, no network, no clock (callers pass `now`). monitor.mjs and evidence.mjs re-export what their callers imported before.
import {load} from 'cheerio';
import {alarmLines} from './alarm.mjs';

export const compact=text=>text.replace(/\u00a0/g,' ').replace(/[\t ]+/g,' ').replace(/\s*\n\s*/g,'\n').replace(/\n{2,}/g,'\n').trim();
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',eacute:'é',auml:'ä',ouml:'ö',uuml:'ü'};
function decode(text){return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(_,key)=>key[0]==='#'?String.fromCodePoint(key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10)):entities[key.toLowerCase()]??`&${key};`);}
// The first extractor (regex, main or body, header and footer dropped). Kept for v1 baselines and the --rebaseline-parser comparison.
export function htmlTextV1(html){
  let value=html.replace(/<(script|style|noscript|svg|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
  const main=value.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
  if(main)value=main[1];
  else value=value.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1]??value;
  value=value.replace(/<\/(?:p|div|section|article|h[1-6]|li|tr|br)\s*>/gi,'\n').replace(/<br\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,' ');
  return compact(decode(value));
}
const BLOCK_TAGS='p,div,section,article,aside,header,footer,main,nav,h1,h2,h3,h4,h5,h6,li,ul,ol,dl,dt,dd,tr,table,thead,tbody,tfoot,form,fieldset,blockquote,pre,address,figure,figcaption,details,summary,caption';
function markBlocks($){
  $('br,hr').replaceWith('\n');
  $(BLOCK_TAGS).each((_,node)=>{$(node).prepend('\n').append('\n');});
  $('td,th,a,button,label,option').each((_,node)=>{$(node).append(' ');});
}
// Opening hours and closing days that sites put in the page header or footer (Club Cafe: "Montag Ruhetag").
const HOURS_LINE=/\b\d{1,2}[.:h]\d{2}\b|(?<![\p{L}])(?:montags?|dienstags?|mittwochs?|donnerstags?|freitags?|samstags?|sonntags?|lundis?|mardis?|mercredis?|jeudis?|vendredis?|samedis?|dimanches?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|ruhetage?|geschlossen|geöffnet|fermée?s?|ouverte?s?|closed|open)(?![\p{L}])|(?<![\p{L}])(?:mo|di|mi|do|fr|sa|so|lu|ma|me|je|ve|mon|tue|wed|thu|fri|sat|sun)(?=\s*[.:–-]|\s+\d)/iu;
const PAGE_CHROME='body>header,body>footer,[role=banner],[role=contentinfo]';
/**
 * Parser v2 (cheerio): page-level header and footer are dropped after their opening-hours lines are kept; all <main> elements are
 * used unless they hold less than a quarter of the remaining body text (then the whole body); entities are decoded by cheerio.
 */
export function htmlTextV2(html,{remove=[]}={}){
  const $=load(String(html));
  $('script,style,noscript,svg,template,iframe,nav').remove();
  if(remove.length)$(remove.join(',')).remove();
  markBlocks($);
  const candidates=$(`${PAGE_CHROME},header,footer`).toArray().filter(el=>$(el).is(PAGE_CHROME)||!$(el).closest('main,article').length);
  const set=new Set(candidates),chrome=candidates.filter(el=>!$(el).parents().toArray().some(parent=>set.has(parent)));
  const harvested=[];
  for(const el of chrome)for(const line of compact($(el).text()).split('\n'))if(line.length<=120&&HOURS_LINE.test(line)&&!harvested.includes(line))harvested.push(line);
  for(const el of chrome)$(el).remove();
  const bodyText=compact($('body').text());
  const mains=$('main').toArray().filter(el=>!$(el).parents('main').length);
  const mainText=compact(mains.map(el=>$(el).text()).join('\n'));
  const text=mains.length&&mainText.length>=bodyText.length*0.25?mainText:bodyText;
  const kept=new Set(text.split('\n'));
  return compact([text,...harvested.filter(line=>!kept.has(line))].join('\n'));
}
/** The whole visible page for alarm lines: title, meta description and the body with header, navigation and footer. */
export function fullPageText(html,{remove=[]}={}){
  const $=load(String(html));
  const title=$('head>title').first().text()||$('title').first().text();
  const description=$('meta').filter((_,el)=>String($(el).attr('name')??'').toLowerCase()==='description').first().attr('content')??'';
  $('script,style,noscript,svg,template,iframe').remove();
  if(remove.length)$(remove.join(',')).remove();
  markBlocks($);
  return compact([title,description,$('body').text()].join('\n'));
}
/**
 * Anchors for long documents, in the source's own language: required markers, the card name before " · " (and its parts around
 * "/" or "–"), the town, and organiser labels of the card's sources ("Tierhappy · organiser"). The English description is left out.
 */
export function sourceAnchors(source,records=[]){
  const byId=new Map(records.map(record=>[record.id,record])),out=[];
  const add=value=>{value=String(value??'').trim();if(value.length>=3&&!out.includes(value))out.push(value);};
  for(const term of source.required??[])add(term);
  for(const id of source.recordIds??[]){
    const record=byId.get(id);if(!record)continue;
    const name=String(record.name??'').split(' · ')[0];
    add(name);
    const parts=name.split(/\s*[/–]\s*/);if(parts.length>1)for(const part of parts)if(part.length>=4)add(part);
    add(record.town);
    for(const item of record.sources??[])if(String(item.label??'').includes(' · '))add(item.label.split(' · ')[0]);
  }
  return out;
}
export function calendarText(value,source={},now=new Date().toISOString()){
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
export const hostOf=url=>{try{return new URL(url).hostname.toLowerCase().replace(/^www\./,'');}catch{return String(url);}};
function compileRule(key,rule){
  try{
    if(!rule||typeof rule!=='object'||Array.isArray(rule))throw Error('a rule must be an object');
    const list=(value,name)=>{
      if(value==null)return [];
      if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!item.trim()))throw Error(`${name} must be a list of non-empty strings`);
      return value;
    };
    if(rule.ranges!=null&&!Array.isArray(rule.ranges))throw Error('ranges must be a list');
    const ranges=(rule.ranges??[]).map(range=>{
      if(typeof range?.from!=='string'||typeof range?.to!=='string'||!range.from||!range.to)throw Error('a range needs a "from" and a "to" pattern');
      return {from:new RegExp(range.from),to:new RegExp(range.to)};
    });
    const selectors=list(rule.selectors,'selectors');
    if(selectors.length)load('<p></p>')(selectors.join(','));
    return {selectors,ranges,lines:list(rule.lines,'lines').map(value=>new RegExp(value))};
  }catch(error){throw Error(`hostIgnore ${key}: ${error.message??error}`);}
}
/**
 * Host rules from `hostIgnore` in source-watch.json: `{host:{selectors:[css],ranges:[{from,to}],lines:[regex]}}`, the host without
 * "www.". Selectors remove page blocks before parser v2 and before the alarm lines; ranges (first line matching `from` to the next
 * line matching `to`, both included; nothing when `to` is missing) and line patterns drop lines from the text of both parsers.
 */
export function hostRules(hostIgnore,url){
  const host=hostOf(url);
  const entry=Object.entries(hostIgnore??{}).find(([key])=>key.toLowerCase().replace(/^www\./,'')===host);
  return entry?compileRule(...entry):null;
}
export function validateHostIgnore(hostIgnore){
  if(hostIgnore==null)return;
  if(typeof hostIgnore!=='object'||Array.isArray(hostIgnore))throw Error('hostIgnore must be an object keyed by host');
  for(const [key,rule] of Object.entries(hostIgnore))compileRule(key,rule);
}
export function dropIgnored(text,rules){
  if(!rules||!rules.ranges.length&&!rules.lines.length)return text;
  const lines=String(text).split('\n'),keep=[];
  for(let i=0;i<lines.length;i++){
    const range=rules.ranges.find(rule=>rule.from.test(lines[i]));
    if(range){const end=lines.findIndex((line,j)=>j>i&&range.to.test(line));if(end>i){i=end;continue;}}
    if(!rules.lines.some(pattern=>pattern.test(lines[i])))keep.push(lines[i]);
  }
  return keep.join('\n');
}
export function normalize(value,source,now,parser='v2',rules=null){
  let text=source.type==='html'?(parser==='v1'?htmlTextV1(value):htmlTextV2(value,{remove:rules?.selectors??[]})):source.type==='ics'?calendarText(value,source,now):compact(value);
  if(source.start){const index=text.indexOf(source.start);if(index<0)throw Error(`missing start marker: ${source.start}`);text=text.slice(index);}
  if(source.end){const index=text.indexOf(source.end);if(index>=0)text=text.slice(0,index);}
  text=compact(text);
  if(source.ignoreLines?.length){const patterns=source.ignoreLines.map(value=>new RegExp(value));text=text.split('\n').filter(line=>!patterns.some(pattern=>pattern.test(line))).join('\n');}
  text=dropIgnored(text,rules);
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

// ---------------------------------------------------------------- the views of one fetch
/** The visible body of a page, navigation dropped: the text the controller's capture (cheerio-visible-body-v1) quotes from. */
export function bodyText(html){
  const $=load(String(html));
  $('script,style,noscript,svg,nav,template').remove();
  const body=$('body');
  body.find('br').replaceWith('\n');
  body.find('p,div,section,article,h1,h2,h3,h4,h5,h6,li,tr,td,th').each((_,node)=>$(node).append('\n'));
  return compact(body.text());
}
/** The parser ids of the full view by source type: the ones a controller capture of the same page carries. */
export const FULL_PARSERS={html:'cheerio-visible-body-v1',pdf:'pdftotext-layout-v1',ics:'calendar-raw-v1'};
/** The full view of a decoded page: what a controller capture of the same bytes holds. Null for a type without one. */
export function fullView(raw,type){
  const parser=FULL_PARSERS[type];
  if(!parser)return null;
  return {parser,text:type==='html'?bodyText(raw):String(raw).trim()};
}
/** The whole page for the alarm lines (HTML: title, description, body with header, navigation and footer; PDF: its text); null for a calendar. */
export function alarmSource(raw,source,rules=null){
  return source.type==='html'?dropIgnored(fullPageText(raw,{remove:rules?.selectors??[]}),rules):source.type==='pdf'?dropIgnored(raw,rules):null;
}
/** The alarm lines of a page as the monitor sees them (objects, see alarm.mjs), or null for a calendar. */
export function pageAlarms(raw,source,{now,rules=null,records=[]}={}){
  const text=alarmSource(raw,source,rules);
  return text==null?null:alarmLines(text,{now,ignore:[...(source.ignoreLines??[]),...(source.alarmIgnore??[])],anchors:sourceAnchors(source,records)});
}
const squash=line=>line.replace(/\s+/g,' ').trim();
/** The monitor's view: the change text and, after it, each alarm line it does not hold yet. A quote from either part is found in it. */
export function viewText(watch,alarm=[]){
  const held=new Set(watch.split('\n').map(squash));
  const extra=[];
  for(const line of alarm.map(squash))if(line&&!held.has(line)&&!extra.includes(line))extra.push(line);
  return extra.length?compact(watch+'\n'+extra.join('\n')):watch;
}
/**
 * The monitor's view of one fetch, built the way the monitor builds it: `watch` is what it hashes and compares (parser v2, v1 for a v1
 * baseline), `alarm` the texts of the alarm lines, `text` the two together. Throws what normalize throws (marker missing, too short).
 */
export function monitorView(raw,source,{now,rules=null,parser='v2',records=[]}={}){
  const watch=normalize(raw,source,now,parser,rules);
  const alarm=(pageAlarms(raw,source,{now,rules,records})??[]).map(line=>line.text);
  return {watch,alarm,text:viewText(watch,alarm)};
}
