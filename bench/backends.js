'use strict';
/**
 * The terminal-backend registry — the single place a new terminal is added.
 *
 * The flood benchmark and the reporting pipeline iterate this list.
 * Currently only 'dom' backends exist: xterm.js-compatible libraries
 * rendering into the DOM of a Chromium renderer (constructed per-key
 * by bench/dom-terminal.js; write()/buffer/onData API assumed). The
 * native ghostty embedding is not yet re-integrated as a flood backend
 * (the pre-rewrite native backend last exists at commit 1a4357c).
 *
 * `resultKey` is the stable field name in results/*.json (the CI
 * summary reads it); `resultFile` is the per-backend flood output.
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
    syncWrite: true
  }
];

const byKey = (key) => {
  const b = BACKENDS.find((b) => b.key === key);
  if (!b) throw new Error(`unknown backend '${key}' — known: ${BACKENDS.map((b) => b.key).join(', ')}`);
  return b;
};

module.exports = { BACKENDS, byKey };
