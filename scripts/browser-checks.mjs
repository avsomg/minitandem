// The browser checks of the release check ("mobile-ages" and "mobile-flow"): the same two files that the QA stage runs on a snapshot
// of the build. They drive WebKit through Playwright, which is not a declared dependency (see README and playwright-loader.mjs).
// Usage: npm run test:browser   (after npm run build; APP_URL overrides the page that is tested)
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const built=path.join(root,'.publish','index.html');
if(!process.env.APP_URL&&!fs.existsSync(built)){console.error('No built site. Run npm run build first, or set APP_URL.');process.exit(1);}
const env={...process.env,APP_URL:process.env.APP_URL||pathToFileURL(built).href};
for(const file of ['verify-age.mjs','verify-mobile.mjs']){
  console.log(`\n== ${file}`);
  const run=spawnSync(process.execPath,[path.join(root,file)],{cwd:root,stdio:'inherit',env});
  if(run.status!==0){console.error(`\n${file} failed (exit ${run.status}).`);process.exit(run.status||1);}
}
console.log('\nBrowser checks passed.');
