'use strict';
/**
 * PTY benchmark: the end-to-end terminal race, across every backend in
 * bench/backends.js.
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
 *   - All terminals: same shell (zsh), same PTY plumbing, same grid
 *     (120×30 @ devicePixelRatio), visible focused windows, sequential runs
 *     with a warm file cache.
 *   - DOM windows get VS Code-style flow control (pause the PTY when
 *     >32 MiB is unparsed, resume under 8 MiB) — without it, a 1 GiB flood
 *     queues gigabytes of strings in the renderer and OOMs. ghostty-web
 *     parses synchronously on write, so its ack (and thus resume) tracks
 *     actual parse progress just like xterm's async callback. The native
 *     backend needs none: the main process parses synchronously, so
 *     backpressure is inherent.
 *
 * Flags: --mb N (default 1024), --interrupt-ms N (default 4000), --keep-file
 *        --latency, --soak-min N, --backends a,b (subset filter)
 */
const { app, BrowserWindow, ipcMain, screen, sharedTexture } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { BACKENDS } = require('./backends');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));

const COLS = 120;
const ROWS = 30;
const FONT_SIZE = 13;
const IS_WIN = process.platform === 'win32';
const SHELL = IS_WIN ? 'powershell.exe' : '/bin/zsh';
const HOME = process.env.HOME || process.env.USERPROFILE;

const flagNum = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : fallback;
};
const SIZE_MB = flagNum('--mb', 1024);
const INTERRUPT_MS = flagNum('--interrupt-ms', 4000);
const SAMPLES = flagNum('--samples', 8);
const LATENCY = process.argv.includes('--latency');
const SOAK_MIN = flagNum('--soak-min', 0);

// Optional subset (e.g. --backends xterm,ghostty); native backend drops out
// automatically where the addon has no platform renderer.
const subsetIdx = process.argv.indexOf('--backends');
const subset = subsetIdx !== -1 ? process.argv[subsetIdx + 1].split(',') : null;
const RUNNABLE = BACKENDS.filter((b) =>
  (!subset || subset.includes(b.key)) &&
  (b.kind !== 'native' || typeof addon.render === 'function'));
if (RUNNABLE.length === 0) {
  console.error('no runnable backends on this platform');
  process.exit(1);
}

// Sentinels: built with $((…)) so the *typed command* echoed to the screen
// never matches the exact output line we search for.
const DONE_N = 8842;
const PONG_N = 4242;
const READY_N = 7117;
const DONE = `CAT_DONE_${DONE_N}`;
const PONG = `PONG_${PONG_N}`;
const READY = `SHELL_READY_${READY_N}`;
// zsh builds the sentinel with $((…)) arithmetic, PowerShell with string
// concatenation — either way the *typed* command line never contains the
// exact sentinel, only its evaluation does.
const doneCmd = (file) => IS_WIN
  ? `cmd /c type "${file}"; echo ("CAT_DONE_" + ${DONE_N})\r`
  : `cat ${file}; echo CAT_DONE_$((${DONE_N}))\r`;
const pongCmd = IS_WIN
  ? `echo ("PONG_" + ${PONG_N})\r`
  : `echo PONG_$((${PONG_N}))\r`;
const readyCmd = IS_WIN
  ? `echo ("SHELL_READY_" + ${READY_N})\r`
  : `echo SHELL_READY_$((${READY_N}))\r`;
// -f / -NoProfile skip rc files: deterministic startup instead of seconds of
// plugins, and the same environment for both terminals.
const SHELL_ARGS = IS_WIN ? ['-NoProfile', '-NoLogo'] : ['-f'];
// Clear the prompt line between latency samples: kill-whole-line on zsh,
// RevertLine (Escape) on PSReadLine.
const KILL_LINE = IS_WIN ? '\x1b' : '\x15';

// Rate-limited load for the latency probe: ~2000 lines/s ("build output"),
// slow enough that an echoed keystroke persists on screen. At unthrottled
// cat rates the screen scrolls millions of lines/s and a typed echo never
// lands on a presented frame in ANY terminal — unmeasurable by definition.
const busyCmd =
  `node -e "const l='x'.repeat(60);let n=0;setInterval(()=>{for(let i=0;i<100;i++)console.log('busy'+(n++)+' '+l)},50)"\r`;

