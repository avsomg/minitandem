// The link preview (og:image) of the home page and the case study: 1200 x 630, black on white like the site, no small text.
// Run on the Mac that builds releases: node scripts/og-image.mjs. It writes assets/og-minitandem.png, which is committed.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPlaywright} from '../playwright-loader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets', 'og-minitandem.png');
const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1200px; height: 630px; background: #fff; color: #0d0d0d; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
         box-sizing: border-box; padding: 96px 104px; display: flex; flex-direction: column; justify-content: space-between; }
  .head { display: flex; align-items: center; gap: 32px; }
  .mark { font-size: 112px; font-weight: 600; letter-spacing: -0.035em; line-height: 1; }
  .mark span { font-weight: 400; color: #636363; }
  .line { font-size: 56px; font-weight: 400; letter-spacing: -0.02em; line-height: 1.15; margin: 0; }
  .name { font-size: 40px; font-weight: 500; color: #636363; margin: 0; }
</style></head><body>
  <div class="head"><svg width="112" height="112" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#0d0d0d"/><g fill="none" stroke="#fff" stroke-width="3.2"><circle cx="19" cy="24" r="8.5"/><circle cx="29" cy="24" r="8.5"/></g></svg>
  <div class="mark">Mini<span>tandem</span></div></div>
  <p class="line">gebaut und betrieben mit KI-Agenten</p>
  <p class="name">Alex Shamrai</p>
</body></html>`;

// WebKit, the engine of the local browser checks (scripts/browser-support.mjs).
const browser = await loadPlaywright().webkit.launch({headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1200, height: 630}, deviceScaleFactor: 1});
  await page.setContent(html);
  await page.screenshot({path: out, type: 'png'});
} finally {
  await browser.close();
}
console.log(out);
