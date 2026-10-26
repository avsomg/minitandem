// The plain pages of the places in German, French and English: one page per published card in each language, the three versions
// pointing at each other, the words of the app (dictionaries, formatting functions, checked card translations), the app's note
// when a translation is out of date, and French typography.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {after} from 'node:test';
import {loadCatalog} from './editorial/quality.mjs';
import {generatePublicPages, placePage} from './public-pages.mjs';
import {PAGE_LANGS, PAGE_TEXT, languageLayer, placeURL, directoryURL, sentences} from './place-languages.mjs';
import {LEGAL_LABELS, LANGUAGE_NAMES, legalURL} from './legal-pages.mjs';
import {GUIDE_URLS} from './daycare-guides.mjs';
import {SITE_ORIGIN} from './site.mjs';
import {loadStack} from './test-support.mjs';

const root = path.dirname(new URL(import.meta.url).pathname);
const NBSP = String.fromCharCode(160);
const DATE = '2026-10-20';
// The catalogue comes from another realm; arrays of this realm compare equal with arrays made here.
const catalog = loadCatalog(), regions = catalog.CATALOG_REGIONS, records = [...catalog.ACTIVITIES];
const published = records.filter(a => !['closed', 'excluded'].includes(a.status));
const folders = [];
const build = (cards, date = DATE) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minitandem-places-i18n-'));
  folders.push(dir);
  generatePublicPages(cards, regions, dir, date);
  return dir;
};
after(() => { for (const dir of folders) fs.rmSync(dir, {recursive: true, force: true}); });
const output = build(records);
const read = (dir, url) => fs.readFileSync(path.join(dir, url, 'index.html'), 'utf8');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const allPages = () => [
  ...PAGE_LANGS.map(lang => ({lang, url: directoryURL(lang), id: null})),
  ...published.flatMap(a => PAGE_LANGS.map(lang => ({lang, url: placeURL(a.id, lang), id: a.id})))
].map(page => ({...page, html: read(output, page.url)}));
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
// Card text that is English on a page of another language: the language switch names English too, and the page has lang="en" on its own element.
const marksEnglish = html => html.slice(html.indexOf('<body')).replace(/<nav class="langnav"[\s\S]*?<\/nav>/, '').includes(' lang="en"');

test('English keeps the address these pages have always had; German and French sit beside it, in the scheme the app links with', () => {
  assert.equal(placeURL('mpe', 'en'), '/places/mpe/');
  assert.equal(placeURL('mpe', 'de'), '/places/mpe/de/');
  assert.equal(placeURL('mpe', 'fr'), '/places/mpe/fr/');
  assert.deepEqual(PAGE_LANGS.map(directoryURL), ['/places/de/', '/places/fr/', '/places/']);
  // The app's card page and footer link to the page of the interface language, from the same table.
  for (const lang of PAGE_LANGS) {
    const S = loadStack({lang});
    assert.ok(S.V.detail(S.byId.get('mpe')).includes(`href="${placeURL('mpe', lang).slice(1)}"`), lang + ': the card page links to its plain page');
    assert.equal('/' + S.I.plainPage(lang), directoryURL(lang));
  }
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<a class="linkbtn" href="places\/" data-places /);
  assert.match(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), /\[data-places\]'\)\) node\.href = I\.plainPage\(I\.lang\(\)\)/);
});

test('one page per published card in each language, a directory in each, and no page for a closed or archived card', () => {
  assert.ok(published.length > 100 && published.length < records.length, 'the catalogue has archived cards');
  for (const lang of PAGE_LANGS) {
    const found = published.filter(a => fs.existsSync(path.join(output, placeURL(a.id, lang), 'index.html')));
    assert.equal(found.length, published.length, lang);
    assert.ok(fs.existsSync(path.join(output, directoryURL(lang), 'index.html')), lang + ' directory');
    for (const a of records.filter(a => !published.includes(a))) assert.equal(fs.existsSync(path.join(output, placeURL(a.id, lang))), false, a.id);
    const listed = [...read(output, directoryURL(lang)).matchAll(/<li><a href="(\/places\/[^"]+\/)"/g)].map(m => m[1]).sort();
    assert.deepEqual(listed, published.map(a => placeURL(a.id, lang)).sort(), lang + ': the directory lists every published card, once, with the address of its own language');
  }
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, {withFileTypes: true})) entry.isDirectory() ? walk(path.join(dir, entry.name)) : files.push(path.join(dir, entry.name)); };
  walk(path.join(output, 'places'));
  assert.equal(files.length, 3 * published.length + 3);
  assert.ok(files.every(file => file.endsWith('index.html')));
  // A card named like a language would take over that language's directory.
  assert.throws(() => build(records.map(a => a === published[0] ? {...a, id: 'de'} : a)), /Invalid public page ID/);
});

