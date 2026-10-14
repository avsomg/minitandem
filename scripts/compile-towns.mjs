// Town centres for the "near me" distances. Looks up every town named on a published card once at the federal geoportal
// SearchServer (the service editorial/geocode.mjs uses) and writes data-towns.js, which the interface reads. Needs the network.
// A populated-place name (swisstopo gazetteer, "Ort") is preferred: the centre of a merged municipality can lie kilometres from
// the village on the card (Plaffeien: about 4 km). Without one, the municipality (gg25) is used. Every match must carry the
// card's own name and lie in the card's district (editorial/municipalities-2026.json), so that a namesake elsewhere in the
// canton is never taken. A town with no such match stays null: its cards sort last as "distance unknown".
// Usage: node scripts/compile-towns.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const context={window:{},structuredClone};
for(const file of ['data.js','data-reviewed.js','data-practical.js','regions.js'])vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),context);
// Bilingual municipalities are listed as "Murten / Morat"; the gazetteer names them by either part.
const districtOf=new Map(JSON.parse(fs.readFileSync(path.join(root,'editorial/municipalities-2026.json'),'utf8')).municipalities
  .flatMap(m=>[m.name,...m.name.split(/\s+\/\s+/)].map(name=>[name,m.region])));
// The same split as placeNames() in catalogue.js: "Giffers / Tentlingen" names two towns.
const districts=new Map();
for(const a of context.window.ACTIVITIES.filter(a=>!['closed','excluded'].includes(a.status)))
  for(const name of a.town.split(/\s+\/\s+/).map(name=>name.trim()).filter(Boolean))districts.set(name,(districts.get(name)||new Set()).add(a.region));
const names=[...districts.keys()].sort((a,b)=>a.localeCompare(b,'de-CH'));
// Names on the cards that the gazetteer spells differently. Farvagny is the postal name of Farvagny-le-Grand and Farvagny-le-Petit;
// the gazetteer names the town of Murten in both languages.
const SPELLING={Farvagny:'Farvagny-le-Grand',Murten:'Murten Morat'};
const normal=s=>String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\bsaint\b/g,'st').replace(/[^a-z0-9]+/g,' ').trim().replace(/ fr$/,'');
const base=s=>normal(String(s).replace(/\s*\([^)]*\)\s*$/,''));
const plain=html=>String(html).replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
const inCanton=r=>r.lat>46.3&&r.lat<47.2&&r.lon>6.5&&r.lon<7.8;
const checked=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
async function search(text,origins,limit){
  const url=new URL('https://api3.geo.admin.ch/rest/services/ech/SearchServer');
  url.search=new URLSearchParams({searchText:text,type:'locations',origins,limit:String(limit),lang:'de',sr:'4326'});
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('HTTP '+response.status);
  const json=await response.json();
  await new Promise(resolve=>setTimeout(resolve,300));
  return {source:url.href,results:json.results.map(r=>({label:r.attrs.label,objectclass:r.attrs.objectclass||'',lat:r.attrs.lat,lon:r.attrs.lon}))};
}
// Gazetteer labels read "<i>Ort</i> <b>Name</b> (FR) - Municipality[,Municipality]"; municipality labels read "<b>Name (FR)</b>".
const gazetteerName=r=>plain((r.label.match(/<b>([\s\S]*?)<\/b>/)||[])[1]||'');
const gazetteerType=r=>plain((r.label.match(/^<i>([\s\S]*?)<\/i>/)||[])[1]||'');
const gazetteerTail=r=>plain(r.label.replace(/^<i>[\s\S]*?<\/i>/,'').replace(/<b>[\s\S]*?<\/b>/,''));
const inDistrict=(municipalities,wanted)=>municipalities.some(m=>wanted.has(districtOf.get(m)));
const one=list=>list.length===1?list[0]:null;
const centres={},report=[];
for(const name of names){
  const spelled=SPELLING[name]||name,text=spelled.replace(/[()]/g,' ').replace(/\s+/g,' ').trim(),wanted=districts.get(name);
  try{
    const places=await search(text,'gazetteer',20);
    const fribourg=places.results.filter(r=>inCanton(r)&&/^\(FR\) - /.test(gazetteerTail(r))&&inDistrict(gazetteerTail(r).replace(/^\(FR\) - /,'').split(','),wanted));
    const villages=fribourg.filter(r=>r.objectclass==='TLM_SIEDLUNGSNAME'&&['Ort',''].includes(gazetteerType(r)));
    // The exact name first ("Forel FR" is Forel); then a single namesake with a qualifier ("Pont (Veveyse)" for Pont).
    let r=one(villages.filter(r=>normal(gazetteerName(r))===normal(spelled)))||one(villages.filter(r=>base(gazetteerName(r))===base(spelled)));
    let hit=r?{r,kind:'locality',source:places.source,label:gazetteerName(r)+' ('+gazetteerTail(r).replace(/^\(FR\) - /,'')+')'}:null;
    if(!hit){
      const towns=await search(text,'gg25',5);
      r=one(towns.results.filter(r=>inCanton(r)&&/\(FR\)$/.test(plain(r.label))&&normal(plain(r.label).replace(/ \(FR\)$/,''))===normal(spelled)&&inDistrict([plain(r.label).replace(/ \(FR\)$/,''),plain(r.label)],wanted)));
      if(r)hit={r,kind:'municipality',source:towns.source,label:plain(r.label)};
    }
    // A hamlet or an area with exactly this name (Rathvel, for example) is still better than no point at all.
    if(!hit){
      r=one(fribourg.filter(r=>['TLM_SIEDLUNGSNAME','TLM_GEBIETSNAME'].includes(r.objectclass)&&normal(gazetteerName(r))===normal(spelled)));
      if(r)hit={r,kind:'place',source:places.source,label:gazetteerName(r)+' ('+gazetteerTail(r).replace(/^\(FR\) - /,'')+')'};
    }
    centres[name]=hit?{lat:Number(hit.r.lat.toFixed(5)),lon:Number(hit.r.lon.toFixed(5)),label:hit.label,kind:hit.kind,source:hit.source,checked}:null;
    report.push(name+': '+(hit?hit.kind+' '+hit.label:'NOT FOUND'));
  }catch(error){centres[name]=null;report.push(name+': FAILED '+error.message);}
}
const body=Object.entries(centres).map(([name,value])=>'  '+JSON.stringify(name)+': '+JSON.stringify(value)).join(',\n');
const code='/* Generated by scripts/compile-towns.mjs: one centre point for each town named on a published card, from the federal geoportal\n'+
  '   SearchServer (a populated-place name, else the municipality). A town centre is not an address: distances to it are approximate.\n'+
  '   null: no match with the card\'s own name in its district, so cards in that town have no distance. */\n'+
  'window.CATALOG_TOWNS = {\n'+body+'\n};\n';
fs.writeFileSync(path.join(root,'data-towns.js'),code);
console.log(report.join('\n'));
const missing=Object.keys(centres).filter(name=>!centres[name]);
console.log(`\n${names.length} towns, ${names.length-missing.length} with a centre`+(missing.length?`; none for: ${missing.join(', ')}`:''));
