// Script-free public notices, using the same renderer and stylesheet as the case study.
import fs from 'node:fs';
import path from 'node:path';
import {SITE_ORIGIN} from './site.mjs';
import {caseStudyBody, esc} from './case-study.mjs';

export const LEGAL_LABELS = {
  de: {impressum: 'Impressum', datenschutz: 'Datenschutz', skip: 'Zum Inhalt', app: 'Zur App', language: 'Sprache'},
  fr: {impressum: 'Mentions légales', datenschutz: 'Protection des données', skip: 'Aller au contenu', app: 'Ouvrir l’application', language: 'Langue'},
  en: {impressum: 'Legal notice', datenschutz: 'Privacy', skip: 'Skip to the content', app: 'Open the app', language: 'Language'},
};
// How each language names itself in the language switch of a plain page (the notices, and the place pages).
export const LANGUAGE_NAMES = {de: 'Deutsch', fr: 'Français', en: 'English'};
export const legalURL = (kind, lang) => `/${kind}/${lang === 'de' ? '' : lang + '/'}`;
export const LEGAL_URLS = Object.keys(LEGAL_LABELS).flatMap(lang => ['impressum', 'datenschutz'].map(kind => legalURL(kind, lang)));
export const legalLinks = lang => ['impressum', 'datenschutz'].map(kind => `<a href="${legalURL(kind, lang)}">${LEGAL_LABELS[lang][kind]}</a>`).join(' · ');
// The first sentences of a paragraph, as many as fit in what a search result shows (about 160 characters); the first one always.
export function firstSentences(paragraph, max = 160) {
  let text = '';
  for (const sentence of paragraph.replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ“"«])/)) {
    if (text && (text + ' ' + sentence).length > max) break;
    text += (text ? ' ' : '') + sentence;
  }
  return text;
}
// The description is taken from the notice itself, so that no new wording needs checking: the first sentence or two of the first paragraph
// under the second heading (what stays in the browser; what the entries are).
export function legalDescription(markdown) {
  const blocks = markdown.trim().split(/\n\s*\n/);
  let headings = 0;
  for (const block of blocks) {
    if (/^## /.test(block)) { headings++; continue; }
    if (headings < 2 || /^(#|- |\d+\. |\[)/.test(block)) continue;
    return firstSentences(block);
  }
  throw Error('No paragraph under the second heading for the description');
}
export function generateLegalPages(root, output) {
  for (const [lang, labels] of Object.entries(LEGAL_LABELS)) for (const kind of ['impressum', 'datenschutz']) {
    const url = legalURL(kind, lang);
    const alternates = Object.keys(LEGAL_LABELS).map(code => `<link rel="alternate" hreflang="${code}" href="${SITE_ORIGIN}${legalURL(kind, code)}">`).join('');
    const markdown = fs.readFileSync(path.join(root, 'content', `${kind}.${lang}.md`), 'utf8');
    const body = caseStudyBody(markdown).replaceAll('<code>LICENSE</code>', '<a href="https://github.com/avsomg/minitandem/blob/main/LICENSE">LICENSE</a>');
    const title = `${labels[kind]} · Minitandem`, description = legalDescription(markdown);
    // Like the case study: description, robots, colour scheme, the preview for a shared link. The switch lists every language, the page's own is marked.
    const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light">`
      + `<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="index, follow">`
      + `<link rel="canonical" href="${SITE_ORIGIN}${url}">${alternates}<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${legalURL(kind, 'de')}">`
      + `<meta property="og:site_name" content="Minitandem"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${SITE_ORIGIN}${url}"><meta property="og:type" content="website"><meta name="theme-color" content="#ffffff">`
      + `<link rel="stylesheet" href="/styles.css"><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">`;
    const switcher = Object.keys(LEGAL_LABELS).map(code => `<a href="${legalURL(kind, code)}" hreflang="${code}" lang="${code}"${code === lang ? ' aria-current="page"' : ''}>${LANGUAGE_NAMES[code]}</a>`).join('');
    const html = `<!doctype html><html lang="${lang}"><head>${head}</head><body class="public-page case-page"><a class="skip" href="#content">${labels.skip}</a><div class="topwrap"><header class="wrap top"><a class="mark" href="/">Mini<span>tandem</span></a><nav class="langnav" aria-label="${labels.language}">${switcher}</nav></header></div><main id="content" class="public-content case">${body}</main><footer class="public-footer"><p><a href="/">${labels.app}</a> · ${legalLinks(lang)}</p></footer></body></html>\n`;
    fs.mkdirSync(path.join(output, url), {recursive: true});
    fs.writeFileSync(path.join(output, url, 'index.html'), html);
  }
}
