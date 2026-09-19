# Performance

Target: **1000+ files in one batch, without the browser appearing frozen.**

## Measured today

Chromium, 1440×900, synthetic JPEGs of mixed sizes (64² to 1600×1200), via
`npm test`:

| files | import | worst main-thread block | cards in the DOM |
|---|---|---|---|
| 100 | 9 ms | 74 ms | 54 |
| 250 | 16 ms | 67 ms | 54 |
| 500 | 35 ms | 70 ms | 54 |
| 1000 | 90–122 ms | 129–134 ms | 54 |

Import time grows roughly linearly and stays in the tens of milliseconds because import
does no image work at all. The DOM stays flat because the grid is virtualised.

Re-measure any time with `npm test` — the benchmark table is printed at the end.

## The original bottlenecks

Ranked by how badly each one broke at scale.

**1. Size estimation re-encoded every file, after every render.**
`refreshSizeEstimates()` ran after each `renderConversionList()` and fully decoded and
re-encoded *every* row to measure its output size — serially, on the main thread. The
cache key included quality, so nudging the global slider invalidated all N. At 1000 files
this alone made the app unusable.

**2. Import decoded every image at full resolution, serially, before any UI.**
`addImages()` awaited a full `new Image()` decode per file and only then rendered. It also
minted an object URL per file and kept it alive forever as the "thumbnail".

**3. PDF import rendered page 1 of every PDF to a base64 data URL.**
`canvas.toDataURL()` per PDF, stored as a string in state — a 33 % size penalty on top of
an already large raster, held permanently.

**4. Every render rebuilt every card.**
`renderGrids()` did `innerHTML = ''` and reconstructed all cards with ~10 listeners each.
`renderAll()` — which calls it — fired on every checkbox click, every keystroke, every
selection change. At 1000 files: 1000 nodes, ~10,000 listeners, rebuilt constantly. The
card builder also called `arr.indexOf(file)` inside the loop, making it O(n²).

**5. Cards showed full-resolution images in 200 px cells.**
1000 full-size decodes for thumbnails.

**6. 1000 `<select>` elements with ~6 `<option>` each** in the conversion list — about
7000 of the most expensive elements the browser has.

**7. Bulk conversion was a serial loop with no cancellation.**
All output blobs accumulated in one JSZip and then `generateAsync` DEFLATEd them — CPU
spent compressing already-compressed JPEGs, with the whole output resident twice. The
Cancel button only hid the modal; the loop kept running.

**8. All CPU work on the main thread** — every decode, encode and PDF raster.

**9. Unbounded caches**, object URLs that were never revoked for conversion files, and
canvases left to the garbage collector.

## The 1000-file strategy

One rule: **never do work proportional to the number of files when the user can only see
twenty of them.**

### Import does no image work

`handleFiles()` reads `name`, `size` and extension only, in chunks of 150 with a
`requestAnimationFrame` yield between chunks, then renders once. Duplicates
(`name|size|mtime`) are skipped, oversized and unsupported files are counted and reported
together rather than as 900 separate toasts. A progress banner appears above
`PERF.bigBatch` (120) files.

### Concurrency model

`runBatch(items, task, { concurrency, signal, onProgress })` — N lanes pulling from a
shared index. Never `Promise.all` over the full list.

- `PERF.imageConcurrency` = `max(2, min(4, hardwareConcurrency - 1))`
- `PERF.pdfConcurrency` = 2 — pdf.js rasterising is memory-bound, not CPU-bound

Each item is individually wrapped, so a failure records a message and the run continues.

`createPool(n)` is a lighter **LIFO** pool for thumbnails and estimates. LIFO because the
newest request is the row on screen — scrolling always jumps the queue correctly.

### Worker strategy

A fixed pool of 2–4 workers, **not one per file**, created once from a Blob URL. Each
worker does `createImageBitmap` → `OffscreenCanvas` → `convertToBlob`, covering
thumbnails, encoding, resize and rotate. `runImageOp()` falls back to a byte-identical
main-thread path when workers are unavailable — notably on `file://`, where most browsers
block Blob workers — or when a job times out (45 s).

