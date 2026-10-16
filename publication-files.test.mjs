import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {PRIVATE} from './editorial/public-audit.mjs';
import {PUBLIC_GATES} from './editorial/agent-run.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const policy=JSON.parse(read('editorial/agent-policy.json'));

test('the role table of both READMEs states the models and efforts of agent-policy.json',()=>{
  for(const file of ['README.md','README.de.md']){
    const text=read(file);
    for(const [role,config] of Object.entries(policy.roles)){
      const row=text.split('\n').find(line=>line.startsWith(`| ${role} |`));
      assert.ok(row,`${file}: no row for ${role}`);
      const cells=row.split('|').map(cell=>cell.trim().replace(/`/g,''));
      if(config.model===null){
        assert.ok(cells.slice(3,7).every(cell=>cell!==''),`${file}: ${role} row is incomplete`);
        assert.doesNotMatch(row,/claude-|gpt-/,`${file}: ${role} has no model`);
        continue;
      }
      assert.equal(cells[3],config.claudeModel,`${file}: ${role} Claude model`);
      assert.equal(cells[4],config.effort,`${file}: ${role} effort`);
      assert.equal(cells[5],config.criticalEffort,`${file}: ${role} effort on critical fields`);
      assert.equal(cells[6],config.model,`${file}: ${role} earlier route`);
    }
  }
  assert.equal(policy.workerProvider,'claude');
});

test('both READMEs carry the honesty section, the licence, the badge and the commands',()=>{
  const en=read('README.md'),de=read('README.de.md');
  // The owner's decision of 14 October 2026: MIT for the code, no licence for the catalogue data.
  assert.match(read('LICENSE'),/^MIT License\n\nCopyright \(c\) 2026 /);
  assert.equal(JSON.parse(read('package.json')).license,'MIT');
  assert.match(en,/^The code is under the MIT licence \(`LICENSE`\)\. It does not cover the catalogue data/m);
  assert.match(de,/^Der Code steht unter der MIT-Lizenz \(`LICENSE`\)\. Sie gilt nicht für die Katalogdaten/m);
  for(const text of [en,de])assert.match(text,/\[!\[tests\]\(https:\/\/github\.com\/avsomg\/minitandem\/actions\/workflows\/test\.yml\/badge\.svg\)\]/);
  assert.match(en,/OpenAI Codex wrote the code until 8 October 2026; Claude Code has done so since then/);
  assert.match(en,/does not write the code himself/);
  assert.match(en,/history of this repository starts at its first commit/);
  assert.match(de,/OpenAI Codex hat den Code bis zum 8\. Oktober 2026 geschrieben, seither Claude Code/);
  assert.match(de,/Er schreibt den Code nicht selbst/);
  for(const command of ['npm test','npm run demo','npm run build','npm run test:browser','npm run setup'])for(const text of [en,de])assert.ok(text.includes(command),command);
  for(const text of [en,de])assert.match(text,/Playwright/);
  assert.match(en,/Playwright and axe-core are exact devDependencies/);
  assert.match(de,/Playwright und axe-core sind devDependencies mit exakten Versionen/);
  assert.match(en,/Node\.js 24\.12\.0/);
  // The README lists the private-only tests; every one of them is skipped by an explicit "private-only:" message in its test file.
  const sources=['catalog.test.mjs','editorial/corrections.test.mjs','editorial/external-pipeline.test.mjs','editorial/external-review.test.mjs','catalogue-i18n.test.mjs'].map(read).join('\n');
  const listed=[...en.matchAll(/^\d\. `([\w./-]+)`: (.+)$/gm)];
  assert.equal(listed.length,7);
  for(const [,file,title] of listed){
    assert.ok(read(file).includes(title),`${file} has no test titled "${title}"`);
  }
  assert.equal((sources.match(/skip:(?:PRIVATE_SKIP|SKIP_[A-Z]+)/g)||[]).length,7,'exactly seven tests are private-only');
  // Each skip reason is a constant; every one of them must start with "private-only:".
  const defined=(sources.match(/const (?:PRIVATE_SKIP|SKIP_[A-Z]+)=/g)||[]).length;
  assert.ok(defined>0);
  assert.equal((sources.match(/const (?:PRIVATE_SKIP|SKIP_[A-Z]+)=[^;]*?\?false:\s*'private-only:/g)||[]).length,defined,'every skip reason starts with private-only:');
});

test('package.json: a root test, build, demo and a separate browser script; browser tools are locked devDependencies',()=>{
  const pkg=JSON.parse(read('package.json'));
  for(const script of ['test','build','demo','test:browser'])assert.ok(pkg.scripts[script],script);
  assert.match(pkg.scripts.test,/--test \*\.test\.mjs editorial\/\*\.test\.mjs/);
  assert.doesNotMatch(pkg.scripts.test,/verify|playwright/i,'the default test never needs a browser');
  assert.match(pkg.scripts['test:browser'],/scripts\/browser-checks\.mjs/);
  assert.match(read('scripts/browser-checks.mjs'),/verify-age\.mjs[\s\S]*verify-mobile\.mjs/);
  assert.equal(pkg.dependencies,undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(),['axe-core','playwright']);
  const lock=JSON.parse(read('package-lock.json'));
  for(const [name,version] of Object.entries(pkg.devDependencies)){
    assert.match(version,/^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[''].devDependencies[name],version);
    assert.equal(lock.packages['node_modules/'+name].version,version);
    assert.match(lock.packages['node_modules/'+name].resolved,/^https:\/\/registry\.npmjs\.org\//);
    assert.ok(lock.packages['node_modules/'+name].integrity);
  }
  assert.equal(pkg.private,true);
  assert.equal(read('.nvmrc').trim(),pkg.engines.node.replace('>=',''));
  const editorial=JSON.parse(read('editorial/package.json'));
  assert.equal(JSON.stringify(editorial).includes('playwright'),false);
});

test('the CI workflow installs the pipeline dependencies with npm ci and runs npm test on push and pull request',()=>{
  const workflow=read('.github/workflows/test.yml');
  assert.match(workflow,/^on:\s*\n\s+push:\s*\n\s+pull_request:/m);
  assert.match(workflow,/run: npm ci\s*\n\s+working-directory: editorial/);
  assert.match(workflow,/run: npm test/);
  assert.match(workflow,/run: git diff --exit-code/);
  assert.match(workflow,/node-version-file: \.nvmrc/);
  assert.match(workflow,/permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(workflow,/secrets\./);
  assert.doesNotMatch(workflow,/\bdeploy\b|ssh|docker login|vercel/i,'the workflow only tests');
});

test('CI and the local QA run the strict public audit and the public scan after the build, as the same commands',()=>{
  const pkg=JSON.parse(read('package.json')),workflow=read('.github/workflows/test.yml');
  assert.equal(pkg.scripts['audit:public'],'node editorial/public-audit.mjs --strict');
  assert.equal(pkg.scripts['scan:public'],'node scripts/scan-public.mjs');
  // CI: npm test builds the site first (pretest), the audit needs that site, and the generated-files check comes last.
  assert.equal(pkg.scripts.pretest,'npm run build');
  const order=['run: npm test','run: npm run audit:public','run: npm run scan:public','run: git diff --exit-code'].map(step=>workflow.indexOf(step));
  assert.ok(order.every(position=>position>0)&&order.every((position,index)=>!index||position>order[index-1]),'npm test, audit:public, scan:public, git diff, in that order');
  // QA: the same two commands, after its own build and before the tests of the built files.
  assert.deepEqual(PUBLIC_GATES.map(([,args])=>['node',...args].join(' ')),[pkg.scripts['audit:public'],pkg.scripts['scan:public']]);
  const source=read('editorial/agent-run.mjs'),qa=source.slice(source.indexOf('export function qaRun'));
  const steps=["['build',['build.mjs']]",'...PUBLIC_GATES',"['unit',"].map(step=>qa.indexOf(step));
  assert.ok(steps.every(position=>position>0)&&steps[0]<steps[1]&&steps[1]<steps[2],'QA: build, public gates, unit tests');
});

test('.gitignore names every private path of the audit, and the account identity of the release',()=>{
  const lines=new Set(read('.gitignore').split('\n').map(line=>line.trim()));
  for(const item of PRIVATE)assert.ok(lines.has(item)||lines.has(item.replace(/\/$/,''))||/(^|\/)node_modules\/$/.test(item)&&lines.has('node_modules/'),`${item} is not ignored`);
  for(const item of ['editorial/release-identity.json','.env','.playwright-path','.DS_Store','.publish/','server-state/'])assert.ok(lines.has(item),item);
  // The tracked policy holds no account identifiers; the example file holds placeholders.
  assert.equal(/prj_|team_/.test(read('editorial/agent-policy.json')),false);
  assert.equal(/"projectId":\s*"prj_[A-Za-z0-9]{20,}/.test(read('editorial/release-identity.example.json')),false);
});

test('the documents exist and are in the language they promise',()=>{
  for(const file of ['docs/publication-scope.md','docs/betrieb.md','docs/architektur.md','README.md','README.de.md'])assert.ok(fs.existsSync(path.join(root,file)),file);
  for(const file of ['docs/betrieb.md','docs/architektur.md','README.de.md'])assert.match(read(file),/\b(?:und|der|die|das|nicht|wird)\b/,file+' is German');
  assert.doesNotMatch(read('docs/publication-scope.md'),/\b(?:und|nicht|wird|werden)\b/,'the scope document is English');
});
