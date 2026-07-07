'use strict';
// npm strips the exec bit from node-pty's prebuilt spawn-helper on unix.
const fs = require('fs');
const path = require('path');

if (process.platform === 'win32') process.exit(0);

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
try {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch {
  // node-pty not installed yet (e.g. --omit=dev) — nothing to fix
}
