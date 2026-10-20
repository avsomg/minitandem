// Visit plans, saved-card tracking, backups merged into the stored profile, calendar and address files.
// Runs the real browser modules (test-support.mjs) against the English catalogue; only the clock is fixed (2026-10-14).
import assert from 'node:assert/strict';
import test from 'node:test';
import {loadStack} from './test-support.mjs';

const FAMILY='minitandem-family-v1';
const plain=v=>JSON.parse(JSON.stringify(v));
// The child's age is a plain number in the stored profile.
const old={version:1,favorites:['mpe'],notes:{mpe:'keep'},statuses:{mpe:'discuss'},age:2.5,origin:'Plaffeien'};
const load=(profile=null,options={})=>loadStack({...options,local:profile?{[FAMILY]:profile}:{}});
// A dictionary word; a missing entry would come back as the key itself, which must never pass for a word.
const word=(s,key,params)=>{const text=s.t(key,params);assert.notEqual(text,key,'missing dictionary entry '+key);return text;};
const unfold=text=>text.replace(/\r\n /g,'');
// The cards the visitor saved whose published details differ from the saved baseline.
const pendingChanges=s=>Array.from(s.store.personal.favorites).filter(id=>{const a=s.byId.get(id);return a&&s.P.changes(a,s.store.personal.tracked[id]).length>0;});
// Sets made inside the page's realm are not instances of this realm's Set.
const isSet=value=>Object.prototype.toString.call(value)==='[object Set]';

