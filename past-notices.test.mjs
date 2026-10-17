// A notice that names a date or a range of dates which is all over is not shown on the card (planning.js current, used by views.js shown).
// The reading of dates and the "still in force" rule are those of the editorial alarm (editorial/alarm.mjs), made stricter: this file
// pins both, line by line against the alarm's own classifier, and then the real cards in English, German and French.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {classifyLines,lineDates} from './editorial/alarm.mjs';
import {loadStack,root} from './test-support.mjs';
import {placePage} from './public-pages.mjs';

const files=(()=>{const context={window:{}};for(const lang of ['de','fr'])vm.runInNewContext(fs.readFileSync(path.join(root,`data-${lang}.js`),'utf8'),context);return context.window.MINITANDEM_CARDS;})();
const plain=value=>JSON.parse(JSON.stringify(value));
const NOW='2026-10-14T08:00:00.000Z',DAY='2026-10-14';
const P=loadStack({today:DAY}).P;

test('a clause is an obsolete notice only when a closure, cancellation or "next" word leads to dates that are all over and the notice is not still in force',()=>{
  const hidden=[
    'Closed 3–10 October 2026','Closed until 01.10.2026','Closed from 01.10.2026 to 05.10.2026','Closure: 5–9 October 2026','Closed on Tuesday 6 October 2026','Temporarily closed from 15.09.2026 until 01.10.2026',
    'The announced closure for works on 7–11.09.2026 has already ended.','The next published meeting is 15 October 2026'.replace('15 October','10 October'),
    'Geschlossen 3–10 Oktober 2026','Geschlossen bis 01.10.2026','Geschlossen am Dienstag, 6. Oktober 2026','Das nächste veröffentlichte Treffen ist am 10. Oktober 2026',
    'Fermé 3–10 octobre 2026',"Fermé jusqu'au 01.10.2026",'Fermeture temporaire du 15.09.2026 au 01.10.2026','La prochaine rencontre publiée a lieu le 10 octobre 2026',
    'Die nächsten veröffentlichten Termine sind am 2. und 9. Oktober 2026, 15:30–17:30','Les prochaines séances publiées ont lieu les 2 et 9 octobre 2026, de 15:30–17:30',
    'Holiday closure: 05.10.2026 and 06.10.2026'];
  const stays=[
    // The end is today or later.
    'Closed until 14.10.2026','Closed 5–18 October 2026','Closed until 01.11.2026','Geschlossen bis 01.11.2026','Fermé du 01.10.2026 au 01.12.2026','Closed from 01.10.2026 to 20.12.2026',
    // Still in force: since / from a past date, permanent, open-ended, a start without an end.
    'Closed since 01.10.2026','Closed from 01.10.2026','Permanently closed since 01.10.2026','Geschlossen seit 1. Oktober 2026','Seit dem 01.10.2026 dauerhaft geschlossen','Fermé depuis le 01.10.2026',
    'Fermé définitivement depuis le 01.10.2026','Closed since 01.10.2026 until further notice','Geschlossen seit 01.10.2026 bis auf Weiteres','The next season starts on 1 September 2026',
    // A day and month without a year may be a yearly closure; a bare year is no date; a future date among the past ones keeps the clause.
    'Closed 3–10 October','Closed on 25 December and 1 January','Fermé 03–10.10.','Closed since 2025','Closed in 2025','Closed 01.10.2026, reopening 01.12.2026','Geschlossen bis 01.10.2026 und vom 20.12.2026 bis 02.01.2027',
    // No closure or "next" word before the date, or the date comes first, or a standing weekday rule stands between.
    'On 28 September the pool is closed','Sonntag, 4. Oktober 2026: geschlossen','Registration required; start date 09.09.2026 is published','The page, updated on 24 March 2024, still gives the old hours',
    'Will there be meetings after 3 October 2026?','Closed on Mondays and 5–9 October 2026','Fermé le lundi et du 5 au 9 octobre 2026','Montags und vom 5.–9. Oktober 2026 geschlossen',
    // Far away from the word, or nothing dated at all.
    'Closed '+'x'.repeat(70)+' 10 October 2026','Closed on public holidays','Open from 09:00; next to the church'];
  assert.deepEqual(hidden.filter(line=>!P.pastNotice(line,DAY)),[],'hidden');
  assert.deepEqual(stays.filter(line=>P.pastNotice(line,DAY)),[],'stays');
});

