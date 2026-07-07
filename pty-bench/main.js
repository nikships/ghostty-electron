'use strict';
/**
 * PTY benchmark: the end-to-end terminal race.
 *
 * Primary metric — wall-clock from issuing `cat <bigfile>` in a real shell
 * (node-pty) until the shell's completion sentinel is VISIBLE ON SCREEN
 * (not when cat exits — on a backlogged terminal those differ by a lot).
 *
 * Secondary metrics, each measured in its own run:
 *   - interrupt-to-response: mid-flood, send Ctrl+C followed by
 *     `echo PONG…`; measure until the PONG line is visible on screen.
 *     This is "how fast does the terminal give the user back control".
 *   - CPU seconds per Electron process type and peak memory
 *     (app.getAppMetrics sampled during the run).
 *   - pipe ceiling: draining the same file through node-pty into a no-op
 *     consumer, to show whether the plumbing (not the terminal) limits.
 *
 * Fairness notes:
 *   - Both terminals: same shell (zsh), same PTY plumbing, same grid
 *     (120×30 @ devicePixelRatio), visible focused windows, sequential runs
 *     with a warm file cache.
 *   - The xterm window gets VS Code-style flow control (pause the PTY when
 *     >32 MiB is unparsed, resume under 8 MiB) — without it, a 1 GiB flood
 *     queues gigabytes of strings in the renderer and OOMs. ghostty needs
 *     none: the main process parses synchronously, so backpressure is
 *     inherent.
 *
 * Flags: --mb N (default 1024), --interrupt-ms N (default 4000), --keep-file
 */
const { app, BrowserWindow, ipcMain, screen, sharedTexture } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));

const COLS = 120;
const ROWS = 30;
const FONT_SIZE = 13;
const SHELL = '/bin/zsh';

const flagNum = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : fallback;
};
const SIZE_MB = flagNum('--mb', 1024);
const INTERRUPT_MS = flagNum('--interrupt-ms', 4000);

// Sentinels: built with $((…)) so the *typed command* echoed to the screen
// never matches the exact output line we search for.
const DONE_N = 8842;
const PONG_N = 4242;
const READY_N = 7117;
const DONE = `CAT_DONE_${DONE_N}`;
const PONG = `PONG_${PONG_N}`;
const READY = `SHELL_READY_${READY_N}`;
const doneCmd = (file) => `cat ${file}; echo CAT_DONE_$((${DONE_N}))\r`;
const pongCmd = `echo PONG_$((${PONG_N}))\r`;
const readyCmd = `echo SHELL_READY_$((${READY_N}))\r`;
// -f skips rc files: deterministic sub-100ms startup instead of seconds of
// .zshrc plugins, and the same environment for both terminals.
const SHELL_ARGS = ['-f'];

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── payload ─────────────────────────────────────────────────────────── */

function ensurePayload() {
  const file = path.join(__dirname, '..', `payload-${SIZE_MB}mb.txt`);
  if (fs.existsSync(file) && fs.statSync(file).size >= SIZE_MB * 1024 * 1024) return file;
  console.log(`generating ${SIZE_MB} MiB payload...`);
  // Same newline-dense, SGR-sprinkled content class as the 1 MiB payload.
  const chunks = [];
  let bytes = 0, n = 0;
  while (bytes < 1024 * 1024) {
    const kind = n % 8;
    let line;
    if (kind === 0) line = `\x1b[32m[${n}]\x1b[0m ok`;
    else if (kind === 3) line = `line ${n} ` + 'x'.repeat(n % 40);
    else if (kind === 6) line = `\x1b[1;31mERR\x1b[0m ${n}: something happened here`;
    else line = `${n}`;
    chunks.push(line + '\n');
    bytes += line.length + 1;
    n++;
  }
  const base = Buffer.from(chunks.join(''), 'utf8');
  const fd = fs.openSync(file, 'w');
  for (let i = 0; i < SIZE_MB; i++) fs.writeSync(fd, base);
  fs.closeSync(fd);
  return file;
}

/* ── metrics sampler ─────────────────────────────────────────────────── */

function startMetricsSampler() {
  const cpuSeconds = {};
  let peakMemMB = 0;
  const baseline = app.getAppMetrics() // also resets percentCPUUsage baseline
    .reduce((sum, p) => sum + (p.memory.workingSetSize || 0) / 1024, 0);
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const dt = (t - last) / 1000;
    last = t;
    let mem = 0;
    for (const p of app.getAppMetrics()) {
      cpuSeconds[p.type] = (cpuSeconds[p.type] || 0) + (p.cpu.percentCPUUsage / 100) * dt;
      mem += (p.memory.workingSetSize || 0) / 1024; // KB → MB
    }
    peakMemMB = Math.max(peakMemMB, mem);
  }, 250);
  return {
    stop() {
      clearInterval(timer);
      const total = Object.values(cpuSeconds).reduce((a, b) => a + b, 0);
      const rounded = Object.fromEntries(
        Object.entries(cpuSeconds).map(([k, v]) => [k, +v.toFixed(2)]));
      return {
        cpuSeconds: rounded,
        cpuTotal: +total.toFixed(2),
        // Growth over the app's pre-run footprint, not absolute WSS.
        peakMemMB: Math.round(Math.max(0, peakMemMB - baseline))
      };
    }
  };
}

