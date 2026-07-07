'use strict';
/**
 * Generates the README benchmark chart as static SVGs (light + dark for
 * GitHub's <picture> prefers-color-scheme trick).
 *
 * Form: small multiples of paired horizontal bars — the four headline metrics
 * have different units, so each row carries its own scale; absolute values
 * are direct-labeled in text ink and the per-row ratio is annotated.
 * Palette: categorical slots 1–2 (validated for both GitHub surfaces;
 * light-mode aqua is sub-3:1, mitigated by the direct value labels).
 *
 * Data comes from results/*.json when present, else the checked-in numbers
 * from the runs documented in the README.
 */
const fs = require('fs');
const path = require('path');

const read = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'results', f), 'utf8')); }
  catch { return null; }
};

const parse = read('parse.json');
const summary = read('summary.json');
const pty = read('pty-bench.json');

const ROWS = [
  {
    label: 'VT parser throughput',
    note: 'MB/s · higher is better',
    higherBetter: true,
    unit: ' MB/s',
    xterm: parse ? parse.xterm.MBps : 20.1,
    ghostty: parse ? parse.ghostty.MBps : 219.3
  },
  {
    label: '10 MiB output flood, in-terminal',
    note: 'ms to final frame · lower is better',
    higherBetter: false,
    unit: ' ms',
    xterm: summary ? Math.round(summary.sustained.xterm.e2eMs) : 1183,
    ghostty: summary ? Math.round(summary.sustained.ghostty.e2eMs) : 65
  },
  {
    label: 'cat a 1 GiB file in a real shell (PTY)',
    note: 'seconds · lower is better',
    higherBetter: false,
    unit: ' s',
    xterm: 54.9,
    ghostty: 24.6
  },
  {
    label: 'Ctrl+C response mid-flood',
    note: 'ms until prompt is back · lower is better',
    higherBetter: false,
    unit: ' ms',
    xterm: pty && pty.sizeMB > 500 ? pty.xterm.interruptMs : 1007,
    ghostty: pty && pty.sizeMB > 500 ? pty.ghostty.interruptMs : 48
  }
];

const THEMES = {
  light: { xterm: '#2a78d6', ghostty: '#1baf7a', text: '#1f2328', secondary: '#59636e', track: '#d1d9e0' },
  dark: { xterm: '#3987e5', ghostty: '#199e70', text: '#e6edf3', secondary: '#9198a1', track: '#3d444d' }
};

const W = 760;
const BAR_MAX = 430;
const BAR_H = 13;
const BAR_GAP = 2;
const ROW_H = 74;
const LEFT = 24;
const TOP = 56;

/** Rect with only the data-end (right side) rounded, baseline square. */
function bar(x, y, w, h, fill) {
  const r = Math.min(4, w);
  return `<path d="M${x} ${y} h${w - r} a${r} ${r} 0 0 1 ${r} ${r} v${h - 2 * r} a${r} ${r} 0 0 1 -${r} ${r} h-${w - r} z" fill="${fill}"/>`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function render(theme) {
  const c = THEMES[theme];
  const font = `font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`;
  const parts = [];
  const H = TOP + ROWS.length * ROW_H + 8;

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Benchmark comparison of xterm.js and libghostty in Electron">`);
  parts.push(`<text x="${LEFT}" y="24" ${font} font-size="15" font-weight="600" fill="${c.text}">xterm.js vs libghostty, both inside Electron</text>`);
  parts.push(`<text x="${LEFT}" y="42" ${font} font-size="12" fill="${c.secondary}">macOS, Apple Silicon @2x — same payloads, same grid, presentation-confirmed finish lines</text>`);

  // Legend (two series → always present; values are also direct-labeled).
  const legendX = W - 210;
  parts.push(`<rect x="${legendX}" y="14" width="10" height="10" rx="2" fill="${c.xterm}"/>`);
  parts.push(`<text x="${legendX + 16}" y="23" ${font} font-size="12" fill="${c.text}">xterm.js + WebGL</text>`);
  parts.push(`<rect x="${legendX}" y="32" width="10" height="10" rx="2" fill="${c.ghostty}"/>`);
  parts.push(`<text x="${legendX + 16}" y="41" ${font} font-size="12" fill="${c.text}">libghostty + sharedTexture</text>`);

  ROWS.forEach((row, i) => {
    const y = TOP + i * ROW_H;
    const max = Math.max(row.xterm, row.ghostty);
    const wX = Math.max(4, (row.xterm / max) * BAR_MAX);
    const wG = Math.max(4, (row.ghostty / max) * BAR_MAX);
    const ratio = row.higherBetter ? row.ghostty / row.xterm : row.xterm / row.ghostty;

    parts.push(`<text x="${LEFT}" y="${y + 12}" ${font} font-size="13" font-weight="600" fill="${c.text}">${esc(row.label)}</text>`);
    parts.push(`<text x="${LEFT}" y="${y + 27}" ${font} font-size="11" fill="${c.secondary}">${esc(row.note)}</text>`);

    const bY = y + 34;
    parts.push(bar(LEFT, bY, wX, BAR_H, c.xterm));
    parts.push(`<text x="${LEFT + wX + 8}" y="${bY + BAR_H - 3}" ${font} font-size="12" fill="${c.text}">${row.xterm}${row.unit}</text>`);
    parts.push(bar(LEFT, bY + BAR_H + BAR_GAP, wG, BAR_H, c.ghostty));
    parts.push(`<text x="${LEFT + wG + 8}" y="${bY + 2 * BAR_H + BAR_GAP - 3}" ${font} font-size="12" fill="${c.text}">${row.ghostty}${row.unit}</text>`);

    parts.push(`<text x="${W - LEFT}" y="${bY + BAR_H + 2}" ${font} font-size="14" font-weight="600" text-anchor="end" fill="${c.text}">${ratio.toFixed(ratio >= 10 ? 0 : 1)}×</text>`);
  });

  parts.push('</svg>');
  return parts.join('\n');
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const theme of ['light', 'dark']) {
  const file = path.join(outDir, `benchmarks-${theme}.svg`);
  fs.writeFileSync(file, render(theme));
  console.log('wrote', file);
}
