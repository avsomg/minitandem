// "Today", "this weekend" and "next 7 days" with weekly hours, the time a schedule gives for one weekday, the distance limit, and the
// category tiles of the rows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {loadStack,root} from './test-support.mjs';

const S=loadStack();
const {K,P}=S;
const ids=items=>Array.from(items,a=>a.id).sort();
const plain=value=>JSON.parse(JSON.stringify(value));
const card=(id,extra={})=>({id,name:id,town:'Testdorf',region:'sense',status:'active',events:[],days:[],min:null,max:null,languages:[],category:'play',format:'group',
  priceKind:'free',parent:'yes',notes:[],sources:[],practical:{},checked:'2026-10-01',reviewAfter:'2026-12-31',address:'',schedule:'',price:'',age:'',...extra});
// A catalogue of made-up cards on a given Swiss date and time.
const at=(cards,today,nowHm='10:00',towns={})=>K.create({activities:cards,regions:{sense:'Sense'},towns,planning:P,clock:{today:()=>today,nowHm:()=>nowHm}});
const filtered=(C,when,extra={})=>ids(C.filter({...K.defaultFilters(),when,...extra},{view:'catalog',...extra.context}));

test('today counts dated sessions not over yet and cards that repeat on this weekday while valid; places apart from groups',()=>{
  const cards=[card('ended',{events:[{date:'2026-10-14',start:'08:00',end:'09:00'}]}),card('later',{events:[{date:'2026-10-14',start:'14:00',end:'16:00'}]}),
    card('wed group',{days:[3]}),card('wed place',{days:[3],format:'self'}),card('thu group',{days:[4]}),card('expired',{days:[3],scheduleValidThrough:'2026-10-13'}),
    card('valid today',{days:[3],scheduleValidThrough:'2026-10-14'}),card('closed',{days:[3],status:'closed'}),card('dated on wed',{days:[3],events:[{date:'2026-10-21',start:'09:00'}]})];
  const C=at(cards,'2026-10-14','10:00');
  assert.deepEqual(filtered(C,'today'),['later','valid today','wed group','wed place']);
  const info=id=>plain(C.whenInfo(cards.find(a=>a.id===id),{when:'today'}));
  assert.deepEqual(info('later'),{date:'2026-10-14',kind:'session'});
  assert.deepEqual(info('wed group'),{date:'2026-10-14',kind:'regular'});
  assert.deepEqual(info('wed place'),{date:'2026-10-14',kind:'place'});
  assert.equal(info('ended'),null,'a session that is over does not count today');
  assert.equal(info('dated on wed'),null,'a card with dated sessions counts by its dates, not its weekdays');
  // "Has upcoming dates" still counts published dates only.
  assert.deepEqual(filtered(C,'upcoming'),['dated on wed','later']);
});

test('this weekend: Saturday and Sunday ahead; on a Saturday both days; on a Sunday only that day',()=>{
  const cards=[card('sat',{days:[6]}),card('sun',{days:[7]}),card('mon',{days:[1]}),card('sat session',{events:[{date:'2026-10-17',start:'10:00'}]})];
  assert.deepEqual(plain(at(cards,'2026-10-14').whenDates('weekend')),['2026-10-17','2026-10-18']);
  assert.deepEqual(filtered(at(cards,'2026-10-14'),'weekend'),['sat','sat session','sun']);
  assert.deepEqual(plain(at(cards,'2026-10-17').whenDates('weekend')),['2026-10-17','2026-10-18']);
  assert.deepEqual(plain(at(cards,'2026-10-18').whenDates('weekend')),['2026-10-18']);
  assert.deepEqual(filtered(at(cards,'2026-10-18'),'weekend'),['sun'],'on Sunday the Saturday is over');
  // The next 7 days run across the weekend into the following week.
  assert.deepEqual(plain(at(cards,'2026-10-17').whenDates('week')),['2026-10-17','2026-10-18','2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23']);
  assert.deepEqual(filtered(at(cards,'2026-10-17'),'week'),['mon','sat','sat session','sun']);
});

test('the week view and the day filters agree on every day of the real catalogue',()=>{
  const {C,state,list}=loadStack();
  for(const when of ['today','weekend','week']){
    state.f=K.defaultFilters();state.f.when=when;
    const listed=ids(list()),days=C.week(list(),state.f),inWeek=ids(C.weekCards(days));
    assert.deepEqual(inWeek,listed,when);
    assert.ok(listed.length>20,when+': regular groups and opening hours make it more than a few dated sessions');
  }
});

