'use strict';
/**
 * Unified benchmark runner: runs both backends (each N times, keeping the
 * median-by-e2e run), then prints a comparison table.
 *
 * Usage: node bench.js [--runs N] [--screenshot]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = require('electron'); // resolves to the binary path in node
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg !== -1 ? parseInt(process.argv[runsArg + 1], 10) : 3;
const screenshot = process.argv.includes('--screenshot') ? ['--screenshot'] : [];

if (!fs.existsSync(path.join(__dirname, 'payload.txt'))) {
  console.error('payload.txt not found — run `npm run payload` first');
  process.exit(1);
}

const BACKENDS = [
  { key: 'xterm', entry: 'xterm-bench/main.js', result: 'results/xterm.json' },
  { key: 'ghostty', entry: 'ghostty-bench/main.js', result: 'results/ghostty.json' }
];

function runOnce(backend) {
  execFileSync(electron, [path.join(__dirname, backend.entry), ...screenshot], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 120_000
  });
  return JSON.parse(fs.readFileSync(path.join(__dirname, backend.result), 'utf8'));
}

const results = {};
for (const backend of BACKENDS) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`running ${backend.key} (${i + 1}/${RUNS})...\n`);
    runs.push(runOnce(backend));
  }
  runs.sort((a, b) => a.e2eMs - b.e2eMs);
  const median = runs[Math.floor(runs.length / 2)];
  median.allE2eMs = runs.map(r => +r.e2eMs.toFixed(1));
  results[backend.key] = median;
  fs.writeFileSync(path.join(__dirname, backend.result), JSON.stringify(median, null, 2));
}

const x = results.xterm;
const g = results.ghostty;
const mb = x.payloadBytes / (1024 * 1024);
const row = (name, r) =>
  `  ${name.padEnd(46)} ${r.parseMs.toFixed(1).padStart(8)} ${r.e2eMs.toFixed(1).padStart(8)} ` +
  `${((mb / (r.e2eMs / 1000))).toFixed(1).padStart(7)} ${String(r.frames).padStart(7)}`;

console.log('');
console.log('═'.repeat(84));
console.log(`  cat ${x.payloadBytes} bytes (${mb.toFixed(1)} MiB, newline-heavy) — grid ${x.cols}×${x.rows}`);
console.log(`  Electron ${x.electronVersion} / Chromium ${x.chromiumVersion} — ${x.platform}/${x.arch} — median of ${RUNS} runs`);
console.log('═'.repeat(84));
console.log(`  ${'backend'.padEnd(46)} ${'parse ms'.padStart(8)} ${'e2e ms'.padStart(8)} ${'MB/s'.padStart(7)} ${'frames'.padStart(7)}`);
console.log('  ' + '─'.repeat(80));
console.log(row('xterm.js + WebGL (in-renderer DOM)', x));
console.log(row('libghostty-vt + IOSurface + sharedTexture', g));
console.log('  ' + '─'.repeat(80));
console.log(`  parse speedup (ghostty vs xterm):  ${(x.parseMs / g.parseMs).toFixed(1)}×`);
console.log(`  e2e speedup   (ghostty vs xterm):  ${(x.e2eMs / g.e2eMs).toFixed(1)}×`);
console.log(`  all e2e runs — xterm: [${x.allE2eMs.join(', ')}] ghostty: [${g.allE2eMs.join(', ')}]`);
console.log('═'.repeat(84));