// Watchdog: a stuck finish-line wait (e.g. ConPTY swallowing the interrupt
// echo on a Windows runner — observed hanging a CI job ~20 min until
// cancelled) must fail the run, not hang until the job timeout. Scaled up
// for soak runs, which are long by design.
const WATCHDOG_MIN = flagNum('--watchdog-min', SOAK_MIN > 0 ? SOAK_MIN * 4 + 10 : 30);
setTimeout(() => {
  console.error(`watchdog: pty-bench did not complete within ${WATCHDOG_MIN} min`);
  app.exit(1);
}, WATCHDOG_MIN * 60_000);

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

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

function startMetricsSampler({ series = false } = {}) {
  const cpuSeconds = {};
  let peakMemMB = 0;
  const memSeries = [];
  const t0 = now();
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
    if (series) memSeries.push({ tMin: (t - t0) / 60000, memMB: mem - baseline });
  }, series ? 2000 : 250);
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
        peakMemMB: Math.round(Math.max(0, peakMemMB - baseline)),
        memSeries
      };
    }
  };
}

/** Least-squares slope (MB/min) over the settled part of a memory series:
 *  the first minute AND the first third are warm-up (scrollback pool and
 *  buffers filling to their caps) — a 10-min run measured 0.29 MB/min after
 *  settling vs ~44 MB/min if the ramp is included. */
function memSlope(series) {
  if (!series.length) return 0;
  const cut = Math.max(1, series[series.length - 1].tMin / 3);
  const tail = series.filter((s) => s.tMin >= cut);
  if (tail.length < 4) return 0;
  const n = tail.length;
  const mx = tail.reduce((a, s) => a + s.tMin, 0) / n;
  const my = tail.reduce((a, s) => a + s.memMB, 0) / n;
  let num = 0, den = 0;
  for (const s of tail) { num += (s.tMin - mx) * (s.memMB - my); den += (s.tMin - mx) ** 2; }
  return den ? num / den : 0;
}

/* ── pipe ceiling control ────────────────────────────────────────────── */

function pipeCeiling(file) {
  return new Promise((resolve) => {
    const t0 = now();
    let bytes = 0;
    const p = IS_WIN
      ? pty.spawn('cmd.exe', ['/c', 'type', file], { name: 'xterm-256color', cols: COLS, rows: ROWS })
      : pty.spawn('/bin/cat', [file], { name: 'xterm-256color', cols: COLS, rows: ROWS });
    p.onData((d) => { bytes += d.length; });
    p.onExit(() => {
      const ms = now() - t0;
      resolve({ ms: +ms.toFixed(0), MBps: +(bytes / (1024 * 1024) / (ms / 1000)).toFixed(1) });
    });
  });
}

/* ── native (libghostty + sharedTexture) runner ──────────────────────── */

