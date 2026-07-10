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
 *
 * Engine placement — opts.engine:
 *   'utility' (default)  the whole engine runs in an Electron
 *       utilityProcess (host.js); the main process only re-derives
 *       each presented frame from its global IOSurfaceID
 *       (IOSurfaceLookup) and imports it into sharedTexture. A busy
 *       or crashed terminal can't stall window management, and the
 *       path stays zero-copy — frames never leave the GPU.
 *   'main'  the engine runs in this process (the original mode; also
 *       what tests use to assert on pixels synchronously).
 */
const { EventEmitter } = require('events');
const path = require('path');
const { ipcMain, sharedTexture, utilityProcess } = require('electron');
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

/* ── engine drivers ─────────────────────────────────────────────────
 * Same contract, two placements. The terminal talks to a driver;
 * frames flow driver -> terminal._presentFrame(textureInfoHandle). */

/** Engine in this process: the addon drives ghostty directly. */
class LocalEngine {
  constructor(term, opts) {
    this._term = term;
    this._addon = load();
    if (!addonInited) {
      this._addon.init();
      addonInited = true;
    }
    this._handle = this._addon.create(opts);
    this._timer = null;
    this._lastFramePtr = null;
    this._exited = false;
  }

  start() {
    this._addon.draw(this._handle);
    if (!this._timer) {
      this._timer = setInterval(() => this._tick(), PRESENT_INTERVAL_MS);
    }
  }

  _tick() {
    if (this._term._sending) return;
    this._addon.tick(this._handle);
    if (this._addon.processExited(this._handle)) {
      if (!this._exited) {
        this._exited = true;
        this.stop();
        this._term._onExit();
      }
      return;
    }
    const frame = this._addon.frame(this._handle);
    if (!frame) return;
    // The swap chain rotates surfaces, so a new frame = a new pointer.
    const ptr = frame.handle.toString('hex');
    if (ptr === this._lastFramePtr) return;
    this._lastFramePtr = ptr;
    this._term._presentFrame(
      { ioSurface: frame.handle }, frame.width, frame.height);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  send(method, ...args) { this._addon[method](this._handle, ...args); }
  size() { return this._addon.size(this._handle); }
  processExited() { return this._addon.processExited(this._handle); }
  tick() { this._addon.tick(this._handle); }
  draw() { this._addon.draw(this._handle); }
  readPixels() { return this._addon.readPixels(this._handle); }

  destroy() {
    this.stop();
    this._addon.destroy(this._handle);
  }
}

/**
 * Engine in an Electron utilityProcess (host.js). Frames arrive as
 * global IOSurfaceIDs; we re-derive a local IOSurfaceRef via
 * IOSurfaceLookup (addon, no ghostty init needed) and present it.
 * State queries (size/readPixels) become async — the sync accessors
 * serve the last known size, tests use the async variants.
 */
class UtilityEngine {
  constructor(term, opts) {
    this._term = term;
    this._addon = load(); // only for surfaceLookup/surfaceRelease
    this._exited = false;
    this._lastSize = null;
    this._replies = new Map(); // id -> resolve
    this._replySeq = 0;
    this._child = utilityProcess.fork(
      path.join(__dirname, 'host.js'),
      [],
      { serviceName: 'electron-ghostty engine' },
    );
    this._child.on('message', (msg) => this._onMessage(msg));
    this._child.on('exit', () => {
      // Engine gone (crash or destroy): flush pending requests so no
      // sizeAsync/readPixelsAsync caller hangs, then surface it like a
      // shell exit.
      for (const resolve of this._replies.values()) resolve(null);
      this._replies.clear();
      if (!this._exited) {
        this._exited = true;
        this._term._onExit();
      }
    });
    this._child.postMessage({ type: 'create', opts });
    this.size(); // prime _lastSize
  }

  start() {
    this._child.postMessage({ type: 'draw' });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'frame': {
        const surf = this._addon.surfaceLookup(msg.surfaceId);
        if (surf) {
          const ok = this._term._presentFrame(
            { ioSurface: surf }, msg.width, msg.height);
          const release = () => this._addon.surfaceRelease(surf);
          if (ok && typeof ok.then === 'function') ok.then(release, release);
          else release();
        }
        // Ack regardless — a failed lookup (surface already recycled,
        // e.g. right after a resize) must not wedge the frame flow.
        this._child.postMessage({ type: 'frame-ack' });
        break;
      }
      case 'exit':
        if (!this._exited) {
          this._exited = true;
          this._term._onExit();
        }
        break;
      case 'reply': {
        const resolve = this._replies.get(msg.id);
        if (resolve) {
          this._replies.delete(msg.id);
          resolve(msg.result);
        }
        break;
      }
      case 'error':
        this._term.emit('present-error', new Error(msg.message));
        break;
    }
  }

  _request(type) {
    if (this._exited) return Promise.resolve(null);
    const id = ++this._replySeq;
    return new Promise((resolve) => {
      this._replies.set(id, resolve);
      this._child.postMessage({ type, id });
    });
  }

  stop() {}

  send(method, ...args) {
    switch (method) {
      case 'key': this._child.postMessage({ type: 'key', event: args[0] }); break;
      case 'text': this._child.postMessage({ type: 'text', text: args[0] }); break;
      case 'mouseButton':
        this._child.postMessage({
          type: 'mouse-button', action: args[0], button: args[1], mods: args[2],
        });
        break;
      case 'mousePos':
        this._child.postMessage({ type: 'mouse-pos', x: args[0], y: args[1], mods: args[2] });
        break;
      case 'mouseScroll':
        this._child.postMessage({
          type: 'mouse-scroll', x: args[0], y: args[1], dx: args[2], dy: args[3],
        });
        break;
      case 'resize':
        this._child.postMessage({ type: 'resize', widthPx: args[0], heightPx: args[1] });
        break;
      case 'draw': this._child.postMessage({ type: 'draw' }); break;
      case 'tick': break; // the host ticks itself
    }
  }

