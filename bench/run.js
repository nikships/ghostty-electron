'use strict';
/**
 * Benchmark entry point. Suites against the current tree:
 *
 *   node bench/run.js flood [--runs N] [--repeat N]   in-terminal flood,
 *       all three backends (xterm.js, ghostty-web, ghostty embedded)
 *   node bench/run.js pty [--mb N] [--runs N]         the PTY race:
 *       throughput + interrupt through a real zsh, VS Code's real
 *       flow-control constants for the DOM backends
 *   node bench/run.js pty --sweep                     issue-#10 watermark
 *       sweep: throughput-vs-interrupt at 4 HIGH points vs ghostty
 *
 * bench/engine-placement.js is standalone: `node bench/engine-placement.js`.
 * (The parser-only suite was removed with the move to full-ghostty
 * embedding; it lasts exists at commit 1a4357c.)
 */
const suite = process.argv[2];

switch (suite) {
  case 'flood':
    require('./flood'); // spawns Electron per backend itself
    break;
  case 'pty':
    require('./pty-race'); // spawns Electron per (backend, mode) itself
    break;
  default:
    console.error('usage: node bench/run.js <flood|pty> [suite flags]');
    process.exit(1);
}
