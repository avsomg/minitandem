// Near me, this week and the rainy-day filter: the pure logic in catalogue.js, its markup in views.js, the remembered town in
// store.js and the generated town centres in data-towns.js. The clock stands at Wednesday 14 October 2026, 10:00 (Swiss time).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {loadStack,root} from './test-support.mjs';

const S=loadStack();
const {K,P}=S;
const ids=items=>Array.from(items,a=>a.id);
// Arrays made inside the loaded modules belong to another realm; compare their plain copies.
const plain=value=>JSON.parse(JSON.stringify(value));
// A made-up card with everything the logic reads; extra overrides.
const card=(id,extra={})=>({id,name:id,town:'Testdorf',region:'sense',status:'active',events:[],days:[],min:null,max:null,languages:[],category:'play',format:'self',
  priceKind:'free',parent:'yes',notes:[],sources:[],practical:{},checked:'2026-10-01',reviewAfter:'2026-12-31',address:'',schedule:'',price:'',age:'',...extra});
// A small catalogue of made-up cards, with its own town centres, on the test clock.
const catalogue=(activities,towns={})=>K.create({activities,regions:{sense:'Sense'},towns,planning:P,clock:{today:()=>'2026-10-14',nowHm:()=>'10:00'}});
const HOME={lat:46.8,lon:7.15};
// About 1.11 km of latitude per 0.01 degree.
const north=km=>({lat:HOME.lat+km/111.195,lon:HOME.lon});

test('straight-line distance: zero at the point, symmetric, one degree of the equator is about 111.2 km',()=>{
  assert.equal(K.distanceKm(HOME,HOME),0);
  assert.ok(Math.abs(K.distanceKm({lat:0,lon:0},{lat:0,lon:1})-111.195)<0.01);
  const a={lat:46.80555,lon:7.15756},b={lat:46.61892,lon:7.05638};
  assert.equal(K.distanceKm(a,b),K.distanceKm(b,a));
  assert.ok(Math.abs(K.distanceKm(HOME,north(4))-4)<0.01);
  // What a row shows: one decimal under 1 km, never 0, whole kilometres above.
  assert.deepEqual([0.01,0.44,0.96,1.4,4.5,12.6].map(K.roundKm),[0.1,0.4,1,1,5,13]);
});

test('a card is measured to its address point, else to its town centre, else its distance is unknown',()=>{
  const towns={Testdorf:{...north(5),label:'Testdorf'},Nebenort:{...north(2),label:'Nebenort'},Leer:null};
  const exact=card('exact',{geo:{...north(3)},address:'Weg 1, 1700 Testdorf'});
  const area=card('area',{geo:{...north(3)},addressPrecision:'area'});
  const moving=card('moving',{geo:{...north(3)},address:'Weg 1',events:[{date:'2026-10-20',address:'Anderswo 2'}]});
  const town=card('town');
  const twoTowns=card('two',{town:'Testdorf / Nebenort'});
  const unmatched=card('unmatched',{town:'Leer'});
  const unlisted=card('unlisted',{town:'Nirgendwo'});
  const C=catalogue([exact,area,moving,town,twoTowns,unmatched,unlisted],towns);
  const d=a=>C.distanceOf(a,HOME);
  assert.equal(C.distanceOf(exact,null),null,'no point, no distance');
  assert.equal(d(exact).exact,true);assert.ok(Math.abs(d(exact).km-3)<0.01);
  // An area or an address that changes with the date is not an exact point: the town centre stands in, approximately.
  for(const a of [area,moving,town]){assert.equal(d(a).exact,false,a.id);assert.ok(Math.abs(d(a).km-5)<0.01,a.id);}
  assert.ok(Math.abs(d(twoTowns).km-2)<0.01,'a card in two towns takes the nearer one');
  assert.equal(d(unmatched),null,'a town the generator could not match has no distance');
  assert.equal(d(unlisted),null);
  assert.equal(C.townCentre('Leer'),null);assert.equal(C.townCentre('constructor'),null,'no inherited keys');
  assert.deepEqual(plain(C.centreTowns()),['Nebenort','Testdorf']);
});