test('the time a schedule gives for one weekday is read only when the text says it plainly',()=>{
  const slot=K.scheduleSlot;
  assert.equal(slot('Mon–Sat 07:00–21:00; Sun 07:00–19:00',7),'07:00–19:00');
  assert.equal(slot('Mon–Sat 07:00–21:00; Sun 07:00–19:00',6),'07:00–21:00');
  assert.equal(slot('Tue, Thu, Fri 14:00–18:00 · Wed 10:00–18:00 · Sat 10:00–16:00. Closed 16–21.11.2026',3),'10:00–18:00');
  assert.equal(slot('Mon 08–17; Tue–Thu 08–14; Fri 08–22',3),'08–14');
  assert.equal(slot('Fri–Mon 10:00–17:00',7),'10:00–17:00','a range across the weekend');
  assert.equal(slot('Wednesday 14:00–17:00 · autumn 01.09–20.12.2026',3),'14:00–17:00','a date range is not a time');
  assert.equal(slot('According to the centre’s page: daily, Mon–Fri 09–22, Sat–Sun 09–20',6),'09–20','each time with the days right before it');
  assert.equal(slot('Tue 15–18; Wed 09–11:30 and 13:30–18:30; Fri 15–19; 2nd and 4th Sat 09–11:30',3),'09–11:30, 13:30–18:30');
  assert.equal(slot('Tue 15–18; Wed 09–11:30 and 13:30–18:30; Fri 15–19; 2nd and 4th Sat 09–11:30',6),null,'the 2nd and 4th Saturday only');
  assert.equal(slot('Daily 10–18 until 31.10; 10–17 from 01.11',6,'2026-10-17'),'10–18');
  assert.equal(slot('Daily 09–18:30 until 30.09; after that the hours change by season',6,'2026-10-17'),null,'hours that ended before the date');
  for(const [text,day] of [['2nd and 4th Saturday 09:00–11:30',6],['Monday to Saturday by individual arrangement',2],['Wed–Sat 09:00–23:00; Mon–Tue closed',1],
    ['In winter daily 09:00–12:00',3],['Saturday · 09:30–10:30 or 10:45–11:45',6],['Tuesday 10:00–11:00',3]])assert.equal(slot(text,day),null,text);
});

test('under a day filter a row marks weekly hours and shows the slot of the matching weekday, else the whole schedule',()=>{
  const {window:W,t,I}=loadStack();
  const cards=[card('Cafe',{format:'self',category:'dining',days:[1,2,3,4,5,6,7],schedule:'Mon–Sat 07:00–21:00; Sun 07:00–19:00'}),
    card('Group',{days:[7],schedule:'2nd and 4th Sunday 10:00–12:00'})];
  const C=K.create({activities:cards,regions:{sense:'Sense'},towns:{},planning:P,clock:{today:()=>'2026-10-18',nowHm:()=>'10:00'},t});
  const F=W.MinitandemFormat.create({t,locale:I.locale}),state={view:'catalog',f:{...K.defaultFilters(),when:'today'},near:null,weekOpen:new Set()};
  const V=W.MinitandemViews.create({t,C,P,X:W.MinitandemExchange,F,store:{personal:{favorites:[],age:null}},state:()=>state});
  const html=V.rows(C.filter(state.f,{view:'catalog'}));
  assert.ok(html.includes(`<b>${V.esc(t('week.hoursMark'))}</b> · <span>Sun 07:00–19:00</span>`),'the Sunday slot, not Monday to Saturday');
  assert.ok(html.includes(`<b>${V.esc(t('week.regularMark'))}</b> · <span>2nd and 4th Sunday 10:00–12:00</span>`),'a rule the slot cannot express: the whole schedule');
  state.f.when='';
  assert.ok(!V.rows(cards).includes(V.esc(t('week.hoursMark'))),'without a day filter the row is as before');
});

test('no dead end: an empty day filter offers what the same day finds without the other filters',()=>{
  const {V,t}=loadStack();
  const some=V.empty('when',{n:23,when:'weekend',keepsAge:true});
  assert.ok(some.includes(V.esc(t('empty.whenAlt',{n:23,when:t('when.weekend')}))));
  assert.match(some,/data-action="when-only"/);
  assert.ok(V.empty('when',{n:0,when:'today'}).includes(V.esc(t('empty.whenNone',{when:t('when.today')}))));
  assert.match(t('note.whenRegular'),/Holidays and closures are not in the data/);
});