Workers were *not* introduced for pdf-lib (its own work is not the bottleneck) or for
ZIP assembly (JSZip's `STORE` mode is nearly free).

### Preview strategy

- Thumbnails: longest edge 320 px, WebP with JPEG fallback, quality 0.72 — about **1 KB**
  each versus the multi-megabyte original.
- Generated **lazily**, requested by the virtualiser only for cards that mount.
- Stored as a Blob on the item; object URLs minted on mount and recycled through a
  **256-entry LRU** that revokes on eviction.
- A shimmer placeholder occupies the cell until the thumbnail arrives, so nothing jumps.
- Full resolution appears only in the preview modal, one image at a time.

### Virtualisation

`#fileGrid` becomes a spacer as tall as all rows; only visible cards plus two overscan
rows are positioned inside it, and their nodes are recycled. `#conversionList` does the
same with a fixed row height inside its own scroller.

No listener is ever attached per row — everything is delegated to the container.
Result: **54 DOM nodes for 1000 files**, instead of 1000 nodes and ~10,000 listeners.

### Estimates, contained

The worst offender is now strictly bounded:

- only rows currently mounted in the conversion list, capped at 24 per pass
- concurrency 2, through the worker pool
- a run token abandons stale work when anything changes
- skipped entirely while a batch is running
- card compression previews only when the selection is 40 files or fewer
- results cached in a 400-entry LRU

### Memory strategy

| Resource | Release |
|---|---|
| Thumbnail URLs | 256-entry LRU, revoked on eviction |
| Thumbnail blobs | cleared in `releaseItemResources()` |
| Preview URL / PDF doc | revoked and `destroy()`ed on close |
| Download URLs | revoked 5 s after click |
| Canvases | `canvas.width = canvas.height = 0` before drop |
| `ImageBitmap` | `.close()` immediately after draw |
| ArrayBuffers | `null`ed after embedding |
| Estimate caches | LRU, 400 entries |
| Workers | terminated on `beforeunload` |

No base64 anywhere. No duplicated `File`. The only copy of the bytes is the `File` the
browser already holds.

### ZIP assembly

`deliverResults()` uses `compression: 'STORE'`. Images and PDFs are already compressed;
DEFLATE burns CPU and memory for roughly nothing. Duplicate output names get a ` (2)`
suffix. A single result skips the ZIP entirely.

### PDF generation

`buildMergedPdf()` streams: embed one image, add its page, drop the buffer, yield every
five images. JPEG and PNG sources are embedded directly from their bytes — no decode, no
canvas. Only other formats get re-encoded, in a worker.

PDF compression rasterises page by page, freeing each page's canvas before moving on, and
keeps the original if rasterising made the file bigger.

## Progress and cancellation

Progress updates are throttled to 120 ms and show **done / left / failed** alongside the
bar, plus a list of up to 20 failed files with plain-language reasons. The same text goes
to an `aria-live` region.

Cancel aborts the batch's `AbortController`. `runBatch` checks `signal.aborted` before
each item, so a run stops within one file. Anything already produced is still offered as a
partial download. `guardBatch()` prevents a second job starting on top of a running one,
and `setBatchLocked()` disables only the controls that could corrupt it — scrolling,
filtering and preview stay available.

## Browser limitations

These are hard ceilings, not things the code can fix:

- **Memory.** A 12 MP JPEG is ~4 MB on disk but ~48 MB decoded. Decoding is bounded to a
  few at a time, but the ZIP of outputs is assembled in memory — a batch whose outputs
  exceed a couple of gigabytes can fail at packaging.
- **`file://` blocks Blob workers** in most browsers. The app falls back to the main
  thread; correct, but slower. Serve over HTTP for the worker pool.
- **`canvas.toBlob` supports PNG, JPEG and WebP only.** BMP and GIF output become PNG.
- **Mobile browsers reclaim memory aggressively** and may discard a backgrounded tab
  mid-batch.
- **Downloads are one file at a time**, which is why many results become a ZIP.

## Testing approach

`npm test` drives a real Chromium against the real page and generates synthetic images of
mixed sizes in-page, feeding them through the genuine import path.

It asserts behaviour, not just timing: DOM node count stays bounded at every batch size,
no single main-thread block exceeds ~1.2 s, live object URLs stay under 300 while
scrolling a 800-file grid, a broken file fails alone while its 8 neighbours succeed,
an aborted run stops early, and the merged PDF is a real PDF.

```bash
npm run check                   # static checks
npm test                        # 100 / 250 / 500 / 1000
npm run test:1000
node tests/run-tests.mjs --sizes 2000     # push past the target
npm run test:headed             # watch it
```

For hand testing, the browser console has `window.Studio` — `Studio.state`,
`Studio.PERF`, `Studio.thumbUrls.size`, `Studio.workersActive()`.
