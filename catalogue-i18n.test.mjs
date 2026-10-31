// German and French card texts: the unit and digest of catalogue-i18n.js, the generated data-de.js and data-fr.js, how the page shows
// a translation, falls back to English per card, searches both languages and says when cards are shown in English.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {loadStack,root} from './test-support.mjs';
import {translationsFolder,compile,english,LANGS} from './scripts/compile-catalogue-i18n.mjs';

const plain=value=>JSON.parse(JSON.stringify(value));
const sha=text=>createHash('sha256').update(text).digest('hex');
// The generated files, read the way the page reads them.
const files=(()=>{const context={window:{}};for(const lang of LANGS)vm.runInNewContext(fs.readFileSync(path.join(root,`data-${lang}.js`),'utf8'),context);return context.window.MINITANDEM_CARDS;})();
// A stack of the real modules with one language's card texts over the cards, wired as app.js wires them.
function translated(lang,{data=files[lang],cards=null}={}){
  const S=loadStack({lang});
  const all=cards||S.records,CI=S.window.MinitandemCatalogueI18n,order=S.window.MinitandemViews.PRACTICAL_ORDER;
  const shown=CI.overlay(all,data,order);
  S.C.setLocalText(shown.text);
  const V=S.window.MinitandemViews.create({t:S.t,C:S.C,P:S.P,X:S.X,F:S.F,store:S.store,state:()=>S.state,shown:shown.card,inEnglish:a=>!shown.translated(a),lang:S.I.lang});
  return {...S,CI,order,shown,V};
}
const PRIVATE_FOLDER=translationsFolder();
const PRIVATE_SKIP=PRIVATE_FOLDER?false:'private-only: the translation records are not present (set MINITANDEM_TRANSLATIONS or .translations-path)';

test('sha256 of catalogue-i18n.js equals Node’s for any text, including the block boundaries and characters outside the BMP',()=>{
  const {CI}=translated('de');
  for(const text of ['','abc','a'.repeat(55),'a'.repeat(56),'a'.repeat(63),'a'.repeat(64),'a'.repeat(65),'Grüezi « Fribourg » 😀'.repeat(40),'\u00a0:\u00a0;'])
    assert.equal(CI.sha256(text),sha(text),JSON.stringify(text.slice(0,20)));
});

test('a unit lists every shown text by path, in the order of the translation pipeline, and its digest covers exactly those strings',()=>{
  const {CI,order}=translated('de');
  const card={id:'x',name:'Name',town:'Various places',intro:' ',parentDetails:'With a parent',age:'2–4 years',schedule:'Mon 09:00',price:'CHF 5',address:'Weg 1',
    events:[{date:'2026-10-20',title:'Autumn',address:'Weg 1'},{date:'2026-10-21',address:'Other 2'}],notes:['One','',"Two"],
    practical:{costNote:{text:'Cost'},indoor:{text:'Inside'},scenario:'visit',warnings:['Warn'],tariff:{note:'Tariff'},photo:{alt:'Alt',caption:'Caption'}},
    research:{findings:[{field:'Field',text:'Found'}],remaining:['Ask']},contacts:[{name:'Office',phone:'026 000 00 00'}],sources:[{label:'Site',url:'https://example.org/'}]};
  const strings=CI.unitStrings(card,order);
  assert.deepEqual(Object.keys(strings),['name','town','parentDetails','age','schedule','price','address','events[0].title','events[1].address','notes[0]','notes[2]',
    'practical.indoor.text','practical.costNote.text','practical.warnings[0]','practical.tariff.note','practical.photo.alt','practical.photo.caption',
    'research.findings[0].field','research.findings[0].text','research.remaining[0]','contacts[0].name','sources[0].label']);
  assert.equal(CI.unitStrings({...card,town:'Plaffeien'},order).town,undefined,'a real town name is not translated');
  assert.equal(CI.revision(card,order),sha(JSON.stringify(plain(strings))));
});