test('nearest first: exact and approximate distances in one order, unknown last, ties by name; without a point the default order',()=>{
  const towns={Weit:{...north(9)},Nah:{...north(1)},Leer:null};
  const cards=[card('Zeta',{town:'Leer'}),card('Far exact',{town:'Weit',geo:{...north(8)}}),card('Near town',{town:'Nah'}),card('Alpha',{town:'Leer'}),
    card('Far town',{town:'Weit'}),card('Twin B',{town:'Nah',geo:{...north(4)}}),card('Twin A',{town:'Nah',geo:{...north(4)}})];
  const C=catalogue(cards,towns);
  const f={...K.defaultFilters(),sort:'near'};
  assert.deepEqual(ids(C.sortItems(cards.slice(),f,{near:HOME})),['Near town','Twin A','Twin B','Far exact','Far town','Alpha','Zeta']);
  assert.deepEqual(ids(C.sortItems(cards.slice(),f,{near:null})),ids(C.sortItems(cards.slice(),K.defaultFilters(),{})),'no point: the default order');
  // The session keeps "nearest first"; the page drops it when there is no point to measure from.
  assert.equal(S.C.restoreFilters({sort:'near'}).sort,'near');
});

test('the real catalogue: every town on a published card has an entry in data-towns.js, and nearest first orders all cards',()=>{
  const {C,window:W,state,list}=loadStack();
  const towns=W.CATALOG_TOWNS,published=C.activities.filter(a=>!C.isArchive(a));
  const named=new Set(published.flatMap(a=>K.placeNames(a)));
  assert.deepEqual([...named].filter(name=>!Object.hasOwn(towns,name)),[],'a town is missing: run node scripts/compile-towns.mjs');
  for(const [name,c] of Object.entries(towns)){
    if(c===null)continue;
    assert.ok(c.lat>46.3&&c.lat<47.2&&c.lon>6.5&&c.lon<7.8,name+' lies outside the canton');
    assert.match(c.source,/^https:\/\/api3\.geo\.admin\.ch\/rest\/services\/ech\/SearchServer\?/,name);
    assert.match(c.checked,/^\d{4}-\d{2}-\d{2}$/,name);
    assert.ok(['locality','municipality','place'].includes(c.kind),name);
  }
  const plaffeien=C.townCentre('Plaffeien');
  state.near={kind:'town',name:'Plaffeien',lat:plaffeien.lat,lon:plaffeien.lon};
  state.f.sort='near';
  const items=list(),km=items.map(a=>C.distanceOf(a,state.near)?.km??Infinity);
  assert.equal(items.length,published.length);
  for(let i=1;i<km.length;i++)assert.ok(km[i-1]<=km[i],items[i].id);
  assert.ok(km[0]<2,'the first card is in or next to Plaffeien');
});

test('rows show the distance only once a point is set, and say when it is approximate or unknown',()=>{
  const {C,V,state,byId,t}=loadStack();
  const exact=C.activities.find(a=>!C.isArchive(a)&&a.geo&&!a.events.some(e=>e.address&&e.address!==a.address));
  const approximate=C.activities.find(a=>!C.isArchive(a)&&!a.geo&&C.townCentre(a.town));
  assert.ok(!V.row(exact).includes('r-dist'),'no point, no distance');
  state.near={kind:'geo',...exact.geo};
  assert.match(V.row(exact),/<span class="r-dist">≈ 0\.1 km<\/span>/);
  const far=C.distanceOf(approximate,state.near).km;
  assert.ok(far>=1);
  assert.ok(V.row(approximate).includes(`<span class="r-dist">${V.esc(t('near.kmTown',{km:Math.round(far)}))}</span>`));
  assert.match(t('near.kmTown',{km:4}),/^≈ 4 km to the town centre$/);
  const centre=C.townCentre(approximate.town);
  state.near={kind:'town',name:approximate.town,lat:centre.lat,lon:centre.lon};
  assert.ok(V.row(approximate).includes(V.esc(t('near.townUnder1'))),'at the centre itself: under 1 km');
  assert.ok(V.row({...byId.get(exact.id),id:'x',town:'Nowhere',geo:undefined}).includes(V.esc(t('near.unknown'))));
});