test('distance limit: a checked address point, else the town centre; unknown distances are left out while it is on',()=>{
  const home={lat:46.8,lon:7.15},north=km=>({lat:home.lat+km/111.195,lon:home.lon});
  const cards=[card('exact3',{town:'Weit',geo:north(3)}),card('centre8',{town:'Weit'}),card('centre25',{town:'Fern'}),card('unknown',{town:'Nirgendwo'})];
  const C=at(cards,'2026-10-14','10:00',{Weit:north(8),Fern:north(25)});
  const within=(radius,near=home)=>ids(C.filter({...K.defaultFilters(),radius},{view:'catalog',near}));
  assert.deepEqual(within(5),['exact3']);
  assert.deepEqual(within(10),['centre8','exact3']);
  assert.deepEqual(within(30),['centre25','centre8','exact3']);
  assert.deepEqual(within(0),['centre25','centre8','exact3','unknown'],'no limit: every card');
  assert.deepEqual(within(5,null),['centre25','centre8','exact3','unknown'],'no point: the limit has no effect');
  assert.equal(C.activeCount({...K.defaultFilters(),radius:10},null),1);
  assert.deepEqual([5,7,'20',-1,'x'].map(r=>S.C.restoreFilters({radius:r}).radius),[5,0,20,0,0]);
  assert.deepEqual(plain(K.RADIUS_KEYS),[0,5,10,20,30]);
});

test('every category has its Phosphor icon in three weights, its own ink, and the ink reaches 4.5:1 on the row and on hover',()=>{
  const css=fs.readFileSync(path.join(root,'styles.css'),'utf8'),icons=S.window.MinitandemCategoryIcons;
  const lum=hex=>{const c=hex.match(/\w\w/g).map(x=>parseInt(x,16)/255).map(v=>v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4);return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];};
  const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
  const inks=new Set();
  assert.deepEqual(Object.keys(icons.ICONS).sort(),[...K.CATEGORY_KEYS].sort(),'one icon set per category, no more');
  for(const category of K.CATEGORY_KEYS){
    for(const weight of ['fill','duotone','regular'])assert.match(icons.ICONS[category][weight],/^<path d="M[\d.,\sA-Za-z-]+"(?: opacity="0\.2")?\/>/,`${category} ${weight}`);
    assert.match(icons.ICONS[category].duotone,/opacity="0\.2"/,category+': the duotone layer');
    const rule=css.match(new RegExp(`\\.c-${category} \\{ --ink: (#[0-9a-f]{6}); --tint: (#[0-9a-f]{6}); \\}`));
    assert.ok(rule,category+' has an ink and a tint');
    for(const ground of ['#f6f6f6','#ececec'])assert.ok(ratio(rule[1],ground)>=4.5,`${category} on ${ground}: ${ratio(rule[1],ground).toFixed(2)}:1`);
    assert.ok(ratio(rule[1],rule[2])>=3,category+' on its tile');
    inks.add(rule[1]);
  }
  assert.equal(inks.size,K.CATEGORY_KEYS.length,'each category its own hue');
  assert.ok(fs.readFileSync(path.join(root,'assets/PHOSPHOR-LICENSE'),'utf8').replace(/\r\n/g,'\n').startsWith('MIT License\n\nCopyright (c) 2023 Phosphor Icons'));
});

test('one switch selects the icon variant: E by default (fill, no tile, coloured word); A to E each render and have their CSS',()=>{
  const {V,byId,t,window:W}=loadStack(),icons=W.MinitandemCategoryIcons,a=byId.get('aef-attalens');
  assert.equal(icons.VARIANT,'E');
  assert.deepEqual(plain(icons.VARIANTS),{A:{weight:'duotone',tile:true,word:false},B:{weight:'fill',tile:false,word:false},C:{weight:'regular',tile:true,word:false},
    D:{weight:'duotone',tile:true,word:true},E:{weight:'fill',tile:false,word:true}});
  const row=V.row(a);
  assert.match(row,new RegExp(`<a class="row c-${a.category}" [^>]*><span class="cat-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">`));
  assert.ok(row.includes(icons.ICONS[a.category].fill),'E draws the fill weight');
  assert.ok(row.includes(`<span class="r-catname">${V.esc(t('category.'+a.category))}</span>`),'the word stays');
  for(const [variant,weight,size] of [['A','duotone',24],['B','fill',26],['C','regular',24],['D','duotone',24]]){
    icons.VARIANT=variant;
    const html=V.row(a);
    assert.ok(html.includes(icons.ICONS[a.category][weight])&&html.includes(`width="${size}"`),variant);
  }
  icons.VARIANT='E';
  const css=fs.readFileSync(path.join(root,'styles.css'),'utf8');
  assert.match(css,/\[data-icons="A"\] \.cat-icon, \[data-icons="C"\] \.cat-icon, \[data-icons="D"\] \.cat-icon \{[^}]*background: var\(--tint\)/,'A, C and D: the tile');
  assert.match(css,/\[data-icons="D"\] \.r-catname, \[data-icons="E"\] \.r-catname \{ color: var\(--ink\)/,'D and E: the coloured word');
  assert.match(css,/\.cat-icon \{ grid-area: tile; align-self: center;/,'centred vertically on the row');
  assert.match(fs.readFileSync(path.join(root,'app.js'),'utf8'),/document\.body\.dataset\.icons = W\.MinitandemCategoryIcons\?\.VARIANT/);
});
