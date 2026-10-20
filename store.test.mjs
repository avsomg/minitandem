// The visitor's own records and where they live: backup validation, saving that merges with other tabs, the visit limit,
// blocked storage and the small side records (corrections waiting for the service, the service connection).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {loadStack} from './test-support.mjs';

const FAMILY='minitandem-family-v1';
const plain=v=>JSON.parse(JSON.stringify(v));
const base={version:1,favorites:[],notes:{},statuses:{},age:null};
const load=(profile=null,options={})=>loadStack({...options,local:profile?{[FAMILY]:profile}:{}});
// Another tab: a second store on the same browser storage.
const openTab=s=>s.window.MinitandemStore.create({storage:s.localStorage,byId:s.byId,P:s.P,today:s.C.today,statusKeys:s.K.PERSONAL_KEYS,canonicalId:s.K.canonicalId});
const visit=(s,id,activity='mpe',extra={})=>s.P.validateVisits({[id]:{activity,...extra}},s.byId)[id];
const code=expected=>error=>error.code===expected;

test('storage keys and the stored layout',()=>{
  const s=load({...base,favorites:['mpe'],age:2});
  assert.deepEqual(plain(s.store.KEYS),{family:'minitandem-family-v1',sync:'minitandem-sync-v1',corrections:'minitandem-pending-corrections-v1',filters:'minitandem-family-v1-filters',near:'minitandem-near-town-v1'});
  assert.deepEqual(plain(s.window.MinitandemStore.KEYS),plain(s.store.KEYS));
  s.store.personal.notes.mpe='a note';assert.equal(s.store.persist(),true);
  assert.deepEqual([...s.localStorage.map.keys()],[FAMILY],'saving writes the family record and nothing else');
  assert.deepEqual(Object.keys(s.localStorage.read(FAMILY)).sort(),['age','favorites','notes','origin','statuses','tracked','version','visits']);
  assert.equal(s.localStorage.read(FAMILY).version,1);
});

test('validateBackup rejects anything that is not a backup, with a code the page can word',()=>{
  const {store,I}=load();
  const good={...base};
  for(const bad of [null,undefined,'text',[],{},{...good,version:2},{...good,version:'1'},{...good,favorites:'mpe'},{...good,notes:null},{...good,notes:undefined},{...good,statuses:null},{version:1,favorites:[],notes:{}}]){
    assert.throws(()=>store.validateBackup(bad),code('backup.invalid'),JSON.stringify(bad));
  }
  assert.doesNotThrow(()=>store.validateBackup(good));
  for(const lang of I.LANGS)assert.ok(I.dictionaries[lang]['error.backup.invalid'],lang+': the error has wording');
});

test('validateBackup does not change what it is given and always returns the same shape',()=>{
  const {store}=load();
  const raw={...base,favorites:['mpe','nope'],notes:{mpe:'a'},extra:{secret:1}};
  const copy=JSON.stringify(raw);
  const result=store.validateBackup(raw);
  assert.equal(JSON.stringify(raw),copy);
  assert.deepEqual(Object.keys(result).sort(),['age','favorites','notes','origin','statuses','tracked','version','visits']);
  assert.equal(result.extra,undefined,'unknown fields are not carried into the profile');
});

test('unknown ids are dropped from favourites, notes, statuses, visits and tracked',()=>{
  const s=load(),{store,P,byId}=s,snapshot=P.snapshot(byId.get('mpe'),'2026-09-20');
  const result=store.validateBackup({...base,favorites:['mpe','no-such-card',7,null,'mpe'],notes:{mpe:'a','no-such-card':'b'},statuses:{mpe:'discuss','no-such-card':'booked'},
    visits:{'v-ok':{activity:'museum'},'v-bad':{activity:'no-such-card'}},tracked:{mpe:snapshot,'no-such-card':snapshot}});
  assert.deepEqual(plain(result.favorites),['mpe'],'also without duplicates');
  assert.deepEqual(Object.keys(result.notes),['mpe']);assert.deepEqual(Object.keys(result.statuses),['mpe']);
  assert.deepEqual(Object.keys(result.visits),['v-ok']);assert.deepEqual(Object.keys(result.tracked),['mpe']);
});

