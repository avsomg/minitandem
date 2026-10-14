import fs from 'node:fs';
import path from 'node:path';

export function preparePublicOutput(output) {
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe public output directory');
  } else {
    fs.mkdirSync(output, {recursive:true});
  }
  // Vercel project linkage is deployment metadata, not a generated public file.
  const metadata = path.join(output, '.vercel');
  const stat = fs.lstatSync(metadata, {throwIfNoEntry:false});
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe Vercel metadata directory');
  }
  for (const entry of fs.readdirSync(output)) {
    if (entry !== '.vercel') fs.rmSync(path.join(output, entry), {recursive:true, force:true});
  }
}
