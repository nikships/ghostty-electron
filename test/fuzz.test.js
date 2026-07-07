'use strict';
/**
 * Fuzz conformance: seeded random VT streams into both emulators, grids
 * diffed row-by-row. Every stream is reproducible from its seed; on failure
 * the seed and the escaped stream are printed.
 *
 * Token set is the VT vocabulary both emulators implement (verified by this
 * very suite): if a new token class diverges, either it's a bug worth
 * reporting or an intentional emulator difference worth documenting.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { ghosttyGrid, xtermGrid } = require('./helpers');

const COLS = 80;
const ROWS = 24;
const CASES = 40;
const TOKENS_PER_CASE = 120;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeStream(rnd) {
  const int = (n) => Math.floor(rnd() * n);
  const pick = (arr) => arr[int(arr.length)];
  const generators = [
    // plain text runs
    () => Array.from({ length: 1 + int(20) }, () => pick('abcdefgh XYZ0123._-'.split(''))).join(''),
    () => '\r\n',
    () => '\r',
    () => '\n',
    () => '\t',
    // absolute + relative cursor movement
    () => `\x1b[${1 + int(ROWS)};${1 + int(COLS)}H`,
    () => `\x1b[${1 + int(5)}${pick(['A', 'B', 'C', 'D'])}`,
    // SGR
    () => `\x1b[${pick(['0', '1', '4', '7', '22', '24', '27'])}m`,
    () => `\x1b[${30 + int(8)}m`,
    () => `\x1b[${40 + int(8)}m`,
    () => `\x1b[38;5;${int(256)}m`,
    () => `\x1b[38;2;${int(256)};${int(256)};${int(256)}m`,
    // erase
    () => `\x1b[${int(3)}J`,
    () => `\x1b[${int(3)}K`,
    // scroll region set/reset and explicit scroll
    () => {
      const top = 1 + int(ROWS - 2);
      return `\x1b[${top};${top + 1 + int(ROWS - top - 1)}r`;
    },
    () => '\x1b[r',
    () => `\x1b[${1 + int(3)}S`,
    () => `\x1b[${1 + int(3)}T`,
    // wide characters
    () => pick(['你好', '漢字', 'テスト']),
    // NOTE: DECSC/DECRC (ESC 7 / ESC 8) are deliberately absent: fuzzing
    // found a real divergence when restoring across a DECSTBM scroll — see
    // the pinned "known divergence" test below.
    // insert/delete lines & chars
    () => `\x1b[${1 + int(3)}L`,
    () => `\x1b[${1 + int(3)}M`,
    () => `\x1b[${1 + int(5)}P`,
    () => `\x1b[${1 + int(5)}@`,
  ];
  let out = '';
  for (let i = 0; i < TOKENS_PER_CASE; i++) out += pick(generators)();
  return out;
}

test('KNOWN DIVERGENCE (fuzz-found): DECRC after scroll inside DECSTBM', async () => {
  // Save cursor on row 1, set a scroll region, scroll it once at the bottom
  // margin, restore. ghostty restores the *absolute* saved row (row 1);
  // xterm.js restores one row higher, following the scrolled content.
  // Neither is obviously wrong (DEC STD-070 says absolute; xterm.js tracks
  // buffer lines) — pinned so a behavior change in either emulator surfaces.
  const stream = '\n\x1b7\x1b[1;21r\x1b[21;50H\r\n\x1b8MARK';
  const [g, x] = [ghosttyGrid(stream), await xtermGrid(stream)];
  assert.strictEqual(g[1], 'MARK', 'ghostty: absolute restore to row 1');
  assert.strictEqual(x[0], 'MARK', 'xterm.js: scroll-adjusted restore to row 0');
});

for (let seed = 1; seed <= CASES; seed++) {
  test(`fuzz stream seed=${seed}`, async () => {
    const stream = makeStream(mulberry32(seed));
    const [g, x] = [ghosttyGrid(stream, COLS, ROWS), await xtermGrid(stream, COLS, ROWS)];
    for (let i = 0; i < ROWS; i++) {
      assert.strictEqual(
        g[i], x[i],
        `seed ${seed}: row ${i} diverges\n ghostty: ${JSON.stringify(g[i])}\n xterm:   ${JSON.stringify(x[i])}\n stream: ${JSON.stringify(stream)}`);
    }
  });
}
