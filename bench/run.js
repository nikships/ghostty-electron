'use strict';
/**
 * Benchmark entry point. Suites against the current tree:
 *
 *   node bench/run.js flood [--runs N] [--repeat N]  DOM-terminal burst+sustained
 *
 * (The parser and PTY-race suites from earlier iterations were removed
 * with the move to full-ghostty embedding — they last exist at commit
 * 1a4357c. bench/engine-placement.js is standalone: `node bench/engine-placement.js`.)
 */
const suite = process.argv[2];

switch (suite) {
  case 'flood':
    require('./flood'); // spawns Electron per backend itself
    break;
  default:
    console.error('usage: node bench/run.js <flood> [suite flags]');
    process.exit(1);
}
