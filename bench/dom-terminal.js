'use strict';
/**
 * Renderer-side factory for DOM backends: constructs an xterm.js-compatible
 * Terminal for whichever backend the main process selected, hiding the two
 * libraries' construction differences (WebGL addon vs WASM load) behind one
 * `create()` call. Runs inside the benchmark/PTY renderer pages
 * (nodeIntegration on, like VS Code's terminal renderer).
 *
 * The returned wrapper exposes exactly what the harnesses use:
 *   term         — the underlying Terminal (write/buffer/onData/onRender…)
 *   writeChunk() — backend-correct feed of one chunk, resolves when parsed
 *                  (see backends.js `syncWrite` for why they differ)
 */
/* eslint-env browser */
const path = require('path');

module.exports = async function create(backend, { cols, rows, fontSize, scrollback, container }) {
  if (backend.key === 'xterm') {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
    document.head.appendChild(link);
    const { Terminal } = require('@xterm/xterm');
    const { WebglAddon } = require('@xterm/addon-webgl');
    const term = new Terminal({
      cols, rows, scrollback,
      ...(fontSize ? { fontSize, fontFamily: 'Menlo, monospace', theme: { background: '#1e1e1e' } } : {})
    });
    term.open(container);
    const webgl = new WebglAddon();
    term.loadAddon(webgl);
    return {
      term,
      onContextLoss: (cb) => webgl.onContextLoss(cb),
      // xterm parses asynchronously; the write callback fires when the bytes
      // are actually parsed — awaiting it is the flow control.
      writeChunk: (chunk) => new Promise((resolve) => term.write(chunk, resolve))
    };
  }

  if (backend.key === 'ghostty-web') {
    // Browser context: self.location exists, so Ghostty.load()'s default
    // base64-WASM path works as designed. Renderer-level init only.
    const { Ghostty, Terminal } = require('ghostty-web');
    const ghostty = await Ghostty.load();
    const term = new Terminal({
      cols, rows, scrollback, ghostty,
      ...(fontSize ? { fontSize, fontFamily: 'Menlo, monospace', theme: { background: '#1e1e1e' } } : {})
    });
    term.open(container);
    return {
      term,
      onContextLoss: () => {},
      // ghostty-web's write() parses synchronously into WASM and defers the
      // callback to rAF (frame cadence, not parse completion) — awaiting it
      // per-chunk would benchmark the display refresh rate. Yield to the
      // event loop instead so rendering/IPC stay serviced, exactly like the
      // sync native-addon feed. MessageChannel, not setTimeout(0): chained
      // timeouts hit Chromium's nested-timer clamp (~4 ms) and would bill
      // ~0.6 s/MiB of pure timer wait to the parser.
      writeChunk: (() => {
        const mc = new MessageChannel();
        let pending = null;
        mc.port1.onmessage = () => { const r = pending; pending = null; if (r) r(); };
        return (chunk) => {
          term.write(chunk);
          return new Promise((resolve) => { pending = resolve; mc.port2.postMessage(null); });
        };
      })()
    };
  }

  throw new Error(`no DOM terminal factory for backend '${backend.key}'`);
};
