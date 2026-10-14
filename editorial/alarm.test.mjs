import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLine,ALARM_TERMS,IGNORE_RULES,alarmLines,classifyLines,newAlarms,significance,LONG_DOCUMENT_CHARS} from './alarm.mjs';

// Quotes are short lines from organisers' public pages, written inline so the tests run on a clean clone.
const NOW='2026-10-14T08:00:00.000Z';
const one=(text,options={})=>alarmLines(text,{now:NOW,...options});
const keys=lines=>lines.map(line=>line.key);

test('normalizeLine folds case, sharp s, typographic apostrophes, NBSP and whitespace',()=>{
  assert.equal(normalizeLine('  Die  Strasse ist GROSS  '),'die strasse ist gross');
  assert.equal(normalizeLine('Grösse: STRAßE'),'grösse: strasse');
  assert.equal(normalizeLine('n’aura pas lieu ‘ici’'),"n'aura pas lieu 'ici'");
  assert.equal(normalizeLine('Fermé'),'fermé');
});

test('word lists cover every category in German, French and English and every term compiles',()=>{
  for(const cat of ['closure','works','cancel','postpone','break','full','last','move','suspend','reopen','missing-page']){
    assert.ok(ALARM_TERMS[cat],cat);
    for(const lang of ['de','fr','en']){
      assert.ok(ALARM_TERMS[cat][lang]?.strong?.length,`${cat}/${lang}`);
      for(const term of [...ALARM_TERMS[cat][lang].strong,...ALARM_TERMS[cat][lang].weak??[]])assert.doesNotThrow(()=>new RegExp(term,'iu'),term);
    }
  }
  for(const name of ['ui','uiLine','policy','doppelganger','live','office'])assert.ok(IGNORE_RULES[name]?.length,name);
});

// Must alarm when new (plan section 4).

test('dated exceptional closure alarms, the weekly cells around it do not, context is attached',()=>{
  const text='Samedi\n10:00 - 12:00\nDimanche\nFermé\nFermeture exceptionnelle - Du 16.11.2026 au 21.11.2026\nLundi\nFermé';
  const lines=one(text);
  assert.equal(lines.length,1);
  assert.equal(lines[0].text,'Fermeture exceptionnelle - Du 16.11.2026 au 21.11.2026');
  assert.equal(lines[0].key,'fermeture exceptionnelle - du 16.11.2026 au 21.11.2026');
  assert.deepEqual(lines[0].cats,['closure']);
  assert.equal(lines[0].strength,'strong');
  assert.equal(lines[0].index,4);
  assert.deepEqual(lines[0].context,['10:00 - 12:00','Dimanche','Fermé','Fermeture exceptionnelle - Du 16.11.2026 au 21.11.2026','Lundi','Fermé']);
});

test('pool closed for an unknown time alarms (bleibt ... geschlossen)',()=>{
  const [line]=one('Wichtige Mitteilung: Das Schwimmbad Düdingen bleibt wegen Wassermangel auf unbestimmte Zeit geschlossen. Wir hoffen im Verlauf des Monats September mit den Kursen beginnen zu können.');
  assert.ok(line.cats.includes('closure'));
  assert.equal(line.strength,'strong');
});

test('fully booked course alarms',()=>{
  const [line]=one('Kursanmeldung\nDer Kurs ist bereits ausgebucht, bitte wähle einen anderen Kurs.\nMINIS Level 2');
  assert.deepEqual(line.cats,['full']);
  assert.equal(line.index,1);
});

test('cancelled until further notice alarms as cancel and suspend, with the lines around it',()=>{
  const text='Pour les enfants de 5 à 10 ans, entrée libre, sans inscription.\nAnnulé jusqu\'à nouvel avis!\nadulte\nBonjour, ca va?';
  const [line]=one(text);
  assert.deepEqual(line.cats,['cancel','suspend']);
  assert.deepEqual(line.context,text.split('\n'));
});

test('a service stopped until further notice alarms',()=>{
  const [line]=one('Aus mangelnder Nachfrage wird der Hütedienst bis auf Weiteres nicht weitergeführt.');
  assert.ok(line.cats.includes('suspend'));
  assert.ok(line.cats.includes('closure'));
});

