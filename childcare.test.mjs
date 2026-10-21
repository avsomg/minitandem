// The Daycare tab in the interface: its filters and order (childcare.js), its markup (childcare-views.js), the family's applications in the
// browser, in the backup and in an import (store.js, exports.js), its words in three languages and its place in the page and the file lists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {loadStack,root} from './test-support.mjs';
import {SCRIPTS,LAZY_SCRIPTS} from './ui-files.mjs';
import {texts,digest} from './scripts/compile-childcare.mjs';

const today='2026-10-21';
const stack=(options={})=>loadStack({today,...options});
const ids=list=>list.map(p=>p.id);
// Values made in the page's realm (the modules run in a vm), compared as plain data.
const plain=value=>JSON.parse(JSON.stringify(value));
const PROVIDENCE='creche-la-providence-fribourg';
// An invented place for the age rules: only the facts a test gives it.
const placeWith=facts=>({id:'test-place',type:'creche',name:'Test',town:'Fribourg',address:'',postcode:'',lat:46.8,lon:7.15,checked:today,pages:['https://a.example.org/'],
  facts:Object.fromEntries(Object.entries(facts).map(([key,value])=>[key,{value,sources:[0]}]))});

test('the age: a minimum in weeks or months and an upper bound in years, read like the activities\' ages; no minimum published is unknown',()=>{
  const M=stack().window.MinitandemChildcare;
  const fit=(facts,age)=>M.ageFit(placeWith(facts),age);
  assert.equal(fit({ageFrom:{weeks:12},ageTo:{years:4}},0),true,'age 0 stands for the first year: 12 weeks is reached');
  assert.equal(fit({ageFrom:{months:30}},2),false,'30 months is not reached at 2');
  assert.equal(fit({ageFrom:{months:30}},3),true);
  assert.equal(fit({ageFrom:{months:24},ageTo:{years:4}},5),false,'over the upper bound');
  assert.equal(fit({ageFrom:{months:24},ageTo:{years:4.5}},4),true);
  assert.equal(fit({ageFrom:{text:'From the end of maternity leave'}},1),null,'a minimum in words only decides nothing');
  assert.equal(fit({ageTo:{years:4}},6),false);assert.equal(fit({ageTo:{years:4}},3),null);
  assert.equal(fit({},3),null);assert.equal(fit({ageFrom:{months:3}},null),null);
});
test('filters: kind of care, subsidy, opening hours, language and approach count only what a place states; the child\'s age leaves out only places it excludes',()=>{
  const {CH,window:W}=stack(),M=W.MinitandemChildcare,f=()=>M.defaultFilters(),value=M.value;
  assert.equal(CH.filter(f()).length,CH.places.length);
  const creches=f();creches.types.add('creche');
  assert.ok(CH.filter(creches).length>50&&CH.filter(creches).every(p=>p.type==='creche'));
  const subsidised=f();subsidised.subsidy.add('yes');
  assert.ok(CH.filter(subsidised).length>50&&CH.filter(subsidised).every(p=>value(p,'subsidised').value==='yes'));
  const early=f();early.opensBy='07:00';early.closesAfter='18:00';
  assert.ok(CH.filter(early).length>20);
  for(const p of CH.filter(early))assert.ok(value(p,'hours').opensAt<='07:00'&&value(p,'hours').closesAt>='18:00',p.id);
  assert.ok(CH.places.some(p=>!value(p,'hours')?.opensAt)&&CH.filter(early).every(p=>value(p,'hours')?.opensAt),'a place without stated hours is left out');
  const german=f();german.languages.add('de');
  assert.ok(CH.filter(german).length>5&&CH.filter(german).every(p=>value(p,'languages').includes('de')));
  const montessori=f();montessori.approaches.add('montessori');montessori.approaches.add('montessoriElements');
  assert.ok(CH.filter(montessori).length>5&&CH.filter(montessori).every(p=>['full','partial'].includes(value(p,'pedagogy').montessori)),'one of the chosen approaches');
  for(const age of [0,3,5]){
    const list=CH.filter(f(),{age});
    assert.ok(list.every(p=>CH.ageFit(p,age)!==false),'age '+age);
    if(age!==3)assert.ok(CH.places.some(p=>CH.ageFit(p,age)===false)&&list.length<CH.places.length,'age '+age+' leaves some out');
    const first=list.findIndex(p=>CH.ageFit(p,age)!==true);
    assert.ok(first>0&&list.slice(first).every(p=>CH.ageFit(p,age)!==true),'age '+age+': the places whose age fits come first');
  }
});
test('distance: nearest first from the point the visitor set, the limit leaves out what is farther; search by name, town and the other language\'s town name',()=>{
  const {CH,K,window:W}=stack(),M=W.MinitandemChildcare;
  const near={kind:'town',name:'Marly',lat:46.776,lon:7.159};
  const list=CH.filter(M.defaultFilters(),{near});
  for(let i=1;i<list.length;i++)assert.ok(CH.distance(list[i-1],near)<=CH.distance(list[i],near));
  const within=CH.filter(M.defaultFilters(),{near,radius:5});
  assert.ok(within.length>5&&within.length<list.length&&within.every(p=>K.distanceKm(near,{lat:p.lat,lon:p.lon})<=5));
  const search=M.defaultFilters();search.query='providence';
  assert.deepEqual(plain(ids(CH.filter(search))),[PROVIDENCE]);
  search.query='freiburg';
  assert.ok(CH.filter(search).length>10&&CH.filter(search).every(p=>p.town==='Fribourg'||/freiburg/i.test(p.address)),'Freiburg finds Fribourg (and a Freiburgstrasse)');
  search.query='Crèche (full day) Marly';
  assert.ok(CH.filter(search).length>0&&CH.filter(search).every(p=>p.type==='creche'),'the kind of care in words is searchable');
});
test('the filters that are on become chips that remove them; toggling accepts only known values',()=>{
  const {CH,CV,window:W}=stack(),f=W.MinitandemChildcare.defaultFilters();
  CH.toggle(f,'type','playgroup');CH.toggle(f,'subsidy','convention');CH.toggle(f,'opens','07:00');CH.toggle(f,'type','nonsense');CH.toggle(f,'closes','23:00');
  assert.deepEqual(plain(CH.active(f).map(x=>x.key)),['type:playgroup','subsidy:convention','opens']);
  assert.deepEqual(plain(CH.active(f).map(CV.filterLabel)),['Playgroup','Agreement with a commune','Opens by 07:00']);
  const chips=CV.filterChips(CH.active(f).map(x=>({key:'cc:'+x.key,label:CV.filterLabel(x)})));
  assert.match(chips,/data-remove="cc:type:playgroup" aria-label="Remove filter: Playgroup"/);
  assert.ok(!chips.includes('data-quick'),'no rainy-day switch in this tab');
  CH.remove(f,'type:playgroup');CH.remove(f,'opens');
  assert.deepEqual(plain(CH.active(f).map(x=>x.key)),['subsidy:convention']);
  CH.toggle(f,'subsidy','convention');assert.equal(CH.anyFilter(f),false);
});
test('a renewal date: every n months from the day of registration, the next one from today on, at the end of a shorter month',()=>{
  const M=stack().window.MinitandemChildcare;
  assert.equal(M.addMonths('2026-01-31',1),'2026-02-28');assert.equal(M.addMonths('2027-12-15',2),'2028-02-15');
  assert.equal(M.nextRenewal('2026-06-30',4,today),'2026-10-30');
  assert.equal(M.nextRenewal('2026-02-21',4,today),'2026-10-21','due today');
  assert.equal(M.nextRenewal('2025-10-31',4,today),'2026-10-31','counted from the day of registration, not from the shorter months between');
  assert.equal(M.nextRenewal('',4,today),'');assert.equal(M.nextRenewal('2026-06-30',null,today),'');
});
test('a list row: kind of care, name, town, age, hours, subsidy and approach, the family\'s status; a link that opens the place',()=>{
  const S=stack(),p=S.CH.byId.get(PROVIDENCE);
  const row=S.CV.row(p);
  assert.match(row,/^<li><a class="row c-childcare" href="#view=childcare&amp;place=creche-la-providence-fribourg" data-place="creche-la-providence-fribourg">/);
  for(const text of ['Crèche (full day)','Crèche La Providence','Fribourg','06:30–18:15','Subsidised · Montessori elements'])assert.ok(row.includes(text),text);
  assert.match(row,/<span class="r-age known">12 weeks–4 years<\/span>/);
  assert.ok(!row.includes('r-dist'),'no distance before a point is set');
  S.state.near={kind:'town',name:'Fribourg',lat:46.8064,lon:7.1615};
  assert.match(S.CV.row(p),/<span class="r-dist">≈.[\d.]+.km<\/span>/);
  S.store.childcare.applications[p.id]={status:'waiting',registered:'',renewBy:'',note:''};
  assert.ok(S.CV.row(p).includes('<span class="sr">My application: On the waiting list</span>'));
  const fr=stack({lang:'fr'});
  assert.ok(fr.CV.row(p).includes('Crèche (journée complète)')&&fr.CV.row(p).includes('12 semaines–4 ans'));
  assert.ok(fr.CV.list(fr.CH.places,24).includes('Afficher plus · 24 sur '+fr.CH.places.length));
});
test('a place\'s page: the rows of the accepted preview, each published fact with its pages, "not published" for the rest, the date it was checked',()=>{
  const S=stack(),p=S.CH.byId.get(PROVIDENCE),html=S.CV.detail(p);
  const rows=[...html.matchAll(/<div class="fr"><dt>([^<]+)<\/dt>/g)].map(m=>m[1]);
  assert.deepEqual(rows.slice(0,11),['Age','Days and hours','Closed','Price','How to register','Free places','Meals','Settling in','Trial period','Approach','Languages']);
  assert.ok(html.includes('<span>From 12 weeks</span><br><span>Until compulsory school entry (oldest group 30 months to 4 years)</span>'),'the minimum and the upper limit, each on its line');
  assert.equal(S.CV.sourceLabel('https://ville-fribourg.ch/files/R%C3%A9ponse%20%C3%A0%20la%20question%20no%20114_Accueil%20cr%C3%A8ches.pdf'),'ville-fribourg.ch › Réponse à la question no 114_Accueil…','a long file name ends with an ellipsis');
  assert.ok(html.includes('<span class="sub">Prices valid from 1 Aug 2021</span>'));
  assert.match(html,/<div class="fr"><dt>Free places<\/dt><dd><span class="np">Not published by the place<\/span><\/dd><\/div>/);
  assert.ok(html.includes('<a href="https://www.crechelaprovidence.ch/horaires/" target="_blank" rel="noopener noreferrer">crechelaprovidence.ch › horaires</a>'));
  assert.ok(html.includes('Checked 20 Oct 2026 against the place’s own pages and the commune’s.'));
  assert.match(html,/<a class="go" href="https:\/\/www\.crechelaprovidence\.ch\/?" target="_blank" rel="noopener noreferrer">Open the place’s website/);
  assert.ok(!/mailto:|tel:/.test(html),'the website is the only contact');
  assert.ok(!html.includes(' lang="en"'),'English page: no language marks');
  const de=stack({lang:'de'}).CV.detail(p);
  assert.ok(de.includes('<span lang="en">Mon–Fri 06:30–18:15')&&de.includes('Die Angaben zu den Einrichtungen sind vorerst auf Englisch'),'German: the facts are marked English');
  // A price dated by a day, a month, a year or a school year.
  assert.deepEqual(plain(['2021-08-01','2025-08','2025','2025-2026','2025/2026','2026-27'].map(S.CV.priceDate)),
    ['Prices valid from 1 Aug 2021','Prices valid from August 2025','Prices valid from 2025','Prices for 2025–2026','Prices for 2025–2026','Prices for 2026–27']);
  for(const q of S.CH.places)assert.doesNotThrow(()=>S.CV.detail(q),q.id+': its page is built');
  const pending=structuredClone(p);pending.pending=['availability'];
  assert.ok(S.CV.detail(pending).includes('<span class="np">Being checked again</span>'));
});
test('the commune the family chooses: its confirmed rules with their pages and calculator, and the renewal interval next to the date of registration',()=>{
  const S=stack(),p=S.CH.byId.get(PROVIDENCE);
  assert.ok(S.CV.detail(p).includes('Choose your commune to see its rules.'));
  assert.equal(S.CV.renewal(p.id),'Choose where you live above to see whether your commune asks you to renew the registration.');
  S.store.childcare.commune='fribourg';
  const rules=S.CV.rules();
  assert.ok(rules.includes('<h4 class="cc-rules-title">Getting a place in Fribourg (city)</h4>'));
  for(const label of ['Waiting list','Keeping your place on the list','Who can register','What parents pay','Subsidised crèches','Price calculator'])assert.ok(rules.includes(`<dt>${label}</dt>`),label);
  assert.ok(rules.includes('Creches_Calcul_revenu_determinant_et_tarif_vf_1_0.xlsx')&&rules.includes('The commune’s calculator'));
  assert.equal(S.CV.renewal(p.id),'Fribourg (city): the registration must be renewed every 4 months.');
  S.store.childcare.applications[p.id]={status:'waiting',registered:'2026-08-15',renewBy:'',note:''};
  assert.equal(S.CV.renewal(p.id),'Fribourg (city): the registration must be renewed every 4 months. Next renewal by 15 Dec 2026.');
  S.store.childcare.commune='marly';
  assert.equal(S.CV.renewal(p.id),'The rules of Marly shown here state no renewal interval.');
  for(const c of S.CH.communes)assert.doesNotThrow(()=>S.CV.rules(c.id),c.id+': its rules are shown');
  const select=S.CV.communeSelect('cc-commune');
  assert.match(select,/<option value="marly" selected>Marly<\/option>/);
  assert.match(select,/<optgroup label="Regional bodies and associations"><option value="region-/);
});
test('my applications: the one to renew first on top, an overdue date marked, the private note; an empty list says how to start',()=>{
  const S=stack();
  assert.ok(S.CV.mine().includes('No applications yet. Open a place and choose a status under “My application”.'));
  S.store.childcare.commune='fribourg';
  S.store.childcare.applications={[PROVIDENCE]:{status:'waiting',registered:'2026-06-30',renewBy:'',note:'Ref. 12'},'creche-mandarine-fribourg':{status:'registered',registered:'',renewBy:'2026-10-01',note:''},
    'no-longer-listed':{status:'interested',registered:'',renewBy:'',note:''}};
  const html=S.CV.mine();
  assert.ok(html.indexOf('creche-mandarine-fribourg')<html.indexOf(PROVIDENCE),'the earlier date first');
  assert.ok(html.includes('1 Oct 2026 <b class="cc-overdue">date passed</b>'));
  assert.ok(html.includes('30 Oct 2026<span class="sub">from your commune’s rule</span>'));
  assert.ok(html.includes('Ref. 12')&&!html.includes('no-longer-listed'));
  assert.ok(S.CV.parts('mine').includes('My applications <b>2</b>'));
});
test('the filter panel: the activity list\'s distance and age controls, then the tab\'s own groups',()=>{
  const S=stack(),panel=S.CV.panel();
  for(const id of ['g-near','nearGeo','nearTown','nearRadius','g-age','age','ageHint','g-cctype','g-ccsub','ccOpens','ccCloses','g-cclang','g-ccapproach'])assert.ok(panel.includes(`id="${id}"`),id);
  assert.ok(!panel.includes('id="unkRow"'),'the switch for unknown ages belongs to the activity list');
  assert.match(panel,/data-ckind="type" data-val="creche" aria-pressed="false">Crèche \(full day\) <span class="num">\d+<\/span>/);
  assert.ok(S.V.panel().includes('id="unkRow"'),'the activity panel is unchanged');
});
test('the applications stay in this browser under a key of their own: never in the family record the service could receive, always in the backup',()=>{
  const S=stack(),{store}=S;
  store.childcare.commune='fribourg';store.childcare.applications[PROVIDENCE]={status:'waiting',registered:'2026-10-01',renewBy:'',note:'n'};
  assert.equal(store.saveChildcare(),true);
  assert.deepEqual(S.localStorage.read('minitandem-childcare-v1'),{version:1,commune:'fribourg',applications:{[PROVIDENCE]:{status:'waiting',registered:'2026-10-01',renewBy:'',note:'n'}}});
  assert.ok(!('childcare' in store.personal)&&!('applications' in store.personal));
  store.personal.notes.mpe='x';store.persist();
  assert.ok(!JSON.stringify(S.localStorage.read('minitandem-family-v1')).includes(PROVIDENCE),'the family record holds no application');
  const backup=JSON.parse(S.EX.backupFile(store.personal,store.childcare).text);
  assert.deepEqual(backup.childcare,plain(store.childcare));assert.equal(backup.notes.mpe,'x');
  assert.equal(JSON.parse(S.EX.backupFile(store.personal).text).childcare,undefined,'without the second argument, as before');
});
test('a backup\'s applications are checked like the other records and replace the matching ones on import; an older backup has none',()=>{
  const S=stack(),{store}=S;
  assert.throws(()=>store.validateChildcare({version:2,applications:{}}),error=>error.code==='backup.invalid');
  assert.throws(()=>store.validateChildcare({version:1,applications:[]}),error=>error.code==='backup.invalid');
  const clean=store.validateChildcare({version:1,commune:'fribourg',applications:{
    [PROVIDENCE]:{status:'offered',registered:'2026-02-30',renewBy:'2026-11-01',note:'y'.repeat(2500),extra:'dropped'},
    'Bad Id':{status:'waiting'},'creche-x':{status:'bogus',note:''},'creche-y':{status:'bogus',note:'kept'}}});
  assert.deepEqual(plain(clean),{version:1,commune:'fribourg',applications:{[PROVIDENCE]:{status:'offered',registered:'',renewBy:'2026-11-01',note:'y'.repeat(2000)},'creche-y':{status:'',registered:'',renewBy:'',note:'kept'}}});
  store.childcare.applications={[PROVIDENCE]:{status:'interested',registered:'',renewBy:'',note:'mine'},'creche-mandarine-fribourg':{status:'waiting',registered:'',renewBy:'',note:''}};
  store.saveChildcare();
  assert.equal(store.saveChildcare(clean),true);
  assert.equal(store.childcare.applications[PROVIDENCE].status,'offered','the file wins for the same place');
  assert.equal(store.childcare.applications['creche-mandarine-fribourg'].status,'waiting','others stay');
  assert.equal(store.childcare.commune,'fribourg');
  const confirm=S.V.importConfirm(store.validateBackup({version:1,favorites:[],notes:{},statuses:{}}),clean).body;
  assert.ok(confirm.includes('Daycare applications: 2. They replace the ones for the same places in this browser.'));
  assert.ok(!S.V.importConfirm(store.validateBackup({version:1,favorites:[],notes:{},statuses:{}})).body.includes('Daycare'));
});
test('two tabs: each tab\'s change to an application goes into what is stored, a removal included; a damaged record is not read',()=>{
  const S=stack(),one=S.store;
  const two=S.window.MinitandemStore.create({storage:S.localStorage,byId:S.byId,P:S.P,today:S.C.today,statusKeys:S.K.PERSONAL_KEYS,applicationKeys:S.window.MinitandemChildcare.APPLICATION_KEYS});
  one.childcare.applications.a={status:'waiting',registered:'',renewBy:'',note:''};one.saveChildcare();
  two.childcare.applications.b={status:'registered',registered:'',renewBy:'',note:''};two.childcare.commune='marly';two.saveChildcare();
  delete one.childcare.applications.a;one.saveChildcare();
  assert.deepEqual(plain(Object.keys(S.localStorage.read('minitandem-childcare-v1').applications)),['b']);
  assert.equal(one.childcare.commune,'marly');
  S.localStorage.setItem('minitandem-childcare-v1','{not json');
  assert.throws(()=>one.reloadChildcare(),error=>error.name==='SyntaxError');
  one.childcare.applications.c={status:'accepted',registered:'',renewBy:'',note:''};
  assert.equal(one.saveChildcare(),true,'a damaged record is replaced by this tab\'s');
  S.localStorage.blockWrites(true);
  one.childcare.applications.d={status:'accepted',registered:'',renewBy:'',note:''};
  assert.equal(one.saveChildcare(),false);assert.equal(one.storageAvailable,false);
});
test('the tab\'s words exist in English, German and French, for every kind, status, rule and fact the data can name',()=>{
  const S=stack(),D=S.window.MINITANDEM_STRINGS,M=S.window.MinitandemChildcare;
  const keys=[...M.TYPE_KEYS.map(k=>'childcare.type.'+k),...M.SUBSIDY_KEYS.map(k=>'childcare.subsidy.'+k),...M.LANGUAGE_KEYS.map(k=>'childcare.lang.'+k),
    ...M.APPROACH_KEYS.map(k=>'childcare.approach.'+k),...['', ...M.APPLICATION_KEYS].map(k=>'childcare.status.'+(k||'none')),...M.RULE_KEYS.map(k=>'childcare.rule.'+k),
    ...M.DETAIL_ROWS.map(k=>'childcare.fact.'+k),...M.VIEW_KEYS.map(k=>'childcare.show.'+k),'tab.childcare','view.childcare','childcare.map.cluster_one','childcare.map.cluster_other'];
  for(const lang of ['en','de','fr'])assert.deepEqual(keys.filter(k=>!D[lang][k]),[],lang);
  assert.deepEqual([D.en['tab.childcare'],D.de['tab.childcare'],D.fr['tab.childcare']],['Daycare','Kita','Crèche']);
  for(const lang of ['de','fr'])assert.ok(D[lang]['data.backupText'].includes(lang==='de'?'Kita-Anmeldungen':'inscriptions en crèche'));
  assert.ok(D.en['about.privacy'].includes('daycare applications and the commune chosen for them')&&D.en['data.backupText'].includes('daycare applications'));
  for(const [lang,words] of [['de','Kita-Anmeldungen und die dafür gewählte Gemeinde'],['fr','inscriptions en crèche et la commune choisie pour elles']])assert.ok(D[lang]['about.privacy'].includes(words),lang);
  // The notice names the commune in the sentence after the applications: the first sentence is also the page's search description (at most 170 characters).
  for(const [lang,words] of [['en','daycare applications, the child'],['en','the commune chosen for the daycare applications'],['de','Kita-Anmeldungen, das Alter'],['de','die für die Kita-Anmeldungen gewählte Gemeinde'],
    ['fr','inscriptions en crèche, l’âge'],['fr','la commune choisie pour les inscriptions en crèche']])
    assert.ok(fs.readFileSync(path.join(root,`content/datenschutz.${lang}.md`),'utf8').includes(words),'privacy notice '+lang+': '+words);
  for(const [key,value] of Object.entries(D.fr).filter(([k])=>k.startsWith('childcare.')))assert.ok(!/ [:;?!»]|« /.test(value),'fr '+key+' needs a no-break space');
  assert.ok(!Object.values(D.de).some(v=>v.includes('ß')),'Swiss German: no sharp s');
});
test('the page: a fifth tab, a box for the tab, its two scripts in the shell and its places loaded only with the tab',()=>{
  const index=fs.readFileSync(path.join(root,'index.html'),'utf8'),sw=fs.readFileSync(path.join(root,'sw.js'),'utf8'),app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  assert.match(index,/<button type="button" class="tab" data-view="childcare" aria-pressed="false"><span data-i18n="tab.childcare">Daycare<\/span><\/button>/);
  assert.ok(index.includes('<div id="childcareBox" class="childcare" hidden></div>')&&index.includes('<p class="viewlead" id="viewLead" hidden></p>'));
  assert.ok(SCRIPTS.indexOf('childcare.js')<SCRIPTS.indexOf('app.js')&&SCRIPTS.indexOf('views.js')<SCRIPTS.indexOf('childcare-views.js'));
  for(const file of ['data-childcare.js','data-childcare-de.js','data-childcare-fr.js'])assert.ok(LAZY_SCRIPTS.includes(file)&&!index.includes(file)&&sw.includes(`'/${file}'`),file);
  assert.ok(sw.includes("'/childcare-views.js'"));
  assert.match(app,/script\.src = 'data-childcare\.js'/);assert.match(app,/script\.src = `data-childcare-\$\{lang\}\.js`/);
  assert.ok(stack().K.VIEWS.includes('childcare'),'the address names the tab');
});

// German texts for the tab as the page gets them (data-childcare-de.js): {id: {en, text}}, set up in the stack's own window.
function translated(entries,lang='de',fileLang=lang){
  const S=stack({lang}),W=S.window,M=W.MinitandemChildcare;
  (W.MINITANDEM_CHILDCARE_TEXTS||={})[fileLang]=entries;
  const CH=M.create({data:W.CHILDCARE,K:S.K,clock:{today:()=>today},t:S.t,translate:M.translator(()=>W.MINITANDEM_CHILDCARE_TEXTS?.[S.I.lang()],W.MinitandemCatalogueI18n.sha256)});
  const CV=W.MinitandemChildcareViews.create({t:S.t,F:S.F,V:S.V,K:S.K,CH:()=>CH,store:S.store,state:()=>S.state,lang:S.I.lang});
  return {...S,CH,CV};
}
test('translated texts: shown while their English is the one they were made from, English (marked) once it changed, and said so',()=>{
  const p='creche-la-providence-fribourg',hours=stack().CH.byId.get(p).facts.hours.value.text,meals=stack().CH.byId.get(p).facts.meals.value.text;
  const S=translated({[`place/${p}/hours`]:{en:digest(hours),text:'Mo–Fr 06:30–18:15 (übersetzt)'},[`place/${p}/meals`]:{en:digest('an older English text'),text:'Veraltete Übersetzung'},
    'commune/fribourg/name':{en:digest('Fribourg (city)'),text:'Freiburg (Stadt)'}});
  const html=S.CV.detail(S.CH.byId.get(p));
  assert.ok(html.includes('<span>Mo–Fr 06:30–18:15 (übersetzt)</span>'),'the current translation, without an English mark');
  assert.ok(!html.includes('Veraltete Übersetzung')&&html.includes(`<span lang="en">${S.V.esc(meals)}</span>`),'a translation of an older English is not shown');
  assert.ok(html.includes('<p class="hint d-english">Angaben zu den Einrichtungen ohne aktuelle Übersetzung erscheinen auf Englisch.</p>'));
  assert.match(S.CV.communeSelect('cc-commune'),/<option value="fribourg">Freiburg \(Stadt\)<\/option>/);
  S.store.childcare.commune='fribourg';
  assert.ok(S.CV.rules().includes('Einen Platz bekommen: Freiburg (Stadt)')&&S.CV.renewal(p).startsWith('Freiburg (Stadt): '));
  assert.deepEqual(JSON.parse(JSON.stringify(S.CH.coverage())),{total:texts(S.window.CHILDCARE).length,translated:2});
  // With no translations at all, everything is English as before, and the page says the texts will follow.
  const none=translated({});
  assert.ok(none.CV.detail(none.CH.byId.get(p)).includes(`<p class="hint d-english">Die Angaben zu den Einrichtungen sind vorerst auf Englisch; Deutsch und Französisch folgen.</p>`));
  assert.equal(none.CH.coverage().translated,0);
  // Back in English, the German file that was loaded is not used.
  const en=translated({[`place/${p}/hours`]:{en:digest(hours),text:'Mo–Fr'}},'en','de');
  assert.ok(!en.CV.detail(en.CH.byId.get(p)).includes('Mo–Fr<'));
});
test('the page asks for the same ids and digests the compile script exports: a full set of translations covers every text',()=>{
  const list=texts(stack().window.CHILDCARE);
  assert.equal(new Set(list.map(item=>item.id)).size,list.length,'ids are unique');
  const S=translated(Object.fromEntries(list.map(item=>[item.id,{en:digest(item.en),text:'DE '+item.en}])));
  assert.deepEqual(JSON.parse(JSON.stringify(S.CH.coverage())),{total:list.length,translated:list.length});
  for(const p of S.CH.places.slice(0,40))assert.ok(!S.CV.detail(p).includes(' lang="en"'),p.id+': every text of its page is translated');
  assert.equal(S.window.MinitandemCatalogueI18n.sha256(list[0].en),digest(list[0].en),'the page computes the digest the script records');
});
