# Architecture

Everything lives in one file: **`index.html`** (~4600 lines). Markup, CSS and JavaScript
in three sections of the same document. There is no framework, no bundler, no build step.

That constraint is deliberate: the app must keep working when someone double-clicks the
file. Do not split it into modules — ES modules do not load over `file://`.

`npm run build` does not build the app. It runs the static checks and copies `index.html`
into a generated `public/`, because static hosts expect a directory to publish.

```
index.html
├── <head>        Tailwind (play CDN), Font Awesome, Google Fonts, tailwind.config
├── <style>       design tokens, component CSS, virtualisation geometry, reduced-motion
├── <body>        header · hero/drop zone · file grid · conversion list · action rail
│                 · modals (preview, crop, processing, settings) · queue sidebar · toasts
├── <script>      the application (see the map below)
└── <script>      small status-LED widget, independent of the main script
```

## Script map

Read in this order; each section builds on the one before.

| Section | What it owns |
|---|---|
| Utilities | `escapeHtml`, `safeText`, `urlRegistry` |
| Lazy loading | `loadLibrary(name, url)` — CDN `<script>` injection, cached |
| State | the single `state` object |
| DOM refs | `$(id)` and the cached element handles |
| **Large-batch infrastructure** | `PERF`, `createPool`, `createLru`, `runBatch`, `friendlyError`, `announce` |
| **Image workers** | `ImageWorkers`, `runImageOp`, `encodeImageFile`, `makeImageThumb`, `makePdfThumb`, `requestThumb` |
| **Virtualisation** | `createVirtualGrid`, `createVirtualList` |
| Format picker | `FORMATS`, `renderFormats`, panel open/close |
| Estimates | `computeEstimate`, `refreshSizeEstimates`, `refreshCardEstimates` |
| **File cards** | `createCardNode` / `updateCardNode`, delegated grid events, `fileGridView` |
| **Conversion list** | `createConvRow` / `updateConvRow`, delegated events, `conversionView` |
| Render | `renderAll`, `renderGrids`, `renderConversionList`, `update*` |
| **Import** | `sanitizeFilename`, `classify`, `handleFiles`, `addToConversion` |
| Preview / crop | `openPreview`, `renderPdfPreview`, crop modal |
| **Batch + progress** | `batchRun`, `startProcessing`, `onBatchProgress`, `finishProcessing` |
| Conversion engine | `produceConvertedBlob`, `convertToPdf`, `convertToImage`, `convertToWord`, … |
| **Bulk jobs** | `runBulkConversion`, `buildMergedPdf`, `deliverResults` |
| Tools | `runImageTool`, `compressSelected`, `mergeSelectedImages`, `mergeSelectedPdfs`, `exportSelectedAsZip` |
| Wiring | drop zones, buttons, keyboard shortcuts, settings, init |
| Test hook | `window.Studio` |

Sections in **bold** are the large-batch machinery. They are the reason 1000 files work;
see [PERFORMANCE.md](PERFORMANCE.md) before changing them.

## State and data flow

One plain object. No store library, no reactivity — code mutates `state` and then calls a
render function.

```js
state = {
  images: [],           // Item[]   kind: 'image'
  pdfs: [],             // Item[]   kind: 'pdf'
  conversionFiles: [],  // Item[]   kind: 'conv'
  selectedIds: Set,     // ids from images + pdfs
  searchQuery: '',
  settings: { quality, imageQuality, pdfQuality, autoDelete, bulkFormat },
  preview: { type, id, zoom, panX, panY },
  theme, activeTab, queue
}
```

An item is a **reference to the original `File` plus metadata** — never a copy of the
bytes, never a base64 string:

```js
{
  id, kind,             // 'image' | 'pdf' | 'conv'
  file,                 // the File object from the picker/drop — the only copy
  name,                 // sanitised for display
  size, type,
  thumbBlob,            // ~1 KB WebP/JPEG, created lazily, null until then
  width, height,        // filled in when the thumbnail is made
  pages,                // PDFs only
  status,               // 'ready' | 'waiting' | 'working' | 'done' | 'failed' | 'cancelled'
  error,                // user-facing message when status === 'failed'
  outputFormat, quality // conversion items only
}
```

Flow:

```
drop / picker
   └─ handleFiles()            metadata only, chunked, yields between chunks
        ├─ classify()          extension → mime, reject unsupported
        ├─ dedupeKey()         skip name|size|mtime already present
        └─ push into state
             └─ renderAll()
                  ├─ updateEmptyState()   reveal containers FIRST (virtualisers measure width)
                  ├─ renderGrids()        → fileGridView.setItems()
                  ├─ renderConversionList() → conversionView.setItems()
                  └─ the update* family (counts, toolbar, bulk bar, …)

scroll / resize
   └─ virtualiser mounts the visible window
        └─ updateCardNode()
             └─ requestThumb()   only for cards actually on screen
```

`renderAll()` is cheap *because* the lists are virtualised — its cost tracks what is on
screen, not how many files exist. Selection changes take an even cheaper path
(`refreshSelectionUi`) that skips the conversion list entirely.

## File processing pipeline

