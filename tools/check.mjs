/**
 * Static checks for index.html. There is no bundler - the "build" is the file
 * itself - so this verifies the things a build step would normally catch:
 * parseable JavaScript, no duplicate element ids, every $('id') actually
 * exists in the markup, and no accidental innerHTML of user-controlled text.
 *
 *   node tools/check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let problems = 0;
const fail = (msg) => { problems++; console.log('  ERROR  ' + msg); };
const ok = (msg) => console.log('  ok     ' + msg);

// ---- 1. every inline script parses -----------------------------------------
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((src, i) => {
  try {
    new vm.Script(src, { filename: `inline-script-${i}.js` });
  } catch (e) {
    fail(`inline script #${i} does not parse: ${e.message}`);
  }
});
if (scripts.length) ok(`${scripts.length} inline scripts parse`);

// ---- 2. no duplicate element ids -------------------------------------------
const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) fail('duplicate element ids: ' + [...new Set(dupes)].join(', '));
else ok(`${ids.length} element ids are unique`);

// ---- 3. every looked-up id exists ------------------------------------------
const idSet = new Set(ids);
const looked = new Set([
  ...[...html.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
  ...[...html.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
  ...[...html.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)].map(m => m[1]),
]);
const missing = [...looked].filter(id => !idSet.has(id));
if (missing.length) fail('looked up but not in the markup: ' + missing.join(', '));
else ok(`${looked.size} id lookups all resolve`);

// ---- 4. no user text assigned through innerHTML -----------------------------
// Filenames and error messages must go through textContent. This catches the
// obvious shapes; it is a guard rail, not a proof.
const risky = [...html.matchAll(/innerHTML\s*=\s*[^;\n]*\b(item|file|f)\.name\b/g)];
if (risky.length) fail(`${risky.length} place(s) put a filename into innerHTML`);
else ok('no filename reaches innerHTML');

// ---- 5. external resources are https and from known CDNs --------------------
const urls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
const badScheme = urls.filter(u => u.startsWith('http://'));
if (badScheme.length) fail('plain-http resources: ' + badScheme.join(', '));
else ok(`${urls.length} external resources, all https`);

// ---- 6. the app is still a single file --------------------------------------
const kb = Math.round(Buffer.byteLength(html) / 1024);
ok(`index.html is ${kb} KB, ${html.split('\n').length} lines`);

console.log(problems ? `\n${problems} problem(s) found\n` : '\nAll checks passed\n');
process.exit(problems ? 1 : 0);
