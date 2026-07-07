'use strict';
/**
 * Side-by-side interactive demo: two real shells (node-pty), one rendered by
 * xterm.js + WebGL in the renderer (left), one by libghostty-vt + native
 * IOSurface producer + sharedTexture (right). Type in either window and
 * compare the feel; run `cat payload.txt`, `find /`, vim, less, etc.
 *
 * Flags:
 *   --smoke  echo a marker through both PTYs, verify both grids show it,
 *            write results/demo-smoke.json (+ screenshots) and exit.
 */
if (process.platform !== 'darwin') {
  console.error('The demo needs the native IOSurface producer (macOS-only for now).');
  process.exit(1);
}
const { app, BrowserWindow, clipboard, ipcMain, screen, sharedTexture } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));

const COLS = 120;
const ROWS = 30;
const FONT_SIZE = 13;
const SMOKE = process.argv.includes('--smoke');
const SHELL = process.env.SHELL || '/bin/zsh';

function spawnShell(cols, rows) {
  return pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME,
    env: process.env
  });
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor;
  const work = display.workArea;

  /* ─── ghostty terminal (right) ─────────────────────────────────────── */
  const term = addon.create(COLS, ROWS, FONT_SIZE, scale);
  const cssW = Math.ceil(term.width / scale);
  const cssH = Math.ceil(term.height / scale);

  const ptyG = spawnShell(COLS, ROWS);
  const ghosttyWin = new BrowserWindow({
    x: work.x + Math.floor(work.width / 2),
    y: work.y,
    width: cssW + 20,
    height: cssH + 60,
    title: 'libghostty + sharedTexture',
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload-ghostty.js')
    }
  });

  ptyG.onData((d) => {
    addon.write(term.session, Buffer.from(d, 'utf8'));
  });

  // Present loop: ~120Hz dirty checks; render() returns null when clean so
  // idle cost is a render_state_update. One transfer in flight at a time,
  // and an IOSurface is only redrawn after the consumer ACKED the last frame
  // that used it — otherwise we'd repaint a surface the compositor is still
  // reading and the user sees torn/blended frames under fast TUI updates.
  let sendBusy = false;
  let seq = 0;
  let maxAckedSeq = 0;
  let lastSurfaceIndex = 0;
  const surfaceSeq = [0, 0]; // last seq presented from each IOSurface
  let framesThisSecond = 0;
  let fps = 0;
  let renderMsLast = 0;
  const pendingSends = new Map();
  let presentLatencyEma = 0;

  setInterval(() => { fps = framesThisSecond; framesThisSecond = 0; }, 1000);

  async function presentTick() {
    if (sendBusy || ghosttyWin.isDestroyed()) return;
    // render() flips to the other surface; skip until its last frame is acked.
    const nextIndex = 1 - lastSurfaceIndex;
    if (surfaceSeq[nextIndex] > maxAckedSeq) return;
    let frame;
    try {
      frame = addon.render(term.session);
    } catch { return; }
    if (!frame) return;
    renderMsLast = frame.renderMs;
    lastSurfaceIndex = frame.surfaceIndex;
    sendBusy = true;
    seq++;
    surfaceSeq[frame.surfaceIndex] = seq;
    pendingSends.set(seq, performance.now());
    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: {
          codedSize: { width: frame.width, height: frame.height },
          pixelFormat: 'bgra',
          handle: { ioSurface: frame.handle }
        }
      });
      await sharedTexture.sendSharedTexture(
        { frame: ghosttyWin.webContents.mainFrame, importedSharedTexture: imported },
        { seq }
      );
      imported.release();
      framesThisSecond++;
    } catch {
      // window closing mid-send
    } finally {
      sendBusy = false;
    }
  }
  const presentTimer = setInterval(presentTick, 8);

  ipcMain.on('frame-presented', (event, ack) => {
    maxAckedSeq = Math.max(maxAckedSeq, ack.seq);
    const sent = pendingSends.get(ack.seq);
    if (sent !== undefined) {
      const latency = performance.now() - sent;
      pendingSends.delete(ack.seq);
      // The first frames land before the window has finished its initial
      // paint; don't let their multi-hundred-ms acks poison the EMA.
      if (ack.seq > 2 || latency < 100) {
        presentLatencyEma = presentLatencyEma ? presentLatencyEma * 0.8 + latency * 0.2 : latency;
      }
    }
  });

  const statsTimer = setInterval(() => {
    if (!ghosttyWin.isDestroyed()) {
      ghosttyWin.webContents.send('stats', {
        fps,
        renderMs: renderMsLast,
        presentMs: presentLatencyEma
      });
    }
  }, 500);

  ipcMain.on('renderer-ready', () => {
    ghosttyWin.webContents.send('init', {
      cssWidth: cssW,
      cssHeight: cssH,
      cellWidth: term.cellWidth / scale,
      cellHeight: term.cellHeight / scale
    });
  });

  let hasSelection = false;
  function clearSelection() {
    if (!hasSelection) return;
    hasSelection = false;
    try { addon.clearSelection(term.session); } catch {}
  }

  ipcMain.on('g-key', (event, ev) => {
    clearSelection();
    try {
      const bytes = addon.encodeKey(term.session, ev);
      if (bytes.length > 0) ptyG.write(bytes.toString('binary'));
    } catch { /* unknown key */ }
  });

  ipcMain.on('g-paste', () => {
    const text = clipboard.readText();
    if (text) ptyG.write(text);
  });

  // Mouse selection: anchor on mousedown, extend on drag, keep on mouseup.
  let selAnchor = null;
  ipcMain.on('g-sel', (event, { phase, x, y }) => {
    const cx = Math.max(0, Math.min(COLS - 1, x));
    const cy = Math.max(0, Math.min(ROWS - 1, y));
    if (phase === 'start') {
      selAnchor = { x: cx, y: cy };
      clearSelection();
    } else if (selAnchor && (phase === 'drag' || phase === 'end')) {
      if (phase === 'end' && cx === selAnchor.x && cy === selAnchor.y && !hasSelection) {
        clearSelection(); // click without drag
        return;
      }
      // Order anchor/point so start ≤ end (backward drags).
      let [s0, s1] = [selAnchor, { x: cx, y: cy }];
      if (s1.y < s0.y || (s1.y === s0.y && s1.x < s0.x)) [s0, s1] = [s1, s0];
      try {
        addon.setSelection(term.session, s0.x, s0.y, s1.x, s1.y);
        hasSelection = true;
      } catch {}
    }
  });

  ipcMain.on('g-copy', () => {
    try {
      const text = addon.getSelectionText(term.session);
      if (text) clipboard.writeText(text);
    } catch {}
  });

  let scrollRemainder = 0;
  ipcMain.on('g-wheel', (event, { deltaY }) => {
    scrollRemainder += deltaY / (term.cellHeight / scale);
    const rows = Math.trunc(scrollRemainder);
    if (rows !== 0) {
      scrollRemainder -= rows;
      addon.scroll(term.session, rows);
    }
  });

  await ghosttyWin.loadFile(path.join(__dirname, 'consumer.html'));

  /* ─── xterm.js terminal (left) ─────────────────────────────────────── */
  const ptyX = spawnShell(COLS, ROWS);
  const xtermWin = new BrowserWindow({
    x: work.x,
    y: work.y,
    width: cssW + 20,
    height: cssH + 60,
    title: 'xterm.js + WebGL',
    webPreferences: {
      nodeIntegration: true,
      backgroundThrottling: false,
      contextIsolation: false
    }
  });

  ptyX.onData((d) => {
    if (!xtermWin.isDestroyed()) xtermWin.webContents.send('x-data', d);
  });
  ipcMain.on('x-input', (event, data) => ptyX.write(data));
  ipcMain.on('x-resize', (event, { cols, rows }) => ptyX.resize(cols, rows));
  ipcMain.on('x-ready', () => {
    xtermWin.webContents.send('x-config', { cols: COLS, rows: ROWS, fontSize: FONT_SIZE });
  });

  await xtermWin.loadFile(path.join(__dirname, 'xterm.html'));

  app.on('before-quit', () => {
    clearInterval(presentTimer);
    clearInterval(statsTimer);
    try { ptyG.kill(); } catch {}
    try { ptyX.kill(); } catch {}
  });

  /* ─── smoke mode for integration tests ─────────────────────────────── */
  if (SMOKE) {
    const MARKER = 'SMOKE_' + 6 * 7 + '_OK';
    const isEcho = (l) => l.includes(MARKER) && !l.includes('echo');
    setTimeout(() => {
      ptyG.write(`echo ${MARKER}\r`);
      ptyX.write(`echo ${MARKER}\r`);
    }, 1500);

    // Poll until both grids show the echo — fixed short deadlines flake on
    // slow CI VMs (shell spawn + first paint can take several seconds).
    const deadline = Date.now() + 25_000;
    let xtermLines = [];
    ipcMain.on('x-text', (event, lines) => { xtermLines = lines; });

    const poll = setInterval(async () => {
      let ghosttyEcho = false;
      try { ghosttyEcho = addon.getText(term.session).some(isEcho); } catch {}
      const xtermEcho = xtermLines.some(isEcho);
      if (!xtermWin.isDestroyed()) xtermWin.webContents.send('x-get-text');

      if (!(ghosttyEcho && xtermEcho) && Date.now() < deadline) return;
      clearInterval(poll);

      const resultsDir = path.join(__dirname, '..', 'results');
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(resultsDir, 'demo-smoke.json'),
        JSON.stringify({ ghosttyEcho, xtermEcho, marker: MARKER }, null, 2)
      );
      const gImg = await ghosttyWin.webContents.capturePage();
      fs.writeFileSync(path.join(resultsDir, 'demo-ghostty.png'), gImg.toPNG());
      const xImg = await xtermWin.webContents.capturePage();
      fs.writeFileSync(path.join(resultsDir, 'demo-xterm.png'), xImg.toPNG());

      console.log(JSON.stringify({ ghosttyEcho, xtermEcho }));
      app.exit(ghosttyEcho && xtermEcho ? 0 : 1);
    }, 500);
  }
});

app.on('window-all-closed', () => app.quit());
