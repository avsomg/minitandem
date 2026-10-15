import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {loadStack,root} from './test-support.mjs';
// The catalogue's clock is fixed to the day the original fixtures were written, so dates in the data stay in the future or past as before.
const clock={today:'2026-09-27',nowHm:'10:00'};
const file=name=>path.join(root,name);
// Calendar lines are folded at 73 bytes; unfold them before reading a line.
const unfold=text=>text.replace(/\r\n /g,'');
const shared=loadStack(clock);

function mountMap(items,t){
  const context={window:{}};
  vm.runInNewContext(fs.readFileSync(file('map.js'),'utf8'),context);
  const container={textContent:''};
  const stop=context.window.MinitandemMap.mount(container,items,t);
  assert.equal(typeof stop,'function','mount returns a cleanup function');
  return container;
}

test('today, weekends, seven-day periods and leap months have inclusive stable boundaries',()=>{
  const {P}=shared,range=(...args)=>Array.from(P.range(...args));
  assert.deepEqual(range('weekend','2026-09-27'),['2026-09-27','2026-09-27']);
  assert.deepEqual(range('weekend','2026-09-28'),['2026-10-03','2026-10-04']);
  assert.deepEqual(range('weekend','2026-10-03'),['2026-10-03','2026-10-04']);
  assert.deepEqual(range('week','2026-09-27'),['2026-09-27','2026-10-03']);
  assert.deepEqual(range('month','2026-09-27','2028-02'),['2028-02-01','2028-02-29']);
  assert.deepEqual(range('today','2026-10-25'),['2026-10-25','2026-10-25']);
});

test('dated events of courses are never offered as bookable one-off events; drop-in dates carry no course wording',()=>{
  const {C,P,EX,t,window:W,records}=shared,esc=W.MinitandemExports.icsEscape;
  const dated=records.filter(a=>!C.isArchive(a)&&C.upcoming(a).length);
  const courses=dated.filter(a=>P.admission(a)==='course'),dropins=dated.filter(a=>P.admission(a)==='dropin');
  assert.ok(courses.length&&dropins.length);
  assert.equal(t('ics.coursePrefix'),'Course');
  for(const a of courses)for(const e of C.upcoming(a)){
    const text=unfold(EX.eventFile(a.id,a.events.indexOf(e)).text);
    assert.ok(text.includes('SUMMARY:Course · '),a.id+': a course date is labelled as a course');
    assert.ok(text.includes(t('ics.courseJoin')),a.id+': joining a course has to be agreed');
    assert.ok(text.includes(esc(t('ics.notBooking'))),a.id+': a published date is not a booking');
  }
  for(const a of dropins)for(const e of C.upcoming(a)){
    assert.equal(a.practical.booking.value,false,a.id);
    const text=unfold(EX.eventFile(a.id,a.events.indexOf(e)).text);
    assert.ok(!text.includes('SUMMARY:Course'),a.id);assert.ok(!text.includes(t('ics.courseJoin')),a.id);
    assert.ok(text.includes(esc(t('ics.notBooking'))),a.id);
  }
});

test('the changed venue of the November Suniai event is the location of that date only',()=>{
  const {EX,byId}=shared,a=byId.get('suniai-family-yoga');
  const location=index=>unfold(EX.eventFile(a.id,index).text).split('\r\n').find(line=>line.startsWith('LOCATION:'));
  const october=a.events.findIndex(e=>e.date==='2026-10-03'),november=a.events.findIndex(e=>e.date==='2026-11-07');
  assert.ok(october>=0&&november>=0);
  assert.equal(location(november),'LOCATION:Warpelstrasse 9\\, Düdingen');
  assert.doesNotMatch(location(november),/Aloha/);
  assert.match(location(october),/^LOCATION:Aloha YOGA Paradise/);
  // A plan entry on a date with a published venue gets that venue; on a date without one the file says that the address depends on the date.
  const plan=date=>({visits:{'v-s':{activity:a.id,date,time:'10:00',booking:'unconfirmed'}}});
  const planLocation=date=>unfold(EX.planFile(plan(date)).text).split('\r\n').find(line=>line.startsWith('LOCATION:'));
  assert.equal(planLocation('2026-11-07'),'LOCATION:Warpelstrasse 9\\, Düdingen');
  assert.equal(planLocation('2026-11-14'),'LOCATION:'+shared.window.MinitandemExports.icsEscape(shared.t('ics.addressByDate',{town:a.town})));
});

