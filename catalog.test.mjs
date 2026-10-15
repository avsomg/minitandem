import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {loadStack,root} from './test-support.mjs';

// The reference child age of the age tests. It is only ever used as a number.
const AGE=2.5;
const FAMILY_KEY='minitandem-family-v1';
const profile=age=>({[FAMILY_KEY]:{version:1,favorites:[],notes:{},statuses:{},age}});
// A fresh stack of the real modules. age is the child's age in the family profile (null: no age filter); filters is a saved
// session filter state, restored the way the page restores it.
function load({age=null,filters=null,...rest}={}){
  const S=loadStack({local:age===null?{}:profile(age),session:filters?{'minitandem-family-v1-filters':filters}:{},...rest});
  if(filters)S.state.f=S.C.restoreFilters(JSON.parse(S.sessionStorage.getItem(S.store.KEYS.filters)));
  return S;
}
const ids=items=>Array.from(items,a=>a.id);
const readJson=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
// Card counts are not written into this file: editorial/profile.json holds them, counted by editorial/profile.mjs straight from the
// data files, a second reading next to the catalogue module these tests load. A card added or archived changes both together.
const COUNTS=readJson('editorial/profile.json');
const isPublished=a=>!['closed','excluded'].includes(a.status);
// Private-only tests check the catalogue against research records that are not in the public repository (see docs/publication-scope.md).
// On a clean clone they are skipped with this message; in the owner's workspace they run.
const PRIVATE_SKIP=fs.existsSync(path.join(root,'editorial/family-venues-visitor-check-2026-09-27.json'))?false:
  'private-only: editorial/family-venues-visitor-check-2026-09-27.json is not present (clean clone)';
const count=(text,part)=>text.split(part).length-1;
// Cards of the canton follow-up pass carry the finding field 'Availability and format'. Four cards carry the same field under
// the label 'Existence and format' (the same heading translated twice); both labels are accepted.
const FOLLOWUP_FIELDS=['Availability and format','Existence and format'];
// editorial/approved-updates.json is empty in the English catalogue (its history is archived). The one full-coverage update of the
// sixteen venues, applied on 2 October 2026, is pinned here; a full update that the file gains later takes precedence.
const LATER_FULL_REVIEW={'coop-fribourg-play':'2026-10-02'};
// The 37 cards of the district expansion receipt of 28 September 2026 (the receipt file itself is archived).
const EXPANSION_IDS=['espace-famille-bulle','fritime-piccolo-bulle','ludo-gruyere-bulle','entrepot-mini-bulle','maison-cailler-broc','maison-gruyere-pringy','pitchounes-romont','ludo-glane-romont','library-glane-romont','vitromusee-romont','gouille-romont','tour-boyer-playground','fees-chapelle','fsg-elki-lully','library-estavayer','village-lacustre-gletterens','nouvelle-plage-estavayer','plage-portalban','plage-chevroux','musee-grenouilles-estavayer','ludo-trottinette-chatel','library-veveyse-chatel','piscine-chatel','rathvel-petit-oiseau','gros-chaumiaux-cerniat','saison-alpage-charmey','ferme-verte-vallee-vuisternens','library-domdidier','plage-cheyres','botanique-attalens','vita-chatel','buvette-sapins-epagny','humilimont-marsens','lutins-paccots','epicentre-pataugeoire-romont','fsg-domdidier-parent','fsg-chatel-parent-remaufens'];

test('all records have a supported category, format and status, and stable unique IDs',()=>{
  const {records,K,t}=load();
  assert.equal(new Set(records.map(a=>a.id)).size,records.length);
  for(const a of records){
    assert.ok(K.CATEGORY_KEYS.includes(a.category),a.id);
    assert.notEqual(t('category.'+a.category),'category.'+a.category,a.id+': category has a name in the dictionary');
    assert.ok(K.FORMAT_KEYS.includes(a.format),a.id);
    assert.ok(['active','check','future','closed','excluded'].includes(a.status),a.id);
  }
});

test('default catalogue includes new family venues without forcing age or language assumptions',()=>{
  const {C,list,state,store}=load();
  assert.equal(store.personal.age,null);
  assert.equal(state.f.languages.size,0);
  assert.equal(state.f.includeUnknownAge,true);
  assert.equal(C.activeCount(state.f,store.personal.age),0);
  assert.equal(C.anyFilter(state.f,store.personal.age),false);
  assert.equal(list().length,COUNTS.catalog,'the unfiltered list is every published card');
  assert.ok(ids(list()).includes('bistro11-duedingen'));
  assert.ok(ids(list()).includes('beo-funpark'));
});

test('new profiles have no assumed child age, while saved profiles retain theirs',()=>{
  // An age filter left over from an old session is not a filter any more: the age lives in the family profile only.
  const neutral=load({filters:{ageMatch:true,ageOverride:3}});
  assert.equal(neutral.store.personal.age,null);
  assert.equal(neutral.C.activeCount(neutral.state.f,neutral.store.personal.age),0);
  assert.equal(neutral.list().length,COUNTS.catalog);
  assert.equal(neutral.C.ageFit(neutral.byId.get('pony-entdecken'),neutral.store.personal.age),null);
  assert.equal(load({age:6}).store.personal.age,6);
  assert.equal(load({age:AGE}).store.personal.age,AGE);
  assert.equal(load({age:0}).store.personal.age,0,'age 0 (under one year) is an age, not an empty profile');
});

test('location choices cover every catalogue locality and filter compound town labels',()=>{
  const {records,C,V,state,list}=load();
  const places=a=>a.town.split(/\s+\/\s+/).map(name=>`${a.region}|${name.trim()}`);
  const expected=new Set(records.flatMap(places));
  assert.equal(C.localities.length,expected.size);
  assert.ok(C.localities.every(place=>expected.has(place.key)));
  // The menu offers every place that has a published card; places that only have archived cards are not offered.
  const published=new Set(records.filter(a=>!C.isArchive(a)).flatMap(places));
  const {districts,towns}=C.placeOptions();
  assert.deepEqual(Array.from(towns,o=>o.id).sort(),[...published].sort());
  const html=V.placeOptionsHtml();
  assert.equal((html.match(/<option /g)||[]).length,1+districts.length+towns.length);
  assert.match(html,/value="t:sense\|Plaffeien"/);
  assert.match(html,/value="t:sarine\|Fribourg"/);
  assert.match(html,/value="t:sarine\|Granges-Paccot"/);
  assert.match(html,/value="d:sense"/);
  const compound=records.find(a=>a.town==='Fribourg / Granges-Paccot'&&!C.isArchive(a));
  assert.ok(compound);
  for(const name of ['Fribourg','Granges-Paccot']){
    state.f.place=`t:sarine|${name}`;
    assert.ok(ids(list()).includes(compound.id),name);
  }
  state.f.place='t:sense|Plaffeien';
  assert.ok(list().length>0);
  assert.ok(list().every(a=>a.region==='sense'&&a.town.split(/\s+\/\s+/).includes('Plaffeien')));
  assert.equal(load({filters:{place:'t:sense|Plaffeien'}}).state.f.place,'t:sense|Plaffeien');
  assert.equal(load({filters:{place:'t:see|Plaffeien'}}).state.f.place,'','a town in the wrong district is not restored');
  assert.equal(load({filters:{place:'sense|Plaffeien'}}).state.f.place,'','a place without its prefix is not restored');
});

test('the MEMO family music meeting stays on record after its date and leaves the catalogue',()=>{
  // Closed by an approved update on 3 October 2026, once the single meeting of 29 September had passed.
  const {records,C,K,list,state,byId}=load({age:AGE});
  const meeting=byId.get('memo-musik-entdecken-2026-09-29');
  assert.equal(meeting.status,'closed');
  assert.equal(meeting.events.length,1);
  assert.equal(meeting.events[0].date,'2026-09-29');
  assert.equal(meeting.events[0].start,'10:00');
  assert.equal(meeting.events[0].end,'10:45');
  assert.equal(meeting.practical.booking.value,true);
  assert.equal(meeting.geo,undefined,'a closed card has no map point');
  state.f.scenario='event';
  assert.equal(C.ageFit(meeting,AGE),true);
  assert.ok(!ids(list()).includes(meeting.id));
  assert.ok(ids(list({view:'archive'})).includes(meeting.id),'the closed card is still found in the archive view');
  assert.equal(records.filter(a=>a.events.some(e=>e.date==='2026-09-29')&&a.name.includes('Musik entdecken')).length,1);
  assert.ok(!records.some(a=>a.id==='memo-musik'));
  assert.equal(K.canonicalId('memo-musik'),meeting.id,'the old identifier of a saved card still resolves');
});

