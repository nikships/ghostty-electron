'use strict';
/**
 * Regression comparison: current results/ vs a previous run's results
 * directory (downloaded from the last successful main run in CI).
 * Prints a markdown section for the job summary; warns on >20% regressions.
 * Never fails the build — benchmarks on shared runners are too noisy for
 * hard gates; the summary makes drift visible instead.
 *
 * Usage: node scripts/compare-results.js <previous-results-dir>
 */
const fs = require('fs');
const path = require('path');

const prevDir = process.argv[2];
const curDir = path.join(__dirname, '..', 'results');

const read = (dir, f) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
  catch { return null; }
};

if (!prevDir || !fs.existsSync(prevDir)) {
  console.log('\n_No previous results to compare against._');
  process.exit(0);
}

// metric extractors: [file, label, path-fn, lower-is-better]
const METRICS = [
  ['parse.json', 'parse: ghostty MB/s', (r) => r.ghostty.MBps, false],
  ['parse.json', 'parse: ghostty-web MB/s', (r) => r.ghosttyWeb?.MBps, false],
  ['parse.json', 'parse: xterm MB/s', (r) => r.xterm.MBps, false],
  ['summary.json', 'in-terminal sustained: ghostty e2e ms', (r) => r.sustained?.ghostty.e2eMs, true],
  ['summary.json', 'in-terminal sustained: xterm e2e ms', (r) => r.sustained?.xterm.e2eMs, true],
  ['pty-bench.json', 'pty race: ghostty cat ms', (r) => r.ghostty?.catMs, true],
  ['pty-bench.json', 'pty race: xterm cat ms', (r) => r.xterm?.catMs, true],
  ['pty-bench.json', 'pty race: ghostty interrupt ms', (r) => r.ghostty?.interruptMs, true],
  ['pty-bench.json', 'pty race: xterm interrupt ms', (r) => r.xterm?.interruptMs, true],
];

const rows = [];
for (const [file, label, get, lowerBetter] of METRICS) {
  const prev = read(prevDir, file);
  const cur = read(curDir, file);
  if (!prev || !cur) continue;
  let p, c;
  try { p = get(prev); c = get(cur); } catch { continue; }
  if (p == null || c == null || !isFinite(p) || !isFinite(c) || p === 0) continue;
  const deltaPct = ((c - p) / p) * 100;
  const worse = lowerBetter ? deltaPct > 20 : deltaPct < -20;
  rows.push({ label, p, c, deltaPct, worse });
}

if (!rows.length) {
  console.log('\n_No comparable metrics between runs._');
  process.exit(0);
}

console.log('\n### vs previous main run\n');
console.log('| metric | previous | current | Δ |');
console.log('|---|---|---|---|');
for (const r of rows) {
  const flag = r.worse ? ' ⚠️' : '';
  console.log(`| ${r.label} | ${r.p} | ${r.c} | ${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%${flag} |`);
}
const regressions = rows.filter((r) => r.worse);
if (regressions.length) {
  console.log(`\n⚠️ **${regressions.length} metric(s) regressed >20%** — check whether the commit explains it (shared runners are noisy).`);
}
