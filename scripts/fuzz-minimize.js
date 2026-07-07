'use strict';
/**
 * Delta-debug a divergent fuzz seed down to a minimal token sequence.
 * Usage: node scripts/fuzz-minimize.js <seed>
 */
const { ghosttyGrid, xtermGrid } = require('../test/helpers');
const { mulberry32, makeTokens, COLS, ROWS } = require('../test/fuzz-gen');

const seed = parseInt(process.argv[2], 10);
if (!seed) {
  console.error('usage: node scripts/fuzz-minimize.js <seed>');
  process.exit(1);
}

async function diverges(tokens) {
  const s = tokens.join('');
  const [g, x] = [ghosttyGrid(s, COLS, ROWS), await xtermGrid(s, COLS, ROWS)];
  return g.some((l, i) => l !== x[i]);
}

(async () => {
  let cur = makeTokens(mulberry32(seed), 120);
  if (!(await diverges(cur))) {
    console.log(`seed ${seed}: no divergence`);
    return;
  }
  // Greedy chunked removal, then single-token removal.
  for (const chunk of [32, 8, 1]) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i + chunk <= cur.length; i++) {
        const t = cur.slice(0, i).concat(cur.slice(i + chunk));
        if (await diverges(t)) { cur = t; changed = true; break; }
      }
    }
  }
  console.log(`seed ${seed} minimal tokens:`, JSON.stringify(cur));
  const s = cur.join('');
  const [g, x] = [ghosttyGrid(s, COLS, ROWS), await xtermGrid(s, COLS, ROWS)];
  for (let i = 0; i < ROWS; i++) {
    if (g[i] !== x[i]) console.log(`row ${i}: ghostty=${JSON.stringify(g[i])} xterm=${JSON.stringify(x[i])}`);
  }
})();
