'use strict';
/**
 * Side-by-side interactive demo: two real shells (node-pty), one rendered by
 * xterm.js + WebGL in the renderer (left), one by libghostty-vt + native
 * IOSurface producer + sharedTexture (right). Type in either window and
 * compare the feel; run `cat payload.txt`, `find /`, vim, less, etc.
 *
 * Flags:
 *   --smoke        echo a marker through both PTYs, verify both grids show
 *                  it, write results/demo-smoke.json (+ screenshots), exit.
 *   --mouse-smoke  run `cat -v` in the PTY with SGR mouse tracking enabled,
 *                  synthesize real clicks/drag/wheel via sendInputEvent and
 *                  verify the app received the right escape sequences;
 *                  write results/demo-mouse-smoke.json and exit.
 */
const { app, BrowserWindow, clipboard, ipcMain, screen, shell, sharedTexture } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));
if (typeof addon.render !== 'function') {
  console.error('No platform renderer in the addon on this OS.');
  process.exit(1);
}

const COLS = 120;
const ROWS = 30;
const FONT_SIZE = 13;
const SMOKE = process.argv.includes('--smoke');
const MOUSE_SMOKE = process.argv.includes('--mouse-smoke');
const SHELL = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');

function spawnShell(cols, rows) {
  return pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || process.env.USERPROFILE,
    env: process.env
  });
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor;
  const work = display.workArea;

  /* ─── ghostty terminal (right) ─────────────────────────────────────── */
  const term = addon.create(COLS, ROWS, FONT_SIZE, scale);
  let cssW = Math.ceil(term.width / scale);
  let cssH = Math.ceil(term.height / scale);
  // Grid size is mutable (auto-resizes with the window); the font — and thus
  // the CSS cell size — is fixed, so cols/rows follow from the content area.
  let cols = COLS, rows = ROWS;
  const cellCssW = term.cellWidth / scale;
  const cellCssH = term.cellHeight / scale;

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
    // write() returns terminal query responses (CPR/DA/…) that must go back
    // to the PTY — ncurses apps stall for seconds without them.
    const resp = addon.write(term.session, Buffer.from(d, 'utf8'));
    if (resp && resp.length) ptyG.write(resp.toString('binary'));
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
          handle: process.platform === 'darwin' ? { ioSurface: frame.handle } : { ntHandle: frame.handle }
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
  // Present only after the consumer's first paint: a sharedTexture sent
  // into a window that hasn't composited yet stalls ~1s inside Electron and
  // the acks stall behind it — the screen then lags the grid by up to a
  // second right at startup (mid-paint htop frames stuck on screen).
  let presentTimer = null;

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

  function sendInit() {
    if (ghosttyWin.isDestroyed()) return;
    ghosttyWin.webContents.send('init', { cssWidth: cssW, cssHeight: cssH });
  }

  ipcMain.on('renderer-ready', () => {
    sendInit();
    if (!presentTimer) presentTimer = setInterval(presentTick, 8);
  });

  // Canvas position (CSS px, window-relative), reported by the renderer
  // after each init (it moves when the window resizes); used to aim
  // synthesized input in --mouse-smoke.
  let canvasRect = null;
  ipcMain.on('canvas-rect', (event, r) => { canvasRect = r; });

  // Auto-resize: derive cols/rows from the window's content area and the fixed
  // cell size, then resize the terminal (reallocates IOSurfaces), the PTY, and
  // the on-screen canvas to match. Debounced to once per frame — a drag emits a
  // burst of 'resize' events. The 20px/60px chrome margins mirror the initial
  // window sizing below.
  let resizeTimer = null;
  function applyResize() {
    resizeTimer = null;
    if (ghosttyWin.isDestroyed()) return;
    const [winW, winH] = ghosttyWin.getContentSize();
    const nextCols = Math.max(1, Math.floor((winW - 20) / cellCssW));
    const nextRows = Math.max(1, Math.floor((winH - 60) / cellCssH));
    if (nextCols === cols && nextRows === rows) return;
    cols = nextCols;
    rows = nextRows;
    let dims;
    try {
      dims = addon.resize(term.session, cols, rows); // also reallocates surfaces
    } catch { return; }
    ptyG.resize(cols, rows);
    cssW = Math.ceil(dims.width / scale);
    cssH = Math.ceil(dims.height / scale);
    // The surfaces are new buffers; drop the old present gate so the next
    // render isn't withheld waiting on acks that reference freed surfaces.
    seq = 0;
    maxAckedSeq = 0;
    lastSurfaceIndex = 0;
    surfaceSeq[0] = surfaceSeq[1] = 0;
    pendingSends.clear();
    sendInit(); // restyle the canvas to the new CSS size
  }
  ghosttyWin.on('resize', () => {
    if (!resizeTimer) resizeTimer = setTimeout(applyResize, 16);
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

  /* ── mouse: app tracking vs local selection ──────────────────────────
   * Events arrive with canvas-relative CSS pixel coords. When the PTY app
   * enabled mouse tracking (htop, vim :set mouse=a, …) we encode via
   * libghostty — encodeMouse reads the tracking/format modes off the
   * terminal and returns the right escape sequence (or nothing) — and
   * write it to the PTY. Shift bypasses tracking for local selection,
   * the universal terminal convention. Cmd+click always opens links. */
  const DOM_TO_GHOSTTY_BUTTON = [1, 3, 2, 8, 9]; // left, middle, right, back, forward
  const toPx = (css) => css * scale; // CSS px → surface px
  const cellOf = (m) => ({
    x: Math.max(0, Math.min(cols - 1, Math.floor(toPx(m.cssX) / term.cellWidth))),
    y: Math.max(0, Math.min(rows - 1, Math.floor(toPx(m.cssY) / term.cellHeight)))
  });
  const sendMouse = (m, action, button) => {
    try {
      const bytes = addon.encodeMouse(term.session, {
        action,
        button,
        x: toPx(m.cssX),
        y: toPx(m.cssY),
        shift: m.shift,
        ctrl: m.ctrl,
        alt: m.alt
      });
      if (bytes.length > 0) ptyG.write(bytes.toString('binary'));
    } catch {}
  };

  let selAnchor = null;       // local selection drag anchor
  let appDragButton = -1;     // ghostty button held while app tracking owns the drag
  ipcMain.on('g-mouse', (event, m) => {
    let tracking = false;
    try { tracking = addon.getMouseState(term.session).tracking; } catch {}
    const appOwns = tracking && !m.shift;

    if (m.type === 'down') {
      if (m.meta && m.button === 0) { openLinkAt(cellOf(m)); return; }
      if (appOwns) {
        appDragButton = DOM_TO_GHOSTTY_BUTTON[m.button] ?? 0;
        sendMouse(m, 'press', appDragButton);
        return;
      }
      if (m.button !== 0) return;
      selAnchor = cellOf(m);
      clearSelection();
    } else if (m.type === 'move') {
      if (appDragButton >= 0) { sendMouse(m, 'motion', appDragButton); return; }
      if (tracking && !m.buttons) { sendMouse(m, 'motion', -1); return; } // any-event mode (1003)
      if (!selAnchor || !(m.buttons & 1)) return;
      dragSelection(cellOf(m), false);
    } else if (m.type === 'up') {
      if (appDragButton >= 0) {
        sendMouse(m, 'release', appDragButton);
        appDragButton = -1;
        return;
      }
      if (!selAnchor) return;
      dragSelection(cellOf(m), true);
      selAnchor = null;
    } else if (m.type === 'dblclick') {
      if (appOwns) return; // press/release pair already reported
      selectWordAt(cellOf(m));
    }
  });

  function dragSelection({ x: cx, y: cy }, isEnd) {
    if (isEnd && cx === selAnchor.x && cy === selAnchor.y && !hasSelection) {
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

  ipcMain.on('g-copy', () => {
    try {
      const text = addon.getSelectionText(term.session);
      if (text) clipboard.writeText(text);
    } catch {}
  });

  // Cursor blink: host-driven phase toggle, paused while output/typing is
  // active (like every native terminal).
  let lastActivity = performance.now();
  ptyG.onData(() => { lastActivity = performance.now(); });
  let blinkHidden = false;
  const blinkTimer = setInterval(() => {
    try {
      if (performance.now() - lastActivity < 600) {
        if (blinkHidden) { blinkHidden = false; addon.setCursorHidden(term.session, false); }
        return;
      }
      blinkHidden = !blinkHidden;
      addon.setCursorHidden(term.session, blinkHidden);
    } catch {}
  }, 530);

  // Double-click word selection (ghostty's own word-boundary rules).
  function selectWordAt({ x, y }) {
    try {
      // Coords are pre-clamped by cellOf.
      const text = addon.selectWord(term.session, x, y);
      hasSelection = !!text;
    } catch {}
  }

  // Cmd+click opens the URL under the pointer.
  const URL_RE = /https?:\/\/[^\s'"«»‹›]+/g;
  function openLinkAt({ x, y }) {
    try {
      const line = addon.getText(term.session)[y] || ''; // y pre-clamped by cellOf
      for (const m of line.matchAll(URL_RE)) {
        if (x >= m.index && x < m.index + m[0].length) {
          shell.openExternal(m[0].replace(/[.,;:)\]]+$/, ''));
          return;
        }
      }
    } catch {}
  }

  // IME: composed text arrives whole from the renderer's composition events.
  ipcMain.on('g-ime', (event, text) => {
    clearSelection();
    if (typeof text === 'string' && text) ptyG.write(text);
  });

  // Cmd+F search over screen + scrollback: scroll to the hit, highlight it
  // via the selection machinery.
  let search = { query: '', matches: [], idx: -1 };
  ipcMain.on('g-search', (event, { query, dir }) => {
    try {
      if (query !== search.query) {
        const bar = addon.getScrollbar(term.session);
        const lines = (addon.getRecentText(term.session, bar.total) || '').split('\n');
        const base = bar.total - lines.length;
        const matches = [];
        lines.forEach((line, i) => {
          let col = line.indexOf(query);
          while (query && col !== -1) {
            matches.push({ row: base + i, col });
            col = line.indexOf(query, col + 1);
          }
        });
        search = { query, matches, idx: -1 };
      }
      if (!search.matches.length) {
        event.sender.send('search-result', { count: 0, idx: 0 });
        return;
      }
      search.idx = (search.idx + (dir || 1) + search.matches.length) % search.matches.length;
      const m = search.matches[search.idx];
      addon.scrollToRow(term.session, Math.max(0, m.row - Math.floor(rows / 2)));
      const offset = addon.getScrollbar(term.session).offset;
      const vy = m.row - offset;
      if (vy >= 0 && vy < rows) {
        addon.setSelection(term.session, m.col, vy,
          Math.min(cols - 1, m.col + search.query.length - 1), vy);
        hasSelection = true;
      }
      event.sender.send('search-result', { count: search.matches.length, idx: search.idx + 1 });
    } catch {}
  });
  ipcMain.on('g-search-close', () => { search = { query: '', matches: [], idx: -1 }; clearSelection(); });

  /* Wheel, three ways (same arbitration as native terminals):
   *  1. app enabled mouse tracking → wheel button 4/5 press events
   *     (htop scrolls its process list, vim :set mouse=a scrolls buffers)
   *  2. alt screen + mode 1007 (alternate scroll, default on) → arrow keys
   *     (how less/man scroll without mouse support)
   *  3. otherwise → our scrollback viewport, as before. */
  let scrollRemainder = 0;
  ipcMain.on('g-wheel', (event, m) => {
    scrollRemainder += m.deltaY / (term.cellHeight / scale);
    const scrollRows = Math.trunc(scrollRemainder);
    if (scrollRows === 0) return;
    scrollRemainder -= scrollRows;

    let state = { tracking: false, altScreen: false, altScroll: false };
    try { state = addon.getMouseState(term.session); } catch {}

    if (state.tracking && !m.shift) {
      const button = scrollRows < 0 ? 4 : 5; // 4 = wheel up, 5 = wheel down
      for (let i = 0; i < Math.min(Math.abs(scrollRows), 20); i++) {
        sendMouse(m, 'press', button);
      }
    } else if (state.altScreen && state.altScroll) {
      const code = scrollRows < 0 ? 'ArrowUp' : 'ArrowDown';
      try {
        const bytes = addon.encodeKey(term.session, { code });
        for (let i = 0; i < Math.min(Math.abs(scrollRows), 20); i++) {
          ptyG.write(bytes.toString('binary'));
        }
      } catch {}
    } else {
      addon.scroll(term.session, scrollRows);
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
    clearInterval(blinkTimer);
    try { ptyG.kill(); } catch {}
    try { ptyX.kill(); } catch {}
  });

  /* ─── debug: auto-type + timed screenshots (GXB_AUTOTYPE) ──────────── */
  if (process.env.GXB_AUTOTYPE) {
    setTimeout(() => {
      const text = process.env.GXB_AUTOTYPE.replace(/\\r/g, '\r');
      ptyG.write(text);
      ptyX.write(text);
    }, 1200);
    const shots = [1800, 3500, 8000];
    shots.forEach((ms, i) => setTimeout(async () => {
      const img = await ghosttyWin.webContents.capturePage();
      fs.mkdirSync(path.join(__dirname, '..', 'results'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '..', 'results', `autotype-${i}.png`), img.toPNG());
      const xImg = await xtermWin.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, '..', 'results', `autotype-xterm-${i}.png`), xImg.toPNG());
      if (i === shots.length - 1) app.exit(0);
    }, ms));
  }

  /* ─── mouse smoke mode for integration tests ───────────────────────── */
  // Full-path verification: OS-level input events synthesized into the real
  // renderer (sendInputEvent) → preload listeners → IPC → encodeMouse →
  // PTY → a raw-mode `cat -v` that prints what the app receives → grid.
  // Asserts the app saw the exact SGR sequences a click/drag/wheel produce.
  if (MOUSE_SMOKE) {
    // Raw tty (no canonical buffering, no echo), enable button-event
    // tracking + SGR as an app like vim would, then print received input.
    setTimeout(() => {
      ptyG.write(`stty -icanon -echo min 1 time 0; printf '\\033[?1002h\\033[?1006h'; cat -v\r`);
    }, 1500);

    const at = (cx, cy) => ({
      x: Math.round(canvasRect.left + (cx + 0.5) * cellCssW),
      y: Math.round(canvasRect.top + (cy + 0.5) * cellCssH)
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Join rows so sequences that soft-wrap across the 120-col boundary
    // are still found.
    const gridHas = (s) => {
      try { return addon.getText(term.session).join('').includes(s); } catch { return false; }
    };
    const waitFor = async (pred, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (pred()) return true;
        await sleep(200);
      }
      return false;
    };

    (async () => {
      const trackingEnabled = await waitFor(() => {
        if (!canvasRect) return false;
        try { return addon.getMouseState(term.session).tracking; } catch { return false; }
      }, 25_000);
      if (!canvasRect) canvasRect = { left: 0, top: 0 }; // still record results

      const send = (ev) => ghosttyWin.webContents.sendInputEvent(ev);
      const p = at(5, 3), q = at(10, 3);
      // Click cell (5,3), drag to (10,3), release.
      send({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(100);
      send({ type: 'mouseMove', x: q.x, y: q.y });
      await sleep(100);
      send({ type: 'mouseUp', x: q.x, y: q.y, button: 'left', clickCount: 1 });
      await sleep(100);
      // Wheel both directions over cell (5,3) — one maps to button 4 (64),
      // the other to button 5 (65).
      send({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: 100 });
      await sleep(100);
      send({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: -100 });

      // cat -v renders ESC as ^[ — cell (5,3) is SGR "6;4", (10,3) "11;4".
      const results = {
        trackingEnabled,
        press: await waitFor(() => gridHas('^[[<0;6;4M'), 10_000),
        drag: gridHas('^[[<32;11;4M'),
        release: gridHas('^[[<0;11;4m'),
        wheelUp: await waitFor(() => gridHas('^[[<64;6;4M'), 5_000),
        wheelDown: await waitFor(() => gridHas('^[[<65;6;4M'), 5_000),
        // First grid rows for diagnosis when an expectation fails.
        grid: (() => { try { return addon.getText(term.session).slice(0, 8); } catch { return []; } })()
      };

      const resultsDir = path.join(__dirname, '..', 'results');
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(resultsDir, 'demo-mouse-smoke.json'),
        JSON.stringify(results, null, 2)
      );
      try {
        const img = await ghosttyWin.webContents.capturePage();
        fs.writeFileSync(path.join(resultsDir, 'demo-mouse-smoke.png'), img.toPNG());
      } catch {}

      const ok = Object.values(results).every(Boolean);
      console.log(JSON.stringify(results));
      app.exit(ok ? 0 : 1);
    })();
  }

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

      // Screenshots are diagnostics, but capturePage() is GPU-dependent and can
      // reject on headless CI runners. A rejection here must NOT turn a passing
      // echo round-trip into a crash exit — capture defensively and retry once.
      let shotOk = false;
      for (let attempt = 0; attempt < 2 && !shotOk; attempt++) {
        try {
          const gImg = await ghosttyWin.webContents.capturePage();
          fs.writeFileSync(path.join(resultsDir, 'demo-ghostty.png'), gImg.toPNG());
          const xImg = await xtermWin.webContents.capturePage();
          fs.writeFileSync(path.join(resultsDir, 'demo-xterm.png'), xImg.toPNG());
          shotOk = true;
        } catch (err) {
          console.error(`capturePage failed (attempt ${attempt + 1}): ${err && err.message}`);
        }
      }

      console.log(JSON.stringify({ ghosttyEcho, xtermEcho, shotOk }));
      app.exit(ghosttyEcho && xtermEcho && shotOk ? 0 : 1);
    }, 500);
  }
});

app.on('window-all-closed', () => app.quit());
