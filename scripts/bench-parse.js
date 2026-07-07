'use strict';
/**
 * Parser benchmark — plain Node, no Electron, no GUI: runs on every OS.
 *
 * Feeds the identical byte stream to libghostty-vt (native addon) and
 * @xterm/headless (the emulator VS Code ships), timing parse + terminal
 * state maintenance only. This isolates the component the architecture
 * comparison hinges on.
 *
 * Usage: node scripts/bench-parse.js [--mb N] [--runs N]
 */
const fs = require('fs');
const path = require('path');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));
const { Terminal } = require('@xterm/headless');

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
  const totalMB = (payload.length * MB) / (1024 * 1024);
  const g = [], x = [];
  for (let i = 0; i < RUNS; i++) {
    g.push(benchGhostty());
    x.push(await benchXterm());
  }
  const gMs = median(g), xMs = median(x);
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

  console.log('═'.repeat(74));
  console.log(`  PARSE-ONLY: ${totalMB.toFixed(0)} MiB through both parsers — grid ${COLS}×${ROWS}, median of ${RUNS}`);
  console.log(`  node ${process.version} — ${process.platform}/${process.arch}`);
  console.log('═'.repeat(74));
  console.log(`  xterm.js headless   ${out.xterm.ms.toFixed(0).padStart(8)} ms   ${String(out.xterm.MBps).padStart(7)} MB/s`);
  console.log(`  libghostty-vt       ${out.ghostty.ms.toFixed(0).padStart(8)} ms   ${String(out.ghostty.MBps).padStart(7)} MB/s`);
  console.log(`  speedup: ${out.speedup}×`);
  console.log('═'.repeat(74));

  const resultsDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'parse.json'), JSON.stringify(out, null, 2));
})();
