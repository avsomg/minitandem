// The list row (age slot, next-date column, week-row classes), the chips that name active filters, and the card page's actions
// (share, report an error by e-mail) and its language marks when a card falls back to English.
import assert from 'node:assert/strict';
import test from 'node:test';
import {loadStack} from './test-support.mjs';

// A stack whose views know a page origin, a family-service state and a fallback reason, as app.js gives them.
function stack({lang='en',inEnglish=()=>'',connected=false}={}){
  const S=loadStack({lang});
  const V=S.window.MinitandemViews.create({t:S.t,C:S.C,P:S.P,X:S.X,F:S.F,store:S.store,state:()=>S.state,inEnglish,origin:'https://minitandem.ch',syncConnected:()=>connected});
  return {...S,V};
}

test('the age slot of a row holds an age: without a published bound it says so, and the card page keeps the organiser’s words',()=>{
  const {V,C,F,t}=stack();
  const unbounded=C.activities.find(a=>!C.isArchive(a)&&!F.bounds(a)&&!/confirm|check|not published|restriction|to be/i.test(a.age));
  const bounded=C.activities.find(a=>!C.isArchive(a)&&F.bounds(a));
  const slot=html=>html.match(/<span class="r-age[^"]*">(?:<svg[\s\S]*?<\/svg><span class="sr">[^<]*<\/span>)?([^<]*)<\/span>/)[1];
  assert.equal(slot(V.row(unbounded)),V.esc(t('age.notPublished')),unbounded.id+': "'+unbounded.age+'" is not an age');
  assert.ok(V.detail(unbounded).includes(V.esc(unbounded.age)),'the card page shows the wording');
  assert.equal(slot(V.row(bounded)),V.esc(F.ageShort(bounded)));
});

test('the next date: "Next:" on the phone line, the date alone for the table column headed "Next date"',()=>{
  const {V,C,F}=stack();
  const dated=C.activities.find(a=>!C.isArchive(a)&&C.upcoming(a).length);
  const html=V.row(dated);
  assert.ok(html.includes(`<span class="w-full">${V.esc(F.nextText(dated,C.upcoming(dated),[]))}</span>`));
  assert.match(html,/<span class="w-short">[^<]+<\/span>/);
  assert.ok(!html.match(/<span class="w-short">([^<]+)</)[1].startsWith('Next'));
  // A week row's time line has its own modifier, never the page container's .wrap.
  assert.ok(!/class="r-when wrap"/.test(V.row(dated,{time:'09:00',when:'x'})));
  assert.match(V.row(dated,{time:'09:00',when:'x'}),/class="r-when is-wrap"/);
});

test('active filters are named as chips that remove them; the rainy-day switch shows while it is off',()=>{
  const {V,t}=stack();
  const none=V.filterChips([]);
  assert.match(none,/<button type="button" class="chip fchip-quick" data-quick="indoor" aria-pressed="false">/);
  assert.ok(none.includes(V.esc(t('filter.indoor'))));
  const some=V.filterChips([{key:'cat:music',label:'Music'},{key:'indoor',label:t('filter.indoor')}]);
  assert.match(some,/data-remove="cat:music" aria-label="Remove filter: Music">Music<svg/);
  assert.match(some,/data-remove="indoor" aria-label="Remove filter: Indoors \(rainy day\)">/);
  assert.ok(!some.includes('data-quick'),'no switch while the filter is on');
  const fr=stack({lang:'fr'});
  assert.ok(fr.V.filterChips([{key:'age',label:'3 ans'}]).includes('aria-label="Retirer le filtre\u00a0: 3 ans"'));
});

test('the card page: Share and Report an error under the facts; the e-mail names the card, its id and link; the correction form only with the family service',()=>{
  const {V,byId,t}=stack();
  const a=byId.get('aef-attalens'),html=V.detail(a);
  const second=html.slice(html.indexOf('<div class="d-second">'),html.indexOf('</p>',html.indexOf('class="d-report"')));
  assert.ok(second.includes(`data-action="share-card">`)&&second.includes(V.esc(t('card.share'))));
  const report=html.slice(html.indexOf('class="d-report"'));
  const href=report.match(/href="(mailto:[^"]+)"/)[1].replace(/&amp;/g,'&');
  const url=new URL(href);
  assert.equal(url.pathname,'hello@minitandem.ch');
  assert.equal(url.searchParams.get('subject'),t('report.mailSubject',{name:a.name}));
  const body=url.searchParams.get('body');
  assert.ok(body.includes(a.id)&&body.includes('https://minitandem.ch/#view=catalog&activity='+a.id)&&body.includes('\r\n'),body);
  assert.ok(second.includes(V.esc(t('card.reportError'))));
  assert.ok(!html.includes('data-action="report-change"'),'no correction file without the family service');
  assert.ok(stack({connected:true}).V.detail(a).includes('data-action="report-change"'));
});