test('Marly parent-child cafe has all published dates',()=>{
  const {byId}=load();
  const cafe=byId.get('cafe-marly');
  assert.equal(cafe.events.length,12);
  assert.deepEqual(Array.from(cafe.events,e=>e.date),[
    '2026-09-30','2026-10-07','2026-10-14','2026-10-21','2026-10-28','2026-11-04',
    '2026-11-11','2026-11-18','2026-11-25','2026-12-02','2026-12-09','2026-12-16'
  ]);
  assert.equal(cafe.events[0].start,'09:00');
  assert.equal(cafe.events[0].end,'11:00');
});

test('corrected gym and Piccolo days participate in the real catalogue filters',()=>{
  const {list,state}=load();
  for(const [day,present,absent] of [
    [1,'bewegungsinsel','elki-giffers'],[3,'elki-giffers','bewegungsinsel'],
    [4,'fritime-piccolo-bulle','elki-heitenried'],[6,'ludo-gruyere-bulle','fritime-piccolo-bulle']
  ]){
    state.f.days=new Set([day]);
    assert.ok(ids(list()).includes(present),present);
    assert.ok(!ids(list()).includes(absent),absent);
  }
});

test('Giffers lantern procession keeps the confirmed 2026 meeting point and weather caveat',()=>{
  const {byId}=load();
  const procession=byId.get('rabel-giffers');
  assert.equal(procession.address,'Parkplatz Nydegger AG, Obertswilstrasse 86, 1735 Giffers');
  assert.deepEqual(Array.from(procession.events,e=>({date:e.date,start:e.start})),[
    {date:'2026-11-07',start:'18:00'}
  ]);
  assert.match(procession.schedule,/only if the weather is suitable/);
  assert.equal(procession.min,null);
  assert.ok(procession.sources.some(source=>source.url==='https://www.evgt.ch/events/r%C3%A4beliechtli/'));
});

test('new AEF cafes keep exact dated sessions, and an unknown age is never a match',()=>{
  const {C,list,state,byId}=load({age:AGE});
  const villars=byId.get('aef-villars');
  const estavayer=byId.get('aef-estavayer-cafe');
  // The editorial pipeline updates these sessions (the first approved update of 15 Oct 2026 changed Estavayer's), so the
  // test pins what must hold for any version: every session has an exact date and start time.
  for(const card of [villars,estavayer]){
    assert.ok(card.events.length>0,card.id);
    assert.ok(card.events.every(e=>/^\d{4}-\d{2}-\d{2}$/.test(e.date)&&/^\d{2}:\d{2}$/.test(e.start)),card.id);
  }
  state.f.scenario='event';
  if(villars.min===null&&villars.max===null)assert.equal(C.ageFit(villars,AGE),null);
  assert.equal(C.ageFit(estavayer,AGE),true);
  assert.ok(ids(list()).includes('aef-estavayer-cafe'));
  assert.ok(ids(list()).includes('aef-villars'));
});

test('Estavayer reading workshop has dated bookable sessions for ages 0 to 4',()=>{
  const {list,state,byId}=load({age:AGE});
  const workshop=byId.get('ne-pour-lire-estavayer');
  assert.deepEqual(Array.from(workshop.events,e=>e.date),['2026-10-05','2026-11-11','2026-12-10']);
  assert.equal(workshop.practical.booking.value,true);
  assert.equal(workshop.max,4);
  assert.equal(workshop.priceKind,'unknown');
  state.f.scenario='event';
  assert.ok(ids(list()).includes(workshop.id));
});

test('existing Fribourg AEF cafes expose the published autumn series',()=>{
  const {byId}=load();
  for(const [id,count,last] of [
    // Counts follow the approved updates of 2 and 3 October 2026, which list the meetings still ahead.
    ['aef-mpe',10,'2026-12-15'],['aef-schonberg',11,'2026-12-16'],
    ['aef-centre',12,'2026-12-17'],['aef-passerelles',4,'2026-12-16']
  ]){
    const record=byId.get(id);
    assert.equal(record.events.length,count,id);
    assert.equal(record.events.at(-1).date,last,id);
    assert.equal(record.scheduleValidThrough,last,id);
  }
});

test('new Fribourg cafes keep date-specific times and uncertain eligibility',()=>{
  const {C,byId}=load();
  const vignettaz=byId.get('aef-vignettaz');
  const jura=byId.get('aef-jura');
  assert.deepEqual(Array.from(vignettaz.events,event=>[event.date,event.start,event.end]),[
    ['2026-10-07','15:00','17:00'],['2026-11-07','09:00','11:00']
  ]);
  assert.deepEqual(Array.from(jura.events,event=>event.date),['2026-10-10','2026-10-31']);
  for(const record of [vignettaz,jura]){
    assert.equal(C.ageFit(record,AGE),null);
    assert.equal(record.priceKind,'unknown');
    assert.equal(record.practical.indoor.value,true);
  }
});

test('AEF Farvagny and Attalens separate ordinary cafes from the themed workshop',()=>{
  const {C,byId}=load();
  const farvagny=byId.get('aef-farvagny');
  const attalens=byId.get('aef-attalens');
  const workshop=byId.get('aef-attalens-alimentation');
  assert.deepEqual(Array.from(farvagny.events,event=>[event.date,event.start,event.end]),[['2026-10-03','09:30','11:00']]);
  assert.deepEqual(Array.from(attalens.events,event=>event.date),[
    '2026-10-07','2026-11-04','2026-11-11','2026-11-25','2026-12-02','2026-12-16'
  ]);
  assert.deepEqual(Array.from(workshop.events,event=>event.date),['2026-10-28']);
  assert.equal(farvagny.region,'sarine');
  assert.equal(attalens.region,'veveyse');
  for(const record of [farvagny,attalens,workshop]){
    assert.equal(C.ageFit(record,AGE),null);
    assert.equal(record.priceKind,'unknown');
    assert.equal(record.practical.indoor.value,true);
  }
});

test('new MEMO events distinguish toddler access from older-child activities',()=>{
  const {C,list,state,byId}=load({age:AGE});
  const mission=byId.get('memo-rat-mission-2026-09-30');
  const vernissage=byId.get('memo-rat-vernissage-2026-09-30');
  const parents=byId.get('devenir-famille-fribourg-2026-10-03');
  state.f.scenario='event';
  assert.equal(C.ageFit(mission,AGE),false);
  assert.equal(C.ageFit(vernissage,AGE),true);
  assert.equal(C.ageFit(parents,AGE),null);
  assert.ok(!ids(list()).includes(mission.id));
  assert.ok(ids(list()).includes(vernissage.id));
  assert.ok(ids(list()).includes(parents.id));
  state.f.includeUnknownAge=false;
  assert.ok(!ids(list()).includes(parents.id));
});

test('winter MEMO programme includes confirmed dates and keeps booking availability unknown',()=>{
  const {C,byId}=load();
  for(const [id,date] of [['memo-grands-signes-2026-11-10','2026-11-10'],['memo-eveil-musical-2027-02-16','2027-02-16'],['memo-musik-entdecken-2027-03-16','2027-03-16']]){
    const a=byId.get(id);
    assert.equal(a.events[0].date,date);
    assert.equal(a.practical.booking.value,true);
    assert.equal(C.ageFit(a,AGE),true);
    assert.match(a.notes.join(' '),/22 October/);
    assert.match(a.notes.join(' '),/availability of places is not yet known/);
  }
  assert.equal(byId.get('memo-rat-exhibition-2026').events.length,0);
});

test('catalogue opens in a bounded batch while retaining the full result count',()=>{
  // The page shows list().slice(0, state.limit) and labels the button 'Show more'; the slicing itself is DOM wiring in app.js.
  const {list,state,V,t}=load();
  const items=list();
  assert.equal(state.limit,24);
  const html=V.rows(items.slice(0,state.limit));
  assert.equal((html.match(/<li><a class="row[ "]/g)||[]).length,24);
  assert.deepEqual(Array.from(html.matchAll(/data-id="([^"]+)"/g),m=>m[1]),ids(items.slice(0,24)));
  assert.equal(t('list.more',{shown:24,total:items.length}),`Show more · 24 of ${COUNTS.catalog}`);
  assert.equal((V.rows(items.slice(0,48)).match(/<li><a class="row[ "]/g)||[]).length,48);
});

