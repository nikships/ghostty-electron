'use strict';
/**
 * Electron integration tests — launch the real apps and verify they work
 * end-to-end. Slower than the node-level tests (each spawns Electron with
 * visible windows); run with `npm run test:integration`.
 *
 *  1. xterm benchmark produces sane results
 *  2. ghostty benchmark produces sane results + a non-trivial screenshot
 *  3. sustained mode works
 *  4. demo --smoke: a real zsh echo round-trips through BOTH terminals
 *     (keyboard → PTY → parser → renderer → grid)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const electron = require('electron');

// The native producer (and zsh for the PTY tests) are macOS-only for now;
// the xterm baseline app runs everywhere Electron does.
const MAC = process.platform === 'darwin' ? {} : { skip: 'requires the macOS producer' };

function runElectron(args, timeout = 120_000) {
  // Capture stdout/stderr so a crash inside Electron isn't a black box in CI.
  // execFileSync attaches them to the thrown error only when they're piped.
  // Only resolve args that reference repo files (entry points contain a
  // slash); flag values like `--backend xterm` must pass through untouched.
  try {
    execFileSync(electron, args.map(a => !path.isAbsolute(a) && a.includes('/') ? path.join(ROOT, a) : a), {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout
    });
  } catch (err) {
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    if (out) err.message += `\n--- Electron output ---\n${out}`;
    throw err;
  }
}

function readResult(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'results', file), 'utf8'));
}

test('payload exists (generate if missing)', () => {
  if (!fs.existsSync(path.join(ROOT, 'payload.txt'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-payload.js')]);
  }
  const size = fs.statSync(path.join(ROOT, 'payload.txt')).size;
  assert.ok(size > 1024 * 1024 - 1024, 'payload is ~1MiB');
});

test('xterm flood benchmark runs and reports sane numbers', () => {
  runElectron(['bench/flood-dom-main.js', '--backend', 'xterm']);
  const r = readResult('xterm.json');
  assert.strictEqual(r.mode, 'burst');
  assert.ok(r.payloadBytes > 1_000_000);
  assert.ok(r.parseMs > 0 && r.parseMs < 10_000, `parseMs sane (${r.parseMs})`);
  assert.ok(r.e2eMs >= r.parseMs, 'e2e includes parse');
  assert.ok(r.frames > 0, 'rendered frames');
  assert.ok(r.scale >= 1, 'reports devicePixelRatio');
});

test('ghostty-web flood benchmark runs and reports sane numbers', () => {
  runElectron(['bench/flood-dom-main.js', '--backend', 'ghostty-web']);
  const r = readResult('ghostty-web.json');
  assert.strictEqual(r.mode, 'burst');
  assert.ok(r.payloadBytes > 1_000_000);
  assert.ok(r.parseMs > 0 && r.parseMs < 10_000, `parseMs sane (${r.parseMs})`);
  assert.ok(r.e2eMs >= r.parseMs, 'e2e includes parse');
  assert.ok(r.frames > 0, 'rendered frames');
});

test('ghostty benchmark runs, reports per-stage stats and a real screenshot', MAC, () => {
  runElectron(['bench/flood-native-main.js', '--screenshot']);
  const r = readResult('ghostty.json');
  assert.strictEqual(r.mode, 'burst');
  assert.ok(r.parseMs > 0 && r.e2eMs >= r.parseMs);
  assert.ok(r.frames >= 1, 'at least one sharedTexture frame presented');
  assert.ok(r.writeMs > 0 && r.renderMs > 0 && r.sendMs > 0, 'per-stage timings present');
  assert.ok(r.presentP50Ms > 0 && r.presentP50Ms < 500, `present latency sane (${r.presentP50Ms})`);
  assert.ok(r.surfacePx.width >= r.cols * 8 * r.scale * 0.9, 'surface is HiDPI-scaled');

  const png = fs.statSync(path.join(ROOT, 'results', 'ghostty-frame.png'));
  assert.ok(png.size > 20_000, `screenshot has content (${png.size} bytes)`);
});

test('sustained mode (5× payload) completes', MAC, () => {
  runElectron(['bench/flood-native-main.js', '--repeat', '5'], 180_000);
  const r = readResult('ghostty.json');
  assert.strictEqual(r.mode, 'sustained');
  assert.strictEqual(r.repeat, 5);
  assert.ok(r.payloadBytes > 5_000_000);
  assert.ok(r.frames >= 2, 'multiple frames during sustained feed');
});

test('pty-bench: sentinel-timed cat race completes with sane metrics', MAC, () => {
  runElectron(['bench/pty-main.js', '--mb', '8', '--interrupt-ms', '500'], 300_000);
  const r = readResult('pty-bench.json');
  assert.ok(Math.abs(r.sizeMB - 8) < 1, 'ran the 8 MiB payload');
  assert.ok(r.pipeCeiling.MBps > 1, 'pipe ceiling measured');
  for (const key of ['ghostty', 'ghosttyWeb', 'xterm']) {
    const t = r[key];
    assert.ok(t.catMs > 0 && t.catMs < 120_000, `${key} cat completed (${t.catMs}ms)`);
    assert.ok(t.MBps > 0.5, `${key} throughput sane`);
    assert.ok(t.interruptMs > 0 && t.interruptMs < 60_000, `${key} interrupt probe completed`);
  }
  assert.ok(r.ghostty.ptyChunks > 100, 'pty chunk stats recorded');
});

test('demo --smoke: zsh echo round-trips through both terminals', MAC, () => {
  runElectron(['demo/main.js', '--smoke'], 60_000);
  const r = readResult('demo-smoke.json');
  assert.strictEqual(r.ghosttyEcho, true, 'PTY output visible in ghostty grid');
  assert.strictEqual(r.xtermEcho, true, 'PTY output visible in xterm buffer');
  assert.ok(fs.statSync(path.join(ROOT, 'results', 'demo-ghostty.png')).size > 10_000);
});

test('demo --mouse-smoke: clicks, drag and wheel reach a mouse-tracking PTY app', MAC, () => {
  // Real input path: synthesized OS-level events into the renderer →
  // preload → IPC → libghostty mouse encoder → PTY → raw-mode cat -v
  // prints the received SGR sequences → visible in the grid.
  runElectron(['demo/main.js', '--mouse-smoke'], 90_000);
  const r = readResult('demo-mouse-smoke.json');
  assert.strictEqual(r.trackingEnabled, true, 'app enabled DECSET 1002/1006');
  assert.strictEqual(r.press, true, 'left press reported at the clicked cell');
  assert.strictEqual(r.drag, true, 'drag motion reported with +32 flag at the target cell');
  assert.strictEqual(r.release, true, 'release reported (SGR lowercase m)');
  assert.strictEqual(r.wheelUp, true, 'wheel up reported as button 64');
  assert.strictEqual(r.wheelDown, true, 'wheel down reported as button 65');
});
