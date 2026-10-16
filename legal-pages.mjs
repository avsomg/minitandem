// Script-free public notices, using the same renderer and stylesheet as the case study.
import fs from 'node:fs';
import path from 'node:path';
import {SITE_ORIGIN} from './site.mjs';
import {caseStudyBody} from './case-study.mjs';

export const LEGAL_LABELS = {
  de: {impressum: 'Impressum', datenschutz: 'Datenschutz', skip: 'Zum Inhalt', app: 'Zur App'},
  fr: {impressum: 'Mentions légales', datenschutz: 'Protection des données', skip: 'Aller au contenu', app: 'Ouvrir le répertoire'},
  en: {impressum: 'Legal notice', datenschutz: 'Privacy', skip: 'Skip to the content', app: 'Open the directory'},
};
export const legalURL = (kind, lang) => `/${kind}/${lang === 'de' ? '' : lang + '/'}`;
export const LEGAL_URLS = Object.keys(LEGAL_LABELS).flatMap(lang => ['impressum', 'datenschutz'].map(kind => legalURL(kind, lang)));
export const legalLinks = lang => ['impressum', 'datenschutz'].map(kind => `<a href="${legalURL(kind, lang)}">${LEGAL_LABELS[lang][kind]}</a>`).join(' · ');
export function generateLegalPages(root, output) {
  for (const [lang, labels] of Object.entries(LEGAL_LABELS)) for (const kind of ['impressum', 'datenschutz']) {
    const url = legalURL(kind, lang);
    const alternates = Object.keys(LEGAL_LABELS).map(code => `<link rel="alternate" hreflang="${code}" href="${SITE_ORIGIN}${legalURL(kind, code)}">`).join('');
    const markdown = fs.readFileSync(path.join(root, 'content', `${kind}.${lang}.md`), 'utf8');
    const body = caseStudyBody(markdown).replaceAll('<code>LICENSE</code>', '<a href="https://github.com/avsomg/minitandem/blob/main/LICENSE">LICENSE</a>');
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${labels[kind]} · Minitandem</title><link rel="canonical" href="${SITE_ORIGIN}${url}">${alternates}<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${legalURL(kind, 'de')}"><link rel="stylesheet" href="/styles.css"><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"></head><body class="public-page case-page"><a class="skip" href="#content">${labels.skip}</a><div class="topwrap"><header class="wrap top"><a class="mark" href="/">Mini<span>tandem</span></a><nav aria-label="Language">${Object.keys(LEGAL_LABELS).map(code => `<a class="ghost" href="${legalURL(kind, code)}" hreflang="${code}" lang="${code}"${code === lang ? ' aria-current="page"' : ''}>${{de:'Deutsch',fr:'Français',en:'English'}[code]}</a>`).join('')}</nav></header></div><main id="content" class="public-content case">${body}</main><footer class="public-footer"><p><a href="/">${labels.app}</a> · ${legalLinks(lang)}</p></footer></body></html>\n`;
    fs.mkdirSync(path.join(output, url), {recursive: true});
    fs.writeFileSync(path.join(output, url, 'index.html'), html);
  }
}
