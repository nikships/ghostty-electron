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
const ghosttyWebFlood = read('ghostty-web.json');
const latency = read('pty-latency.json');
const soak = read('pty-soak.json');
const stress = read('render-stress.json');

console.log(`## Benchmark results — ${process.platform}/${process.arch}\n`);

if (parse) {
  console.log(`### Parse-only (${parse.payloadMB} MiB, node, no GUI)\n`);
  console.log('| parser | ms | MB/s |');
  console.log('|---|---|---|');
  console.log(`| xterm.js headless | ${parse.xterm.ms} | ${parse.xterm.MBps} |`);
  if (parse.ghosttyWeb)
    console.log(`| ghostty-web (WASM) | ${parse.ghosttyWeb.ms} | ${parse.ghosttyWeb.MBps} |`);
  console.log(`| libghostty-vt (native) | ${parse.ghostty.ms} | ${parse.ghostty.MBps} |`);
  console.log(`\n**libghostty-vt vs xterm.js: ${parse.speedup}×**`);
  if (parse.ghosttyWeb)
    console.log(` · ghostty-web vs xterm.js: ${parse.ghosttyWebSpeedup}× · native vs WASM (same engine): ${parse.wasmVsNative}×`);
  console.log('');
}

// Ordered [resultKey, label] pairs for every backend a suite may report;
// rows render only when that backend produced results (older baselines and
// platform-limited runs simply have fewer rows).
const TERMINALS = [
  ['xterm', 'xterm.js + WebGL'],
  ['ghosttyWeb', 'ghostty-web (WASM)'],
  ['ghostty', 'ghostty + sharedTexture']
];
const present = (r) => TERMINALS.filter(([key]) => r[key]);

if (summary) {
  for (const [mode, r] of Object.entries(summary)) {
    const first = present(r)[0];
    if (!first) continue;
    console.log(`### In-terminal ${mode} (${(r[first[0]].payloadBytes / 1048576).toFixed(0)} MiB, Electron)\n`);
    console.log('| backend | parse ms | e2e ms | frames |');
    console.log('|---|---|---|---|');
    for (const [key, label] of present(r))
      console.log(`| ${label} | ${r[key].parseMs.toFixed(1)} | ${r[key].e2eMs.toFixed(1)} | ${r[key].frames} |`);
    console.log('');
  }
} else if (xterm || ghosttyWebFlood) {
  // Standalone DOM flood runs (Linux/Windows CI — no orchestrated summary).
  console.log(`### DOM terminal flood (Electron)\n`);
  console.log('| backend | parse ms | e2e ms | frames | MB/s |');
  console.log('|---|---|---|---|---|');
  for (const [label, r] of [['xterm.js + WebGL', xterm], ['ghostty-web (WASM)', ghosttyWebFlood]]) {
    if (r) console.log(`| ${label} | ${r.parseMs.toFixed(1)} | ${r.e2eMs.toFixed(1)} | ${r.frames} | ${r.throughputMBps.toFixed(1)} |`);
  }
  console.log('');
}

if (pty) {
  console.log(`### PTY race (${pty.sizeMB.toFixed(0)} MiB through a real zsh)\n`);
  console.log(`pipe ceiling: ${pty.pipeCeiling.MBps} MB/s\n`);
  console.log('| terminal | cat ms | MB/s | Ctrl+C→response ms | cpu s | mem growth MB |');
  console.log('|---|---|---|---|---|---|');
  for (const [key, label] of present(pty))
    console.log(`| ${label} | ${pty[key].catMs} | ${pty[key].MBps} | ${pty[key].interruptMs} | ${pty[key].cpuTotal} | ${pty[key].peakMemMB} |`);
  console.log('');
}

if (latency) {
  console.log('### Input latency (keystroke → echo visible)\n');
  console.log('| terminal | idle p50 | idle p95 | busy p50 | busy p95 |');
  console.log('|---|---|---|---|---|');
  for (const [key, label] of present(latency))
    console.log(`| ${label} | ${latency[key].idleP50Ms} | ${latency[key].idleP95Ms} | ${latency[key].floodP50Ms} | ${latency[key].floodP95Ms} |`);
  console.log('');
}

if (soak) {
  console.log(`### Soak (${soak.minutes} min sustained output) — ${soak.pass ? 'PASS' : 'FAIL'}\n`);
  console.log('| terminal | consumed MB | mem slope MB/min | cpu s |');
  console.log('|---|---|---|---|');
  for (const [key, label] of present(soak))
    console.log(`| ${label} | ${soak[key].bytesConsumedMB} | ${soak[key].memSlopeMBperMin} | ${soak[key].cpuTotal} |`);
  console.log('');
}

if (stress) {
  console.log(`### Render stress: ${stress.fullRedrawsPerSec} full-damage 4K redraws/s (avg ${stress.avgRenderMs} ms) — ${stress.verdict}\n`);
}

if (!parse && !summary && !pty && !xterm) console.log('_no results produced_');