test('map does not plot a multi-venue event at its first date only',()=>{
  const {byId,t}=shared;
  const container=mountMap([byId.get('suniai-family-yoga')],t);
  assert.equal(container.textContent,t('map.noPoints'));
  assert.match(container.textContent,/no single confirmed point/);
  // Without a translator the keys themselves show, so a missing dictionary never produces a blank map.
  assert.equal(mountMap([byId.get('suniai-family-yoga')]).textContent,'map.noPoints');
});

test('map does not plot a descriptive area as an exact point',()=>{
  const {byId,t}=shared;
  const container=mountMap([{...byId.get('beaches'),geo:{lat:46.67,lon:7.28}}],t);
  assert.equal(container.textContent,t('map.noPoints'));
  assert.match(container.textContent,/no single confirmed point/);
});

test('map keeps a single-venue card with an address point while dropping the unplottable ones',()=>{
  const {byId,t}=shared,located=byId.get('swim-buissonnets');
  assert.equal(located.addressPrecision,undefined);assert.ok(located.geo);assert.ok(!located.events.some(e=>e.address&&e.address!==located.address));
  // No Leaflet in the fake browser: a card that passes the plotting rules reaches the "map did not load" message instead of "no point".
  assert.equal(mountMap([located],t).textContent,t('map.notLoaded'));
  assert.equal(mountMap([byId.get('suniai-family-yoga'),located],t).textContent,t('map.notLoaded'));
  assert.equal(mountMap([byId.get('beaches')],t).textContent,t('map.noPoints'),'a card without any point is not plotted');
});

test('search by occurrence title finds the programme, although its general text never mentions that title',()=>{
  const {state,list,C,byId}=loadStack(clock),workshops=byId.get('office-family-workshops');
  const titles=workshops.events.map(e=>e.title);
  assert.ok(titles.includes('Getting to know emotions')&&titles.includes('Saturday stories'));
  for(const title of ['Getting to know emotions','Saturday stories']){
    assert.equal(C.matchesSearch(C.searchText(workshops),title),false,title+' is not in the programme text');
    state.f.query=title;
    assert.deepEqual(Array.from(list(),a=>a.id),['office-family-workshops'],title);
  }
  // Every word of the query must belong to the same text or to the same occurrence title.
  state.f.query='Saturday emotions';
  assert.equal(list().length,0);
});

test('scenarios and convenience filters do not equate a self-guided visit with no booking',()=>{
  const {P,byId,state,list}=loadStack(clock);
  assert.equal(P.scenario(byId.get('mpe')),'visit');
  assert.equal(P.scenario(byId.get('krabbel-plaffeien')),'event');
  assert.equal(P.scenario(byId.get('conservatoire')),'course');
  assert.equal(P.matches(byId.get('alice-marly'),'walkin'),false);
  assert.equal(P.matches(byId.get('mpe'),'walkin'),true);
  assert.equal(P.matches(byId.get('swim-tentlingen'),'short'),true);
  state.f.scenario='visit';state.f.preset='walkin';
  const result=list();
  assert.ok(result.length);assert.ok(result.every(a=>P.scenario(a)==='visit'&&a.practical.booking.value===false));
  assert.ok(result.some(a=>a.id==='mpe'));assert.ok(!result.some(a=>a.id==='alice-marly'));
});

test('combined conditions use explicit facts, not the absence of restrictions',()=>{
  const {P,byId}=shared;
  assert.equal(P.matchesNeeds(byId.get('mpe'),new Set(['noCourse','flexible'])),true);
  assert.equal(P.matchesNeeds(byId.get('mpe'),new Set(['trial'])),false);
  assert.equal(P.matchesNeeds(byId.get('swim-courtepin-babies'),new Set(['trial','changing'])),true);
  assert.equal(P.matchesNeeds(byId.get('swim-courtepin-babies'),new Set(['access'])),false);
  assert.equal(P.matchesNeeds(byId.get('elki-plaffeien'),new Set(['trial'])),false);
  assert.equal(P.matchesNeeds(byId.get('sellenhof-group'),new Set(['small'])),true);
  assert.equal(P.matches(byId.get('krabbel-giffers'),'walkin'),false);
  assert.equal(byId.get('swim-courtepin-babies').practical.trial.value,true);
  assert.match(byId.get('swim-courtepin-babies').practical.trial.text,/cost is not stated/);
});

