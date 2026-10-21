// The guides for parents next to the Daycare tab: four short texts (content/daycare/<slug>.<lang>.md), one plain page per guide and language.
// Addresses as for the places' pages: English at /daycare/<slug>/, German and French beside it at /daycare/<slug>/de/ and /fr/ (i18n.js
// guidePage, which the tab's links use too). The texts are checked as written, so this file only lays them out; it never rewrites a sentence.
// Like the notices and the places' pages, a guide carries no script and uses styles.css, inside the site's Content-Security-Policy. The words
// around a text (language switch, the way back to the tab, the list of guides, footer) are the app's own, from its dictionaries.
import fs from 'node:fs';
import path from 'node:path';
import {SITE_ORIGIN} from './site.mjs';
import {esc} from './case-study.mjs';
import {LEGAL_LABELS, LANGUAGE_NAMES, legalLinks, firstSentences} from './legal-pages.mjs';
import {PAGE_LANGS, ROOT_LANG, PAGE_TEXT, languageLayer} from './place-languages.mjs';

// The guides in the order of the tab's list (childcare.js GUIDE_KEYS), and the address of one in a language.
export const GUIDES = languageLayer(ROOT_LANG).guides;
export const guideURL = (slug, lang) => languageLayer(lang).guidePage(slug);
export const GUIDE_URLS = GUIDES.flatMap(slug => PAGE_LANGS.map(lang => guideURL(slug, lang)));
// Where a page leads back to: the Daycare tab of the app, in the page's language.
export const tabURL = lang => `/?lang=${lang}#view=childcare`;
export const guideSource = (root, slug, lang) => path.join(root, 'content', 'daycare', `${slug}.${lang}.md`);
export const guideTitle = markdown => {
  const title = markdown.match(/^# (.+)\n/);
  if (!title) throw Error('A guide starts with its title: # …');
  return title[1];
};
// The description is the guide's own first paragraph, as far as a search result shows it: no new wording.
export function guideDescription(markdown) {
  const lead = markdown.trim().split(/\n\s*\n/)[1] || '';
  if (!lead || /^(#|- )/.test(lead)) throw Error('A guide has a paragraph under its title for the description');
  return firstSentences(lead.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The marks the guides use: **bold** and [text](https://…). A link to another site is a plain link, as on the places' pages (no new window,
// rel="noopener noreferrer"). The title of another guide, quoted in the text ("…", «…», « … »), links to that guide in the same language.
function inline(text, others) {
  let html = esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  if (/\*\*|\]\(|`/.test(html)) throw Error('Unknown mark in a guide: ' + text);
  for (const {title, url} of others) {
    const quoted = new RegExp(`(&quot;|«\\s?)(${escapeRegExp(esc(title))})(\\s?»|&quot;)`, 'g');
    html = html.replace(quoted, (all, open, name, close) => `${open}<a href="${url}">${name}</a>${close}`);
  }
  return html;
}
// A list of two levels: "- item", and "  - item" under the item before it.
function list(lines, others) {
  const items = [];
  for (const line of lines) {
    const top = line.match(/^- (.+)$/), sub = line.match(/^ {2}- (.+)$/);
    if (top) items.push({text: top[1], sub: []});
    else if (sub && items.length) items.at(-1).sub.push(sub[1]);
    else throw Error('Unknown list line in a guide: ' + line);
  }
  return `<ul>${items.map(item => `<li>${inline(item.text, others)}${item.sub.length ? `<ul>${item.sub.map(sub => `<li>${inline(sub, others)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`;
}
// others: [{title, url}] of the other guides in the same language. Anything a guide does not use is refused, so that a new mark in a text
// stops the build instead of reaching the page as written.
export function guideBody(markdown, others = []) {
  const blocks = markdown.trim().split(/\n\s*\n/);
  return blocks.map((block, index) => {
    const lines = block.split('\n'), first = lines[0];
    const heading = first.match(/^(#{1,3}) (.+)$/);
    if (heading) {
      if (lines.length > 1) throw Error('A heading has a line of its own: ' + first);
      return `<h${heading[1].length}>${inline(heading[2], others)}</h${heading[1].length}>`;
    }
    if (/^- /.test(first)) return list(lines, others);
    if (/^(\s|\d+\. |[>#|*+])/.test(first) && !/^\*\*/.test(first)) throw Error('Unknown block in a guide: ' + first);
    // The last block says when the text was checked and that rules change; its lines stay lines.
    if (index === blocks.length - 1) return `<p class="guide-checked">${lines.map(line => inline(line.trim(), others)).join('<br>')}</p>`;
    return `<p>${inline(lines.map(line => line.trim()).join(' '), others)}</p>`;
  }).join('');
}

// texts: {slug: {lang: markdown}} of every guide.
function page(slug, lang, texts) {
  const {t} = languageLayer(lang), labels = LEGAL_LABELS[lang], markdown = texts[slug][lang];
  const urls = Object.fromEntries(PAGE_LANGS.map(code => [code, guideURL(slug, code)])), own = urls[lang];
  const title = guideTitle(markdown), description = guideDescription(markdown), pageTitle = `${title} · Minitandem`;
  const others = GUIDES.filter(other => other !== slug).map(other => ({title: guideTitle(texts[other][lang]), url: guideURL(other, lang)}));
  const alternates = PAGE_LANGS.map(code => `<link rel="alternate" hreflang="${code}" href="${SITE_ORIGIN}${urls[code]}">`).join('')
    + `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${urls[ROOT_LANG]}">`;
  const switcher = `<nav class="langnav" aria-label="${esc(labels.language)}">${PAGE_LANGS.map(code => `<a href="${urls[code]}" hreflang="${code}" lang="${code}"${code === lang ? ' aria-current="page"' : ''}>${LANGUAGE_NAMES[code]}</a>`).join('')}</nav>`;
  // Every guide in the order of the tab, this one marked: the same list as in the tab.
  const guides = `<nav class="guide-nav" aria-labelledby="guides"><h2 id="guides">${esc(t('childcare.guides.title'))}</h2><ul class="guide-links">`
    + GUIDES.map(other => `<li><a href="${guideURL(other, lang)}"${other === slug ? ' aria-current="page"' : ''}>${esc(t('childcare.guide.' + other))}</a></li>`).join('') + '</ul></nav>';
  const body = `<nav class="public-breadcrumbs" aria-label="${esc(PAGE_TEXT[lang].breadcrumb)}"><a href="${tabURL(lang)}">${esc(t('tab.childcare'))}</a><span>${esc(t('childcare.guides.title'))}</span></nav>`
    + `<article class="guide">${guideBody(markdown, others)}</article>`
    + `<p class="public-actions"><a class="go" href="${tabURL(lang)}">${esc(t('childcare.guides.back'))}</a></p>${guides}`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light">`
    + `<title>${esc(pageTitle)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="index, follow">`
    + `<link rel="canonical" href="${SITE_ORIGIN}${own}">${alternates}`
    + `<meta property="og:site_name" content="Minitandem"><meta property="og:title" content="${esc(pageTitle)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${SITE_ORIGIN}${own}"><meta property="og:type" content="article">`
    + `<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(pageTitle)}"><meta name="twitter:description" content="${esc(description)}"><meta name="theme-color" content="#ffffff">`
    + `<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"><link rel="stylesheet" href="/styles.css"></head>`
    + `<body class="public-page case-page"><a class="skip" href="#content">${esc(labels.skip)}</a><div class="topwrap"><header class="wrap top"><a class="mark" href="/" aria-label="Minitandem">Mini<span>tandem</span></a>${switcher}</header></div>`
    + `<main id="content" class="public-content case">${body}</main><footer class="public-footer"><p><a href="/">${esc(labels.app)}</a> · ${legalLinks(lang)}</p></footer></body></html>\n`;
}

// Writes every guide in every language; a missing text stops the build. Returns the number of pages.
export function generateDaycareGuides(root, output) {
  const texts = Object.fromEntries(GUIDES.map(slug => [slug, Object.fromEntries(PAGE_LANGS.map(lang => [lang, fs.readFileSync(guideSource(root, slug, lang), 'utf8')]))]));
  for (const slug of GUIDES) for (const lang of PAGE_LANGS) {
    const dir = path.join(output, guideURL(slug, lang));
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'index.html'), page(slug, lang, texts));
  }
  return GUIDES.length * PAGE_LANGS.length;
}