test('old backups acquire empty visits and tracking without losing previous notes',()=>{
  const {store}=load(),v=store.validateBackup(old);
  assert.deepEqual(plain(v.visits),{});assert.deepEqual(plain(v.tracked),{});assert.equal(v.notes.mpe,'keep');
  assert.equal(v.statuses.mpe,'discuss');assert.equal(v.age,2.5);assert.equal(v.origin,'Plaffeien');
});
test('old excluded MEMO record keeps family notes when merged into the dated event',()=>{
  const {store,P,byId}=load();
  const id='memo-musik-entdecken-2026-09-29';
  assert.equal(byId.has('memo-musik'),false,'the old id is an alias only, not a card');
  const snapshot=P.snapshot(byId.get(id),'2026-09-28');
  const restored=store.validateBackup({...old,favorites:['memo-musik'],notes:{'memo-musik':'ask about language'},statuses:{'memo-musik':'discuss'},visits:{'v-memo':{activity:'memo-musik',date:'2026-09-29'}},tracked:{'memo-musik':snapshot}});
  assert.deepEqual(plain(restored.favorites),[id]);
  assert.equal(restored.notes[id],'ask about language');
  assert.equal(restored.statuses[id],'discuss');
  assert.equal(restored.visits['v-memo'].activity,id);
  assert.ok(restored.tracked[id]);
});
test('visit validation accepts leap days, rejects normalized impossible dates and never confirms by default',()=>{
  const {P,byId}=load();
  const result=P.validateVisits({'v-one':{activity:'mpe',date:'2026-02-30',time:'24:00',booking:'yes',reply:'a'.repeat(3000)},'v-two':{activity:'mpe',date:'2028-02-29',time:'09:30'},'bad':{activity:'mpe'},'v-bad':{activity:'not-a-card'}},byId);
  assert.equal(result['v-one'].date,'');assert.equal(result['v-one'].time,'');assert.equal(result['v-one'].booking,'unconfirmed');assert.equal(result['v-one'].reply.length,2000);
  assert.equal(result['v-two'].date,'2028-02-29');assert.equal(result['v-two'].time,'09:30');assert.equal(Object.keys(result).length,2);
  const tooMany=Object.fromEntries(Array.from({length:201},(_,i)=>['v-'+i,{activity:'mpe'}]));
  assert.throws(()=>P.validateVisits(tooMany,byId),error=>error.code==='visits.limit'&&/200/.test(error.message));
  assert.equal(Object.keys(P.validateVisits(Object.fromEntries(Object.entries(tooMany).slice(0,200)),byId)).length,200);
});
test('distinct fields and visits merge across tabs, without restoring stale replies',()=>{
  const {P}=load();const base={'v-one':{activity:'mpe',date:'2026-10-01',reply:'old',pack0:false}};
  const current=structuredClone(base);current['v-one'].date='2026-10-02';
  const latest=structuredClone(base);latest['v-one'].reply='new';latest['v-one'].pack0=true;latest['v-two']={activity:'museum'};
  const result=P.mergeVisits(latest,current,base);
  assert.equal(result['v-one'].date,'2026-10-02');assert.equal(result['v-one'].reply,'new');assert.equal(result['v-one'].pack0,true);assert.ok(result['v-two']);
});
test('real persistence merges private visit edits with an unseen second-tab update',()=>{
  const initial={...old,visits:{'v-one':{activity:'mpe',date:'2026-10-01',reply:'old'}}};
  const s=load(initial);s.store.personal.visits['v-one'].date='2026-10-02';
  s.localStorage.setItem(FAMILY,JSON.stringify({...initial,notes:{mpe:'other tab'},visits:{'v-one':{activity:'mpe',date:'2026-10-01',reply:'other reply'}}}));
  assert.equal(s.store.persist(),true);
  const saved=s.localStorage.read(FAMILY);
  assert.equal(saved.notes.mpe,'other tab');assert.equal(saved.visits['v-one'].reply,'other reply');assert.equal(saved.visits['v-one'].date,'2026-10-02');assert.ok(saved.tracked.mpe);
  assert.equal(s.store.personal.visits['v-one'].reply,'other reply','this tab now shows the merged state');
});
test('blocked local storage reports failure without claiming the visit was saved',()=>{
  const s=load(old),before=s.localStorage.map.get(FAMILY);
  s.localStorage.blockWrites(true);
  s.store.personal.visits['v-new']=s.P.validateVisits({'v-new':{activity:'museum',date:'2026-10-20'}},s.byId)['v-new'];
  assert.equal(s.store.persist(),false);
  assert.equal(s.store.storageAvailable,false,'the page uses this flag to say that the plan lives in memory only');
  assert.equal(s.localStorage.map.get(FAMILY),before,'nothing half-written');
  assert.ok(s.store.personal.visits['v-new'],'the plan stays on the page');
  s.localStorage.blockWrites(false);
  assert.equal(s.store.persist(),true,'the unsaved visit is written once storage works again');
  assert.equal(s.store.storageAvailable,true);
  assert.equal(s.localStorage.read(FAMILY).visits['v-new'].date,'2026-10-20');
  // The visitor is told in each interface language that the plan was not stored.
  for(const lang of s.I.LANGS){
    const dictionary=s.I.dictionaries[lang];
    assert.ok(dictionary['visit.savedMemory']&&dictionary['storage.failed'],lang);
    assert.notEqual(dictionary['visit.savedMemory'],dictionary['visit.saved'],lang+': a failed save must not read like a successful one');
  }
});
test('backup import without visits preserves existing visit history',()=>{
  const s=load({...old,visits:{'v-one':{activity:'mpe',date:'2026-10-01',booking:'confirmed',observations:'private'}}});
  assert.equal(s.store.persist(s.store.validateBackup({...old,notes:{mpe:'imported'}})),true);
  const saved=s.localStorage.read(FAMILY);
  assert.equal(saved.visits['v-one'].observations,'private');assert.equal(saved.visits['v-one'].booking,'confirmed');assert.equal(saved.notes.mpe,'imported');
});
test('published lessons differ from no-booking events, reservations and unknown participation',()=>{
  const {P,byId,records}=load();
  assert.equal(P.admission(byId.get('swim-tentlingen')),'course');
  assert.equal(P.admission(byId.get('krabbel-plaffeien')),'dropin');
  assert.equal(P.admission(byId.get('museum')),'reservation');
  assert.equal(P.admission(byId.get('memo-buchstart')),'unknown');
  assert.equal(P.admission(byId.get('sellenhof-wednesday')),'dropin');
  // Whatever the card says, a published course lesson is never offered as a place to just join.
  for(const a of records){
    assert.ok(P.admissionKeys.includes(P.admission(a)),a.id);
    if(a.priceKind==='course'||a.practical?.commitment?.value===true)assert.equal(P.admission(a),'course',a.id);
  }
});
test('tracking ignores editorial check timestamps, date order and private state',()=>{
  const {P,byId}=load(),a=byId.get('swim-tentlingen'),before=P.snapshot(a,'2026-09-27');
  const reordered={...a,checked:'2026-10-02',events:[...a.events].reverse(),personalNote:'PRIVATE'};
  assert.equal(P.changes(reordered,before).length,0);assert.equal(P.changes(a,null).length,0);
  assert.deepEqual(plain(P.changes({...a,price:'CHF 400'},before)),[{key:'price',before:a.price,after:'CHF 400'}]);
  assert.equal(P.changes({...a,events:[...a.events,{date:'2027-01-01',start:'10:00'}]},before)[0].key,'events');
  assert.equal(before.rev,2,'snapshots carry the layout revision');
});
test('switching the interface language never looks like a change to a saved card',()=>{
  const en=load(),fr=load(null,{lang:'fr'}),de=load(null,{lang:'de'});
  const a=en.byId.get('swim-tentlingen'),snapshot=en.P.snapshot(a,'2026-09-27');
  assert.deepEqual(plain(fr.P.snapshot(fr.byId.get('swim-tentlingen'),'2026-09-27')),plain(snapshot));
  assert.deepEqual(plain(de.P.snapshot(de.byId.get('swim-tentlingen'),'2026-09-27')),plain(snapshot));
  en.I.setLang('de',{persist:false});
  assert.equal(en.P.changes(a,snapshot).length,0);
});
test('only saved changed records notify; a baseline is not a fabricated past change',()=>{
  const s=load(old),a=s.byId.get('mpe');
  assert.equal(pendingChanges(s).length,0);
  s.store.personal.tracked.mpe=s.P.snapshot(a,'2026-09-20');a.price='NEW';
  assert.deepEqual(pendingChanges(s),['mpe']);
  assert.equal(s.V.changesBox().count,1);assert.equal(s.V.saved().changes,1,'the saved view counts the same cards');
  s.store.personal.tracked.mpe=s.P.snapshot(a,'2026-09-27');assert.equal(pendingChanges(s).length,0);
  assert.equal(s.V.changesBox().count,0);assert.equal(s.V.saved().changes,0);
  a.price='ANOTHER';s.store.personal.favorites=[];assert.equal(pendingChanges(s).length,0);
  assert.equal(s.V.changesBox().count,0,'a card that is no longer saved does not notify');
});
test('saving a card takes its baseline today, so nothing is reported until the card changes',()=>{
  const s=load({...old,favorites:['mpe','museum']});
  assert.deepEqual(plain(s.store.personal.tracked),{},'a profile without baselines has none in memory');
  assert.equal(s.store.persist(),true);
  const saved=s.localStorage.read(FAMILY);
  assert.deepEqual(Object.keys(saved.tracked).sort(),['mpe','museum']);
  assert.equal(saved.tracked.museum.date,'2026-10-14');assert.equal(saved.tracked.museum.rev,2);
  assert.equal(pendingChanges(s).length,0);
  s.byId.get('museum').schedule='Different hours';
  assert.deepEqual(pendingChanges(s),['museum']);
});
test('the changes box lists what was and what is, escaped, with status wording from the dictionary',()=>{
  const s=load(old),a=s.byId.get('mpe');
  s.store.personal.tracked.mpe=s.P.snapshot(a,'2026-09-20');
  const before=a.price;a.price='NEW <b>bold</b>';a.status='closed';
  const html=s.V.changesBox().html;
  assert.ok(html.includes(s.V.esc(a.name)));assert.ok(html.includes(word(s,'tracked.price')));assert.ok(html.includes(word(s,'tracked.status')));
  assert.ok(html.includes(s.V.esc(before)),'the old value');assert.ok(html.includes('NEW &lt;b&gt;bold&lt;/b&gt;'),'the new value, escaped');
  assert.doesNotMatch(html,/<b>bold/);
  assert.ok(html.includes(word(s,'status.closed.long')),'status values are worded, not shown as codes');
  assert.ok(html.includes('data-ack="mpe"'));
});
test('venue identities are explicit and all offerings survive unrelated search filters',()=>{
  const s=load(),{byId,state}=s,venues=s.window.ACTIVITY_VENUES;
  assert.equal(venues.length,3);assert.equal(new Set(venues.map(v=>v.id)).size,3);
  for(const venue of venues){
    assert.match(venue.source,/^https:/);assert.ok(venue.members.every(id=>byId.has(id)));
    assert.ok(venue.members.every(id=>byId.get(id).contacts[0]?.phone===byId.get(venue.members[0]).contacts[0]?.phone),venue.id+': one venue, one phone');
    assert.ok(venue.members.every(id=>s.C.venueFor(byId.get(id)).id===venue.id));
  }
  state.view='venue';state.venueId='sellenhof';state.f.query='no match';state.f.categories.add('books');state.f.place='d:see';
  assert.equal(s.list().length,3);
  for(const venue of venues){state.venueId=venue.id;assert.equal(s.list().length,venue.members.length,venue.id);}
  state.venueId='invalid';assert.equal(s.list().length,0);
});
test('personal visits are dated, worded in the interface language and keep private text out of the card page',()=>{
  const profile={...old,visits:{'v-one':{activity:'mpe',date:'2026-10-02',booking:'confirmed',outcome:'repeat',observations:'<img src=x onerror=alert(1)>',reply:'PRIVATE_REPLY'}}};
  const s=load(profile),html=s.V.visitPlans(s.byId.get('mpe'));
  assert.match(html,/2026/);assert.ok(html.includes(s.F.dateLabel('2026-10-02')));
  assert.ok(html.includes(word(s,'booking.confirmed')));assert.ok(html.includes(word(s,'outcome.repeat')));
  assert.doesNotMatch(html,/<img/);assert.doesNotMatch(html,/alert\(1\)|PRIVATE_REPLY/,'impressions and replies are not printed on the card page');
  assert.ok(html.includes('data-edit-visit="v-one"')&&html.includes('data-plan="mpe"'));
  // Other interface languages: the same visit, the words of that language.
  for(const lang of ['de','fr']){
    const other=load(profile,{lang}),text=other.V.visitPlans(other.byId.get('mpe'));
    assert.ok(text.includes(word(other,'booking.confirmed')),lang);assert.ok(text.includes(other.F.dateLabel('2026-10-02')),lang);
    assert.ok(!text.includes(word(s,'booking.confirmed')),lang+': no English left over');
  }
  assert.equal(s.V.visitPlans(s.byId.get('museum')).includes('visit-row'),false,'a card without visits lists none');
});
test('visit text and card names are escaped wherever the saved view prints them',()=>{
  const profile={...old,visits:{'v-one':{activity:'mpe',date:'2026-10-02',booking:'confirmed',bring:'<img src=x onerror=alert(1)>\nsunscreen'}}};
  const s=load(profile);s.state.outingDate='2026-10-02';
  s.byId.get('mpe').name='Test <b>place</b> & "co"';
  const html=s.V.saved().html;
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'),'the packing list is shown, as text');
  assert.ok(html.includes('sunscreen'));
  assert.doesNotMatch(html,/<img/);assert.doesNotMatch(html,/<b>place/);
  assert.ok(html.includes('Test &lt;b&gt;place&lt;/b&gt; &amp; &quot;co&quot;'));
});
test('private records do not change public suitability',()=>{
  const s=load({...old,visits:{'v-one':{activity:'mpe',date:'2026-10-02',booking:'confirmed',outcome:'repeat',observations:'x'}}});
  const a=s.byId.get('mpe'),baseline=s.P.snapshot(a,'2026-09-27');
  const publicView=()=>JSON.stringify([s.C.statusOf(a,s.store.personal.age),s.C.ageFit(a,s.store.personal.age),s.P.warnings(a,s.C.today()),s.P.admission(a),s.P.visit(a)]);
  const shown=publicView();
  s.store.personal.visits['v-one'].observations='NEW PRIVATE';s.store.personal.notes.mpe='NEW NOTE';s.store.personal.statuses.mpe='booked';s.store.personal.origin='Elsewhere';
  assert.equal(s.P.changes(a,baseline).length,0);assert.equal(publicView(),shown);
});
test('new data retains unknown age and parent access despite confirmed Sellenhof booking conditions',()=>{
  const {byId}=load();
  for(const id of ['sellenhof-wednesday','sellenhof-group','sellenhof-private']){assert.equal(byId.get(id).min,null);assert.equal(byId.get(id).parent,'unknown');}
  assert.match(byId.get('sellenhof-group').practical.groupSize.text,/2–3/);assert.equal(byId.get('sellenhof-group').practical.groupSize.value,3);
  assert.equal(byId.get('swim-tentlingen').practical.standardGerman.value,null);
});
test('offline address export has a version date, contacts and no private notes or plans',()=>{
  const s=load({...old,origin:'PRIVATE_ORIGIN',notes:{mpe:'PRIVATE_NOTE'},visits:{'v-one':{activity:'mpe',reply:'PRIVATE_REPLY'}}});
  const a=s.byId.get('mpe'),file=s.EX.addressesFile(s.store.personal.favorites.map(id=>s.byId.get(id)));
  assert.match(file.name,/^minitandem-addresses-2026-10-14\.txt$/);assert.match(file.type,/text\/plain/);
  assert.ok(file.text.includes(word(s,'addresses.title')));
  assert.ok(file.text.includes(word(s,'addresses.saved',{date:s.F.dateLabel('2026-10-14')})),'when the copy was made, and that it is a stored copy');
  assert.ok(file.text.includes(word(s,'addresses.noPrivate')));
  assert.match(file.text,/https:\/\//);
  assert.ok(file.text.includes(a.address));assert.ok(file.text.includes(a.contacts[0].phone));assert.ok(file.text.includes(a.contacts[0].email));
  assert.ok(file.text.includes(word(s,'addresses.checked',{date:s.F.dateLabel(a.checked)})),'the check date reads as a date, not as 2026-09-27');
  assert.ok(!file.text.includes(word(s,'addresses.checked',{date:a.checked})));
  assert.doesNotMatch(file.text,/PRIVATE_/);
});
test('ICS course export warns that attendance is not confirmed and never exports family records',()=>{
  const s=load({...old,notes:{'swim-tentlingen':'PRIVATE_NOTE'}}),card=s.byId.get('swim-tentlingen'),e=card.events[5];
  assert.ok(e&&e.date&&e.start,'the card has a sixth dated lesson with a start time');
  const file=s.EX.eventFile('swim-tentlingen',5),text=unfold(file.text),escape=s.window.MinitandemExports.icsEscape;
  assert.equal(file.name,`swim-tentlingen-${e.date}.ics`);assert.match(file.type,/text\/calendar/);
  assert.match(text,/TZID=Europe\/Zurich/);
  assert.ok(text.includes(`DTSTART;TZID=Europe/Zurich:${e.date.replace(/-/g,'')}T${e.start.replace(':','')}00`));
  assert.ok(text.includes('SUMMARY:'+escape(word(s,'ics.coursePrefix'))+' · '),'a course date is marked as a course in the title');
  assert.ok(text.includes(escape(word(s,'ics.notBooking'))),'a published date is not a booking');
  assert.ok(text.includes(escape(word(s,'ics.courseJoin'))),'joining a course has to be agreed');
  assert.ok(text.includes(escape(word(s,'admission.course'))));
  assert.doesNotMatch(text,/PRIVATE_NOTE/);
  // An event without a course attached carries neither the course marker nor the joining warning.
  const dropin=unfold(s.EX.eventFile('krabbel-plaffeien',0).text);
  assert.ok(!dropin.includes('SUMMARY:'+escape(s.t('ics.coursePrefix'))));assert.ok(!dropin.includes(escape(s.t('ics.courseJoin'))));
  assert.ok(dropin.includes(escape(s.t('admission.dropin'))));assert.ok(dropin.includes(escape(s.t('ics.notBooking'))));
  assert.equal(s.EX.eventFile('swim-tentlingen',999),null);assert.equal(s.EX.eventFile('no-such-card',0),null);
});
test('ICS text escapes backslashes, line breaks, commas and semicolons',()=>{
  const s=load(),escape=s.window.MinitandemExports.icsEscape;
  assert.equal(escape('a;b,c\\d\ne'),'a\\;b\\,c\\\\d\\ne');
  // In a real file: the course note joins two clauses with a semicolon, and no unescaped semicolon is left in a text line.
  const text=unfold(s.EX.eventFile('swim-tentlingen',5).text);
  const description=text.split('\r\n').find(line=>line.startsWith('DESCRIPTION:'));
  assert.ok(description.includes(s.t('admission.course')+'\\; '+s.t('ics.courseJoin').replace(/,/g,'\\,')));
  assert.doesNotMatch(description.replace(/\\\\/g,''),/(^|[^\\]);/,'every semicolon in DESCRIPTION is escaped');
  for(const line of text.split('\r\n').filter(l=>/^(SUMMARY|LOCATION):/.test(l)))assert.doesNotMatch(line.replace(/\\\\/g,''),/(^|[^\\]);/,line);
});
test('ICS description: French sets a no-break space before the semicolon the code adds, and the check date reads as a date',()=>{
  for(const [lang,space] of [['en',''],['fr','\u00a0']]){
    const s=loadStack({lang}),escape=s.window.MinitandemExports.icsEscape,card=s.byId.get('swim-tentlingen');
    const text=unfold(s.EX.eventFile('swim-tentlingen',5).text);
    const description=text.split('\r\n').find(line=>line.startsWith('DESCRIPTION:'));
    assert.ok(description.includes(escape(s.t('admission.course'))+space+'\\; '+escape(s.t('ics.courseJoin'))),lang+': '+description.slice(0,160));
    assert.ok(description.includes(escape(s.t('ics.checked',{date:s.F.dateLabel(card.checked)}))),lang+': the check date as the interface writes dates');
    assert.ok(!description.includes(card.checked),lang+': not the raw '+card.checked);
  }
});
test('ICS text follows the interface language',()=>{
  const de=load(null,{lang:'de'}),text=unfold(de.EX.eventFile('swim-tentlingen',5).text);
  assert.ok(text.includes('PRODID:-//Minitandem//Family Activities//DE'));
  assert.ok(text.includes('SUMMARY:'+de.window.MinitandemExports.icsEscape(word(de,'ics.coursePrefix'))+' · '));
  assert.ok(text.includes(de.window.MinitandemExports.icsEscape(word(de,'ics.notBooking'))));
  assert.notEqual(word(de,'ics.coursePrefix'),load().t('ics.coursePrefix'));
});
test('ICS export uses the venue of the selected Suniai date',()=>{
  const s=load(),card=s.byId.get('suniai-family-yoga');
  const text=unfold(s.EX.eventFile('suniai-family-yoga',1).text);
  assert.equal(card.events[1].date,'2026-11-07');
  assert.match(text,/DTEND;TZID=Europe\/Zurich:20261107T110000/);
  assert.match(text,/LOCATION:Warpelstrasse 9\\, Düdingen/);
  assert.doesNotMatch(text,/LOCATION:Hauptstrasse 20/);
  // The first date is held at the studio named on the card.
  assert.match(unfold(s.EX.eventFile('suniai-family-yoga',0).text),/LOCATION:Aloha YOGA Paradise\\, Hauptstrasse 20\\, 3186 Düdingen/);
});
test('reset returns every filter to its default and clears the remembered age',()=>{
  const s=load(old),{K,C}=s;
  const single={query:'test',place:'d:see',categories:'books',formats:'group',languages:'DE',days:3,needs:'trial',when:'week',price:'free',status:'active',scenario:'course',preset:'walkin',parentMatch:true};
  // Every filter dimension of the panel counts as active when set, one by one.
  for(const [key,value] of Object.entries(single)){
    const f=K.defaultFilters();
    if(isSet(f[key]))f[key].add(value);else f[key]=value;
    assert.ok(C.anyFilter(f,null),key+' counts as an active filter');
    if(key!=='query')assert.equal(C.activeCount(f,null),1,key);
  }
  const used=K.defaultFilters();
  for(const [key,value] of Object.entries(single)){if(isSet(used[key]))used[key].add(value);else used[key]=value;}
  used.sort='name';used.planStatus='discuss';used.includeUnknownAge=false;
  const fresh=K.defaultFilters();
  assert.equal(C.anyFilter(fresh,null),false);assert.equal(C.activeCount(fresh,null),0);
  assert.deepEqual(plain(C.serializeFilters(fresh)),plain(C.serializeFilters(C.restoreFilters(C.serializeFilters(fresh)))));
  assert.equal(fresh.scenario,'');assert.equal(fresh.when,'');assert.equal(fresh.query,'');assert.equal(fresh.sort,'default');assert.equal(fresh.includeUnknownAge,true);
  assert.notEqual(fresh.categories,used.categories);assert.equal(used.categories.size,1,'a fresh filter set is not the old one emptied behind its back');
  assert.deepEqual(C.filter(fresh,{age:null,view:'catalog'}).map(a=>a.id),C.filter(K.defaultFilters(),{age:null,view:'catalog'}).map(a=>a.id));
  // The reset also forgets the child's age, and that is what gets stored.
  s.store.personal.age=null;assert.equal(s.store.persist(),true);assert.equal(s.localStorage.read(FAMILY).age,null);
});
