'use strict';
/**
 * xterm.js baseline: cat a 1MB file into xterm.js with the WebGL addon,
 * rendering in a real (visible) Chromium renderer window — this is how
 * VS Code's terminal actually renders.
 *
 * Measures: first byte written → last frame presented (rAF after final write).
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const PAYLOAD = path.join(__dirname, '..', 'payload.txt');
if (!fs.existsSync(PAYLOAD)) {
  console.error('payload.txt not found — run `npm run payload` first');
  process.exit(1);
}

// Watchdog: a renderer that fails before signaling 'ready' would otherwise
// hang the benchmark (and CI) forever.
setTimeout(() => {
  console.error('watchdog: benchmark did not complete within 180s');
  app.exit(1);
}, 180_000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      backgroundThrottling: false,
      contextIsolation: false
    }
  });

  // Handlers must be registered before loadFile: the page signals 'ready'
  // on DOMContentLoaded, which fires before loadFile() resolves.
  const repeatIdx = process.argv.indexOf('--repeat');
  const repeat = repeatIdx !== -1 ? parseInt(process.argv[repeatIdx + 1], 10) : 1;

  ipcMain.on('ready', () => {
    win.webContents.send('start', { payloadPath: PAYLOAD, repeat });
  });

  ipcMain.on('done', async (event, results) => {
    const out = {
      backend: 'xterm.js + WebGL addon (in-renderer)',
      ...results,
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      platform: process.platform,
      arch: process.arch
    };
    console.log(JSON.stringify(out, null, 2));
    const resultsDir = path.join(__dirname, '..', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, 'xterm.json'), JSON.stringify(out, null, 2));
    if (process.argv.includes('--screenshot')) {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(resultsDir, 'xterm-frame.png'), img.toPNG());
    }
    app.quit();
  });

  ipcMain.on('bench-error', (event, msg) => {
    console.error('benchmark error:', msg);
    app.exit(1);
  });

  await win.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
