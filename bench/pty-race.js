'use strict';
/**
 * PTY race orchestrator + the issue-#10 watermark sweep.
 *
 *   node bench/pty-race.js [--mb N] [--runs N]           throughput + interrupt, all backends
 *   node bench/pty-race.js --sweep [--mb N] [--runs N]   flow-control watermark sweep
 *
 * The sweep runs xterm.js at four HIGH watermarks — VS Code's real
 * 100 KB constant up to the old benchmark's 32 MiB — measuring BOTH
 * throughput and interrupt latency at each point, and prints the
 * trade-off table next to ghostty (which has no knob: backpressure is
 * inherent in owning the PTY). Answers "was the 24x interrupt
 * headline an artifact of an oversized window?" with data.
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
const MB = flag('--mb', 50);
const RUNS = flag('--runs', 3);
const SWEEP = argv.includes('--sweep');

const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function runOnce(backendKey, extra) {
  execFileSync(electron,
    [path.join(__dirname, 'pty-race-main.js'), '--backend', backendKey, ...extra],
    { stdio: ['ignore', 'ignore', 'inherit'], timeout: 400_000 });
  return JSON.parse(fs.readFileSync(
    path.join(ROOT, 'results', `pty-race-${backendKey}.json`), 'utf8'));
}

function runMedian(backendKey, extra, field) {
  const vals = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`  ${backendKey} ${extra.join(' ')} — ${i + 1}/${RUNS}\n`);
    vals.push(runOnce(backendKey, extra)[field]);
  }
  return { median: med(vals), all: vals };
}

const available = BACKENDS.filter(b =>
  !b.platforms || b.platforms.includes(process.platform));

if (SWEEP) {
  // HIGH sweep points; LOW and ack scale proportionally (VS Code's
  // ratios: LOW = HIGH/20, ack = HIGH/20).
  const POINTS = [
    { label: 'VS Code (100 KB)', high: 100_000 },
    { label: '1 MiB', high: 1024 * 1024 },
    { label: '8 MiB', high: 8 * 1024 * 1024 },
    { label: '32 MiB (old bench)', high: 32 * 1024 * 1024 },
  ];
  const rows = [];
  for (const pt of POINTS) {
    const fc = ['--fc-high', String(pt.high),
                '--fc-low', String(Math.max(5000, Math.round(pt.high / 20))),
                '--fc-ack', String(Math.max(5000, Math.round(pt.high / 20)))];
    const cat = runMedian('xterm', ['--mb', String(MB), ...fc], 'catMs');
    const intr = runMedian('xterm',
      ['--interrupt', '--mb', String(MB * 20), ...fc], 'interruptMs');
    rows.push({ ...pt, catMs: cat.median, catAll: cat.all,
                interruptMs: intr.median, interruptAll: intr.all });
  }
  // ghostty reference (no knob to sweep).
  const gCat = runMedian('ghostty', ['--mb', String(MB)], 'catMs');
  const gIntr = runMedian('ghostty',
    ['--interrupt', '--mb', String(MB * 20)], 'interruptMs');

  console.log('');
  console.log('═'.repeat(78));
  console.log(`  xterm.js flow-control watermark sweep — cat ${MB} MiB / interrupt mid-flood`);
  console.log(`  (LOW and ack quantum scale as HIGH/20, VS Code's ratios)`);
  console.log('═'.repeat(78));
  console.log(`  ${'HIGH watermark'.padEnd(22)} ${'cat ms'.padStart(9)} ${'MB/s'.padStart(7)} ${'interrupt ms'.padStart(13)}`);
  console.log('  ' + '─'.repeat(74));
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(22)} ${r.catMs.toFixed(0).padStart(9)} ` +
      `${(MB / (r.catMs / 1000)).toFixed(1).padStart(7)} ${r.interruptMs.toFixed(1).padStart(13)}`);
  }
  console.log('  ' + '─'.repeat(74));
  console.log(`  ${'ghostty (no knob)'.padEnd(22)} ${gCat.median.toFixed(0).padStart(9)} ` +
    `${(MB / (gCat.median / 1000)).toFixed(1).padStart(7)} ${gIntr.median.toFixed(1).padStart(13)}`);
  console.log('═'.repeat(78));

  fs.writeFileSync(path.join(ROOT, 'results', 'pty-sweep.json'), JSON.stringify({
    mb: MB, runs: RUNS, points: rows,
    ghostty: { catMs: gCat.median, catAll: gCat.all,
               interruptMs: gIntr.median, interruptAll: gIntr.all },
  }, null, 2));
} else {
  const summary = {};
  for (const b of available) {
    if (b.key === 'ghostty-web' && argv.includes('--skip-web')) continue;
    const cat = runMedian(b.key, ['--mb', String(MB)], 'catMs');
    const intr = runMedian(b.key,
      ['--interrupt', '--mb', String(MB * 20)], 'interruptMs');
    summary[b.key] = {
      catMs: cat.median, catAll: cat.all,
      mbPerSec: +(MB / (cat.median / 1000)).toFixed(1),
      interruptMs: intr.median, interruptAll: intr.all,
    };
  }
  console.log('');
  console.log('═'.repeat(70));
  console.log(`  PTY race — cat ${MB} MiB through a real zsh / interrupt mid-flood`);
  console.log('═'.repeat(70));
  console.log(`  ${'backend'.padEnd(14)} ${'cat ms'.padStart(9)} ${'MB/s'.padStart(7)} ${'interrupt ms'.padStart(13)}`);
  console.log('  ' + '─'.repeat(66));
  for (const [key, r] of Object.entries(summary)) {
    console.log(`  ${key.padEnd(14)} ${r.catMs.toFixed(0).padStart(9)} ` +
      `${String(r.mbPerSec).padStart(7)} ${r.interruptMs.toFixed(1).padStart(13)}`);
  }
  console.log('═'.repeat(70));
  console.log('  NOTE: DOM backends use VS Code\'s real flow-control constants');
  console.log('  (100K/5K/5K) by default; ghostty owns its PTY (no flow control');
  console.log('  needed) and its sentinel is title-change + presented frame.');
  fs.writeFileSync(
    path.join(ROOT, 'results', 'pty-race-summary.json'),
    JSON.stringify({ mb: MB, runs: RUNS, ...summary }, null, 2));
}
