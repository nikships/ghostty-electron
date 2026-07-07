'use strict';
// Render whatever benchmark results exist as a GitHub job-summary table.
const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, '..', 'results');
const read = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')); }
  catch { return null; }
};

const parse = read('parse.json');
const summary = read('summary.json');
const pty = read('pty-bench.json');
const xterm = read('xterm.json');

console.log(`## Benchmark results — ${process.platform}/${process.arch}\n`);

if (parse) {
  console.log(`### Parse-only (${parse.payloadMB} MiB, node, no GUI)\n`);
  console.log('| parser | ms | MB/s |');
  console.log('|---|---|---|');
  console.log(`| xterm.js headless | ${parse.xterm.ms} | ${parse.xterm.MBps} |`);
  console.log(`| libghostty-vt | ${parse.ghostty.ms} | ${parse.ghostty.MBps} |`);
  console.log(`\n**speedup: ${parse.speedup}×**\n`);
}

if (summary) {
  for (const [mode, r] of Object.entries(summary)) {
    console.log(`### In-terminal ${mode} (${(r.xterm.payloadBytes / 1048576).toFixed(0)} MiB, Electron)\n`);
    console.log('| backend | parse ms | e2e ms | frames |');
    console.log('|---|---|---|---|');
    console.log(`| xterm.js + WebGL | ${r.xterm.parseMs.toFixed(1)} | ${r.xterm.e2eMs.toFixed(1)} | ${r.xterm.frames} |`);
    console.log(`| ghostty + sharedTexture | ${r.ghostty.parseMs.toFixed(1)} | ${r.ghostty.e2eMs.toFixed(1)} | ${r.ghostty.frames} |`);
    console.log('');
  }
} else if (xterm) {
  console.log(`### xterm baseline (${(xterm.payloadBytes / 1048576).toFixed(0)} MiB, Electron)\n`);
  console.log(`parse ${xterm.parseMs.toFixed(1)} ms · e2e ${xterm.e2eMs.toFixed(1)} ms · ${xterm.frames} frames · ${xterm.throughputMBps.toFixed(1)} MB/s\n`);
}

if (pty) {
  console.log(`### PTY race (${pty.sizeMB.toFixed(0)} MiB through a real zsh)\n`);
  console.log(`pipe ceiling: ${pty.pipeCeiling.MBps} MB/s\n`);
  console.log('| terminal | cat ms | MB/s | Ctrl+C→response ms | cpu s | mem growth MB |');
  console.log('|---|---|---|---|---|---|');
  console.log(`| xterm | ${pty.xterm.catMs} | ${pty.xterm.MBps} | ${pty.xterm.interruptMs} | ${pty.xterm.cpuTotal} | ${pty.xterm.peakMemMB} |`);
  console.log(`| ghostty | ${pty.ghostty.catMs} | ${pty.ghostty.MBps} | ${pty.ghostty.interruptMs} | ${pty.ghostty.cpuTotal} | ${pty.ghostty.peakMemMB} |`);
  console.log('');
}

if (!parse && !summary && !pty && !xterm) console.log('_no results produced_');
