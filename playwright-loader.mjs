// Local overrides keep their precedence; CI uses the exact dependency installed by npm ci.
// MINITANDEM_PLAYWRIGHT_DIR and .playwright-path name a folder with playwright in node_modules.
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
  throw Error('Playwright was not found. Run npm ci to install the declared dependency '+
    '(browser binaries are installed separately on CI), or point MINITANDEM_PLAYWRIGHT_DIR '+
    'or the file .playwright-path at a folder that has it. Tried: '+errors.join('; '));
}
