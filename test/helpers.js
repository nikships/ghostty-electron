'use strict';
/** Shared grid extraction for conformance/fuzz tests: feed identical bytes
 *  to libghostty-vt and @xterm/headless, return viewport text lines. */
const path = require('path');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));
const { Terminal } = require('@xterm/headless');

// Both grids are right-trimmed: xterm's translateToString(true) preserves
// explicitly *written* trailing spaces while ghostty's getText trims them —
// a buffer-representation difference, not an emulation one. Comparisons are
// over visible content.
const trimEnd = (l) => l.replace(/ +$/, '');

function ghosttyGrid(input, cols = 80, rows = 24) {
  const t = addon.create(cols, rows, 13, 1);
  addon.write(t.session, Buffer.from(input, 'utf8'));
  return addon.getText(t.session).map(trimEnd);
}

async function xtermGrid(input, cols = 80, rows = 24) {
  const term = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  await new Promise((resolve) => term.write(input, resolve));
  const lines = [];
  const buf = term.buffer.active;
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    lines.push(line ? trimEnd(line.translateToString(true)) : '');
  }
  term.dispose();
  return lines;
}

module.exports = { addon, ghosttyGrid, xtermGrid };
