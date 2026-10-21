import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.dirname(new URL(import.meta.url).pathname);
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
// Every rule of the stylesheet, also those inside @media: [{selectors, body}].
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({selectors: selector.split(',').map(item => item.trim()), body}));
const specificity = selector => {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
  const tags = (selector.replace(/\.[\w-]+|#[\w-]+|\[[^\]]*\]|::?[\w-]+/g, ' ').match(/[a-z][\w-]*/gi) || []).length;
  return [ids, classes, tags];
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function builtPublicPages() {
  const pages = ['projekt/index.html', 'projekt/en/index.html', 'places/index.html'];
  for (const kind of ['impressum', 'datenschutz']) for (const lang of ['', 'fr/', 'en/']) pages.push(`${kind}/${lang}index.html`);
  for (const guide of fs.readdirSync(path.join(root, '.publish/daycare'))) for (const lang of ['', 'de/', 'fr/']) pages.push(`daycare/${guide}/${lang}index.html`);
  for (const folder of fs.readdirSync(path.join(root, '.publish/places'), {withFileTypes: true}).filter(entry => entry.isDirectory())) {
    pages.push(`places/${folder.name}/index.html`);
    for (const lang of ['de', 'fr']) if (fs.existsSync(path.join(root, `.publish/places/${folder.name}/${lang}/index.html`))) pages.push(`places/${folder.name}/${lang}/index.html`);
  }
  return pages.map(file => ({file, html: read('.publish/' + file)}));
}

test('every dark .go button on a public page gets the inverse text colour, whatever link rule the page also has', () => {
  const pages = builtPublicPages(), withButton = pages.filter(page => /<a class="go[ "]/.test(page.html));
  // The page types that have the button: every place card, the case study in both languages and every Daycare guide.
  assert.ok(withButton.filter(page => /^places\/[^/]+\/index\.html$/.test(page.file)).length > 100);
  // The German and French page of a place has the button too.
  for (const lang of ['de', 'fr']) assert.ok(withButton.filter(page => page.file.endsWith(`/${lang}/index.html`) && page.file.split('/').length === 4).length > 100, lang);
  assert.deepEqual(withButton.filter(page => page.file.startsWith('projekt/')).map(page => page.file).sort(), ['projekt/en/index.html', 'projekt/index.html']);
  assert.equal(withButton.filter(page => page.file.startsWith('daycare/')).length, 12, 'every guide in three languages');
  for (const {file, html} of withButton) assert.match(html, /<body class="public-page[ "]/, `${file}: .go needs the public-page class for its rule`);
  const goRule = rules.find(rule => rule.selectors.includes('.public-page a.go'));
  assert.ok(goRule && /(^|;|\s)color:\s*var\(--inv\)/.test(goRule.body), '.public-page a.go must set color: var(--inv)');
  // Any other rule that colours a link inside a public page ranks lower than the button's rule. The old .case-actions a.go rule
  // covered one page type only, and .public-content a painted the label dark (13,13,13 on 13,13,13) on the place pages.
  const own = specificity('.public-page a.go');
  for (const rule of rules) for (const selector of rule.selectors) {
    if (!/(^|\s)a$/.test(selector) || !/\.public-/.test(selector) || !/(^|;|\s)color:/.test(rule.body)) continue;
    assert.ok(compare(specificity(selector), own) < 0, `${selector} would win over .public-page a.go`);
  }
  // A visible focus ring: the global rule draws 2 px in the text colour with an offset, and nothing on public pages removes it.
  assert.ok(rules.some(rule => rule.selectors.includes(':focus-visible') && /outline:\s*2px solid var\(--t\)/.test(rule.body)));
  for (const rule of rules) if (rule.selectors.some(selector => /\.(go|public-)/.test(selector))) assert.doesNotMatch(rule.body, /outline:\s*(none|0)/, rule.selectors.join(', '));
});

test('page titles on public pages use the whole column, and "Web-App" never breaks at its hyphen', () => {
  const title = rules.find(rule => rule.selectors.includes('.public-content h1'));
  assert.match(title.body, /max-width:\s*none/, 'the global 22ch cap squeezed the title to 400 px on wide screens');
  assert.ok(rules.some(rule => rule.selectors.includes('.nb') && /white-space:\s*nowrap/.test(rule.body)));
  const german = read('.publish/projekt/index.html').match(/<h1>(.*?)<\/h1>/)[1];
  assert.equal(german, 'Minitandem: eine <span class="nb">Web-App</span>, gebaut und betrieben mit <span class="nb">KI-Agenten</span>');
  assert.equal(german.replace(/<[^>]+>/g, ''), 'Minitandem: eine Web-App, gebaut und betrieben mit KI-Agenten', 'the wording is untouched');
  // Titles without a hyphenated word stay as they are.
  assert.equal(read('.publish/projekt/en/index.html').match(/<h1>(.*?)<\/h1>/)[1], 'Minitandem: a web app built and run with AI agents');
  assert.equal(read('.publish/datenschutz/index.html').match(/<h1>(.*?)<\/h1>/)[1], 'Datenschutzerklärung');
});

test('the home page footer waits for the first list, stays in the page, and shows at once without scripting', () => {
  const html = read('index.html'), app = read('app.js');
  const footer = html.match(/<footer class="foot">[\s\S]*?<\/footer>/)[0];
  assert.match(footer, /href="places\/"/);
  assert.match(footer, /data-legal="impressum"/);
  assert.match(footer, /data-legal="datenschutz"/);
  // Hidden only where scripts run and only until app.js has rendered; the class is added even if rendering throws.
  assert.match(css, /@media \(scripting: enabled\)\s*\{\s*body:not\(\.ready\) \.foot\s*\{\s*display:\s*none;\s*\}\s*\}/);
  assert.equal((css.match(/body:not\(\.ready\)/g) || []).length, 1);
  assert.match(app, /try \{ render\(\); \} finally \{ document\.body\.classList\.add\('ready'\); \}/);
  assert.doesNotMatch(footer, /\shidden\b|style=/);
  // Room kept for what the first render adds above the list, so nothing there moves either.
  assert.match(rules.find(rule => rule.selectors.includes('.fchips')).body, /min-height:\s*44px/);
  assert.match(rules.find(rule => rule.selectors.includes('.fp b')).body, /min-height:\s*1\.25em/);
});
