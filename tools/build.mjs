/**
 * Deploy staging step.
 *
 * The app needs no build - index.html is the deliverable and works on its own.
 * This only exists because static hosts (Vercel, Netlify, Cloudflare Pages)
 * expect a directory to publish. It runs the static checks, then copies the
 * app into public/ so the deployed site contains the app and nothing else -
 * no docs, no tests, no node_modules.
 *
 *   node tools/build.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public');

// 1. Refuse to publish something that does not pass the static checks.
const check = spawnSync(process.execPath, [path.join(root, 'tools', 'check.mjs')], {
  stdio: 'inherit',
});
if (check.status !== 0) process.exit(check.status ?? 1);

// 2. Stage the files that make up the published site.
const assets = ['index.html'];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const name of assets) {
  fs.copyFileSync(path.join(root, name), path.join(outDir, name));
}

const bytes = assets.reduce((n, f) => n + fs.statSync(path.join(outDir, f)).size, 0);
console.log(`Staged ${assets.length} file(s) into public/ (${Math.round(bytes / 1024)} KB)\n`);
