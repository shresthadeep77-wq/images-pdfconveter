# AGENTS.md — context for AI coding assistants

Read this before touching the code. It should be enough to work without reading every
line of `index.html`.

## What this is

A local, offline converter and compressor for images and PDFs. Everything runs in the
browser; no server, no uploads, no account. Headline use case: **turn a pile of images
into one PDF**, but it also converts formats, compresses, resizes, rotates, crops and
merges.

**The entire app is one file: `index.html` (~4600 lines).** Markup, CSS and vanilla JS in
one document. No framework, no bundler, no build step.

## Non-negotiable constraints

1. **Keep it a single self-contained `index.html`.** It must work when double-clicked
   (`file://`). Do not split into ES modules — they do not load over `file://`. Do not add
   a bundler.
2. **No frameworks, no state libraries, no UI kits.** Vanilla JS and the existing Tailwind
   CDN classes.
3. **Nothing leaves the device.** No uploads, no analytics, no telemetry. Heavy libraries
   load lazily from a CDN; that is the only network traffic.
4. **Runtime dependencies stay lazy-loaded from a CDN** via `loadLibrary()` — never
   bundled, never eagerly loaded.
5. `playwright-core` is the only npm dependency and it is **dev-only**, for tests.

## Files

```
index.html          the app — everything
tests/run-tests.mjs browser-driven test + benchmark suite
tools/check.mjs     static checks (stands in for a build)
package.json        scripts + one dev dependency
ARCHITECTURE.md     structure, data flow, pipelines
PERFORMANCE.md      bottlenecks, measurements, strategy
```

## Do not casually rewrite these

They are the reason 1000 files work. Each looks more complicated than it "needs" to be,
and each is that way for a measured reason. Read PERFORMANCE.md before changing any.

| Thing | Why it exists |
|---|---|
| `createVirtualGrid` / `createVirtualList` | 54 DOM nodes for 1000 files instead of 1000 nodes + 10,000 listeners |
| `createCardNode` / `updateCardNode` split | node recycling — never merge them back into one builder |
| Delegated `fileGrid` / `conversionList` listeners | per-row listeners are what made the old version collapse |
| `runBatch` | bounded concurrency + per-item error isolation + `AbortSignal` |
| `createPool` (LIFO) | visible rows jump the thumbnail queue |
| `ImageWorkers` + `runImageOp` | keeps decode/encode off the main thread, with a working fallback |
| `requestThumb` + `thumbUrls` LRU | lazy thumbnails, bounded live object URLs |
| `handleFiles` chunking | why importing 1000 files takes ~100 ms and never blocks |
| `refreshSizeEstimates` bounds | estimating means re-encoding; unbounded, it kills the app |
| `deliverResults` `compression: 'STORE'` | DEFLATE on already-compressed data is wasted CPU |

## Performance requirements

Any change must keep these true — `npm test` asserts all of them:

- 1000 files import in well under a second, with no main-thread block over ~1.2 s.
- The DOM never holds more than ~80 file cards or ~40 conversion rows, at any batch size.
- Live thumbnail object URLs stay bounded (≤ 300) while scrolling a large grid.
- One failed file never stops a batch.
- A large batch can be cancelled and stops within a file or so.
- No horizontal scrolling at 390 px, 820 px or 1440 px wide.

**The rule to internalise:** never do work proportional to the number of files when the
user can only see twenty of them. Before adding any per-file loop, ask whether it can be
limited to the visible window instead.

## UI/UX principles

- Simple surface over complex machinery. Do not expose the architecture in the interface.
- One obvious primary action per area; avoid competing buttons.
- State is never communicated by colour alone — every `.state-chip` pairs an icon and a
  word with its colour.
- Filenames go through `textContent`, **never** `innerHTML`. `tools/check.mjs` enforces this.
- Errors are plain language via `friendlyError()`. Never show a stack trace.
- Progress shows counts (done / left / failed), throttled to ~120 ms, mirrored to the
  `aria-live` region through `announce()`.