test('the weekday convention is 1 = Monday ... 7 = Sunday, the same as the day filter and the cards',()=>{
  assert.equal(K.weekdayOf('2026-10-14'),3,'14 October 2026 is a Wednesday');
  assert.equal(K.weekdayOf('2026-10-18'),7);
  assert.equal(K.weekdayOf('2026-10-19'),1);
  assert.equal(K.addDays('2026-10-31',1),'2026-11-01');
  assert.equal(K.addDays('2026-10-24',1),'2026-10-25','the change to winter time does not skip a date');
  // A real card: "Wednesday 14:00–17:00" is stored as day 3.
  assert.match(S.byId.get('sellenhof-wednesday').schedule,/^Wednesday/);
  assert.deepEqual(plain(S.byId.get('sellenhof-wednesday').days),[3]);
});

test('this week: dated sessions with their time; regular groups and places on their weekdays while their schedule is valid; nothing invented',()=>{
  const dated=card('Dated',{format:'group',days:[3,5],events:[{date:'2026-10-14',start:'09:00',end:'09:30'},{date:'2026-10-14',start:'14:00',end:'16:00'},
    {date:'2026-10-16',start:'10:00'},{date:'2026-10-16'},{date:'2026-10-21',start:'10:00'}]});
  const early=card('Early',{format:'event',events:[{date:'2026-10-16',start:'08:00'}]});
  const group=card('Wednesday group',{format:'group',days:[3]});
  const lesson=card('Wednesday lesson',{format:'individual',days:[3]});
  const place=card('Wednesday place',{format:'self',days:[3,4]});
  const ending=card('Ending place',{format:'self',days:[1,6],scheduleValidThrough:'2026-10-17'});
  const unsure=card('Unsure group',{format:'group',days:[5],status:'check'});
  const overdue=card('Overdue place',{format:'self',days:[5],reviewAfter:'2026-10-01'});
  const later=card('Later group',{format:'group',days:[5],status:'future',min:4});
  const closed=card('Closed group',{format:'group',days:[5],status:'closed'});
  const archived=card('Archived place',{format:'self',days:[5],status:'excluded'});
  const C=catalogue([dated,early,group,lesson,place,ending,unsure,overdue,later,closed,archived]);
  const week=C.week(C.activities,K.defaultFilters());
  assert.deepEqual(plain(week.map(d=>d.date)),['2026-10-14','2026-10-15','2026-10-16','2026-10-17','2026-10-18','2026-10-19','2026-10-20']);
  assert.deepEqual(plain(week.map(d=>d.weekday)),[3,4,5,6,7,1,2]);
  assert.deepEqual(plain(week.map(d=>d.offset)),[0,1,2,3,4,5,6]);
  const day=date=>week.find(d=>d.date===date);
  // Today only what is not over yet; a session without a time comes after the timed ones; the 21st is outside the week.
  assert.deepEqual(plain(day('2026-10-14').sessions.map(s=>s.a.id+' '+(s.e.start||'-'))),['Dated 14:00']);
  assert.deepEqual(plain(day('2026-10-16').sessions.map(s=>s.a.id+' '+(s.e.start||'-'))),['Early 08:00','Dated 10:00','Dated -']);
  assert.equal(day('2026-10-16').sessions[1].index,2,'the index of the session on its card, for planning');
  assert.ok(week.every(d=>d.sessions.every(s=>s.e.date===d.date)));
  // A card with dated sessions is never repeated as a weekly offer, even if it names weekdays.
  assert.ok(week.every(d=>!d.regular.includes(dated)&&!d.places.includes(dated)));
  // Groups, courses and individual offers apart from places to visit on your own (format 'self').
  assert.deepEqual(ids(day('2026-10-14').regular),['Wednesday group','Wednesday lesson']);
  assert.deepEqual(ids(day('2026-10-14').places),['Wednesday place']);
  assert.deepEqual(ids(day('2026-10-15').regular),[]);assert.deepEqual(ids(day('2026-10-15').places),['Wednesday place']);
  assert.ok(week.every(d=>d.regular.every(a=>a.format!=='self')&&d.places.every(a=>a.format==='self')));
  assert.deepEqual(ids(day('2026-10-17').places),['Ending place'],'valid through Saturday 17 October');
  assert.deepEqual(ids(day('2026-10-19').places),[],'not on the Monday after its schedule ran out');
  // The same cards as the list: "check details", a review that is due and "for later" stay, each with its own status; closed and
  // excluded cards never appear.
  assert.deepEqual(ids(day('2026-10-16').regular),['Later group','Unsure group']);
  assert.deepEqual(ids(day('2026-10-16').places),['Overdue place']);
  assert.deepEqual(plain([unsure,overdue,later].map(a=>C.statusOf(a,null))),['check','check','future']);
  assert.ok(week.every(d=>![...d.regular,...d.places].some(a=>C.isArchive(a))));
  assert.deepEqual(ids(C.weekCards(week)).sort(),['Dated','Early','Ending place','Later group','Overdue place','Unsure group','Wednesday group','Wednesday lesson','Wednesday place']);
});