test('status values are checked against the known ones',()=>{
  const {store,K}=load();
  const statuses={mpe:'bogus',museum:'visited','swim-tentlingen':5,'krabbel-plaffeien':'skip',beo:'booked','beo-funpark':null};
  const result=store.validateBackup({...base,statuses}).statuses;
  assert.deepEqual(Object.keys(result).sort(),['krabbel-plaffeien','museum']);
  for(const value of K.PERSONAL_KEYS.filter(Boolean))assert.equal(store.validateBackup({...base,statuses:{mpe:value}}).statuses.mpe,value,value);
  assert.ok(K.PERSONAL_KEYS.length>=7,'the choices of the status menu');
});

test('notes are text only and are cut at 10000 characters',()=>{
  const {store}=load();
  const result=store.validateBackup({...base,notes:{mpe:'x'.repeat(12000),museum:'y'.repeat(10000),'swim-tentlingen':{text:'no'},'krabbel-plaffeien':42,beo:'kept'}}).notes;
  assert.equal(result.mpe.length,10000);assert.equal(result.museum.length,10000);
  assert.equal(result['swim-tentlingen'],undefined);assert.equal(result['krabbel-plaffeien'],undefined);
  assert.equal(store.validateBackup({...base,notes:{mpe:'  spaces and\nnew lines kept  '}}).notes.mpe,'  spaces and\nnew lines kept  ');
});

test('the age is a number from 0 to 18, otherwise it is forgotten',()=>{
  const {store}=load();
  for(const [age,expected] of [[0,0],[2.5,2.5],[3,3],[18,18],[-1,null],[-0.5,null],[18.5,null],[19,null],[120,null],['3',null],[null,null],[undefined,null],[NaN,null],[Infinity,null],[{},null],[[3],null]]){
    assert.equal(store.validateBackup({...base,age}).age,expected,String(age));
  }
});

test('the starting point is cleaned, and an absent one falls back to the current one',()=>{
  const {store}=load();
  assert.equal(store.validateBackup({...base}).origin,'');
  assert.equal(store.validateBackup({...base},'Plaffeien').origin,'Plaffeien','a backup that has no starting point keeps the current one');
  assert.equal(store.validateBackup({...base,origin:''},'Plaffeien').origin,'','an empty starting point in the file is a choice');
  assert.equal(store.validateBackup({...base,origin:'  Tafers\u0000\u0007 '},'x').origin,'Tafers','control characters and padding are removed');
  assert.equal(store.validateBackup({...base,origin:'a'.repeat(200)}).origin.length,80);
  assert.equal(store.validateBackup({...base,origin:12}).origin,'');assert.equal(store.validateBackup({...base,origin:{a:1}}).origin,'');
  assert.equal(store.cleanOrigin('\t Fribourg\n'),'Fribourg');
});

test('the old id of the MEMO music event leads to the dated event in favourites, notes, statuses, visits and tracked',()=>{
  const s=load(),{store,P,byId}=s,id='memo-musik-entdecken-2026-09-29',snapshot=P.snapshot(byId.get(id),'2026-09-28');
  assert.equal(s.K.canonicalId('memo-musik'),id);assert.equal(s.K.canonicalId('mpe'),'mpe');
  const result=store.validateBackup({...base,favorites:['memo-musik',id],notes:{'memo-musik':'ask about language'},statuses:{'memo-musik':'discuss'},
    visits:{'v-memo':{activity:'memo-musik',date:'2026-09-29'},'v-direct':{activity:id}},tracked:{'memo-musik':snapshot}});
  assert.deepEqual(plain(result.favorites),[id],'both spellings count as one favourite');
  assert.deepEqual(plain(result.notes),{[id]:'ask about language'});assert.deepEqual(plain(result.statuses),{[id]:'discuss'});
  assert.equal(result.visits['v-memo'].activity,id);assert.equal(result.visits['v-direct'].activity,id);
  assert.deepEqual(Object.keys(result.tracked),[id]);
});

