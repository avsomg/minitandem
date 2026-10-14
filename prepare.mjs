// One-off helper: copies the Lucide icon bundle and its licence into assets/ (used by the editorial admin panel only).
// Usage: node prepare.mjs DIR, where DIR is a node_modules folder that contains lucide/dist/umd/lucide.min.js and lucide/LICENSE.
// The copies are already in assets/; this is only needed to update them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = process.argv[2] || process.env.MINITANDEM_ICON_SOURCE;
if (!runtime) throw Error('Usage: node prepare.mjs DIR (a node_modules folder with lucide/dist/umd/lucide.min.js)');
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.copyFileSync(path.join(runtime, 'lucide/dist/umd/lucide.min.js'), path.join(root, 'assets/lucide.min.js'));
fs.copyFileSync(path.join(runtime, 'lucide/LICENSE'), path.join(root, 'assets/LUCIDE-LICENSE'));
console.log('Local icons and license copied. Run build.mjs for the public catalogue.');