test('blocking closures and old tariffs appear before generic unknowns',()=>{
  const {P,byId}=shared,codes=list=>list.map(w=>w.code);
  const closure=P.warnings(byId.get('swim-duedingen'),'2026-09-27');
  assert.match(closure[0].text,/closure/);assert.equal(closure[0].code,undefined);
  assert.ok(codes(closure).indexOf('priceUnclear')>0,'the generic unknown comes after the published closure');
  const tariff=P.warnings(byId.get('elki-kerzers'),'2026-09-27');
  assert.match(tariff[0].text,/2025\/26/);
  assert.ok(codes(tariff).indexOf('languageUnconfirmed')>0);
  assert.ok(codes(P.warnings(byId.get('museum'),'2030-01-01')).includes('datesPassed'));
  assert.ok(!codes(P.warnings(byId.get('museum'),'2026-09-27')).includes('datesPassed'));
});

test('a closed or archived status is the first warning, ahead of published card text',()=>{
  const {P,byId}=shared,base=byId.get('swim-duedingen');
  assert.ok(base.practical.warnings.length);
  assert.equal(P.warnings({...base,status:'closed'},'2026-09-27')[0].code,'closed');
  assert.equal(P.warnings({...base,status:'excluded'},'2026-09-27')[0].code,'archived');
  const open=P.warnings({...base,status:'active'},'2026-09-27');
  assert.ok(!open.some(w=>w.code==='closed'||w.code==='archived'));
});

test('planning returns codes or card text only, never interface wording',()=>{
  const {P,records}=shared,known=new Set(['closed','archived','scheduleExpired','datesPassed','reviewDue','bookingRequired','entranceUnknown','placeUnknown','adultUnconfirmed','priceUnclear','languageUnconfirmed','ageNotPublished','confirmWithOrganiser']);
  for(const a of records)for(const date of ['2026-09-27','2026-12-31','2030-01-01'])for(const w of P.warnings(a,date)){
    assert.equal(Boolean(w.code),!w.text,a.id+': a warning is either a code or card text');
    if(w.code)assert.ok(known.has(w.code),a.id+': unknown code '+w.code);
    assert.deepEqual(Object.keys(w),[w.code?'code':'text'],a.id);
  }
  const mpe=shared.byId.get('mpe');
  assert.deepEqual(Array.from(P.matchReasons(mpe,2,true,true,null)),['ageInRange','adultJoins','noBookingBySource']);
  assert.deepEqual(Array.from(P.matchReasons(mpe,9,false,false,null)),['ageToConfirm']);
  assert.deepEqual(Array.from(P.matchReasons(mpe,null,false,false,null)),[]);
  const workshops=shared.byId.get('office-family-workshops');
  assert.ok(P.matchReasons(workshops,null,false,false,'2026-10-06').includes('publishedDate'));
  assert.ok(!P.matchReasons(workshops,null,false,false,'2026-10-07').includes('publishedDate'));
});

test('the uncertain upper age counts only as a number: missing and null mean no bound, 0 and a positive value are bounds',()=>{
  const {K,P,C,regions,byId}=shared;
  // A card with confirmed ages 2 to 4, listed alone in its own catalogue so that the interface's own filter runs on it.
  const withBound=bound=>{const card={...byId.get('mpe'),min:2,max:4};delete card.ageException;delete card.ageUpperUncertainFrom;if(bound!=='absent')card.ageUpperUncertainFrom=bound;return card;};
  const shows=(card,age,includeUnknownAge)=>K.create({activities:[card],regions,planning:P,clock}).filter({...K.defaultFilters(),includeUnknownAge},{age}).length===1;
  const reasons=(card,age)=>Array.from(P.matchReasons(card,age,false,false,null));
  // Absent (the field never set) and null (how a full-review patch clears it) are the same thing: the confirmed range decides.
  for(const bound of ['absent',undefined,null]){
    const card=withBound(bound),label=String(bound);
    assert.equal(C.ageFit(card,3),true,label);
    assert.equal(shows(card,3,false),true,label+': still listed when unknown ages are left out');
    assert.deepEqual(reasons(card,3),['ageInRange'],label+': the explanation keeps the confirmed-age reason');
    assert.equal(C.ageFit(card,5),false,label+': above the published limit');
  }
  // 0 is a bound like any other: from age 0 on, suitability is uncertain, so the confirmed range no longer settles it.
  const zero=withBound(0);
  assert.equal(C.ageFit(zero,3),null);
  assert.equal(shows(zero,3,false),false);assert.equal(shows(zero,3,true),true);
  assert.deepEqual(reasons(zero,3),['ageToConfirm']);
  // A positive bound applies from that age: below it the range fits, at it the age is to be confirmed, and the published limit still excludes.
  const four=withBound(3.5);
  assert.equal(C.ageFit(four,3),true);assert.deepEqual(reasons(four,3),['ageInRange']);
  assert.equal(C.ageFit(four,3.5),null);assert.deepEqual(reasons(four,3.5),['ageToConfirm']);
  assert.equal(shows(four,3.5,false),false);assert.equal(shows(four,3.5,true),true);
  assert.equal(C.ageFit(four,5),false);
  // The same card as an editor leaves it: the key present with null, then with a number, changes nothing for the other ages.
  assert.equal(C.ageFit(withBound(null),2),C.ageFit(withBound('absent'),2));
});

