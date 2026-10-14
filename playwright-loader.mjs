// The browser checks (verify*.mjs, screenshots.mjs) drive WebKit through Playwright. Playwright is not a declared dependency
// of this repository (nothing is installed by default), so it is looked up in this order:
//   1. the directory named by MINITANDEM_PLAYWRIGHT_DIR (a folder that has playwright in its node_modules)
//   2. the first line of the file .playwright-path in the repository root (a local file, ignored by git)
//   3. the repository itself, after `npm install --no-save playwright` or with NODE_PATH set
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));

export function playwrightLocations({env=process.env,base=root}={}){
  const places=[];
  if(env.MINITANDEM_PLAYWRIGHT_DIR)places.push(path.resolve(env.MINITANDEM_PLAYWRIGHT_DIR));
  try{
    const line=fs.readFileSync(path.join(base,'.playwright-path'),'utf8').split(/\r?\n/)[0].trim();
    if(line)places.push(path.resolve(line));
  }catch{}
  places.push(base);
  return places;
}

export function loadPlaywright({env=process.env,base=root,requireFrom=directory=>createRequire(path.join(directory,'package.json'))}={}){
  const places=playwrightLocations({env,base}),errors=[];
  for(const directory of places){
    try{return requireFrom(directory)('playwright');}
    catch(error){errors.push(`${directory}: ${error.code||error.message}`);}
  }
  throw Error('Playwright was not found. It is not a declared dependency of this repository. Install it yourself '+
    '(for example: npm install --no-save playwright && npx playwright install webkit), or point MINITANDEM_PLAYWRIGHT_DIR '+
    'or the file .playwright-path at a folder that has it. Tried: '+errors.join('; '));
}