test('the unit and the digest are those of the translation records for every card in both languages',{skip:PRIVATE_SKIP},t=>{
  const {cards,CI,order}=english();
  for(const lang of LANGS){
    const {data,report}=compile(PRIVATE_FOLDER,lang);
    assert.deepEqual(report.unmapped,[],lang);assert.deepEqual(report.invalid,[],lang);
    let changedSince=0,behind=0;
    for(const card of cards){
      const record=JSON.parse(fs.readFileSync(path.join(PRIVATE_FOLDER,lang,card.id+'.json'),'utf8'));
      // The same English gives the same paths, strings and digest as the pipeline. A card whose English changed after its translation
      // (an approved update, for example) is allowed to differ: the page shows it in English until it is translated again.
      if(CI.revision(card,order)===record.revision)assert.deepEqual(plain(CI.unitStrings(card,order)),record.unit.strings,`${lang} ${card.id}: paths and English strings`);
      else changedSince++;
      // The generator keeps the checked translations byte for byte (the French no-break spaces included).
      assert.equal(data[card.id].rev,record.revision);
      assert.deepEqual(plain(data[card.id].strings),record.result.translations,`${lang} ${card.id}: generated strings`);
      if(files[lang][card.id]?.rev!==record.revision||JSON.stringify(files[lang][card.id]?.strings)!==JSON.stringify(record.result.translations))behind++;
    }
    // The committed file is regenerated by hand after a translation pass; until then it may lag behind the records. Reported, not failed.
    t.diagnostic(`${lang}: ${changedSince} cards changed in English since translation; data-${lang}.js differs from the records on ${behind} cards`+(behind?' (run node scripts/compile-catalogue-i18n.mjs)':''));
  }
});