test('the reading of dates and the "still in force" rule agree with the editorial alarm: what is hidden here the alarm drops as past, what the alarm keeps is kept here',()=>{
  const dropped=line=>classifyLines(line,{now:NOW})[0]?.dropped??null;
  const lines=[
    'Closed until 01.10.2026','Geschlossen bis 01.10.2026',"Fermé jusqu'au 01.10.2026",'Temporarily closed from 15.09.2026 until 01.10.2026','Vorübergehend geschlossen vom 15.09. bis 01.10.2026',
    'Fermeture temporaire du 15.09 au 01.10.2026',"Fermé depuis le 15.09.2026 jusqu'au 01.10.2026",'Closed from 01.10.2026 to 05.10.2026','Geschlossen ab 01.10.2026 bis 05.10.2026',
    'Permanently closed since 01.10.2026','Closed since 01.10.2026','Closed from 01.10.2026','Seit dem 01.10.2026 dauerhaft geschlossen','Geschlossen seit 1. Oktober','Geschlossen ab 01.10.2026',
    'Fermé définitivement depuis le 01.10.2026','Closed since 01.10.2026 until further notice','Geschlossen seit 01.10.2026 bis auf Weiteres',"Fermé depuis le 01.10.2026 jusqu'à nouvel avis",
    'Closed until 01.11.2026','Geschlossen bis 01.11.2026',"Fermé jusqu'au 01.11.2026",'Closed until 14.10.2026','Closed since 01.10.2026, reopening 01.12.2026','Fermé du 01.10.2026 au 01.12.2026',
    'Geschlossen bis 01.10.2026 und vom 20.12.2026 bis 02.01.2027','Closed since 2025','Saison 2025 beendet','Sonntag, 4. Oktober: geschlossen','Betriebsferien 5.10.-9.10.2026',
    'Holiday closure: 05.10.2026 and 06.10.2026','Sommerpause: 05.10., 06.10. und 07.10.2026','Fermeture annuelle du 05.10. au 09.10.2026'];
  for(const line of lines){
    const mine=P.pastNotice(line,DAY);
    // Never stricter the other way: a line the alarm still raises is never hidden here.
    if(mine)assert.equal(dropped(line),'past',line);
    if(dropped(line)===null)assert.equal(mine,false,line);
  }
  // Dates with a year read the same: a closure with an explicit end in the past is dropped by both.
  for(const line of ['Closed until 01.10.2026','Geschlossen bis 01.10.2026',"Fermé jusqu'au 01.10.2026",'Temporarily closed from 15.09.2026 until 01.10.2026',"Fermé depuis le 15.09.2026 jusqu'au 01.10.2026"]){
    assert.equal(P.pastNotice(line,DAY),true,line);assert.equal(dropped(line),'past',line);
  }
  // The days a text names, with a year, are the alarm's days.
  for(const line of ['Closed 3–10 October 2026','geschlossen vom 7. bis 11. september 2026','fermé du 7 au 11 septembre 2026','closed 16–21.11.2026 and 24.12.2026–05.01.2027','closed 05/10/2026','Geschlossen 01.10.26',
    'next meeting 1st Oct 2026'.replace('1st Oct','1 Oct')]){
    const key=line.toLowerCase();
    assert.deepEqual(plain(P.noticeDays(key).days.map(d=>d.day)).sort(),[...new Set(lineDates(key,new Date(NOW)).days)].sort(),line);
  }
});

test('one obsolete clause goes out of a text, with its separator, and the rest reads as before',()=>{
  const cut=text=>P.withoutPastNotices(text,DAY);
  assert.equal(cut('A staff member helps. Closed 3–10 October 2026; Sunday openings are not announced yet.'),'A staff member helps. Sunday openings are not announced yet.');
  assert.equal(cut('Une personne aide. Fermé 3–10 octobre 2026 ; les ouvertures du dimanche ne sont pas annoncées.'),'Une personne aide. Les ouvertures du dimanche ne sont pas annoncées.','a sentence starts with a capital');
  assert.equal(cut('Fermé 3–10 octobre 2026 ; les ouvertures du dimanche ne sont pas annoncées.'),'Les ouvertures du dimanche ne sont pas annoncées.');
  assert.equal(cut('Mon, Wed 09:00–18:00; Sat 14:00–18:00 · closed 3–10 October 2026'),'Mon, Wed 09:00–18:00; Sat 14:00–18:00','nothing is left over the dot or the semicolon');
  assert.equal(cut('Hours as published; closed 3–10 October 2026.'),'Hours as published.');
  assert.equal(cut('Registration is needed. The next published meeting is 10 October 2026. The year of the May date is cut off.'),'Registration is needed. The year of the May date is cut off.');
  assert.equal(cut('Das ist wichtig. Das nächste veröffentlichte Treffen ist am 10. Oktober 2026. Das Jahr fehlt.'),'Das ist wichtig. Das Jahr fehlt.','"10. Oktober" is a date, not the end of a sentence');
  assert.equal(cut('Treffen um 17:30. Bei Regen anderer Ort.'),'Treffen um 17:30. Bei Regen anderer Ort.','nothing to cut: the same text');
  assert.equal(cut('A; closed 3–10 October 2026; B; closed 1–2 October 2026; C'),'A; B; C');
  assert.equal(cut('Closed 3–10 October 2026'),'','all of it is obsolete');
  assert.equal(cut(''),'');assert.equal(cut(undefined),undefined);
});