- Touch targets ≥ 44 px. Every interactive element is a real `<button>` with an
  accessible name.
- `prefers-reduced-motion` is respected globally.

## How file processing works

```
File (never copied, never base64)
  └─ runBatch(items, task, { concurrency, signal, onProgress })
       └─ produceConvertedBlob(item, format)
            ├─ image→image   encodeImageFile()  → worker pool
            ├─ image→PDF     pdf-lib embedJpg / embedPng
            ├─ PDF→images    pdf.js, page by page, canvas freed each page
            ├─ PDF→PDF       pdf-lib copyPages
            └─ office→PDF    mammoth / XLSX / pptx2json → text → pdf-lib
  └─ deliverResults()  1 file → direct download; 2+ → JSZip (STORE)
```

Release every intermediate as soon as it is consumed: `bitmap.close()`,
`canvas.width = canvas.height = 0`, `buffer = null`, `pdf.destroy()`.

## How PDF generation works

Two distinct paths — do not merge them:

- **`buildMergedPdf(items)`** — one PDF containing every image as a page. Streams: embed,
  add page, drop the buffer, yield every 5 images. This is the `application/pdf+merged`
  bulk format and the Merge tool.
- **`convertToPdf(item)`** — one PDF per input file. This is the plain `application/pdf`
  bulk format; results are zipped.

JPEG and PNG are embedded straight from their bytes. Anything else is re-encoded to PNG
in a worker first.

## Commands

```bash
npm install          # one dev dependency
npm start            # serve at http://localhost:5173 (needed for Web Workers)
npm run build        # static checks — run this after every edit
npm test             # full suite: 100 / 250 / 500 / 1000 files
npm run test:1000
npm run test:headed  # visible browser
```

`npm run build` is fast and catches broken JS, duplicate ids, `$('id')` lookups for
elements that do not exist, and filenames reaching `innerHTML`. Run it before `npm test`.

## Debugging

`window.Studio` exposes the const-scoped internals: `Studio.state`, `Studio.PERF`,
`Studio.knownFiles`, `Studio.batchRun`, `Studio.thumbUrls.size`,
`Studio.workersActive()`. Top-level `function` declarations are already on `window`.

## Editing gotchas

- `index.html` has very long lines. Prefer targeted string replacement over rewriting
  regions, and re-run `npm run build` immediately.
- **Watch `\uXXXX` escapes.** Some editing paths decode them into raw characters. For
  control characters this produces an invalid regex that breaks the whole script. Prefer
  `charCodeAt` checks over escapes in character classes — `sanitizeFilename` already does.
- `updateEmptyState()` must run **before** `renderGrids()` in `renderAll()`: the
  virtualisers measure container width, and a hidden container measures zero.
- Node recycling means per-node closure state does not survive. Transient UI state (like
  the two-tap delete confirm) lives in module scope keyed by item — see `armedDeleteKey`.

## Known limitations

- Browser memory is the real ceiling; ~1000–2000 typical photos on desktop, less on mobile.
- Blob workers are blocked on `file://` in most browsers — the main-thread fallback runs
  instead. Serve over HTTP for full speed.
- `canvas.toBlob` has no BMP or GIF encoder; those outputs become PNG.
- Office → PDF extracts text only; layout, fonts and images are lost. PPTX is text-only.
- The output ZIP is assembled in memory — multi-gigabyte result sets may fail at packaging.
- PDF compression rasterises, so text stops being selectable (the original is kept when
  rasterising would be larger).
- Reordering works within a file type, not across types.
- `splitSelectedPdf()` is a stub that shows a toast.

## Keep this file current

If you change the architecture, the concurrency model, the worker setup or the
virtualisation, update this file and the relevant section of ARCHITECTURE.md /
PERFORMANCE.md in the same change.
