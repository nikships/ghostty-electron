'use strict';
/**
 * Approach A demo: ghostty embedded headlessly — ghostty owns
 * EVERYTHING (PTY + shell, VT parsing, key/mouse encoding, selection,
 * fonts/shaping, Metal rendering, IOSurface presentation). Electron's
 * main process is just ghostty's "app runtime": it ticks the app loop,
 * forwards input events, and ships presented IOSurfaces zero-copy into
 * a sandboxed <canvas> via the sharedTexture module.
 *
 *   ghostty_surface_new(HEADLESS)  ─┐ (fork patch: headless platform)
 *   app tick + input forwarding    ─┤ this file
 *   ghostty_surface_headless_frame ─┘
 *     -> sharedTexture.importSharedTexture({ ioSurface })
 *     -> <canvas> VideoFrame drawImage
 */
const { app, BrowserWindow, ipcMain, screen, sharedTexture } = require('electron');
const fs = require('fs');
const path = require('path');

const addon = require(path.join(
  __dirname, '..', 'native', 'ghostty-renderer', 'build', 'Release',
  'ghostty_renderer.node'));

// --smoke: run a marker command, wait until its output is visibly
// rendered (checked in the raw IOSurface), screenshot, write a result
// JSON, exit 0/1. Used by test/integration.test.js and CI.
const SMOKE = process.argv.includes('--smoke');

app.whenReady().then(() => {
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const widthPx = Math.round(960 * scale);
  const heightPx = Math.round(560 * scale);

  addon.init();
  const term = addon.create({
    widthPx,
    heightPx,
    scale,
    fontSize: 13,
    // No command: ghostty launches the user's shell like a real window.
    // Smoke mode runs a deterministic marker instead. Note: ghostty
    // execs the command directly (login-shell exec), so compound
    // commands must be wrapped in an explicit sh -c.
    ...(SMOKE
      ? { command: `/bin/sh -c 'printf "DEMO_SMOKE_MARKER\\n"; sleep 60'` }
      : {}),
  });

  const win = new BrowserWindow({
    width: Math.ceil(widthPx / scale) + 24,
    height: Math.ceil(heightPx / scale) + 48,
    title: 'ghostty embedded headless (approach A) inside Electron',
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Present loop: tick ghostty (drains its app mailbox; its render
  // thread draws on damage), then ship the last presented IOSurface if
  // it changed. lastPtr dedups identical frames cheaply (the swap
  // chain rotates surfaces, so a new frame = a different pointer).
  let lastPtr = null;
  let sending = false;
  async function presentTick() {
    if (sending || win.isDestroyed()) return;
    addon.tick(term);
    if (addon.processExited(term)) {
      app.quit();
      return;
    }
    const frame = addon.frame(term);
    if (!frame) return;
    const ptr = frame.handle.toString('hex');
    if (ptr === lastPtr) return;
    lastPtr = ptr;
    sending = true;
    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: {
          codedSize: { width: frame.width, height: frame.height },
          pixelFormat: 'bgra',
          handle: { ioSurface: frame.handle },
        },
      });
      await sharedTexture.sendSharedTexture(
        { frame: win.webContents.mainFrame, importedSharedTexture: imported },
        {},
      );
      imported.release();
    } catch (err) {
      console.error('present failed:', err.message);
    } finally {
      sending = false;
    }
  }

  let presentTimer = null;
  ipcMain.on('renderer-ready', () => {
    win.webContents.send('init', {
      cssWidth: widthPx / scale,
      cssHeight: heightPx / scale,
    });
    addon.draw(term);
    if (!presentTimer) presentTimer = setInterval(presentTick, 8); // ~120Hz
    if (SMOKE) runSmoke();
  });

  async function runSmoke() {
    const t0 = Date.now();
    const deadline = t0 + 60_000;
    let fg = 0;
    // Wait until the marker output is visibly rendered in the IOSurface.
    while (Date.now() < deadline) {
      addon.tick(term);
      addon.draw(term);
      const px = addon.readPixels(term);
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
    await new Promise(r => setTimeout(r, 300));
    const resultsDir = path.join(__dirname, '..', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(resultsDir, 'demo-ghostty.png'), img.toPNG());
    } catch {}
    const ok = fg > 200;
    const out = {
      ok,
      foregroundPixels: fg,
      elapsedMs: Date.now() - t0,
      size: addon.size(term),
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

  // Input: everything goes through ghostty's own encoders.
  ipcMain.on('key', (event, k) => addon.key(term, k));
  ipcMain.on('text', (event, t) => addon.text(term, t));
  ipcMain.on('mouse-button', (event, { action, button, mods }) =>
    addon.mouseButton(term, action, button, mods));
  ipcMain.on('mouse-pos', (event, { x, y, mods }) =>
    addon.mousePos(term, x * scale, y * scale, mods));
  ipcMain.on('mouse-scroll', (event, { x, y, dx, dy }) =>
    addon.mouseScroll(term, x * scale, y * scale, dx, dy));

  // Window resize -> surface resize. Ghostty reflows the grid, resizes
  // the PTY (SIGWINCH), and re-renders — all internal.
  let resizeTimer = null;
  win.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const [cssW, cssH] = win.getContentSize();
      const wPx = Math.max(200, (cssW - 24) * scale);
      const hPx = Math.max(100, (cssH - 48) * scale);
      addon.resize(term, Math.round(wPx), Math.round(hPx));
      win.webContents.send('init', {
        cssWidth: wPx / scale,
        cssHeight: hPx / scale,
      });
    }, 80);
  });

  win.on('closed', () => {
    if (presentTimer) clearInterval(presentTimer);
    addon.destroy(term); // frees surface: ghostty kills+reaps the shell
  });

  win.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