test('every page names its three versions: hreflang pairs, x-default, canonical, and a language switch that marks the page\'s own language', () => {
  const pages = allPages();
  const alternatesOf = html => Object.fromEntries([...html.matchAll(/<link rel="alternate" hreflang="([\w-]+)" href="([^"]+)">/g)].map(m => [m[1], m[2]]));
  for (const {lang, url, id, html} of pages) {
    const where = url;
    const urls = Object.fromEntries(PAGE_LANGS.map(code => [code, id === null ? directoryURL(code) : placeURL(id, code)]));
    const alternates = alternatesOf(html);
    assert.deepEqual(Object.keys(alternates).sort(), ['de', 'en', 'fr', 'x-default'], where);
    for (const code of PAGE_LANGS) assert.equal(alternates[code], SITE_ORIGIN + urls[code], where + ' ' + code);
    assert.equal(alternates['x-default'], SITE_ORIGIN + urls.en, where + ': x-default is the English address, the fallback of the app');
    assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}${url}">`), where + ': canonical is the page itself');
    assert.ok(html.includes(`<meta property="og:url" content="${SITE_ORIGIN}${url}">`), where);
    assert.ok(html.startsWith(`<!doctype html><html lang="${lang}">`), where);
    // The switch: one nav in the page's language, every language in the same order, only the page's own is current.
    const nav = html.match(/<nav class="langnav" aria-label="([^"]+)">(.*?)<\/nav>/);
    assert.equal(nav[1], LEGAL_LABELS[lang].language, where);
    const links = [...nav[2].matchAll(/<a href="([^"]+)" hreflang="(\w+)" lang="\w+"( aria-current="page")?>([^<]+)<\/a>/g)];
    assert.deepEqual(links.map(m => m[2]), ['de', 'fr', 'en'], where);
    assert.deepEqual(links.filter(m => m[3]).map(m => m[2]), [lang], where);
    for (const m of links) { assert.equal(m[1], urls[m[2]], where); assert.equal(m[4], LANGUAGE_NAMES[m[2]], where); assert.ok(fs.existsSync(path.join(output, m[1], 'index.html')), where + ' -> ' + m[1]); }
    // The pairs are complete: each version lists exactly the same three addresses.
    for (const code of PAGE_LANGS) assert.deepEqual(alternatesOf(read(output, urls[code])), alternates, where + ' and ' + urls[code]);
  }
  assert.equal(pages.length, 3 * published.length + 3);
});

