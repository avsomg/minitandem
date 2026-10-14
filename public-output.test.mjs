import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {preparePublicOutput} from './public-output.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minitandem-output-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  return directory;
}

test('each build removes previous public files and accidental private files, retaining only Vercel linkage', t => {
  const root = fixture(t), output = path.join(root, '.publish');
  fs.mkdirSync(path.join(output, '.vercel'), {recursive:true});
  fs.mkdirSync(path.join(output, 'assets'));
  fs.writeFileSync(path.join(output, '.vercel', 'project.json'), '{"projectId":"expected"}');
  fs.writeFileSync(path.join(output, '.gitignore'), '.vercel');
  fs.writeFileSync(path.join(output, 'private.json'), 'must-not-survive');
  fs.writeFileSync(path.join(output, 'assets', 'old.png'), 'stale');
  preparePublicOutput(output);
  assert.deepEqual(fs.readdirSync(output), ['.vercel']);
  assert.equal(fs.readFileSync(path.join(output, '.vercel', 'project.json'), 'utf8'), '{"projectId":"expected"}');
  preparePublicOutput(output);
  assert.deepEqual(fs.readdirSync(output), ['.vercel']);
});

test('fresh output is created, and output symlinks never remove external files', t => {
  const root = fixture(t), fresh = path.join(root, '.publish'), external = path.join(root, 'external');
  preparePublicOutput(fresh);
  assert.deepEqual(fs.readdirSync(fresh), []);
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep.txt'), 'keep');
  const linked = path.join(root, 'linked');
  fs.symlinkSync(external, linked);
  assert.throws(() => preparePublicOutput(linked), /Unsafe public output/);
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep');
  fs.symlinkSync(external, path.join(fresh, '.vercel'));
  assert.throws(() => preparePublicOutput(fresh), /Unsafe Vercel metadata/);
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep');
  fs.unlinkSync(path.join(fresh, '.vercel'));
  fs.symlinkSync(path.join(root, 'missing'), path.join(fresh, '.vercel'));
  assert.throws(() => preparePublicOutput(fresh), /Unsafe Vercel metadata/);
});