test('family calculations respect child bands and never expose course unit prices as tickets',()=>{
  const {P,byId}=shared,beo=byId.get('beo-funpark');
  assert.equal(P.familyPrice(beo,2.5,1).total,19);
  assert.equal(P.familyPrice(beo,4,2).total,37);
  assert.equal(P.familyPrice(beo,.5,1),null);
  assert.equal(P.familyPrice(beo,16,1),null);
  assert.equal(P.familyPrice(beo,2,0),null);
  assert.equal(P.familyPrice(beo,2,1.5),null);
  assert.equal(P.familyPrice(byId.get('swim-tentlingen'),2.5,1),null);
});

test('share links contain only allowed public IDs and strip query strings and private state',()=>{
  const {P,byId,state,store,list}=loadStack(clock);
  store.personal.notes.mpe='PRIVATE';store.personal.origin='PRIVATE HOME';
  const url=P.shareURL('https://minitandem.ch/?secret=PRIVATE#age=2.5',['mpe','museum','mpe','<script>'],byId);
  assert.equal(new URL(url).search,'');assert.doesNotMatch(url,/PRIVATE|age|script/);
  assert.deepEqual(Array.from(P.shareIds(new URLSearchParams(new URL(url).hash.slice(1)).get('list'),byId)),['mpe','museum']);
  assert.equal(P.shareIds('x'.repeat(4001),byId).length,0);
  state.view='shared';state.sharedIds=['mpe','museum'];state.f.query='no-match';state.f.categories.add('horses');
  assert.equal(list().length,2,'recipient filters do not silently hide shared places');
  store.personal.age=17;
  assert.equal(list().length,2,'the recipient\'s own child age does not hide shared places either');
  assert.throws(()=>P.shareURL('https://minitandem.ch/',[],byId),{code:'share.none',message:/at least one place/});
});

test('new personal statuses remain compatible with existing backups and saved filtering',()=>{
  const {store,list,state}=loadStack(clock);
  assert.equal(store.validateBackup({...store.personal,statuses:{mpe:'discuss'}}).statuses.mpe,'discuss');
  assert.equal(store.validateBackup({...store.personal,statuses:{mpe:'not-a-status'}}).statuses.mpe,undefined);
  store.personal.favorites=['mpe','museum'];store.personal.statuses.mpe='discuss';state.view='saved';state.f.planStatus='discuss';
  assert.deepEqual(Array.from(list(),a=>a.id),['mpe']);
});