/* ── pipe ceiling control ────────────────────────────────────────────── */

function pipeCeiling(file) {
  return new Promise((resolve) => {
    const t0 = now();
    let bytes = 0;
    const p = pty.spawn('/bin/cat', [file], { name: 'xterm-256color', cols: COLS, rows: ROWS });
    p.onData((d) => { bytes += d.length; });
    p.onExit(() => {
      const ms = now() - t0;
      resolve({ ms: +ms.toFixed(0), MBps: +(bytes / (1024 * 1024) / (ms / 1000)).toFixed(1) });
    });
  });
}

/* ── ghostty runner ──────────────────────────────────────────────────── */

async function ghosttyRun(file, { interrupt }) {
  for (const ch of ['renderer-ready', 'frame-presented']) ipcMain.removeAllListeners(ch);

  const scale = screen.getPrimaryDisplay().scaleFactor;
  const term = addon.create(COLS, ROWS, FONT_SIZE, scale);
  const cssW = Math.ceil(term.width / scale);
  const cssH = Math.ceil(term.height / scale);

  const win = new BrowserWindow({
    width: cssW + 20,
    height: cssH + 60,
    title: `ghostty pty-bench${interrupt ? ' (interrupt probe)' : ''}`,
    webPreferences: {
      sandbox: true,
      // Never let Chromium throttle rAF/timers when occluded: frame acks
      // (and thus presentation) must keep running unattended.
      backgroundThrottling: false,
      preload: path.join(__dirname, '..', 'demo', 'preload-ghostty.js')
    }
  });

  const shell = pty.spawn(SHELL, SHELL_ARGS, {
    name: 'xterm-256color', cols: COLS, rows: ROWS,
    cwd: process.env.HOME, env: process.env
  });
  let chunks = 0, chunkBytes = 0;
  shell.onData((d) => {
    chunks++;
    chunkBytes += d.length;
    try { addon.write(term.session, Buffer.from(d, 'utf8')); } catch {}
  });
  const gDebugTimer = process.env.PTYBENCH_DEBUG
    ? setInterval(() => console.log(`  [ghostty] rx=${(chunkBytes / 1048576).toFixed(1)}MB chunks=${chunks} seq=${seq} acked=${maxAcked}`), 2000)
    : null;

  // Present loop (same shape as the demo: dirty-gated + ack-gated reuse).
  let seq = 0, maxAcked = 0, lastIdx = 0, sendBusy = false;
  const surfaceSeq = [0, 0];
  ipcMain.on('frame-presented', (e, ack) => { maxAcked = Math.max(maxAcked, ack.seq); });
  async function tick() {
    if (sendBusy || win.isDestroyed()) return;
    if (surfaceSeq[1 - lastIdx] > maxAcked) return;
    let frame;
    try { frame = addon.render(term.session); } catch { return; }
    if (!frame) return;
    lastIdx = frame.surfaceIndex;
    sendBusy = true;
    seq++;
    surfaceSeq[lastIdx] = seq;
    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: {
          codedSize: { width: frame.width, height: frame.height },
          pixelFormat: 'bgra',
          handle: { ioSurface: frame.handle }
        }
      });
      await sharedTexture.sendSharedTexture(
        { frame: win.webContents.mainFrame, importedSharedTexture: imported }, { seq });
      imported.release();
    } catch {} finally { sendBusy = false; }
  }
  const timer = setInterval(tick, 8);

  const ready = new Promise((r) => ipcMain.on('renderer-ready', r));
  await win.loadFile(path.join(__dirname, '..', 'demo', 'consumer.html'));
  await ready;
  win.webContents.send('init', {
    cssWidth: cssW, cssHeight: cssH,
    cellWidth: term.cellWidth / scale, cellHeight: term.cellHeight / scale
  });

  /** Wait until `marker` ends a grid line AND that frame was presented.
   *  endsWith (not equality): a file without a trailing newline puts the
   *  sentinel on the tail of the last content line. The typed command never
   *  matches — it ends in the unexpanded `$((…))`. */
  async function visible(marker, pollMs) {
    for (;;) {
      const lines = addon.getText(term.session);
      if (lines.some((l) => l.trim().endsWith(marker))) break;
      await sleep(pollMs);
    }
    // The sentinel is in the grid; wait (bounded) until the present loop has
    // gone idle — no new frames for ~3 ticks and every sent frame acked — so
    // the clock stops at "visible", not "parsed".
    const t = now();
    let stableSeq = seq, stableAt = now();
    while (now() - t < 1000) {
      if (seq !== stableSeq) { stableSeq = seq; stableAt = now(); }
      if (surfaceSeq[0] <= maxAcked && surfaceSeq[1] <= maxAcked &&
          now() - stableAt > 25) break;
      await sleep(5);
    }
    return now();
  }

  // Handshake: don't start the clock until the shell proves it's reading
  // input (rc-file startup otherwise buffers our command for seconds).
  shell.write(readyCmd);
  await visible(READY, 50);
  await sleep(200);

  const sampler = startMetricsSampler();
  const result = {};
  const t0 = now();
  shell.write(doneCmd(file));

  if (interrupt) {
    await sleep(INTERRUPT_MS);
    const tIntr = now();
    const ctrlC = addon.encodeKey(term.session, { code: 'KeyC', ctrl: true, utf8: 'c' });
    shell.write(ctrlC.toString('binary'));
    shell.write(pongCmd);
    await visible(PONG, 20);
    result.interruptMs = +(now() - tIntr).toFixed(0);
  } else {
    await visible(DONE, 50);
    result.catMs = +(now() - t0).toFixed(0);
    result.ptyChunks = chunks;
    result.avgChunkBytes = Math.round(chunkBytes / Math.max(1, chunks));
  }

  Object.assign(result, sampler.stop());
  clearInterval(timer);
  if (gDebugTimer) clearInterval(gDebugTimer);
  try { shell.kill(); } catch {}
  win.destroy();
  await sleep(500);
  return result;
}

