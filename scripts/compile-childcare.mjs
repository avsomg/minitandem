// The places and commune rules of the Daycare tab. Reads the private childcare folder (the canton's open list of preschool places,
// the facts collected per place and per commune, and the independent second reading of them) and writes data-childcare.js.
// Published: a fact only when the second reading confirmed it; never a held fact, never a place with a top-level hold, never notes,
// problems or quotes. The website is the only contact. A fact with a value but without a confirmed verdict stops the script, and so does
// a published text with an e-mail address or a phone number: a person has to look at it first. A verdict counts only for the fact as it
// was read: a fact that a dated note says was quoted anew after the second reading ("21 Oct 2026: price now quoted from the recognised
// scan ...") needs a new reading. Notes are read for that alone and never written out. The folder is never named in the output.
// --leave-out-unconfirmed: instead of stopping, leave such facts out and list them (in the output as "pending", without their values),
// for a preview while the second reading is still to come.
// German and French: <folder>/translations/de.json and fr.json ({id: {en_digest, text}}, the digest being sha256 of the English text) become
// data-childcare-de.js and data-childcare-fr.js, which the tab loads with the interface language. Only translations of the current English
// are written; a text without one is shown in English. --export-texts <file> writes every published English text with its id and a context
// ({id, en, context}) for the translators instead, and changes nothing in the repository.
// Usage: node scripts/compile-childcare.mjs <folder> [--leave-out-unconfirmed] [--export-texts <file>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const OUTPUT='data-childcare.js';
export const LANGS=['de','fr'];
export const textsFile=lang=>`data-childcare-${lang}.js`;
export const TYPES=['creche','garderie','family-day-care','playgroup','nature-playgroup','maternelle'];
// The fields a published value may have, per fact. Anything else in a value stops the script, so that a new field is looked at before it is published.
export const PLACE_FACTS={ageFrom:['months','weeks','text'],ageTo:['years','text'],days:null,hours:['text','opensAt','closesAt'],closures:['text'],languages:null,
  pedagogy:['montessori','nature','bilingual','text'],subsidised:['value','text'],price:['kind','text','minChf','maxChf','unit','validFrom'],meals:['text'],
  registration:['via','text'],availability:['text','statedOn'],settlingIn:['text'],trialPeriod:['text']};
export const COMMUNE_FACTS={registration:['text'],registrationFrom:['text'],renewal:['text'],residency:['text'],registrationFee:['text'],
  tariff:['text','minChf','maxChf','unit','validFrom'],calculator:['url','text'],subsidisedPlaces:['names'],privateSupport:['text']};
const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE=/(?:\+41|\b0)[ \u00a0]?[0-9]{2}[ \u00a0]?[0-9]{3}[ \u00a0]?[0-9]{2}[ \u00a0]?[0-9]{2}\b/;
const WEB_ADDRESS=/\bhttps?:\/\/\S+/g;
// A social network page is not the place's own website.
const SOCIAL=/(?:^|\.)(?:facebook|instagram|tiktok|twitter|x|linkedin|youtube)\.com$/i;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const https=url=>{try{const u=new URL(url);return u.protocol==='https:'?u:null;}catch{return null;}};