test('the card as read today: the same object when nothing is over, else a copy without the obsolete clauses in every text a notice can stand in',()=>{
  const base={id:'x',name:'Closed 3–10 October 2026',town:'Closed 3–10 October 2026',intro:'Closed 3–10 October 2026',age:'Closed 3–10 October 2026',price:'Closed 3–10 October 2026',schedule:'Mon 09:00–10:00; closed 3–10 October 2026',
    notes:['Closed 3–10 October 2026','Other note'],practical:{warnings:['Closed 3–10 October 2026','Bring boots'],booking:{text:'Closed 3–10 October 2026',source:'https://example.org/'},indoor:{text:'Indoors'},tariff:{note:'Closed 3–10 October 2026'}},
    research:{date:'2026-09-27',findings:[{field:'Visit',text:'Closed 3–10 October 2026'},{field:'Hours',text:'Open. Closed 3–10 October 2026'}],remaining:['Closed 3–10 October 2026','Is there a snack?']}};
  const card=structuredClone(base),out=P.current(card,DAY);
  assert.notEqual(out,card);
  assert.equal(out.name,base.name);assert.equal(out.town,base.town);assert.equal(out.age,base.age);assert.equal(out.price,base.price);assert.equal(out.practical.tariff.note,base.practical.tariff.note);
  assert.equal(out.intro,base.intro,'an introduction that would be left empty stays');
  assert.equal(out.schedule,'Mon 09:00–10:00');
  assert.deepEqual(plain(out.notes),['Other note']);
  assert.deepEqual(plain(out.practical.warnings),['Bring boots']);
  assert.equal(out.practical.booking.text,'');assert.equal(out.practical.booking.source,'https://example.org/');assert.equal(out.practical.indoor.text,'Indoors');
  assert.deepEqual(plain(out.research.findings),[{field:'Hours',text:'Open.'}]);
  assert.deepEqual(plain(out.research.remaining),['Is there a snack?']);
  assert.deepEqual(plain(card),plain(base),'the card itself is not changed');
  // Nothing over: the very same object. A translated card keeps the English card it stands for.
  const fine={...base,intro:'Open',schedule:'Mon 09:00–10:00',notes:['Closed until 01.11.2026'],practical:{warnings:['Closed since 01.10.2026']},research:{findings:[],remaining:[]}};
  assert.equal(P.current(fine,DAY),fine);
  const translated=Object.defineProperty({...base},'english',{value:fine});
  assert.equal(P.current(translated,DAY).english,fine);
  assert.equal(P.current(null,DAY),null);assert.equal(P.current(card,'nonsense'),card);
});

test('on the card page and in the list: a notice that is over is gone on the day after its end, and still there on its last day',()=>{
  const cards=[{id:'closure',name:'Closure',town:'Testdorf',region:'sense',status:'active',events:[],days:[3],min:null,max:null,languages:['DE'],category:'play',format:'group',age:'x',parent:'unknown',
    schedule:'Wed 09:00–10:00; closed 3–10 October 2026',price:'Free',priceKind:'free',contacts:[],sources:[],address:'Weg 1',checked:'2026-09-27',notes:['Good to know. The next published meeting is 10 October 2026.'],
    practical:{warnings:['Closed 3–10 October 2026','Bring a towel']},research:{date:'2026-09-27',findings:[],remaining:[]}}];
  for(const [today,over] of [['2026-10-10',false],['2026-10-11',true]]){
    const S=loadStack({today}),W=S.window;
    const C=W.MinitandemCatalogue.create({activities:cards,regions:{sense:'Sense'},towns:{},planning:S.P,clock:{today:()=>today,nowHm:()=>'10:00'},t:S.t});
    const V=W.MinitandemViews.create({t:S.t,C,P:S.P,X:W.MinitandemExchange,F:S.F,store:{personal:{favorites:[],age:null,notes:{},statuses:{},visits:{}}},state:()=>S.state});
    const page=V.detail(cards[0]);
    assert.equal(page.includes('Closed 3–10 October 2026'),!over,today+': the closure warning');
    assert.equal(page.includes('closed 3–10 October 2026'),!over,today+': the closure in the schedule');
    assert.equal(page.includes('next published meeting'),!over,today+': the next meeting');
    assert.ok(page.includes('Bring a towel')&&page.includes('Good to know.'),today+': what is not over stays');
    assert.equal(V.rows(cards).includes('Wed 09:00–10:00'),true);
    assert.equal(V.hoursLine(V.shown(cards[0])),over?'Wed 09:00–10:00':'Wed 09:00–10:00 + more times');
  }
});

