'use strict';
// Generate a ~1MB payload that is "a lot of new lines": short lines, so the
// terminal must process a high rate of line feeds / grid scrolls — the classic
// `cat bigfile` stress that hammers the VT parser and the scroll path.
const fs = require('fs');
const path = require('path');

const TARGET_BYTES = 1024 * 1024; // 1 MiB
const out = path.join(__dirname, '..', 'payload.txt');

const chunks = [];
let bytes = 0;
let n = 0;
// Mix of line lengths, mostly short → newline-dense. Include some SGR color so
// the parser exercises escape sequences too (realistic log output).
while (bytes < TARGET_BYTES) {
  const kind = n % 8;
  let line;
  if (kind === 0) line = `\x1b[32m[${n}]\x1b[0m ok`;
  else if (kind === 3) line = `line ${n} ` + 'x'.repeat(n % 40);
  else if (kind === 6) line = `\x1b[1;31mERR\x1b[0m ${n}: something happened here`;
  else line = `${n}`;
  const withNl = line + '\n';
  chunks.push(withNl);
  bytes += Buffer.byteLength(withNl);
  n++;
}
const buf = Buffer.from(chunks.join(''), 'utf8');
fs.writeFileSync(out, buf);
const newlines = buf.filter(b => b === 0x0a).length;
console.log(`wrote ${out}: ${buf.length} bytes, ${newlines} newlines, ${n} lines (avg ${(buf.length / n).toFixed(1)} B/line)`);
