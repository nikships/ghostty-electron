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

const { mulberry32, makeTokens } = require('./fuzz-gen');

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

test('KNOWN DIVERGENCE (fuzz-found): DECOM homing after DECSTBM', async () => {
  // With origin mode on, DECSTBM homes the cursor to the region origin
  // (row 3 for a 4;16 region) and CPL clamps at the top margin — ghostty
  // does exactly that (matching DEC semantics / classic xterm). xterm.js
  // lands the cursor rows lower. Minimal repro found by fuzz seed 12.
  const stream = '\x1b[?6h\x1b[4;16r\x1b[2FMARK';
  const [g, x] = [ghosttyGrid(stream), await xtermGrid(stream)];
  assert.strictEqual(g[3], 'MARK', 'ghostty: clamped at region origin (row 3)');
  assert.strictEqual(x[6], 'MARK', 'xterm.js: lands at row 6');
});

for (let seed = 1; seed <= CASES; seed++) {
  test(`fuzz stream seed=${seed}`, async () => {
    const stream = makeTokens(mulberry32(seed), TOKENS_PER_CASE).join('');
    const [g, x] = [ghosttyGrid(stream, COLS, ROWS), await xtermGrid(stream, COLS, ROWS)];
    for (let i = 0; i < ROWS; i++) {
      assert.strictEqual(
        g[i], x[i],
        `seed ${seed}: row ${i} diverges\n ghostty: ${JSON.stringify(g[i])}\n xterm:   ${JSON.stringify(x[i])}\n stream: ${JSON.stringify(stream)}`);
    }
  });
}