test('tracked snapshots of another layout, with a bad date or with missing fields are dropped',()=>{
  const s=load(),{store,P,byId}=s,good=P.snapshot(byId.get('mpe'),'2026-09-20'),fields=good.fields;
  const without=key=>{const copy={...fields};delete copy[key];return copy;};
  const tracked={mpe:good,museum:{...P.snapshot(byId.get('museum'),'2026-09-20'),rev:1},'swim-tentlingen':{date:'2026-09-20',fields},
    'krabbel-plaffeien':{...good,date:'2026-02-30'},beo:{...good,fields:without('price')},'beo-funpark':{...good,fields:{...fields,events:7}},'memo-library':'text'};
  const result=store.validateBackup({...base,tracked}).tracked;
  assert.deepEqual(Object.keys(result),['mpe']);
  assert.deepEqual(plain(result.mpe),plain(good));
  const long=store.validateBackup({...base,tracked:{mpe:{...good,fields:{...fields,schedule:'s'.repeat(13000)}}}}).tracked;
  assert.equal(long.mpe.fields.schedule.length,12000);
  assert.deepEqual(plain(store.validateBackup({...base,tracked:[good]}).tracked),{});
});

test('a backup with more than 200 visits is refused as a whole',()=>{
  const {store,I}=load();
  const visits=Object.fromEntries(Array.from({length:201},(_,i)=>['v-'+i,{activity:'mpe'}]));
  assert.throws(()=>store.validateBackup({...base,visits}),code('visits.limit'));
  assert.equal(Object.keys(store.validateBackup({...base,visits:Object.fromEntries(Object.entries(visits).slice(0,200))}).visits).length,200);
  for(const lang of I.LANGS)assert.ok(I.dictionaries[lang]['error.visits.limit'],lang);
});

test('the stored profile is checked on load, with old ids and unknown cards cleaned up',()=>{
  const s=load({...base,favorites:['memo-musik','gone-card'],notes:{mpe:'kept','gone-card':'x'},age:30,origin:'Plaffeien'});
  assert.deepEqual(plain(s.store.personal.favorites),['memo-musik-entdecken-2026-09-29']);
  assert.deepEqual(plain(s.store.personal.notes),{mpe:'kept'});assert.equal(s.store.personal.age,null);assert.equal(s.store.personal.origin,'Plaffeien');
  assert.deepEqual(plain(s.store.baseline),plain(s.store.personal));assert.notEqual(s.store.baseline,s.store.personal);
  s.store.personal.notes.mpe='changed';assert.equal(s.store.baseline.notes.mpe,'kept','the baseline is a separate copy');
  assert.equal(s.store.persist(),true);
  assert.deepEqual(plain(s.localStorage.read(FAMILY).notes),{mpe:'changed'},'the next save drops what the catalogue no longer has');
  assert.equal(s.store.storageAvailable,true);
});

test('an empty browser starts with an empty profile',()=>{
  const {store}=load();
  assert.deepEqual(plain(store.personal),plain(store.emptyPersonal()));assert.equal(store.storageAvailable,true);
  assert.equal(store.hasFamilyData(store.personal),false);
});

test('unreadable stored data leaves an empty profile and a storage that is reported as unavailable',()=>{
  for(const raw of ['not json at all','{"version":2,"favorites":[]}','[]']){
    const s=loadStack({local:{[FAMILY]:raw}});
    assert.equal(s.store.storageAvailable,false,raw);assert.deepEqual(plain(s.store.personal),plain(s.store.emptyPersonal()));
  }
  const refusing={getItem(){throw new DOMException('Denied','SecurityError');},setItem(){},removeItem(){}};
  const s=loadStack();
  const store=s.window.MinitandemStore.create({storage:refusing,byId:s.byId,P:s.P,today:s.C.today,statusKeys:s.K.PERSONAL_KEYS});
  assert.equal(store.storageAvailable,false);assert.equal(store.persist(),false);
});

test('a storage in the page memory only (the page\'s stand-in for a refused browser storage) is never reported as available',()=>{
  // app.js gives the store such a stand-in when the browser refuses localStorage: it works, but nothing survives a reload.
  const s=loadStack(),map=new Map();
  const memoryOnly={memoryOnly:true,getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,String(v));},removeItem:k=>{map.delete(k);}};
  const store=s.window.MinitandemStore.create({storage:memoryOnly,byId:s.byId,P:s.P,today:s.C.today,statusKeys:s.K.PERSONAL_KEYS});
  assert.equal(store.storageAvailable,false,'the data dialog says the browser cannot save, not that it can');
  store.personal.notes.mpe='kept on the page';
  assert.equal(store.persist(),false,'a save into it reads like a failed one, so the page says the records last only until it is closed or reloaded');
  assert.equal(store.storageAvailable,false);
  assert.equal(store.personal.notes.mpe,'kept on the page','the page keeps the records meanwhile');
  assert.equal(JSON.parse(map.get(FAMILY)).notes.mpe,'kept on the page');
  const app=fs.readFileSync(new URL('app.js',import.meta.url),'utf8');
  assert.match(app,/catch \{ return \{memoryOnly: true, getItem:/,'the page marks its stand-in');
});

