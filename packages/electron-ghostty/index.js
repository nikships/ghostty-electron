'use strict';
/**
 * electron-ghostty — ghostty embedded headlessly in an Electron app.
 *
 * Ghostty owns EVERYTHING (PTY + shell, VT parsing, key/mouse encoding,
 * selection, fonts/shaping, Metal rendering, IOSurface presentation);
 * this package is the Electron glue: it ticks ghostty's app loop,
 * routes input from the renderer, and ships presented IOSurfaces
 * zero-copy into a sandboxed <canvas> via the sharedTexture module.
 *
 * Main process:
 *   const { GhosttyTerminal } = require('electron-ghostty');
 *   const term = new GhosttyTerminal({ scale, fontSize: 13 });
 *   term.attach(win.webContents);
 *   term.on('exit', () => app.quit());
 *
 * Renderer: sandboxed page with a <canvas data-ghostty> and this
 * package's preload (see preload.js). The canvas is the source of
 * truth for sizing — a ResizeObserver reports CSS size changes and
 * ghostty reflows the grid + resizes the PTY (SIGWINCH) internally.
 */
const { EventEmitter } = require('events');
const { ipcMain, sharedTexture } = require('electron');
const { load, available } = require('./addon');

const CH = (name) => `electron-ghostty:${name}`;
const PRESENT_INTERVAL_MS = 8; // ~120Hz poll of ghostty's swap chain
const RESIZE_DEBOUNCE_MS = 80;

let addonInited = false;
let ipcWired = false;
const byWebContents = new Map(); // webContents.id -> GhosttyTerminal

/* One ipcMain wiring for all terminals; events route by sender. */
function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  const route = (name, fn) =>
    ipcMain.on(CH(name), (event, arg) => {
      const term = byWebContents.get(event.sender.id);
      if (term && !term._destroyed) fn(term, arg);
    });
  route('ready', (t) => t._onRendererReady());
  route('resize', (t, { cssWidth, cssHeight }) =>
    t._onCanvasResize(cssWidth, cssHeight));
  route('key', (t, k) => t.key(k));
  route('text', (t, s) => t.text(s));
  route('mouse-button', (t, { action, button, mods }) =>
    t.mouseButton(action, button, mods));
  // Renderer sends CSS coordinates; ghostty wants surface pixels.
  route('mouse-pos', (t, { x, y, mods }) =>
    t.mousePos(x * t.scale, y * t.scale, mods));
  route('mouse-scroll', (t, { x, y, dx, dy }) =>
    t.mouseScroll(x * t.scale, y * t.scale, dx, dy));
}

class GhosttyTerminal extends EventEmitter {
  /**
   * opts: {
   *   scale        devicePixelRatio of the target display (default 2)
   *   fontSize?    pt
   *   command?     spawn this instead of the user's shell. Note:
   *                ghostty execs it directly (login-shell exec), so
   *                compound commands need an explicit `sh -c '…'`.
   *   widthPx?, heightPx?  initial surface size; the attached canvas
   *                takes over sizing as soon as the renderer reports.
   * }
   */
  constructor(opts = {}) {
    super();
    this._addon = load();
    if (!addonInited) {
      this._addon.init();
      addonInited = true;
    }
    this.scale = opts.scale ?? 2;
    this._handle = this._addon.create({
      widthPx: Math.round(opts.widthPx ?? 960 * this.scale),
      heightPx: Math.round(opts.heightPx ?? 560 * this.scale),
      scale: this.scale,
      ...(opts.fontSize ? { fontSize: opts.fontSize } : {}),
      ...(opts.command ? { command: opts.command } : {}),
    });
    this._destroyed = false;
    this._exited = false;
    this._target = null;
    this._presentTimer = null;
    this._resizeTimer = null;
    this._lastFramePtr = null;
    this._sending = false;
  }

