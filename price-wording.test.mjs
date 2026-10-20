// An unknown price is said once by the interface, and "1 card" is not "1 cards".
// Real cards in three languages come with the wiring app.js gives them; invented cards test each wording.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {loadStack,root} from './test-support.mjs';

const clock={today:'2026-10-17',nowHm:'10:00'};
const files=(()=>{const context={window:{}};for(const lang of ['de','fr'])vm.runInNewContext(fs.readFileSync(path.join(root,`data-${lang}.js`),'utf8'),context);return context.window.MINITANDEM_CARDS;})();
const card=(id,extra={})=>({id,name:id,town:'Testdorf',region:'sense',status:'active',events:[],days:[1,2,3,4,5,6,7],min:null,max:null,languages:[],category:'play',format:'self',
  age:'x',parent:'unknown',schedule:'',price:'Free',priceKind:'free',notes:[],contacts:[],sources:[],practical:{},...extra});
const price=html=>html.match(/<span class="r-price[^"]*"[^>]*>([\s\S]*?)<\/span>/)[1];
function real(lang){
  const S=loadStack({...clock,lang});
  if(lang==='en')return S;
  const shown=S.window.MinitandemCatalogueI18n.overlay(S.records,files[lang],S.window.MinitandemViews.PRACTICAL_ORDER);
  S.C.setLocalText(shown.text);
  return {...S,V:S.window.MinitandemViews.create({t:S.t,C:S.C,P:S.P,X:S.X,F:S.F,store:S.store,state:()=>S.state,shown:shown.card,inEnglish:a=>!shown.translated(a)})};
}
const PHRASE={en:'Price not published',de:'Preis nicht veröffentlicht',fr:'Prix non publié'};
// The wordings the catalogue uses for "the price is not published" (design-raw/price-variants.json of the review of 17 October 2026).
const PLACEHOLDERS=['Price not published','Price not published.','Price is not published','Price is not published.','The price is not published.','The entrance price is not published','Entry price not published','The cost of access is not stated.'];

test('every wording of "the price is not published" is one phrase in the list and in the shared text, in each language',()=>{
  for(const lang of ['en','de','fr']){
    const S=loadStack({...clock,lang});
    for(const text of PLACEHOLDERS){
      const a=card('p',{price:text,priceKind:'unknown'});
      assert.equal(price(S.V.rows([a])),PHRASE[lang],lang+': '+text);
      assert.equal(S.F.priceShort(a),PHRASE[lang]);
    }
  }
});

test('a text that carries something is shown as written, and a known price is never replaced',()=>{
  const {V,F}=loadStack(clock);
  for(const text of ['Check the price','Free walk; no tariff stated','According to the menu; dish prices are not published','Summer menu 2026: coffee CHF 4.50','Payment for what is picked, by weight or quantity; prices are not given',
    'Price not published; coffee CHF 4','No price not published here','Entry price not published yet']){
    const a=card('p',{price:text,priceKind:'unknown'});
    assert.equal(price(V.rows([a])),V.esc(F.first(text)),text);
    assert.equal(F.noPrice(a),false,text);
  }
  const known=card('k',{price:'Price is not published.',priceKind:'visit'});
  assert.equal(F.noPrice(known),false,'only a price of an unknown kind is the placeholder');
  assert.equal(price(V.rows([known])),'Price is not published.');
  assert.equal(price(V.rows([card('f',{price:'Free',priceKind:'free'})])),'Free');
  assert.match(V.rows([card('p',{price:'Price not published.',priceKind:'unknown'})]),/class="r-price"/,'it keeps the grey of an unknown price');
});

