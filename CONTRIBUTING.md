# Contributing

Small project, short rules.

## Setup

```bash
git clone https://github.com/shresthadeep77-wq/images-pdfconveter
cd images-pdfconveter
npm install          # one dev-only dependency: playwright-core
npm start            # http://localhost:5173
```

Open `index.html` directly if you prefer, but serve it over HTTP when working on anything
performance-related — Web Workers are blocked on `file://`.

## Structure

```
index.html          the whole app: markup, CSS, JavaScript
tests/run-tests.mjs browser-driven tests + benchmark
tools/check.mjs     static checks (there is no bundler)
```

`ARCHITECTURE.md` maps the script section by section. Start there.

## Conventions

- **Keep `index.html` self-contained.** No build step, no ES modules, no framework. It has
  to work when double-clicked.
- Vanilla JS. 4-space indent, semicolons, `const` by default.
- Reuse the existing CSS variables (`--ink`, `--signal`, `--surface`, `--line`, …) rather
  than hard-coding colours, so both themes keep working.
- Filenames and error text go through `textContent`. Never `innerHTML`.
- User-facing errors go through `friendlyError()` — no stack traces in the UI.
- New interactive elements are real `<button>`s with an accessible name and a ≥ 44 px
  touch target.
- Do not communicate state with colour alone; pair it with an icon and a word.

## Before you open a PR

```bash
npm run build     # static checks — fast, run after every edit
npm test          # full suite including the 1000-file batch
```

Both must pass. If you touched rendering, import, workers or concurrency, paste the
benchmark table from the end of `npm test` into the PR description.

## Performance is a feature here

The one rule: **never do work proportional to the number of files when only twenty are on
screen.** Before adding a per-file loop, check whether it can be limited to the visible
window instead.

`AGENTS.md` lists the parts that exist purely to make large batches work. Read
`PERFORMANCE.md` before changing any of them.

## PR expectations

- One focused change per PR.
- Say what you changed and why; note anything you deliberately left out.
- Update `AGENTS.md`, `ARCHITECTURE.md` or `PERFORMANCE.md` in the same PR if you changed
  what they describe.
- New behaviour gets a test in `tests/run-tests.mjs` — it is a plain script, just add a
  `test(...)` block.