// Every text a published value carries must be free of contact details and Cyrillic; web addresses are left out of the phone check.
function checkText(text,where){
  if(EMAIL.test(text))throw Error(`${where}: an e-mail address in a published text`);
  if(PHONE.test(text.replace(WEB_ADDRESS,' ')))throw Error(`${where}: a phone number in a published text`);
  if(/[\u0400-\u04FF]/.test(text))throw Error(`${where}: Cyrillic in a published text`);
}
function cleanValue(value,fields,where){
  if(fields===null){
    if(!Array.isArray(value)||!value.every(item=>typeof item==='number'||typeof item==='string'))throw Error(`${where}: expected a list`);
    value.forEach(item=>typeof item==='string'&&checkText(item,where));
    return [...value];
  }
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${where}: expected an object`);
  const extra=Object.keys(value).filter(key=>!fields.includes(key));
  if(extra.length)throw Error(`${where}: unknown field ${extra.join(', ')}; add it to the script once it is checked`);
  const out={};
  for(const key of fields){
    if(!Object.hasOwn(value,key)||value[key]===null||value[key]===undefined)continue;
    const item=value[key];
    if(typeof item==='string')checkText(item,where+'.'+key);
    else if(Array.isArray(item))item.forEach(name=>{if(typeof name!=='string')throw Error(`${where}.${key}: expected text`);checkText(name,where+'.'+key);});
    else if(!['number','boolean'].includes(typeof item))throw Error(`${where}.${key}: unexpected value`);
    out[key]=Array.isArray(item)?[...item]:item;
  }
  if(out.url!==undefined&&!https(out.url))throw Error(`${where}: the link is not an https address`);
  return out;
}
// The pages a fact rests on: the URLs of its quotes (the quotes themselves stay private).
function sourcesOf(entry,where){
  const urls=[...new Set([...(entry.quotes||[]).map(q=>q?.url),entry.url].filter(Boolean))];
  if(!urls.length)throw Error(`${where}: a published fact without a source`);
  for(const url of urls)if(!https(url))throw Error(`${where}: source ${url} is not an https address`);
  return urls;
}
// Facts quoted anew after the second reading, from the dated notes the re-reading of scans writes ("21 Oct 2026: price, meals now quoted ...").
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
export function requotedAfter(record,verifiedOn){
  const keys=new Set();
  for(const note of record.notes||[]){
    const m=String(note).match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4}): ([A-Za-z, ]+?) now quoted\b/);
    if(!m||!MONTHS.includes(m[2].toLowerCase()))continue;
    const date=`${m[3]}-${String(MONTHS.indexOf(m[2].toLowerCase())+1).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    if(!verifiedOn||date>verifiedOn)m[4].split(/,\s*|\s+and\s+/).forEach(key=>keys.add(key.trim()));
  }
  return keys;
}
// The facts of one record that may be published: confirmed by the second reading (and not quoted anew since), not held. Any other fact with
// a value stops the script, or with leaveOut is left out and named in pending.
export function publishedFacts(record,verified,schema,where,{leaveOut=false}={}){
  const facts={},pending=[],held=new Set(Object.keys(record.held||{})),verdicts=verified?.facts||{},requoted=requotedAfter(record,verified?.verifiedOn);
  if(verified&&verified.id!==record.id)throw Error(`${where}: the second reading is of ${verified.id}`);
  for(const [key,fields] of Object.entries(schema)){
    const entry=record.facts?.[key];
    if(!entry||!Object.hasOwn(entry,'value'))throw Error(`${where}.${key}: the fact is missing`);
    if(entry.value===null||held.has(key))continue;
    const verdict=requoted.has(key)?'quoted anew after the second reading':verdicts[key]?.verdict;
    if(verdict!=='confirmed'){
      if(leaveOut){pending.push(key);continue;}
      throw Error(`${where}.${key}: has a value but the second reading says ${verdict?`"${verdict}"`:'nothing'}, not "confirmed"`);
    }
    facts[key]={value:cleanValue(entry.value,fields,`${where}.${key}`),sources:sourcesOf(entry,`${where}.${key}`)};
  }
  return {facts,pending};
}
// The website: the place's own site as the collector used it (its pages were read there), else the canton's entry; https only and no social network.
export function websiteOf(place,record){
  const read=new Set((record.pages||[]).map(page=>https(page.url)?.hostname).filter(Boolean));
  for(const [url,checked] of [[record.website,true],[place.website,false]]){
    const u=https(url);
    if(u&&!SOCIAL.test(u.hostname)&&(!checked||read.has(u.hostname)))return u.href;
  }
  return null;
}
// "The request must be renewed every 4 months": the interval in months, when a confirmed renewal rule states one in these words.
export function renewalMonths(text){
  const match=String(text||'').match(/\brenew(?:ed|al)?\b[^.]*?\bevery (\d{1,2}) months?\b/i);
  return match?Number(match[1]):null;
}
const round=n=>Math.round(n*1e6)/1e6;
// The pages of a record once, and each fact's sources as positions in that list: the same page backs many facts.
export function paged(facts){
  const pages=[],out={};
  for(const [key,fact] of Object.entries(facts))out[key]={value:fact.value,sources:fact.sources.map(url=>{if(!pages.includes(url))pages.push(url);return pages.indexOf(url);})};
  return {pages,facts:out};
}
// Records whose file was written after their second reading. Reported only: a later edit may be wording a person made (dated notes say which).
const newer=(file,verified)=>fs.existsSync(verified)&&fs.statSync(file).mtimeMs>fs.statSync(verified).mtimeMs+1000;
export function compile(folder,{leaveOut=false}={}){
  const lists=fs.readdirSync(folder).filter(name=>/^places-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  if(!lists.length)throw Error('No places-YYYY-MM-DD.json in the folder');
  const list=readJson(path.join(folder,lists.at(-1))),report={list:lists.at(-1),places:0,onHold:[],facts:0,communes:0,communeFacts:0,leftOut:{},changedAfterReading:[]};
  const verifiedOf=name=>{const file=path.join(folder,'verified',name);return fs.existsSync(file)?readJson(file):null;};
  const places=[];
  for(const place of [...list.places].sort((a,b)=>a.id.localeCompare(b.id))){
    const where=place.id,file=path.join(folder,'collected',place.id+'.json');
    if(!TYPES.includes(place.type))throw Error(`${where}: unknown type ${place.type}`);
    if(!fs.existsSync(file))throw Error(`${where}: no collected facts`);
    const record=readJson(file);
    if(record.id!==place.id)throw Error(`${where}: the collected file is of ${record.id}`);
    if(record.hold){report.onHold.push(place.id);continue;}
    if(!DATE.test(record.collectedOn||''))throw Error(`${where}: no date of collection`);
    if(!Number.isFinite(place.lat)||!Number.isFinite(place.lon))throw Error(`${where}: no map point`);
    for(const key of ['name','address','postcode','town'])if(place[key]!==null&&place[key]!==undefined)checkText(String(place[key]),`${where}.${key}`);
    const {facts,pending}=publishedFacts(record,verifiedOf(place.id+'.json'),PLACE_FACTS,where,{leaveOut});
    places.push({id:place.id,type:place.type,name:place.name,address:place.address||'',postcode:place.postcode?String(place.postcode):'',town:place.town||'',
      lat:round(place.lat),lon:round(place.lon),website:websiteOf(place,record),checked:record.collectedOn,...paged(facts),...(pending.length?{pending}:{})});
    if(newer(file,path.join(folder,'verified',place.id+'.json')))report.changedAfterReading.push(place.id);
    if(pending.length)report.leftOut[place.id]=pending;
    report.places++;report.facts+=Object.keys(facts).length;
  }
  const communes=[];
  const communeFiles=fs.existsSync(path.join(folder,'communes'))?fs.readdirSync(path.join(folder,'communes')).filter(name=>name.endsWith('.json')).sort():[];
  for(const name of communeFiles){
    const record=readJson(path.join(folder,'communes',name)),where='commune '+name.slice(0,-5);
    if(record.id!==name.slice(0,-5))throw Error(`${where}: the file is of ${record.id}`);
    if(record.hold)continue;
    if(!DATE.test(record.collectedOn||''))throw Error(`${where}: no date of collection`);
    checkText(record.name,where+'.name');
    const {facts,pending}=publishedFacts(record,verifiedOf('commune-'+name),COMMUNE_FACTS,where,{leaveOut});
    communes.push({id:record.id,name:record.name,kind:record.id.startsWith('region-')?'region':'commune',checked:record.collectedOn,
      renewMonths:facts.renewal?renewalMonths(facts.renewal.value.text):null,...paged(facts),...(pending.length?{pending}:{})});
    if(newer(path.join(folder,'communes',name),path.join(folder,'verified','commune-'+name)))report.changedAfterReading.push('commune '+record.id);
    if(pending.length)report.leftOut['commune '+record.id]=pending;
    report.communes++;report.communeFacts+=Object.keys(facts).length;
  }
  const source={name:'Etat de Fribourg',licence:list.places[0]?.source?.licence||'OGD, Source : Etat de Fribourg',url:list.source||'',fetchedOn:list.generatedOn||''};
  return {data:{schema:1,source,places,communes},report};
}
// The family-facing English texts of the published data, each with a stable id: the text of a place's fact ('place/<id>/<fact>'), of a
// commune's rule ('commune/<id>/<rule>') and a commune's name ('commune/<id>/name', which often explains the body in English). childcare.js
// asks for a translation with the same ids. Names of places and of subsidised crèches are proper names and stay as they are.
const FACT_WORDS={ageFrom:'Minimum age',ageTo:'Upper age limit',hours:'Days and opening hours',closures:'When the place is closed',pedagogy:'Educational approach',
  subsidised:'Whether the place is subsidised',price:'Price',meals:'Meals',registration:'How to register',availability:'Free places',settlingIn:'Settling in',trialPeriod:'Trial period'};
const RULE_WORDS={registration:'Waiting list',registrationFrom:'From when a family can register',renewal:'Keeping a request on the waiting list',residency:'Who can register',
  registrationFee:'Registration fee',tariff:'What parents pay',calculator:'Description of the price calculator',privateSupport:'Help for private or other crèches'};
export function texts({places,communes}){
  const out=[],put=(id,en,context)=>{if(typeof en==='string'&&en.trim())out.push({id,en,context});};
  for(const p of places)for(const [key,fact] of Object.entries(p.facts))
    put(`place/${p.id}/${key}`,fact.value?.text,`${FACT_WORDS[key]||key} at the daycare place "${p.name}"${p.town?' in '+p.town:''}, canton Fribourg; shown to families under that heading.`);
  for(const c of communes){
    put(`commune/${c.id}/name`,c.name,'Name of a commune or regional body in canton Fribourg, in the list "Where do you live?". Keep the place names; translate only the words that explain.');
    for(const [key,fact] of Object.entries(c.facts))put(`commune/${c.id}/${key}`,fact.value?.text,`${RULE_WORDS[key]||key}: a rule of ${c.name} for a place in a crèche, shown under "Getting a place in ${c.name}".`);
  }
  return out;
}
export const digest=text=>crypto.createHash('sha256').update(text,'utf8').digest('hex');
// One language's translations of the current texts: {id: {en, text}}, en the digest of the English they were made from. A translation of
// an English text that has changed since (stale) or of a text that is not published now (unknown) is left out and named; one with
// contact details or Cyrillic stops the script, as a published English text would.
export function translationsFor(list,folder,lang){
  const file=path.join(folder,'translations',lang+'.json'),report={found:fs.existsSync(file),translated:0,stale:[],unknown:[],invalid:[]},data={};
  if(!report.found)return {data,report};
  const raw=readJson(file),byId=new Map(list.map(item=>[item.id,item]));
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error(`translations/${lang}.json must hold {id: {en_digest, text}}`);
  for(const [id,entry] of Object.entries(raw)){
    const english=byId.get(id);
    if(!english){report.unknown.push(id);continue;}
    if(!entry||typeof entry.text!=='string'||!entry.text.trim()||!/^[0-9a-f]{64}$/.test(entry.en_digest||'')){report.invalid.push(id);continue;}
    if(entry.en_digest!==digest(english.en)){report.stale.push(id);continue;}
    checkText(entry.text,`translations/${lang}.json ${id}`);
    data[id]={en:entry.en_digest,text:entry.text};report.translated++;
  }
  return {data,report};
}
const LANGUAGE={de:'German',fr:'French'};
export function textsCode(lang,data){
  return `/* Generated by scripts/compile-childcare.mjs from the checked ${LANGUAGE[lang]} translations of the Daycare texts. Per text (its id is the one of
   texts() there): en, the digest of the English it was translated from, and the translation. A text whose English has changed since is
   shown in English (childcare.js translator). Loaded with the Daycare tab when the interface is ${LANGUAGE[lang]}. */
(window.MINITANDEM_CHILDCARE_TEXTS = window.MINITANDEM_CHILDCARE_TEXTS || {}).${lang} = {
${Object.entries(data).map(([id,entry])=>JSON.stringify(id)+':'+JSON.stringify(entry)).join(',\n')}
};
`;
}
export function code({schema,source,places,communes}){
  return `/* Generated by scripts/compile-childcare.mjs: the preschool places of canton Fribourg from the canton's open list (OGD, "Source : Etat de
   Fribourg"), each with the facts that a second reading confirmed, and the rules of the communes and regional bodies. A record lists its
   pages once; a fact's sources are positions in that list. No quotes, notes or contact details other than the website. "pending": facts
   left out until a second reading confirms them.
   One place or commune per line. Do not edit by hand. */
window.CHILDCARE = {"schema":${JSON.stringify(schema)},"source":${JSON.stringify(source)},
"places":[
${places.map(place=>JSON.stringify(place)).join(',\n')}
],
"communes":[
${communes.map(commune=>JSON.stringify(commune)).join(',\n')}
]};
`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),folder=args[0],exportAt=args.indexOf('--export-texts'),exportFile=exportAt>=0?args[exportAt+1]:'';
  if(!folder||folder.startsWith('--')||!fs.existsSync(folder))throw Error('Pass the private childcare folder as the first argument');
  if(exportAt>=0&&(!exportFile||exportFile.startsWith('--')))throw Error('--export-texts needs a file to write');
  const {data,report}=compile(path.resolve(folder),{leaveOut:args.includes('--leave-out-unconfirmed')}),text=code(data),list=texts(data);
  if(exportFile){
    // For the translators: the texts only. The repository is left as it is; the line says whether its data file holds the same texts.
    fs.writeFileSync(exportFile,JSON.stringify(list,null,2)+'\n');
    const current=fs.existsSync(path.join(root,OUTPUT))&&fs.readFileSync(path.join(root,OUTPUT),'utf8')===text;
    console.log(JSON.stringify({file:exportFile,texts:list.length,places:list.filter(item=>item.id.startsWith('place/')).length,communes:list.filter(item=>item.id.startsWith('commune/')).length,
      sameAsRepository:current},null,2));
  }else{
    fs.writeFileSync(path.join(root,OUTPUT),text);
    const languages={};
    for(const lang of LANGS){
      const {data:translated,report:langReport}=translationsFor(list,path.resolve(folder),lang),file=textsFile(lang);
      fs.writeFileSync(path.join(root,file),textsCode(lang,translated));
      languages[lang]={file,texts:list.length,...langReport};
    }
    console.log(JSON.stringify({file:OUTPUT,bytes:Buffer.byteLength(text),...report,languages},null,2));
  }
}