test('the list clamps the organiser\'s own words in the price slot and never the interface phrase for an unknown price',()=>{
  const {V}=loadStack(clock);
  assert.match(V.rows([card('o',{price:'Summer menu 2026: coffee CHF 4.50',priceKind:'unknown'})]),/class="r-price own"/);
  assert.match(V.rows([card('f',{price:'Free',priceKind:'free'})]),/class="r-price known own"/);
  assert.doesNotMatch(V.rows([card('p',{price:'Price not published.',priceKind:'unknown'})]),/class="r-price[^"]* own"/);
  const css=fs.readFileSync(path.join(root,'styles.css'),'utf8');
  assert.match(css,/\.r-price\.own \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/);
  assert.doesNotMatch(css,/\.r-age[^{]*\{[^}]*-webkit-line-clamp/,'the age slot holds interface phrases and grows with them');
});

test('the card page keeps the organiser\'s wording of an unknown price',()=>{
  const {V}=loadStack(clock);
  for(const text of PLACEHOLDERS)assert.ok(V.detail(card('p',{price:text,priceKind:'unknown'})).includes(V.esc(text)),text);
});

test('the real catalogue: one phrase for the placeholder in every language, with the translated cards too',()=>{
  const english=loadStack(clock).records,placeholder=a=>a.priceKind==='unknown'&&PLACEHOLDERS.includes(a.price);
  const cards=english.filter(placeholder);
  assert.ok(cards.length>100,'most unknown prices are the placeholder');
  for(const lang of ['en','de','fr']){
    const {V,byId,F}=real(lang);
    const shown=new Set(cards.map(a=>price(V.rows([byId.get(a.id)]))));
    assert.deepEqual([...shown],[PHRASE[lang]],lang);
    // Nothing else changes: every other unknown price is the card's own first part.
    for(const a of english.filter(a=>a.priceKind==='unknown'&&!placeholder(a)))assert.equal(F.noPrice(V.shown(byId.get(a.id))),false,lang+' '+a.id);
  }
});

test('"1 activity" and "2 activities": the counted sentences have a singular and a plural in every language',()=>{
  const en=loadStack({lang:'en'}).t,de=loadStack({lang:'de'}).t,fr=loadStack({lang:'fr'}).t;
  const note=(t,fits)=>t('note.age',{age:'2',fits,unknown:9,n:fits});
  assert.equal(note(en,1),'Age 2: 1 activity with a matching age limit, 9 without a clear age limit.');
  assert.equal(note(en,2),'Age 2: 2 activities with a matching age limit, 9 without a clear age limit.');
  assert.equal(note(en,0),'Age 2: 0 activities with a matching age limit, 9 without a clear age limit.');
  assert.equal(note(de,1),'Alter 2: 1 mit passender Altersgrenze, 9 ohne klare Altersgrenze.');
  assert.equal(note(fr,1),'Âge 2\u00a0: 1 avec une limite d’âge compatible, 9 sans limite d’âge claire.');
  // The map caption is a label with two numbers, so it needs no agreement with either of them.
  assert.equal(en('map.caption',{located:1,total:1,n:1}),'Activities on the map: 1 of 1. Several activities can be in one building.');
  assert.match(en('map.caption',{located:3,total:5,n:5}),/^Activities on the map: 3 of 5\./);
  assert.match(de('map.caption',{located:1,total:1,n:1}),/^Angebote auf der Karte: 1 von 1\./);
  assert.match(de('map.caption',{located:3,total:5,n:5}),/^Angebote auf der Karte: 3 von 5\./);
  assert.equal(en('map.cluster',{n:1}),'1 activity; zoom in to see it');assert.equal(en('map.cluster',{n:12}),'12 activities; zoom in to see them');
  assert.equal(de('map.cluster',{n:1}),'1 Angebot; zum Anzeigen hineinzoomen');assert.equal(de('map.cluster',{n:12}),'12 Angebote; zum Anzeigen hineinzoomen');
  assert.equal(fr('map.cluster',{n:1}),'Groupe de 1 activité\u00a0; zoomez pour la voir');assert.equal(fr('map.cluster',{n:12}),'Groupe de 12 activités\u00a0; zoomez pour les voir');
  // The map page on the screen: one card.
  const S=loadStack(clock);
  assert.ok(S.V.mapBox([S.byId.get('mpe')]).includes('<p class="hint">Activities on the map: 1 of 1.'));
  assert.ok(S.V.mapBox([S.byId.get('mpe'),S.byId.get('museum')]).includes('<p class="hint">Activities on the map: 2 of 2.'));
});

test('no English sentence counts cards without a singular and a plural; French keeps its no-break space before : ; ? !',()=>{
  const {window:W}=loadStack(),en=W.MINITANDEM_STRINGS.en,fr=W.MINITANDEM_STRINGS.fr;
  for(const [key,text] of Object.entries(en))if(/\{\w+\}\s+cards?\b/.test(text))assert.ok(/_(one|other)$/.test(key),key+' counts cards but has one form');
  for(const key of Object.keys(fr).filter(k=>/^(note\.age|map\.caption|map\.cluster|data\.tripNone)/.test(k)))assert.doesNotMatch(fr[key],/ [:;?!]/,key);
});