test('persist merges this tab with an unseen update from another tab',()=>{
  const s=load({...base,favorites:['mpe'],notes:{mpe:'first'},statuses:{},age:2,origin:'Plaffeien'});
  const other=openTab(s);
  // The other tab: a new favourite, a note, a status, a different age and starting point.
  other.personal.favorites.push('museum');other.personal.notes.museum='from the other tab';other.personal.statuses['swim-tentlingen']='contact';other.personal.age=3;other.personal.origin='Tafers';
  assert.equal(other.persist(),true);
  // This tab did not see that; it saves its own new favourite and note.
  s.store.personal.favorites.push('krabbel-plaffeien');s.store.personal.notes['krabbel-plaffeien']='from this tab';
  assert.equal(s.store.persist(),true);
  const saved=s.localStorage.read(FAMILY);
  assert.deepEqual(plain(saved.favorites).sort(),['krabbel-plaffeien','mpe','museum']);
  assert.equal(saved.notes.museum,'from the other tab');assert.equal(saved.notes['krabbel-plaffeien'],'from this tab');assert.equal(saved.notes.mpe,'first');
  assert.equal(saved.statuses['swim-tentlingen'],'contact');
  assert.equal(saved.age,3,'a field this tab never touched keeps the other tab\'s value');assert.equal(saved.origin,'Tafers');
  assert.deepEqual(plain(s.store.personal),plain(saved),'and this tab now shows the merged result');
  assert.deepEqual(plain(s.store.baseline),plain(saved));
});

test('a field edited in this tab wins over a stored value, and only that field',()=>{
  const s=load({...base,favorites:['mpe','museum'],notes:{mpe:'one',museum:'two'},age:2});
  const other=openTab(s);other.personal.notes.mpe='other tab';other.personal.notes.museum='other tab too';other.personal.age=4;assert.equal(other.persist(),true);
  s.store.personal.notes.mpe='this tab';assert.equal(s.store.persist(),true);
  const saved=s.localStorage.read(FAMILY);
  assert.equal(saved.notes.mpe,'this tab');assert.equal(saved.notes.museum,'other tab too');assert.equal(saved.age,4);
});

test('a removed favourite is not resurrected from stale storage, and another tab does not bring it back',()=>{
  const s=load({...base,favorites:['mpe','museum'],age:2});
  const stale=openTab(s);                       // opened before the removal, never refreshed
  s.store.personal.favorites=s.store.personal.favorites.filter(id=>id!=='mpe');
  assert.equal(s.store.persist(),true);
  assert.deepEqual(plain(s.localStorage.read(FAMILY).favorites),['museum']);
  stale.personal.favorites.push('krabbel-plaffeien');
  assert.equal(stale.persist(),true);
  assert.deepEqual(plain(s.localStorage.read(FAMILY).favorites).sort(),['krabbel-plaffeien','museum'],'the stale tab added one card and did not touch mpe');
  assert.deepEqual(plain(stale.personal.favorites).sort(),['krabbel-plaffeien','museum']);
  // After a reload this tab sees the other tab's card and can remove another one.
  s.store.reload();
  s.store.personal.favorites=s.store.personal.favorites.filter(id=>id!=='museum');
  assert.equal(s.store.persist(),true);
  assert.deepEqual(plain(s.localStorage.read(FAMILY).favorites),['krabbel-plaffeien']);
});

test('removing a favourite and a note in one tab reaches storage; clearing the age is saved as unknown',()=>{
  const s=load({...base,favorites:['mpe'],notes:{mpe:'keep'},age:2});
  s.store.personal.favorites=[];s.store.personal.notes.mpe='';s.store.personal.age=null;
  assert.equal(s.store.persist(),true);
  const saved=s.localStorage.read(FAMILY);
  assert.deepEqual(saved.favorites,[]);assert.equal(saved.notes.mpe,'');assert.equal(saved.age,null);
});

