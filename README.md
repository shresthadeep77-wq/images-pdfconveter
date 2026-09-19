# Studio — local image & PDF converter

Convert, compress, resize, rotate, crop and merge images and PDFs **entirely in your
browser**. Nothing is uploaded, there is no account, and it works offline once the page
has loaded.

The whole app is one file: [`index.html`](index.html). There is no build step — open it
and it runs.

## Features

- **Images → PDF** — combine any number of images into a single PDF, in the order you choose.
- **Format conversion** — JPG, PNG, WebP, BMP, GIF, plus PDF → images and Office → PDF.
- **Compression** — one quality slider for images, another for PDFs, with a live size
  preview so you can see the result before committing.
- **PDF tools** — merge, rasterise/compress, extract page images.
- **Editing** — resize, rotate, crop.
- **Batch everything** — built to stay responsive with 1000+ files in one go, with a
  progress readout, a working Cancel button, and per-file error reporting.
- **Local only** — files never leave the device.

## Supported file types

| In | Out |
|---|---|
| JPG, PNG, WebP, GIF, BMP, SVG, TIFF, AVIF, ICO | PNG, JPG, WebP, BMP, GIF, PDF |
| PDF | PNG, JPG, WebP, PDF, DOCX, XLSX, TXT |
| DOCX, XLSX, PPTX, HTML | PDF, images |

Individual files are capped at 50 MB.

## Running it

**The simplest way:** double-click `index.html`.

Everything works this way except Web Workers, which most browsers block on `file://`
URLs. The app detects this and falls back to processing on the main thread — correct,
just slower on very large batches. For the full experience, serve it over HTTP:

```bash
npm start           # serves on http://localhost:5173
```

or any static server you already have:

```bash
python -m http.server 5173
npx serve .
```

## Building

There is nothing to build. `index.html` *is* the deliverable.

What stands in for a build is a static check that catches what a bundler normally would —
unparseable JavaScript, duplicate element ids, `getElementById` calls for ids that do not
exist, and filenames reaching `innerHTML`:

```bash
npm run build       # == node tools/check.mjs
```

## Testing

```bash
npm install         # one dev-only dependency: playwright-core
npm test            # full suite at 100 / 250 / 500 / 1000 files
npm run test:1000   # just the 1000-file batch
npm run test:headed # watch it happen in a visible browser
```

The tests drive a real Chromium against the real page. They cover import, duplicate
handling, invalid and oversized files, removal, ordering, filtering, selection,
conversion, cancellation, error isolation, PDF generation, memory bounds, accessible
names, and responsive layout at three viewport sizes — plus a benchmark table.

If Chromium is not found automatically, point at one:

```bash
CHROME_PATH="/path/to/chrome" npm test
```

## Deploying

Upload `index.html` anywhere that serves static files — GitHub Pages, Netlify, Cloudflare
Pages, S3, or a folder on a web server. No server-side code, no environment variables,
no database.

For GitHub Pages: push to `main` and enable Pages on the repository root.

## Architecture in one paragraph

A single HTML file holding markup, CSS and vanilla JavaScript. State lives in one plain
`state` object. Heavy libraries (pdf-lib, pdf.js, JSZip, mammoth, XLSX, docx) load lazily
from a CDN only when a feature needs them. The file grid and conversion list are
**virtualised**: only the rows on screen exist in the DOM. Image decoding and encoding run
in a small **Web Worker pool**. Batch jobs run through a **bounded concurrency queue** with
real cancellation. See [ARCHITECTURE.md](ARCHITECTURE.md) and [PERFORMANCE.md](PERFORMANCE.md).

## Performance approach

The short version: never do work proportional to the number of files when the user can
only see twenty of them.

- Importing reads metadata only, in chunks that yield to the browser. 1000 files import
  in about 100 ms.
- Thumbnails are generated lazily, off the main thread, only for cards on screen, and
  stored as ~1 KB blobs rather than full-resolution images.
- Size estimates — which mean actually re-encoding a file — are limited to visible rows.
- Conversions run a few at a time, releasing each intermediate blob as it goes.

## Known limitations

- **Browser memory is the real ceiling.** Around 1000–2000 typical photos is comfortable
  on a desktop; a mobile browser will tap out earlier, and very large source images
  (40+ megapixels) consume far more than their file size suggests.
- **Web Workers are unavailable on `file://`** in most browsers. The app still works, but
  large batches are slower. Serve over HTTP to get the worker pool.
- **BMP and GIF output** fall back to PNG — browsers do not ship encoders for them.
- **Office → PDF extracts text, not layout.** Fonts, images and formatting are lost.
  PPTX support is text-only.
- **The final ZIP is assembled in memory.** A batch whose *outputs* total more than a
  couple of gigabytes may fail at the packaging step even though every file converted.
- **PDF compression rasterises pages**, so text stops being selectable. The app keeps the
  original when rasterising would make the file bigger.
- **Reordering is within a file type** — images reorder among images, PDFs among PDFs.
- Heavy libraries come from a CDN, so the very first use of a feature needs a connection.
  After that it is cached.