```
Item.file (File)
   ↓  runBatch — bounded concurrency, per-item try/catch, AbortSignal
   ↓  produceConvertedBlob(item, format)
        ├─ image → image    encodeImageFile()  → worker
        ├─ image → PDF      pdf-lib embedJpg/embedPng
        ├─ PDF   → images   pdf.js render → canvas → toBlob, page by page
        ├─ PDF   → PDF      pdf-lib copyPages
        └─ office → PDF     mammoth / XLSX / pptx2json → text → pdf-lib
   ↓  Blob
   ↓  deliverResults()  single file → direct download
   ↓                    many files  → JSZip with compression: 'STORE'
   ↓  downloadBlob()    object URL, revoked after 5 s
```

Every intermediate (ArrayBuffer, canvas, ImageBitmap) is released as soon as it is
consumed. Canvases get `canvas.width = canvas.height = 0` before being dropped, which
frees the backing store immediately instead of waiting for GC.

## Preview system

Three tiers, so the expensive one is rare:

1. **Card thumbnail** — longest edge 320 px, WebP (JPEG fallback), ~1 KB, stored as a
   Blob on the item. Made once, lazily, in a worker.
2. **Object URL** — minted from the thumbnail blob only when a card mounts, recycled
   through a 256-entry LRU that revokes on eviction.
3. **Full resolution** — only inside the preview modal, one at a time, revoked on close.

PDF thumbnails render page 1 through pdf.js at concurrency 2, then destroy the document.

## Worker architecture

`ImageWorkers` is a fixed pool of `max(2, min(4, hardwareConcurrency - 1))` workers built
from a Blob URL. Each handles four ops via `createImageBitmap` + `OffscreenCanvas`:

| op | used by |
|---|---|
| `thumb` | card thumbnails |
| `encode` | format conversion, compression, size estimates |
| `resize` | the Resize tool |
| `rotate` | the Rotate tool |

`runImageOp(payload)` is the only entry point. It tries the pool and **falls back to an
identical main-thread implementation** when workers are unavailable (`file://` blocks Blob
workers in most browsers) or when a job times out. Behaviour is identical either way;
only speed differs. `window.Studio.workersActive()` reports which path is live.

pdf.js runs in its own worker, managed by the library.

## Queue / concurrency model

`runBatch(items, task, { concurrency, signal, onProgress })` is the single primitive for
every batch operation:

- N lanes pull from a shared index — no `Promise.all` over the whole list.
- Each item is wrapped in `try/catch`; a failure records a friendly message and the run
  continues.
- `signal.aborted` is checked before every item, so Cancel stops within one file.
- Progress is throttled to ~120 ms.
- Returns `{ results, done, failed, errors, cancelled }`.

Concurrency comes from `PERF`: `imageConcurrency` (2–4) for image work,
`pdfConcurrency` (2) for anything rasterising PDFs.

`createPool(n)` is a lighter, **LIFO** variant used for thumbnails and estimates. LIFO is
deliberate: the newest request is the row the user is looking at, so scrolling always
services the visible window first.

Only one batch runs at a time. `batchRun` holds the `AbortController`; `guardBatch()`
refuses a second job and `setBatchLocked()` disables the controls that could corrupt a
running one — while leaving scrolling, filtering and preview available.

## Virtualisation

`createVirtualGrid` turns `#fileGrid` into a spacer as tall as all rows, with only the
visible cards (plus two rows of overscan) absolutely positioned inside it. Card nodes are
**recycled** through a pool as they scroll. Scroll and resize handlers are `rafThrottle`d.

`createVirtualList` does the same for `#conversionList`, which scrolls inside itself with
a fixed row height (62 px desktop / 92 px mobile) capped at 55 vh.

Neither attaches listeners per row. All interaction is **delegated** to the container and
resolved with `closest('[data-action]')`. This is why 1000 files cost 54 DOM nodes instead
of 1000 nodes and ~10,000 listeners.

Transient per-node state that would break under recycling (the two-tap delete confirm)
lives in module scope keyed by item, not in a closure on the node.

## Memory-management strategy

| Resource | How it is released |
|---|---|
| Thumbnail object URLs | 256-entry LRU, revoked on eviction |
| Thumbnail blobs | dropped in `releaseItemResources()` on delete |
| Preview object URL | revoked in `closePreviewResources()` |
| Preview PDF document | `pdf.destroy()` on close |
| Download URLs | revoked 5 s after the click |
| Canvases | sized to 0×0 before being dropped |
| `ImageBitmap` | `.close()` right after drawing |
| ArrayBuffers | set to `null` once embedded |
| Estimate caches | LRU capped at 400 entries |
| Workers | terminated on `beforeunload` |

The app never stores base64, never duplicates a `File`, and never holds a decoded
full-resolution image outside the preview modal.

## Test hook

`window.Studio` exposes the `const`-scoped internals (`state`, `PERF`, `knownFiles`,
`batchRun`, `thumbUrls`, the two views) for `tests/run-tests.mjs` and for debugging in the
console. Top-level `function` declarations are already on `window`. It reads and writes
live objects — do not build features on it.