/* ── xterm runner ────────────────────────────────────────────────────── */

async function xtermRun(file, { interrupt }) {
  for (const ch of ['x-ready', 'x-input', 'x-acked', 'x-found']) ipcMain.removeAllListeners(ch);

  const win = new BrowserWindow({
    width: 1100,
    height: 620,
    title: `xterm pty-bench${interrupt ? ' (interrupt probe)' : ''}`,
    // backgroundThrottling: an occluded window otherwise gets its rAF
    // suspended and setTimeout clamped — it silently poisoned an overnight
    // run with ~18 minutes of "waiting for a frame". VS Code disables it too.
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });

  const shell = pty.spawn(SHELL, SHELL_ARGS, {
    name: 'xterm-256color', cols: COLS, rows: ROWS,
    cwd: process.env.HOME, env: process.env
  });

  // VS Code-style flow control + batching: PTY chunks are tiny, and one IPC
  // message per chunk collapses throughput; batch every 4 ms. Pause the PTY
  // when the renderer is >32 MiB behind so a 1 GiB flood can't queue
  // unbounded strings.
  let sentBytes = 0, ackedBytes = 0, paused = false;
  const HIGH = 32 * 1024 * 1024, LOW = 8 * 1024 * 1024;
  let batch = [];
  shell.onData((d) => {
    sentBytes += d.length;
    batch.push(d);
    if (!paused && sentBytes - ackedBytes > HIGH) { paused = true; shell.pause(); }
  });
  const flushTimer = setInterval(() => {
    if (batch.length && !win.isDestroyed()) {
      win.webContents.send('x-data', batch.join(''));
      batch = [];
    }
  }, 4);
  ipcMain.on('x-acked', (e, n) => {
    ackedBytes = n;
    if (paused && sentBytes - ackedBytes < LOW) { paused = false; shell.resume(); }
  });
  ipcMain.on('x-input', (e, d) => shell.write(d));
  if (process.env.PTYBENCH_DEBUG) {
    ipcMain.removeAllListeners('x-debug');
    ipcMain.on('x-debug', (e, d) =>
      console.log(`  [xterm grid] vY=${d.viewportY} baseY=${d.baseY} tail=${JSON.stringify(d.tail)}`));
  }

  const ready = new Promise((r) => ipcMain.on('x-ready', r));
  await win.loadFile(path.join(__dirname, 'xterm.html'));
  await ready;
  win.webContents.send('x-config', { cols: COLS, rows: ROWS, fontSize: FONT_SIZE });

  function visible(marker, pollMs = 50) {
    return new Promise((resolve) => {
      ipcMain.on('x-found', (e, m) => { if (m === marker) resolve(now()); });
      win.webContents.send('x-watch', { marker, pollMs });
    });
  }

  // Handshake: don't start the clock until the shell proves it's reading input.
  const shellUp = visible(READY);
  shell.write(readyCmd);
  await shellUp;
  await sleep(200);

  const debugTimer = process.env.PTYBENCH_DEBUG
    ? setInterval(() => console.log(`  [xterm] sent=${(sentBytes / 1048576).toFixed(1)}MB acked=${(ackedBytes / 1048576).toFixed(1)}MB paused=${paused}`), 2000)
    : null;

  const sampler = startMetricsSampler();
  const result = {};
  const t0 = now();

  if (interrupt) {
    const found = visible(PONG, 20);
    shell.write(doneCmd(file));
    await sleep(INTERRUPT_MS);
    const tIntr = now();
    shell.write('\x03');
    shell.write(pongCmd);
    await found;
    result.interruptMs = +(now() - tIntr).toFixed(0);
  } else {
    const found = visible(DONE, 50);
    shell.write(doneCmd(file));
    await found;
    result.catMs = +(now() - t0).toFixed(0);
  }

  Object.assign(result, sampler.stop());
  if (debugTimer) clearInterval(debugTimer);
  clearInterval(flushTimer);
  try { shell.kill(); } catch {}
  win.destroy();
  await sleep(500);
  return result;
}