test('this week follows the weekday and "when" filters by leaving other days out, and the other filters through the list',()=>{
  const regular=card('Regular',{days:[1,2,3,4,5,6,7]});
  const C=catalogue([regular]);
  const f=K.defaultFilters();
  f.days=new Set([6,7]);
  assert.deepEqual(plain(C.week(C.activities,f).map(d=>d.date)),['2026-10-17','2026-10-18']);
  const g=K.defaultFilters();g.when='weekend';
  assert.deepEqual(plain(C.week(C.activities,g).map(d=>d.date)),['2026-10-17','2026-10-18']);
  g.when='today';
  assert.deepEqual(plain(C.week(C.activities,g).map(d=>d.date)),['2026-10-14']);
  // The real catalogue: the week is built from the filtered list, so the rainy-day filter and the age reach every entry.
  const {C:R,state,list,store}=loadStack();
  state.f.indoor=true;store.personal.age=3;
  const days=R.week(list(),state.f,{age:3});
  const cards=R.weekCards(days);
  assert.ok(cards.length>0);
  assert.ok(cards.every(a=>a.practical?.indoor?.value===true&&R.ageFit(a,3)!==false));
  for(const d of days)for(const a of [...d.regular,...d.places]){
    assert.equal(a.events.length,0,a.id);assert.ok(a.days.includes(d.weekday),a.id);
    assert.ok(!R.isArchive(a),a.id);assert.ok(!a.scheduleValidThrough||a.scheduleValidThrough>=d.date,a.id);
  }
  // Nearest first orders the regular groups and the places of a day.
  const centre=R.townCentre('Fribourg');
  state.f.sort='near';
  const near=R.week(list(),state.f,{age:3,near:centre});
  for(const d of near)for(const part of [d.regular,d.places]){const km=part.map(a=>R.distanceOf(a,centre)?.km??Infinity);for(let i=1;i<km.length;i++)assert.ok(km[i-1]<=km[i],d.date);}
  // Without filters, a Wednesday splits the many places from the groups and courses, and lists exactly the cards the list offers
  // for that weekday, "check details" included; each row carries the status mark of the list.
  const all=loadStack();
  const listed=all.list(),wednesday=all.C.week(listed,all.state.f).find(d=>d.weekday===3);
  assert.ok(wednesday.places.length>wednesday.regular.length&&wednesday.regular.length>=10);
  const expected=listed.filter(a=>!a.events.length&&a.days.includes(3)&&(!a.scheduleValidThrough||a.scheduleValidThrough>=wednesday.date));
  assert.deepEqual(ids([...wednesday.regular,...wednesday.places]).sort(),ids(expected).sort());
  assert.ok(wednesday.regular.some(a=>all.C.statusOf(a,null)==='check'),'groups that need checking are shown');
  for(const a of wednesday.regular)assert.ok(all.V.row(a).includes(all.V.esc(all.t('status.'+all.C.statusOf(a,null)+'.short'))),a.id);
});

