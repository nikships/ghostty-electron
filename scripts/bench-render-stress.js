'use strict';
/**
 * Render-stress: is the CPU rasterizer fast enough, or does the ghostty side
 * need a GPU renderer?
 *
 * Worst case by construction: a 4K-equivalent surface (240×67 cells @2x ≈
 * 3840×2144 px) with EVERY cell changing EVERY frame (full-screen damage,
 * mixed colors) — no dirty-row savings, the renderer's absolute worst case.
 * Reports full redraws/sec vs the 120 Hz frame budget.
 *
 * macOS only (drives the native renderer directly, no Electron needed).
 */
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
  console.error('render-stress drives the macOS renderer.');
  process.exit(1);
}

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));

const COLS = 240;
const ROWS = 67;
const FRAMES = 120;

const t = addon.create(COLS, ROWS, 13, 2);
console.log(`surface: ${t.width}×${t.height} px (${COLS}×${ROWS} cells @2x)`);

// Two alternating full screens of styled text so every cell changes each
// frame and glyph runs break on color boundaries (realistic worst case).
function fullScreen(phase) {
  const parts = ['\x1b[H'];
  for (let r = 0; r < ROWS; r++) {
    const color = 31 + ((r + phase) % 6);
    parts.push(`\x1b[${color}m`);
    let line = '';
    for (let c = 0; c < COLS; c++) line += String.fromCharCode(33 + ((r + c + phase * 7) % 90));
    parts.push(line);
    if (r < ROWS - 1) parts.push('\r\n');
  }
  return Buffer.from(parts.join(''), 'utf8');
}
const screens = [fullScreen(0), fullScreen(1)];

// Warm-up.
for (let i = 0; i < 5; i++) {
  addon.write(t.session, screens[i % 2]);
  addon.render(t.session);
}

let totalRenderMs = 0;
let rowsDrawn = 0;
const t0 = performance.now();
for (let i = 0; i < FRAMES; i++) {
  addon.write(t.session, screens[i % 2]);
  const f = addon.render(t.session);
  totalRenderMs += f.renderMs;
  rowsDrawn += f.rowsDrawn;
}
const wallMs = performance.now() - t0;

const out = {
  mode: 'render-stress',
  surfacePx: { width: t.width, height: t.height },
  cells: COLS * ROWS,
  frames: FRAMES,
  avgRowsDrawnPerFrame: +(rowsDrawn / FRAMES).toFixed(1),
  avgRenderMs: +(totalRenderMs / FRAMES).toFixed(2),
  fullRedrawsPerSec: +(FRAMES / (totalRenderMs / 1000)).toFixed(1),
  wallMsIncludingParse: +wallMs.toFixed(0),
  budget120HzMs: 8.3,
  verdict: totalRenderMs / FRAMES < 8.3
    ? 'CPU rasterizer holds 120Hz at 4K full damage'
    : 'GPU renderer needed for 120Hz at 4K full damage',
  platform: process.platform,
  arch: process.arch
};

console.log(`full-damage frames: ${FRAMES} — avg render ${out.avgRenderMs} ms ` +
            `(${out.fullRedrawsPerSec}/s) vs 120Hz budget 8.3 ms`);
console.log(`verdict: ${out.verdict}`);

const resultsDir = path.join(__dirname, '..', 'results');
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, 'render-stress.json'), JSON.stringify(out, null, 2));
