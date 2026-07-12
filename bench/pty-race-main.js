'use strict';
/**
 * The PTY race, one (backend, mode) per Electron run: a real zsh on a
 * real PTY, raced end-to-end. Rebuilt against the current architecture
 * (issue #10) with the flow-control watermarks as FLAGS, so the
 * interrupt headline can be swept instead of asserted.
 *
 * Modes:
 *   throughput (default) — `cat` payload --mb times; clock stops when
 *     the completion sentinel is detected on the terminal (see below),
 *     never when cat exits.
 *   --interrupt — mid-flood Ctrl+C then a PONG echo; measures
 *     Ctrl+C → PONG visible. "How fast do you get control back."
 *
 * Backends:
 *   DOM (xterm, ghostty-web): node-pty in the main process, bytes to
 *     the renderer over IPC with VS Code-style flow control — pause
 *     the PTY above --fc-high unacked bytes, resume below --fc-low,
 *     renderer acks every --fc-ack parsed bytes, 4 ms batching.
 *     Defaults are VS Code's REAL constants (100000/5000/5000 chars),
 *     not the old 32 MiB window — override to sweep.
 *     Sentinel detection: renderer scans the terminal buffer tail.
 *   ghostty (native): ghostty owns the PTY — no external flow control
 *     exists or is needed (backpressure is inherent). Sentinel
 *     detection: the sentinel command sets the window title (OSC 0)
 *     and prints visible marker text; the clock stops at the first
 *     PRESENTED frame after the title event — parsed-and-presented,
 *     the closest honest equivalent to the DOM buffer scan.
 *     Methodological differences are stated in the results.
 *
 * Usage:
 *   electron bench/pty-race-main.js --backend xterm|ghostty-web|ghostty
 *     [--mb N] [--interrupt] [--interrupt-ms N]
 *     [--fc-high N] [--fc-low N] [--fc-ack N]   (bytes; DOM only)
 * Results: results/pty-race-<backend>.json
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { byKey } = require('./backends');

const ROOT = path.join(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'payload.txt');

const argv = process.argv;
const flagNum = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 ? parseInt(argv[i + 1], 10) : fallback;
};
const backendIdx = argv.indexOf('--backend');
const backend = byKey(backendIdx !== -1 ? argv[backendIdx + 1] : 'xterm');
const MB = flagNum('--mb', 10);
const INTERRUPT = argv.includes('--interrupt');
const INTERRUPT_MS = flagNum('--interrupt-ms', 2000);
// VS Code's actual FlowControlConstants (chars ≈ bytes for this payload).
const FC_HIGH = flagNum('--fc-high', 100_000);
const FC_LOW = flagNum('--fc-low', 5_000);
const FC_ACK = flagNum('--fc-ack', 5_000);

const COLS = 120, ROWS = 30, FONT_SIZE = 13;
const now = () => performance.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!fs.existsSync(PAYLOAD)) {
  console.error('payload.txt not found — run `npm run payload` first');
  process.exit(1);
}

setTimeout(() => {
  console.error('watchdog: pty race did not complete within 300s');
  app.exit(1);
}, 300_000);

function writeResult(result) {
  const out = {
    backend: backend.key,
    mode: INTERRUPT ? 'interrupt' : 'throughput',
    mb: MB,
    flowControl: backend.kind === 'dom'
      ? { high: FC_HIGH, low: FC_LOW, ack: FC_ACK, batchMs: 4 }
      : null, // ghostty owns its PTY; backpressure is inherent
    ...result,
    electronVersion: process.versions.electron,
    platform: process.platform,
  };
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'results', `pty-race-${backend.key}.json`),
    JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
}

/* ── DOM backends: node-pty + flow control + renderer buffer scan ── */
async function runDom() {
  const pty = require('node-pty');
  const win = new BrowserWindow({
    width: 1000, height: 700, show: true,
    title: `${backend.key} pty race`,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  const shell = pty.spawn('/bin/zsh', ['-f'], {
    name: 'xterm-256color', cols: COLS, rows: ROWS,
    cwd: process.env.HOME, env: process.env,
  });

  // VS Code-style flow control, all knobs from flags.
  let sentBytes = 0, ackedBytes = 0, paused = false;
  let batch = [];
  shell.onData((d) => {
    sentBytes += d.length;
    batch.push(d);
    if (!paused && sentBytes - ackedBytes > FC_HIGH) {
      paused = true;
      shell.pause();
    }
  });
  const flushTimer = setInterval(() => {
    if (batch.length && !win.isDestroyed()) {
      win.webContents.send('x-data', batch.join(''));
      batch = [];
    }
  }, 4);
  ipcMain.on('x-acked', (e, n) => {
    ackedBytes = n;
    if (paused && sentBytes - ackedBytes < FC_LOW) {
      paused = false;
      shell.resume();
    }
  });

  const visible = (marker) => new Promise((resolve) => {
    const handler = (e, m) => {
      if (m !== marker) return;
      ipcMain.removeListener('x-found', handler);
      resolve(now());
    };
    ipcMain.on('x-found', handler);
    win.webContents.send('x-watch', { marker });
  });

  const termUp = new Promise((resolve, reject) => {
    ipcMain.on('x-term-up', resolve);
    ipcMain.on('x-term-error', (e, m) => reject(new Error(m)));
  });
  ipcMain.on('x-ready', () => {
    win.webContents.send('x-config', {
      cols: COLS, rows: ROWS, fontSize: FONT_SIZE, backend, ackEvery: FC_ACK,
    });
  });
  await win.loadFile(path.join(__dirname, 'pty-race-dom.html'));
  await termUp;

  // READY handshake: the clock starts only once the shell echoes.
  // Sentinel built by arithmetic so the echoed command line can't
  // false-match the scan.
  const ready = visible('R3ADY7q');
  shell.write(`echo R3ADY$((3+4))q\r`);
  await ready;
  await sleep(200);

  const catLoop =
    `for i in $(seq ${MB}); do cat ${JSON.stringify(PAYLOAD)}; done`;

  if (INTERRUPT) {
    shell.write(`${catLoop}\r`);
    await sleep(INTERRUPT_MS);
    const found = visible('P0NG7q');
    const tIntr = now();
    shell.write('\x03');
    shell.write(`echo P0NG$((3+4))q\r`);
    await found;
    writeResult({ interruptMs: +(now() - tIntr).toFixed(1) });
  } else {
    const found = visible('D0NE7q');
    const t0 = now();
    // Sentinel as arithmetic so the echoed command line can't match.
    shell.write(`${catLoop}; echo D0NE$((3+4))q\r`);
    await found;
    writeResult({
      catMs: +(now() - t0).toFixed(1),
      mbPerSec: +((MB * fs.statSync(PAYLOAD).size / 1048576) /
                  ((now() - t0) / 1000)).toFixed(1),
    });
  }
  clearInterval(flushTimer);
  try { shell.kill(); } catch {}
  app.exit(0);
}

/* ── native backend: ghostty owns the PTY; title+frame sentinel ──── */
async function runNative() {
  const { GhosttyTerminal } = require('electron-ghostty');
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const term = new GhosttyTerminal({ scale, fontSize: FONT_SIZE, command: '/bin/zsh -f' });
  const win = new BrowserWindow({
    width: 1000, height: 700, show: true,
    title: 'ghostty pty race',
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
      preload: require.resolve('electron-ghostty/preload'),
    },
  });

  let lastTitle = null;
  let frameAfterTitle = null;
  term.on('title', (t) => {
    lastTitle = t;
    frameAfterTitle = new Promise((resolve) =>
      term.once('frame', () => resolve(now())));
  });

  // Sentinel = OSC 0 title + first frame presented after it.
  const visible = (marker) => new Promise((resolve) => {
    const check = setInterval(async () => {
      if (lastTitle === marker && frameAfterTitle) {
        clearInterval(check);
        resolve(await frameAfterTitle);
      }
    }, 10);
  });

  const type = (text) => {
    term.text(text);
    term.key({ action: 1, keycode: 36, mods: 0 });
    term.key({ action: 0, keycode: 36, mods: 0 });
  };
  // The OSC title is the native-side parse signal; the visible marker
  // guarantees a new dirty frame after the title event. Without visible
  // output, a title-only sentinel can hang forever waiting for "the
  // frame after the title" because OSC 0 does not dirty the surface.
  const markerCmd = (marker) => `printf '\\033]0;${marker}\\007${marker}\\n'`;

  const ready = new Promise((resolve) => term.once('ready', resolve));
  term.attach(win.webContents);
  win.loadFile(path.join(__dirname, 'engine-placement.html'));
  await ready;
  await sleep(1500); // prompt settles

  const catLoop =
    `for i in $(seq ${MB}); do cat ${JSON.stringify(PAYLOAD)}; done`;

  if (INTERRUPT) {
    type(catLoop);
    await sleep(INTERRUPT_MS);
    const found = visible('P0NGq');
    const tIntr = now();
    // Ctrl+C through ghostty's key encoder (keycode 8 = 'c', mods 2 =
    // ctrl) — the same renderer->encoder path a real keystroke takes.
    term.key({ action: 1, keycode: 8, mods: 2, unshiftedCodepoint: 99 });
    term.key({ action: 0, keycode: 8, mods: 2 });
    type(markerCmd('P0NGq'));
    await found;
    writeResult({ interruptMs: +(now() - tIntr).toFixed(1) });
  } else {
    const found = visible('D0NEq');
    const t0 = now();
    type(`${catLoop} && ${markerCmd('D0NEq')}`);
    await found;
    writeResult({
      catMs: +(now() - t0).toFixed(1),
      mbPerSec: +((MB * fs.statSync(PAYLOAD).size / 1048576) /
                  ((now() - t0) / 1000)).toFixed(1),
    });
  }
  term.destroy();
  app.exit(0);
}

app.whenReady().then(() => backend.kind === 'native' ? runNative() : runDom())
  .catch((err) => { console.error(err); app.exit(1); });

app.on('window-all-closed', () => app.quit());
