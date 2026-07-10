'use strict';
/**
 * Electron-side driver for test/utility-engine.test.js: exercises the
 * utilityProcess engine's own behaviors — the ones that have already
 * regressed once during development and were previously verified only
 * with throwaway probes:
 *
 *   1. frame flow: >1 distinct frame arrives (the frame→ack loop
 *      doesn't wedge; regression: missing pumpMainQueue froze frames
 *      after the first draw)
 *   2. input through the message protocol: text roundtrips to pixels;
 *      key events go through ghostty's encoder; mouse messages are
 *      accepted (no error events)
 *   3. resize across the process boundary converges to the new size
 *      with zero present errors (swap-chain rebuild invalidates
 *      surface IDs — failed lookups must not wedge the ack loop)
 *   4. engine crash: pending sizeAsync/readPixelsAsync resolve null
 *      instead of hanging (regression: reply map wasn't flushed), and
 *      the terminal emits 'exit'
 *   5. second engine after destroying the first works (no cross-host
 *      state bleed)
 *
 * Runs each scenario, writes results/utility-engine-tests.json, exits
 * 0 iff all passed. No BrowserWindow: frames are verified through the
 * host's readPixels (the renderer presentation path is covered by the
 * demo smoke).
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { GhosttyTerminal } = require('electron-ghostty');

const results = {};
let failures = 0;

async function scenario(name, fn) {
  try {
    await fn();
    results[name] = { ok: true };
  } catch (err) {
    failures++;
    results[name] = { ok: false, error: err.message };
  }
}

function until(fn, timeoutMs = 15000, stepMs = 50) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (async function poll() {
      try {
        const v = await fn();
        if (v) return resolve(v);
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout: ${fn}`));
      setTimeout(poll, stepMs);
    })();
  });
}

function foregroundPixels(px) {
  const bg = px.data.readUInt32LE(0);
  let n = 0;
  for (let i = 0; i < px.data.length; i += 4)
    if (px.data.readUInt32LE(i) !== bg) n++;
  return n;
}

app.whenReady().then(async () => {
  await scenario('frames flow and dedup advances', async () => {
    const term = new GhosttyTerminal({
      scale: 2, command: `/bin/sh -c 'while :; do date; sleep 0.05; done'`,
    });
    try {
      // Count distinct frame messages at the engine level.
      let frames = 0;
      const engine = term._engine;
      const orig = engine._onMessage.bind(engine);
      engine._onMessage = (msg) => {
        if (msg.type === 'frame') {
          frames++;
          // No renderer attached: ack manually so the loop keeps flowing
          // (attach() normally makes _presentFrame do the acking side).
          engine._child.postMessage({ type: 'frame-ack' });
          return;
        }
        orig(msg);
      };
      await until(() => frames >= 3);
    } finally {
      term.destroy();
    }
  });

  await scenario('text input roundtrips to pixels through the protocol', async () => {
    const term = new GhosttyTerminal({ scale: 2, command: 'cat' });
    try {
      await until(async () => (await term.readPixelsAsync()) !== null);
      const before = foregroundPixels(await term.readPixelsAsync());
      term.text('UTILITY_ENGINE_ROUNDTRIP\r');
      await until(async () => {
        const px = await term.readPixelsAsync();
        return px && foregroundPixels(px) > before + 100;
      });
    } finally {
      term.destroy();
    }
  });

  await scenario('key events go through ghostty encoder', async () => {
    const term = new GhosttyTerminal({ scale: 2, command: 'cat' });
    try {
      await until(async () => (await term.readPixelsAsync()) !== null);
      const before = foregroundPixels(await term.readPixelsAsync());
      // "hi" + Enter via macOS keycodes (4='h', 34='i', 36=Enter).
      term.key({ action: 1, keycode: 4, mods: 0, text: 'h', unshiftedCodepoint: 104 });
      term.key({ action: 0, keycode: 4, mods: 0 });
      term.key({ action: 1, keycode: 34, mods: 0, text: 'i', unshiftedCodepoint: 105 });
      term.key({ action: 0, keycode: 34, mods: 0 });
      term.key({ action: 1, keycode: 36, mods: 0 });
      term.key({ action: 0, keycode: 36, mods: 0 });
      await until(async () => {
        const px = await term.readPixelsAsync();
        return px && foregroundPixels(px) > before + 50;
      });
    } finally {
      term.destroy();
    }
  });

  await scenario('mouse messages accepted without protocol errors', async () => {
    const term = new GhosttyTerminal({ scale: 2, command: 'sleep 30' });
    const errors = [];
    term.on('present-error', (e) => errors.push(e.message));
    try {
      await until(async () => (await term.readPixelsAsync()) !== null);
      term.mouseButton(1, 1, 0);
      term.mousePos(100, 100, 0);
      term.mouseButton(0, 1, 0);
      term.mouseScroll(100, 100, 0, 5);
      term.mouseScroll(100, 100, 0, -5);
      await term.sizeAsync(); // sync point: all prior messages processed
      if (errors.length) throw new Error(`protocol errors: ${errors.join('; ')}`);
    } finally {
      term.destroy();
    }
  });

  await scenario('resize storm converges across the boundary', async () => {
    const term = new GhosttyTerminal({
      scale: 2, command: `/bin/sh -c 'while :; do date; sleep 0.1; done'`,
    });
    const errors = [];
    term.on('present-error', (e) => errors.push(e.message));
    try {
      for (const [w, h] of [[800, 480], [1200, 700], [640, 400], [1000, 600]]) {
        term.resize(w, h);
        await until(async () => {
          const px = await term.readPixelsAsync();
          return px && px.width === w && px.height === h;
        });
      }
      if (errors.length) throw new Error(`present errors: ${errors.join('; ')}`);
    } finally {
      term.destroy();
    }
  });

  await scenario('engine crash resolves pending requests and emits exit', async () => {
    const term = new GhosttyTerminal({ scale: 2, command: 'sleep 60' });
    await term.sizeAsync(); // engine is up
    const exited = new Promise((resolve) => term.once('exit', resolve));
    const pending = term.readPixelsAsync(); // in flight...
    term._engine._child.kill();             // ...engine dies
    const result = await Promise.race([
      pending.then((v) => ({ settled: true, value: v })),
      new Promise((r) => setTimeout(() => r({ settled: false }), 5000)),
    ]);
    if (!result.settled) throw new Error('pending request hung after engine death');
    if (result.value !== null) throw new Error('crashed-engine request should resolve null');
    await Promise.race([
      exited,
      new Promise((_, rej) => setTimeout(() => rej(new Error("no 'exit' after kill")), 5000)),
    ]);
    // post-exit requests short-circuit
    const after = await term.sizeAsync();
    if (after !== null) throw new Error('post-exit request should resolve null');
    term.destroy();
  });

  await scenario('fresh engine after destroy works (no cross-host bleed)', async () => {
    const term = new GhosttyTerminal({ scale: 2, command: 'cat' });
    try {
      await until(async () => (await term.readPixelsAsync()) !== null);
      const size = await term.sizeAsync();
      if (!size || size.cols <= 0) throw new Error('second engine has no grid');
    } finally {
      term.destroy();
    }
  });

  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'results', 'utility-engine-tests.json'),
    JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  app.exit(failures ? 1 : 0);
});

setTimeout(() => {
  console.error('utility-engine tests: global timeout');
  process.exit(2);
}, 180_000);