test('dining filter survives restored filters and includes new mountain buvettes',()=>{
  const {list,records}=load({filters:{categories:['dining','invalid']}});
  assert.equal(list().length,records.filter(a=>a.category==='dining'&&isPublished(a)).length);
  assert.ok(list().length>0);
  assert.ok(ids(list()).includes('alice-marly'));
  assert.ok(ids(list()).includes('gros-chaumiaux-cerniat'));
  assert.ok(ids(list()).includes('buvette-sapins-epagny'));
  assert.ok(list().every(a=>a.category==='dining'));
});

test('unknown ages, languages and admission fees remain unknown for original dining venues',()=>{
  const {C,list,state,store,records}=load({filters:{categories:['dining']}});
  const dining=records.filter(a=>a.category==='dining'&&isPublished(a)).length;
  const withAge=['gros-chaumiaux-cerniat','buvette-sapins-epagny','ueberstorf-schluessel-play','sarrazin-lossy-play','plasselb-tennisbuvette-play'];
  for(const a of list().filter(a=>!withAge.includes(a.id))){
    assert.equal(a.min,null,a.id);
    assert.equal(C.ageFit(a,AGE),null,a.id);
    assert.equal(a.languages.length,0,a.id);
    assert.equal(a.priceKind,'unknown',a.id);
    assert.equal(a.amount,null,a.id);
  }
  store.personal.age=AGE;
  assert.equal(list().length,dining,'unknown ages remain discoverable without becoming confirmed');
  state.f.includeUnknownAge=false;
  assert.deepEqual(ids(list()).sort(),['buvette-sapins-epagny','gros-chaumiaux-cerniat']);
  store.personal.age=null;state.f.price='free';
  assert.equal(list().length,0);
});

test('district and parent filters compose with dining, obsolete routes are ignored',()=>{
  const {list,state}=load({filters:{categories:['dining'],parentMatch:true}});
  assert.equal(state.f.parentMatch,true);
  state.f.place='d:sense';
  assert.ok(ids(list()).includes('fein-sein-schwarzsee'));
  state.f.place='d:see';
  assert.deepEqual(ids(list()).sort(),['beachhouse-muntelier','clubcafe-kerzers','jardin-muntelier','kafi8-kerzers','laferme-murten']);
  // The old route filter is gone: a saved session that still has it is not a filter.
  const obsolete=load({filters:{routes:['schwarzsee']}});
  assert.equal(obsolete.list().length,COUNTS.catalog);
  assert.equal(obsolete.C.activeCount(obsolete.state.f,null),0);
});

test('directions use current location by default and preserve an existing home town',()=>{
  const {V,t,store,byId}=load();
  const venue=byId.get('hostellerie');
  assert.ok(venue.address);
  assert.equal(store.personal.origin,'');
  const route=new URL(V.routeURL(venue));
  assert.equal(route.searchParams.has('origin'),false);
  assert.equal(route.searchParams.get('destination'),venue.address);
  // The card offers directions only for an exact address; without one it offers the map.
  const withAddress=V.detail(venue),without=V.detail({...venue,address:''});
  assert.ok(withAddress.includes('google.com/maps/dir/'));
  assert.ok(withAddress.includes(V.esc(t('card.directions'))));
  assert.ok(!without.includes('google.com/maps/dir/'));
  assert.ok(without.includes(V.esc(t('card.map'))));
  // The starting point is kept in the data dialog.
  assert.match(V.data(null,false,true).body,/id="detail-origin"[^>]*value=""/);
  store.personal.origin='Plaffeien';
  assert.equal(new URL(V.routeURL(venue)).searchParams.get('origin'),'Plaffeien, Switzerland');
  assert.match(V.data(null,false,true).body,/id="detail-origin"[^>]*value="Plaffeien"/);
});

test('new preschool options preserve confirmed age, language and parent uncertainty',()=>{
  const {C,list,state,byId}=load({age:AGE});
  const trip=byId.get('trip-trap-marly'),dance=byId.get('zumba-mini-bulle');
  assert.equal(C.ageFit(trip,AGE),true);
  assert.equal(trip.parent,'no');
  assert.deepEqual(Array.from(trip.languages),['DE/FR']);
  assert.equal(trip.amount,490);
  assert.match(trip.price,/semester/);
  assert.equal(trip.practical.booking.value,true);
  assert.equal(trip.practical.commitment.value,true);
  assert.equal(trip.practical.groupSize.value,10);
  assert.equal(trip.practical.trial,undefined);
  assert.equal(dance.parent,'unknown');
  assert.equal(C.ageFit(dance,AGE),true);
  assert.equal(dance.days.length,0,'ambiguous weekly planning must not become calendar dates');
  assert.equal(dance.practical.booking.value,true);
  assert.equal(dance.practical.commitment.value,false);
  assert.equal(dance.practical.trial,undefined);
  state.f.place='d:sarine';state.f.categories.add('play');state.f.languages.add('DE/FR');state.f.includeUnknownAge=false;
  assert.ok(ids(list()).includes(trip.id));
  state.f.parentMatch=true;
  assert.ok(!ids(list()).includes(trip.id));
  assert.equal(byId.get('chez-betty-massonnens').status,'check');
  assert.equal(byId.get('fetigny-peralles-picnic').category,'nature');
});