test('data-de.js and data-fr.js hold only a digest and strings per card, cover the catalogue and keep the French typography',()=>{
  const {records}=loadStack();
  for(const lang of LANGS){
    assert.deepEqual(Object.keys(files[lang]).sort(),plain(records.map(a=>a.id)).sort(),lang);
    for(const [id,entry] of Object.entries(files[lang])){
      assert.deepEqual(Object.keys(entry),['rev','strings'],`${lang} ${id}`);
      assert.match(entry.rev,/^[0-9a-f]{64}$/);
      for(const text of Object.values(entry.strings))assert.ok(typeof text==='string'&&text.trim()&&!/[\u0400-\u04FF]/.test(text),`${lang} ${id}`);
    }
    const raw=fs.readFileSync(path.join(root,`data-${lang}.js`),'utf8');
    assert.ok(!/translator|checker|arbiter|corrections|flags|reason|findings"\s*:\s*\[\{"by"/.test(raw.replace(/"research\.findings\[\d+\]\.(?:field|text)"/g,'')),lang+': no check records or model notes');
  }
  const fr=fs.readFileSync(path.join(root,'data-fr.js'));
  assert.ok(fr.includes(Buffer.from('\u00a0:','utf8'))&&fr.includes(Buffer.from('«\u00a0','utf8')),'literal no-break spaces before : and inside « »');
  assert.ok(!fr.includes('\\u00a0'),'written as characters, not escapes');
  assert.ok(!Object.values(files.fr).some(entry=>Object.values(entry.strings).some(text=>/ [:;?!](?!\/)|« | »/.test(text.replace(/https?:\/\/\S+/g,'')))),'no ordinary space where French needs a no-break space');
  assert.ok(!Object.values(files.de).some(entry=>Object.values(entry.strings).some(text=>/ß/.test(text))),'Swiss German: no sharp s');
});

test('the overlay shows every translated string at its path on a copy; the English card is untouched and stays reachable',()=>{
  const {CI,order}=translated('de');
  const card={id:'c',name:'Garden · open morning',town:'Plaffeien',intro:'A garden.',age:'Age to be confirmed',schedule:'Wednesday 09:00',price:'Free',address:'Weg 1',
    events:[{date:'2026-10-20',title:'Autumn walk',address:'Other 2'}],notes:['Bring boots.'],practical:{indoor:{text:'Outside',value:false},warnings:['Mud']},
    research:{findings:[{field:'Dates',text:'Published.'}],remaining:['Ask about rain.']},contacts:[{name:'Office',phone:'026 000 00 00'}],sources:[{label:'Site',url:'https://example.org/'}]};
  const de=Object.fromEntries(Object.entries(CI.unitStrings(card,order)).map(([key,text])=>[key,'DE '+text]));
  const shown=CI.overlay([card],{c:{rev:CI.revision(card,order),strings:{...de,'notes[5]':'Nowhere','practical.indoor.value':'x'}}},order);
  const copy=shown.card(card);
  assert.notEqual(copy,card);assert.equal(shown.card(copy),copy,'idempotent');
  assert.equal(copy.name,'DE Garden · open morning');assert.equal(copy.events[0].title,'DE Autumn walk');assert.equal(copy.events[0].address,'DE Other 2');
  assert.equal(copy.notes[0],'DE Bring boots.');assert.equal(copy.practical.indoor.text,'DE Outside');assert.equal(copy.practical.indoor.value,false);
  assert.equal(copy.practical.warnings[0],'DE Mud');assert.equal(copy.research.remaining[0],'DE Ask about rain.');assert.equal(copy.contacts[0].name,'DE Office');
  assert.equal(copy.contacts[0].phone,'026 000 00 00');assert.equal(copy.sources[0].label,'DE Site');assert.equal(copy.town,'Plaffeien');
  assert.equal(card.name,'Garden · open morning','the English card is not changed');
  assert.equal(copy.english,card);assert.ok(!Object.keys(copy).includes('english'),'not an enumerable field');
  assert.deepEqual(plain(shown.unmapped),['c notes[5]','c practical.indoor.value'],'paths the card does not show are ignored and reported');
  assert.equal(shown.translated(card),true);assert.match(shown.text(card),/DE Bring boots\./);
});

test('stale fallback: a card whose English changed after translation is shown in English, and only that card',()=>{
  const {records,CI,order}=translated('de');
  const cards=structuredClone(records.filter(a=>a.status==='active').slice(0,3));
  cards[1].notes=[...cards[1].notes,'An approved update added this note.'];
  const {V,shown,t,C}=translated('de',{cards});
  assert.deepEqual(plain(shown.stale),[cards[1].id]);
  assert.equal(shown.translated(cards[0]),true);assert.equal(shown.translated(cards[1]),false);assert.equal(shown.translated(cards[2]),true);
  assert.equal(shown.card(cards[1]),cards[1],'the stale card is the English one');
  assert.equal(shown.card(cards[0]).name,files.de[cards[0].id].strings.name);
  const english=V.detail(cards[1]),german=V.detail(cards[0]);
  assert.ok(english.includes(V.esc(t('card.inEnglish'))),'the card page says it is shown in English');
  assert.ok(english.includes(V.esc(cards[1].name).replace(/ · /g,'\u00a0· ')));
  assert.ok(!german.includes(V.esc(t('card.inEnglish'))));
  assert.equal(CI.revision(records.find(a=>a.id===cards[0].id),order),files.de[cards[0].id].rev);
  assert.ok(C);
});

test('the shown language reaches the list row, the card page, the week view, the map list and the dialogs; logic keeps the English card',()=>{
  for(const lang of LANGS){
    const {V,shown,byId,C,state,list,t,records,CI,order}=translated(lang);
    // Every card is either shown translated or explained: its English changed after translation (another digest), or it has no entry.
    assert.equal(shown.count+shown.stale.length+shown.missing.length,records.length,lang);
    for(const id of shown.stale)assert.notEqual(CI.revision(byId.get(id),order),files[lang][id].rev,lang+' '+id);
    assert.ok(shown.count>records.length/2,lang+': most cards are current');
    const card=['aef-attalens',...records.map(a=>a.id)].map(id=>byId.get(id)).find(a=>shown.translated(a)&&a.intro&&a.notes.length&&a.research?.remaining?.length&&a.sources.length&&a.address);
    const strings=files[lang][card.id].strings,esc=V.esc;
    assert.ok(V.row(card).includes(V.nm(strings.name)),lang+' row');
    const page=V.detail(card);
    for(const key of ['intro','schedule','notes[0]','research.remaining[0]','sources[0].label'])assert.ok(page.includes(esc(strings[key])),`${lang} card page: ${key}`);
    assert.ok(!page.includes(esc(card.intro)),lang+': the English intro is not shown');
    assert.ok(page.includes(encodeURIComponent(card.address)),lang+': directions use the address as published');
    state.view='week';
    // A card with a dated session in the test week shows its translated name there.
    const days=C.week(list(),state.f),html=V.week(days),session=days.flatMap(d=>d.sessions).map(s=>s.a).find(a=>shown.translated(a)&&shown.card(a).name!==a.name);
    assert.ok(session,lang+': a translated card has a session this week');
    assert.ok(html.includes(V.nm(shown.card(session).name)),lang+' week view');
    assert.notEqual(shown.card(session).name,session.name);
    assert.ok(V.mapBox([card]).includes(esc(strings.name)),lang+' map list');
    assert.ok(V.report(card,false).body.includes(esc(strings.name)),lang+' correction dialog');
    // Saved cards are compared in English, so changing the language never looks like a change.
    assert.deepEqual(plain(S_changes(card)),[]);
    assert.ok(t('cards.english',{n:2}).length>0);
  }
  function S_changes(card){const {P}=loadStack();return P.changes(card,P.snapshot(card,'2026-10-14'));}
});

test('search finds a card by the shown language and by the English',()=>{
  const {state,list,shown,byId}=translated('fr');
  const card=byId.get('aef-attalens'),fr=files.fr['aef-attalens'].strings.intro;
  // A French word of the intro that the English card does not contain (its French category name included).
  const plainStack=loadStack({lang:'fr'}),english=plainStack.C.searchText(plainStack.byId.get('aef-attalens'));
  const word=fr.split(/[\s,.;:’'()«»\u00a0]+/).find(w=>w.length>6&&!english.includes(plainStack.C.norm(w)));
  assert.ok(word,'a French-only word');
  state.f.query=word;
  assert.ok(list().some(a=>a.id==='aef-attalens'),'found by '+word);
  state.f.query='parenting topics';
  assert.ok(list().some(a=>a.id==='aef-attalens'),'and by its English text');
  // Without the French texts the French word finds nothing of this card.
  plainStack.state.f.query=word;
  assert.ok(!plainStack.list().some(a=>a.id==='aef-attalens'));
  assert.ok(shown.translated(card));
});

test('the English-only notice is gone; a short note names the cards shown in English, in three languages',()=>{
  const {window:W}=loadStack();
  const D=W.MINITANDEM_STRINGS;
  for(const lang of ['en','de','fr']){
    assert.equal(D[lang]['intro.contentEnglish'],undefined,lang);
    assert.match(D[lang]['cards.english_one'],/\{n\}/);assert.match(D[lang]['cards.english_other'],/\{n\}/);assert.ok(D[lang]['card.inEnglish']);
  }
  assert.ok(D.fr['cards.english_other'].includes('\u00a0:'));
  const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(index,/<p class="note" id="contentNote" hidden><\/p>/,'no fixed text: app.js fills it only when cards fall back to English');
  const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  assert.match(app,/cards\.filter\(inEnglish\)\.length/);
  assert.match(app,/script\.src = `data-\$\{lang\}\.js`/,'only the chosen language is loaded, from this site');
});

test('a finding headed by the name of a card field shows the interface label for that field, also where a translation rendered the name',()=>{
  const {window:W}=loadStack(),V=W.MinitandemViews;
  assert.equal(V.fieldLabel('parentDetails'),'fact.parent');assert.equal(V.fieldLabel('practical.playArea'),'practical.playArea');
  assert.equal(V.fieldLabel('events'),'dates.title');assert.equal(V.fieldLabel('schedule'),'fact.schedule');
  for(const heading of ['Team','Payment terms','Schedule','practical.nothing','constructor','toString',undefined])assert.equal(V.fieldLabel(heading),'',String(heading));
  const heads=page=>[...page.matchAll(/<span class="ff"[^>]*>([^<]*)<\/span>/g)].map(m=>m[1]);
  // A card of the catalogue with two findings, headed here by two field names; its German text renders one of them word by word.
  const {records,CI,order}=translated('de');
  const card=structuredClone(records.find(a=>a.status==='active'&&a.research?.findings?.length>=2&&a.research.findings.every(f=>f.text)));
  card.research.findings[0].field='parentDetails';card.research.findings[1].field='practical.playArea';
  const english=loadStack().V.detail(card),D=W.MINITANDEM_STRINGS;
  assert.deepEqual(heads(english).slice(0,2),[D.en['fact.parent'],D.en['practical.playArea']]);
  const strings=Object.fromEntries(Object.entries(CI.unitStrings(card,order)).map(([key,text])=>[key,'DE '+text]));
  strings['research.findings[0].field']='Angaben zum Elternteil';
  const {V:german}=translated('de',{cards:[card],data:{[card.id]:{rev:CI.revision(card,order),strings}}});
  const page=german.detail(card);
  assert.deepEqual(heads(page).slice(0,2),[D.de['fact.parent'],D.de['practical.playArea']]);
  assert.ok(!page.includes('Angaben zum Elternteil')&&!page.includes('practical.playArea<'));
  // A card shown in English under the German interface: the label is German and says so.
  const {V:fallback}=translated('de',{cards:[card],data:{}});
  assert.match(fallback.detail(card),new RegExp(`<span class="ff" lang="de">${D.de['fact.parent']}</span>`));
  // The real cards: no heading on a card page in any language, and none in research.md, is the name of a field.
  for(const lang of ['en',...LANGS]){
    const {V:view,records:all}=lang==='en'?{V:loadStack().V,records}:translated(lang);
    for(const a of all)for(const heading of heads(view.detail(a)))assert.ok(!V.fieldLabel(heading)&&!/^(?:Angaben zu[mr] (?:Elternteil|Begleitung)|Anlässe)$/.test(heading),`${lang} ${a.id}: ${heading}`);
  }
  const research=fs.readFileSync(path.join(root,'research.md'),'utf8');
  for(const [,heading] of research.matchAll(/^- \*\*(.+?)\*\* \(/gm))assert.equal(V.fieldLabel(heading),'',heading);
});