async function ghosttyRun(file, { interrupt, latency, soak }) {
  for (const ch of ['renderer-ready', 'frame-presented']) ipcMain.removeAllListeners(ch);

  const scale = screen.getPrimaryDisplay().scaleFactor;
  const term = addon.create(COLS, ROWS, FONT_SIZE, scale);
  const cssW = Math.ceil(term.width / scale);
  const cssH = Math.ceil(term.height / scale);

  const win = new BrowserWindow({
    width: cssW + 20,
    height: cssH + 60,
    title: `ghostty pty-bench${interrupt ? ' (interrupt probe)' : latency ? ' (latency probe)' : ''}`,
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
    cwd: HOME, env: process.env
  });
  let chunks = 0, chunkBytes = 0, doneArrivedAt = 0;
  shell.onData((d) => {
    chunks++;
    chunkBytes += d.length;
    if (!doneArrivedAt && d.includes(DONE)) doneArrivedAt = now();
    try {
      const resp = addon.write(term.session, Buffer.from(d, 'utf8'));
      if (resp && resp.length) shell.write(resp.toString('binary'));
    } catch {}
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
          handle: process.platform === 'darwin' ? { ioSurface: frame.handle } : { ntHandle: frame.handle }
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

  const sampler = startMetricsSampler({ series: !!soak });
  const result = {};
  const t0 = now();
  if (!latency && !soak) shell.write(doneCmd(file));

  if (interrupt) {
    await sleep(INTERRUPT_MS);
    const tIntr = now();
    const ctrlC = addon.encodeKey(term.session, { code: 'KeyC', ctrl: true, utf8: 'c' });
    shell.write(ctrlC.toString('binary'));
    shell.write(pongCmd);
    await visible(PONG, 20);
    result.interruptMs = +(now() - tIntr).toFixed(0);
  } else if (soak) {
    // Sustained-output soak: loop the payload for N minutes and watch the
    // memory trend. Scrollback is capped, so steady state must be flat.
    shell.write(`while :; do cat ${file}; done\r`);
    await sleep(SOAK_MIN * 60_000);
    const ctrlC = addon.encodeKey(term.session, { code: 'KeyC', ctrl: true, utf8: 'c' });
    shell.write(ctrlC.toString('binary'));
    await sleep(500);
    result.soakMinutes = SOAK_MIN;
    result.bytesConsumedMB = Math.round(chunkBytes / 1048576);
  } else if (latency) {
    // Keystroke→visible-echo latency, sampled at idle and mid-flood. The
    // echo scrolls out of the viewport within milliseconds under load, so
    // detection scans recent screen history (viewport + tail of scrollback).
    const measure = async (marker) => {
      const t = now();
      shell.write(marker);
      for (;;) {
        const recent = addon.getRecentText(term.session, 300);
        if (recent && recent.includes(marker)) break;
        await sleep(3);
      }
      // Confirm a frame produced *after* detection was presented — the same
      // finish line as the DOM backends' double-rAF report.
      const seqAtDetect = seq;
      const t2 = now();
      while (!(seq > seqAtDetect && maxAcked >= seqAtDetect + 1) &&
             now() - t2 < 300) await sleep(2);
      return now() - t;
    };
    const floodActive = () => {
      const before = chunkBytes;
      return sleep(30).then(() => chunkBytes > before);
    };
    const idle = [];
    for (let i = 0; i < SAMPLES; i++) {
      idle.push(await measure(`zq${i}xj`));
      shell.write(KILL_LINE); // clean the prompt between samples
      await sleep(150);
    }
    shell.write(busyCmd);
    await sleep(1500); // let the load reach steady state
    const flood = [];
    let dropped = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const sample = await measure(`fq${i}xj`);
      const active = await floodActive();
      if (process.env.PTYBENCH_DEBUG)
        console.log(`  [ghostty] flood sample ${i}: ${sample.toFixed(1)}ms active=${active}`);
      // Discard samples where the flood ended mid-measurement (the echo then
      // measures prompt behavior, not under-load behavior).
      if (active) flood.push(sample);
      else { dropped++; break; }
      await sleep(350);
    }
    shell.write('\x03');
    result.droppedFloodSamples = dropped;
    idle.sort((a, b) => a - b);
    flood.sort((a, b) => a - b);
    result.idleP50Ms = +percentile(idle, 0.5).toFixed(1);
    result.idleP95Ms = +percentile(idle, 0.95).toFixed(1);
    result.floodP50Ms = +percentile(flood, 0.5).toFixed(1);
    result.floodP95Ms = +percentile(flood, 0.95).toFixed(1);
    result.samples = SAMPLES;
  } else {
    await visible(DONE, 50);
    result.catMs = +(now() - t0).toFixed(0);
    // Write-side finish line (cat done, sentinel reached the pty reader) —
    // comparable with stock terminals whose screens we can't read.
    result.catExitMs = +(doneArrivedAt - t0).toFixed(0);
    result.ptyChunks = chunks;
    result.avgChunkBytes = Math.round(chunkBytes / Math.max(1, chunks));
  }

  Object.assign(result, sampler.stop());
  if (soak) result.memSlopeMBperMin = +memSlope(result.memSeries).toFixed(2);
  if (!soak) delete result.memSeries;
  clearInterval(timer);
  if (gDebugTimer) clearInterval(gDebugTimer);
  try { shell.kill(); } catch {}
  win.destroy();
  await sleep(500);
  return result;
}

/* ── DOM runner (xterm.js, ghostty-web — anything in-renderer) ───────── */

async function domRun(backend, file, { interrupt, latency, soak }) {
  for (const ch of ['x-ready', 'x-term-up', 'x-term-error', 'x-input', 'x-acked', 'x-found']) ipcMain.removeAllListeners(ch);

  const win = new BrowserWindow({
    width: 1100,
    height: 620,
    title: `${backend.key} pty-bench${interrupt ? ' (interrupt probe)' : latency ? ' (latency probe)' : ''}`,
    // backgroundThrottling: an occluded window otherwise gets its rAF
    // suspended and setTimeout clamped — it silently poisoned an overnight
    // run with ~18 minutes of "waiting for a frame". VS Code disables it too.
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });

  const shell = pty.spawn(SHELL, SHELL_ARGS, {
    name: 'xterm-256color', cols: COLS, rows: ROWS,
    cwd: HOME, env: process.env
  });

  // VS Code-style flow control + batching: PTY chunks are tiny, and one IPC
  // message per chunk collapses throughput; batch every 4 ms. Pause the PTY
  // when the renderer is >32 MiB behind so a 1 GiB flood can't queue
  // unbounded strings.
  let sentBytes = 0, ackedBytes = 0, paused = false, xDoneArrivedAt = 0;
  const HIGH = 32 * 1024 * 1024, LOW = 8 * 1024 * 1024;
  let batch = [];
  shell.onData((d) => {
    sentBytes += d.length;
    if (!xDoneArrivedAt && d.includes(DONE)) xDoneArrivedAt = now();
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
      console.log(`  [${backend.key} grid] base=${d.base} len=${d.length} tail=${JSON.stringify(d.tail)}`));
  }

  const ready = new Promise((r) => ipcMain.on('x-ready', r));
  await win.loadFile(path.join(__dirname, 'pty-dom.html'));
  await ready;
  // Terminal construction is async for WASM backends — wait for the page to
  // confirm the terminal is actually up (or surface its failure).
  const termUp = new Promise((resolve, reject) => {
    ipcMain.on('x-term-up', resolve);
    ipcMain.on('x-term-error', (e, msg) => reject(new Error(`${backend.key} terminal init failed: ${msg}`)));
  });
  win.webContents.send('x-config', { cols: COLS, rows: ROWS, fontSize: FONT_SIZE, backend });
  await termUp;

  function visible(marker, pollMs = 50, depth = 0) {
    return new Promise((resolve) => {
      const handler = (e, m) => {
        if (m !== marker) return;
        ipcMain.removeListener('x-found', handler);
        resolve(now());
      };
      ipcMain.on('x-found', handler);
      win.webContents.send('x-watch', { marker, pollMs, depth });
    });
  }

  // Handshake: don't start the clock until the shell proves it's reading input.
  const shellUp = visible(READY);
  shell.write(readyCmd);
  await shellUp;
  await sleep(200);

  const debugTimer = process.env.PTYBENCH_DEBUG
    ? setInterval(() => console.log(`  [${backend.key}] sent=${(sentBytes / 1048576).toFixed(1)}MB acked=${(ackedBytes / 1048576).toFixed(1)}MB paused=${paused}`), 2000)
    : null;

  const sampler = startMetricsSampler({ series: !!soak });
  const result = {};
  const t0 = now();

  if (soak) {
    shell.write(`while :; do cat ${file}; done\r`);
    await sleep(SOAK_MIN * 60_000);
    shell.write('\x03');
    await sleep(500);
    result.soakMinutes = SOAK_MIN;
    result.bytesConsumedMB = Math.round(sentBytes / 1048576);
  } else if (latency) {
    // Keystroke→visible-echo latency (see the native runner for the model);
    // detection deep-scans the tail of the renderer's buffer. The wait is
    // bounded: an echo that scrolls past the scan depth before a scan tick
    // lands must drop the sample, not hang the suite (a ghostty-web run once
    // sat 30+ minutes on exactly this).
    const measure = async (marker) => {
      const found = visible(marker, 10, 300);
      const t = now();
      shell.write(marker);
      const hit = await Promise.race([found, sleep(10_000).then(() => null)]);
      return hit === null ? null : now() - t;
    };
    // 150 ms window: the busy load ticks every 50 ms, so a 30 ms window
    // false-reports "flood ended" ~40% of the time.
    const floodActive = () => {
      const before = sentBytes;
      return sleep(150).then(() => sentBytes > before);
    };
    const idle = [];
    for (let i = 0; i < SAMPLES; i++) {
      const s = await measure(`zq${i}xj`);
      if (s != null) idle.push(s);
      shell.write(KILL_LINE);
      await sleep(150);
    }
    shell.write(busyCmd);
    await sleep(1500); // let the load reach steady state
    const flood = [];
    let dropped = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const sample = await measure(`fq${i}xj`);
      if (sample != null && await floodActive()) flood.push(sample);
      else { dropped++; break; }
      await sleep(350);
    }
    shell.write('\x03');
    result.droppedFloodSamples = dropped;
    idle.sort((a, b) => a - b);
    flood.sort((a, b) => a - b);
    result.idleP50Ms = +percentile(idle, 0.5).toFixed(1);
    result.idleP95Ms = +percentile(idle, 0.95).toFixed(1);
    result.floodP50Ms = +percentile(flood, 0.5).toFixed(1);
    result.floodP95Ms = +percentile(flood, 0.95).toFixed(1);
    result.samples = SAMPLES;
  } else if (interrupt) {
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
    result.catExitMs = +(xDoneArrivedAt - t0).toFixed(0);
  }

  Object.assign(result, sampler.stop());
  if (soak) result.memSlopeMBperMin = +memSlope(result.memSeries).toFixed(2);
  if (!soak) delete result.memSeries;
  if (debugTimer) clearInterval(debugTimer);
  clearInterval(flushTimer);
  try { shell.kill(); } catch {}
  win.destroy();
  await sleep(500);
  return result;
}

