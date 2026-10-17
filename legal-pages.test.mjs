import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {generateLegalPages,LEGAL_URLS,LEGAL_LABELS,legalURL,legalDescription} from './legal-pages.mjs';
import {loadStack} from './test-support.mjs';
import {SITE_ORIGIN} from './site.mjs';
const root=path.dirname(new URL(import.meta.url).pathname);
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('six script-free notices have canonical and alternate links, contacts, and translated footers',t=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-legal-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  generateLegalPages(root,output);
  assert.equal(LEGAL_URLS.length,6);
  for(const lang of ['de','fr','en'])for(const kind of ['impressum','datenschutz']){
    const url=legalURL(kind,lang),html=fs.readFileSync(path.join(output,url,'index.html'),'utf8');
    assert.ok(html.includes(`<html lang="${lang}">`));
    assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}${url}">`));
    for(const other of ['de','fr','en'])assert.ok(html.includes(`hreflang="${other}" href="${SITE_ORIGIN}${legalURL(kind,other)}"`));
    assert.ok(html.includes(`hreflang="x-default" href="${SITE_ORIGIN}${legalURL(kind,'de')}"`));
    assert.match(html,/<link rel="stylesheet" href="\/styles.css">/);
    assert.doesNotMatch(html,/<script|<style|\sstyle=|\son[a-z]+=|[\u0400-\u04ff]/i);
    assert.ok(html.includes('Alex Shamrai'));assert.ok(html.includes('Hauptstrasse 15, 1716 Plaffeien, '+{de:'Schweiz',fr:'Suisse',en:'Switzerland'}[lang]));
    assert.deepEqual([...new Set(html.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi))],['hello@minitandem.ch']);
    const footer=html.match(/<footer\b[^>]*>(.*?)<\/footer>/s)[1];
    for(const key of ['impressum','datenschutz'])assert.ok(footer.includes(`href="${legalURL(key,lang)}">${LEGAL_LABELS[lang][key]}</a>`));
    if(kind==='datenschutz')for(const fact of ['wmts.geo.admin.ch','Google Maps','IPv4','IPv6','/24','/48','Infomaniak Network SA','Gmail'])assert.ok(html.includes(fact));
  }
});

test('built app, project pages, directory and every card link to existing legal pages, with sitemap entries',()=>{
  const sitemap=read('.publish/sitemap.xml');
  for(const url of LEGAL_URLS)assert.ok(sitemap.includes(`<loc>${SITE_ORIGIN}${url}</loc>`));
  const pages=['.publish/index.html','.publish/projekt/index.html','.publish/projekt/en/index.html','.publish/places/index.html'];
  for(const folder of fs.readdirSync(path.join(root,'.publish/places'),{withFileTypes:true}).filter(entry=>entry.isDirectory()))pages.push(`.publish/places/${folder.name}/index.html`);
  for(const file of pages){
    const html=read(file),lang=file.includes('/projekt/index')?'de':file.endsWith('.publish/index.html')?'de':'en';
    const footer=html.match(/<footer\b[^>]*>(.*?)<\/footer>/s)[1];
    for(const kind of ['impressum','datenschutz'])assert.ok(footer.includes(`href="${legalURL(kind,lang)}"`),file+' '+kind);
  }
  assert.match(read('app.js'),/node\.dataset\.legal.*I\.lang\(\)/);
});

test('legal footer labels match the dictionaries and French notice typography uses no-break spaces',()=>{
  for(const lang of ['de','fr','en']){
    const {t}=loadStack({lang});
    assert.equal(t('foot.impressum'),LEGAL_LABELS[lang].impressum);assert.equal(t('foot.privacy'),LEGAL_LABELS[lang].datenschutz);
  }
  for(const kind of ['impressum','datenschutz']){
    const text=read(`content/${kind}.fr.md`);
    assert.doesNotMatch(text,/ [;:?!]|« | »/);
  }
});

test('every notice has a description taken from its own text, the preview tags of the case study, and a language switch that marks the page\'s own language',t=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-legal-head-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  generateLegalPages(root,output);
  const descriptions=new Map();
  for(const lang of ['de','fr','en'])for(const kind of ['impressum','datenschutz']){
    const url=legalURL(kind,lang),html=fs.readFileSync(path.join(output,url,'index.html'),'utf8'),where=url;
    const description=html.match(/<meta name="description" content="([^"]+)">/)?.[1];
    assert.ok(description,where+': a meta description');
    assert.equal(html.match(/<meta name="description"/g).length,1,where);
    assert.ok(description.length>=60&&description.length<=170,where+': about one line of a search result, not '+description.length);
    assert.equal(description,legalDescription(read(`content/${kind}.${lang}.md`)).replace(/&/g,'&amp;'),where);
    assert.ok(read(`content/${kind}.${lang}.md`).replace(/\s+/g,' ').includes(description),where+': the description is the notice\'s own sentence, no new wording');
    assert.ok(!descriptions.has(description),where+': a description of its own');descriptions.set(description,url);
    for(const tag of [`<meta name="color-scheme" content="light">`,`<meta name="robots" content="index, follow">`,`<meta property="og:description" content="${description}">`,`<meta property="og:title" content="${LEGAL_LABELS[lang][kind]} · Minitandem">`,
      `<meta property="og:url" content="${SITE_ORIGIN}${url}">`,`<meta name="theme-color" content="#ffffff">`])assert.ok(html.includes(tag),where+': '+tag);
    // One switch with every language side by side, in a nav named in the page's language; only the page's own language is current.
    const nav=html.match(/<nav class="langnav" aria-label="([^"]+)">(.*?)<\/nav>/);
    assert.equal(nav[1],LEGAL_LABELS[lang].language,where);
    const links=[...nav[2].matchAll(/<a href="([^"]+)" hreflang="(\w+)" lang="\w+"( aria-current="page")?>/g)];
    assert.deepEqual(links.map(m=>m[2]),['de','fr','en'],where);
    assert.deepEqual(links.filter(m=>m[3]).map(m=>m[2]),[lang],where+': exactly the own language is aria-current');
    for(const m of links)assert.equal(m[1],legalURL(kind,m[2]),where);
  }
  assert.equal(descriptions.size,6);
});

test('the language switch of the notices is one pill with a gap, never wrapped into rows, and the current language is black on the page\'s ink',()=>{
  const css=read('styles.css');
  assert.match(css,/\.langnav \{[^}]*display: flex;[^}]*gap: 2px;[^}]*border-radius: 999px;/);
  assert.match(css,/\.langnav a \{[^}]*min-height: 44px;/);
  assert.match(css,/\.langnav a\[aria-current="page"\] \{[^}]*background: var\(--t\); color: var\(--inv\);/);
  assert.match(css,/\.top \{[^}]*flex-wrap: wrap;/,'the header wraps on every page, so the switch goes on its own line when the logo leaves no room');
  assert.match(css,/\.top \.seg \{ margin-left: auto;/);
});

test('the description of a notice is the first sentences under its second heading, at most about one line of a search result',()=>{
  assert.equal(legalDescription('# T\n\nStand: 1.\n\n## A\n\nOwner.\n\n## B\n\n- list\n\nOne here. Two there. Three. '+'Word '.repeat(40)),'One here. Two there. Three.');
  assert.equal(legalDescription('# T\n\n## A\n\nx\n\n## B\n\nOnly one sentence'),'Only one sentence');
  assert.throws(()=>legalDescription('# T\n\n## A\n\nOwner'),/second heading/);
});
