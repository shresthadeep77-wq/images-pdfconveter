/**
 * Browser-driven test + benchmark suite for Studio Pro.
 *
 * The app is a single self-contained index.html with no build step, so these
 * tests drive a real browser against the real page rather than importing
 * modules. They exercise the parts that decide whether 1000+ files are
 * practical: import, virtualisation, selection, ordering, error handling,
 * cancellation and PDF generation.
 *
 * Usage:
 *   node tests/run-tests.mjs                 # default batches (100, 250, 500, 1000)
 *   node tests/run-tests.mjs --sizes 100,2000
 *   node tests/run-tests.mjs --headed
 *
 * Requires a Chromium that Playwright can drive. Point at one with
 * CHROME_PATH=... if it is not discovered automatically.
 */

import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(path.join(here, '..', 'index.html')).href;

const args = process.argv.slice(2);
const sizes = (readFlag('--sizes') || '100,250,500,1000').split(',').map(Number);
const headed = args.includes('--headed');

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    process.env.HOME && path.join(process.env.HOME, '.cache', 'ms-playwright'),
  ].filter(Boolean);
  const names = [
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win', 'chrome.exe'],
    ['chrome-linux', 'chrome'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      if (!dir.startsWith('chromium')) continue;
      for (const parts of names) {
        const p = path.join(root, dir, ...parts);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) if (fs.existsSync(p)) return p;
  return null;
}

// ---------------------------------------------------------------- test runner
let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${expected}, got ${actual})`);
}

// ------------------------------------------------------- in-page file factory
/**
 * Builds N synthetic image Files of mixed sizes directly in the page and feeds
 * them through the real import path. `broken` files carry an image extension
 * but garbage bytes, which is how we test per-file error isolation.
 */
const makeFilesInPage = `
async (opts) => {
  const { count, broken = 0, prefix = 'img' } = opts;
  const files = [];
  // A handful of distinct sizes, reused, so generation stays fast.
  const shapes = [[64, 64], [320, 240], [800, 600], [1600, 1200]];
  const blobs = [];
  for (const [w, h] of shapes) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#E8541E'); g.addColorStop(1, '#2D7D7B');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
    blobs.push(await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8)));
  }
  for (let i = 0; i < count; i++) {
    const b = blobs[i % blobs.length];
    files.push(new File([b], prefix + '_' + i + '.jpg',
      { type: 'image/jpeg', lastModified: 1700000000000 + i }));
  }
  for (let i = 0; i < broken; i++) {
    files.push(new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
      'broken_' + i + '.jpg', { type: 'image/jpeg', lastModified: 1800000000000 + i }));
  }
  return files;
}`;

async function importFiles(page, opts) {
  return page.evaluate(async ({ opts, factory }) => {
    const make = eval('(' + factory + ')');
    const files = await make(opts);
    const t0 = performance.now();
    await window.handleFiles(files, opts.target || 'auto');
    return { ms: Math.round(performance.now() - t0), made: files.length };
  }, { opts, factory: makeFilesInPage });
}

const reset = (page) => page.evaluate(() => {
  window.Studio.state.images.length = 0;
  window.Studio.state.pdfs.length = 0;
  window.Studio.state.conversionFiles.length = 0;
  window.Studio.state.selectedIds.clear();
  window.Studio.knownFiles.clear();
  window.Studio.state.searchQuery = '';
  document.getElementById('searchInput').value = '';
  window.renderAll();
});

/** Longest single main-thread block observed over `ms`, via rAF sampling. */
const measureLongestFrame = (page, ms) => page.evaluate((duration) => new Promise(resolve => {
  let worst = 0, last = performance.now();
  const end = last + duration;
  (function tick() {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    if (now < end) requestAnimationFrame(tick);
    else resolve(Math.round(worst));
  })();
}), ms);

// ------------------------------------------------------------------- the suite
async function main() {
  const executablePath = findChrome();
  if (!executablePath) {
    console.error('No Chromium found. Set CHROME_PATH to a Chrome/Chromium binary.');
    process.exit(2);
  }

  const browser = await chromium.launch({ executablePath, headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  await page.goto(pageUrl);
  await page.waitForFunction(() => typeof window.handleFiles === 'function', { timeout: 20000 });

  console.log('\nStudio Pro test suite');
  console.log('=====================\n');

  console.log('Core behaviour');

  await test('imports a small batch and shows every file', async () => {
    await reset(page);
    await importFiles(page, { count: 12 });
    const n = await page.evaluate(() => window.Studio.state.images.length);
    assertEqual(n, 12, 'image count after import');
    const shown = await page.evaluate(() => document.getElementById('fileCount').textContent);
    assertEqual(shown, '12', 'header file count');
  });

  await test('skips exact duplicates on re-import', async () => {
    await reset(page);
    await importFiles(page, { count: 10 });
    await importFiles(page, { count: 10 });     // identical name/size/mtime
    assertEqual(await page.evaluate(() => window.Studio.state.images.length), 10, 'count after duplicate import');
  });

  await test('rejects unsupported and oversized files', async () => {
    await reset(page);
    const r = await page.evaluate(async () => {
      const big = new File([new Uint8Array(51 * 1024 * 1024)], 'huge.jpg', { type: 'image/jpeg' });
      const weird = new File([new Uint8Array(10)], 'notes.xyz', { type: '' });
      await window.handleFiles([big, weird], 'auto');
      return window.Studio.state.images.length + window.Studio.state.conversionFiles.length;
    });
    assertEqual(r, 0, 'nothing accepted');
  });

  await test('removes a file and releases its thumbnail', async () => {
    await reset(page);
    await importFiles(page, { count: 5 });
    const after = await page.evaluate(() => {
      const id = window.Studio.state.images[2].id;
      window.deleteFile('image', id);
      return { n: window.Studio.state.images.length, gone: !window.Studio.state.images.some(i => i.id === id) };
    });
    assertEqual(after.n, 4, 'count after delete');
    assert(after.gone, 'deleted file is no longer in state');
  });

  await test('keeps file order and reorders within a kind', async () => {
    await reset(page);
    await importFiles(page, { count: 6 });
    const order = await page.evaluate(() => {
      const a = window.Studio.state.images;
      const moved = a.splice(0, 1)[0];
      a.splice(3, 0, moved);
      return a.map(f => f.name);
    });
    assertEqual(order[3], 'img_0.jpg', 'moved file landed at index 3');
    assertEqual(order[0], 'img_1.jpg', 'following file shifted up');
  });

  await test('filters by filename without dropping state', async () => {
    await reset(page);
    await importFiles(page, { count: 30 });
    const n = await page.evaluate(() => {
      window.Studio.state.searchQuery = 'img_1';
      return window.visibleFileItems().length;
    });
    assert(n > 0 && n < 30, `filter narrowed the list (got ${n})`);
    assertEqual(await page.evaluate(() => window.Studio.state.images.length), 30, 'underlying list intact');
    await page.evaluate(() => { window.Studio.state.searchQuery = ''; });
  });

  await test('select all and clear operate on the filtered set', async () => {
    await reset(page);
    await importFiles(page, { count: 40 });
    await page.click('#selectAllBtn');
    assertEqual(await page.evaluate(() => window.Studio.state.selectedIds.size), 40, 'all selected');
    await page.click('#clearSelectedBtn');
    assertEqual(await page.evaluate(() => window.Studio.state.selectedIds.size), 0, 'selection cleared');
  });

  console.log('\nError isolation and cancellation');

  await test('one broken file does not stop the batch', async () => {
    await reset(page);
    const out = await page.evaluate(async ({ factory }) => {
      const make = eval('(' + factory + ')');
      const files = await make({ count: 8, broken: 2 });
      await window.handleFiles(files, 'convert');
      const items = window.Studio.state.conversionFiles.slice();
      items.forEach(i => { i.outputFormat = 'image/png'; });
      const run = await window.runBatch(items, async (item) => {
        return await window.produceConvertedBlob(item, 'image/png');
      }, { concurrency: 3 });
      return { done: run.done, failed: run.failed, total: items.length };
    }, { factory: makeFilesInPage });
    assertEqual(out.total, 10, 'all files queued');
    assertEqual(out.done, 10, 'every file was attempted');
    assertEqual(out.failed, 2, 'exactly the broken files failed');
  });

  await test('runBatch stops promptly when its signal aborts', async () => {
    const out = await page.evaluate(async () => {
      const items = Array.from({ length: 400 }, (_, i) => ({ name: 'x' + i }));
      const ctrl = new AbortController();
      let started = 0;
      const p = window.runBatch(items, async () => {
        started++;
        await new Promise(r => setTimeout(r, 5));
      }, { concurrency: 4, signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 60);
      const run = await p;
      return { started, cancelled: run.cancelled, total: items.length };
    });
    assert(out.cancelled, 'run reported as cancelled');
    assert(out.started < out.total, `stopped early (${out.started} of ${out.total} started)`);
  });

  await test('cancel button aborts a running conversion', async () => {
    await reset(page);
    await importFiles(page, { count: 120, target: 'convert' });
    await page.evaluate(() => {
      window.Studio.state.conversionFiles.forEach(i => { i.outputFormat = 'image/png'; });
      window.Studio.state.settings.bulkFormat = 'image/png';
    });
    const p = page.evaluate(() => window.runBulkConversion());
    await page.waitForFunction(() => window.Studio.batchRun.active === true, { timeout: 5000 });
    await page.click('#processingCancel');
    await p;
    const st = await page.evaluate(() => ({
      active: window.Studio.batchRun.active,
      status: document.getElementById('processingStatus').textContent,
    }));
    assertEqual(st.active, false, 'batch is no longer active');
    assert(/cancel/i.test(st.status), `status says cancelled (got "${st.status}")`);
    await page.click('#processingDone').catch(() => {});
  });

  await test('a second conversion cannot start while one is running', async () => {
    const blocked = await page.evaluate(() => {
      window.Studio.batchRun.active = true;
      const ok = window.guardBatch();
      window.Studio.batchRun.active = false;
      return ok;
    });
    assertEqual(blocked, false, 'guardBatch refuses a concurrent run');
  });

  console.log('\nPDF generation');

  await test('builds one PDF from many images', async () => {
    await reset(page);
    await importFiles(page, { count: 25 });
    const out = await page.evaluate(async () => {
      const r = await window.buildMergedPdf(window.Studio.state.images.slice(), {});
      return { size: r.blob.size, ok: r.ok, type: r.blob.type, errors: r.errors.length };
    });
    assertEqual(out.ok, 25, 'every image became a page');
    assertEqual(out.type, 'application/pdf', 'output is a PDF');
    assert(out.size > 1000, `PDF has real content (${out.size} bytes)`);
    assertEqual(out.errors, 0, 'no per-image failures');
  });

  await test('merged PDF skips broken images but still produces a file', async () => {
    await reset(page);
    const out = await page.evaluate(async ({ factory }) => {
      const make = eval('(' + factory + ')');
      const files = await make({ count: 6, broken: 2 });
      await window.handleFiles(files, 'auto');
      const r = await window.buildMergedPdf(window.Studio.state.images.slice(), {});
      return { ok: r.ok, errors: r.errors.length, size: r.blob.size };
    }, { factory: makeFilesInPage });
    assertEqual(out.ok, 6, 'good images made it in');
    assertEqual(out.errors, 2, 'broken images reported individually');
    assert(out.size > 1000, 'PDF still produced');
  });

  console.log('\nLarge batches');

  const report = [];
  for (const size of sizes) {
    await test(`imports ${size} files without blocking the UI`, async () => {
      await reset(page);
      const framePromise = measureLongestFrame(page, 1500);
      const r = await importFiles(page, { count: size });
      const longestFrame = await framePromise;

      const stats = await page.evaluate(() => ({
        cards: document.querySelectorAll('#fileGrid .file-card').length,
        images: window.Studio.state.images.length,
        gridNodes: document.getElementById('fileGrid').childElementCount,
      }));

      assertEqual(stats.images, size, 'every file was accepted');
      assert(stats.cards <= 80, `DOM holds only visible cards (${stats.cards} for ${size} files)`);
      assert(r.ms < 8000, `import completed in reasonable time (${r.ms}ms)`);
      assert(longestFrame < 1200, `no single block over ~1.2s (worst frame ${longestFrame}ms)`);

      report.push({ size, importMs: r.ms, longestFrameMs: longestFrame, domCards: stats.cards });
    });
  }

  await test('scrolling a 1000-file grid keeps the DOM small', async () => {
    await reset(page);
    await importFiles(page, { count: 1000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(400);
    const cards = await page.evaluate(() => document.querySelectorAll('#fileGrid .file-card').length);
    assert(cards > 0 && cards <= 80, `still only visible cards after scrolling (${cards})`);
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  await test('1000 conversion rows render only a window of rows', async () => {
    await reset(page);
    await importFiles(page, { count: 1000, target: 'convert' });
    await page.waitForTimeout(300);
    const rows = await page.evaluate(() => document.querySelectorAll('#conversionList .conv-row').length);
    assertEqual(await page.evaluate(() => window.Studio.state.conversionFiles.length), 1000, 'all rows in state');
    assert(rows > 0 && rows <= 40, `only a window of rows in the DOM (${rows})`);
  });

  await test('thumbnail object URLs stay bounded while scrolling', async () => {
    await reset(page);
    await importFiles(page, { count: 800 });
    for (const y of [0, 2000, 6000, 12000, 20000, 0]) {
      await page.evaluate(v => window.scrollTo(0, v), y);
      await page.waitForTimeout(150);
    }
    const live = await page.evaluate(() => window.Studio.thumbUrls.size);
    assert(live <= 300, `live object URLs stayed bounded (${live})`);
  });

  console.log('\nAccessibility and safety');

  await test('filenames are never interpreted as HTML', async () => {
    await reset(page);
    const html = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg'));
      const evil = new File([blob], '<img src=x onerror=alert(1)>.jpg', { type: 'image/jpeg' });
      await window.handleFiles([evil], 'auto');
      const card = document.querySelector('#fileGrid .file-card .card-name');
      return { text: card.textContent, inner: card.innerHTML };
    });
    assert(html.text.includes('<img'), 'the raw name is shown as text');
    assert(!html.inner.includes('<img'), 'no element was injected from the filename');
  });

  await test('interactive controls have accessible names', async () => {
    const unnamed = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('button').forEach(b => {
        if (b.offsetParent === null) return;
        const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
        if (!name) bad.push(b.className || b.id || 'button');
      });
      return bad;
    });
    assertEqual(unnamed.length, 0, `every visible button is named (missing: ${unnamed.join(', ')})`);
  });

  await test('the page has a live region for status updates', async () => {
    const ok = await page.evaluate(() => !!document.querySelector('[aria-live="polite"][role="status"]'));
    assert(ok, 'status live region exists');
  });

  console.log('\nResponsive layout');

  for (const [label, width, height] of [['mobile', 390, 844], ['tablet', 820, 1180], ['laptop', 1440, 900]]) {
    await test(`${label} (${width}x${height}) has no horizontal overflow`, async () => {
      await page.setViewportSize({ width, height });
      await reset(page);
      await importFiles(page, { count: 40 });
      await page.waitForTimeout(300);
      const o = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      assert(o.scrollW <= o.clientW + 2, `no sideways scroll (${o.scrollW} vs ${o.clientW})`);
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ----------------------------------------------------------------- results
  const realErrors = consoleErrors.filter(t =>
    !/favicon|cdn\.tailwindcss|Failed to load resource/i.test(t));

  console.log('\nLarge-batch report');
  console.log('  files   import    worst frame   cards in DOM');
  report.forEach(r => {
    console.log(
      '  ' + String(r.size).padEnd(7) +
      (r.importMs + 'ms').padEnd(9) +
      (r.longestFrameMs + 'ms').padEnd(14) +
      r.domCards
    );
  });

  if (realErrors.length) {
    console.log('\nConsole errors observed:');
    realErrors.slice(0, 10).forEach(e => console.log('  - ' + e.slice(0, 200)));
  }

  console.log(`\n${passed} passed, ${failed} failed${realErrors.length ? `, ${realErrors.length} console errors` : ''}\n`);

  await browser.close();
  process.exit(failed || realErrors.length ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
