'use strict';
/**
 * Unified benchmark runner.
 *
 * Runs both backends in two modes:
 *   burst     — cat the 1 MiB payload once (median of --runs, default 3)
 *   sustained — cat it --repeat times back-to-back (default 10 → 10 MiB),
 *               forcing steady-state parse+render interleaving
 *
 * Usage: node bench.js [--runs N] [--repeat N] [--screenshot] [--burst-only]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = require('electron');
const argv = process.argv;
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 ? parseInt(argv[i + 1], 10) : fallback;
};
const RUNS = flag('--runs', 3);
const REPEAT = flag('--repeat', 10);
const screenshot = argv.includes('--screenshot') ? ['--screenshot'] : [];

if (!fs.existsSync(path.join(__dirname, 'payload.txt'))) {
  console.error('payload.txt not found — run `npm run payload` first');
  process.exit(1);
}

const BACKENDS = [
  { key: 'xterm', name: 'xterm.js + WebGL (in-renderer DOM)', entry: 'xterm-bench/main.js', result: 'results/xterm.json' },
  { key: 'ghostty', name: 'libghostty-vt + IOSurface + sharedTexture', entry: 'ghostty-bench/main.js', result: 'results/ghostty.json' }
];

function runOnce(backend, extraArgs) {
  execFileSync(electron, [path.join(__dirname, backend.entry), ...extraArgs], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 300_000
  });
  return JSON.parse(fs.readFileSync(path.join(__dirname, backend.result), 'utf8'));
}

function runMedian(backend, extraArgs, runs) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    process.stdout.write(`running ${backend.key} ${extraArgs.join(' ') || '(burst)'} — ${i + 1}/${runs}\n`);
    results.push(runOnce(backend, extraArgs));
  }
  results.sort((a, b) => a.e2eMs - b.e2eMs);
  const median = results[Math.floor(results.length / 2)];
  median.allE2eMs = results.map(r => +r.e2eMs.toFixed(1));
  return median;
}

function printTable(title, x, g) {
  const mb = x.payloadBytes / (1024 * 1024);
  const row = (name, r) =>
    `  ${name.padEnd(46)} ${r.parseMs.toFixed(1).padStart(9)} ${r.e2eMs.toFixed(1).padStart(9)} ` +
    `${(mb / (r.e2eMs / 1000)).toFixed(1).padStart(7)} ${String(r.frames).padStart(7)}`;

  console.log('');
  console.log('═'.repeat(86));
  console.log(`  ${title} — ${mb.toFixed(0)} MiB, grid ${x.cols}×${x.rows} @${g.scale}x`);
  console.log('═'.repeat(86));
  console.log(`  ${'backend'.padEnd(46)} ${'parse ms'.padStart(9)} ${'e2e ms'.padStart(9)} ${'MB/s'.padStart(7)} ${'frames'.padStart(7)}`);
  console.log('  ' + '─'.repeat(82));
  console.log(row(BACKENDS[0].name, x));
  console.log(row(BACKENDS[1].name, g));
  console.log('  ' + '─'.repeat(82));
  console.log(`  parse speedup: ${(x.parseMs / g.parseMs).toFixed(1)}×   e2e speedup: ${(x.e2eMs / g.e2eMs).toFixed(1)}×`);
  console.log(`  ghostty per-stage: write ${g.writeMs.toFixed(1)}ms · render ${g.renderMs.toFixed(1)}ms · ` +
              `send ${g.sendMs.toFixed(1)}ms · present p50 ${g.presentP50Ms.toFixed(1)}ms / p95 ${g.presentP95Ms.toFixed(1)}ms`);
  console.log(`  e2e runs — xterm: [${x.allE2eMs.join(', ')}]  ghostty: [${g.allE2eMs.join(', ')}]`);
}

const modes = [{ title: 'BURST: cat payload once', args: [...screenshot] }];
if (!argv.includes('--burst-only')) {
  modes.push({ title: `SUSTAINED: cat payload ×${REPEAT}`, args: ['--repeat', String(REPEAT)] });
}

const summary = {};
for (const mode of modes) {
  const x = runMedian(BACKENDS[0], mode.args.filter(a => a !== '--screenshot'), RUNS);
  const g = runMedian(BACKENDS[1], mode.args, RUNS);
  printTable(mode.title, x, g);
  summary[x.mode] = { xterm: x, ghostty: g };
}

const meta = summary.burst?.xterm || summary.sustained?.xterm;
console.log('═'.repeat(86));
console.log(`  Electron ${meta.electronVersion} / Chromium ${meta.chromiumVersion} — ${meta.platform}/${meta.arch} — median of ${RUNS} runs`);
console.log('═'.repeat(86));

fs.writeFileSync(path.join(__dirname, 'results', 'summary.json'), JSON.stringify(summary, null, 2));
