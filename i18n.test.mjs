import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {loadStack,root} from './test-support.mjs';
import {SCRIPTS} from './ui-files.mjs';

const {window:W,I,P,K}=loadStack();
const dictionaries=W.MINITANDEM_STRINGS;
const LANGS=['en','de','fr'];
const placeholders=text=>[...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort().join(',');
const cyrillic=/[\u0400-\u04FF]/;

test('English, German and French have exactly the same keys',()=>{
  assert.deepEqual(Object.keys(dictionaries).sort(),LANGS.slice().sort());
  const reference=Object.keys(dictionaries.en);
  assert.ok(reference.length>400);
  for(const lang of ['de','fr']){
    assert.deepEqual(Object.keys(dictionaries[lang]).filter(k=>!reference.includes(k)),[],lang+' has keys that English lacks');
    assert.deepEqual(reference.filter(k=>!Object.hasOwn(dictionaries[lang],k)),[],lang+' lacks keys that English has');
  }
});
test('no value is empty, none is Cyrillic, and every language uses the same placeholders',()=>{
  for(const lang of LANGS)for(const [key,value] of Object.entries(dictionaries[lang])){
    assert.equal(typeof value,'string',lang+' '+key);
    assert.ok(value.trim().length>0,lang+' '+key+' is empty');
    assert.ok(!cyrillic.test(value),lang+' '+key+' contains Cyrillic');
    assert.ok(!/<[a-z/][^>]*>/i.test(value),lang+' '+key+' contains markup');
    assert.equal(placeholders(value),placeholders(dictionaries.en[key]),lang+' '+key+': placeholders differ from English');
  }
});
test('counted phrases come as a singular and a plural in every language',()=>{
  for(const lang of LANGS){
    const keys=Object.keys(dictionaries[lang]);
    for(const key of keys.filter(k=>k.endsWith('_one')))assert.ok(keys.includes(key.replace(/_one$/,'_other')),lang+' '+key+' has no plural');
    for(const key of keys.filter(k=>k.endsWith('_other')))assert.ok(keys.includes(key.replace(/_other$/,'_one')),lang+' '+key+' has no singular');
  }
});
test('German and French do not copy the English interface text for ordinary labels',()=>{
  const same=(lang)=>Object.keys(dictionaries.en).filter(k=>dictionaries[lang][k]===dictionaries.en[k]&&dictionaries.en[k].length>14&&!/^(meta|csv)\./.test(k));
  assert.deepEqual(same('de'),[],'German strings identical to English');
  assert.deepEqual(same('fr'),[],'French strings identical to English');
});

// Every word the interface can show must have a dictionary entry: literal keys in the code, and the families built from key lists.
const used=new Set();
for(const file of ['views.js','app.js','exports.js','format.js','map.js','sync.js']){
  const source=fs.readFileSync(path.join(root,file),'utf8');
  for(const m of source.matchAll(/\bt\('([A-Za-z0-9_.]+)'(?!\s*\+)/g))used.add(m[1]);
}
for(const m of fs.readFileSync(path.join(root,'index.html'),'utf8').matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z0-9_.]+)"/g))used.add(m[1]);
const has=(lang,key)=>Object.hasOwn(dictionaries[lang],key)||Object.hasOwn(dictionaries[lang],key+'_one');
test('every key the code asks for exists in every language',()=>{
  for(const lang of LANGS)assert.deepEqual([...used].filter(k=>!has(lang,k)),[],lang);
});
test('every dynamic key family is complete in every language',()=>{
  const family=(prefix,values)=>values.map(v=>prefix+'.'+(v===''?'none':v));
  const wanted=[
    ...family('category',K.CATEGORY_KEYS),...family('format',K.FORMAT_KEYS),...family('langFilter',K.LANGUAGE_KEYS),...family('priceFilter',K.PRICE_KEYS),
    ...family('statusFilter',K.STATUS_FILTER_KEYS),...family('when',K.WHEN_KEYS.filter(Boolean)),...family('preset',K.PRESET_KEYS.filter(Boolean)),...family('sort',K.SORT_KEYS),
    ...family('weekday',K.DAY_KEYS),...family('weekly',K.DAY_KEYS),...family('personalStatus',K.PERSONAL_KEYS),...family('needs',P.needKeys),...family('admission',P.admissionKeys),
    ...family('booking',P.bookingStateKeys),...family('outcome',P.outcomeKeys),...family('attendance',P.attendanceKeys),...family('usefulness',P.usefulnessKeys),
    ...family('information',P.informationKeys),...family('tracked',P.trackedFieldKeys),...family('practical',[...P.facilityKeys,...P.visitFieldKeys,'playArea','costNote','warnings']),
    ...family('warning',['closed','archived','scheduleExpired','datesPassed','reviewDue','bookingRequired','entranceUnknown','placeUnknown','adultUnconfirmed','priceUnclear','languageUnconfirmed','ageNotPublished','confirmWithOrganiser']),
    ...['active','check','future','closed','excluded'].flatMap(k=>[`status.${k}.short`,`status.${k}.long`]),...['active','check','future'].map(k=>`about.status.${k}`),
    ...['yes','no','unknown'].flatMap(k=>[`parent.${k}.long`,`parent.${k}.short`]),
    ...['name','category','town','district','address','age','adult','language','schedule','price','status','contacts','sources','checked'].map(k=>'csv.'+k),
    ...['waiting','syncing','saved','conflict','badKey','offline'].map(k=>'sync.'+k),
    ...W.MinitandemExchange.topics.map(topic=>'report.topic.'+({'Schedule':'schedule','Price':'price','Age or adult participation':'age','Address or closure':'address','Other':'other'}[topic]))
  ];
  assert.ok(wanted.every(k=>!k.endsWith('.undefined')));
  for(const lang of LANGS)assert.deepEqual(wanted.filter(k=>!has(lang,k)),[],lang);
  // Error codes thrown by the logic modules are worded by the interface.
  const codes=new Set();
  for(const file of ['planning.js','exchange.js','store.js','sync.js','app.js'])for(const m of fs.readFileSync(path.join(root,file),'utf8').matchAll(/(?:fail|code:)\s*\(?\s*'([a-z]+\.[A-Za-z]+)'/g))codes.add(m[1]);
  assert.ok(codes.size>=10);
  for(const lang of LANGS)assert.deepEqual([...codes].filter(c=>!has(lang,'error.'+c)),[],lang+' error codes');
});
test('the interface code, the dictionaries and the page contain no Cyrillic',()=>{
  for(const file of [...SCRIPTS.filter(f=>!/^data/.test(f)&&f!=='regions.js'),'index.html','styles.css','manifest.webmanifest','sw.js'])
    assert.ok(!cyrillic.test(fs.readFileSync(path.join(root,file),'utf8')),file);
});

test('the language follows the browser, falls back to English and honours a remembered choice',()=>{
  assert.equal(I.detect(['de-CH','en']),'de');
  assert.equal(I.detect(['fr-FR']),'fr');
  assert.equal(I.detect(['en-GB']),'en');
  assert.equal(I.detect(['ru-RU','it']),'en');
  assert.equal(I.detect(['ru-RU','fr']),'fr','the first language we have wins');
  assert.equal(I.detect([]),'en');
  assert.equal(I.detect(['de'],'fr'),'fr','a remembered choice wins');
  assert.equal(I.detect(['de'],'pt'),'de','an unknown remembered value is ignored');
  for(const [languages,expected] of [[['de-CH'],'de'],[['pt-BR'],'en']])assert.equal(loadStack({browserLanguages:languages}).I.init(languages),expected);
});
test('switching the language is remembered and sets the document language',()=>{
  const stack=loadStack(),writes=[];
  stack.window.document=undefined;
  const doc={documentElement:{lang:'en'}};
  stack.context.document=doc;
  stack.context.localStorage.setItem=(k,v)=>writes.push([k,v]);
  stack.I.setLang('de');
  assert.equal(doc.documentElement.lang,'de');
  assert.deepEqual(writes,[['minitandem-lang-v1','de']]);
  assert.equal(stack.I.setLang('xx'),'de','an unknown language is ignored');
  assert.equal(stack.t('tab.list'),'Liste');
  stack.I.setLang('fr',{persist:false});assert.equal(writes.length,1);
  assert.equal(stack.t('tab.list'),'Liste');
  assert.equal(stack.t('tab.saved'),'Enregistrés');
});
test('t() picks plural forms, fills parameters, formats decimals and falls back to English and then to the key',()=>{
  const en=loadStack({lang:'en'}),fr=loadStack({lang:'fr'});
  assert.equal(en.t('count.label',{n:1}),'activity');
  assert.equal(en.t('count.label',{n:12}),'activities');
  assert.equal(en.t('filters.show',{n:1}),'Show 1 activity');
  assert.equal(en.t('filters.show',{n:295}),'Show 295 activities');
  assert.equal(fr.t('filters.show',{n:0}),'Afficher 0 activité','French uses the singular for zero');
  assert.equal(fr.t('filters.show',{n:2}),'Afficher 2 activités');
  assert.equal(fr.t('age.from',{n:1.5}),'Dès 1,5 an','a decimal follows the language');
  assert.equal(en.t('age.from',{n:1.5}),'From 1.5 years');
  assert.equal(en.t('no.such.key'),'no.such.key');
  en.I.setLang('de',{persist:false});
  en.window.MINITANDEM_STRINGS.en['test.onlyEnglish']='English only';
  assert.equal(en.t('test.onlyEnglish'),'English only','a missing German entry falls back to English');
});
test('card content does not come from the interface dictionaries: without a card-text file the same card text appears in all three languages',()=>{
  const card='memo-library';
  const texts=LANGS.map(lang=>{const s=loadStack({lang});return s.V.detail(s.byId.get(card));});
  const name=loadStack().byId.get(card).name;
  const schedule=loadStack().byId.get(card).schedule;
  for(const html of texts){assert.ok(html.includes(loadStack().V.esc(name).replace(/ · /g,' · ')));assert.ok(html.includes(loadStack().V.esc(schedule)));}
  assert.notEqual(texts[0],texts[1]);assert.notEqual(texts[0],texts[2]);
});
