'use strict';
/**
 * The terminal-backend registry — the single place a new terminal is added.
 *
 * Every benchmark surface (parse, flood, pty race/latency/soak) and the
 * reporting pipeline iterates this list. A backend is either:
 *
 *   kind 'dom'    — an xterm.js-compatible library rendering into the DOM of
 *                   a Chromium renderer (constructed per-key by
 *                   bench/dom-terminal.js; write()/buffer/onData API assumed).
 *   kind 'native' — parses in the main process, presents via sharedTexture
 *                   (bespoke: wired explicitly where `kind === 'native'`).
 *
 * `resultKey` is the field name in every results/*.json (must stay stable —
 * compare-results.js diffs it against previous CI runs); `resultFile` is the
 * per-backend flood output.
 *
 * DOM quirk flags:
 *   syncWrite — write() parses synchronously and the completion callback is
 *               rAF-deferred (ghostty-web): feed with sync write + event-loop
 *               yield, and ack flow control immediately after write returns.
 *               xterm.js parses async and fires the callback when the bytes
 *               are actually parsed: await it (that IS its backpressure).
 */
const BACKENDS = [
  {
    key: 'xterm',
    resultKey: 'xterm',
    resultFile: 'xterm.json',
    name: 'xterm.js + WebGL (in-renderer DOM)',
    kind: 'dom',
    syncWrite: false
  },
  {
    key: 'ghostty-web',
    resultKey: 'ghosttyWeb',
    resultFile: 'ghostty-web.json',
    name: 'ghostty-web WASM (in-renderer DOM)',
    kind: 'dom',
    syncWrite: true,
    // Measured and reported in the leak soak, but not part of its pass/fail
    // gate: the WASM heap's growth (~30 MB/min on a CI 2-min soak) is
    // upstream ghostty-web behavior, and the gate exists to catch leaks in
    // THIS repo's native code, not to break CI on a third-party library.
    soakGate: false
  }
];

const byKey = (key) => {
  const b = BACKENDS.find((b) => b.key === key);
  if (!b) throw new Error(`unknown backend '${key}' — known: ${BACKENDS.map((b) => b.key).join(', ')}`);
  return b;
};

module.exports = { BACKENDS, byKey };
