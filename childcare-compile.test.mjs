// The Daycare tab's data: scripts/compile-childcare.mjs against an invented private folder (confirmed facts only, nothing held, no place on
// hold, no notes, problems, quotes or contacts other than the website), and the published data-childcare.js as it is in the repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {compile,code,publishedFacts,requotedAfter,websiteOf,renewalMonths,texts,digest,translationsFor,textsCode,textsFile,LANGS,PLACE_FACTS,COMMUNE_FACTS,TYPES} from './scripts/compile-childcare.mjs';
import {root} from './test-support.mjs';

const NULLS=Object.fromEntries(Object.keys(PLACE_FACTS).map(key=>[key,{value:null,reason:'not-stated'}]));
const quote=(text,url,id='snap-1')=>({quote:'PRIVATE QUOTE '+text,snapshotId:id,url});
// One place with three facts, two of them confirmed; its record carries everything that must stay private.
function place(overrides={}){
  return {schema:1,kind:'place',id:'creche-a',name:'Crèche A',town:'Fribourg',type:'creche',collectedOn:'2026-10-20',website:'https://a.example.org/',
    pages:[{snapshotId:'snap-1',url:'https://a.example.org/tarifs/',purpose:'tarifs'}],
    facts:{...NULLS,
      hours:{value:{text:'Mon–Fri 06:30–18:30',opensAt:'06:30',closesAt:'18:30'},...quote('du lundi au vendredi','https://a.example.org/horaires/')},
      price:{value:{kind:'income-based',text:'CHF 18.00 to 86.55 a day',minChf:18,maxChf:86.55,unit:'day',validFrom:'2021-08-01'},
        quotes:[quote('barème','https://a.example.org/tarifs/'),quote('grille','https://city.example.org/grille.pdf','snap-2')]},
      meals:{value:{text:'Lunch included'},...quote('repas','https://a.example.org/tarifs/')}},
    notes:['PRIVATE NOTE'],problems:['PRIVATE PROBLEM'],...overrides};
}
const verified=(facts={hours:'confirmed',price:'confirmed',meals:'rejected'},id='creche-a')=>({schema:1,id,verifiedOn:'2026-10-20',
  facts:Object.fromEntries(Object.entries(facts).map(([key,verdict])=>[key,{verdict,reason:'PRIVATE REASON'}])),overall:'fix'});
const commune=(overrides={})=>({schema:1,kind:'commune',id:'fribourg',name:'Fribourg (city)',collectedOn:'2026-10-20',pages:[],
  facts:{...Object.fromEntries(Object.keys(COMMUNE_FACTS).map(key=>[key,{value:null,reason:'not-stated'}])),
    renewal:{value:{text:'The request must be renewed every 4 months, otherwise it is taken off the list.'},...quote('tous les 4 mois','https://city.example.org/notice.pdf')},
    calculator:{value:{url:'https://city.example.org/calculator.xlsx',text:'Excel calculator'},...quote('Calculateur','https://city.example.org/garde')}},
  notes:['PRIVATE COMMUNE NOTE'],problems:[],...overrides});
// The private folder as the collectors leave it: the canton's list, collected/, communes/ and verified/.
function folder(t,{places=[place()],verdicts={'creche-a':verified()},communes=[commune()],communeVerdicts={fribourg:verified({renewal:'confirmed',calculator:'confirmed'},'fribourg')},
  listed=null}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-childcare-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const sub of ['collected','communes','verified'])fs.mkdirSync(path.join(dir,sub));
  const write=(file,value)=>fs.writeFileSync(path.join(dir,file),JSON.stringify(value));
  write('places-2026-10-20.json',{schema:1,generatedOn:'2026-10-20',source:'https://maps.example.org/open-data',places:listed||places.map(p=>({id:p.id,sejObjectId:1,type:p.type,typeLabel:'Crèche',name:p.name,
    address:'Rue A 1',postcode:1700,town:p.town,lon:7.151234567,lat:46.801234567,website:'https://canton-listed.example.org',email:'info@a.example.org',phone:'026 000 00 00',
    source:{licence:'OGD, Source : Etat de Fribourg'}}))});
  for(const p of places)write(`collected/${p.id}.json`,p);
  for(const [id,v] of Object.entries(verdicts))write(`verified/${id}.json`,v);
  for(const c of communes)write(`communes/${c.id}.json`,c);
  for(const [id,v] of Object.entries(communeVerdicts))write(`verified/commune-${id}.json`,v);
  return dir;
}
// The data as the page reads it, brought into this realm.
const load=text=>{const context={window:{}};vm.runInNewContext(text,context);return JSON.parse(JSON.stringify(context.window.CHILDCARE));};