test('persist with overrides: an explicit import replaces the age and starting point even when equal to what this tab had',()=>{
  const s=load({...base,favorites:['mpe'],notes:{mpe:'mine'},age:2,origin:'Plaffeien'});
  const other=openTab(s);other.personal.age=3;other.personal.origin='Tafers';assert.equal(other.persist(),true);
  // Without an import, this tab's unchanged age does not undo the other tab's.
  assert.equal(s.store.persist(),true);assert.equal(s.localStorage.read(FAMILY).age,3);
  // An import of a backup with the same age this tab started with: the file wins.
  const fresh=load({...base,favorites:['mpe'],notes:{mpe:'mine'},age:2,origin:'Plaffeien'});
  const second=openTab(fresh);second.personal.age=3;second.personal.origin='Tafers';assert.equal(second.persist(),true);
  const imported=fresh.store.validateBackup({...base,favorites:['museum'],notes:{museum:'imported'},statuses:{museum:'booked'},age:2,origin:''});
  assert.equal(fresh.store.persist(imported),true);
  const saved=fresh.localStorage.read(FAMILY);
  assert.equal(saved.age,2);assert.equal(saved.origin,'');
  assert.deepEqual(plain(saved.favorites).sort(),['mpe','museum'],'imported favourites are added to the existing ones');
  assert.equal(saved.notes.museum,'imported');assert.equal(saved.notes.mpe,'mine','notes of other cards stay');assert.equal(saved.statuses.museum,'booked');
  assert.ok(saved.tracked.museum,'an imported favourite gets its baseline');
});

test('a backup without a starting point keeps the starting point when it is imported',()=>{
  const s=load({...base,favorites:['mpe'],age:2,origin:'Plaffeien'});
  const imported=s.store.validateBackup({...base,notes:{mpe:'imported'},age:2},s.store.personal.origin);
  assert.equal(s.store.persist(imported),true);
  assert.equal(s.localStorage.read(FAMILY).origin,'Plaffeien');assert.equal(s.localStorage.read(FAMILY).notes.mpe,'imported');
});

test('every saved card gets a baseline snapshot of today, and old-layout baselines are replaced',()=>{
  const old={date:'2026-09-20',fields:{price:'Old price text',schedule:'x'}};
  const s=load({...base,favorites:['mpe','museum'],tracked:{mpe:old}});
  assert.deepEqual(plain(s.store.personal.tracked),{},'a baseline of another layout is dropped on load');
  s.store.personal.favorites.push('krabbel-plaffeien');
  assert.equal(s.store.persist(),true);
  const saved=s.localStorage.read(FAMILY);
  assert.deepEqual(Object.keys(saved.tracked).sort(),['krabbel-plaffeien','mpe','museum']);
  for(const id of ['mpe','museum','krabbel-plaffeien']){
    assert.equal(saved.tracked[id].rev,2,id);assert.equal(saved.tracked[id].date,'2026-10-14',id);
    assert.deepEqual(plain(saved.tracked[id]),plain(s.P.snapshot(s.byId.get(id),'2026-10-14')),id);
    assert.equal(s.P.changes(s.byId.get(id),saved.tracked[id]).length,0,id+': a fresh baseline reports nothing');
  }
  // An existing baseline is kept as it is, so the comparison keeps its original date.
  s.store.personal.tracked.mpe=s.P.snapshot(s.byId.get('mpe'),'2026-09-20');
  assert.equal(s.store.persist(),true);assert.equal(s.localStorage.read(FAMILY).tracked.mpe.date,'2026-09-20');
  assert.equal(s.localStorage.read(FAMILY).tracked.museum.date,'2026-10-14');
  // Cards that are not saved have none.
  assert.equal(s.localStorage.read(FAMILY).tracked.beo,undefined);
});

