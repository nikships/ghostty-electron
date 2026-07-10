'use strict';
/**
 * Electron integration tests — launch the real apps and verify they work
 * end-to-end. Slower than the node-level tests (each spawns Electron with
 * visible windows); run with `npm run test:integration`.
 *
 *  1. xterm.js flood benchmark produces sane results
 *  2. ghostty-web flood benchmark produces sane results
 *  3. ghostty headless-embedding demo renders its marker on screen
 *     (verified in the raw IOSurface) in --smoke mode
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const electron = require('electron');

// Headless ghostty embedding renders via Metal — macOS only for now;
// the DOM benchmarks run everywhere Electron does.
const MAC = process.platform === 'darwin'
  ? {}
  : { skip: 'requires macOS (Metal headless rendering)' };

function runElectron(args, timeout = 240_000) {
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

test('ghostty headless-embedding demo renders marker (smoke, utility-process engine)', MAC, () => {
  runElectron(['demo-ghostty-renderer/main.js', '--smoke'], 210_000);
  const r = readResult('demo-smoke.json');
  assert.ok(r.ok, 'marker rendered');
  assert.ok(r.foregroundPixels > 200, 'text pixels present in the IOSurface');
  assert.ok(r.framesPresented > 0, 'frames were imported+sent via sharedTexture');
  assert.ok(r.rendererForegroundPixels > 200,
    'the renderer canvas actually painted (frame→ack→sharedTexture→canvas path)');
  assert.ok(r.size.cols > 0 && r.size.rows > 0, 'grid derived from cell metrics');
  assert.ok(fs.existsSync(path.join(ROOT, 'results', 'demo-ghostty.png')), 'screenshot');
});

test('ghostty headless-embedding demo renders marker (smoke, main-process engine)', MAC, () => {
  runElectron(['demo-ghostty-renderer/main.js', '--smoke', '--engine=main'], 210_000);
  const r = readResult('demo-smoke.json');
  assert.ok(r.ok, 'marker rendered');
  assert.ok(r.foregroundPixels > 200, 'text pixels present');
});

test('utility engine protocol behaviors (frames, input, resize, crash)', MAC, () => {
  runElectron(['test/utility-engine.main.js'], 200_000);
  const r = readResult('utility-engine-tests.json');
  for (const [name, res] of Object.entries(r)) {
    assert.ok(res.ok, `${name}: ${res.error ?? 'ok'}`);
  }
  assert.ok(Object.keys(r).length >= 7, 'all scenarios ran');
});
