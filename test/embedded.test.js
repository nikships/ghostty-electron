'use strict';
/**
 * E2E tests for the approach-A embedding addon: ghostty embedded
 * headlessly (ghostty owns PTY + shell, parsing, input encoding,
 * fonts, Metal rendering, IOSurface presentation).
 *
 * These run without Electron: frames are verified by reading the
 * presented IOSurface's pixels directly. macOS only (skipped elsewhere).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ADDON_PATH = path.join(
  __dirname, '..', 'native', 'ghostty-renderer', 'build', 'Release',
  'ghostty_renderer.node');

const available = process.platform === 'darwin' && fs.existsSync(ADDON_PATH);
const addon = available ? require(ADDON_PATH) : null;
if (available) addon.init();

const sessions = [];
function create(overrides = {}) {
  const s = addon.create({
    widthPx: 800, heightPx: 480,
    scale: 2, fontSize: 12,
    ...overrides,
  });
  sessions.push(s);
  return s;
}

// Tear down surfaces synchronously so shells spawned by ghostty can't
// keep the test runner's event loop alive.
process.on('exit', () => {
  for (const s of sessions) {
    try { addon.destroy(s); } catch {}
  }
});

/** Count pixels differing from the top-left (background) pixel. */
function foregroundPixels(px) {
  const bg = px.data.readUInt32LE(0);
  let n = 0;
  for (let i = 0; i < px.data.length; i += 4)
    if (px.data.readUInt32LE(i) !== bg) n++;
  return n;
}

/** Tick ghostty + poll until fn() is truthy or timeout. */
async function until(s, fn, timeoutMs = 8000, stepMs = 25) {
  const t0 = Date.now();
  for (;;) {
    addon.tick(s);
    addon.draw(s);
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout');
    await new Promise(r => setTimeout(r, stepMs));
  }
}

function renderedPixels(s, min) {
  return () => {
    const px = addon.readPixels(s);
    return px && foregroundPixels(px) > min ? px : null;
  };
}

test('spawned command renders end-to-end (ghostty-owned PTY)', { skip: !available }, async () => {
  const s = create({ command: `/bin/sh -c 'printf "E2E_A_MARKER\\n"; sleep 30'` });
  const px = await until(s, renderedPixels(s, 200));
  assert.strictEqual(px.width, 800);
  assert.strictEqual(px.height, 480);
});

test('grid is derived from pixel size and cell metrics', { skip: !available }, async () => {
  const s = create({ command: 'sleep 30' });
  await until(s, renderedPixels(s, 0)); // any presented frame
  const size = addon.size(s);
  assert.ok(size.cellWidth > 0 && size.cellHeight > 0, 'cell metrics');
  // Ghostty subtracts its window padding before dividing, so allow
  // a cell of slack rather than assuming zero padding.
  const expCols = Math.floor(800 / size.cellWidth);
  const expRows = Math.floor(480 / size.cellHeight);
  assert.ok(size.cols >= expCols - 2 && size.cols <= expCols, `cols ${size.cols} ~ ${expCols}`);
  assert.ok(size.rows >= expRows - 2 && size.rows <= expRows, `rows ${size.rows} ~ ${expRows}`);
});

test('text input roundtrips through ghostty PTY and renders', { skip: !available }, async () => {
  const s = create({ command: 'cat' });
  await until(s, renderedPixels(s, 0));
  const before = foregroundPixels(addon.readPixels(s));
  addon.text(s, 'INPUT_ROUNDTRIP_VIA_GHOSTTY\r');
  const px = await until(s, () => {
    const p = addon.readPixels(s);
    return p && foregroundPixels(p) > before + 100 ? p : null;
  });
  assert.ok(px, 'echoed input rendered');
});

test('key events go through ghostty key encoding', { skip: !available }, async () => {
  const s = create({ command: 'cat' });
  await until(s, renderedPixels(s, 0));
  const before = foregroundPixels(addon.readPixels(s));
  // Type "hi" + Enter using key events (keycode 4 = macOS 'h', 34 = 'i').
  addon.key(s, { action: 1, keycode: 4, mods: 0, text: 'h', unshiftedCodepoint: 104 });
  addon.key(s, { action: 0, keycode: 4, mods: 0 });
  addon.key(s, { action: 1, keycode: 34, mods: 0, text: 'i', unshiftedCodepoint: 105 });
  addon.key(s, { action: 0, keycode: 34, mods: 0 });
  addon.key(s, { action: 1, keycode: 36, mods: 0 }); // Enter
  addon.key(s, { action: 0, keycode: 36, mods: 0 });
  const px = await until(s, () => {
    const p = addon.readPixels(s);
    return p && foregroundPixels(p) > before + 50 ? p : null;
  });
  assert.ok(px, 'typed keys rendered via ghostty encoder');
});

test('process exit is observable', { skip: !available }, async () => {
  const s = create({ command: 'true' });
  await until(s, () => {
    addon.tick(s);
    return addon.processExited(s);
  });
});

test('resize reflows and grows the presented frame', { skip: !available }, async () => {
  const s = create({ command: 'sleep 30' });
  await until(s, renderedPixels(s, 0));
  addon.resize(s, 1000, 600);
  const px = await until(s, () => {
    const p = addon.readPixels(s);
    return p && p.width === 1000 && p.height === 600 ? p : null;
  });
  assert.strictEqual(px.width, 1000);
  const size = addon.size(s);
  assert.strictEqual(size.widthPx, 1000);
  const expCols2 = Math.floor(1000 / size.cellWidth);
  assert.ok(size.cols >= expCols2 - 2 && size.cols <= expCols2, `cols ${size.cols} ~ ${expCols2}`);
});

test('mouse scroll reaches ghostty without error (scrollback path)', { skip: !available }, async () => {
  const s = create({ command: `/bin/sh -c 'i=0; while [ $i -lt 100 ]; do echo line $i; i=$((i+1)); done; sleep 30'` });
  await until(s, renderedPixels(s, 200));
  // Scroll up into scrollback, then back down; assert frames keep coming.
  addon.mouseScroll(s, 100, 100, 0, 5);
  addon.mouseScroll(s, 100, 100, 0, -5);
  const px = await until(s, renderedPixels(s, 200));
  assert.ok(px, 'still rendering after scroll events');
});