test('a card shown in English in German or French carries lang="en" and says why',()=>{
  const stale=stack({lang:'de',inEnglish:()=>'stale'}),failed=stack({lang:'de',inEnglish:()=>'failed'}),fine=stack({lang:'de'});
  const a=stale.byId.get('aef-attalens');
  assert.match(stale.V.row(a),/<span class="r-name"><span lang="en">/);
  assert.match(stale.V.detail(a),/<h2 class="d-name" id="dTitle" lang="en">/);
  assert.ok(stale.V.detail(a).includes(stale.V.esc(stale.t('card.inEnglish'))));
  assert.ok(failed.V.detail(a).includes(failed.V.esc(failed.t('card.notLoaded'))));
  assert.ok(!fine.V.row(a).includes('lang="en"')&&!fine.V.detail(a).includes('lang="en"'));
  assert.notEqual(stale.t('cards.notLoaded'),stale.t('cards.english',{n:1}),'a file that did not load is worded apart from a stale card');
});

test('the new words exist in three languages; French keeps its no-break spaces; the report e-mail keeps its line breaks',()=>{
  const {window:W}=loadStack();
  const D=W.MINITANDEM_STRINGS;
  for(const key of ['cards.notLoaded','card.notLoaded','week.jump','filters.remove','card.share','share.cardCopied','card.reportError','report.mailSubject','report.mailBody']){
    for(const lang of ['en','de','fr'])assert.ok(D[lang][key],lang+' '+key);
    assert.ok(!/ [:;?!]/.test(D.fr[key]),'fr '+key);assert.ok(!/ß/.test(D.de[key]),'de '+key);
  }
  for(const lang of ['en','de','fr'])assert.equal(D[lang]['report.mailBody'].split('\n').length,7,lang);
});

test('the card page shows when it was checked; past 60 days a hint asks to confirm with the organiser, and the status stays',()=>{
  for(const lang of ['en','de','fr']){
    const {V,C,P,F,t}=stack({lang});
    const a=C.activities.find(x=>!C.isArchive(x)&&x.checked),today=C.today();
    const day=n=>new Date(Date.parse(today+'T12:00:00Z')-n*86400000).toISOString().slice(0,10);
    const html=(card)=>V.detail(card);
    const at=n=>({...a,checked:day(n)});
    assert.equal(P.STALE_CHECK_DAYS,60);
    assert.equal(P.checkAge(at(0),today),0);
    assert.equal(P.checkAge(at(60),today),60);
    assert.equal(P.checkStale(at(60),today),false,'60 days old is still within the limit');
    assert.equal(P.checkStale(at(61),today),true,'61 days old is past it');
    assert.equal(P.checkAge({...a,checked:day(-3)},today),null,'a date in the future is not shown as an age');
    const hint=V.esc(t('card.checkedOld')),line=V.esc(t('card.checked',{date:F.dateLabel(at(61).checked)}));
    assert.ok(html(at(61)).includes(line)&&html(at(61)).includes(hint),lang+': old card carries date and hint');
    assert.ok(html(at(60)).includes(V.esc(t('card.checked',{date:F.dateLabel(at(60).checked)})))&&!html(at(60)).includes(hint),lang+': fresh card has no hint');
    assert.equal(C.statusOf(at(61),NaN),C.statusOf(at(1),NaN),'age of the check does not change the status');
  }
});

test('a card without a valid check date shows no date line and no hint',()=>{
  const {V,C,P,t}=stack();
  const a=C.activities.find(x=>!C.isArchive(x));
  for(const checked of [undefined,'','soon','2026-13-40']){
    const html=V.detail({...a,checked});
    assert.ok(!html.includes('d-checked')&&!html.includes('d-stale')&&!html.includes('Invalid'),String(checked));
    assert.equal(P.checkAge({...a,checked},C.today()),null);
    assert.equal(P.checkStale({...a,checked},C.today()),false);
  }
  assert.ok(t('card.checkedOld'));
});
