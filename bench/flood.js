'use strict';
/**
 * In-terminal flood orchestrator: runs every backend in the registry in two
 * modes and prints the comparison table.
 *
 *   burst     — cat the 1 MiB payload once (median of --runs, default 3)
 *   sustained — cat it --repeat times back-to-back (default 10 → 10 MiB),
 *               forcing steady-state parse+render interleaving
 *
 * DOM backends run through bench/flood-dom-main.js (one Electron app,
 * parameterized). A backend that can't run here is
 * reported and skipped — the comparison degrades, never breaks.
 *
 * Usage: node bench/flood.js [--runs N] [--repeat N] [--screenshot] [--burst-only]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = require('electron');
const { BACKENDS } = require('./backends');

const ROOT = path.join(__dirname, '..');
const argv = process.argv;
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 ? parseInt(argv[i + 1], 10) : fallback;
};
const RUNS = flag('--runs', 3);
const REPEAT = flag('--repeat', 10);
const screenshot = argv.includes('--screenshot') ? ['--screenshot'] : [];

if (!fs.existsSync(path.join(ROOT, 'payload.txt'))) {
  console.error('payload.txt not found — run `npm run payload` first');
  process.exit(1);
}

function entryArgs(backend) {
  // Only DOM backends remain; the native producer was replaced by the
  // headless ghostty embedding (see demo-ghostty-renderer/).
  return [path.join(__dirname, 'flood-dom-main.js'), '--backend', backend.key];
}

function runOnce(backend, extraArgs) {
  execFileSync(electron, [...entryArgs(backend), ...extraArgs], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 300_000
  });
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'results', backend.resultFile), 'utf8'));
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

function printTable(title, rows) {
  const baseline = rows[0]; // registry order: xterm.js first
  const mb = baseline.result.payloadBytes / (1024 * 1024);
  const scale = rows[rows.length - 1].result.scale;
  const row = (name, r) =>
    `  ${name.padEnd(46)} ${r.parseMs.toFixed(1).padStart(9)} ${r.e2eMs.toFixed(1).padStart(9)} ` +
    `${(mb / (r.e2eMs / 1000)).toFixed(1).padStart(7)} ${String(r.frames).padStart(7)}`;

  console.log('');
  console.log('═'.repeat(86));
  console.log(`  ${title} — ${mb.toFixed(0)} MiB, grid ${baseline.result.cols}×${baseline.result.rows} @${scale}x`);
  console.log('═'.repeat(86));
  console.log(`  ${'backend'.padEnd(46)} ${'parse ms'.padStart(9)} ${'e2e ms'.padStart(9)} ${'MB/s'.padStart(7)} ${'frames'.padStart(7)}`);
  console.log('  ' + '─'.repeat(82));
  for (const { backend, result } of rows) console.log(row(backend.name, result));
  console.log('  ' + '─'.repeat(82));
  for (const { backend, result } of rows.slice(1)) {
    console.log(`  ${backend.key} vs ${rows[0].backend.key} — ` +
      `parse: ${(baseline.result.parseMs / result.parseMs).toFixed(1)}×   ` +
      `e2e: ${(baseline.result.e2eMs / result.e2eMs).toFixed(1)}×`);
  }
  for (const { backend, result } of rows)
    console.log(`  e2e runs — ${backend.key}: [${result.allE2eMs.join(', ')}]`);
}

const modes = [{ title: 'BURST: cat payload once', args: [...screenshot] }];
if (!argv.includes('--burst-only')) {
  modes.push({ title: `SUSTAINED: cat payload ×${REPEAT}`, args: ['--repeat', String(REPEAT)] });
}

const summary = {};
for (const mode of modes) {
  const rows = [];
  for (const backend of BACKENDS) {
    // Screenshots only apply to the native backend's pixel-equivalence check.
    const args = backend.kind === 'dom' ? mode.args.filter(a => a !== '--screenshot') : mode.args;
    try {
      rows.push({ backend, result: runMedian(backend, args, RUNS) });
    } catch (err) {
      console.error(`${backend.key} failed on this platform (${err.message.split('\n')[0]}); skipping`);
    }
  }
  if (rows.length < 2) {
    console.error('fewer than two backends ran — no comparison to print');
    process.exit(1);
  }
  printTable(mode.title, rows);
  const modeKey = rows[0].result.mode;
  summary[modeKey] = Object.fromEntries(rows.map(({ backend, result }) => [backend.resultKey, result]));
}

// Any backend's result carries the environment metadata; xterm may have
// been skipped on this platform.
const meta = Object.values(summary.burst || summary.sustained)[0];
console.log('═'.repeat(86));
console.log(`  Electron ${meta.electronVersion} / Chromium ${meta.chromiumVersion} — ${meta.platform}/${meta.arch} — median of ${RUNS} runs`);
console.log('═'.repeat(86));

fs.writeFileSync(path.join(ROOT, 'results', 'summary.json'), JSON.stringify(summary, null, 2));