test('the visit limit: 200 visits are stored, 201 are refused and storage stays as it was',()=>{
  const s=load({...base,favorites:['mpe']});
  for(let i=0;i<200;i++)s.store.personal.visits['v-'+i]=visit(s,'v-'+i);
  assert.equal(s.store.persist(),true);
  assert.equal(Object.keys(s.localStorage.read(FAMILY).visits).length,200);
  const before=s.localStorage.map.get(FAMILY);
  s.store.personal.visits['v-200']=visit(s,'v-200');
  assert.equal(s.store.persist(),false);
  assert.equal(s.localStorage.map.get(FAMILY),before,'the stored profile is not touched');
  assert.equal(Object.keys(s.store.personal.visits).length,201,'the page still has the visit the visitor just made');
  assert.equal(Object.keys(s.store.baseline.visits).length,200,'and it stays unsaved');
});

test('the visit limit also applies to the sum of two tabs',()=>{
  const s=load({...base,favorites:['mpe']});
  const other=openTab(s);
  for(let i=0;i<150;i++)other.personal.visits['v-o'+i]=visit(s,'v-o'+i);
  assert.equal(other.persist(),true);
  for(let i=0;i<60;i++)s.store.personal.visits['v-t'+i]=visit(s,'v-t'+i);
  const before=s.localStorage.map.get(FAMILY);
  assert.equal(s.store.persist(),false);assert.equal(s.localStorage.map.get(FAMILY),before);
});

test('blocked storage: persist returns false, storage is reported unavailable, the page keeps the data and a later save succeeds',()=>{
  const s=load({...base,favorites:['mpe'],age:2}),before=s.localStorage.map.get(FAMILY);
  s.localStorage.blockWrites(true);
  s.store.personal.notes.mpe='typed while storage is full';
  assert.equal(s.store.persist(),false);
  assert.equal(s.store.storageAvailable,false);
  assert.equal(s.localStorage.map.get(FAMILY),before);
  assert.equal(s.store.personal.notes.mpe,'typed while storage is full');
  s.localStorage.blockWrites(false);
  assert.equal(s.store.persist(),true);assert.equal(s.store.storageAvailable,true);
  assert.equal(s.localStorage.read(FAMILY).notes.mpe,'typed while storage is full');
});

test('onSaved runs after a successful save only',()=>{
  const s=load({...base,favorites:['mpe']});let saved=0;
  const store=s.window.MinitandemStore.create({storage:s.localStorage,byId:s.byId,P:s.P,today:s.C.today,statusKeys:s.K.PERSONAL_KEYS,canonicalId:s.K.canonicalId,onSaved:()=>{saved++;}});
  store.personal.notes.mpe='a';assert.equal(store.persist(),true);assert.equal(saved,1);
  s.localStorage.blockWrites(true);store.personal.notes.mpe='b';assert.equal(store.persist(),false);assert.equal(saved,1);
});

test('reload adopts what another tab stored and makes it the new baseline',()=>{
  const s=load({...base,favorites:['mpe'],notes:{mpe:'first'},age:2});
  const other=openTab(s);other.personal.favorites.push('museum');other.personal.notes.mpe='second';other.personal.age=5;assert.equal(other.persist(),true);
  const adopted=s.store.reload();
  assert.equal(adopted,s.store.personal);
  assert.deepEqual(plain(s.store.personal.favorites).sort(),['mpe','museum']);assert.equal(s.store.personal.notes.mpe,'second');assert.equal(s.store.personal.age,5);
  assert.deepEqual(plain(s.store.baseline),plain(s.store.personal));
  const stored=s.localStorage.map.get(FAMILY);
  assert.equal(s.store.persist(),true);
  assert.deepEqual(plain(s.localStorage.read(FAMILY)),JSON.parse(stored),'saving straight after a reload changes nothing');
  // The other tab clears everything: an empty profile is adopted.
  s.localStorage.removeItem(FAMILY);s.store.reload();
  assert.deepEqual(plain(s.store.personal),plain(s.store.emptyPersonal()));
});

test('reload refuses unreadable data and keeps what the page has',()=>{
  const s=load({...base,favorites:['mpe'],age:2});
  s.localStorage.setItem(FAMILY,'{broken');
  assert.throws(()=>s.store.reload());
  assert.deepEqual(plain(s.store.personal.favorites),['mpe']);
});

test('writeProfile stores a profile and makes it the baseline',()=>{
  const s=load();
  const profile=s.store.validateBackup({...base,favorites:['museum'],notes:{museum:'from the service'},age:3});
  s.store.writeProfile(profile);
  assert.deepEqual(plain(s.localStorage.read(FAMILY)),plain(profile));
  assert.equal(s.store.personal,profile);assert.deepEqual(plain(s.store.baseline),plain(profile));assert.notEqual(s.store.baseline,s.store.personal);
});

