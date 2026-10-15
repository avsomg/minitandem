import test from 'node:test';
import assert from 'node:assert/strict';
import {writesNumber,numberProblem,NUMBER_FIELDS} from './quote-numbers.mjs';

// Invented sentences in the three languages. Each row: field, value, quote.
const accepted=[
  // digits, ranges, decimal comma and point
  ['min',2,'Children aged 2 to 4'],['max',4,'Children aged 2 to 4'],['min',2,'2 – 4 Jahre'],['max',4,'2–4 Jahre'],['min',2,'de 2 à 4 ans'],['max',4,'de 2 à 4 ans'],
  ['min',0,'(0-5ans)'],['max',5,'(0-5ans)'],['min',1.5,'ab 1,5 Jahren'],['min',1.5,'from 1.5 years'],['min',2,'DI 29.9 | 10:00 – 10:45 | 2 – 4 JAHRE'],
  ['amount',12.5,'CHF 12.50'],['amount',12.5,'12,50 Franken'],['amount',12,'Fr. 12.-'],['amount',12,'CHF 12.–'],['amount',1200,"CHF 1'200.–"],['amount',1200,'1 200 CHF'],
  ['practical.groupSize',8,'Maximal 8 Personen'],['practical.duration',45,'45 Minuten'],['practical.duration',45,'45 min.'],
  // number words in three languages
  ['min',2,'zwei bis vier Jahre'],['max',4,'zwei bis vier Jahre'],['min',2,'de deux à quatre ans'],['max',4,'de deux à quatre ans'],['min',2,'two to four years'],['max',4,'two to four years'],
  ['max',12,'bis zwölf Jahre'],['max',12,"jusqu'à douze ans"],['max',12,'up to twelve'],['min',3,'dreijährige Kinder'],['practical.groupSize',8,'maximal acht Kinder'],
  ['practical.groupSize',6,'six enfants au maximum'],['practical.groupSize',1,'eine Begleitperson'],['min',20,'ab zwanzig'],['min',0,'null Monate Wartezeit'],
  // halves
  ['min',2.5,'ab 2½ Jahren'],['min',2.5,'ab zweieinhalb Jahren'],['min',2.5,'deux ans et demi'],['min',2.5,'2 Jahre und ein halbes Jahr'],['min',2.5,'two and a half years'],
  ['min',1.5,'ab anderthalb Jahren'],['min',0.5,'ab ½ Jahr'],['min',0.75,'¾ Jahr'],
  // months and weeks for an age in years
  ['min',1.5,'ab 18 Monaten'],['min',1.5,'dès 18 mois'],['min',1.5,'from 18 months'],['min',0.5,'ab 6 Monaten'],['min',0.33,'ab 4 Monaten'],['min',0.5,'6 bis 18 Monate'],['max',1.5,'6 bis 18 Monate'],
  ['min',2.5,'2 Jahre und 6 Monate'],['min',2.5,'2 ans et 6 mois'],['min',2.5,'2 years 6 months'],['min',0.5,'ab sechs Monaten'],
  ['min',0.12,'ab 6 Wochen'],['ageUpperUncertainFrom',4,'bis circa 4 Jahren'],
  // zero without a digit
  ['min',0,'ab Geburt'],['min',0,'von Geburt an'],['min',0,'dès la naissance'],['min',0,'from birth to 3 years'],['min',0,'kein Mindestalter'],['min',0,'no minimum age'],['min',0,'pas d\'âge minimum'],
  ['amount',0,'Eintritt frei'],['amount',0,'Das Treffen ist gratis'],['amount',0,'gratuit et sans inscription'],['amount',0,'kostenlos'],['amount',0,'Admission is free'],['amount',0,'Entrée libre'],
  // durations: hours, composites, halves and the span between two times
  ['practical.duration',60,'1 Stunde'],['practical.duration',90,'1,5 Stunden'],['practical.duration',120,'2 hours'],['practical.duration',60,'une heure'],['practical.duration',90,'1h30'],
  ['practical.duration',75,'ca. 1 Stunde 15 bis 1 Stunde 30'],['practical.duration',90,'ca. 1 Stunde 15 bis 1 Stunde 30'],['practical.duration',30,'eine halbe Stunde'],
  ['practical.duration',30,'une demi-heure'],['practical.duration',90,'anderthalb Stunden'],['practical.duration',90,'1½ Stunden'],['practical.duration',150,'zweieinhalb Stunden'],
  ['practical.duration',15,'Viertelstunde'],['practical.duration',45,'Dreiviertelstunde'],
  ['practical.duration',45,'10:00 – 10:45'],['practical.duration',60,'9H30 - 10H30'],['practical.duration',120,'De 9h30 à 11h30'],['practical.duration',120,'ab 9:00 Uhr bis 11:00 Uhr'],
  ['practical.duration',120,'von 9 bis 11 Uhr'],['practical.duration',90,'from 14:00 until 15:30'],
  // accents lost by OCR, upper case, line breaks and non-breaking spaces
  ['min',2,'ZWEI JAHRE'],['max',12,'ZWÖLF'],['max',12,'ZWOLF'],['amount',45,'Kind\n45.- CHF'],['amount',1200,'1 200 CHF'],
];
const refused=[
  ['max',5,'Children aged 2 to 4'],['min',3,'2 – 4 Jahre'],['min',4,'Kinder ab Kindergarten'],['min',0,'Babys und Kleinkinder bis 4 Jahre'],['min',4,'For pupils in 1H–4H'],
  ['min',2,'ab 2½ Jahren'],['min',1,'ab 1,5 Jahren'],['max',5,'ab 1,5 Jahren'],['min',18,'ab 18 Monaten'],['min',0.5,'ab 5 Monaten'],['min',3,'ab vierzig Jahren'],
  ['amount',35,'CHF 25 für Erwachsene + CHF 10 für Kinder'],['amount',75,'CHF 25 pro Termin, Block mit drei Terminen'],['amount',12,'CHF 12.50'],['amount',5,'CHF 50'],['amount',0,'CHF 5.–'],
  ['practical.groupSize',10,'10:00 – 10:45'],['practical.groupSize',45,'10:00 – 10:45'],['practical.groupSize',9,'maximal acht Kinder'],['practical.groupSize',2,'Kleingruppe'],
  ['practical.duration',50,'10:00 – 10:45'],['practical.duration',60,'2 – 4 JAHRE'],['practical.duration',30,'um 14 Uhr'],['practical.duration',60,'bis 9 Uhr'],['practical.duration',90,'45 Minuten'],
  ['practical.duration',120,'ca. 1 Stunde 15 bis 1 Stunde 30'],['max',29,'DI 29.10 | 10:00 – 10:45 | 2 – 4 JAHRE'],
];
test('a figure the quote writes is accepted, whatever the language, number format or stated unit',()=>{
  for(const [field,value,quote] of accepted)assert.equal(writesNumber(field,value,quote),true,`${field} ${value} in ${JSON.stringify(quote)}`);
});
test('a figure the quote does not write is refused: a sum, a school grade turned into an age, babies read as 0, a wrong unit',()=>{
  for(const [field,value,quote] of refused)assert.equal(writesNumber(field,value,quote),false,`${field} ${value} in ${JSON.stringify(quote)}`);
});
test('only the numeric fields are checked, and a null value (an unknown claim) is not a figure',()=>{
  assert.deepEqual([...NUMBER_FIELDS].sort(),['amount','ageUpperUncertainFrom','max','min','practical.duration','practical.groupSize'].sort());
  assert.equal(numberProblem('age',3,'nothing numeric here'),null);assert.equal(numberProblem('min',null,'no age'),null);assert.equal(numberProblem('priceKind','free','x'),null);
  assert.match(numberProblem('amount',45,'Eintritt CHF 12.-'),/^amount 45 is not written in its quote/);assert.equal(numberProblem('amount',12,'Eintritt CHF 12.-'),null);
});
