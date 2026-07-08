'use strict';
/**
 * Parser benchmark — plain Node, no Electron, no GUI: runs on every OS.
 *
 * Feeds the identical byte stream through three VT engines, timing parse +
 * terminal state maintenance only. This isolates the component the
 * architecture comparison hinges on:
 *
 *   xterm.js headless — the emulator VS Code ships (terminal logic in JS)
 *   ghostty-web       — coder/ghostty-web: ghostty's engine compiled to WASM
 *   libghostty-vt     — the same engine as a native N-API addon
 *
 * xterm-vs-ghostty is the JS-vs-native story; ghostty-web sits between them
 * — the *same* ghostty parser as libghostty-vt, but crossing the WASM
 * boundary instead of running natively — so the two ghostty rows read as the
 * cost of the WASM sandbox on an otherwise identical engine.
 *
 * ghostty-web ships for the browser (its default `init()` reaches for
 * `self.location`); we shim that one global so its headless `Ghostty.load()`
 * path — base64 WASM over Node's `fetch` — runs in plain Node. If it can't
 * load on some runner, the benchmark degrades to the xterm-vs-native pair.
 *
 * Usage: node scripts/bench-parse.js [--mb N] [--runs N]
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));
const { Terminal } = require('@xterm/headless');

// ghostty-web targets the browser; give it the one browser global its
// headless load path touches, then load the WASM engine. Optional: a load
// failure on an exotic runner leaves the two-way comparison intact.
globalThis.self = globalThis.self || {
  location: pathToFileURL(path.join(__dirname, '..', 'node_modules', 'ghostty-web', 'dist') + path.sep).href
};
let GhosttyWeb = null;
try {
  GhosttyWeb = require('ghostty-web').Ghostty;
} catch (err) {
  console.error(`ghostty-web unavailable (${err.message}); running xterm vs libghostty-vt only`);
}

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : fallback;
};
const MB = flag('--mb', 10);
const RUNS = flag('--runs', 3);
const COLS = 120;
const ROWS = 30;
const CHUNK = 64 * 1024;

const payloadPath = path.join(__dirname, '..', 'payload.txt');
if (!fs.existsSync(payloadPath)) {
  console.error('payload.txt not found — run `npm run payload` first');
  process.exit(1);
}
const payload = fs.readFileSync(payloadPath);
const payloadStr = payload.toString('latin1'); // ASCII payload; xterm takes strings

function benchGhostty() {
  const t = addon.create(COLS, ROWS, 13, 1);
  const t0 = performance.now();
  for (let r = 0; r < MB; r++)
    for (let off = 0; off < payload.length; off += CHUNK)
      addon.write(t.session, payload.subarray(off, off + CHUNK));
  return performance.now() - t0;
}

// Same byte-chunked feed as the native addon, so the only variable between
// the two ghostty rows is native call vs WASM boundary crossing.
function benchGhosttyWeb(ghostty) {
  const t = ghostty.createTerminal(COLS, ROWS);
  const t0 = performance.now();
  for (let r = 0; r < MB; r++)
    for (let off = 0; off < payload.length; off += CHUNK)
      t.write(payload.subarray(off, off + CHUNK));
  const ms = performance.now() - t0;
  t.free();
  return ms;
}

async function benchXterm() {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true });
  const t0 = performance.now();
  for (let r = 0; r < MB; r++) {
    for (let off = 0; off < payloadStr.length; off += CHUNK) {
      await new Promise((resolve) => term.write(payloadStr.slice(off, off + CHUNK), resolve));
    }
  }
  const ms = performance.now() - t0;
  term.dispose();
  return ms;
}

function median(runs) {
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

(async () => {
  let ghosttyWeb = null;
  if (GhosttyWeb) {
    try {
      ghosttyWeb = await GhosttyWeb.load();
    } catch (err) {
      console.error(`ghostty-web failed to load WASM (${err.message}); skipping it`);
    }
  }

  const totalMB = (payload.length * MB) / (1024 * 1024);
  const g = [], x = [], w = [];
  for (let i = 0; i < RUNS; i++) {
    g.push(benchGhostty());
    x.push(await benchXterm());
    if (ghosttyWeb) w.push(benchGhosttyWeb(ghosttyWeb));
  }
  const gMs = median(g), xMs = median(x);
  const wMs = w.length ? median(w) : null;
  const MBps = (ms) => +(totalMB / (ms / 1000)).toFixed(1);

  const out = {
    mode: 'parse-only',
    payloadMB: +totalMB.toFixed(1),
    runs: RUNS,
    cols: COLS,
    rows: ROWS,
    ghostty: { ms: +gMs.toFixed(1), MBps: MBps(gMs) },
    xterm: { ms: +xMs.toFixed(1), MBps: MBps(xMs) },
    speedup: +(xMs / gMs).toFixed(1),
    node: process.version,
    platform: process.platform,
    arch: process.arch
  };
  if (wMs != null) {
    out.ghosttyWeb = { ms: +wMs.toFixed(1), MBps: MBps(wMs) };
    // native vs WASM on the identical engine — the sandbox tax
    out.wasmVsNative = +(wMs / gMs).toFixed(1);
    // how much just moving to the ghostty engine (WASM) buys over xterm.js
    out.ghosttyWebSpeedup = +(xMs / wMs).toFixed(1);
  }

  console.log('═'.repeat(74));
  console.log(`  PARSE-ONLY: ${totalMB.toFixed(0)} MiB through each parser — grid ${COLS}×${ROWS}, median of ${RUNS}`);
  console.log(`  node ${process.version} — ${process.platform}/${process.arch}`);
  console.log('═'.repeat(74));
  console.log(`  xterm.js headless   ${out.xterm.ms.toFixed(0).padStart(8)} ms   ${String(out.xterm.MBps).padStart(7)} MB/s`);
  if (out.ghosttyWeb)
    console.log(`  ghostty-web (WASM)  ${out.ghosttyWeb.ms.toFixed(0).padStart(8)} ms   ${String(out.ghosttyWeb.MBps).padStart(7)} MB/s`);
  console.log(`  libghostty-vt       ${out.ghostty.ms.toFixed(0).padStart(8)} ms   ${String(out.ghostty.MBps).padStart(7)} MB/s`);
  console.log('  ' + '─'.repeat(70));
  console.log(`  libghostty-vt vs xterm.js:        ${out.speedup}×`);
  if (out.ghosttyWeb) {
    console.log(`  ghostty-web  vs xterm.js:        ${out.ghosttyWebSpeedup}×`);
    console.log(`  libghostty-vt vs ghostty-web:    ${out.wasmVsNative}×  (native over WASM, same engine)`);
  }
  console.log('═'.repeat(74));

  const resultsDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'parse.json'), JSON.stringify(out, null, 2));
})();