test('only facts the second reading confirmed are published, each with the pages it rests on; nothing private is written',t=>{
  assert.throws(()=>compile(folder(t)),/creche-a\.meals: has a value but the second reading says "rejected", not "confirmed"/,'a rejected fact stops the script');
  const {data,report}=compile(folder(t,{verdicts:{'creche-a':verified({hours:'confirmed',price:'confirmed'})}}),{leaveOut:true});
  const [p]=data.places;
  assert.deepEqual(Object.keys(p.facts),['hours','price'],'the fact without a verdict is left out');
  assert.deepEqual(p.pending,['meals']);assert.deepEqual(report.leftOut,{'creche-a':['meals']});
  assert.deepEqual(p.pages,['https://a.example.org/horaires/','https://a.example.org/tarifs/','https://city.example.org/grille.pdf']);
  assert.deepEqual(p.facts.price,{value:{kind:'income-based',text:'CHF 18.00 to 86.55 a day',minChf:18,maxChf:86.55,unit:'day',validFrom:'2021-08-01'},sources:[1,2]});
  assert.deepEqual({id:p.id,type:p.type,name:p.name,address:p.address,postcode:p.postcode,town:p.town,lat:p.lat,lon:p.lon,checked:p.checked},
    {id:'creche-a',type:'creche',name:'Crèche A',address:'Rue A 1',postcode:'1700',town:'Fribourg',lat:46.801235,lon:7.151235,checked:'2026-10-20'});
  const text=code(data);
  for(const secret of ['PRIVATE','snap-1','"snapshotId"','"quote"','"quotes"','"notes"','"problems"','info@','026 000','"reason"'])assert.ok(!text.includes(secret),secret+' must not be published');
  assert.deepEqual(load(text),JSON.parse(JSON.stringify(data)),'the file is the data, readable by the page');
  assert.ok(!text.includes(os.tmpdir()),'the private folder is never named');
});
test('without --leave-out-unconfirmed a value with no verdict stops the script, and the error names the place and the fact',t=>{
  assert.throws(()=>compile(folder(t,{verdicts:{}})),/creche-a\.hours: has a value but the second reading says nothing, not "confirmed"/);
  assert.throws(()=>compile(folder(t,{verdicts:{'creche-a':verified({hours:'unclear',price:'confirmed',meals:'confirmed'})}})),/creche-a\.hours: .*"unclear"/);
  assert.throws(()=>compile(folder(t,{verdicts:{'creche-a':verified({hours:'confirmed',price:'confirmed',meals:'confirmed'},'creche-b')}})),/the second reading is of creche-b/);
  const missing=place();delete missing.facts.closures;
  assert.throws(()=>compile(folder(t,{places:[missing],verdicts:{'creche-a':verified({hours:'confirmed',price:'confirmed',meals:'confirmed'})}})),/creche-a\.closures: the fact is missing/);
});
test('a held fact is never published, a place with a top-level hold is left out, and a fact quoted anew after the reading needs a new one',t=>{
  const all={'creche-a':verified({hours:'confirmed',price:'confirmed',meals:'confirmed'})};
  const held=place({held:{meals:{heldOn:'2026-10-20',verdict:'rejected',readerReason:'PRIVATE',collected:{}}}});
  assert.deepEqual(Object.keys(compile(folder(t,{places:[held],verdicts:all})).data.places[0].facts),['hours','price']);
  const onHold=compile(folder(t,{places:[place({hold:'PRIVATE: the association was dissolved'})],verdicts:all}));
  assert.deepEqual(onHold.data.places,[]);assert.deepEqual(onHold.report.onHold,['creche-a']);
  assert.ok(!code(onHold.data).includes('creche-a'));
  const requoted=place({notes:['21 Oct 2026: price, meals now quoted from the recognised scan https://a.example.org/scan.pdf']});
  assert.deepEqual([...requotedAfter(requoted,'2026-10-20')],['price','meals']);
  assert.deepEqual([...requotedAfter(requoted,'2026-10-21')],[],'a reading on the same day or later covers it');
  assert.throws(()=>compile(folder(t,{places:[requoted],verdicts:all})),/creche-a\.price: .*"quoted anew after the second reading"/);
  assert.deepEqual(compile(folder(t,{places:[requoted],verdicts:all}),{leaveOut:true}).data.places[0].pending,['price','meals']);
});
test('a published text with an e-mail address or a phone number, or a value field nobody checked, stops the script',t=>{
  const all={'creche-a':verified({hours:'confirmed',price:'confirmed',meals:'confirmed'})};
  const withText=text=>{const p=place();p.facts.meals.value.text=text;return p;};
  assert.throws(()=>compile(folder(t,{places:[withText('Write to kitchen@a.example.org')],verdicts:all})),/creche-a\.meals\.text: an e-mail address/);
  assert.throws(()=>compile(folder(t,{places:[withText('Call 026 000 00 00')],verdicts:all})),/creche-a\.meals\.text: a phone number/);
  // Built at run time, so that the public scan does not read the digits of the address as a phone number either.
  assert.doesNotThrow(()=>compile(folder(t,{places:[withText(['See https://a.example.org/0','260000000/menu'].join(''))],verdicts:all})),'digits in a web address are not a phone number');
  const extra=place();extra.facts.meals.value.quote='PRIVATE';
  assert.throws(()=>compile(folder(t,{places:[extra],verdicts:all})),/creche-a\.meals: unknown field quote/);
  const http=place();http.facts.meals.url='http://a.example.org/repas';
  assert.throws(()=>compile(folder(t,{places:[http],verdicts:all})),/is not an https address/);
});
test('the website is the place\'s own https site where its pages were read, else the canton\'s entry; never a social network page',()=>{
  const listed={website:'https://canton-listed.example.org'};
  assert.equal(websiteOf(listed,place()),'https://a.example.org/');
  assert.equal(websiteOf(listed,place({website:'https://elsewhere.example.org/'})),'https://canton-listed.example.org/','a site none of whose pages was read');
  assert.equal(websiteOf({website:'https://www.facebook.com/somegroup/'},place({website:null})),null);
  assert.equal(websiteOf({website:'http://old.example.org'},place({website:null})),null);
});
test('communes: confirmed rules only, regional bodies marked, and the renewal interval read from a confirmed rule that states one',t=>{
  assert.equal(renewalMonths('The request must be renewed every 4 months, otherwise it is taken off the list.'),4);
  assert.equal(renewalMonths('The registration must be renewed every 4 months, by e-mail or in writing.'),4);
  assert.equal(renewalMonths('A request stays active for 3 months; if the family sends no news, it is removed.'),null);
  assert.equal(renewalMonths('The contract is renewed for each school year.'),null);
  const region=commune({id:'region-example',name:'Example region'});
  const {data}=compile(folder(t,{verdicts:{'creche-a':verified({hours:'confirmed',price:'confirmed',meals:'confirmed'})},communes:[commune(),region],
    communeVerdicts:{fribourg:verified({renewal:'confirmed',calculator:'confirmed'},'fribourg'),'region-example':verified({renewal:'rejected',calculator:'confirmed'},'region-example')}}),{leaveOut:true});
  const [city,other]=data.communes;
  assert.deepEqual([city.id,city.kind,city.renewMonths,Object.keys(city.facts)],['fribourg','commune',4,['renewal','calculator']]);
  assert.deepEqual([other.kind,other.renewMonths,Object.keys(other.facts),other.pending],['region',null,['calculator'],['renewal']]);
  assert.deepEqual(city.facts.calculator.value,{url:'https://city.example.org/calculator.xlsx',text:'Excel calculator'});
  assert.ok(!code(data).includes('PRIVATE COMMUNE NOTE'));
});
test('every fact of a place and of a commune is expected, and the kinds of care are the canton\'s',()=>{
  assert.deepEqual(Object.keys(PLACE_FACTS),['ageFrom','ageTo','days','hours','closures','languages','pedagogy','subsidised','price','meals','registration','availability','settlingIn','trialPeriod']);
  assert.deepEqual(Object.keys(COMMUNE_FACTS),['registration','registrationFrom','renewal','residency','registrationFee','tariff','calculator','subsidisedPlaces','privateSupport']);
  assert.deepEqual(TYPES,['creche','garderie','family-day-care','playgroup','nature-playgroup','maternelle']);
  const record={id:'x',facts:{...NULLS,hours:{value:{text:'Mon'},url:'https://x.example.org'}}};
  assert.deepEqual(publishedFacts(record,null,PLACE_FACTS,'x',{leaveOut:true}),{facts:{},pending:['hours']},'no second reading at all: nothing is published');
});