test('hasFamilyData ignores the age, the starting point and baselines',()=>{
  const {store,P,byId}=load();
  const profile=overrides=>({...store.emptyPersonal(),...overrides});
  assert.equal(store.hasFamilyData(profile({age:3,origin:'Plaffeien',tracked:{mpe:P.snapshot(byId.get('mpe'),'2026-09-20')}})),false);
  assert.equal(store.hasFamilyData(profile({favorites:['mpe']})),true);
  assert.equal(store.hasFamilyData(profile({notes:{mpe:'x'}})),true);
  assert.equal(store.hasFamilyData(profile({statuses:{mpe:'discuss'}})),true);
  assert.equal(store.hasFamilyData(profile({visits:{'v-one':{activity:'mpe'}}})),true);
});

test('corrections waiting for the service survive a round trip and a damaged record',()=>{
  const s=load(),report=(activity,message)=>({type:'vmeste-correction',version:1,activity,topic:'Schedule',message,source:'',date:'2026-10-14'});
  assert.deepEqual(plain(s.store.pendingCorrections()),[]);
  const queue=[report('mpe','Opening hours changed'),report('museum','New price')];
  s.store.setPendingCorrections(queue);
  assert.deepEqual(plain(s.store.pendingCorrections()),plain(queue));
  assert.deepEqual(plain(s.localStorage.read(s.store.KEYS.corrections)),plain(queue));
  s.store.setPendingCorrections(queue.slice(1));assert.deepEqual(plain(s.store.pendingCorrections()),[queue[1]]);
  s.store.setPendingCorrections([]);assert.deepEqual(plain(s.store.pendingCorrections()),[]);
  for(const damaged of ['{broken','{"a":1}','"text"','null','42']){s.localStorage.setItem(s.store.KEYS.corrections,damaged);assert.deepEqual(plain(s.store.pendingCorrections()),[],damaged);}
});

test('the service connection is stored on its own and ignores a damaged record',()=>{
  const s=load(),config={url:'https://family.example.ch',token:'t'.repeat(40),revision:3,dirty:true};
  assert.equal(s.store.loadSync(),null);
  s.store.saveSync(config);assert.deepEqual(plain(s.store.loadSync()),config);assert.deepEqual(plain(s.localStorage.read(s.store.KEYS.sync)),config);
  s.store.saveSync(null);assert.equal(s.store.loadSync(),null);assert.equal(s.localStorage.map.has(s.store.KEYS.sync),false);
  for(const damaged of ['{broken','{"url":"https://family.example.ch"}','{"token":"x"}','[]','"text"']){s.localStorage.setItem(s.store.KEYS.sync,damaged);assert.equal(s.store.loadSync(),null,damaged);}
  s.localStorage.blockWrites(true);assert.doesNotThrow(()=>s.store.saveSync(config),'a full storage does not break the page');
});

test('a stored profile that is not JSON is replaced on the next save, one of an unknown version is never overwritten',()=>{
  const broken=loadStack({local:{[FAMILY]:'{broken'}});
  assert.equal(broken.store.storageAvailable,false);
  broken.store.personal.notes.mpe='fresh start';
  assert.equal(broken.store.persist(),true,'an unreadable profile cannot be merged and is replaced');
  assert.equal(broken.store.storageAvailable,true);
  assert.equal(broken.localStorage.read(FAMILY).notes.mpe,'fresh start');
  const future=loadStack({local:{[FAMILY]:{version:2,favorites:[],notes:{},statuses:{}}}});
  future.store.personal.notes.mpe='x';
  assert.equal(future.store.persist(),false,'a profile written by a newer version is left alone');
  assert.equal(future.localStorage.read(FAMILY).version,2);
});
test('reaching the visit limit is not reported as unavailable storage',()=>{
  const s=load({...base});
  const visits={};for(let i=0;i<201;i++)visits['v-'+i]=visit(s,'v-'+i);
  s.store.personal.visits=visits;
  assert.equal(s.store.persist(),false);
  assert.equal(s.store.storageAvailable,true,'the storage works; the plan is simply too large');
});
