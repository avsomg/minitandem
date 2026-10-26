import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {loadCatalog,qualityReport,root} from './editorial/quality.mjs';
import {placePage,generatePublicPages,site} from './public-pages.mjs';
import {LEGAL_URLS} from './legal-pages.mjs';
import {GUIDE_URLS} from './daycare-guides.mjs';
import {SITE_ORIGIN} from './site.mjs';
import {loadStack} from './test-support.mjs';
const catalog=loadCatalog(),P=catalog.MinitandemPlanning,X=catalog.MinitandemExchange;
const allowed=new Map(catalog.ACTIVITIES.map(a=>[a.id,a]));
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
// Card counts are not written into this file: editorial/profile.json holds them, counted by editorial/profile.mjs straight from the
// data files, a second reading next to the catalogue module these tests load. A card added or archived changes both together.
const COUNTS=JSON.parse(read('editorial/profile.json'));
const isPublished=a=>!['closed','excluded'].includes(a.status);
// Calendar lines are folded at 73 bytes; unfold them before reading a line.
const unfold=text=>text.replace(/\r\n /g,'');
// The two stored-file identifiers are the only places where the old product name remains.
// The old product name, assembled so that this file itself never spells it.
const oldName=new RegExp('vme'+'ste','i');
const withoutStoredIds=text=>text.replaceAll('vmeste-plan','').replaceAll('vmeste-correction','');