  /**
   * Bind this terminal to a BrowserWindow's webContents. The present
   * loop starts when the renderer preload reports ready; input and
   * canvas resizes route back here automatically.
   */
  attach(webContents) {
    wireIpc();
    this._target = webContents;
    byWebContents.set(webContents.id, this);
    webContents.once('destroyed', () => {
      if (byWebContents.get(webContents.id) === this)
        byWebContents.delete(webContents.id);
      this._stopLoop();
    });
    return this;
  }

  _onRendererReady() {
    this._addon.draw(this._handle);
    if (!this._presentTimer) {
      this._presentTimer = setInterval(
        () => this._presentTick(), PRESENT_INTERVAL_MS);
    }
    this.emit('ready');
  }

  _onCanvasResize(cssWidth, cssHeight) {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.resize(
        Math.max(200, Math.round(cssWidth * this.scale)),
        Math.max(100, Math.round(cssHeight * this.scale)));
    }, RESIZE_DEBOUNCE_MS);
  }

  /**
   * Present loop: tick ghostty (drains its app mailbox; its render
   * thread draws on damage), then ship the last presented IOSurface if
   * it changed. The pointer dedups identical frames cheaply (the swap
   * chain rotates surfaces, so a new frame = a different pointer).
   */
  async _presentTick() {
    if (this._sending || this._destroyed) return;
    const target = this._target;
    if (!target || target.isDestroyed()) return;
    this._addon.tick(this._handle);
    if (this._addon.processExited(this._handle)) {
      if (!this._exited) {
        this._exited = true;
        this._stopLoop();
        this.emit('exit');
      }
      return;
    }
    const frame = this._addon.frame(this._handle);
    if (!frame) return;
    const ptr = frame.handle.toString('hex');
    if (ptr === this._lastFramePtr) return;
    this._lastFramePtr = ptr;
    this._sending = true;
    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: {
          codedSize: { width: frame.width, height: frame.height },
          pixelFormat: 'bgra',
          handle: { ioSurface: frame.handle },
        },
      });
      await sharedTexture.sendSharedTexture(
        { frame: target.mainFrame, importedSharedTexture: imported }, {});
      imported.release();
    } catch (err) {
      this.emit('present-error', err);
    } finally {
      this._sending = false;
    }
  }

  _stopLoop() {
    if (this._presentTimer) {
      clearInterval(this._presentTimer);
      this._presentTimer = null;
    }
    clearTimeout(this._resizeTimer);
  }

  /* ── input (surface pixels; ghostty's own encoders) ─────────────── */

  /** Raw key event: {action, keycode, mods, text?, unshiftedCodepoint?} */
  key(k) { this._addon.key(this._handle, k); }
  /** Cooked text input (typing, paste). */
  text(s) { this._addon.text(this._handle, s); }
  mouseButton(action, button, mods) {
    this._addon.mouseButton(this._handle, action, button, mods);
  }
  mousePos(x, y, mods) { this._addon.mousePos(this._handle, x, y, mods); }
  mouseScroll(x, y, dx, dy) {
    this._addon.mouseScroll(this._handle, x, y, dx, dy);
  }

  /* ── state ──────────────────────────────────────────────────────── */

  /** Pixel size; ghostty reflows the grid and resizes the PTY. */
  resize(widthPx, heightPx) {
    this._addon.resize(this._handle, widthPx, heightPx);
  }
  /** {cols, rows, widthPx, heightPx, cellWidth, cellHeight} */
  size() { return this._addon.size(this._handle); }
  processExited() { return this._addon.processExited(this._handle); }

  /* ── advanced / testing ─────────────────────────────────────────── */

  /** Drain ghostty's app loop now (the present loop does this itself). */
  tick() { this._addon.tick(this._handle); }
  /** Force a synchronous render of current state. */
  draw() { this._addon.draw(this._handle); }
  /** BGRA copy of the presented frame: {width, height, data}. Tests. */
  readPixels() { return this._addon.readPixels(this._handle); }

  /** Synchronous teardown: ghostty kills + reaps the shell. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._stopLoop();
    if (this._target && !this._target.isDestroyed())
      byWebContents.delete(this._target.id);
    this._target = null;
    this._addon.destroy(this._handle);
  }
}

module.exports = { GhosttyTerminal, available };