test('full course with a waiting list and no playgroup during school holidays alarm',()=>{
  const [full]=one("COMPLET ! Inscription possible sur liste d'attente");
  assert.deepEqual(full.cats,['full']);
  assert.equal(full.strength,'strong');
  const [pause]=one('Bitte beachten: keine Krabbelgruppe während der Schulferien');
  assert.deepEqual(pause.cats,['break']);
});

test('an HTML entity apostrophe does not hide a cancellation',()=>{
  const [line]=one('Le cours du mercredi n&rsquo;aura pas lieu le 21.10.2026');
  assert.deepEqual(line.cats,['cancel']);
  assert.equal(line.text,'Le cours du mercredi n’aura pas lieu le 21.10.2026');
  assert.match(line.key,/n'aura pas lieu/);
});

test('windows-1252 bytes of a closure notice, once decoded, are found',()=>{
  const bytes=Buffer.from([...Buffer.from('La piscine est ferm'),0xe9,...Buffer.from(" jusqu'au 30.11.2026")]);
  assert.throws(()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const text=new TextDecoder('windows-1252').decode(bytes);
  assert.equal(text.includes('�'),false);
  const [line]=one(text);
  assert.deepEqual(line.cats,['closure']);
  assert.equal(line.strength,'weak+date');
});

test('a dated maintenance closure alarms while its dates are still ahead',()=>{
  const line="Fermeture, inaccessibilité pour cause d'entretien : 7 au 11 septembre 2026.";
  assert.equal(alarmLines(line,{now:'2026-09-01T08:00:00Z'}).length,1);
  assert.equal(one(line).length,0);
});

test('reopening and vanished pages get their own categories',()=>{
  assert.deepEqual(one('Wiedereröffnung des Hallenbads am 2. November').map(line=>line.cats),[['reopen']]);
  assert.deepEqual(one('Oups ! Page introuvable').map(line=>line.cats),[['missing-page']]);
  assert.deepEqual(one('Seite nicht gefunden').map(line=>line.cats),[['missing-page']]);
});

test('works, postponement, last edition and move are recognised',()=>{
  assert.deepEqual(one('Wegen Revision der Bahn kein Betrieb bis 12.12.2026').map(line=>line.cats),[['works']]);
  assert.deepEqual(one('Das Kinderkonzert wird verschoben').map(line=>line.cats),[['postpone']]);
  assert.deepEqual(one('Dernière édition du marché des enfants').map(line=>line.cats),[['last']]);
  assert.deepEqual(one('La ludothèque a déménagé : nouvelle adresse Route de la Gare 3').map(line=>line.cats),[['move']]);
  assert.deepEqual(one('The playgroup is suspended until further notice').map(line=>line.cats),[['suspend']]);
});

// Must not alarm (plan section 4).

test('weekly opening-hours cells do not alarm',()=>{
  assert.deepEqual(one('Vendredi 8:00 — 21:00\nSamedi 8:00 — 16:00\nDimanche Fermé'),[]);
  assert.deepEqual(one('Vendredi de 15h30 à 18h00\nDimanche Fermé\nContact & Localisation'),[]);
  assert.deepEqual(one('Öffnungszeiten\nMontag und Dienstag: Ruhetag\nMittwoch - Sonntag: 9 - 23 Uhr'),[]);
  assert.deepEqual(one('Samedi\nFermé'),[]);
  assert.deepEqual(one('Mardi\n13:00 - 13:30\nFermé'),[]);
  assert.deepEqual(one('Montags geschlossen bis 14 Uhr'),[]);
});

test('the weekday rule is what drops a weekly closing line',()=>{
  const reasons=classifyLines('Samedi\nGeschlossen\nMontags geschlossen bis 14 Uhr',{now:NOW}).map(line=>line.dropped);
  assert.deepEqual(reasons,['cell','weekday']);
});

test('past dates and past seasons do not alarm',()=>{
  assert.deepEqual(one("Fermeture, inaccessibilité pour cause d'entretien : 7 au 11 septembre 2026."),[]);
  assert.deepEqual(one('Saison 2025 beendet'),[]);
  assert.equal(classifyLines('Saison 2025 beendet',{now:NOW})[0].dropped,'past');
  assert.deepEqual(one('Sonntag, 4. Oktober: geschlossen'),[]);
  assert.equal(one('Saison 2026 beendet').length,1);
  assert.equal(one('Geschlossen bis 10.01.').length,1,'a date without a year early next year is ahead');
});

test('conditions and rules do not alarm',()=>{
  for(const line of [
    'Lors des jours de pluie, la balade est annulée',
    'Si le camping est complet, une place de parking supplémentaire est disponible.',
    "Conditions d'annulation : 50 % jusqu'au 1er novembre",
    'Frais d\'annulation : CHF 20.-',
    'ACHTUNG: Bitte Website checken für kurzfristige Absagen!',
    'Bei Regen fällt der Anlass aus.',
    'Annullationskosten werden verrechnet',
    'Cancellation policy: 24 hours notice',
    'Toute annulation doit se faire 24 heures à l\'avance',
    "En cas d'empêchement, merci de signaler votre annulation dès que possible.",
    "Si l'atelier auquel vous souhaitez vous inscrire est complet, écrivez-nous."
  ])assert.deepEqual(one(line),[],line);
  for(const line of ['Lors des jours de pluie, la balade est annulée','Si le camping est complet, une place de parking supplémentaire est disponible.','ACHTUNG: Bitte Website checken für kurzfristige Absagen!'])
    assert.equal(classifyLines(line,{now:NOW})[0].dropped,'policy',line);
});

test('doppelgaengers do not alarm',()=>{
  for(const line of [
    'Die wichtigsten Aufgaben sind die Organisation der Spiel- und der Krabbelgruppe, des Ferienpasses, sowie die Führung der Ludothek.',
    'Team Ferienpass Heitenried Nächste Ausgabe: 12.03.2026',
    'Merci de prévoir des chaussures fermées pour le 18.11.2026',
    'Laternenumzug in der Altstadt am 11.11.2026',
    'Le programme complet de la saison 2026-2027',
    'Die Kommentare sind geschlossen.',
    'Les commentaires sont fermés.',
    'Un moment suspendu pour les tout-petits',
    'Passeport vacances 2026 : inscriptions dès le 1er mars',
    'Bricolage et travaux manuels pour enfants'
  ])assert.deepEqual(one(line),[],line);
  for(const line of ['Die Kommentare sind geschlossen.','Merci de prévoir des chaussures fermées pour le 18.11.2026','Un moment suspendu pour les tout-petits'])
    assert.equal(classifyLines(line,{now:NOW})[0].dropped,'doppelganger',line);
});

test('buttons and cookie banners do not alarm',()=>{
  for(const line of [
    'Fermer','Menu Fermer','Schliessen','Close',
    'Diese Website verwendet Cookies. Durch die Nutzung erklären Sie sich einverstanden. Schliessen',
    'Nous utilisons des cookies. Refuser et fermer',
    'Datenschutz: Ihre Anmeldung ist geschlossen und gespeichert bis 31.12.2026'
  ])assert.deepEqual(one(line),[],line);
  assert.equal(classifyLines('Cookie-Hinweis geschlossen bis 31.12.2026',{now:NOW})[0].dropped,'ui');
});

test('live open/closed indicators do not alarm; office closures are information only',()=>{
  assert.deepEqual(one('Le bureau est actuellement fermé'),[]);
  assert.equal(classifyLines('Le bureau est actuellement fermé',{now:NOW})[0].dropped,'live');
  assert.deepEqual(one('Jetzt geschlossen'),[]);
  const [office]=alarmLines('Notre secrétariat sera fermé du vendredi 24 juillet',{now:'2026-07-10T08:00:00Z'});
  assert.equal(office.strength,'info');
  assert.equal(office.office,true);
  assert.deepEqual(office.cats,['closure']);
});

test('ignore patterns (ignoreLines, alarmIgnore) drop a line',()=>{
  const text='Der Kurs ist ausgebucht.';
  assert.equal(one(text).length,1);
  assert.deepEqual(one(text,{ignore:[/ausgebucht/]}),[]);
  assert.deepEqual(one(text,{ignore:['^Der Kurs']}),[]);
});

test('long documents only count lines near an anchor',()=>{
  const filler=Array.from({length:600},(_,i)=>`Compte ${i} charges courantes et amortissements 12'000.00`);
  const far=[...filler.slice(0,100),'Place de jeux du collège',...filler.slice(100,500),'Rénovation appartement 2ème étage',...filler.slice(500)].join('\n');
  assert.ok(far.length>LONG_DOCUMENT_CHARS);
  assert.deepEqual(one(far,{anchors:['Place de jeux']}),[]);
  const near=[...filler.slice(0,100),'Place de jeux du collège','Rénovation appartement 2ème étage',...filler.slice(100)].join('\n');
  assert.deepEqual(one(near,{anchors:['Place de jeux']}).map(line=>line.cats),[['works']]);
  assert.deepEqual(one(far,{anchors:['Place de jeux'],longDocument:false}).map(line=>line.cats),[['works']]);
});

// Set semantics (plan section 2.5 item 5, analysis section 4 rules 1 and 12).

test('a line already known does not alarm again',()=>{
  const text='Accessibilité\nFermée durant les vacances scolaires\nMardi\n13:00 - 13:30 15:15 - 16:00\nWährend den Schulferien & Feiertagen bleibt die Ludothek geschlossen.';
  const current=one(text);
  assert.equal(current.length,2);
  const result=newAlarms(keys(current),current,[],NOW);
  assert.deepEqual(result.added,[]);
  assert.deepEqual(result.muted,[]);
  assert.deepEqual(result.keys,keys(current));
});

test('first run only records a baseline',()=>{
  const current=one('Der Kurs ist ausgebucht.');
  const result=newAlarms(undefined,current,[],NOW);
  assert.equal(result.baseline,true);
  assert.deepEqual(result.added,[]);
  assert.deepEqual(result.keys,keys(current));
});

test('a new line alarms; a changed date is a new line',()=>{
  const before=one('Geschlossen bis 20.10.2026');
  const after=one('Geschlossen bis 03.11.2026');
  const result=newAlarms(keys(before),after,[],NOW);
  assert.deepEqual(keys(result.added),['geschlossen bis 03.11.2026']);
  assert.equal(result.history.find(entry=>entry.key==='geschlossen bis 20.10.2026').goneAt,NOW);
});

test('a line that comes and goes twice within 30 days is muted',()=>{
  const line=one('Der Kurs ist ausgebucht.');
  const day=n=>new Date(Date.parse('2026-10-01T08:00:00Z')+n*86_400_000).toISOString();
  let state=newAlarms(undefined,[],[],day(0));
  const step=(current,n)=>{const result=newAlarms(state.keys,current,state.history,day(n));state=result;return result;};
  assert.equal(step(line,1).added.length,1,'first appearance alarms');
  step([],2);
  assert.equal(step(line,3).added.length,1,'appeared and went once: still alarms');
  step([],4);
  const fifth=step(line,5);
  assert.deepEqual(fifth.added,[]);
  assert.equal(fifth.muted.length,1);
  assert.ok(state.history.length<=30);
  // Older than 30 days the flapping is forgotten.
  state=newAlarms(['x'],[],state.history,day(40));
  assert.equal(newAlarms(state.keys,line,state.history,day(41)).added.length,1);
});

test('significance: facts high, boilerplate low, prose normal',()=>{
  assert.equal(significance(['Mittwoch 14:00 - 16:00'],['Mittwoch 14:00 - 17:00']),'high');
  assert.equal(significance(['Prix : CHF 15.-'],[]),'high');
  assert.equal(significance(['Le cours est complet.'],[]),'high');
  assert.equal(significance(['Cette page utilise des cookies.','© 2026 Commune'],['© 2025 Commune']),'low');
  assert.equal(significance(['Bereitgestellt: 12.10.2026 Besuche: 1203'],['Bereitgestellt: 11.10.2026 Besuche: 1199']),'low');
  assert.equal(significance([],[]),'low');
  assert.equal(significance(['Wir freuen uns auf viele Familien und neue Gesichter in unserem Treff.'],[]),'normal');
});
