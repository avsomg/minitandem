// The age filter "under 1" (age 0 = 0-11 months) and the wording of ages below two years in months. Everything runs through the functions
// the interface uses: the filter and its explanation (catalogue.js, planning.js), the age text of the row and of the card page (format.js, views.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {loadStack,root} from './test-support.mjs';

const clock={today:'2026-10-17',nowHm:'10:00'};
const files=(()=>{const context={window:{}};for(const lang of ['de','fr'])vm.runInNewContext(fs.readFileSync(path.join(root,`data-${lang}.js`),'utf8'),context);return context.window.MINITANDEM_CARDS;})();
const card=(id,extra={})=>({id,name:id,town:'Testdorf',region:'sense',status:'active',events:[],days:[],min:null,max:null,languages:[],category:'play',format:'group',
  age:'x',parent:'unknown',schedule:'Sat 10:00–11:00',price:'Free',priceKind:'free',notes:[],contacts:[],sources:[],practical:{},...extra});
// The real interface modules over a list of cards, as they are wired in the page.
function over(cards,lang='en'){
  const S=loadStack({...clock,lang}),{window:W,t,P,F}=S;
  const C=W.MinitandemCatalogue.create({activities:cards,regions:{sense:'Sense'},towns:{},planning:P,clock:{today:()=>clock.today,nowHm:()=>clock.nowHm},t});
  const state={view:'catalog',f:W.MinitandemCatalogue.defaultFilters(),near:null,weekOpen:new Set()};
  const V=W.MinitandemViews.create({t,C,P,X:W.MinitandemExchange,F,store:{personal:{favorites:[],age:null}},state:()=>state});
  return {...S,C,V,state,ids:age=>C.filter(state.f,{age}).map(a=>a.id)};
}

test('age 0 is the first year: an offer that starts below 1 year fits, one that starts at 1 does not, and unknown or uncertain bounds keep their rules',()=>{
  const cards=[card('m033',{min:0.33,max:4}),card('m05',{min:0.5}),card('m0',{min:0,max:3}),card('m1',{min:1,max:3}),card('mnull',{min:null,max:null}),
    card('mnullmax',{min:null,max:3}),card('exception',{min:null,ageException:true}),card('uncertain',{min:0,max:4,ageUpperUncertainFrom:0})];
  const {C,P,ids,state}=over(cards);
  const fit=id=>C.ageFit(C.byId.get(id),0);
  assert.deepEqual(['m033','m05','m0','m1','mnull','mnullmax','exception','uncertain'].map(fit),[true,true,true,false,null,null,true,null]);
  // The list: what fits or is to be confirmed stays; what the published limits exclude goes; "leave out unknown ages" drops the undecided ones.
  assert.deepEqual(ids(0).sort(),['exception','m0','m033','m05','mnull','mnullmax','uncertain']);
  state.f.includeUnknownAge=false;
  assert.deepEqual(ids(0).sort(),['exception','m0','m033','m05']);
  // Age 1 and above work as before: a minimum of 0.33 or 0.5 is behind a one-year-old, a minimum of 1 is reached.
  assert.deepEqual([1,2].map(age=>['m033','m05','m1'].map(id=>C.ageFit(C.byId.get(id),age))),[[true,true,true],[true,true,true]]);
  assert.equal(C.ageFit(C.byId.get('m033'),null),null);
  // The reasons the page gives agree with the filter.
  const reasons=id=>Array.from(P.matchReasons(C.byId.get(id),0,false,false,null));
  assert.deepEqual(['m033','m05','m0','m1','uncertain'].map(reasons),[['ageInRange'],['ageInRange'],['ageInRange'],['ageToConfirm'],['ageToConfirm']]);
  // A card for older children stays "for later" until the age reaches its minimum; age 0 reaches a minimum below 1.
  const later=[card('later05',{status:'future',min:0.5}),card('later1',{status:'future',min:1})];
  const L=over(later).C;
  assert.deepEqual(later.map(a=>L.statusOf(a,0)),['check','future']);
});

