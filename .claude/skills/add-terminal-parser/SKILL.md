---
name: add-terminal-parser
description: Add another terminal/VT engine to the benchmark suite — register it in bench/backends.js, integrate it into the parse/flood/PTY suites, measure real local numbers, update the README tables, and regenerate the README benchmark SVGs with the new values. Use when the user asks to benchmark/compare another terminal emulator, VT parser, or terminal engine (e.g. "add X to the benchmark", "compare against Y").
---

# Add a terminal to the benchmark

All benchmarks live in one app: `bench/`. Every suite iterates the backend
registry in **`bench/backends.js`** — that file is the single place a new
terminal is added. The reporting pipeline (`scripts/ci-summary.js` TERMINALS
list, `scripts/compare-results.js` METRICS, `scripts/gen-chart.js` ROWS) also
keys off per-backend result fields.

Suites: `node bench/run.js parse | flood | pty` (npm aliases `bench:parse`,
`bench`, `bench:pty`). CI runs all of them on three OSes and renders
`ci-summary.js` into each job summary — new registry entries flow through
with **no CI YAML changes** unless the terminal needs its own install step.

## Backend kinds

- **`dom`** — any library speaking the xterm.js API (`write()`,
  `buffer.active.getLine().translateToString()`, `onData`, `open(el)`),
  rendering in the Chromium renderer. Cheap to add: one registry entry + one
  factory case in `bench/dom-terminal.js`. The flood app
  (`flood-dom-main.js --backend <key>`) and the PTY DOM runner
  (`pty-main.js`, `pty-dom.html`) are already parameterized over these.
- **`native`** — parses in the main process, presents via sharedTexture.
  Bespoke by nature (libghostty is the only one); budget a real project.

## Step 1 — Prove it runs first, in isolation

In a scratch dir (`/tmp/<name>-inspect`): `npm install` it, create a
terminal, `write()` bytes, read state back — once in plain Node (for the
parse suite) and once considering the browser path. Many terminal packages
ship browser-only. Precedent from ghostty-web:

- Node: its loader touched `self.location` → one-global shim where
  `location` must be a **URL string** (`pathToFileURL(...).href`), then the
  default base64-data-URL WASM load works over Node's `fetch`. Its explicit
  file-path load API is broken in Node (Vite browser-external stub).
- Renderer: no shim needed; `Ghostty.load()` + `new Terminal({ghostty})`.
- Check three API semantics that WILL differ between libraries:
  1. **write callback** — xterm.js fires it when bytes are parsed (await it
     = flow control); ghostty-web parses synchronously and defers the
     callback to rAF (awaiting it benchmarks the display refresh — set
     `syncWrite: true` and ack/yield after write returns instead). When
     yielding in a loop use MessageChannel, not setTimeout(0): Chromium's
     nested-timer clamp (~4 ms) bills ~0.6 s/MiB of pure wait to the parser.
  2. **onRender** — ghostty-web declares but never fires it; frames are
     counted via rAF ticks for syncWrite backends.
  3. **buffer viewport base** — xterm.js: `buffer.active.baseY`; ghostty-web
     reports baseY/viewportY as 0 but `length` includes scrollback, so
     `length - rows` is the portable viewport base (what `pty-dom.html`
     uses).

## Step 2 — Register and integrate

1. `npm install --save-dev <package>@<version>`; verify `package-lock.json`
   picked it up (CI uses `npm ci`).
2. Add the entry to `bench/backends.js`: key, `resultKey` (camelCase field
   used in every results JSON — stable forever, compare-results diffs it
   against old runs), `resultFile`, name, kind, `syncWrite` (dom only).
3. `dom` kind: add a factory case in `bench/dom-terminal.js` returning
   `{term, onContextLoss, writeChunk}`. `writeChunk` must resolve when the
   chunk is *parsed* (see semantics above).
4. Parse suite: add a `benchX()` in `bench/parse.js` mirroring the existing
   three — fresh terminal per run, identical 64 KiB chunks, time only the
   write loop, free resources, try/catch fallback so no runner can break.
   Add `{ms, MBps}` + ratio fields to the output JSON, guarded on load.
5. Reporting: add a `[resultKey, label]` pair to TERMINALS in
   `scripts/ci-summary.js`; add null-safe METRICS lines (parse MB/s, flood
   e2e, pty cat, pty interrupt) in `scripts/compare-results.js`.
6. Integration tests: clone the flood test in `test/integration.test.js`
   for the new backend; add its resultKey to the pty-bench assertion loop
   (only if it runs on all platforms the test runs on).

## Step 3 — Measure (fairness is the product)

Build prerequisites, in order (skip what exists):

```bash
npm install && npm run payload
npm run setup:ghostty     # zig 0.15.2 EXACTLY — see traps
npm run build:native
```

Traps:
- In a git worktree, `vendor/` (gitignored) won't exist even when the main
  checkout has it built — `ln -s <main-checkout>/vendor vendor`, build only
  the addon, and remove the symlink before committing.
- ghostty pins zig 0.15.2; `setup:ghostty` exits 0 even when the zig build
  silently failed on a version mismatch (surfaces later as missing
  `ghostty/vt.h`). Fetch the pinned toolchain from ziglang.org if needed.
- Don't test dir existence with `ls dir | head && echo exists` — the pipe
  masks the exit code.

Run each suite with the CI flags, twice, confirming stable ratios:

```bash
npm run bench:parse -- --mb 10 --runs 3
npm run bench -- --runs 3                                # flood
npx electron bench/pty-main.js --mb 1024                 # the real 1 GiB race
npx electron bench/pty-main.js --latency --mb 8
```

- Check machine load first (`uptime`); on a loaded machine ratios reproduce
  but absolutes sag — don't overwrite documented numbers with a noisy run.
- Verify the results JSONs have the new fields and `node
  scripts/ci-summary.js` renders the new rows.
- Deliberately break the new module (rename its node_modules dir) and
  confirm the parse suite degrades instead of crashing.
- `npm test` and `npm run test:integration` must pass.

## Step 4 — Chart + README

`scripts/gen-chart.js` → `assets/benchmarks-{light,dark}.svg` (the README
`<picture>`). It reads `results/*.json` with checked-in fallbacks.

1. Add the new backend's value to each ROWS entry (guarded `?.` read +
   fallback constant from your fresh run) and a THEMES color + legend line.
   Pick the color with the `dataviz` skill's validator against both GitHub
   surfaces (`#ffffff` / `#0d1117`) — light and dark need separately chosen
   hexes (existing: amber `#eda100` light / `#bf8300` dark). Direct value
   labels stay on every bar; the per-row ratio stays native-vs-xterm; row
   height already scales with series count.
2. Regenerate with fallbacks only (stash `results/` aside so noisy local
   numbers don't leak in): `mv results /tmp/r && node scripts/gen-chart.js
   && mv /tmp/r results`. Rasterize and LOOK at both SVGs (qlmanage or
   open): label collisions, legend, bar scale.
3. README: add the terminal to the intro list, every affected metric table,
   the platform matrix, the Layout section, and the `<img alt>` text.

## Step 5 — Ship

Branch, commit (double-check `package-lock.json` + both SVGs staged), PR
with the measured-numbers table in the commit message — follow the style of
the ghostty-web PRs. After CI, pull the other OSes' numbers from the job
summaries into any *"see CI"* README cells.
