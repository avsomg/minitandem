import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bodyText,fullView,FULL_PARSERS,alarmSource,pageAlarms,viewText,monitorView,normalize,decodeBytes} from './page-text.mjs';
import {htmlText,snapshot,locateQuote} from './evidence.mjs';
import {htmlTextV2,fullPageText} from './monitor.mjs';

// Everything below is invented: no such place, page or notice exists.
const now='2026-10-14T05:00:00.000Z';
const source={id:'fx',url:'https://fixture.example.org/spielgruppe',type:'html',minChars:10};
const PAGE=`<html><head><title>Spielgruppe Teststadt: vorübergehend geschlossen bis 30.11.2099</title><meta name="description" content="Treffen fuer Kinder"></head>
<body><header><p>Montag Ruhetag</p><p>Dienstag bis Freitag 09:00-12:00</p></header><nav><a href="/">Startseite</a></nav>
<main><h1>Spielgruppe Teststadt</h1><p>Jeden Mittwoch 15:00 bis 16:00 Uhr fuer Kinder von 2 bis 4 Jahren.</p><table><tr><td>Beitrag</td><td>CHF 8</td></tr></table></main>
<footer><p>Kontakt: Fixture Verein, Probeweg 5</p></footer></body></html>`;

test('one page gives the controller its full body and the monitor its change text and alarm lines',()=>{
  const full=fullView(PAGE,'html'),view=monitorView(PAGE,source,{now});
  assert.equal(full.parser,FULL_PARSERS.html);
  // The full body keeps header and footer, drops navigation; the change text is the main block plus the opening-hours lines of the header.
  assert.match(full.text,/Montag Ruhetag/);assert.match(full.text,/Probeweg 5/);assert.doesNotMatch(full.text,/Startseite/);
  assert.match(view.watch,/Jeden Mittwoch/);assert.match(view.watch,/Montag Ruhetag/);assert.doesNotMatch(view.watch,/Probeweg|Startseite/);
  // The alarm line comes from the title, which neither text holds; the view adds it after the change text.
  assert.deepEqual(view.alarm,['Spielgruppe Teststadt: vorübergehend geschlossen bis 30.11.2099']);
  assert.doesNotMatch(full.text,/vorübergehend/);assert.doesNotMatch(view.watch,/vorübergehend/);
  assert.ok(view.text.startsWith(view.watch));assert.match(view.text,/vorübergehend geschlossen bis 30\.11\.2099$/);
});
test('a quote taken from either view is found in the other record of the same fetch',()=>{
  const full=fullView(PAGE,'html'),view=monitorView(PAGE,source,{now});
  const url=source.url,common={url,fetchedAt:now,contentType:'text/html'};
  const records={full:snapshot({...common,parser:full.parser,text:full.text}),view:snapshot({...common,parser:'monitor-view-v2',text:view.text})};
  // Header hours are in both; the footer address only in the full body; the title notice only in the monitor view.
  for(const quote of ['Dienstag bis Freitag 09:00-12:00','Jeden Mittwoch 15:00 bis 16:00 Uhr fuer Kinder von 2 bis 4 Jahren.'])
    for(const record of Object.values(records))assert.ok(locateQuote(record,quote),quote);
  assert.ok(locateQuote(records.full,'Kontakt: Fixture Verein, Probeweg 5'));assert.equal(locateQuote(records.view,'Kontakt: Fixture Verein, Probeweg 5'),null);
  assert.ok(locateQuote(records.view,'vorübergehend geschlossen bis 30.11.2099'));assert.equal(locateQuote(records.full,'vorübergehend geschlossen bis 30.11.2099'),null);
  // Table cells are separate lines in the full body; whitespace does not matter to a quote.
  assert.ok(locateQuote(records.view,'Beitrag   CHF 8'));assert.ok(locateQuote(records.full,'Beitrag CHF 8'));
});
test('the controller body text is the one step the monitor shares: same bytes, same text, whatever the decoder',()=>{
  const bytes=Buffer.from(PAGE);
  assert.equal(htmlText(bytes),bodyText(PAGE));assert.equal(htmlText(PAGE),bodyText(PAGE));
  // Latin-1 bytes with a declared charset are decoded as the monitor decodes them, not read as broken UTF-8.
  const latin=Buffer.from('<html><head><meta charset="iso-8859-1"></head><body><p>Kinder ab 3 Jahren, Zürich, Anmeldung nötig.</p></body></html>','latin1');
  assert.match(htmlText(latin),/Zürich, Anmeldung nötig/);assert.equal(decodeBytes(latin,'text/html'),latin.toString('latin1'));
  assert.doesNotMatch(htmlText(latin),/�/);
});
test('the view adds an alarm line once and only when the change text does not hold it',()=>{
  assert.equal(viewText('Montag 09:00\nMittwoch 10:00',['Montag   09:00']),'Montag 09:00\nMittwoch 10:00');
  assert.equal(viewText('Montag 09:00',['Notice A','Notice A','  Notice B ','']),'Montag 09:00\nNotice A\nNotice B');
  assert.equal(viewText('Montag 09:00'),'Montag 09:00');
});
test('calendars and PDFs have a full view of their own text and no body parser',()=>{
  assert.deepEqual(fullView('  BEGIN:VCALENDAR\nEND:VCALENDAR\n','ics'),{parser:'calendar-raw-v1',text:'BEGIN:VCALENDAR\nEND:VCALENDAR'});
  assert.deepEqual(fullView('Programm\n\nSeite 1  ','pdf'),{parser:'pdftotext-layout-v1',text:'Programm\n\nSeite 1'});
  assert.equal(fullView('x','image'),null);
  const pdf={id:'p',type:'pdf'};
  assert.match(alarmSource('Der Kurs ist vorübergehend geschlossen.',pdf),/vorübergehend/);
  assert.equal(alarmSource('BEGIN:VCALENDAR',{type:'ics'}),null);assert.equal(pageAlarms('BEGIN:VCALENDAR',{type:'ics'},{now}),null);
});
test('the change text is exactly what the monitor stores: normalize, nothing added',()=>{
  const view=monitorView(PAGE,source,{now});
  assert.equal(view.watch,normalize(PAGE,source,now,'v2'));
  // The monitor's own helpers still give the same pieces (they moved, they did not change).
  assert.match(htmlTextV2(PAGE),/Jeden Mittwoch/);assert.match(fullPageText(PAGE),/^Spielgruppe Teststadt: vorübergehend/);
  assert.throws(()=>monitorView('<body><p>kurz</p></body>',source,{now}),/too short/);
  assert.throws(()=>monitorView(PAGE,{...source,required:['Fehlt']},{now}),/required marker missing/);
});
