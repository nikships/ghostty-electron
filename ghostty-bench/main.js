'use strict';
/**
 * libghostty + sharedTexture: cat a payload through libghostty-vt in the
 * main process, render the grid natively into an IOSurface (CoreText,
 * HiDPI-scaled, dirty-row incremental), and present it in a sandboxed
 * renderer <canvas> via Electron's sharedTexture module.
 *
 * Measures per stage: write (parse), render (native draw), send (import +
 * transfer), and per-frame present latency (send → consumer double-rAF ack).
 * e2e = first byte fed → final frame presented.
 *
 * Flags: --repeat N (sustained mode, feeds the payload N times),
 *        --screenshot (dump final frame to results/).
 */
const { app, BrowserWindow, ipcMain, screen, sharedTexture } = require('electron');
const path = require('path');
const fs = require('fs');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));
if (typeof addon.render !== 'function') {
  console.error('No platform renderer in the addon on this OS.');
  process.exit(1);
}

const PAYLOAD = path.join(__dirname, '..', 'payload.txt');
if (!fs.existsSync(PAYLOAD)) {
  console.error('payload.txt not found — run `npm run payload` first');
  process.exit(1);
}

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : fallback;
}

const COLS = 120;
const ROWS = 30;
const FONT_SIZE = 13;
const CHUNK_SIZE = 64 * 1024;
const FRAME_INTERVAL_MS = 16; // present at ~60fps cadence while feeding
const REPEAT = flagValue('--repeat', 1);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// Watchdog: a consumer that never acks (or an import failure swallowed by
// a promise) would otherwise hang the benchmark forever.
setTimeout(() => {
  console.error('watchdog: benchmark did not complete within 180s');
  app.exit(1);
}, 180_000);
process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection:', err);
  app.exit(1);
});

app.whenReady().then(async () => {
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const term = addon.create(COLS, ROWS, FONT_SIZE, scale);

  const win = new BrowserWindow({
    width: Math.ceil(term.width / scale) + 40,
    height: Math.ceil(term.height / scale) + 60,
    show: true,
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  let seq = 0;
  let renderMs = 0;
  let sendMs = 0;
  const pendingSendTimes = new Map();
  const presentLatencies = [];

  async function presentFrame(isFinal) {
    const frame = addon.render(term.session);
    if (!frame) {
      if (isFinal) win.webContents.send('no-frame-final');
      return;
    }
    renderMs += frame.renderMs;
    seq++;
    const t0 = performance.now();
    const imported = sharedTexture.importSharedTexture({
      textureInfo: {
        codedSize: { width: frame.width, height: frame.height },
        pixelFormat: 'bgra',
        handle: process.platform === 'darwin' ? { ioSurface: frame.handle } : { ntHandle: frame.handle }
      }
    });
    pendingSendTimes.set(seq, t0);
    await sharedTexture.sendSharedTexture(
      { frame: win.webContents.mainFrame, importedSharedTexture: imported },
      { seq, isFinal }
    );
    imported.release();
    sendMs += performance.now() - t0;
  }

  let finish = null;
  ipcMain.on('frame-presented', (event, ack) => {
    const sentAt = pendingSendTimes.get(ack.seq);
    if (sentAt !== undefined) {
      presentLatencies.push(performance.now() - sentAt);
      pendingSendTimes.delete(ack.seq);
    }
    if (ack.isFinal && finish) finish();
  });

  // Handlers must be registered before loadFile: the preload signals
  // 'renderer-ready' after first paint, before loadFile() resolves... but
  // register early anyway to avoid ordering races.
  ipcMain.on('renderer-ready', async () => {
    win.webContents.send('init', {
      cssWidth: term.width / scale,
      cssHeight: term.height / scale
    });
    try {
      const data = fs.readFileSync(PAYLOAD);
      const t0 = performance.now();
      let writeMs = 0;
      let lastPresent = 0;

      for (let r = 0; r < REPEAT; r++) {
        for (let off = 0; off < data.length; off += CHUNK_SIZE) {
          const chunk = data.subarray(off, off + CHUNK_SIZE);
          const tw = performance.now();
          addon.write(term.session, chunk);
          writeMs += performance.now() - tw;
          if (performance.now() - lastPresent >= FRAME_INTERVAL_MS) {
            lastPresent = performance.now();
            await presentFrame(false);
          }
        }
      }
      const parseMs = performance.now() - t0;

      const done = new Promise(resolve => { finish = resolve; });
      await presentFrame(true);
      await done;

      const e2eMs = performance.now() - t0;
      presentLatencies.sort((a, b) => a - b);
      const totalBytes = data.length * REPEAT;
      const out = {
        backend: 'libghostty-vt + native IOSurface producer + sharedTexture',
        mode: REPEAT > 1 ? 'sustained' : 'burst',
        repeat: REPEAT,
        payloadBytes: totalBytes,
        parseMs,
        writeMs,
        renderMs,
        sendMs,
        e2eMs,
        frames: seq,
        presentP50Ms: percentile(presentLatencies, 0.5),
        presentP95Ms: percentile(presentLatencies, 0.95),
        throughputMBps: (totalBytes / (1024 * 1024)) / (e2eMs / 1000),
        cols: COLS,
        rows: ROWS,
        scale,
        surfacePx: { width: term.width, height: term.height },
        electronVersion: process.versions.electron,
        chromiumVersion: process.versions.chrome,
        platform: process.platform,
        arch: process.arch
      };
      console.log(JSON.stringify(out, null, 2));
      const resultsDir = path.join(__dirname, '..', 'results');
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(path.join(resultsDir, 'ghostty.json'), JSON.stringify(out, null, 2));
      if (process.argv.includes('--screenshot')) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(resultsDir, 'ghostty-frame.png'), img.toPNG());
      }
      app.quit();
    } catch (err) {
      console.error('benchmark error:', err);
      app.exit(1);
    }
  });

  ipcMain.on('bench-error', (event, msg) => {
    console.error('consumer error:', msg);
    app.exit(1);
  });

  await win.loadFile(path.join(__dirname, 'consumer.html'));
});

app.on('window-all-closed', () => app.quit());