test('the sitemap lists every page of every language once, and the other pages as before', () => {
  const sitemap = fs.readFileSync(path.join(output, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  assert.equal(new Set(locs).size, locs.length, 'no address twice');
  for (const page of allPages()) assert.ok(locs.includes(SITE_ORIGIN + page.url), page.url);
  for (const url of ['/', '/projekt/', '/projekt/en/', legalURL('impressum', 'de'), legalURL('datenschutz', 'fr')]) assert.ok(locs.includes(SITE_ORIGIN + url), url);
  assert.equal(locs.length, 3 * published.length + 3 + 2 + 6 + GUIDE_URLS.length + 1);
});

test('the pages carry the app\'s own words, dates and ages in each language, from the dictionaries and the formatting functions', () => {
  for (const lang of PAGE_LANGS) {
    const S = loadStack({lang}), {t, F} = S, layer = languageLayer(lang);
    // The layer in Node is the same interface as the one the app loads.
    for (const key of ['fact.age', 'fact.parent', 'fact.price', 'card.practical', 'card.contacts', 'card.sources', 'dates.title', 'card.toConfirm', 'saved.openCard', 'card.map', 'foot.places', 'foot.catalogue', 'count.label', 'cards.english'])
      assert.equal(layer.t(key, {n: 5}), t(key, {n: 5}), lang + ' ' + key);
    const shown = layer.cards(records);
    for (const id of ['museum', 'suniai-family-yoga', 'beaches']) {
      const card = records.find(a => a.id === id), page = read(output, placeURL(id, lang)), a = shown.shown(card);
      assert.ok(page.includes(`<dt>${esc(t('fact.age'))}</dt>`) && page.includes(`<h2>${esc(t('card.practical'))}</h2>`), lang + ' ' + id);
      assert.ok(page.includes(`<h2>${esc(t('card.contacts'))}</h2>`) && page.includes(`<h2>${esc(t('card.sources'))}</h2>`), lang + ' ' + id);
      assert.ok(page.includes(esc(t('saved.openCard'))), lang + ' ' + id);
      assert.ok(page.includes(`<time datetime="${a.checked}">${esc(F.dateLabel(a.checked))}</time>`), lang + ' ' + id + ': the check date is written as the app writes it');
      assert.ok(page.includes(esc(a.name)), lang + ' ' + id + ': the card\'s name in the page language');
      for (const [key, fact] of Object.entries(a.practical || {})) if (fact?.text && layer.practicalOrder.includes(key)) assert.ok(page.includes(`<dt>${esc(t('practical.' + key))}</dt>`) && page.includes(esc(fact.text)), `${lang} ${id} ${key}`);
    }
    // Dates: the day, month and year of the app, the time of the app, the interface's own phrase for an unknown time.
    const museum = read(output, placeURL('museum', lang)), future = records.find(a => a.id === 'museum').events.filter(e => e.date >= DATE);
    assert.ok(future.length > 2);
    for (const e of future) assert.ok(museum.includes(`<time datetime="${e.date}">${esc(F.dateLabel(e.date))}</time> · ${esc(F.clockLabel(e))}`), lang + ' ' + e.date);
    // The directory: the age of a row is the app's short age, or its phrase for no published age.
    const directory = read(output, directoryURL(lang)), shownMpe = shown.shown(records.find(a => a.id === 'mpe'));
    assert.ok(directory.includes(esc(`${shownMpe.town} · ${F.bounds(shownMpe) ? F.ageShort(shownMpe) : t('age.notPublished')}`)), lang);
    assert.ok(directory.includes(`<h1>${esc(PAGE_TEXT[lang].places)}</h1>`) && directory.includes(`${published.length} ${esc(t('count.label', {n: published.length}))}`), lang);
    // The footer note and the directory text are sentences of the app's own notes, nothing new.
    assert.equal(sentences(t('foot.note')).length, 3, lang + ': the last of three sentences (about the browser) is left out');
    assert.ok(directory.includes(esc(sentences(t('foot.note')).slice(0, 2).join(' '))) && !directory.includes(esc(sentences(t('foot.note'))[2])), lang);
    assert.ok(directory.includes(esc(sentences(t('about.intro')).slice(0, 2).join(' '))), lang);
    assert.ok(read(output, placeURL('mpe', lang)).includes(`<a href="${directoryURL(lang)}">${esc(t('foot.places'))}</a>`), lang);
  }
});

test('footer links to the notices are in the page language, and the button into the app opens the card in it', () => {
  for (const {lang, url, id, html} of allPages()) {
    const footer = html.match(/<footer class="public-footer">(.*?)<\/footer>/)[1];
    for (const kind of ['impressum', 'datenschutz']) assert.ok(footer.includes(`<a href="${legalURL(kind, lang)}">${LEGAL_LABELS[lang][kind]}</a>`), url + ' ' + kind);
    assert.ok(footer.includes(`<a href="/">${LEGAL_LABELS[lang].app}</a>`), url);
    assert.match(html, /<a class="skip" href="#content">/);
    assert.ok(html.includes(`>${esc(LEGAL_LABELS[lang].skip)}</a>`), url);
    if (id) assert.ok(html.includes(`<a class="go" href="/?lang=${lang}#view=catalog&amp;activity=${id}">${esc(languageLayer(lang).t('saved.openCard'))}</a>`), url + ': the .go button');
  }
});

test('the pages stay script-free and inside the Content-Security-Policy: one local stylesheet, no inline style, no handler', () => {
  for (const {url, html} of allPages()) {
    assert.doesNotMatch(html, /<script|<style|\sstyle=|\son[a-z]+=|<iframe|<object|<embed|<form|@import/i, url);
    assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]), ['/styles.css'], url);
    assert.doesNotMatch(html, /\s(?:src|srcset)=/i, url);
  }
});

test('no page holds Cyrillic, in any language', () => {
  // Written as code points: the repository scan (npm run scan:public) must not find Cyrillic in this file either.
  const cyrillic = value => [...value].filter(ch => ch.codePointAt(0) >= 0x400 && ch.codePointAt(0) <= 0x52f);
  for (const {url, html} of allPages()) assert.deepEqual(cyrillic(html), [], url);
  for (const lang of PAGE_LANGS) for (const [key, value] of Object.entries(PAGE_TEXT[lang])) assert.deepEqual(cyrillic(value), [], key);
});