test('the texts to translate: every published English text with a stable id and a context, nothing unpublished, nothing private',t=>{
  const all={'creche-a':verified({hours:'confirmed',price:'confirmed',meals:'confirmed'})};
  const {data}=compile(folder(t,{verdicts:all}));
  const list=texts(data);
  assert.deepEqual(list.map(item=>item.id),['place/creche-a/hours','place/creche-a/price','place/creche-a/meals','commune/fribourg/name','commune/fribourg/renewal','commune/fribourg/calculator']);
  assert.deepEqual(list.map(item=>item.en).slice(0,4),['Mon–Fri 06:30–18:30','CHF 18.00 to 86.55 a day','Lunch included','Fribourg (city)']);
  assert.ok(list.every(item=>item.context.length>20&&!/PRIVATE/.test(item.context)),'each with a context for the translator');
  assert.match(list[0].context,/Days and opening hours at the daycare place "Crèche A" in Fribourg/);
  const pending=compile(folder(t,{verdicts:{'creche-a':verified({hours:'confirmed',price:'confirmed'})}}),{leaveOut:true}).data;
  assert.ok(!texts(pending).some(item=>item.id==='place/creche-a/meals'),'a fact waiting for its reading is not offered for translation');
  assert.deepEqual(texts(data).map(item=>item.id),list.map(item=>item.id),'the same data gives the same ids');
});
test('translations: only those of the current English are written; a changed, unknown or broken one is named, one with contact data stops',t=>{
  const all={'creche-a':verified({hours:'confirmed',price:'confirmed',meals:'confirmed'})};
  const dir=folder(t,{verdicts:all}),list=texts(compile(dir).data);
  assert.deepEqual(translationsFor(list,dir,'de'),{data:{},report:{found:false,translated:0,stale:[],unknown:[],invalid:[]}},'no translations: every text stays English');
  fs.mkdirSync(path.join(dir,'translations'));
  const write=value=>fs.writeFileSync(path.join(dir,'translations','de.json'),JSON.stringify(value));
  write({'place/creche-a/hours':{en_digest:digest('Mon–Fri 06:30–18:30'),text:'Mo–Fr 06:30–18:30'},'place/creche-a/meals':{en_digest:digest('Lunch'),text:'Mittagessen'},
    'place/creche-b/hours':{en_digest:digest('x'),text:'y'},'commune/fribourg/name':{en_digest:digest('Fribourg (city)'),text:''}});
  const {data,report}=translationsFor(list,dir,'de');
  assert.deepEqual(data,{'place/creche-a/hours':{en:digest('Mon–Fri 06:30–18:30'),text:'Mo–Fr 06:30–18:30'}});
  assert.deepEqual(report,{found:true,translated:1,stale:['place/creche-a/meals'],unknown:['place/creche-b/hours'],invalid:['commune/fribourg/name']});
  write({'place/creche-a/meals':{en_digest:digest('Lunch included'),text:'Schreiben Sie an kitchen@a.example.org'}});
  assert.throws(()=>translationsFor(list,dir,'de'),/translations\/de\.json place\/creche-a\/meals: an e-mail address/);
  const file=textsCode('de',data),context={window:{}};vm.runInNewContext(file,context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.MINITANDEM_CHILDCARE_TEXTS.de)),data);
  assert.ok(file.includes('Loaded with the Daycare tab when the interface is German'));
});
test('--export-texts writes the list for the translators and leaves the repository as it is',t=>{
  const all={'creche-a':verified({hours:'confirmed',price:'confirmed',meals:'confirmed'})};
  const dir=folder(t,{verdicts:all}),out=path.join(dir,'texts-en.json'),before=fs.readFileSync(path.join(root,'data-childcare.js'),'utf8');
  const run=spawnSync(process.execPath,[path.join(root,'scripts/compile-childcare.mjs'),dir,'--export-texts',out],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const list=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.deepEqual(list,texts(compile(dir).data));
  assert.deepEqual(Object.keys(list[0]),['id','en','context']);
  assert.deepEqual(JSON.parse(run.stdout),{file:out,texts:6,places:3,communes:3,sameAsRepository:false});
  assert.equal(fs.readFileSync(path.join(root,'data-childcare.js'),'utf8'),before,'the data file is not written');
  assert.notEqual(spawnSync(process.execPath,[path.join(root,'scripts/compile-childcare.mjs'),dir,'--export-texts'],{encoding:'utf8'}).status,0,'a file is needed');
});

// The file as published: what the page and the tests read.
const published=load(fs.readFileSync(path.join(root,'data-childcare.js'),'utf8'));
test('data-childcare.js: places with a kind, a point in the canton, dated checks and facts that each name their https pages; no private field',()=>{
  assert.equal(published.schema,1);assert.equal(published.source.name,'Etat de Fribourg');
  assert.ok(published.places.length>150,'the canton lists about 200 places');
  assert.equal(new Set(published.places.map(p=>p.id)).size,published.places.length);
  for(const p of published.places){
    assert.ok(TYPES.includes(p.type),p.id);assert.match(p.checked,/^\d{4}-\d{2}-\d{2}$/,p.id);
    assert.ok(p.lat>46.4&&p.lat<47.1&&p.lon>6.7&&p.lon<7.45,p.id+': a point in canton Fribourg');
    assert.ok(p.website===null||/^https:\/\//.test(p.website),p.id);
    assert.deepEqual(Object.keys(p).filter(k=>!['id','type','name','address','postcode','town','lat','lon','website','checked','pages','facts','pending'].includes(k)),[],p.id);
    for(const [key,fact] of Object.entries(p.facts)){
      assert.ok(Object.hasOwn(PLACE_FACTS,key),p.id+' '+key);
      assert.ok(fact.sources.length&&fact.sources.every(i=>/^https:\/\//.test(p.pages[i])),p.id+' '+key+': its pages');
      if(PLACE_FACTS[key])assert.deepEqual(Object.keys(fact.value).filter(k=>!PLACE_FACTS[key].includes(k)),[],p.id+' '+key);
    }
    for(const key of p.pending||[])assert.ok(!p.facts[key],p.id+' '+key+': a pending fact has no value');
  }
  for(const c of published.communes){
    assert.ok(['commune','region'].includes(c.kind));assert.ok(c.renewMonths===null||Number.isInteger(c.renewMonths));
    for(const [key,fact] of Object.entries(c.facts))assert.ok(Object.hasOwn(COMMUNE_FACTS,key)&&fact.sources.every(i=>/^https:\/\//.test(c.pages[i])),c.id+' '+key);
  }
  const text=JSON.stringify(published);
  assert.doesNotMatch(text,/"(?:quote|quotes|snapshotId|notes|problems|held|hold|reason|email|phone)"/);
  assert.doesNotMatch(text,/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,'no e-mail address');
  assert.equal(published.communes.find(c=>c.id==='fribourg')?.renewMonths,4,'Fribourg city: renew every 4 months');
});
test('data-childcare-de.js and -fr.js: translations of texts that are published, each with the digest of its English; French typography',()=>{
  const ids=new Set(texts(published).map(item=>item.id)),english=new Map(texts(published).map(item=>[item.id,item.en]));
  for(const lang of LANGS){
    const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,textsFile(lang)),'utf8'),context);
    const data=context.window.MINITANDEM_CHILDCARE_TEXTS[lang];
    assert.ok(data&&typeof data==='object',lang);
    for(const [id,entry] of Object.entries(data)){
      assert.ok(ids.has(id),lang+' '+id+': a published text');
      assert.equal(entry.en,digest(english.get(id)),lang+' '+id+': a translation of the current English');
      assert.ok(typeof entry.text==='string'&&entry.text.trim()&&!/[\u0400-\u04FF]/.test(entry.text),lang+' '+id);
      if(lang==='fr')assert.ok(!/ [:;?!]|« | »/.test(entry.text.replace(/https?:\/\/\S+/g,'')),'fr '+id+': a no-break space before : ; ? ! and inside « »');
    }
  }
});