/* ── main ────────────────────────────────────────────────────────────── */

app.on('window-all-closed', () => { /* keep alive between runs */ });

app.whenReady().then(async () => {
  try {
    const file = ensurePayload();
    const mb = fs.statSync(file).size / (1024 * 1024);

    console.log(`\npipe ceiling (node-pty → no-op consumer)...`);
    const pipe = await pipeCeiling(file);
    console.log(`  ${pipe.MBps} MB/s (${pipe.ms} ms)`);

    console.log(`\nghostty: cat ${mb} MiB...`);
    const g = await ghosttyRun(file, { interrupt: false });
    console.log(`  ${g.catMs} ms`);
    console.log(`ghostty: interrupt probe (Ctrl+C at ${INTERRUPT_MS} ms)...`);
    const gi = await ghosttyRun(file, { interrupt: true });
    console.log(`  ${gi.interruptMs} ms to PONG`);

    console.log(`\nxterm: cat ${mb} MiB...`);
    const x = await xtermRun(file, { interrupt: false });
    console.log(`  ${x.catMs} ms`);
    console.log(`xterm: interrupt probe (Ctrl+C at ${INTERRUPT_MS} ms)...`);
    const xi = await xtermRun(file, { interrupt: true });
    console.log(`  ${xi.interruptMs} ms to PONG`);

    const MBps = (r) => +(mb / (r.catMs / 1000)).toFixed(1);
    const summary = {
      sizeMB: mb,
      interruptAtMs: INTERRUPT_MS,
      pipeCeiling: pipe,
      ghostty: { ...g, MBps: MBps(g), interruptMs: gi.interruptMs, interruptRun: gi },
      xterm: { ...x, MBps: MBps(x), interruptMs: xi.interruptMs, interruptRun: xi },
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch
    };

    const pad = (s, n) => String(s).padStart(n);
    console.log('\n' + '═'.repeat(86));
    console.log(`  PTY RACE: cat ${mb} MiB in a real zsh — sentinel visible on screen`);
    console.log(`  pipe ceiling: ${pipe.MBps} MB/s — grid ${COLS}×${ROWS} — Electron ${process.versions.electron}`);
    console.log('═'.repeat(86));
    console.log(`  ${'terminal'.padEnd(12)} ${pad('cat ms', 10)} ${pad('MB/s', 8)} ${pad('Ctrl+C→PONG ms', 16)} ${pad('cpu s', 8)} ${pad('peak mem MB', 12)}`);
    console.log('  ' + '─'.repeat(82));
    console.log(`  ${'xterm'.padEnd(12)} ${pad(x.catMs, 10)} ${pad(summary.xterm.MBps, 8)} ${pad(xi.interruptMs, 16)} ${pad(x.cpuTotal, 8)} ${pad(x.peakMemMB, 12)}`);
    console.log(`  ${'ghostty'.padEnd(12)} ${pad(g.catMs, 10)} ${pad(summary.ghostty.MBps, 8)} ${pad(gi.interruptMs, 16)} ${pad(g.cpuTotal, 8)} ${pad(g.peakMemMB, 12)}`);
    console.log('  ' + '─'.repeat(82));
    console.log(`  cat speedup: ${(x.catMs / g.catMs).toFixed(1)}×   interrupt speedup: ${(xi.interruptMs / gi.interruptMs).toFixed(1)}×`);
    console.log('═'.repeat(86));

    const resultsDir = path.join(__dirname, '..', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, 'pty-bench.json'), JSON.stringify(summary, null, 2));

    if (!process.argv.includes('--keep-file') && SIZE_MB >= 256) fs.unlinkSync(file);
    app.exit(0);
  } catch (err) {
    console.error('pty-bench failed:', err);
    app.exit(1);
  }
});
