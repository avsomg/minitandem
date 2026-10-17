// The time line of a list row shows the first part of the opening hours. It must never read as the whole hours: a marker says that more
// times follow, and under a chosen weekday the row names that day's time. Real cards: Piscine de Morat and the Epagny aerodrome restaurant.
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
// The time line of a row: its markup, and its words.
const when=html=>html.match(/<span class="r-when([^"]*)">([\s\S]*?)<\/span><span class="r-status/);
const words=html=>when(html)[2].replace(/<[^>]+>/g,'');
// The real catalogue with one language's card texts, wired as app.js wires them.
function real(lang){
  const S=loadStack({...clock,lang});
  if(lang==='en')return S;
  const shown=S.window.MinitandemCatalogueI18n.overlay(S.records,files[lang],S.window.MinitandemViews.PRACTICAL_ORDER);
  S.C.setLocalText(shown.text);
  return {...S,V:S.window.MinitandemViews.create({t:S.t,C:S.C,P:S.P,X:S.X,F:S.F,store:S.store,state:()=>S.state,shown:shown.card,inEnglish:a=>!shown.translated(a)})};
}
function over(cards){
  const S=loadStack(clock),{window:W,t,P,F}=S;
  const C=W.MinitandemCatalogue.create({activities:cards,regions:{sense:'Sense'},towns:{},planning:P,clock:{today:()=>clock.today,nowHm:()=>clock.nowHm},t});
  const state={view:'catalog',f:W.MinitandemCatalogue.defaultFilters(),near:null,weekOpen:new Set()};
  return {...S,C,state,V:W.MinitandemViews.create({t,C,P,X:W.MinitandemExchange,F,store:{personal:{favorites:[],age:null}},state:()=>state})};
}

test('a schedule that goes on with more days or times is only ever shown with a marker: Piscine de Morat and the Epagny restaurant, three languages',()=>{
  const expected={
    en:{pool:'Mon 14:00–21:00 + more times',restaurant:'Wed–Thu 09:00–22:00 + more times'},
    de:{pool:'Mo 14:00–21:00 + weitere Zeiten',restaurant:'Mi–Do 09:00–22:00 + weitere Zeiten'},
    fr:{pool:'lun. 14:00–21:00 + autres horaires',restaurant:'mer.–jeu. 09:00–22:00 + autres horaires'}};
  for(const lang of ['en','de','fr']){
    const {V,byId,t}=real(lang);
    assert.equal(t('time.more'),expected[lang].pool.slice(expected[lang].pool.indexOf('+')));
    for(const [key,id] of [['pool','murten-family-pool'],['restaurant','aerodrome-epagny-play']]){
      const html=V.rows([byId.get(id)]);
      assert.equal(words(html),expected[lang][key],lang+' '+id);
      assert.match(when(html)[1],/is-wrap/,lang+' '+id+': the line may wrap, so the marker is never cut off');
      assert.ok(V.hoursLine(V.shown(byId.get(id))).endsWith(t('time.more')),lang+' '+id+': the shared text carries the marker too');
    }
  }
});

test('no marker when nothing is hidden: a remark after the semicolon, a schedule without one, dated sessions',()=>{
  const cards=[card('remark',{schedule:'Friday 15:00–17:30; except school holidays and public holidays'}),card('single',{schedule:'Wednesday 14:00–14:30 · cycle 23.09–09.12.2026'}),
    card('unknown',{schedule:'Public place; opening hours not published'}),card('closedday',{schedule:'Wed–Sat 09:00–23:00; Mon–Tue closed'}),
    card('later',{schedule:'Mon 09–22; Tue–Thu 09–23:30; Fri–Sat 09–00; Sun closed'}),card('lateroneday',{schedule:'Tue–Fri 09–18; Sat–Mon closed'}),
    card('dated',{schedule:'Sat 10:00–11:00; Sun 10:00–11:00',days:[],events:[{date:'2026-10-24',start:'10:00',end:'11:00'}]})];
  const {V}=over(cards),line=id=>words(V.rows([cards.find(a=>a.id===id)]));
  assert.equal(line('remark'),'Friday 15:00–17:30');
  assert.equal(line('single'),'Wednesday 14:00–14:30 · cycle 23.09–09.12.2026');
  assert.equal(line('unknown'),'Public place');
  assert.equal(line('closedday'),'Wed–Sat 09:00–23:00 + more times');
  assert.equal(line('later'),'Mon 09–22 + more times');
  assert.equal(line('lateroneday'),'Tue–Fri 09–18 + more times','a hidden closed day is a hidden day');
  assert.match(line('dated'),/^Next: Sat 24 Oct/,'a card with a published date shows the date, as before');
  assert.ok(!line('dated').includes('more times'));
});

test('under a chosen weekday the row names the time of that day; what the text does not say plainly keeps the first part and its marker',()=>{
  const cards=[card('pool',{schedule:'Mon 14:00–21:00; Tue 06:00–21:00; Wed–Fri 09:30–21:00; Sat–Sun 09:30–18:00'}),
    card('ended',{schedule:'Mon–Fri 09–18; Sat–Sun 10–17 until 11.10.2026'}),card('monthly',{schedule:'Sat 09:30–11:00; 1st Tue 17:30–18:30'}),
    card('seasonal',{schedule:'Mon–Fri 09:00–17:00; Sat 10:00–14:00',scheduleValidThrough:'2026-10-16'})];
  const {V,state}=over(cards),line=id=>words(V.rows([cards.find(a=>a.id===id)]));
  state.f.days=new Set([7]);
  assert.equal(line('pool'),'Sun 09:30–18:00');
  state.f.days=new Set([6,3]);
  assert.equal(line('pool'),'Wed 09:30–21:00 · Sat 09:30–18:00','several weekdays: each one, in the order of the week');
  assert.equal(line('monthly'),'Sat 09:30–11:00 + more times','a rule a weekday cannot express: the first part and the marker');
  state.f.days=new Set([2]);
  assert.equal(line('monthly'),'Sat 09:30–11:00 + more times');
  state.f.days=new Set([7]);
  assert.equal(line('ended'),'Mon–Fri 09–18 + more times','a clause that ended before the day: not claimed');
  assert.equal(line('seasonal'),'Mon–Fri 09:00–17:00 + more times','a schedule valid through an earlier date: not claimed');
  // With the day filter "next 7 days" the date named is a chosen weekday, not the first day that matches.
  state.f.days=new Set();state.f.when='week';
  assert.ok(V.rows([cards[0]]).includes('<span>Sat 09:30–18:00</span>'),'today is a Saturday');
  state.f.days=new Set([7]);
  assert.ok(V.rows([cards[0]]).includes('<span>Sun 09:30–18:00</span>'),'Sunday was chosen');
  state.f.days=new Set([1]);
  assert.ok(V.rows([cards[0]]).includes('<span>Mon 14:00–21:00</span>'),'Monday was chosen');
});

test('the real Morat pool shows the time of the chosen day in all three languages',()=>{
  const expected={en:'Sun 09:30–18:00',de:'So 09:30–18:00',fr:'Dim 09:30–18:00'};
  for(const lang of ['en','de','fr']){
    const {V,byId,state}=real(lang);
    state.f.days=new Set([7]);
    assert.equal(words(V.rows([byId.get('murten-family-pool')])),expected[lang],lang);
  }
});
