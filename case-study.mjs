// The case-study page: /projekt/ in German, /projekt/en/ in English, built from content/fallstudie.de.md and .en.md.
// The texts are checked as written, so this file only lays them out; it never rewrites a sentence. The pages carry no
// script and use styles.css, which keeps them inside the site's Content-Security-Policy. Notes in [square brackets] are
// layout instructions from the text's author: they become the buttons and the diagram, or are left out.
import fs from 'node:fs';
import path from 'node:path';
import {SITE_ORIGIN} from './site.mjs';

const REPOSITORY = 'https://github.com/avsomg/minitandem';
const PAGES = {
  de: {source: 'fallstudie.de.md', dir: 'projekt', url: '/projekt/', prefix: '../', skip: 'Zum Inhalt'},
  en: {source: 'fallstudie.en.md', dir: 'projekt/en', url: '/projekt/en/', prefix: '../../', skip: 'Skip to the content'},
};
const SWITCH = {de: 'Deutsch', en: 'English'};
const BUTTONS = {'Zur App': '/', 'Open the app': '/', 'Code auf GitHub': REPOSITORY, 'Code on GitHub': REPOSITORY};

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
function inline(text) {
  return esc(text)
    .replace(/\[`docs\/architektur\.md`\]/g, `<a href="${REPOSITORY}/blob/main/docs/architektur.md"><code>docs/architektur.md</code></a>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/hello@minitandem\.ch/g, '<a href="mailto:hello@minitandem.ch">hello@minitandem.ch</a>')
    .replace(/(?<![/\w])github\.com\/avsomg(?![/\w])/g, '<a href="https://github.com/avsomg">github.com/avsomg</a>');
}

// "[Knöpfe:] Zur App · Code auf GitHub · [Video, sobald V8 fertig ist]": bracketed items are not built yet.
function buttons(line) {
  const items = line.replace(/^\[[^\]]+:\]\s*/, '').split(' · ').filter(item => !item.startsWith('['));
  return `<p class="public-actions case-actions">${items.map((label, index) => {
    if (!BUTTONS[label]) throw Error(`No address for the button "${label}"`);
    return `<a class="${index ? 'ghost' : 'go'}" href="${BUTTONS[label]}">${esc(label)}</a>`;
  }).join('')}</p>`;
}
// "[Schema, 5 Kästchen in einer Reihe:] A (who) → B (who) → …": one box per step, the actor under the step.
function diagram(text) {
  const steps = text.replace(/^\[[^\]]+:\]\s*/, '').split(' → ').map(step => step.match(/^(.+?) \((.+)\)$/));
  if (steps.some(step => !step)) throw Error('Diagram step without an actor in brackets');
  return `<ol class="case-flow">${steps.map(([, step, actor]) => `<li><strong>${esc(step)}</strong><span>${esc(actor)}</span></li>`).join('')}</ol>`;
}

export function caseStudyBody(markdown) {
  const html = [];
  for (const block of markdown.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n'), first = lines[0];
    if (/^\[(Quelle|Source)\b/.test(first)) continue;
    if (/^\[(Knöpfe|Buttons):\]/.test(first)) { html.push(buttons(lines.join(' '))); continue; }
    if (/^\[(Schema|Diagram)\b/.test(first)) { html.push(diagram(lines.map(line => line.trim()).join(' '))); continue; }
    const heading = first.match(/^(#{1,3}) (.+)$/);
    if (heading && lines.length === 1) { html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
    const list = /^- /.test(first) ? 'ul' : /^\d+\. /.test(first) ? 'ol' : null;
    if (list) {
      // An item may continue on indented lines.
      const items = [];
      for (const line of lines) {
        if (/^(- |\d+\. )/.test(line)) items.push(line.replace(/^(- |\d+\. )/, ''));
        else items[items.length - 1] += ' ' + line.trim();
      }
      html.push(`<${list}>${items.map(item => `<li>${inline(item)}</li>`).join('')}</${list}>`);
      continue;
    }
    if (/^\[/.test(first)) throw Error(`Unknown layout note: ${first}`);
    html.push(`<p>${inline(lines.map(line => line.trim()).join(' '))}</p>`);
  }
  return html.join('');
}

function page(lang, markdown) {
  const own = PAGES[lang], other = lang === 'de' ? 'en' : 'de';
  const title = markdown.match(/^# (.+)$/m)[1];
  const description = markdown.split('\n').find(line => line && !line.startsWith('#'));
  const alternates = Object.entries(PAGES).map(([code, p]) => `<link rel="alternate" hreflang="${code}" href="${SITE_ORIGIN}${p.url}">`).join('')
    + `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${PAGES.de.url}">`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light">`
    + `<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="index, follow">`
    + `<link rel="canonical" href="${SITE_ORIGIN}${own.url}">${alternates}`
    + `<meta property="og:site_name" content="Minitandem"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${SITE_ORIGIN}${own.url}"><meta property="og:type" content="article"><meta name="theme-color" content="#ffffff">`
    + `<link rel="icon" href="${own.prefix}assets/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="${own.prefix}assets/apple-touch-icon.png"><link rel="stylesheet" href="${own.prefix}styles.css"></head>`
    + `<body class="public-page case-page"><a class="skip" href="#content">${esc(own.skip)}</a><div class="topwrap"><header class="wrap top"><a class="mark" href="/" aria-label="Minitandem">Mini<span>tandem</span></a>`
    + `<a class="ghost" href="${PAGES[other].url}" hreflang="${other}" lang="${other}">${SWITCH[other]}</a></header></div>`
    + `<main id="content" class="public-content case">${caseStudyBody(markdown)}</main></body></html>\n`;
}

export const CASE_STUDY_URLS = Object.values(PAGES).map(p => p.url);
export function generateCaseStudy(root, output) {
  for (const [lang, own] of Object.entries(PAGES)) {
    const markdown = fs.readFileSync(path.join(root, 'content', own.source), 'utf8');
    fs.mkdirSync(path.join(output, own.dir), {recursive: true});
    fs.writeFileSync(path.join(output, own.dir, 'index.html'), page(lang, markdown));
  }
}
