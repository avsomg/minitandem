import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {generateLegalPages,LEGAL_URLS,LEGAL_LABELS,legalURL} from './legal-pages.mjs';
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
    assert.ok(html.includes('Alex Shamrai'));assert.ok(html.includes('Hauptstrasse 15, 1716 Plaffeien, Schweiz'));
    assert.deepEqual([...new Set(html.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi))],['hello@minitandem.ch']);
    const footer=html.match(/<footer\b[^>]*>(.*?)<\/footer>/s)[1];
    for(const key of ['impressum','datenschutz'])assert.ok(footer.includes(`href="${legalURL(key,lang)}">${LEGAL_LABELS[lang][key]}</a>`));
    if(kind==='datenschutz')for(const fact of ['wmts.geo.admin.ch','Google Maps','IPv4','IPv6','/24','/48','Authorization','Cookie'])assert.ok(html.includes(fact));
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
