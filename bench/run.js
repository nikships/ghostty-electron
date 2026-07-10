'use strict';
/**
 * Unified benchmark entry point. One app, every suite, every backend in
 * bench/backends.js:
 *
 *   node bench/run.js parse [--mb N] [--runs N]        parser-only, no GUI
 *   node bench/run.js flood [--runs N] [--repeat N]    in-terminal burst+sustained
 *   node bench/run.js pty   [--mb N] [...]             the PTY race (Electron)
 *   node bench/run.js pty --latency                    input-latency probe
 *   node bench/run.js pty --soak-min N                 leak soak
 *
 * parse runs in this plain-Node process; flood/pty spawn Electron.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const suite = process.argv[2];
const rest = process.argv.slice(3);

const electronize = (entry) => {
  const electron = require('electron');
  const r = spawnSync(electron, [path.join(__dirname, entry), ...rest], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
};

switch (suite) {
  case 'flood':
    require('./flood'); // spawns Electron per backend itself
    break;
  default:
    console.error('usage: node bench/run.js <flood> [suite flags]');
    process.exit(1);
}
