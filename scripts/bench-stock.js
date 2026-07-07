'use strict';
/**
 * Stock-terminal reference: how fast does the REAL Ghostty.app (native,
 * no Electron) consume the same payload?
 *
 * We can't read a stock terminal's screen, so the only honest finish line is
 * write-side: the shell times `cat` itself (backpressure means cat can't
 * finish until the terminal has consumed the bytes). The Electron terminals
 * report the same finish line as `catExitMs` in `npm run bench:pty` results,
 * so all three are compared like-for-like. CPU/RSS of the Ghostty process is
 * sampled via ps.
 *
 * Usage: node scripts/bench-stock.js [--mb N] [--app /Applications/Ghostty.app]
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'darwin') {
  console.error('bench:stock drives Ghostty.app (macOS only).');
  process.exit(1);
}

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const SIZE_MB = parseInt(flag('--mb', '256'), 10);
const APP = flag('--app', '/Applications/Ghostty.app');

if (!fs.existsSync(APP)) {
  console.error(`${APP} not found — install Ghostty or pass --app`);
  process.exit(1);
}

// Reuse pty-bench's payload naming so files are shared between benchmarks.
const payload = path.join(__dirname, '..', `payload-${SIZE_MB}mb.txt`);
if (!fs.existsSync(payload)) {
  console.log(`generating ${SIZE_MB} MiB payload...`);
  const base = [];
  let bytes = 0, n = 0;
  while (bytes < 1024 * 1024) {
    const kind = n % 8;
    let line;
    if (kind === 0) line = `\x1b[32m[${n}]\x1b[0m ok`;
    else if (kind === 3) line = `line ${n} ` + 'x'.repeat(n % 40);
    else if (kind === 6) line = `\x1b[1;31mERR\x1b[0m ${n}: something happened here`;
    else line = `${n}`;
    base.push(line + '\n');
    bytes += line.length + 1;
    n++;
  }
  const buf = Buffer.from(base.join(''), 'utf8');
  const fd = fs.openSync(payload, 'w');
  for (let i = 0; i < SIZE_MB; i++) fs.writeSync(fd, buf);
  fs.closeSync(fd);
}

const resultFile = path.join(os.tmpdir(), `gxb-stock-${Date.now()}.json`);
const runner = path.join(os.tmpdir(), 'gxb-stock-runner.zsh');
fs.writeFileSync(runner, `#!/bin/zsh -f
zmodload zsh/datetime
sleep 0.5                     # let the window finish opening
t0=$EPOCHREALTIME
cat ${JSON.stringify(payload)}
t1=$EPOCHREALTIME
print -r -- "{\\"catSeconds\\": $((t1 - t0))}" > ${JSON.stringify(resultFile)}
sleep 0.5
`, { mode: 0o755 });

console.log(`launching stock Ghostty for a ${SIZE_MB} MiB cat...`);
execFileSync('open', ['-na', APP, '--args', '-e', runner]);

// Sample the Ghostty process while the run is in flight.
let peakRssMB = 0;
let cpuSamples = [];
const sampler = setInterval(() => {
  try {
    const out = execSync(
      "ps -axo rss=,pcpu=,comm= | grep -i '[G]hostty.app/Contents/MacOS' || true",
      { encoding: 'utf8' }).trim();
    for (const line of out.split('\n').filter(Boolean)) {
      const [rss, pcpu] = line.trim().split(/\s+/);
      peakRssMB = Math.max(peakRssMB, parseInt(rss, 10) / 1024);
      cpuSamples.push(parseFloat(pcpu));
    }
  } catch { /* process listing race */ }
}, 250);

const deadline = Date.now() + 15 * 60 * 1000;
(function poll() {
  if (fs.existsSync(resultFile)) {
    clearInterval(sampler);
    const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    const avgCpu = cpuSamples.length
      ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length : 0;
    const out = {
      terminal: 'stock Ghostty.app (native, no Electron)',
      sizeMB: SIZE_MB,
      catExitMs: Math.round(r.catSeconds * 1000),
      MBps: +(SIZE_MB / r.catSeconds).toFixed(1),
      avgCpuPercent: +avgCpu.toFixed(1),
      peakRssMB: Math.round(peakRssMB),
      finishLine: 'write-side (cat exit); screens of stock apps are unreadable',
      platform: process.platform,
      arch: process.arch
    };
    console.log(JSON.stringify(out, null, 2));
    const resultsDir = path.join(__dirname, '..', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, 'stock-ghostty.json'), JSON.stringify(out, null, 2));
    console.log('\nCompare with catExitMs in results/pty-bench.json (same --mb, same finish line).');
    fs.unlinkSync(resultFile);
    return;
  }
  if (Date.now() > deadline) {
    clearInterval(sampler);
    console.error('timed out waiting for stock Ghostty result');
    process.exit(1);
  }
  setTimeout(poll, 250);
})();
