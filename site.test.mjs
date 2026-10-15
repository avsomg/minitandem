import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {SITE_ORIGIN} from './site.mjs';
import {SCRIPTS,LAZY_SCRIPTS,STATIC,ASSETS,LAZY_ASSETS,GENERATED,BUILD_INFO} from './ui-files.mjs';
import {root} from './test-support.mjs';

const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('the site origin is one constant and the static files agree with it',()=>{
  assert.equal(SITE_ORIGIN,'https://minitandem.ch');
  const index=read('index.html');
  assert.ok(index.includes(`<link rel="canonical" href="${SITE_ORIGIN}/">`));
  assert.ok(index.includes(`<meta property="og:url" content="${SITE_ORIGIN}/">`));
  assert.ok(read('robots.txt').includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`));
  // No other site origin is named in the static files.
  for(const file of ['index.html','robots.txt','manifest.webmanifest','vercel.json'])
    for(const [origin] of read(file).matchAll(/https?:\/\/[a-z0-9.-]+/gi))
      assert.ok([SITE_ORIGIN,'https://wmts.geo.admin.ch','https://openapi.vercel.sh','https://www.w3.org'].includes(origin)||/^https?:\/\/(?:localhost|127\.0\.0\.1)/.test(origin),file+' names '+origin);
  for(const file of ['server.mjs','public-pages.mjs','build.mjs'])assert.ok(!read(file).includes('https://minitandem.ch'),file+' must import the constant instead of repeating it');
});
test('the page is English by default, light only, and named Minitandem',()=>{
  const index=read('index.html');
  assert.match(index,/<html lang="en">/);
  assert.match(index,/<meta name="color-scheme" content="light">/);
  assert.match(index,/<title>Minitandem/);
  const manifest=JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.short_name,'Minitandem');assert.match(manifest.name,/^Minitandem/);assert.equal(manifest.lang,'en');
  assert.equal(manifest.theme_color,'#ffffff');
  assert.ok(!/prefers-color-scheme\s*:\s*dark/.test(read('styles.css')),'light theme only');
});
test('index.html loads exactly the scripts in ui-files.mjs, in that order, without inline code or outside hosts',()=>{
  const index=read('index.html');
  const loaded=[...index.matchAll(/<script src="([^"]+)"[^>]*><\/script>/g)].map(m=>m[1]);
  assert.deepEqual(loaded,SCRIPTS);
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(index),'no inline script (the policy only allows own files)');
  assert.ok(!/\son[a-z]+="/.test(index),'no inline event handlers');
  assert.ok(!/<link[^>]+href="https?:/.test(index.replace(/rel="canonical"[^>]*/g,'')),'no external stylesheet or font');
  for(const file of [...STATIC,...SCRIPTS,...LAZY_SCRIPTS])assert.ok(fs.existsSync(path.join(root,file)),file);
  for(const file of LAZY_SCRIPTS)assert.ok(!index.includes(file),file+' is loaded only for its language, by app.js');
  for(const file of ASSETS)assert.ok(fs.existsSync(path.join(root,'assets',file)),file);
});
test('the Vercel allow-list names every published file and nothing private',()=>{
  const allowed=read('.vercelignore').split('\n').filter(line=>line.startsWith('!')).map(line=>line.slice(1));
  for(const file of [...STATIC,...GENERATED,BUILD_INFO,...SCRIPTS,...LAZY_SCRIPTS].filter(f=>f!=='.vercelignore'))assert.ok(allowed.includes(file),file+' is published but not allowed through');
  for(const file of ASSETS.filter(f=>!/^(?:lucide\.min\.js|LUCIDE-LICENSE)$/.test(f)))assert.ok(allowed.includes('assets/'+file),file);
  assert.ok(!allowed.some(item=>/editorial|archive-ru|server|\.test\.|verify/.test(item)));
  assert.ok(!allowed.includes('assets/lucide.min.js'),'the admin panel icons stay off the public site');
  for(const file of LAZY_ASSETS)assert.ok(allowed.includes('assets/'+file));
});
test('the security policy keeps scripts and styles to the site itself',()=>{
  const headers=JSON.parse(read('vercel.json')).headers[0].headers;
  const csp=headers.find(h=>h.key==='Content-Security-Policy').value;
  assert.match(csp,/script-src 'self'(?:;|$)/);assert.match(csp,/style-src 'self'(?:;|$)/);assert.match(csp,/object-src 'none'/);
});
