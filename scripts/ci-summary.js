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
const smoke = read('demo-smoke.json');

console.log(`## Results — ${process.platform}/${process.arch}\n`);

if (smoke) {
  console.log('### Ghostty headless embedding (demo smoke)\n');
  console.log(`ok: **${smoke.ok}** · rendered pixels: ${smoke.foregroundPixels}` +
    ` · grid ${smoke.size.cols}×${smoke.size.rows}` +
    ` (${smoke.size.widthPx}×${smoke.size.heightPx}px)` +
    ` · ${smoke.elapsedMs} ms to first content\n`);
}

if (xterm) {
  console.log(`### xterm.js baseline (${(xterm.payloadBytes / 1048576).toFixed(0)} MiB, Electron)\n`);
  console.log(`parse ${xterm.parseMs.toFixed(1)} ms · e2e ${xterm.e2eMs.toFixed(1)} ms` +
    ` · ${xterm.frames} frames · ${xterm.throughputMBps.toFixed(1)} MB/s\n`);
}

if (ghosttyWeb) {
  console.log(`### ghostty-web WASM baseline (${(ghosttyWeb.payloadBytes / 1048576).toFixed(0)} MiB, Electron)\n`);
  console.log(`parse ${ghosttyWeb.parseMs.toFixed(1)} ms · e2e ${ghosttyWeb.e2eMs.toFixed(1)} ms` +
    ` · ${ghosttyWeb.frames} frames\n`);
}

if (!smoke && !xterm && !ghosttyWeb) console.log('_No results produced._');