test('map publishes only unique exact-address matches, never arbitrary first search results',()=>{
  const {records,byId}=shared;
  const located=records.filter(a=>a.geo);
  assert.equal(located.length,JSON.parse(fs.readFileSync(file('editorial/profile.json'),'utf8')).geocodedCards);
  for(const a of located){assert.equal(a.geo.precision,'address');assert.ok(a.geo.label);assert.match(a.geo.source,/^https:\/\/api3\.geo\.admin\.ch\//);assert.ok(Number.isFinite(a.geo.lat)&&Number.isFinite(a.geo.lon));}
  assert.equal(byId.get('elki-plaffeien').geo,undefined);
  assert.equal(byId.get('swim-buissonnets').geo.label,'Route de Villars-les-Joncs 3 1700 Fribourg');
  assert.equal(byId.get('conservatoire').geo.label,'Route Louis-Braille 8 1763 Granges-Paccot');
  for(const [id,label] of [
    ['elki-kerzers','Fräschelsgasse 11 3210 Kerzers'],
    ['enney-sarine-play','Prâ des Frassettes 185 1667 Enney'],
    ['thusy-pont-la-ville','Impasse de Thusy 89 1649 Pont-la-Ville'],
    ['hauteville-otavela-play','Route de la Bahy 1 1648 Hauteville'],
    ['chatonnaye-forest-cabin','Chemin de la Cabane 9 1553 Châtonnaye']
  ])assert.equal(byId.get(id).geo.label,label,id);
  assert.equal(byId.get('familybloom-yoga').geo.label,'Steindleren 1a 3210 Kerzers');
  assert.equal(byId.get('aef-villars').geo.label,'Route de Villars-Vert 26 1752 Villars-sur-Glâne');
  assert.equal(byId.get('aef-estavayer-cafe').geo.label,'Route de la Chapelle 33 1470 Estavayer-le-Lac');
  assert.equal(byId.get('ne-pour-lire-estavayer').geo.label,'Route de la Chapelle 33 1470 Estavayer-le-Lac');
  assert.equal(byId.get('encore-jura').geo.label,"Route de l'Aurore 2a 1700 Fribourg");
  assert.equal(byId.get('aef-vignettaz').geo.label,'Route de la Gruyère 9 1700 Fribourg');
  assert.equal(byId.get('aef-jura').geo.label,'Avenue du Général-Guisan 59 1700 Fribourg');
  assert.equal(byId.get('aef-farvagny').geo,undefined,'the newly sourced address needs its own exact registry match');
  assert.equal(byId.get('aef-attalens').geo.label,"Rue de l'Eglise 26 1616 Attalens");
  assert.equal(byId.get('aef-attalens-alimentation').geo.label,"Rue de l'Eglise 26 1616 Attalens");
  assert.equal(byId.get('suniai-family-yoga').geo.label,'Hauptstrasse 20 3186 Düdingen');
  assert.equal(byId.get('schlittschuh-gurmels').geo,undefined,'no exact Sportweg 21 registry match');
  assert.equal(byId.get('arconciel-arche-play').geo.label,"Place de l'Arche 1 1732 Arconciel");
  assert.equal(byId.get('nuvilly-batailles-play').geo,undefined,'a street name is not an exact entrance');
});

test('a generated map point is not applied after its visitor address changes',()=>{
  const original=shared.byId.get('swim-buissonnets');
  const c={window:{ACTIVITIES:[{id:original.id,address:'A different visitor address'}]}};
  vm.runInNewContext(fs.readFileSync(file('data-geo.js'),'utf8'),c);
  assert.equal(c.window.ACTIVITIES[0].geo,undefined);
  c.window.ACTIVITIES[0].address=original.address;
  vm.runInNewContext(fs.readFileSync(file('data-geo.js'),'utf8'),c);
  assert.equal(c.window.ACTIVITIES[0].geo.label,original.geo.label);
});

test('new programmes have sourced exact dates and retain unknown local language and timetable',()=>{
  const {byId}=shared,a=byId.get('artist-factory-parent');
  assert.equal(a.amount,162);assert.equal(a.min,1.5);assert.equal(a.max,4);assert.equal(a.events.length,0);assert.equal(a.languages.length,0);
  assert.equal(a.status,'active');assert.deepEqual(Array.from(a.days),[3]);assert.match(a.schedule,/10:00–10:45/);
  assert.equal(a.practical.trial.value,true);assert.equal(a.practical.commitment.value,true);
  assert.match(a.practical.commitment.text,/31 May/);assert.equal(a.practical.groupSize.value,6);
  assert.ok(a.research.findings.length>=4);
  const workshop=byId.get('office-family-workshops'),books=byId.get('office-family-books');
  assert.equal(workshop.events.length+books.events.length,6);assert.equal(workshop.max,5);assert.equal(books.max,4);
  assert.ok(workshop.events.every(e=>e.title));assert.equal(workshop.practical.booking.value,false);
  assert.ok(workshop.research.findings.length>=3);assert.ok(books.research.findings.length>=3);
});

test('all practical facts have dated provenance and photo reuse has attribution',()=>{
  const {records,byId}=shared;
  for(const a of records)for(const value of Object.values(a.practical||{}))if(value&&typeof value==='object'&&Object.hasOwn(value,'value')){
    assert.match(value.source,/^https:\/\//,a.id);
    assert.match(value.checked,/^\d{4}-\d{2}-\d{2}$/,a.id);
    assert.equal(new Date(value.checked+'T12:00:00Z').toISOString().slice(0,10),value.checked,a.id);
    assert.ok(value.checked<=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'}),a.id+': future evidence date');
    assert.ok(value.text);
  }
  const photo=byId.get('papiliorama-kerzers').practical.photo;
  assert.match(photo.credit,/Public domain/);assert.match(photo.caption,/2010/);assert.ok(fs.existsSync(file(photo.path)));
});

test('CSP permits tile images and HTTPS family sync without inline scripts',()=>{
  const config=JSON.parse(fs.readFileSync(file('vercel.json'),'utf8'));
  const csp=config.headers[0].headers.find(h=>h.key==='Content-Security-Policy').value;
  assert.match(csp,/img-src 'self' data: https:\/\/wmts\.geo\.admin\.ch;/);
  assert.match(csp,/connect-src 'self' https:;/);assert.doesNotMatch(csp,/unsafe-eval|unsafe-inline|\*/);
});