test('secondary play evidence is clearly attributed and BEO is not a free cafe',()=>{
  const {byId}=load();
  assert.match(byId.get('bistro11-duedingen').notes.join(' '),/Bärner Mamis/);
  assert.match(byId.get('migros-avry-play').notes.join(' '),/2025/);
  assert.equal(byId.get('bistro11-duedingen').status,'check');
  assert.equal(byId.get('migros-avry-play').status,'active');
  assert.match(byId.get('migros-avry-play').notes.join(' '),/The owner's reply/);
  const beo=byId.get('beo-funpark');
  assert.equal(beo.category,'play');assert.equal(beo.amount,19);assert.equal(beo.priceKind,'visit');
  assert.equal(byId.get('eispalaeste').status,'closed');
});

test('follow-up status decisions cover all sixteen new venues without implying age suitability',{skip:PRIVATE_SKIP},()=>{
  const {records,C}=load();
  const review=readJson('editorial/family-venues-detail-check-2026-09-27.json');
  const visitorReview=readJson('editorial/family-venues-visitor-check-2026-09-27.json');
  const updates=readJson('editorial/approved-updates.json').updates;
  const decisions=new Map(review.records.map(r=>[r.id,r]));
  const venues=records.filter(a=>decisions.has(a.id));
  assert.equal(review.directContactMade,false);
  assert.equal(decisions.size,16);
  assert.equal(venues.filter(a=>a.status==='active').length,10);
  assert.equal(venues.filter(a=>a.status==='check').length,6);
  for(const a of venues){
    const decision=decisions.get(a.id);
    assert.ok(decision,a.id);
    assert.equal(a.status,visitorReview.statusOverrides[a.id]||decision.status,a.id);
    const full=updates.filter(update=>update.draft.cardId===a.id&&update.draft.reviewCoverage?.mode==='full').at(-1);
    assert.equal(a.checked,full?.draft.patch.checked||LATER_FULL_REVIEW[a.id]||review.checked,a.id);
    assert.equal(C.ageFit(a,AGE),null,a.id);
    assert.ok(decision.remaining.length,a.id);
    assert.ok(decision.sourceUrls.length,a.id);
  }
});

test('visitor research covers sixteen venues and preserves provenance for nine enrichments',{skip:PRIVATE_SKIP},()=>{
  const {byId}=load();
  const review=readJson('editorial/family-venues-visitor-check-2026-09-27.json');
  assert.equal(review.directContactMade,false);
  assert.equal(new Set(review.records.map(r=>r.id)).size,16);
  assert.equal(review.records.filter(r=>r.updated).length,9);
  for(const r of review.records){
    assert.ok(byId.has(r.id));
    assert.ok(r.remaining);
    assert.ok(r.sources.length);
    if(r.updated)assert.ok(r.sources.some(url=>byId.get(r.id).sources.some(s=>s.url===url)),r.id);
  }
});

test('visitor research notes keep their caveats in the catalogue',()=>{
  const {byId}=load();
  assert.match(byId.get('bistro11-duedingen').notes.join(' '),/photographs show a wooden toy coffee machine/);
  assert.match(byId.get('kafi8-kerzers').notes.join(' '),/copy of a Google review/);
  assert.match(byId.get('jardin-muntelier').notes.join(' '),/"2 years ago"/);
  assert.match(byId.get('beachhouse-muntelier').notes.join(' '),/not two independent confirmations/);
  assert.match(byId.get('migros-avry-play').notes.join(' '),/do not confirm that it currently works/);
});

test('follow-up preserves dated caveats, closures and price units',()=>{
  const {byId}=load();
  assert.match(byId.get('kafi8-kerzers').schedule,/closed 5–18 October 2026/);
  assert.match(byId.get('laferme-murten').schedule,/Mon–Fri 09:00–18:30/);
  assert.doesNotMatch(byId.get('laferme-murten').schedule,/confirm/i);
  assert.match(byId.get('seepark-schiffenen').schedule,/09:30–22:00/);
  assert.match(byId.get('leset-villars').price,/spring 2026/);
  assert.match(byId.get('beachhouse-muntelier').price,/Summer menu 2026/);
  assert.equal(byId.get('sarrazin-lossy').amount,null,'free empty plate is not free admission');
  assert.match(byId.get('sarrazin-lossy').notes.join(' '),/not a free children's dish/);
  assert.match(byId.get('beo-funpark').schedule,/Mon–Fri 11–18; Sat 10–20; Sun 10–18/);
  assert.match(byId.get('beo-funpark').notes.join(' '),/there is no supervision by staff/);
});

test('new category coverage does not imply a completed regional survey',()=>{
  const coverage=readJson('editorial/coverage-see.json');
  const dining=coverage.cells.filter(c=>c.category==='dining');
  assert.equal(dining.length,14);
  assert.equal(dining.filter(c=>c.status==='partial').length,4);
  assert.equal(dining.filter(c=>c.status==='search-only').length,10);
});

test('watched family sources refer to existing cards and have a monthly interval',()=>{
  const {byId}=load();
  const config=readJson('editorial/source-watch.json');
  assert.equal(new Set(config.sources.map(s=>s.id)).size,config.sources.length);
  const dining=config.sources.filter(s=>s.id.startsWith('dining-'));
  assert.equal(dining.length,12);
  for(const s of dining){assert.equal(s.intervalDays,30);for(const id of s.recordIds)assert.ok(byId.has(id),id);}
});

test('deep review covers active cards and preserves receipts for ended events',()=>{
  const {records,byId,C}=load();
  const main=records.filter(a=>!C.isArchive(a));
  assert.equal(main.length,COUNTS.catalog);
  assert.equal(main.filter(a=>a.research).length,main.length,'every published card carries a deep-review record');
  for(const a of main){
    assert.match(a.research.date,/^\d{4}-\d{2}-\d{2}$/,a.id);
    assert.equal(new Date(a.research.date+'T12:00:00Z').toISOString().slice(0,10),a.research.date,a.id);
    assert.ok(a.research.date<=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'}),a.id+': future review date');
    assert.ok(a.research.remaining.length,a.id);
    for(const f of a.research.findings){
      assert.ok(f.field && f.text,a.id);
      assert.equal(new URL(f.url).protocol,'https:');
      assert.ok(a.sources.some(s=>s.url===f.url),a.id);
    }
  }
  const counts=Object.fromEntries(['enriched','rechecked','unresolved','reused'].map(outcome=>[outcome,main.filter(a=>a.research.outcome===outcome).length]));
  assert.equal(Object.values(counts).reduce((sum,count)=>sum+count,0),main.length);
  assert.ok(counts.enriched>=134 && counts.unresolved>=34);
  assert.deepEqual(ids(records.filter(a=>C.isArchive(a)&&a.research)).sort(),['alpabzug','chocolat','memo-musik-entdecken-2026-09-29','plage-chevroux']);
  for(const id of ['swim-duedingen','playgrounds-marly','elki-kerzers'])assert.deepEqual(Array.from(byId.get(id).days),[],`${id}: stale schedule must not appear as a weekday`);
  assert.equal(byId.get('playgrounds-marly').scheduleValidThrough,null);
  assert.equal(byId.get('elki-kerzers').scheduleValidThrough,null);
});

test('all four expanded districts have sourced cards and participate in normal filters',()=>{
  const {records,list,state,byId}=load();
  const counts=Object.fromEntries(['gruyere','glane','broye','veveyse'].map(region=>[region,COUNTS.byRegion[region]]));
  for(const [region,count] of Object.entries(counts))assert.ok(count>0,region+': the profile counts cards in every expanded district');
  assert.equal(new Set(EXPANSION_IDS).size,37);
  for(const id of EXPANSION_IDS)assert.ok(records.some(a=>a.id===id&&Object.hasOwn(counts,a.region)),id);
  for(const [region,count] of Object.entries(counts)){
    const cards=records.filter(a=>a.region===region&&!['closed','excluded'].includes(a.status));
    assert.equal(cards.length,count,region);
    // Since 14 October 2026 the catalogue lists organisation contacts only, so a card may have none; its sources lead to the organiser.
    for(const a of cards){
      assert.ok(a.sources.length && a.notes.length>=2 && a.address,a.id);
      assert.ok(a.research?.findings.length && a.research.remaining.length,a.id);
      assert.ok(a.intro && a.practical?.scenario,a.id);
      assert.ok(Object.values(a.practical).some(value=>value?.source && a.sources.some(s=>s.url===value.source)),a.id);
    }
    state.f.place='d:'+region;
    assert.equal(list().length,count,region);
  }
  const aged=load({age:AGE});
  aged.state.f.place='d:broye';aged.state.f.categories.add('movement');aged.state.f.includeUnknownAge=false;
  assert.ok(ids(aged.list()).includes('fsg-elki-lully'));
  assert.ok(aged.list().every(a=>a.region==='broye' && a.category==='movement'));
  assert.match(byId.get('epicentre-pataugeoire-romont').price,/child under 6 free/);
  assert.equal(byId.get('fsg-domdidier-parent').status,'check');
  assert.equal(byId.get('fsg-domdidier-parent').min,3);
  assert.match(byId.get('fsg-domdidier-parent').schedule,/group is full/);
  assert.match(byId.get('fsg-chatel-parent-remaufens').practical.trial.text,/Three trial sessions/);
});

test('canton follow-up preserves uncertainty and filters across every district',()=>{
  const {records,list,state,byId}=load();
  const followup=records.filter(a=>a.research?.findings.some(f=>FOLLOWUP_FIELDS.includes(f.field)));
  assert.equal(followup.length,108);
  assert.deepEqual([...new Set(followup.map(a=>a.region))].sort(),['broye','glane','gruyere','sarine','see','sense','veveyse']);
  for(const a of followup){
    assert.ok(a.address&&a.sources.length&&a.notes.length>=2,a.id); // a card may have no contact since 14 October 2026
    if(a.id==='trip-trap-marly')assert.deepEqual(Array.from(a.languages),['DE/FR']);
    else assert.equal(a.languages.length,0,a.id);
    if(a.min!==null)assert.ok(a.age && a.sources.length,a.id);
    assert.ok(a.research.remaining.length&&a.practical.warnings.length,a.id);
    assert.ok(a.sources.some(s=>s.url===a.practical.indoor.source),a.id);
    state.f.place='d:'+a.region;assert.ok(ids(list()).includes(a.id),a.id);
  }
  for(const id of ['fun4all-sevaz-kids','broc-outdoor-pool','clos-cerfs-gruyeres','paccots-recreation','seeweid-play','grengspitz-beaches']){
    assert.equal(byId.get(id).status,'check',id);
    assert.deepEqual(Array.from(byId.get(id).days),[],id);
  }
  assert.equal(byId.get('jeuss-animal-park').priceKind,'free');
  assert.equal(byId.get('font-beach').priceKind,'unknown');
  for(const id of ['bruenisried-forest-playgroup','saint-martin-besencens-atelier','st-silvester-spielgruppe'])assert.equal(byId.get(id).parent,'unknown',id);
});

test('See follow-up cards use normal filters and do not revive obsolete schedules',()=>{
  const {C,list,state,store,byId}=load();
  const added=['familybloom-yoga','familybloom-mini-move','stimm-family','suniai-family-yoga','kibim-murten','baby-bade-murten','schlittschuh-gurmels','gym-parents-misery','jeux-apav-vully-2026'];
  assert.equal(new Set(added).size,added.length);
  for(const id of added){
    const a=byId.get(id);
    assert.ok(a,id);
    assert.ok(a.research?.findings.length,id);
    assert.ok(a.sources.length,id);
    assert.ok(a.address,id);
    assert.equal(a.parent,id==='jeux-apav-vully-2026'?'unknown':'yes',id);
  }
  state.f.place='d:see';
  assert.ok(added.filter(id=>id!=='suniai-family-yoga').every(id=>ids(list()).includes(id)));
  assert.ok(!ids(list()).includes('suniai-family-yoga'));
  state.f.place='d:sense';
  assert.ok(ids(list()).includes('suniai-family-yoga'));
  state.f.place='';state.f.categories.add('music');
  assert.ok(ids(list()).includes('stimm-family'));
  assert.ok(!ids(list()).includes('kibim-murten'));
  state.f.categories.clear();store.personal.age=AGE;state.f.includeUnknownAge=false;
  assert.ok(ids(list()).includes('familybloom-yoga'));
  assert.ok(!ids(list()).includes('suniai-family-yoga'));
  assert.equal(C.ageFit(byId.get('familybloom-yoga'),AGE),true);
  store.personal.age=null;state.f.days.add(6);
  assert.ok(ids(list()).includes('suniai-family-yoga'));
  for(const id of ['familybloom-yoga','kibim-murten','baby-bade-murten','gym-parents-misery'])assert.ok(!ids(list()).includes(id),id);
  assert.equal(byId.get('suniai-family-yoga').events.length,3);
  assert.equal(byId.get('jeux-apav-vully-2026').events[0].start,'');
  assert.equal(byId.get('familybloom-yoga').amount,null);
  for(const id of ['stimm-family','baby-bade-murten','gym-parents-misery'])assert.equal(byId.get(id).min,null,`${id}: historical age must remain unconfirmed`);
});

test('uncertain sources do not become current eligibility or invented calendar dates',()=>{
  const {C,byId}=load();
  const yoga=byId.get('haragati');
  assert.equal(yoga.research.outcome,'unresolved');
  assert.equal(yoga.min,4);
  assert.equal(C.ageFit(yoga,AGE),false);
  assert.equal(yoga.parent,'yes');
  assert.deepEqual(Array.from(yoga.days),[],'suspended hours are not treated as a current weekly event');
  assert.match(yoga.schedule,/November 2026/);
  assert.equal(byId.get('candles-plaffeien').events.length,0);
  assert.match(byId.get('candles-plaffeien').schedule,/contradicts itself/);
  assert.equal(byId.get('fyfauter').status,'check');
  assert.equal(byId.get('psymolo').research.findings.length,1);
  assert.equal(byId.get('psymolo').status,'check');
  assert.match(byId.get('papiliorama-kerzers').schedule,/opening time to be confirmed/);
});

test('corrected schedules and price units reach real app data',()=>{
  const {byId}=load();
  assert.match(byId.get('biblio-tafers').schedule,/15:00–19:00/);
  assert.match(byId.get('ludo-giffers').schedule,/1st and 3rd/);
  assert.equal(byId.get('memo-library').priceKind,'free');
  assert.equal(byId.get('library-murten').priceKind,'free');
  assert.equal(byId.get('library-murten').amount,0);
  assert.match(byId.get('library-murten').price,/to take home/);
  assert.equal(byId.get('swim-courtepin-babies').amount,324);
  assert.match(byId.get('swim-courtepin-babies').price,/adult entry included/);
  assert.equal(byId.get('candles-giffers').amount,null,'price per weight cannot be a flat admission price');
  assert.equal(byId.get('christmas-plaffeien').events.length,7);
  assert.ok(byId.get('christmas-plaffeien').events.every(e=>e.date==='2026-12-12'));
  assert.equal(byId.get('kinderfeier').parent,'yes');
  assert.ok(byId.get('kinderfeier').events.every(e=>e.date.startsWith('2026-')),'different 2027 venues stay in source-linked details, not misleading ICS locations');
  assert.equal(byId.get('familienkonzert-kerzers-2026').events[0].end,'17:00');
  assert.equal(byId.get('spielkafi-kerzers-2026').events[0].date,'2026-10-25');
});

test('source-linked details escape text, refuse unsafe links and preserve unknowns',()=>{
  const {byId,V,t}=load({age:AGE});
  const base=byId.get('alice-marly');
  const hostile='<img src=x onerror=alert(1)>';
  const record={...base,name:'<script>alert(1)</script> Café "Q" & \'R\'',intro:'<b>intro</b>',notes:[hostile],schedule:'<i>Mon</i>',price:'<u>CHF 5</u>',address:'<s>1 Street</s>',
    practical:{...base.practical,photo:undefined,gallery:undefined,warnings:['<mark>careful</mark>']},
    contacts:[{name:'<em>Name</em>',phone:'026 123 45 67',email:'a"b@example.ch'}],
    sources:[{url:'javascript:alert(1)',label:'<svg onload=alert(1)>'},{url:'https://example.ch/?a=1&b="2"',label:'<kbd>Source</kbd>'}],
    research:{date:'2026-09-27',findings:[{field:'<script>',text:hostile,url:'javascript:alert(1)',kind:'historical'}],remaining:['<b>Price?</b>']}};
  const html=V.detail(record),row=V.row(record);
  for(const markup of [html,row]){
    assert.ok(!/<script|<img|<b>|<i>|<u>|<s>|<em>|<mark>|<kbd>|<svg onload|javascript:/.test(markup),'card text must not become markup');
    assert.ok(markup.includes('&lt;script&gt;alert(1)&lt;/script&gt; Café &quot;Q&quot; &amp; &#39;R&#39;'));
  }
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;b&gt;Price?&lt;/b&gt;'));
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;')===false,'a source with an unsafe link is not shown as a link');
  // Only the https source is a link, and its address is escaped inside the attribute.
  assert.equal(count(html,'href="https://example.ch/?a=1&amp;b=&quot;2&quot;"'),2,'the organiser button and the source list');
  assert.ok(html.includes('&lt;kbd&gt;Source&lt;/kbd&gt;'));
  assert.ok(html.includes('a&quot;b@example.ch'));
  // Unknowns stay visible as unknowns; sections without content are not invented.
  const bare=V.detail({...base,address:'',sources:[],contacts:[],research:undefined,intro:''});
  assert.ok(bare.includes(`<span class="np">${V.esc(t('common.notPublished'))}</span>`));
  assert.ok(bare.includes(V.esc(t('card.noContact'))));
  assert.ok(bare.includes(V.esc(t('card.noSources'))));
  assert.ok(bare.includes(V.esc(t('card.noDescription'))));
  for(const heading of ['card.checkedTitle','card.toConfirm'])assert.ok(!bare.includes(V.esc(t(heading))),heading);
  assert.ok(!bare.includes('data-action="copy-questions"'));
});

test('list rows and card pages show the status label from the dictionary',()=>{
  const {C,V,t,byId}=load({age:AGE});
  const base=byId.get('alice-marly');
  // An active card with no overdue dates keeps its status; the visitor sees the dictionary's short and long wording.
  const sample={...base,status:'active',reviewAfter:'2099-01-01',scheduleValidThrough:null,events:[]};
  assert.equal(C.statusOf(sample,AGE),'active');
  assert.ok(V.row(sample).includes(`${V.esc(t('status.active.short'))}</span>`));
  assert.ok(V.detail(sample).includes(V.esc(t('status.active.long'))));
  // In a row "Current" is written without a dot; the remaining dots mark what needs a look.
  assert.ok(!V.row(sample).includes('class="dot good"'));
  assert.ok(V.row({...sample,status:'check'}).includes('class="dot check"'));
  const check={...sample,status:'check'};
  assert.equal(C.statusOf(check,AGE),'check');
  assert.ok(V.row(check).includes(V.esc(t('status.check.short'))));
  assert.ok(V.detail(check).includes(V.esc(t('status.check.long'))));
  // Overdue review dates turn an active card into one to check.
  assert.equal(C.statusOf({...sample,reviewAfter:'2026-10-13'},AGE),'check');
  assert.equal(C.statusOf({...sample,scheduleValidThrough:'2026-10-13'},AGE),'check');
  assert.equal(C.statusOf({...sample,events:[{date:'2026-10-13',start:'09:00',end:'10:00'}]},AGE),'check');
  // A card for older children is 'for later' only while the chosen age is below its minimum.
  const pony=byId.get('pony-entdecken');
  assert.equal(C.statusOf(pony,AGE),'future');
  assert.equal(C.statusOf(pony,5),'check');
  assert.equal(C.statusOf(pony,null),'future','with no age chosen the card is flagged for later');
  assert.ok(V.detail(pony).includes(V.esc(t('status.future.long'))));
  assert.ok(V.row(pony).includes(V.esc(t('status.future.short'))));
  // Archived cards keep their own status whatever the age.
  const closed=byId.get('memo-musik-entdecken-2026-09-29'),excluded=byId.get('chocolat');
  assert.ok(V.row(closed).includes(`${V.esc(t('status.closed.short'))}</span>`));
  assert.ok(V.detail(closed).includes(V.esc(t('status.closed.long'))));
  assert.ok(V.row(excluded).includes(`${V.esc(t('status.excluded.short'))}</span>`));
  assert.ok(V.detail(excluded).includes(V.esc(t('status.excluded.long'))));
  // The statuses are worded differently in each of the three languages.
  for(const lang of ['de','fr']){
    const other=load({lang});
    assert.notEqual(other.t('status.check.short'),t('status.check.short'),lang);
    assert.ok(other.V.row({...check}).includes(other.V.esc(other.t('status.check.short'))),lang);
  }
});

test('age selection separates confirmed and unknown and excludes known mismatches',()=>{
  const {C,V,F,t,list,state,store,byId}=load({age:AGE});
  const items=list();
  const summary=C.ageSummary(items,AGE);
  const alice=byId.get('alice-marly'),pony=byId.get('pony-entdecken');
  assert.ok(summary.fits>0);
  assert.ok(summary.unknown>0);
  assert.equal(summary.fits+summary.unknown,items.length);
  assert.equal(C.ageFit(alice,AGE),null);
  assert.ok(ids(items).includes('alice-marly'),'a card with no published age stays discoverable');
  assert.ok(items.every(a=>C.ageFit(a,AGE)!==false));
  assert.ok(!ids(items).includes('pony-entdecken'));
  // Confirmed cards come first, then the cards that do not say.
  const firstUnknown=items.findIndex(a=>C.ageFit(a,AGE)!==true);
  assert.ok(firstUnknown>0);
  assert.ok(items.slice(0,firstUnknown).every(a=>C.ageFit(a,AGE)===true));
  assert.ok(items.slice(firstUnknown).every(a=>C.ageFit(a,AGE)===null));
  assert.equal(firstUnknown,summary.fits);
  // The list row marks only the confirmed ones; the card page says which case applies.
  const age=F.ageBare(AGE);
  const mark=V.esc(t('fit.sr',{age}));
  assert.ok(V.row(items[0]).includes(mark));
  assert.ok(!V.row(alice).includes(mark));
  assert.ok(V.detail(items[0]).includes(V.esc(t('fit.yes',{age}))));
  assert.ok(V.detail(alice).includes(V.esc(t('fit.unknown',{age}))));
  assert.ok(V.detail(pony).includes(V.esc(t('fit.no',{age}))));
  state.f.includeUnknownAge=false;
  assert.ok(list().every(a=>C.ageFit(a,AGE)===true));
  assert.equal(C.ageSummary(list(),AGE).unknown,0);
  assert.equal(list().length,summary.fits);
  // The age handed to the filter decides; the stored profile is not touched by asking about another age.
  assert.ok(ids(list({age:4})).includes('pony-entdecken'));
  assert.ok(ids(list({age:6})).includes('pony-entdecken'),'the published maximum is inclusive');
  assert.ok(!ids(list({age:7})).includes('pony-entdecken'));
  assert.equal(store.personal.age,AGE);
});

test('unknown-age preference restores false and old sessions migrate to inclusive selection',()=>{
  assert.equal(load({filters:{ageMatch:true}}).state.f.includeUnknownAge,true);
  assert.equal(load({filters:{includeUnknownAge:'no'}}).state.f.includeUnknownAge,true,'only an explicit false switches it off');
  const strict=load({age:AGE,filters:{ageMatch:true,includeUnknownAge:false}});
  assert.equal(strict.state.f.includeUnknownAge,false);
  assert.ok(strict.list().every(a=>strict.C.ageFit(a,AGE)===true));
  // The preference survives the round trip through the session storage.
  const again=strict.C.restoreFilters(JSON.parse(JSON.stringify(strict.C.serializeFilters(strict.state.f))));
  assert.equal(again.includeUnknownAge,false);
});

test('default ordering puts published ages first and then sorts by name without claiming quality',()=>{
  const {C,list,state,store}=load({age:AGE});
  const items=list();
  assert.equal(C.ageFit(items[0],AGE),true);
  let previous=-1;
  for(const a of items){const rank=C.ageFit(a,AGE)===true?0:C.ageFit(a,AGE)===null?1:2;assert.ok(rank>=previous);previous=rank;}
  for(let i=1;i<items.length;i++){
    if(C.ageRank(items[i-1],AGE)===C.ageRank(items[i],AGE))assert.ok(items[i-1].name.localeCompare(items[i].name,'en')<=0,items[i].id);
  }
  // Without an age nothing is ranked: the order is by name alone.
  store.personal.age=null;
  const plain=list();
  for(let i=1;i<plain.length;i++)assert.ok(plain[i-1].name.localeCompare(plain[i].name,'en')<=0,plain[i].id);
  // The other sort orders are chosen explicitly.
  state.f.sort='town';
  const byTown=list();
  for(let i=1;i<byTown.length;i++)assert.ok(byTown[i-1].town.localeCompare(byTown[i].town,'de-CH')<=0,byTown[i].id);
  state.f.sort='date';
  const byDate=list();
  const next=a=>C.upcoming(a)[0]?.date||'9999';
  for(let i=1;i<byDate.length;i++)assert.ok(next(byDate[i-1])<=next(byDate[i]),byDate[i].id);
  assert.notEqual(next(byDate[0]),'9999');
  assert.equal(next(byDate.at(-1)),'9999');
  assert.equal(load({filters:{sort:'random'}}).state.f.sort,'default');
});

test('detail presentation preserves every note, finding, question, price and source for all records',()=>{
  for(const age of [null,AGE]){
    const {records,V,t}=load({age});
    for(const a of records){
      const html=V.detail(a);
      const texts=[...a.notes,a.schedule,a.price,a.age,a.intro||'',...(a.research?.findings||[]).map(f=>f.text),...(a.research?.remaining||[]),
        ...Object.values(a.practical||{}).map(f=>f?.text).filter(Boolean),...a.contacts.flatMap(c=>[c.name,c.phone,c.email]).filter(Boolean),...a.sources.map(s=>s.label)];
      // An address that differs by date is shown with each date instead of once at the top.
      if(!a.events.some(e=>e.address&&e.address!==a.address))texts.push(a.address);
      for(const text of texts)assert.ok(html.includes(V.esc(text)),a.id+': '+text);
      for(const source of a.sources)assert.ok(html.includes(V.esc(source.url)),a.id+': '+source.url);
      assert.match(html,/class="d-actions"/);
      assert.match(html,/data-close/);
      assert.ok(html.includes(V.esc(t('card.back'))),a.id);
      assert.doesNotMatch(html,/undefined|NaN/,a.id);
    }
  }
});

test('cafe, class and event keep their own facts and keep essential questions outside disclosures',()=>{
  const {V,t,byId}=load({age:AGE});
  const open=(html,part)=>count(html.slice(0,html.indexOf(part)),'<details')-count(html.slice(0,html.indexOf(part)),'</details>');
  const cafe=V.detail(byId.get('alice-marly'));
  assert.ok(cafe.includes(V.esc(t('category.dining'))));
  assert.ok(cafe.includes(V.esc(t('fact.schedule'))));
  const intro=V.esc(byId.get('alice-marly').intro);
  assert.ok(cafe.includes(intro));
  assert.ok(cafe.indexOf(intro)<cafe.indexOf(V.esc(t('card.toConfirm'))));
  assert.ok(cafe.indexOf(V.esc(t('card.toConfirm')))<cafe.indexOf(V.esc(t('card.contacts'))));
  assert.equal(open(cafe,V.esc(t('card.toConfirm'))),0,'the questions are not inside a disclosure');
  assert.ok(cafe.includes('data-action="copy-questions"'));
  // The unknown age is said once as a warning and once as a note for the chosen age, not repeated.
  assert.equal(count(cafe,V.esc(t('warning.ageNotPublished'))),1);
  assert.equal(count(cafe,V.esc(t('fit.unknown',{age:AGE}))),1);
  const course=V.detail(byId.get('swim-tentlingen'));
  assert.ok(course.includes(V.esc(t('fact.courseHint'))),'a course price is labelled as a course price');
  assert.ok(course.includes(V.esc(t('fact.languages'))));
  assert.ok(course.includes(V.esc(t('admission.course'))));
  assert.ok(course.includes(V.esc(t('cost.title'))));
  const event=V.detail(byId.get('christmas-plaffeien'));
  assert.ok(event.includes(V.esc(t('dates.title'))));
  assert.ok(event.includes(V.esc(t('admission.unknown'))));
  assert.equal(count(event,'data-plan-event='),7);
  assert.equal(count(event,'data-ics='),7);
  const club=V.detail(byId.get('elki-plaffeien'));
  assert.ok(club.includes(V.esc(t('practical.trial'))));
  assert.ok(club.includes(V.esc(t('card.practical'))));
  assert.ok(club.includes(V.esc(t('parent.yes.long'))));
});

test('question copying uses public questions only, never personal notes, age or family details',()=>{
  const {V,t,store,byId}=load({age:AGE});
  const a=byId.get('alice-marly');
  store.personal.notes[a.id]='PRIVATE NOTE';
  const html=V.detail(a);
  assert.ok(a.research.remaining.length);
  const heading=V.esc(t('card.toConfirm'));
  const section=html.slice(html.indexOf(heading),html.indexOf('</section>',html.indexOf(heading)));
  for(const q of a.research.remaining)assert.ok(section.includes(V.esc(q)));
  assert.ok(section.includes('data-action="copy-questions"'));
  assert.ok(!section.includes('PRIVATE NOTE'));
  // The copy handler lives in app.js (DOM wiring); it must build the text from the card's own name and questions alone.
  const source=fs.readFileSync(path.join(root,'app.js'),'utf8');
  const start=source.indexOf("'copy-questions'");
  assert.ok(start>0,"the 'copy-questions' handler was not found in app.js: update this test");
  const next=source.indexOf("\n    '",start+1);
  const handler=source.slice(start,next>0?Math.min(next,start+600):start+600);
  assert.match(handler,/a\.name/);
  assert.match(handler,/research\??\.remaining/);
  assert.doesNotMatch(handler,/personal|notes|statuses|favorites|visits|origin|\bage\b|store\./);
});

test('additional findings and open questions participate in catalogue search',()=>{
  const {C,list,state,byId}=load();
  state.f.query='tropical';
  assert.ok(ids(list()).includes('papiliorama-kerzers'));
  state.f.query='medical certificate';
  assert.ok(ids(list()).includes('snowli'));
  // Every published card is found by the first words of its first finding and of its first open question.
  state.f.query='';
  for(const a of byId.values()){
    if(C.isArchive(a)||!a.research)continue;
    for(const text of [a.research.findings[0]?.text,a.research.remaining[0]]){
      if(!text)continue;
      const query=text.split(/\s+/).slice(0,4).join(' ');
      assert.ok(C.matches(a,{...state.f,query},{}),`${a.id}: ${query}`);
    }
  }
});

test('search also finds German and French place names, category names and the visitor\'s own notes',()=>{
  const {C,list,state,store,byId}=load();
  const find=query=>{state.f.query=query;return list();};
  assert.ok(find('Freiburg').some(a=>a.town==='Fribourg'));
  assert.ok(find('Morat').some(a=>a.town==='Murten'));
  assert.ok(find('Chiètres').some(a=>a.town==='Kerzers'));
  assert.ok(find('Chietres').some(a=>a.town==='Kerzers'),'accents do not matter');
  assert.ok(find('Dudingen').some(a=>a.town==='Düdingen'));
  assert.equal(find('FRIBOURG').length,find('fribourg').length);
  const swimming=find('Swimming');
  assert.ok(swimming.length>0);
  assert.ok(Array.from(byId.values()).filter(a=>a.category==='water'&&!C.isArchive(a)).every(a=>ids(swimming).includes(a.id)));
  assert.equal(find('zebra').length,0);
  store.personal.notes['cafe-marly']='Zebra crossing at the corner';
  assert.deepEqual(ids(find('zebra')),['cafe-marly']);
  assert.equal(find('zebra platypus').length,0,'every word of the query has to match');
});

test('every filter option selects only cards that have the property, and some cards',()=>{
  const {C,K,list,state}=load();
  const weekday=date=>new Date(date+'T12:00:00Z').getUTCDay()||7;
  // 14 October 2026 is a Wednesday and the test clock stands at 10:00, so the weekend is 17 and 18 October.
  const dated=(a,from,to)=>a.events.some(e=>e.date>=from&&e.date<=to&&(e.date!=='2026-10-14'||!e.end||e.end>='10:00'));
  // Today, this weekend and the next 7 days also count a card without dated sessions on its weekdays while its schedule is valid and does
  // not limit that weekday ("1st and 3rd Wed", every other week, dates not confirmed: K.restrictedOn, tested on its own in near-week.test.mjs).
  const repeats=(a,dates)=>!a.events.length&&dates.some(d=>a.days.includes(weekday(d))&&(!a.scheduleValidThrough||a.scheduleValidThrough>=d)&&!K.restrictedOn(a.schedule,weekday(d)));
  const days=(from,n)=>Array.from({length:n},(_,i)=>new Date(Date.parse(from+'T12:00:00Z')+i*864e5).toISOString().slice(0,10));
  const cases=[
    ['category',f=>f.categories.add('water'),a=>a.category==='water'],
    ['format',f=>f.formats.add('event'),a=>a.format==='event'],
    ['language FR',f=>f.languages.add('FR'),a=>a.languages.includes('FR')||a.languages.includes('DE/FR')],
    ['language not stated',f=>f.languages.add('unknown'),a=>a.languages.length===0],
    ['weekday',f=>f.days.add(6),a=>a.days.includes(6)||a.events.some(e=>weekday(e.date)===6)],
    ['condition: trial visit',f=>f.needs.add('trial'),a=>a.practical?.trial?.value===true],
    ['condition: no course fee',f=>f.needs.add('noCourse'),a=>a.practical?.commitment?.value===false],
    ['when: upcoming',f=>{f.when='upcoming';},a=>dated(a,'2026-10-14','9999-12-31')],
    ['when: today',f=>{f.when='today';},a=>dated(a,'2026-10-14','2026-10-14')||repeats(a,days('2026-10-14',1))],
    ['when: next 7 days',f=>{f.when='week';},a=>dated(a,'2026-10-14','2026-10-20')||repeats(a,days('2026-10-14',7))],
    ['when: this weekend',f=>{f.when='weekend';},a=>dated(a,'2026-10-17','2026-10-18')||repeats(a,days('2026-10-17',2))],
    ['price: free or donation',f=>{f.price='free';},a=>a.priceKind==='free'||a.priceKind==='donation'],
    ['price: per course',f=>{f.price='course';},a=>a.priceKind==='course'],
    ['price: unclear',f=>{f.price='unknown';},a=>a.priceKind==='unknown'],
    ['status: check details',f=>{f.status='check';},a=>C.statusOf(a,null)==='check'],
    ['status: current',f=>{f.status='active';},a=>C.statusOf(a,null)==='active'],
    ['with an adult',f=>{f.parentMatch=true;},a=>a.parent==='yes'],
    ['indoors (rainy day)',f=>{f.indoor=true;},a=>a.practical?.indoor?.value===true],
    ['preset: no booking',f=>{f.preset='walkin';},a=>a.practical?.booking?.value===false],
    ['scenario: course',f=>{f.scenario='course';},a=>(a.practical?.scenario||{group:'course',individual:'course'}[a.format])==='course'],
    ['scenario: visit',f=>{f.scenario='visit';},a=>(a.practical?.scenario||{self:'visit'}[a.format])==='visit']
  ];
  const total=list().length;
  for(const [name,set,has] of cases){
    state.f=K.defaultFilters();set(state.f);
    const items=list();
    assert.ok(items.length>0,name+': selects some cards');
    assert.ok(items.length<total,name+': selects fewer cards than the whole list');
    assert.ok(items.every(has),name+': every selected card has the property');
    // and no published card with the property was left out
    const left=Array.from(C.activities).filter(a=>!C.isArchive(a)&&has(a)&&!items.includes(a));
    assert.deepEqual(ids(left),[],name+': no matching card is missing');
  }
  // Choosing several values in one group widens the result; choosing groups together narrows it.
  state.f=K.defaultFilters();state.f.categories.add('water');
  const water=list().length;
  state.f.categories.add('music');
  const both=list().length;
  assert.ok(both>water);
  state.f.languages.add('FR');
  assert.ok(list().length>0&&list().length<both);
  assert.ok(list().every(a=>['water','music'].includes(a.category)&&(a.languages.includes('FR')||a.languages.includes('DE/FR'))));
});

test('filter state restored from the session rejects unknown values',()=>{
  const {C,K,P}=load();
  const restored=C.restoreFilters({place:'d:atlantis',categories:['dining','bogus',7],formats:['group','teleport'],languages:['DE','Klingon'],days:[1,'3',9,'x',0],needs:['trial','nope'],
    when:'next-year',price:'cheap',status:'gone',scenario:'party',preset:'cloudy',sort:'random',planStatus:'maybe',parentMatch:'yes',includeUnknownAge:'no',query:123});
  assert.equal(restored.place,'');
  assert.deepEqual([...restored.categories],['dining']);
  assert.deepEqual([...restored.formats],['group']);
  assert.deepEqual([...restored.languages],['DE']);
  assert.deepEqual([...restored.days].sort(),[1,3]);
  assert.deepEqual([...restored.needs],['trial']);
  for(const key of ['when','price','status','scenario','preset','planStatus','query'])assert.equal(restored[key],'',key);
  assert.equal(restored.sort,'default');
  assert.equal(restored.parentMatch,false,'only a real true switches the adult filter on');
  assert.equal(restored.includeUnknownAge,true);
  // Garbage in any shape gives the default filters.
  for(const junk of [null,undefined,'text',42,[],{categories:'dining',days:'1'}]){
    const f=C.restoreFilters(junk);
    assert.equal(C.activeCount(f,null),0,JSON.stringify(junk));
    assert.equal(f.query,'');
    assert.equal(f.sort,'default');
  }
  // Every value the module itself writes is accepted again.
  const every=K.defaultFilters();
  every.place='d:sense';every.categories=new Set(K.CATEGORY_KEYS);every.formats=new Set(K.FORMAT_KEYS);every.languages=new Set(K.LANGUAGE_KEYS);every.days=new Set(K.DAY_KEYS);every.needs=new Set(P.needKeys);
  Object.assign(every,{when:'weekend',price:'course',status:'check',scenario:'course',preset:'walkin',indoor:true,sort:'date',planStatus:'booked',parentMatch:true,includeUnknownAge:false,query:'swim'});
  const again=C.restoreFilters(JSON.parse(JSON.stringify(C.serializeFilters(every))));
  assert.deepEqual(JSON.parse(JSON.stringify(C.serializeFilters(again))),JSON.parse(JSON.stringify(C.serializeFilters(every))));
  assert.equal(C.restoreFilters({query:'x'.repeat(900)}).query.length,500,'a stored search text is cut to 500 characters');
});

test('active filters count each chosen option once and never the search text',()=>{
  const {C,K,P}=load();
  const f=K.defaultFilters();
  assert.equal(C.activeCount(f,null),0);
  f.query='swimming with a parent';
  assert.equal(C.activeCount(f,null),0,'the search text has its own field');
  assert.equal(C.anyFilter(f,null),true);
  assert.equal(C.anyFilter({...f,query:'   '},null),false,'blank search text is not a filter');
  assert.equal(C.activeCount(f,AGE),1,'the child age counts once');
  assert.equal(C.activeCount(f,0),1,'age 0 is an age');
  for(const none of [null,undefined,NaN])assert.equal(C.activeCount(f,none),0);
  f.categories=new Set(['play','dining']);assert.equal(C.activeCount(f,null),2);
  f.formats=new Set(['group']);assert.equal(C.activeCount(f,null),3);
  f.languages=new Set(['DE','FR','unknown']);assert.equal(C.activeCount(f,null),6);
  f.days=new Set([1,6]);assert.equal(C.activeCount(f,null),8);
  f.needs=new Set(P.needKeys.slice(0,2));assert.equal(C.activeCount(f,null),10);
  f.place='d:sense';f.when='today';f.price='free';f.status='check';f.scenario='visit';f.preset='walkin';f.indoor=true;f.parentMatch=true;
  assert.equal(C.activeCount(f,null),18);
  assert.equal(C.activeCount(f,AGE),19);
  // Settings that are not filters do not count.
  f.sort='name';f.includeUnknownAge=false;f.planStatus='booked';
  assert.equal(C.activeCount(f,AGE),19);
});

test('each place option counts the published cards in it, and choosing it lists exactly those',()=>{
  const {records,C,V,state,list}=load();
  const published=records.filter(a=>!C.isArchive(a));
  const townsOf=a=>a.town.split(/\s+\/\s+/).map(name=>`${a.region}|${name.trim()}`);
  const {districts,towns}=C.placeOptions();
  assert.ok(districts.length>=7);
  let districtTotal=0,townTotal=0;
  for(const option of districts){
    const expected=published.filter(a=>a.region===option.id);
    assert.ok(option.count>0,option.value);
    assert.equal(option.count,expected.length,option.value);
    state.f.place=option.value;
    assert.deepEqual(ids(list()).sort(),ids(expected).sort(),option.value);
    districtTotal+=option.count;
  }
  assert.equal(districtTotal,published.length,'every published card belongs to one district');
  for(const option of towns){
    const expected=published.filter(a=>townsOf(a).includes(option.id));
    assert.ok(option.count>0,option.value);
    assert.equal(option.count,expected.length,option.value);
    state.f.place=option.value;
    assert.deepEqual(ids(list()).sort(),ids(expected).sort(),option.value);
    townTotal+=option.count;
  }
  assert.equal(townTotal,published.reduce((sum,a)=>sum+townsOf(a).length,0),'a card in two towns is counted in both');
  // The menu shows the same numbers.
  const html=V.placeOptionsHtml();
  for(const option of [...districts,...towns])assert.ok(html.includes(`<option value="${V.esc(option.value)}">${V.esc(option.name)} (${option.count})</option>`),option.value);
  // Places that only have archived cards are not offered.
  const archivedOnly=C.localities.filter(place=>!towns.some(o=>o.id===place.key));
  for(const place of archivedOnly)assert.ok(!html.includes(`value="t:${place.key}"`),place.key);
});

test('archive, saved, shared and venue views select their own cards',()=>{
  const {records,C,list,state,store}=load();
  const archived=records.filter(a=>C.isArchive(a));
  assert.equal(archived.length,COUNTS.archive);
  assert.equal(archived.length+COUNTS.catalog,records.length);
  assert.ok(list().every(a=>!C.isArchive(a)),'closed and excluded cards stay out of the list');
  assert.deepEqual(ids(list({view:'archive'})).sort(),ids(archived).sort());
  // Saved: only the visitor's saved cards, archived ones included, filtered by the private status.
  store.personal.favorites=['cafe-marly','eispalaeste','beo-funpark'];
  store.personal.statuses={'cafe-marly':'booked'};
  assert.deepEqual(ids(list({view:'saved'})).sort(),['beo-funpark','cafe-marly','eispalaeste']);
  state.f.planStatus='booked';
  assert.deepEqual(ids(list({view:'saved'})),['cafe-marly']);
  state.f.planStatus='none';
  assert.deepEqual(ids(list({view:'saved'})).sort(),['beo-funpark','eispalaeste']);
  state.f.planStatus='';
  // Shared: exactly the shared cards; the visitor's own filters do not apply.
  state.sharedIds=['beo-funpark','eispalaeste'];state.f.categories.add('music');
  assert.deepEqual(ids(list({view:'shared'})).sort(),['beo-funpark','eispalaeste']);
  // Venue: the offers of one place.
  const venue=C.venues.find(v=>v.id==='memo');
  assert.ok(venue);
  state.venueId='memo';state.f=load().state.f;
  assert.deepEqual(ids(list({view:'venue'})).sort(),Array.from(venue.members).sort());
  assert.equal(C.venueFor(C.byId.get(venue.members[0])).id,'memo');
});

test('every local script referenced by the page is allowed into Vercel deployment',()=>{
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const allowed=new Set(fs.readFileSync(path.join(root,'.vercelignore'),'utf8').split(/\r?\n/).filter(l=>l.startsWith('!')).map(l=>l.slice(1)));
  const scripts=Array.from(html.matchAll(/<script\b[^>]*src="([^"]+)"/g),m=>m[1]);
  assert.ok(scripts.includes('data-reviewed.js'));
  for(const script of scripts){
    assert.ok(allowed.has(script),`${script} is excluded from deployment`);
    assert.ok(fs.existsSync(path.join(root,script)),script);
  }
  assert.ok(scripts.indexOf('data-reviewed.js')<scripts.indexOf('regions.js'));
});

test('the status filter "for when older" lists the cards flagged for later while no age is chosen',()=>{
  const {C,list,state,store,records}=load();
  const flagged=Array.from(records.filter(a=>a.status==='future').map(a=>a.id)).sort();
  assert.ok(flagged.length>0);
  state.f.status='future';
  assert.deepEqual(Array.from(ids(list())).sort(),flagged);
  assert.ok(list().every(a=>C.statusOf(a,null)==='future'));
  // With an age that reaches the minimum the card is no longer 'for later'; below the minimum the age filter hides it.
  store.personal.age=6;
  assert.ok(list().every(a=>C.statusOf(a,6)==='future'));
  assert.ok(list().length<flagged.length);
});
