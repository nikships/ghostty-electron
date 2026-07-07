'use strict';
/**
 * libghostty + sharedTexture: cat a 1MB file through libghostty-vt in the
 * main process, render the grid natively into an IOSurface (CoreText), and
 * present it in a sandboxed renderer <canvas> via Electron's sharedTexture
 * module (IOSurface → importSharedTexture → sendSharedTexture → VideoFrame).
 *
 * Measures: first byte fed → final frame presented in the consumer canvas
 * (consumer acks after drawImage + double rAF, same finish line as the
 * xterm baseline).
 */
const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron');
const path = require('path');
const fs = require('fs');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));

const PAYLOAD = path.join(__dirname, '..', 'payload.txt');
if (!fs.existsSync(PAYLOAD)) {
  console.error('payload.txt not found — run `npm run payload` first');
  process.exit(1);
}

const COLS = 120;
const ROWS = 30;
const FONT_SIZE = 13;
const CHUNK_SIZE = 64 * 1024;
const FRAME_INTERVAL_MS = 16; // present at ~60fps cadence while feeding

app.whenReady().then(async () => {
  const term = addon.create(COLS, ROWS, FONT_SIZE);

  const win = new BrowserWindow({
    width: term.width + 40,
    height: term.height + 60,
    show: true,
    webPreferences: {
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  let seq = 0;

  async function presentFrame(isFinal) {
    const frame = addon.render(term.session);
    if (!frame && !isFinal) return false;
    if (!frame && isFinal) {
      // Nothing new to draw but we still need the final ack: re-present by
      // telling the consumer the last frame it drew was final.
      win.webContents.send('no-frame-final');
      return false;
    }
    seq++;
    const imported = sharedTexture.importSharedTexture({
      textureInfo: {
        codedSize: { width: frame.width, height: frame.height },
        pixelFormat: 'bgra',
        handle: { ioSurface: frame.handle }
      }
    });
    await sharedTexture.sendSharedTexture(
      { frame: win.webContents.mainFrame, importedSharedTexture: imported },
      { seq, isFinal }
    );
    imported.release();
    return true;
  }

  // Handlers must be registered before loadFile: the preload signals
  // 'renderer-ready' on DOMContentLoaded, before loadFile() resolves.
  ipcMain.on('renderer-ready', async () => {
    try {
      const data = fs.readFileSync(PAYLOAD);
      const t0 = performance.now();

      let lastPresent = 0;
      for (let off = 0; off < data.length; off += CHUNK_SIZE) {
        addon.write(term.session, data.subarray(off, off + CHUNK_SIZE));
        const now = performance.now();
        if (now - lastPresent >= FRAME_INTERVAL_MS) {
          lastPresent = now;
          await presentFrame(false);
        }
      }
      const parseMs = performance.now() - t0;

      // Final frame carries isFinal; the consumer acks once it is on screen.
      const finalSeq = seq + 1;
      ipcMain.on('frame-presented', async (event, ack) => {
        if (!ack.isFinal) return;
        const e2eMs = performance.now() - t0;
        const out = {
          backend: 'libghostty-vt + native IOSurface producer + sharedTexture',
          payloadBytes: data.length,
          parseMs,
          e2eMs,
          frames: finalSeq,
          throughputMBps: (data.length / (1024 * 1024)) / (e2eMs / 1000),
          cols: COLS,
          rows: ROWS,
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
      });
      await presentFrame(true);
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
