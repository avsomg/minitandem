import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {generateCaseStudy} from './case-study.mjs';
import {SITE_ORIGIN} from './site.mjs';

const root = path.dirname(new URL(import.meta.url).pathname);
// Inline tags join their text to the words around them; block tags separate.
const decode = html => html.replace(/<\/?(code|strong|a|span)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const flat = text => text.replace(/\s+/g, ' ').trim();
// The text of a markdown block as a reader sees it: markers and layout notes removed. A list marker counts only in a block that is a list,
// as for the page: in a paragraph, a line may start with "3. Oktober" when the sentence before ends in "2. und".
const plain = block => {
  const marker = /^(- |\d+\. )/.test(block) ? /^(#{1,3} |- |\d+\. )/ : /^#{1,3} /;
  return flat(block.split('\n').map(line => line.replace(marker, '')).join(' ')
    .replace(/\[`docs\/architektur\.md`\]/g, 'docs/architektur.md').replace(/\*\*|`/g, ''));
};

test('the case study and the home page share one link preview of 1200 x 630; English quotes on the German page are marked as English', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minitandem-case-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  generateCaseStudy(root, dir);
  const png = fs.readFileSync(path.join(root, 'assets', 'og-minitandem.png'));
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
  const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const html of [fs.readFileSync(path.join(dir, 'projekt/index.html'), 'utf8'), fs.readFileSync(path.join(dir, 'projekt/en/index.html'), 'utf8'), home]) {
    assert.ok(html.includes(`<meta property="og:image" content="${SITE_ORIGIN}/assets/og-minitandem.png">`));
    assert.match(html, /<meta property="og:image:width" content="1200">\s*<meta property="og:image:height" content="630">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  }
  const german = fs.readFileSync(path.join(dir, 'projekt/index.html'), 'utf8'), english = fs.readFileSync(path.join(dir, 'projekt/en/index.html'), 'utf8');
  for (const quote of ['children aged 2 to 4 years', 'Registration is not needed']) assert.ok(german.includes(`«<span lang="en">${quote}</span>»`), quote);
  assert.doesNotMatch(english, /<span lang=/);
  assert.ok(english.includes('<a class="skip" href="#content">Skip to content</a>'));
  // The section of the review is about the app, not about sending one application.
  assert.doesNotMatch(german, /Versand/); assert.doesNotMatch(english, /sending/i);
});

for (const [lang, url, file] of [['de', '/projekt/', 'fallstudie.de.md'], ['en', '/projekt/en/', 'fallstudie.en.md']]) {
  test(`case study (${lang}): every sentence of the checked text is on the page, unchanged`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minitandem-case-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    generateCaseStudy(root, dir);
    const html = fs.readFileSync(path.join(dir, url, 'index.html'), 'utf8');
    const text = flat(decode(html));
    const markdown = fs.readFileSync(path.join(root, 'content', file), 'utf8');
    for (const block of markdown.trim().split(/\n\s*\n/)) {
      if (block.startsWith('[')) continue; // layout notes: buttons, diagram, source note
      assert.ok(text.includes(plain(block)), `missing on the page: ${plain(block).slice(0, 80)}`);
    }
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}${url}">`));
    for (const [code, href] of [['de', '/projekt/'], ['en', '/projekt/en/'], ['x-default', '/projekt/']])
      assert.ok(html.includes(`<link rel="alternate" hreflang="${code}" href="${SITE_ORIGIN}${href}">`), code);
    // Inside the site's Content-Security-Policy: no script, no inline style; nothing from other hosts but links.
    assert.doesNotMatch(html, /<script|<style|\sstyle=|\son[a-z]+=/i);
    assert.doesNotMatch(html, /(src|href)="https?:\/\/(?!minitandem\.ch|github\.com)/);
    assert.doesNotMatch(html, /[\u0400-\u04FF]/);
    assert.equal((html.match(/<ol class="case-flow">/g) || []).length, 1);
    assert.equal((html.match(/<ol class="case-flow">.*?<\/ol>/s)[0].match(/<li>/g) || []).length, 5);
    assert.ok(html.includes('href="https://github.com/avsomg/minitandem"') && html.includes('class="go" href="/"'));
    assert.ok(html.includes('href="https://github.com/avsomg/minitandem/blob/main/docs/architektur.md"'));
    assert.ok(html.includes('<code>npm run demo</code>'));
    assert.doesNotMatch(text, /\[(Video|Knöpfe|Buttons|Schema|Diagram|Quelle|Source)/);
  });
}