test('the real cards: which are affected on 17 October 2026, in all three languages, and what stays',()=>{
  const today='2026-10-17',affected={};
  for(const lang of ['en','de','fr']){
    const S=loadStack({today,lang}),CI=S.window.MinitandemCatalogueI18n;
    const shown=lang==='en'?{card:a=>a}:CI.overlay(S.records,files[lang],S.window.MinitandemViews.PRACTICAL_ORDER);
    affected[lang]=plain(S.records.filter(a=>S.P.current(shown.card(a),today)!==shown.card(a)).map(a=>a.id).sort());
  }
  assert.deepEqual(affected.en,['encore-schonberg','ile','krabbel-ursen','sentier-botanique-vully']);
  assert.deepEqual(affected.de,affected.en,'German');assert.deepEqual(affected.fr,affected.en,'French');
  const closureWords={en:/Closed 3–10 October 2026/,de:/Geschlossen 3–10 Oktober 2026/,fr:/Fermé 3–10 octobre 2026/};
  const nextMeeting={en:/next published meeting/,de:/nächste veröffentlichte Treffen/,fr:/prochaine rencontre publiée/};
  for(const lang of ['en','de','fr']){
    const S=loadStack({today,lang}),CI=S.window.MinitandemCatalogueI18n;
    const shown=lang==='en'?null:CI.overlay(S.records,files[lang],S.window.MinitandemViews.PRACTICAL_ORDER);
    const V=shown?S.window.MinitandemViews.create({t:S.t,C:S.C,P:S.P,X:S.X,F:S.F,store:S.store,state:()=>S.state,shown:shown.card,inEnglish:a=>!shown.translated(a)}):S.V;
    const ile=V.detail(S.byId.get('ile')),krabbel=V.detail(S.byId.get('krabbel-ursen'));
    assert.ok(!closureWords[lang].test(ile),lang+': no "Closed 3–10 October 2026" on the card of L’île aux trésors');
    assert.ok(/class="warns"/.test(ile),lang+': its other warnings stay');
    assert.match(ile,lang==='en'?/closed 3–10 October</:lang==='de'?/geschlossen 3–10 Oktober</:/fermé 3–10 octobre</,lang+': the closure in its schedule has no year, so it stays');
    assert.ok(!nextMeeting[lang].test(krabbel),lang+': no "next published meeting 15 October" on the card of Krabbelgruppe Ursen');
    assert.ok(krabbel.includes(shown?shown.card(S.byId.get('krabbel-ursen')).research.findings[0].text.split('. ')[0]:S.byId.get('krabbel-ursen').research.findings[0].text.split('. ')[0]),lang+': the rest of that finding stays');
    // A closure that has not ended yet stays: the café in Kerzers is closed until 18 October.
    const kafi=S.byId.get('kafi8-kerzers'),text=(shown?shown.card(kafi):kafi).schedule;
    assert.match(text,/18/);assert.ok(V.detail(kafi).includes(V.esc(text)),lang+': an open closure stays');
  }
});

test('the plain page of a card follows the same rule, by the date it is built on',()=>{
  const {byId,window:W}=loadStack({today:'2026-10-10'}),ile=byId.get('ile'),regions=W.CATALOG_REGIONS;
  assert.ok(placePage(ile,regions,'2026-10-10').includes('Closed 3–10 October 2026'),'on the last day of the closure');
  const later=placePage(ile,regions,'2026-10-17');
  assert.ok(!later.includes('Closed 3–10 October 2026')&&!later.includes('visit-warnings'),'the plaque is gone, and with it the empty list');
  assert.ok(later.includes('Mon, Wed 09:00–18:00; Sat 14:00–18:00'),'the schedule keeps its hours');
  assert.ok(later.includes('closed 3–10 October</dd>'),'a closure written without a year stays: it may be a yearly one');
  const vully=placePage(byId.get('sentier-botanique-vully'),regions,'2026-10-17');
  assert.ok(!vully.includes('unavailability due to works')&&vully.includes('Check for new restrictions before the trip.'),'a note keeps its other sentence');
  assert.equal(ile.practical.warnings[0],'Closed 3–10 October 2026','the data are not changed');
});
