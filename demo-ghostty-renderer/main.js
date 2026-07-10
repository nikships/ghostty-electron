'use strict';
/**
 * Approach A demo: ghostty embedded headlessly — ghostty owns
 * EVERYTHING (PTY + shell, VT parsing, key/mouse encoding, selection,
 * fonts/shaping, Metal rendering, IOSurface presentation). All the
 * Electron glue (present loop, input routing, canvas-driven resize)
 * lives in packages/electron-ghostty; this demo is just a consumer:
 * create a terminal, attach it to a window whose preload is the
 * package's, done.
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const { GhosttyTerminal } = require('electron-ghostty');

// --smoke: run a marker command, wait until its output is visibly
// rendered (checked in the raw IOSurface), screenshot, write a result
// JSON, exit 0/1. Used by test/integration.test.js and CI.
const SMOKE = process.argv.includes('--smoke');
// --engine=main|utility: where ghostty runs (default: utility process).
const ENGINE = (process.argv.find(a => a.startsWith('--engine=')) || '')
  .split('=')[1] || undefined;

app.whenReady().then(() => {
  const scale = screen.getPrimaryDisplay().scaleFactor;

  const term = new GhosttyTerminal({
    scale,
    fontSize: 13,
    ...(ENGINE ? { engine: ENGINE } : {}),
    // No command: ghostty launches the user's shell like a real window.
    // Smoke mode runs a deterministic marker instead. Note: ghostty
    // execs the command directly (login-shell exec), so compound
    // commands must be wrapped in an explicit sh -c.
    ...(SMOKE
      ? { command: `/bin/sh -c 'printf "DEMO_SMOKE_MARKER\\n"; sleep 60'` }
      : {}),
  });

  const win = new BrowserWindow({
    width: 984,
    height: 608,
    title: 'ghostty embedded headless (approach A) inside Electron',
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
      preload: require.resolve('electron-ghostty/preload'),
    },
  });

  term.attach(win.webContents);
  term.on('exit', () => app.quit());
  term.on('present-error', (err) => console.error('present failed:', err.message));
  let framesPresented = 0;
  term.on('frame', () => framesPresented++);
  if (SMOKE) term.once('ready', runSmoke);

  async function runSmoke() {
    const t0 = Date.now();
    const deadline = t0 + 60_000;
    let fg = 0;
    // Wait until the marker output is visibly rendered in the IOSurface.
    while (Date.now() < deadline) {
      const px = await term.readPixelsAsync();
      if (px) {
        const bg = px.data.readUInt32LE(0);
        fg = 0;
        for (let i = 0; i < px.data.length; i += 4)
          if (px.data.readUInt32LE(i) !== bg) fg++;
        if (fg > 200) break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    // Let a frame reach the compositor, then screenshot the window.
    // The screenshot is the renderer's composited output — the pixel
    // count below proves the frame→sharedTexture→canvas path actually
    // painted, not just that ghostty rendered into its IOSurface.
    await new Promise(r => setTimeout(r, 300));
    const resultsDir = path.join(__dirname, '..', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    let rendererFg = 0;
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(resultsDir, 'demo-ghostty.png'), img.toPNG());
      const bmp = img.toBitmap(); // BGRA
      const rbg = bmp.readUInt32LE(0);
      for (let i = 0; i < bmp.length; i += 4)
        if (bmp.readUInt32LE(i) !== rbg) rendererFg++;
    } catch {}
    const ok = fg > 200 && framesPresented > 0 && rendererFg > 200;
    const out = {
      ok,
      foregroundPixels: fg,
      rendererForegroundPixels: rendererFg,
      framesPresented,
      elapsedMs: Date.now() - t0,
      size: await term.sizeAsync(),
      engine: term.engine,
      electronVersion: process.versions.electron,
      platform: process.platform,
    };
    fs.writeFileSync(
      path.join(resultsDir, 'demo-smoke.json'),
      JSON.stringify(out, null, 2),
    );
    console.log(JSON.stringify(out));
    app.exit(ok ? 0 : 1);
  }

  win.on('closed', () => {
    term.destroy(); // frees surface: ghostty kills+reaps the shell
  });

  win.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
