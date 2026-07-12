'use strict';
// Render whatever results exist as a GitHub job-summary table.
const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, '..', 'results');
const read = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')); }
  catch { return null; }
};

const xterm = read('xterm.json');
const ghosttyWeb = read('ghostty-web.json');
const ghostty = read('ghostty.json');
const smoke = read('demo-smoke.json');
const pty = read('pty-race-summary.json');
const enginePlacement = read('engine-placement-all.json');

console.log(`## Results — ${process.platform}/${process.arch}\n`);

if (smoke) {
  console.log('### Ghostty headless embedding (demo smoke)\n');
  console.log(`ok: **${smoke.ok}** · rendered pixels: ${smoke.foregroundPixels}` +
    ` · grid ${smoke.size.cols}×${smoke.size.rows}` +
    ` (${smoke.size.widthPx}×${smoke.size.heightPx}px)` +
    ` · ${smoke.elapsedMs} ms to first content\n`);
}

const floodRows = [
  ['xterm.js + WebGL', xterm],
  ['ghostty-web WASM', ghosttyWeb],
  ['ghostty embedded', ghostty],
].filter(([, r]) => r);

if (floodRows.length) {
  console.log('### Flood benchmark (Electron)\n');
  console.log('| backend | payload | parse | e2e | frames | throughput |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const [label, r] of floodRows) {
    const parse = r.parseMs == null ? 'n/a' : `${r.parseMs.toFixed(1)} ms`;
    const mbps = r.throughputMBps ??
      ((r.payloadBytes / 1048576) / (r.e2eMs / 1000));
    console.log(`| ${label} | ${(r.payloadBytes / 1048576).toFixed(0)} MiB | ${parse} | ` +
      `${r.e2eMs.toFixed(1)} ms | ${r.frames} | ${mbps.toFixed(1)} MB/s |`);
  }
  console.log('');
}

if (pty) {
  console.log(`### PTY race (${pty.mb} MiB cat; interrupt mid-flood)\n`);
  console.log('| backend | cat | throughput | interrupt |');
  console.log('|---|---:|---:|---:|');
  for (const [key, label] of [
    ['xterm', 'xterm.js'],
    ['ghostty-web', 'ghostty-web'],
    ['ghostty', 'ghostty'],
  ]) {
    const r = pty[key];
    if (!r) continue;
    console.log(`| ${label} | ${r.catMs.toFixed(1)} ms | ${r.mbPerSec.toFixed(1)} MB/s | ` +
      `${r.interruptMs.toFixed(1)} ms |`);
  }
  console.log('');
}

if (enginePlacement?.main && enginePlacement?.utility) {
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const values = (engine, fn) => enginePlacement[engine].map(fn);
  console.log('### Engine placement\n');
  console.log('| metric | main | utility |');
  console.log('|---|---:|---:|');
  console.log(`| flood | ${med(values('main', r => r.floodMs)).toFixed(0)} ms | ` +
    `${med(values('utility', r => r.floodMs)).toFixed(0)} ms |`);
  console.log(`| create block | ${med(values('main', r => r.createBlockMs)).toFixed(1)} ms | ` +
    `${med(values('utility', r => r.createBlockMs)).toFixed(1)} ms |`);
  console.log(`| first frame | ${med(values('main', r => r.firstFrameMs)).toFixed(0)} ms | ` +
    `${med(values('utility', r => r.firstFrameMs)).toFixed(0)} ms |`);
  console.log(`| main-loop lag p99 | ${med(values('main', r => r.lag.p99)).toFixed(1)} ms | ` +
    `${med(values('utility', r => r.lag.p99)).toFixed(1)} ms |`);
  console.log('');
}

if (!smoke && floodRows.length === 0 && !pty && !enginePlacement)
  console.log('_No results produced._');