test('all seven Fribourg districts are represented while ended events leave the catalogue',()=>{
  const active=catalog.ACTIVITIES.filter(isPublished);
  assert.equal(active.length,COUNTS.catalog);assert.equal(catalog.ACTIVITIES.length,COUNTS.total);
  assert.deepEqual([...new Set(active.map(a=>a.region))].sort(),['broye','glane','gruyere','sarine','see','sense','veveyse']);
});
test('the front page is English and names one origin, the same one the generated pages and sitemap use',()=>{
  const html=read('index.html');
  assert.match(html,/<html lang="en">/);
  assert.equal(SITE_ORIGIN,'https://minitandem.ch');assert.equal(site,SITE_ORIGIN);
  assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}/">`));
  assert.ok(html.includes(`<meta property="og:url" content="${SITE_ORIGIN}/">`));
  assert.match(html,/<title>Minitandem · /);
  assert.ok(read('robots.txt').includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`));
  assert.equal(JSON.parse(read('manifest.webmanifest')).lang,'en');
});
test('combined conditions use explicit facts, not the absence of restrictions',()=>{
  assert.equal(P.matchesNeeds(allowed.get('mpe'),new Set(['noCourse','flexible'])),true);
  assert.equal(P.matchesNeeds(allowed.get('mpe'),new Set(['trial'])),false);
  assert.equal(P.matchesNeeds(allowed.get('swim-courtepin-babies'),new Set(['trial','changing'])),true);
  assert.equal(P.matchesNeeds(allowed.get('swim-courtepin-babies'),new Set(['access'])),false);
  assert.equal(P.matchesNeeds(allowed.get('elki-plaffeien'),new Set(['trial'])),false);
  assert.equal(P.matchesNeeds(allowed.get('sellenhof-group'),new Set(['small'])),true);
  assert.equal(P.matches(allowed.get('krabbel-giffers'),'walkin'),false);
  assert.equal(allowed.get('swim-courtepin-babies').practical.trial.value,true);
  assert.match(allowed.get('swim-courtepin-babies').practical.trial.text,/cost is not stated/);
});
test('when filter never invents dates from regular opening hours and excludes ended events',()=>{
  assert.equal(P.matchesWhen(allowed.get('conservatoire'),'today','2026-09-27'),false);
  const a={events:[{date:'2026-09-27',start:'09:00',end:'10:00'}]};
  assert.equal(P.matchesWhen(a,'today','2026-09-27','11:00'),false);
  assert.equal(P.matchesWhen(a,'today','2026-09-27','09:00'),true);
  assert.equal(P.matchesWhen(a,'','2026-09-27'),true);
});
const privateVisit={activity:'mpe',date:'2026-10-01',time:'09:30',booking:'requested',reply:'SECRET_REPLY',observations:'SECRET_CHILD',bring:'SECRET_BRING',outcome:'repeat',attendance:'went'};
test('plan allowlist removes all private free text and rejects corrupt imports atomically',()=>{
  const raw={type:'vmeste-plan',version:1,visits:{'v-test':privateVisit},notes:'SECRET_NOTE',origin:'SECRET_HOME'};
  const result=X.plan(raw,allowed);
  assert.deepEqual(Object.keys(result.visits['v-test']).sort(),['activity','booking','date','time']);
  assert.doesNotMatch(JSON.stringify(result),/SECRET|outcome|attendance/);
  for(const [bad,code] of [
    [{...privateVisit,date:'2026-02-30'},'plan.invalidVisit'],
    [{...privateVisit,activity:'missing'},'plan.invalidVisit'],
    [{...privateVisit,time:'25:00'},'plan.invalidVisit'],
    [{...privateVisit,booking:'maybe'},'plan.invalidVisit']
  ])assert.throws(()=>X.plan({...raw,visits:{'v-test':bad}},allowed),{code,message:/Import cancelled/});
  assert.throws(()=>X.plan({...raw,visits:{'../bad':privateVisit}},allowed),{code:'plan.invalidVisit'});
  assert.throws(()=>X.plan({...raw,visits:{}},allowed),{code:'plan.count'});
  assert.throws(()=>X.plan({...raw,type:'something-else'},allowed),{code:'plan.notPlan'});
  assert.throws(()=>X.plan({...raw,version:2},allowed),{code:'plan.notPlan'});
  // One corrupt visit cancels the whole import, even beside valid ones.
  assert.throws(()=>X.plan({...raw,visits:{'v-good':privateVisit,'v-bad':{...privateVisit,date:'2026-13-01'}}},allowed),{code:'plan.invalidVisit'});
  assert.equal(X.plan(result,allowed).visits['v-test'].booking,'requested');
});
test('plan preview counts conflicts and never replaces existing private fields',()=>{
  const raw={type:'vmeste-plan',version:1,visits:{'v-test':{...privateVisit,date:'2026-10-02'}}};
  const current={'v-test':privateVisit},preview=X.planSummary(raw,allowed,current);
  assert.equal(preview.added,0);assert.equal(preview.changed,1);
  const merged=P.mergeVisits(current,preview.clean.visits,current);
  assert.equal(merged['v-test'].date,'2026-10-02');assert.equal(merged['v-test'].reply,'SECRET_REPLY');
  assert.throws(()=>X.planSummary(raw,allowed,{'v-test':{...privateVisit,activity:'museum'}}),{code:'plan.otherPlace',message:/different place/});
});
test('visit limits are enforced with stable error codes and an English message',()=>{
  const visits=n=>Object.fromEntries(Array.from({length:n},(_,i)=>['v-n'+i,{activity:'mpe',date:'2026-10-01',time:'',booking:'unconfirmed'}]));
  assert.equal(P.maxVisits,200);
  assert.equal(Object.keys(X.plan({type:'vmeste-plan',version:1,visits:visits(200)},allowed).visits).length,200);
  assert.throws(()=>X.plan({type:'vmeste-plan',version:1,visits:visits(201)},allowed),{code:'plan.count',message:/between 1 and 200 visits/});
  assert.throws(()=>X.planSummary({type:'vmeste-plan',version:1,visits:{'v-test':privateVisit}},allowed,visits(200)),{code:'plan.tooMany',message:/More than 200 visits/});
  assert.throws(()=>P.validateVisits(visits(201),allowed),{code:'visits.limit',message:/More than 200 visits/});
  assert.equal(Object.keys(P.validateVisits(visits(200),allowed)).length,200);
});
test('correction schema strips extra personal fields and unsafe sources',()=>{
  const raw={type:'vmeste-correction',version:1,activity:'mpe',topic:'Price',message:' The tariff has changed ',date:'2026-09-27',source:'https://example.org/info',email:'PRIVATE'};
  assert.equal(X.report(raw,allowed).message,'The tariff has changed');assert.doesNotMatch(JSON.stringify(X.report(raw,allowed)),/PRIVATE/);
  assert.deepEqual(Object.keys(X.report(raw,allowed)).sort(),['activity','date','message','source','topic','type','version']);
  for(const source of ['javascript:alert(1)','http://example.org','https://user:password@example.org','not a link'])assert.throws(()=>X.report({...raw,source},allowed),{code:'report.source',message:/HTTPS link/});
  assert.throws(()=>X.report({...raw,message:' '},allowed),{code:'report.invalid'});
  assert.throws(()=>X.report({...raw,topic:'price'},allowed),{code:'report.invalid'},'a topic is one of the stored English values');
  assert.throws(()=>X.report({...raw,activity:'missing'},allowed),{code:'report.invalid'});
  assert.equal(X.report({...raw,source:''},allowed).source,'');
});
test('every correction topic has a dictionary entry in each interface language',()=>{
  const {I}=loadStack({today:'2026-09-27'});
  const keyOf={Schedule:'schedule',Price:'price','Age or adult participation':'age','Address or closure':'address',Other:'other'};
  assert.deepEqual(Array.from(X.topics),Object.keys(keyOf));
  const source=read('strings-en.js');
  for(const topic of X.topics){
    const key='report.topic.'+keyOf[topic];
    assert.ok(source.includes(`'${key}'`),key+' is defined in strings-en.js');
    assert.equal(I.dictionaries.en[key],topic,'the English wording is the stored value');
    for(const lang of ['de','fr'])assert.ok(I.dictionaries[lang][key],`${key} exists in ${lang}`);
    assert.equal(X.report({type:'vmeste-correction',version:1,activity:'mpe',topic,message:'Fixture',date:'2026-09-27'},allowed).topic,topic);
  }
});
test('planning.js and exchange.js contain no Cyrillic and keep the old product name only in the two stored-file ids',()=>{
  for(const name of ['planning.js','exchange.js']){
    const text=read(name);
    const cyrillic=[...text].filter(ch=>{const c=ch.codePointAt(0);return c>=0x400&&c<=0x52f;});
    assert.deepEqual(cyrillic,[],name+' contains Cyrillic');
    assert.doesNotMatch(withoutStoredIds(text),oldName,name);
  }
  assert.ok(read('exchange.js').includes("'vmeste-plan'")&&read('exchange.js').includes("'vmeste-correction'"),'stored-file ids are unchanged');
});
test('pilot totals count self-reported attendance only and disclose no personal details',()=>{
  const visits={'v-1':{...privateVisit,usefulness:'yes',information:'missing'},'v-2':{...privateVisit,attendance:'',outcome:'repeat'},'v-3':{...privateVisit,attendance:'missed'}};
  const report=X.metrics(visits);
  assert.equal(report.type,'minitandem-pilot-summary');
  assert.equal(report.planned,3);assert.equal(report.attended,1);assert.equal(report.wantRepeat,1);assert.equal(report.neededClarification,1);
  assert.equal(report.missed,1);assert.equal(report.selectedHere,1);
  assert.doesNotMatch(JSON.stringify(report),/SECRET|2026|mpe|v-1/);
});
test('public pages use one data source, escape content and contain no personal storage',()=>{
  const a={...allowed.get('mpe'),name:'Test <script>alert(1)</script>',personalNote:'SECRET',practical:{...allowed.get('mpe').practical}};
  const html=placePage(a,catalog.CATALOG_REGIONS,'2026-09-27');
  assert.doesNotMatch(html,/<script|SECRET|localStorage/);assert.match(html,/&lt;script&gt;/);
  assert.ok(html.includes(`${SITE_ORIGIN}/places/mpe/`));
  assert.match(html,/<html lang="en">/);
  assert.match(html,/schema.org\/Article/);assert.match(html,/Practical facts/);
  assert.match(html,/Good to know/);
});
test('public pages are English, branded and carry the headings and links the directory promises (the words are the app\'s own English)',()=>{
  const mpe=allowed.get('mpe'),regions=catalog.CATALOG_REGIONS;
  const html=placePage(mpe,regions,'2026-09-27');
  assert.ok(html.includes(`<title>${mpe.name} · ${mpe.town} | Minitandem</title>`));
  assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}/places/mpe/">`));
  assert.ok(html.includes(`<meta property="og:url" content="${SITE_ORIGIN}/places/mpe/">`));
  assert.match(html,/<h2>Practical facts<\/h2>/);assert.match(html,/<h2>Contact<\/h2>/);assert.match(html,/<h2>Sources<\/h2>/);
  assert.match(html,/>Open the activity<\/a>/);assert.match(html,/>Show on map<\/a>/);
  const dated=allowed.get('museum'),withDates=placePage(dated,regions,'2026-09-27');
  assert.match(withDates,/<h2>Published dates<\/h2>/);
  const pending=catalog.ACTIVITIES.find(a=>!['closed','excluded'].includes(a.status)&&a.research?.remaining.length);
  assert.ok(pending);assert.match(placePage(pending,regions,'2026-09-27'),/<h2>Still to confirm<\/h2>/);
  assert.doesNotMatch(withoutStoredIds(html+withDates),oldName);
  assert.doesNotMatch(html+withDates,/vercel\.app/);
});
test('public Suniai page lists the venue for each date without a misleading global map link',()=>{
  // Since 26 October 2026 the 3 October session at the studio has passed and every Suniai date is at the card's own address, so the
  // real card no longer has dates at another venue. The card as published until then (studio address, later dates moved) keeps the case.
  const studio='Aloha YOGA Paradise, Hauptstrasse 20, 3186 Düdingen',moved='Warpelstrasse 9, Düdingen';
  const a={...allowed.get('suniai-family-yoga'),address:studio,events:[['2026-10-03',studio],['2026-11-07',moved],['2026-12-12',moved]].map(([date,address])=>({date,start:'10:00',end:'11:00',title:'',address}))};
  const html=placePage(a,catalog.CATALOG_REGIONS,'2026-09-29'),{F}=loadStack({lang:'en'});
  assert.ok(html.includes(F.dateLabel('2026-11-07')+': Warpelstrasse 9, Düdingen'));
  assert.ok(html.includes(F.dateLabel('2026-10-03')+': Aloha YOGA Paradise'));
  assert.doesNotMatch(html,/>Show on map<\/a>/);
});
test('two Schwarzsee beaches remain separate map searches, not one route destination',()=>{
  const a=allowed.get('beaches');
  const html=placePage(a,catalog.CATALOG_REGIONS,'2026-09-29');
  assert.equal(a.addressPrecision,'area');
  assert.match(html,/Show on map: Gypsera/);
  assert.match(html,/Show on map: Staldenmotta/);
  assert.doesNotMatch(html,/>Show on map<\/a>/);
  assert.ok(P.warnings(a,'2026-09-29').some(w=>w.code==='entranceUnknown'),'the exact entrance is reported as unknown');
});
test('static directory and sitemap include all public records and no archives',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-public-'));
  try{
    assert.equal(generatePublicPages(catalog.ACTIVITIES,catalog.CATALOG_REGIONS,dir,'2026-09-27'),COUNTS.catalog);
    // Three pages (English, German, French) per published card, plus the home page, the directory in three languages, project pages, legal notices and the Daycare guides.
    const sitemap=fs.readFileSync(path.join(dir,'sitemap.xml'),'utf8'),fixedPages=['/','/places/','/places/de/','/places/fr/','/projekt/','/projekt/en/',...LEGAL_URLS,...GUIDE_URLS];
    assert.equal((sitemap.match(/<loc>/g)||[]).length,3*COUNTS.catalog+fixedPages.length);
    for(const page of fixedPages)assert.ok(sitemap.includes(`<loc>${SITE_ORIGIN}${page}</loc>`),page);
    assert.ok(sitemap.includes(`<loc>${SITE_ORIGIN}/projekt/</loc>`)&&sitemap.includes(`<loc>${SITE_ORIGIN}/projekt/en/</loc>`));
    assert.ok(sitemap.includes(`<loc>${SITE_ORIGIN}/</loc>`)&&sitemap.includes(`<loc>${SITE_ORIGIN}/places/mpe/</loc>`));
    assert.ok([...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].every(match=>match[1].startsWith(SITE_ORIGIN+'/')));
    const directory=fs.readFileSync(path.join(dir,'places/index.html'),'utf8');
    assert.match(directory,/<html lang="en">/);assert.match(directory,/<h1>Places and activities<\/h1>/);
    for(const a of catalog.ACTIVITIES)assert.equal(fs.existsSync(path.join(dir,'places',a.id)),!['closed','excluded'].includes(a.status));
    fs.mkdirSync(path.join(dir,'places/obsolete'));generatePublicPages(catalog.ACTIVITIES,catalog.CATALOG_REGIONS,dir,'2026-09-27');assert.equal(fs.existsSync(path.join(dir,'places/obsolete')),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('editorial queue measures missing facts without inventing owners or new verification dates',()=>{
  const sources=JSON.parse(read('editorial/source-watch.json')).sources;
  const report=qualityReport(catalog.ACTIVITIES,sources,'2026-09-27');
  assert.equal(report.records,COUNTS.catalog);assert.equal(report.queue.length,report.records);assert.equal(report.unassigned,report.queue.length);
  for(const field of Object.values(report.coverage)){
    assert.equal(field.known+field.unknown,field.applicable);
    assert.equal(field.applicable+field.notApplicable,COUNTS.catalog);
  }
  assert.ok(report.coverage.trial.applicable<report.records);
  assert.ok(report.queue.every(row=>row.owner===null&&row.checked===allowed.get(row.id).checked));
  assert.ok(report.coverage.booking.known>=20);
});
test('freshness queue prioritizes imminent meetings and the whole 0–6 audience without a family route',()=>{
  const report=JSON.parse(execFileSync(process.execPath,[path.join(root,'maintain.mjs'),'--date=2026-09-28'],{encoding:'utf8'}));
  assert.deepEqual(report.due,[]);
  const byId=new Map(report.needsConfirmation.map(row=>[row.id,row]));
  // aef-mpe and aef-passerelles were confirmed active by approved updates (2 and 20 October 2026) and no longer wait here.
  for(const id of ['aef-mpe','aef-passerelles'])assert.equal(byId.has(id),false,id);
  // herbstbasteln still waits for confirmation, and its meeting of 30 September is two days after the report date.
  assert.equal(byId.get('herbstbasteln').nextEvent,'2026-09-30');
  assert.equal(byId.get('herbstbasteln').priority,'now');
  assert.deepEqual(report.targetAge,{min:0,max:6});
  assert.equal(byId.get('krabbel-giffers').priority,'review');
  assert.equal(byId.get('krabbel-giffers').ageFit,'confirmed');
  assert.equal(byId.get('swim-duedingen').priority,'review');
  assert.equal(byId.get('swim-duedingen').ageFit,'confirmed');
  assert.ok(report.needsConfirmation.every(row=>row.priority!=='family'));
});
test('editorial profile includes practical additions and matches the public catalogue',()=>{
  const active=catalog.ACTIVITIES.filter(a=>!['closed','excluded'].includes(a.status));
  const profile=JSON.parse(read('editorial/profile.json'));
  const inventory=JSON.parse(read('editorial/source-inventory.generated.json'));
  assert.equal(profile.catalog,active.length);
  assert.equal(profile.total,catalog.ACTIVITIES.length);
  assert.equal(profile.geocodedCards,active.filter(a=>a.geo).length);
  assert.equal(profile.uniqueAddressPoints,new Set(active.filter(a=>a.geo).map(a=>`${a.geo.lat},${a.geo.lon}`)).size);
  assert.equal(profile.sources,inventory.sources.length);
  assert.ok(inventory.sources.some(source=>source.recordIds.includes('artist-factory-parent')));
  assert.ok(inventory.sources.some(source=>source.recordIds.includes('office-family-workshops')));
});
test('shared calendar keeps Zurich time, stable UIDs and no invented duration or private notes',()=>{
  const {EX,X:stackX,byId}=loadStack({today:'2026-09-27'});
  const plan=stackX.plan({type:'vmeste-plan',version:1,visits:{'v-test':privateVisit}},byId);
  const file=EX.planFile(plan),text=unfold(file.text);
  assert.match(text,/DTSTART;TZID=Europe\/Zurich:20261001T093000/);assert.match(text,/UID:v-test@minitandem\.local/);assert.doesNotMatch(text,/SECRET|DTEND/);
  assert.match(text,/STATUS:TENTATIVE/);
  const allDay=stackX.plan({type:'vmeste-plan',version:1,visits:{'v-test':{...privateVisit,time:'',date:'2028-02-29'}}},byId);
  assert.match(unfold(EX.planFile(allDay).text),/DTEND;VALUE=DATE:20280301/);
  const cancelled=stackX.plan({type:'vmeste-plan',version:1,visits:{'v-test':{...privateVisit,booking:'cancelled'}}},byId);
  assert.match(unfold(EX.planFile(cancelled).text),/STATUS:CANCELLED/);
});
test('calendar files carry the Minitandem names, fold lines safely and never use the old product name',()=>{
  const {EX,X:stackX,C,byId,window:W}=loadStack({today:'2026-09-27'});
  const plan=stackX.plan({type:'vmeste-plan',version:1,visits:{'v-test':privateVisit,'v-two':{...privateVisit,activity:'suniai-family-yoga',date:'2026-11-07',time:'10:00'}}},byId);
  const planFile=EX.planFile(plan);
  assert.equal(planFile.name,'minitandem-plan-2026-09-27.ics');assert.equal(planFile.type,'text/calendar;charset=utf-8');
  assert.match(planFile.text,/PRODID:-\/\/Minitandem\/\/Personal Plan\/\/EN\r\n/);
  const a=byId.get('suniai-family-yoga'),index=a.events.findIndex(e=>e.date==='2026-11-07');
  const event=EX.eventFile(a.id,index);
  assert.equal(event.name,'suniai-family-yoga-2026-11-07.ics');
  assert.match(event.text,/PRODID:-\/\/Minitandem\/\/Family Activities\/\/EN\r\n/);
  assert.match(unfold(event.text),/UID:suniai-family-yoga-20261107-10:00@minitandem\.local/);
  assert.match(unfold(event.text),/DTSTART;TZID=Europe\/Zurich:20261107T100000/);assert.match(unfold(event.text),/DTEND;TZID=Europe\/Zurich:20261107T110000/);
  assert.equal(EX.eventFile(a.id,999),null);assert.equal(EX.eventFile('missing',0),null);
  for(const file of [planFile,event]){
    assert.ok(file.text.startsWith('BEGIN:VCALENDAR\r\n')&&file.text.endsWith('END:VCALENDAR\r\n'));
    assert.match(file.text,/BEGIN:VTIMEZONE\r\nTZID:Europe\/Zurich\r\n/);
    for(const line of file.text.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75,'folded line too long: '+line);
    assert.ok(!file.text.includes(String.fromCharCode(0xFFFD)),'folding never splits a multi-byte character');
    assert.doesNotMatch(withoutStoredIds(file.text),oldName);
  }
  // The same file is produced for another interface language; only the dictionary words change.
  const french=loadStack({today:'2026-09-27',lang:'fr'});
  assert.match(french.EX.eventFile(a.id,index).text,/PRODID:-\/\/Minitandem\/\/Family Activities\/\/FR\r\n/);
  assert.notEqual(french.EX.eventFile(a.id,index).text.replace(/DTSTAMP:\S+/,''),event.text.replace(/DTSTAMP:\S+/,''));
  // Every dated event of every published card turns into a well-formed file with a unique UID.
  const uids=new Set();
  for(const card of catalog.ACTIVITIES.filter(x=>!C.isArchive(x)))card.events.forEach((e,i)=>{
    const text=unfold(EX.eventFile(card.id,i).text),uid=text.match(/UID:(\S+)\r\n/)[1];
    assert.match(uid,/@minitandem\.local$/);
    assert.ok(!uids.has(uid),'duplicate UID '+uid);
    uids.add(uid);
    assert.ok(text.includes('BEGIN:VEVENT')&&text.includes('END:VEVENT'));
  });
  assert.ok(uids.size>50);
  assert.equal(typeof W.MinitandemExports.UID_DOMAIN,'string');
});
test('calendar text escapes backslash, comma and line breaks',()=>{
  const {icsEscape}=loadStack({today:'2026-09-27'}).window.MinitandemExports;
  assert.equal(icsEscape('a,b\\c\nd'),'a\\,b\\\\c\\nd');
  assert.equal(icsEscape('plain text'),'plain text');
});
test('semicolons in calendar text are escaped as the format requires',()=>{
  const {icsEscape}=loadStack({today:'2026-09-27'}).window.MinitandemExports;
  assert.equal(icsEscape('a;b'),'a\\;b');
});
test('the one remembered child age filters the catalogue and clearing it restores the full list',()=>{
  const {C,K,state,store,list,localStorage}=loadStack({today:'2026-09-28'});
  const all=list(),ids=items=>Array.from(items,a=>a.id);
  assert.equal(store.personal.age,null);assert.equal(C.activeCount(state.f,store.personal.age),0);
  store.personal.age=2.5;
  const fitted=list(),kept=new Set(ids(fitted));
  assert.ok(fitted.length>0&&fitted.length<all.length,'setting the age narrows the list');
  for(const a of all)assert.equal(kept.has(a.id),C.ageFit(a,2.5)!==false,a.id+': only cards whose published limits exclude the age drop out');
  assert.equal(C.activeCount(state.f,2.5),1,'the age counts as one active filter');
  state.f.includeUnknownAge=false;
  const strict=list();
  assert.ok(strict.length>0&&strict.length<fitted.length&&strict.every(a=>C.ageFit(a,2.5)===true),'cards with no published age limit can be left out');
  state.f.includeUnknownAge=true;
  store.personal.age=0;
  const newborn=list();
  assert.ok(newborn.length<all.length,'age 0 is a real age, not "no age"');
  const older=all.find(a=>a.min>0);assert.ok(older&&!ids(newborn).includes(older.id));
  store.personal.age=null;
  assert.deepEqual(ids(list()),ids(all),'clearing the age restores the full list');
  assert.equal(C.activeCount(state.f,null),0);
  // The age is the visitor's own remembered setting: saved with the profile and restored on the next visit.
  store.personal.age=4;assert.ok(store.persist());
  assert.equal(localStorage.read(store.KEYS.family).age,4);
  const next=loadStack({today:'2026-09-28',local:{[store.KEYS.family]:localStorage.read(store.KEYS.family)}});
  assert.equal(next.store.personal.age,4);
  assert.deepEqual(ids(next.list()),ids((store.personal.age=4,list())));
});
test('a stored or imported child age outside 0–18 is dropped, not applied as a filter',()=>{
  const {store,K}=loadStack({today:'2026-09-28'});
  const age=value=>store.validateBackup({version:1,favorites:[],notes:{},statuses:{},age:value}).age;
  assert.equal(K.MAX_AGE,18);
  for(const ok of [0,.5,2.5,K.MAX_AGE])assert.equal(age(ok),ok);
  for(const bad of [-1,K.MAX_AGE+.5,19,NaN,Infinity,'3',null,undefined])assert.equal(age(bad),null,String(bad));
});
test('ordinary CSV export excludes personal notes and statuses',()=>{
  const {EX,C,store,byId,t}=loadStack({today:'2026-09-28'});
  store.personal.notes.mpe='PRIVATE_NOTE';store.personal.statuses.mpe='booked';store.personal.origin='PRIVATE_HOME';
  const row={...byId.get('mpe'),name:'=PRIVATE_FORMULA'};
  const out=EX.csvFile([row],a=>C.statusOf(a,store.personal.age));
  assert.match(out.name,/^minitandem-catalogue-2026-09-28\.csv$/);assert.equal(out.type,'text/csv;charset=utf-8');
  assert.match(out.text,/"'=PRIVATE_FORMULA"/);
  assert.doesNotMatch(out.text,/PRIVATE_NOTE|PRIVATE_HOME|booked/);
  assert.ok(!out.text.includes(t('mine.title'))&&!out.text.includes(t('mine.status')));
  assert.doesNotMatch(withoutStoredIds(out.text),oldName);
  assert.equal(out.text.charCodeAt(0),0xFEFF,'a byte order mark lets spreadsheets read the accents');
  const [header,line,...rest]=out.text.slice(1).split('\r\n');
  assert.equal(header,'"Name";"Category";"Town";"District";"Address";"Age";"Adult";"Language";"Schedule";"Price";"Status";"Contacts";"Sources";"Checked"');
  assert.equal(rest.length,0);assert.ok(line.endsWith(`"${row.checked}"`));
});
test('CSV cells that a spreadsheet could read as formulas are neutralised and quotes are doubled',()=>{
  const {EX,C,byId}=loadStack({today:'2026-09-28'}),mpe=byId.get('mpe');
  const cells=name=>{
    const out=EX.csvFile([{...mpe,name}],a=>C.statusOf(a,null));
    return out.text.slice(1).split('\r\n')[1].split('";"')[0].slice(1);
  };
  for(const name of ['=1+1','+41 26 000 00 00','-5','@SUM(A1)',' =HYPERLINK("x")','\tcmd'])assert.ok(cells(name).startsWith("'"),JSON.stringify(name));
  assert.equal(cells('Plain name'),'Plain name');
  assert.equal(cells('Say "hello"'),'Say ""hello""');
});
test('downloadable files use Minitandem names and types and keep private records out of public ones',()=>{
  const {EX,X:stackX,C,store,byId,I}=loadStack({today:'2026-09-28'});
  store.personal.notes.mpe='PRIVATE_NOTE';store.personal.origin='PRIVATE_HOME';store.personal.favorites=['mpe'];
  const plan=stackX.plan({type:'vmeste-plan',version:1,visits:{'v-test':privateVisit}},byId);
  const json=EX.planJson(plan);
  assert.equal(json.name,'minitandem-plan-2026-09-28.json');assert.equal(json.type,'application/json');
  assert.deepEqual(JSON.parse(json.text),JSON.parse(JSON.stringify(plan)));assert.doesNotMatch(json.text,/SECRET/);
  const pilot=EX.pilotFile(stackX.metrics({'v-test':privateVisit}));
  assert.equal(pilot.name,'minitandem-pilot-summary.json');assert.equal(JSON.parse(pilot.text).type,'minitandem-pilot-summary');
  const correction=EX.correctionFile(stackX.report({type:'vmeste-correction',version:1,activity:'mpe',topic:'Other',message:'Fixture',date:'2026-09-28'},byId));
  assert.equal(correction.name,'minitandem-correction-mpe.json');assert.equal(JSON.parse(correction.text).type,'vmeste-correction');
  const backup=EX.backupFile(store.personal);
  assert.equal(backup.name,'minitandem-backup-2026-09-28.json');assert.equal(JSON.parse(backup.text).notes.mpe,'PRIVATE_NOTE');
  assert.ok(JSON.parse(backup.text).exportedAt);
  const addresses=EX.addressesFile([byId.get('mpe')]);
  assert.equal(addresses.name,'minitandem-addresses-2026-09-28.txt');assert.equal(addresses.type,'text/plain;charset=utf-8');
  assert.ok(addresses.text.includes(I.t('addresses.title'))&&addresses.text.includes(byId.get('mpe').address));
  assert.doesNotMatch(addresses.text,/PRIVATE/);
  for(const file of [json,pilot,correction,backup,addresses])assert.doesNotMatch(withoutStoredIds(file.text),oldName,file.name);
});
test('editorial intake deduplicates reports and leaves catalogue data unchanged',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-intake-')),input=path.join(folder,'report.json');let created;
  const before=fs.readFileSync(path.join(root,'data-practical.js'),'utf8');
  const env={...process.env,MINITANDEM_CORRECTION_DIR:path.join(folder,'corrections')};
  try{
    fs.writeFileSync(input,JSON.stringify({type:'vmeste-correction',version:1,activity:'mpe',topic:'Other',date:'2026-09-27',message:'Automated intake fixture, not a factual correction: '+path.basename(folder)}));
    const first=JSON.parse(execFileSync(process.execPath,[path.join(root,'editorial/intake.mjs'),input],{encoding:'utf8',env}));created=first.file;
    const second=JSON.parse(execFileSync(process.execPath,[path.join(root,'editorial/intake.mjs'),input],{encoding:'utf8',env}));
    assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);assert.equal(second.catalogChanged,false);
    assert.ok(first.file.startsWith(env.MINITANDEM_CORRECTION_DIR),'the report is stored in the configured folder');
    assert.equal(JSON.parse(fs.readFileSync(created,'utf8')).status,'pending-review');
    assert.equal(fs.readFileSync(path.join(root,'data-practical.js'),'utf8'),before);
  }finally{if(created)fs.rmSync(created);fs.rmSync(folder,{recursive:true,force:true});}
});
test('editorial intake records the fields an editors\' report names, and only fields of the catalogue',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-intake-')),input=path.join(folder,'report.json');
  const env={...process.env,MINITANDEM_CORRECTION_DIR:path.join(folder,'corrections')};
  const run=(...args)=>JSON.parse(execFileSync(process.execPath,[path.join(root,'editorial/intake.mjs'),input,...args],{encoding:'utf8',env,stdio:'pipe'}));
  try{
    fs.writeFileSync(input,JSON.stringify({type:'vmeste-correction',version:1,activity:'mpe',topic:'Schedule',date:'2026-10-22',message:'Automated intake fixture, not a factual correction'}));
    const plain=run(),named=run('--fields=schedule,events');
    assert.notEqual(named.file,plain.file);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(plain.file,'utf8')),'fields'),false);
    assert.deepEqual(JSON.parse(fs.readFileSync(named.file,'utf8')).fields,['schedule','events']);
    for(const fields of ['--fields=research.findings','--fields=price,price','--fields='])assert.throws(()=>run(fields),/Unknown or repeated report field/);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('editorial intake accepts only the English correction topics',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-intake-')),input=path.join(folder,'report.json');
  const env={...process.env,MINITANDEM_CORRECTION_DIR:path.join(folder,'corrections')};
  try{
    fs.writeFileSync(input,JSON.stringify({type:'vmeste-correction',version:1,activity:'mpe',topic:'other',date:'2026-09-27',message:'Automated intake fixture, not a factual correction'}));
    assert.throws(()=>execFileSync(process.execPath,[path.join(root,'editorial/intake.mjs'),input],{encoding:'utf8',env,stdio:'pipe'}),/Invalid correction/);
    assert.equal(fs.existsSync(env.MINITANDEM_CORRECTION_DIR),false,'nothing is stored for a rejected report');
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