test('French typography: no space before : ; ? ! or ») and none after «, in the text, the title and the description', () => {
  const french = allPages().filter(page => page.lang === 'fr');
  assert.equal(french.length, published.length + 1);
  for (const {url, html} of french) {
    const parts = [text(html), html.match(/<title>(.*?)<\/title>/)[1], html.match(/<meta name="description" content="([^"]*)">/)[1]];
    for (const part of parts) assert.doesNotMatch(part.replace(/&#39;/g, "'"), / [:;?!»]|« /, url);
  }
  // The colon the pages add themselves (a label before a value) is set with the no-break space.
  // Since 26 October 2026 every Suniai date is at the card's own address; the Schönberg meetings name their hall on each date.
  const S = loadStack({lang: 'fr'}), schonberg = read(output, placeURL('aef-schonberg', 'fr'));
  assert.ok(schonberg.includes(`${S.F.dateLabel('2026-12-16')}${NBSP}: `), 'the address by date');
  const beaches = read(output, placeURL('beaches', 'fr'));
  assert.ok(beaches.includes(`${S.t('card.map')}${NBSP}: Gypsera`), 'the map link of an area');
  // The same labels in German and English have a plain colon.
  assert.ok(read(output, placeURL('beaches', 'de')).includes(`${loadStack({lang: 'de'}).t('card.map')}: Gypsera`));
  assert.ok(read(output, placeURL('beaches', 'en')).includes('Show on map: Gypsera'));
});

test('a card whose English changed since it was translated is shown in English with the app\'s note, and only that card', () => {
  const target = published.find(a => a.intro);
  const other = published.find(a => a.id !== target.id && a.intro);
  const changed = ' The programme was changed after the translation.';
  const stale = build([...records.map(a => a.id === target.id ? {...a, intro: a.intro + changed} : a), {...other, id: 'untranslated-test-card', name: 'Untranslated test card'}]);
  for (const lang of ['de', 'fr']) {
    const {t} = languageLayer(lang), note = `<p class="field-note">${esc(t('card.inEnglish'))}</p>`;
    for (const id of [target.id, 'untranslated-test-card']) {
      const html = read(stale, placeURL(id, lang)), card = id === target.id ? {...target, intro: target.intro + changed} : {...other, id, name: 'Untranslated test card'};
      assert.ok(html.includes(note), `${lang} ${id}: the note, in the page language`);
      assert.ok(html.includes(`<h1 itemprop="headline" lang="en">${esc(card.name)}</h1>`), `${lang} ${id}: English text is marked`);
      assert.ok(html.includes(`<p class="public-intro" itemprop="description" lang="en">${esc(card.intro)}</p>`), `${lang} ${id}: the English intro`);
      assert.ok(html.includes(`<dt>${esc(t('fact.schedule'))}</dt><dd><span lang="en">${esc(card.schedule)}</span></dd>`), `${lang} ${id}: facts in English, labels in ${lang}`);
      assert.ok(html.startsWith(`<!doctype html><html lang="${lang}">`) && html.includes(`<dt>${esc(t('fact.age'))}</dt>`), `${lang} ${id}: the page itself stays ${lang}`);
    }
    // The card with a current translation is untouched, and so is the English page of the changed card.
    assert.ok(!read(stale, placeURL(other.id, lang)).includes(note) && !marksEnglish(read(stale, placeURL(other.id, lang))), `${lang}: other cards stay translated`);
    const directory = read(stale, directoryURL(lang));
    assert.ok(directory.includes(`<p class="field-note">${esc(t('cards.english', {n: 2}))}</p>`), `${lang}: the directory counts the two cards in English`);
    assert.ok(directory.includes('lang="en">Untranslated test card</a>'), lang);
  }
  const english = read(stale, placeURL(target.id, 'en'));
  assert.ok(english.includes(esc(target.intro + changed)) && !marksEnglish(english) && !english.includes('no current translation'), 'the English page has no note');
  // The note is shown exactly for the cards that have no current translation, in the real catalogue as well.
  for (const lang of ['de', 'fr']) {
    const cards = languageLayer(lang).cards(records), note = esc(languageLayer(lang).t('card.inEnglish'));
    for (const a of published) assert.equal(read(output, placeURL(a.id, lang)).includes(note), cards.fallback(a), `${lang} ${a.id}`);
  }
});

test('notices that are over are hidden on German and French pages as in the app, by the date the page is built on', () => {
  const ile = records.find(a => a.id === 'ile');
  for (const lang of ['de', 'fr']) {
    const cards = languageLayer(lang).cards(records), warning = cards.shown(ile).practical.warnings[0];
    assert.ok(warning && warning !== ile.practical.warnings[0], lang + ': the closure notice is translated');
    assert.ok(placePage(ile, regions, '2026-10-10', lang, cards).includes(esc(warning)), lang + ': on the last day of the closure');
    const later = placePage(ile, regions, '2026-10-17', lang, cards);
    assert.ok(!later.includes(esc(warning)) && !later.includes('visit-warnings'), lang + ': gone afterwards, and with it the empty list');
  }
});

test('a page built from one card alone matches it against its own translation; unknown languages are refused', () => {
  const mpe = records.find(a => a.id === 'mpe');
  assert.equal(placePage(mpe, regions, DATE, 'de'), read(output, placeURL('mpe', 'de')));
  assert.equal(placePage(mpe, regions, DATE), read(output, placeURL('mpe', 'en')));
  assert.throws(() => placePage(mpe, regions, DATE, 'it'), /No such page language/);
});