test('the week view: day headings; sessions with times; regular groups open and marked; places folded into a count; a line for an empty day',()=>{
  const {K:K2,P:P2,window:W,t,I}=loadStack();
  const sessions=card('Session card',{format:'group',events:[{date:'2026-10-15',start:'09:30',end:'11:00',title:'Autumn morning'}]});
  const group=card('Group card',{format:'group',days:[3],schedule:'Wednesday 09:00–11:00; except school holidays'});
  const places=['A','B'].map(id=>card('Place '+id,{format:'self',days:[3],schedule:'Wed–Sun 10:00–17:00'}));
  const C=K2.create({activities:[sessions,group,...places],regions:{sense:'Sense'},towns:{},planning:P2,clock:{today:()=>'2026-10-14',nowHm:()=>'10:00'},t});
  const F=W.MinitandemFormat.create({t,locale:I.locale});
  const state={view:'week',f:K2.defaultFilters(),near:null,weekOpen:new Set()};
  const V=W.MinitandemViews.create({t,C,P:P2,X:W.MinitandemExchange,F,store:{personal:{favorites:[],age:null}},state:()=>state});
  const days=C.week(C.activities,state.f);
  let html=V.week(days);
  assert.ok(html.includes(V.esc(t('week.note'))));
  assert.ok(html.includes('Today · Wednesday 14 October'));
  assert.ok(html.includes('Tomorrow · Thursday 15 October'));
  assert.ok(html.includes('>1 dated session<')&&html.includes('<b>09:30–11:00</b> · Autumn morning'));
  // In this order on Wednesday: the regular group, open, with its whole weekly schedule and the mark; then the places, folded.
  const wednesday=html.slice(html.indexOf('Today ·'),html.indexOf('Tomorrow ·'));
  assert.ok(wednesday.indexOf('1 regular group or course on Wednesdays')<wednesday.indexOf('<details'));
  assert.ok(wednesday.includes(`<b>${V.esc(t('week.regularMark'))}</b> · Wednesday 09:00–11:00; except school holidays`));
  assert.equal(t('week.regularMark'),'Regular, confirm holidays');
  assert.ok(!/<details[^>]*>[\s\S]*Group card[\s\S]*<\/details>/.test(wednesday),'the group is not folded away');
  assert.ok(wednesday.includes('<summary>2 places open by their weekly hours</summary>'));
  assert.ok(wednesday.includes(`<b>${V.esc(t('week.hoursMark'))}</b> · Wed–Sun 10:00–17:00`));
  assert.ok(wednesday.includes(V.esc(t('week.regularNote'))));
  assert.ok(!html.includes('<details class="more wreg" data-day="2026-10-14" open>'),'folded at first');
  assert.equal((html.match(new RegExp(V.esc(t('week.emptyDay')),'g'))||[]).length,5,'five days have nothing');
  assert.equal((html.match(/<a class="row" href="#view=week&amp;activity=/g)||[]).length,4,'every entry opens its card like a list row');
  state.weekOpen.add('2026-10-14');
  html=V.week(days);
  assert.ok(html.includes('<details class="more wreg" data-day="2026-10-14" open>'),'an unfolded day stays unfolded');
  // The counts are worded with the weekday in every language.
  I.setLang('de',{persist:false});
  assert.equal(t('week.regular',{n:2,day:t('weekly.3')}),'2 regelmässige Gruppen- und Kursangebote, jeweils mittwochs');
  assert.equal(t('week.places',{n:2}),'2 Orte laut Öffnungszeiten geöffnet');
  I.setLang('fr',{persist:false});
  assert.equal(t('week.regular',{n:1,day:t('weekly.3')}),'1 groupe ou cours régulier le mercredi');
  assert.equal(t('week.places',{n:1}),'1 lieu ouvert selon ses horaires');
  html=V.week(days);
  assert.ok(html.includes('Aujourd’hui · mercredi 14 octobre'),'the weekday stays small after "today"');
  assert.ok(html.includes('>Vendredi 16 octobre<'),'and starts with a capital when it begins the heading');
  I.setLang('en',{persist:false});
});

test('rainy day: only cards stated to be indoors; unknown and outdoor cards are left out; it combines with presets and counts once',()=>{
  const {C,state,list}=loadStack();
  const published=C.activities.filter(a=>!C.isArchive(a));
  state.f.indoor=true;
  const indoor=list();
  assert.deepEqual(ids(indoor).sort(),ids(published.filter(a=>a.practical?.indoor?.value===true)).sort());
  assert.ok(indoor.length>50);
  for(const value of [false,null,undefined])assert.ok(!indoor.some(a=>a.practical?.indoor?.value===value),String(value));
  // It is a switch of its own now, so it combines with "no booking needed".
  state.f.preset='walkin';
  assert.ok(list().length>0);
  assert.ok(list().every(a=>a.practical.indoor.value===true&&a.practical.booking?.value===false));
  assert.equal(C.activeCount(state.f,null),2);
  // A session saved while "indoors" was a preset keeps the filter on.
  const restored=C.restoreFilters({preset:'indoor'});
  assert.equal(restored.indoor,true);assert.equal(restored.preset,'');
  assert.equal(C.restoreFilters({indoor:'yes'}).indoor,false,'only a real true');
});

test('the town for distances is remembered as a name in its own key, cleaned, and can be forgotten; the family records do not carry it',()=>{
  const {store,localStorage}=loadStack();
  assert.equal(store.loadNear(),'');
  store.saveNear('Plaffeien\u0000');
  assert.equal(localStorage.getItem('minitandem-near-town-v1'),'Plaffeien');
  assert.equal(store.loadNear(),'Plaffeien');
  assert.equal(localStorage.getItem('minitandem-family-v1'),null,'not part of the family profile, the backup or the sync');
  store.saveNear('');
  assert.equal(localStorage.map.has('minitandem-near-town-v1'),false);
  localStorage.blockWrites(true);
  assert.doesNotThrow(()=>store.saveNear('Bulle'));
});

test('the new words exist in all three languages, French keeps its no-break spaces and German has no sharp s',()=>{
  const W=S.window.MINITANDEM_STRINGS;
  const keys=Object.keys(W.en).filter(k=>/^(near|week|weekly)\.|^(tab|view)\.week$|^filter\.indoor$|^sort\.near$/.test(k));
  assert.ok(keys.length>=45);
  for(const k of keys){
    assert.ok(W.de[k]&&W.fr[k],k);
    assert.ok(!/ß/.test(W.de[k]),'de '+k);
    assert.ok(!/ [;:!?»]|« /.test(W.fr[k]),'fr '+k+' needs a no-break space');
  }
  assert.ok(W.fr['week.note'].includes('\u00a0;')&&W.fr['week.note'].includes('\u00a0:'));
  assert.equal(W.en['preset.indoor'],undefined,'the old preset label is gone');
});

test('distances are one tap from the first screen: "Near me" in the count bar, the controls first in the filter panel, a line to change or turn them off',()=>{
  const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const bar=index.slice(index.indexOf('<div class="bar">'),index.indexOf('<p class="note" id="countNote"'));
  assert.match(bar,/<button type="button" class="ghost nearbtn" id="nearOpen">[\s\S]*data-i18n="near.open"/);
  assert.ok(index.indexOf('id="nearOpen"')<index.indexOf('id="list"'),'above the results, in the page flow');
  assert.match(index,/id="nearNote"[^>]*hidden><span id="nearText"><\/span> <button[^>]*id="nearChange"[\s\S]*?id="nearOff"/);
  const css=fs.readFileSync(path.join(root,'styles.css'),'utf8');
  for(const rule of css.match(/\.(?:nearbtn|nearline|bar-r)[^{]*\{[^}]*\}/g))assert.ok(!/position:\s*(?:fixed|sticky)/.test(rule),rule);
  const {V}=loadStack();
  assert.match(V.panel(),/^<div class="group" id="g-near"/,'the first group of the filters');
});