const runnerFor = (backend) => (file, opts) =>
  backend.kind === 'native' ? ghosttyRun(file, opts) : domRun(backend, file, opts);

/* ── main ────────────────────────────────────────────────────────────── */

app.on('window-all-closed', () => { /* keep alive between runs */ });

app.whenReady().then(async () => {
  try {
    const file = ensurePayload();
    const mb = fs.statSync(file).size / (1024 * 1024);
    const resultsDir = path.join(__dirname, '..', 'results');
    const pad = (s, n) => String(s).padStart(n);
    const meta = {
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch
    };

    if (SOAK_MIN > 0) {
      const LIMIT_MB_PER_MIN = 10;
      const perBackend = {};
      for (const backend of RUNNABLE) {
        console.log(`\n${backend.key}: ${SOAK_MIN} min soak...`);
        const r = await runnerFor(backend)(file, { soak: true });
        console.log(`  consumed ${r.bytesConsumedMB} MB · mem slope ${r.memSlopeMBperMin} MB/min · cpu ${r.cpuTotal}s`);
        perBackend[backend.resultKey] = r;
      }
      // Gate only on backends whose leaks are ours to fix (soakGate !== false
      // in the registry); the rest are measured and reported informationally.
      // Growth-only: a leak is a POSITIVE slope. A negative slope is GC
      // reclaiming the flood's buffers after warm-up (a CI run measured
      // xterm at -63.75 MB/min — memory going down is not a leak).
      const pass = RUNNABLE
        .filter((b) => b.soakGate !== false)
        .every((b) => perBackend[b.resultKey].memSlopeMBperMin < LIMIT_MB_PER_MIN);
      const out = { mode: 'soak', minutes: SOAK_MIN, limitMBperMin: LIMIT_MB_PER_MIN, pass, ...perBackend, ...meta };
      const gated = RUNNABLE.filter((b) => b.soakGate !== false).map((b) => b.key).join(', ');
      console.log(`\n  soak ${pass ? 'PASS' : 'FAIL'} (mem slope < ${LIMIT_MB_PER_MIN} MB/min after warm-up; gated: ${gated})`);
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(path.join(resultsDir, 'pty-soak.json'), JSON.stringify(out, null, 2));
      app.exit(pass ? 0 : 1);
      return;
    }

    if (LATENCY) {
      const perBackend = {};
      for (const backend of RUNNABLE) {
        console.log(`\n${backend.key}: latency probe (${SAMPLES} samples idle + mid-flood)...`);
        const r = await runnerFor(backend)(file, { latency: true });
        console.log(`  idle p50 ${r.idleP50Ms} ms · flood p50 ${r.floodP50Ms} ms`);
        perBackend[backend.resultKey] = r;
      }
      const out = { mode: 'latency', sizeMB: mb, samples: SAMPLES, ...perBackend, ...meta };
      console.log('\n' + '═'.repeat(78));
      console.log(`  INPUT LATENCY: keystroke → echo visible on screen (${SAMPLES} samples)`);
      console.log('═'.repeat(78));
      console.log(`  ${'terminal'.padEnd(14)} ${pad('idle p50', 10)} ${pad('idle p95', 10)} ${pad('flood p50', 11)} ${pad('flood p95', 11)}`);
      console.log('  ' + '─'.repeat(74));
      for (const backend of RUNNABLE) {
        const r = perBackend[backend.resultKey];
        console.log(`  ${backend.key.padEnd(14)} ${pad(r.idleP50Ms, 10)} ${pad(r.idleP95Ms, 10)} ${pad(r.floodP50Ms, 11)} ${pad(r.floodP95Ms, 11)}`);
      }
      console.log('═'.repeat(78));

      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(path.join(resultsDir, 'pty-latency.json'), JSON.stringify(out, null, 2));
      if (!process.argv.includes('--keep-file') && SIZE_MB >= 256) fs.unlinkSync(file);
      app.exit(0);
      return;
    }

    console.log(`\npipe ceiling (node-pty → no-op consumer)...`);
    const pipe = await pipeCeiling(file);
    console.log(`  ${pipe.MBps} MB/s (${pipe.ms} ms)`);

    const MBps = (r) => +(mb / (r.catMs / 1000)).toFixed(1);
    const perBackend = {};
    for (const backend of RUNNABLE) {
      console.log(`\n${backend.key}: cat ${mb} MiB...`);
      const run = runnerFor(backend);
      const r = await run(file, { interrupt: false });
      console.log(`  ${r.catMs} ms`);
      console.log(`${backend.key}: interrupt probe (Ctrl+C at ${INTERRUPT_MS} ms)...`);
      const ri = await run(file, { interrupt: true });
      console.log(`  ${ri.interruptMs} ms to PONG`);
      perBackend[backend.resultKey] = { ...r, MBps: MBps(r), interruptMs: ri.interruptMs, interruptRun: ri };
    }

    const summary = { sizeMB: mb, interruptAtMs: INTERRUPT_MS, pipeCeiling: pipe, ...perBackend, ...meta };

    console.log('\n' + '═'.repeat(86));
    console.log(`  PTY RACE: cat ${mb} MiB in a real zsh — sentinel visible on screen`);
    console.log(`  pipe ceiling: ${pipe.MBps} MB/s — grid ${COLS}×${ROWS} — Electron ${process.versions.electron}`);
    console.log('═'.repeat(86));
    console.log(`  ${'terminal'.padEnd(14)} ${pad('cat ms', 10)} ${pad('MB/s', 8)} ${pad('Ctrl+C→PONG ms', 16)} ${pad('cpu s', 8)} ${pad('peak mem MB', 12)}`);
    console.log('  ' + '─'.repeat(82));
    for (const backend of RUNNABLE) {
      const r = perBackend[backend.resultKey];
      console.log(`  ${backend.key.padEnd(14)} ${pad(r.catMs, 10)} ${pad(r.MBps, 8)} ${pad(r.interruptMs, 16)} ${pad(r.cpuTotal, 8)} ${pad(r.peakMemMB, 12)}`);
    }
    console.log('  ' + '─'.repeat(82));
    const base = perBackend[RUNNABLE[0].resultKey];
    for (const backend of RUNNABLE.slice(1)) {
      const r = perBackend[backend.resultKey];
      console.log(`  ${backend.key} vs ${RUNNABLE[0].key} — cat: ${(base.catMs / r.catMs).toFixed(1)}×   interrupt: ${(base.interruptMs / r.interruptMs).toFixed(1)}×`);
    }
    console.log('═'.repeat(86));

    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, 'pty-bench.json'), JSON.stringify(summary, null, 2));

    if (!process.argv.includes('--keep-file') && SIZE_MB >= 256) fs.unlinkSync(file);
    app.exit(0);
  } catch (err) {
    console.error('pty-bench failed:', err);
    app.exit(1);
  }
});
