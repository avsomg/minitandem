import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {loadPlaywright,playwrightLocations} from './playwright-loader.mjs';

function folder(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-playwright-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return directory;
}
const fakePlaywright=(directory,name)=>{
  const module=path.join(directory,'node_modules','playwright');
  fs.mkdirSync(module,{recursive:true});
  fs.writeFileSync(path.join(module,'package.json'),'{"name":"playwright","main":"index.js"}');
  fs.writeFileSync(path.join(module,'index.js'),`module.exports={webkit:${JSON.stringify(name)}};`);
};

test('Playwright is looked up in the environment variable, then in .playwright-path, then in the repository',t=>{
  const base=folder(t),fromEnv=folder(t),fromFile=folder(t);
  assert.deepEqual(playwrightLocations({env:{},base}),[base]);
  fs.writeFileSync(path.join(base,'.playwright-path'),fromFile+'\nignored second line\n');
  assert.deepEqual(playwrightLocations({env:{MINITANDEM_PLAYWRIGHT_DIR:fromEnv},base}),[fromEnv,fromFile,base]);
  fakePlaywright(base,'base');fakePlaywright(fromFile,'file');
  assert.equal(loadPlaywright({env:{},base}).webkit,'file');
  fakePlaywright(fromEnv,'env');
  assert.equal(loadPlaywright({env:{MINITANDEM_PLAYWRIGHT_DIR:fromEnv},base}).webkit,'env');
  fs.rmSync(path.join(base,'.playwright-path'));
  assert.equal(loadPlaywright({env:{},base}).webkit,'base');
});

test('without Playwright the error names npm ci, local overrides and the searched locations',t=>{
  const base=folder(t);
  assert.throws(()=>loadPlaywright({env:{},base}),error=>/Run npm ci/.test(error.message)&&error.message.includes(base)&&/MINITANDEM_PLAYWRIGHT_DIR/.test(error.message));
});