  /** Sync contract: serves the last reply and refreshes in background. */
  size() {
    this._request('size').then((s) => { this._lastSize = s; });
    return this._lastSize;
  }
  sizeAsync() {
    return this._request('size').then((s) => { this._lastSize = s; return s; });
  }
  processExited() { return this._exited; }
  tick() {}
  draw() { this._child.postMessage({ type: 'draw' }); }
  readPixels() {
    throw new Error(
      "readPixels is async with engine: 'utility' — use readPixelsAsync()");
  }
  readPixelsAsync() {
    return this._request('read-pixels').then((px) => px && {
      ...px, data: Buffer.from(px.data),
    });
  }

  destroy() {
    this._exited = true; // suppress the exit event from our own kill
    this._child.postMessage({ type: 'destroy' });
    // destroy tears down synchronously in the host then exits; kill is
    // the backstop if the host is already wedged.
    setTimeout(() => { try { this._child.kill(); } catch {} }, 1000).unref?.();
  }
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
   *   engine?      'utility' (default) | 'main' — where ghostty runs.
   * }
   */
  constructor(opts = {}) {
    super();
    this.scale = opts.scale ?? 2;
    this._destroyed = false;
    this._target = null;
    this._resizeTimer = null;
    this._sending = false;
    const engineOpts = {
      widthPx: Math.round(opts.widthPx ?? 960 * this.scale),
      heightPx: Math.round(opts.heightPx ?? 560 * this.scale),
      scale: this.scale,
      ...(opts.fontSize ? { fontSize: opts.fontSize } : {}),
      ...(opts.command ? { command: opts.command } : {}),
    };
    this.engine = opts.engine ?? 'utility';
    this._engine = this.engine === 'main'
      ? new LocalEngine(this, engineOpts)
      : new UtilityEngine(this, engineOpts);
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
      this._engine.stop();
    });
    return this;
  }

  _onRendererReady() {
    this._engine.start();
    this.emit('ready');
  }

  _onExit() {
    this.emit('exit');
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
   * Import a presented IOSurface and send it to the attached renderer.
   * `handle` is a sharedTexture handle object ({ ioSurface: Buffer }).
   * Returns the send promise (the caller may need to defer a release
   * until the transfer completes), or undefined if skipped.
   */
  _presentFrame(handle, width, height) {
    if (this._sending || this._destroyed) return;
    const target = this._target;
    if (!target || target.isDestroyed()) return;
    this._sending = true;
    let sent;
    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: {
          codedSize: { width, height },
          pixelFormat: 'bgra',
          handle,
        },
      });
      this.emit('frame', { width, height });
      sent = sharedTexture.sendSharedTexture(
        { frame: target.mainFrame, importedSharedTexture: imported }, {})
        .then(() => imported.release())
        .catch((err) => {
          imported.release();
          this.emit('present-error', err);
        })
        .finally(() => { this._sending = false; });
    } catch (err) {
      this._sending = false;
      this.emit('present-error', err);
      return;
    }
    return sent;
  }

  /* ── input (surface pixels; ghostty's own encoders) ─────────────── */

  /** Raw key event: {action, keycode, mods, text?, unshiftedCodepoint?} */
  key(k) { this._engine.send('key', k); }
  /** Cooked text input (typing, paste). */
  text(s) { this._engine.send('text', s); }
  mouseButton(action, button, mods) {
    this._engine.send('mouseButton', action, button, mods);
  }
  mousePos(x, y, mods) { this._engine.send('mousePos', x, y, mods); }
  mouseScroll(x, y, dx, dy) {
    this._engine.send('mouseScroll', x, y, dx, dy);
  }

  /* ── state ──────────────────────────────────────────────────────── */

  /** Pixel size; ghostty reflows the grid and resizes the PTY. */
  resize(widthPx, heightPx) { this._engine.send('resize', widthPx, heightPx); }
  /**
   * {cols, rows, widthPx, heightPx, cellWidth, cellHeight}.
   * With engine 'utility' this returns the last known size (may be
   * null before the first reply); use sizeAsync() for a fresh answer.
   */
  size() { return this._engine.size(); }
  sizeAsync() {
    return this._engine.sizeAsync
      ? this._engine.sizeAsync()
      : Promise.resolve(this._engine.size());
  }
  processExited() { return this._engine.processExited(); }

  /* ── advanced / testing ─────────────────────────────────────────── */

  /** Drain ghostty's app loop now (no-op with engine 'utility'). */
  tick() { this._engine.tick(); }
  /** Force a synchronous render of current state. */
  draw() { this._engine.draw(); }
  /** BGRA copy of the presented frame. Sync only with engine 'main'. */
  readPixels() { return this._engine.readPixels(); }
  /** BGRA copy of the presented frame, any engine. */
  readPixelsAsync() {
    return this._engine.readPixelsAsync
      ? this._engine.readPixelsAsync()
      : Promise.resolve(this._engine.readPixels());
  }

  /** Synchronous teardown: ghostty kills + reaps the shell. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    clearTimeout(this._resizeTimer);
    if (this._target && !this._target.isDestroyed())
      byWebContents.delete(this._target.id);
    this._target = null;
    this._engine.destroy();
  }
}

module.exports = { GhosttyTerminal, available };