test('the real Dylan card (4 months to 4 years) is found with "under 1" in all three languages; the list shows the age in months',()=>{
  const S=loadStack(clock),dylan=S.byId.get('swim-courtepin-babies');
  assert.equal(dylan.min,0.33);assert.equal(dylan.max,4);assert.equal(S.C.isArchive(dylan),false);
  for(const [lang,query,months,years] of [['en','dylan','4 months','4 years'],['de','dylan','4 Monate','4 Jahre'],['fr','bébé nageur','4 mois','4 ans']]){
    const A=loadStack({...clock,lang}),CI=A.window.MinitandemCatalogueI18n,shown=lang==='en'?null:CI.overlay(A.records,files[lang],A.window.MinitandemViews.PRACTICAL_ORDER);
    if(shown)A.C.setLocalText(shown.text);
    A.state.f.query=query;
    const ids=age=>A.C.filter(A.state.f,{age}).map(a=>a.id);
    assert.ok(ids(null).includes(dylan.id),lang+': found without an age');
    assert.ok(ids(0).includes(dylan.id),lang+': found with "under 1"');
    assert.ok(ids(1).includes(dylan.id),lang+': and with 1 year');
    A.store.personal.age=0;
    const V=shown?A.window.MinitandemViews.create({t:A.t,C:A.C,P:A.P,X:A.X,F:A.F,store:A.store,state:()=>A.state,shown:shown.card,inEnglish:a=>!shown.translated(a)}):A.V;
    const row=V.row(dylan),slot=row.match(/<span class="r-age[^"]*">(?:<svg[\s\S]*?<\/svg><span class="sr">[^<]*<\/span>)?([^<]*)<\/span>/)[1];
    assert.equal(slot,`${months}–${years}`,lang+': the row says months, not 0.33');
    assert.ok(!/0[.,]33/.test(row)&&!/0[.,]33/.test(V.detail(dylan).match(/<dd>[^]*?<\/dd>/g).join('')),lang+': no decimal fraction of a year');
    assert.ok(V.detail(dylan).includes(`${months}–${years}`),lang+': the card page names the published limits in months');
  }
});

test('ages below two years read in months in English, German and French; a whole year or 2 years and more stays in years',()=>{
  const read=(lang,min,max)=>{const {F}=loadStack({...clock,lang});return F.ageShort({min,max});};
  const rows=[[0.33,null,'From 4 months','Ab 4 Monaten','Dès 4 mois'],[0.5,null,'From 6 months','Ab 6 Monaten','Dès 6 mois'],[1.5,null,'From 18 months','Ab 18 Monaten','Dès 18 mois'],
    [1,null,'From 1 year','Ab 1 Jahr','Dès 1 an'],[3.5,null,'From 3.5 years','Ab 3.5 Jahren','Dès 3,5 ans'],
    [0.33,4,'4 months–4 years','4 Monate–4 Jahre','4 mois–4 ans'],[0.5,12,'6 months–12 years','6 Monate–12 Jahre','6 mois–12 ans'],[1.5,3,'18 months–3 years','18 Monate–3 Jahre','18 mois–3 ans'],
    [0.5,1,'6–12 months','6–12 Monate','6–12 mois'],[0,0.5,'Up to 6 months','Bis 6 Monate','Jusqu’à 6 mois'],[null,1.5,'Up to 18 months','Bis 18 Monate','Jusqu’à 18 mois'],
    [2,4.5,'2–4.5 years','2–4.5 Jahre','2–4,5 ans'],[2,4,'2–4 years','2–4 Jahre','2–4 ans'],[0,3,'Up to 3 years','Bis 3 Jahre','Jusqu’à 3 ans']];
  for(const [min,max,en,de,fr] of rows)assert.deepEqual(['en','de','fr'].map(lang=>read(lang,min,max)),[en,de,fr],`${min}–${max}`);
  // Every committed card with a bound under 2 years that is not a whole year is worded in months, never as a decimal fraction.
  const S=loadStack(clock);
  for(const a of S.records.filter(a=>[a.min,a.max].some(v=>v!==null&&v<2&&!Number.isInteger(v))))assert.match(S.F.ageShort(a),/month/,a.id);
});

test('the three dictionaries hold the same month keys, each with both plural forms',()=>{
  const {window:W}=loadStack(clock),keys=lang=>Object.keys(W.MINITANDEM_STRINGS[lang]).filter(k=>/^age\.(?:from|upTo|range)Months/.test(k)).sort();
  assert.deepEqual(keys('en'),['age.fromMonths_one','age.fromMonths_other','age.rangeMonthsYears_one','age.rangeMonthsYears_other','age.rangeMonths_one','age.rangeMonths_other','age.upToMonths_one','age.upToMonths_other'].sort());
  assert.deepEqual(keys('de'),keys('en'));assert.deepEqual(keys('fr'),keys('en'));
});
