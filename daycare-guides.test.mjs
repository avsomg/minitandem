// The Daycare guides: every guide in English, German and French with its checked text unchanged, the three versions pointing at each other,
// the sitemap, no script, the way back to the Daycare tab, and the tab's line that opens the guides of the interface language.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {after} from 'node:test';
import {GUIDES, GUIDE_URLS, guideURL, guideSource, guideTitle, guideDescription, guideBody, tabURL, generateDaycareGuides} from './daycare-guides.mjs';
import {PAGE_LANGS, ROOT_LANG, languageLayer} from './place-languages.mjs';
import {LEGAL_LABELS, LANGUAGE_NAMES, legalURL} from './legal-pages.mjs';
import {SITE_ORIGIN} from './site.mjs';
import {loadStack, root} from './test-support.mjs';

const NBSP = String.fromCharCode(160);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'minitandem-guides-'));
after(() => fs.rmSync(output, {recursive: true, force: true}));
const count = generateDaycareGuides(root, output);
const markdown = (slug, lang) => fs.readFileSync(guideSource(root, slug, lang), 'utf8');
const page = (slug, lang) => fs.readFileSync(path.join(output, guideURL(slug, lang), 'index.html'), 'utf8');
const pages = GUIDES.flatMap(slug => PAGE_LANGS.map(lang => ({slug, lang, url: guideURL(slug, lang), html: page(slug, lang)})));
// The text a reader sees: inline tags join their words to the words around them, block tags separate.
const decode = html => html.replace(/<\/?(strong|a|span)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const flat = text => text.replace(/\s+/g, ' ').trim();
// The text of a markdown block as a reader sees it: list and heading marks, bold and link addresses removed.
const plain = block => flat(block.split('\n').map(line => line.replace(/^(#{1,3} | {0,2}- )/, '')).join(' ').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
const article = html => html.match(/<article class="guide">(.*?)<\/article>/s)[1];

test('the four guides of the tab, each in English, German and French, from the texts in content/daycare and nothing else', () => {
  assert.deepEqual(GUIDES, ['getting-a-place', 'what-it-costs', 'when-it-does-not-work', 'settling-in']);
  assert.deepEqual([...loadStack().window.MinitandemChildcare.GUIDE_KEYS], GUIDES, 'the tab and the pages list the same guides');
  assert.equal(count, 12);
  // Only the texts are in the repository: the fact-check and claims files of the authors stay private.
  assert.deepEqual(fs.readdirSync(path.join(root, 'content/daycare')).sort(), GUIDES.flatMap(slug => ['de', 'en', 'fr'].map(lang => `${slug}.${lang}.md`)).sort());
  for (const {slug, lang, url} of pages) {
    assert.equal(url, `/daycare/${slug}/${lang === ROOT_LANG ? '' : lang + '/'}`, 'English where the places\' pages have theirs, German and French beside it');
    assert.ok(fs.existsSync(path.join(output, url, 'index.html')), url);
  }
});

for (const lang of PAGE_LANGS) test(`every sentence of the checked texts is on the guide pages (${lang}), unchanged`, () => {
  for (const slug of GUIDES) {
    const text = markdown(slug, lang), html = page(slug, lang), shown = flat(decode(article(html)));
    for (const block of text.trim().split(/\n\s*\n/)) assert.ok(shown.includes(plain(block)), `${slug}.${lang}: missing on the page: ${plain(block).slice(0, 80)}`);
    assert.equal(html.match(/<h1>(.*?)<\/h1>/)[1].replace(/&#39;/g, "'"), guideTitle(text), slug + '.' + lang);
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.ok(html.includes(`<title>${guideTitle(text).replace(/'/g, '&#39;')} · Minitandem</title>`), slug + '.' + lang);
    // French no-break spaces and typographic apostrophes reach the page as written.
    assert.equal(article(html).split(NBSP).length, text.split(NBSP).length, slug + '.' + lang + ': no-break spaces');
    assert.equal(article(html).split('’').length, text.split('’').length, slug + '.' + lang + ': apostrophes');
    assert.doesNotMatch(article(html), /\*\*|\]\(|^#|<p>- /m, slug + '.' + lang + ': no markdown left on the page');
  }
});

test('the three versions of a guide point at each other, the switch marks the page\'s own language, English is the default', () => {
  for (const {slug, lang, url, html} of pages) {
    assert.ok(html.includes(`<html lang="${lang}">`), url);
    assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}${url}">`), url);
    const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([\w-]+)" href="([^"]+)">/g)].map(m => [m[1], m[2]]);
    assert.deepEqual(alternates, [...PAGE_LANGS.map(code => [code, SITE_ORIGIN + guideURL(slug, code)]), ['x-default', SITE_ORIGIN + guideURL(slug, ROOT_LANG)]], url);
    const nav = html.match(/<nav class="langnav" aria-label="([^"]+)">(.*?)<\/nav>/);
    assert.equal(nav[1], LEGAL_LABELS[lang].language, url);
    const links = [...nav[2].matchAll(/<a href="([^"]+)" hreflang="(\w+)" lang="\w+"( aria-current="page")?>([^<]+)<\/a>/g)];
    assert.deepEqual(links.map(m => m[2]), PAGE_LANGS, url);
    assert.deepEqual(links.filter(m => m[3]).map(m => m[2]), [lang], url);
    for (const m of links) { assert.equal(m[1], guideURL(slug, m[2]), url); assert.equal(m[4], LANGUAGE_NAMES[m[2]], url); }
  }
});

test('every guide page is in the sitemap once, beside the other pages', () => {
  assert.equal(GUIDE_URLS.length, 12);
  assert.deepEqual([...GUIDE_URLS].sort(), pages.map(p => p.url).sort());
  const locs = [...fs.readFileSync(path.join(root, '.publish/sitemap.xml'), 'utf8').matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  assert.equal(new Set(locs).size, locs.length, 'no address twice');
  for (const url of GUIDE_URLS) assert.ok(locs.includes(SITE_ORIGIN + url), url);
  for (const url of GUIDE_URLS) assert.ok(fs.existsSync(path.join(root, '.publish', url, 'index.html')), 'built: ' + url);
});

test('the guide pages carry no script and stay inside the Content-Security-Policy; links to other sites are plain links', () => {
  for (const {url, html} of pages) {
    assert.doesNotMatch(html, /<script|<style|\sstyle=|\son[a-z]+=|<iframe|<object|<embed|<form|@import|javascript:/i, url);
    assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]), ['/styles.css'], url);
    assert.doesNotMatch(html, /\s(?:src|srcset)=/i, url);
    assert.doesNotMatch(html, /target=/, url + ': a link opens in the same window, as on the places\' pages');
    for (const [, href, rest] of html.matchAll(/<a href="([^"]+)"([^>]*)>/g)) {
      if (/^https?:/.test(href)) { assert.match(href, /^https:\/\//, url); assert.equal(rest, ' rel="noopener noreferrer"', url + ' ' + href); }
      else assert.match(href, /^(\/|#content$)/, url + ' ' + href);
    }
    assert.match(html, /<meta name="description" content="[^"]{50,}">/, url);
  }
  // The links of the texts themselves, for example the services for parents in each district.
  const links = [...article(page('when-it-does-not-work', 'en')).matchAll(/<a href="(https:[^"]+)"/g)].map(m => m[1]);
  assert.ok(links.length >= 7 && links.includes('https://www.sei-fribourg.ch/'), String(links));
});

test('every guide leads back to the Daycare tab in its language and has the footer of the plain pages', () => {
  for (const {slug, lang, url, html} of pages) {
    const {t} = languageLayer(lang);
    assert.equal(tabURL(lang), `/?lang=${lang}#view=childcare`);
    assert.ok(html.includes(`<a class="go" href="${tabURL(lang)}">${t('childcare.guides.back')}</a>`), url + ': the button into the tab');
    assert.ok(html.includes(`<nav class="public-breadcrumbs" aria-label="`) && html.includes(`<a href="${tabURL(lang)}">${t('tab.childcare')}</a>`), url + ': the breadcrumb');
    assert.match(html, /<body class="public-page[ "]/, url);
    assert.ok(html.includes(`<a class="skip" href="#content">${LEGAL_LABELS[lang].skip.replace(/'/g, '&#39;')}</a>`), url);
    const footer = html.match(/<footer class="public-footer">(.*?)<\/footer>/)[1];
    assert.ok(footer.includes(`<a href="/">${LEGAL_LABELS[lang].app.replace(/'/g, '&#39;')}</a>`), url);
    for (const kind of ['impressum', 'datenschutz']) assert.ok(footer.includes(`<a href="${legalURL(kind, lang)}">${LEGAL_LABELS[lang][kind]}</a>`), url + ' ' + kind);
    // The list of guides at the end: all four in the page's language, the one being read marked.
    const list = [...html.match(/<nav class="guide-nav"[^>]*>(.*?)<\/nav>/)[1].matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)];
    assert.deepEqual(list.map(m => m[1]), GUIDES.map(other => guideURL(other, lang)), url);
    assert.deepEqual(list.filter(m => m[2]).map(m => m[1]), [url], url);
    assert.deepEqual(list.map(m => m[3].replace(/&#39;/g, "'")), GUIDES.map(other => guideTitle(markdown(other, lang))), url);
  }
});

test('a guide named in another guide\'s text links to it in the same language', () => {
  for (const lang of PAGE_LANGS) {
    const titles = GUIDES.map(slug => ({slug, title: guideTitle(markdown(slug, lang))}));
    // Named as a guide is named: its title in quotation marks ("…", «…», « … »). "Eingewöhnung" in a sentence is not the guide.
    const quoted = (text, title) => new RegExp(`["«]\\s?${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s?["»]`).test(text);
    let named = 0;
    for (const slug of GUIDES) {
      const html = article(page(slug, lang));
      for (const other of titles.filter(item => item.slug !== slug)) if (quoted(markdown(slug, lang), other.title)) {
        named++;
        assert.ok(html.includes(`<a href="${guideURL(other.slug, lang)}">${other.title}</a>`), `${slug}.${lang} names ${other.slug}`);
      }
    }
    assert.equal(named, 3, lang + ': getting-a-place, when-it-does-not-work and settling-in each name another guide');
  }
});

test('the description of a guide is its own first sentences, about one line of a search result, different for every page', () => {
  const seen = new Set();
  for (const {slug, lang, url, html} of pages) {
    const description = guideDescription(markdown(slug, lang));
    // At most 160 characters, unless the first sentence alone is longer (the French settling-in: 176): a sentence is never cut.
    assert.ok(description.length >= 50 && (description.length <= 160 || !/[.!?]\s/.test(description)), url + ': ' + description.length);
    assert.ok(flat(markdown(slug, lang)).includes(flat(description)), url + ': no new wording');
    if (lang === 'fr') assert.ok(!/ [:;?!]/.test(description), url + ': the no-break spaces of the text stay');
    assert.ok(html.includes(`<meta name="description" content="${description.replace(/'/g, '&#39;')}">`), url);
    assert.ok(!seen.has(description), url);
    seen.add(description);
  }
});

test('the guide names of the dictionaries are the titles of the texts, in every language', () => {
  for (const lang of PAGE_LANGS) {
    const {t} = loadStack({lang});
    for (const slug of GUIDES) assert.equal(t('childcare.guide.' + slug), guideTitle(markdown(slug, lang)), slug + '.' + lang);
  }
});

test('the Daycare tab shows the guides of the interface language under its introduction, one line that opens the four links', () => {
  for (const lang of PAGE_LANGS) {
    const {CV, CH, t} = loadStack({lang, today: '2026-10-21'});
    const block = CV.guides();
    assert.ok(block.startsWith(`<details class="more cc-guides"><summary>${t('childcare.guides.title')}</summary><ul class="guide-links">`), lang + ': closed until opened');
    const links = [...block.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)];
    assert.deepEqual(links.map(m => m[1]), GUIDES.map(slug => guideURL(slug, lang)), lang + ': the pages of the interface language');
    assert.deepEqual(links.map(m => m[2].replace(/&#39;/g, "'")), GUIDES.map(slug => guideTitle(markdown(slug, lang))), lang);
    for (const [href] of links.map(m => m.slice(1))) assert.ok(fs.existsSync(path.join(root, '.publish', href, 'index.html')), 'built: ' + href);
    for (const view of ['list', 'map', 'mine']) assert.ok(!CV.box(CH.places.slice(0, 3), {view}).includes('cc-guides'), lang + ' ' + view + ': not at the bottom of the tab');
  }
  assert.equal(loadStack({lang: 'de'}).t('childcare.guides.title'), 'Ratgeber');
  // In the page: between the introduction and the switch of the tab's parts, shown with them once the places are loaded, hidden in the
  // other views, and written again only when its words change, so that an open list stays open while the list below changes.
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(index.indexOf('id="viewLead"') < index.indexOf('<div class="viewguides" id="viewGuides" hidden></div>') && index.indexOf('id="viewGuides"') < index.indexOf('id="viewParts"'));
  assert.match(app, /const guides = CV\.guides\(\); if \(guides !== childcareGuides\) \{ els\.viewGuides\.innerHTML = guides; childcareGuides = guides; \} els\.viewGuides\.hidden = !CH\.loaded;/);
  assert.match(app, /els\.viewLead\.hidden = true; els\.viewGuides\.hidden = true;/);
});

test('the layout of a guide: two levels of lists, bold, links to other sites and a closing note; anything else stops the build', () => {
  assert.equal(guideBody('# T\n\nLead.\n\n- **A:** one\n  - two [x](https://example.org/a?b=1&c=2)\n- three\n\n**Sub**\n\nLast.\nLine.'),
    '<h1>T</h1><p>Lead.</p><ul><li><strong>A:</strong> one<ul><li>two <a href="https://example.org/a?b=1&amp;c=2" rel="noopener noreferrer">x</a></li></ul></li><li>three</li></ul><p><strong>Sub</strong></p><p class="guide-checked">Last.<br>Line.</p>');
  assert.equal(guideBody('# T\n\nSee the guide "Other".\n\nEnd.', [{title: 'Other', url: '/daycare/other/'}]), '<h1>T</h1><p>See the guide &quot;<a href="/daycare/other/">Other</a>&quot;.</p><p class="guide-checked">End.</p>');
  assert.throws(() => guideBody('# T\n\n1. one\n\nEnd.'), /Unknown block/);
  assert.throws(() => guideBody('# T\n\n- a\n  continued\n\nEnd.'), /Unknown list line/);
  assert.throws(() => guideBody('# T\n\nSee [x](http://example.org).\n\nEnd.'), /Unknown mark/);
  assert.throws(() => guideBody('# T\n\nA `code` word.\n\nEnd.'), /Unknown mark/);
  assert.throws(() => guideBody('# T\nNo blank line\n\nEnd.'), /line of its own/);
  assert.throws(() => guideTitle('Text without a title\n'), /title/);
});
