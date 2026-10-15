import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {scan} from './scripts/scan-public.mjs';

// Values are assembled from parts so that this file does not trip the scan itself.
const planted={
  'private-key':'-----BEGIN '+'RSA PRIVATE KEY-----',
  'api-token':'sk'+'-ant-'+'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  'vercel-identifier':'prj'+'_'+'a1B2c3D4e5F6g7H8i9J0k1L2',
  'personal-computer-path':'/'+'Users/someone/Documents/project',
  'cyrillic':String.fromCharCode(0x41f,0x440,0x438,0x432,0x435,0x442)
};

function project(t,files){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-scan-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  for(const [name,text] of Object.entries(files)){
    fs.mkdirSync(path.dirname(path.join(directory,name)),{recursive:true});
    fs.writeFileSync(path.join(directory,name),text);
  }
  return directory;
}

test('the publication scan finds secrets, identifiers, personal paths and Cyrillic text',t=>{
  const files=Object.fromEntries(Object.entries(planted).map(([rule,value])=>[rule+'.txt','line one\nvalue: '+value+'\n']));
  const report=scan(project(t,files));
  for(const rule of Object.keys(planted))assert.ok(report.findings.some(f=>f.rule===rule&&f.file===rule+'.txt'&&f.line===2),rule);
});

test('contact data is counted in the catalogue files and is a finding anywhere else',t=>{
  const contact='info'+'@organiser.ch, 026 123 '+'99 99';
  const report=scan(project(t,{'data.js':contact,'notes.md':contact,'fixture.test.mjs':'info@example.org and 026 000 00 00'}));
  assert.deepEqual(report.catalogue.files['data.js'],{emails:1,phones:1});
  assert.deepEqual(report.findings.map(f=>f.rule).sort(),['email-outside-catalogue','phone-outside-catalogue']);
  assert.ok(report.findings.every(f=>f.file==='notes.md'));
});

test('the project address in the README is not a finding, another address at the domain is',t=>{
  const report=scan(project(t,{'README.md':'Contact: hello'+'@minitandem.ch','notes.md':'anna'+'@minitandem.ch'}));
  assert.deepEqual(report.findings.map(f=>`${f.file}:${f.rule}`),['notes.md:email-outside-catalogue']);
});

test('a public URL path that contains the word Users is not a personal computer path',t=>{
  const report=scan(project(t,{'urls.json':'"https://commune.example.org/fileadmin/WWW/Users/Culture/list.pdf"'}));
  assert.deepEqual(report.findings,[]);
});

test('without git, files that .gitignore names are not scanned',t=>{
  const value='/'+'Users/someone/Documents/project';
  const report=scan(project(t,{'.gitignore':'.publish/\nlocal-settings.json\nprivate/state/\n','.publish/page.html':value,'local-settings.json':value,'private/state/a.json':value,'kept.txt':value}));
  assert.deepEqual(report.findings.map(f=>f.file),['kept.txt']);
});

// The command CI and QA run: node scripts/scan-public.mjs DIRECTORY. A finding gives its exit code 1; the report names file, line and rule, never the value.
test('the command fails on a forbidden public file and passes on a clean tree',t=>{
  const script=fileURLToPath(new URL('./scripts/scan-public.mjs',import.meta.url)),run=directory=>spawnSync(process.execPath,[script,directory],{encoding:'utf8'});
  const clean=run(project(t,{'README.md':'Playgroups in canton Fribourg','data.js':'window.ACTIVITIES=[{"contacts":[{"email":"info'+'@organiser.ch"}]}];'}));
  assert.equal(clean.status,0);assert.deepEqual(JSON.parse(clean.stdout).findings,[]);
  for(const [rule,value] of Object.entries(planted)){
    const failed=run(project(t,{'docs/notes.md':'one\n'+value+'\n'}));
    assert.equal(failed.status,1,rule);assert.deepEqual(JSON.parse(failed.stdout).findings,[{file:'docs/notes.md',line:2,rule}]);
    assert.equal(failed.stdout.includes(value),false,rule+': the value is not printed');
  }
  const contact=run(project(t,{'docs/notes.md':'Write to anna.muster'+'@organiser.ch'}));
  assert.equal(contact.status,1);assert.deepEqual(JSON.parse(contact.stdout).findings.map(f=>f.rule),['email-outside-catalogue']);
});
