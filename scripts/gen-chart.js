'use strict';
/**
 * Generates the README benchmark chart as static SVGs (light + dark for
 * GitHub's <picture> prefers-color-scheme trick).
 *
 * Form: small multiples of paired horizontal bars — the four headline metrics
 * have different units, so each row carries its own scale; absolute values
 * are direct-labeled in text ink and the per-row ratio is annotated. All
 * rows carry three series (xterm.js, ghostty-web WASM, libghostty native)
 * from the unified bench/ harness; a row degrades to two if a backend has
 * no numbers on the platform that produced results/.
 * Palette: categorical slots validated for both GitHub surfaces (adjacent-pair
 * CVD ΔE ≥ 40; dark amber snapped to #bf8300 for the dark lightness band;
 * light-mode amber/aqua are sub-3:1, mitigated by the direct value labels).
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
    xterm: parse ? parse.xterm.MBps : 19.7,
    ghosttyWeb: parse ? parse.ghosttyWeb?.MBps : 58.4,
    ghostty: parse ? parse.ghostty.MBps : 237.2
  },
  {
    label: '10 MiB output flood, in-terminal',
    note: 'ms to final frame · lower is better',
    higherBetter: false,
    unit: ' ms',
    xterm: summary ? Math.round(summary.sustained.xterm.e2eMs) : 1200,
    ghosttyWeb: summary ? summary.sustained.ghosttyWeb && Math.round(summary.sustained.ghosttyWeb.e2eMs) : 968,
    ghostty: summary ? Math.round(summary.sustained.ghostty.e2eMs) : 66
  },
  {
    label: 'cat a 1 GiB file in a real shell (PTY)',
    note: 'seconds · lower is better · pipe-bound: node-pty ceiling ≈ 64 MB/s',
    higherBetter: false,
    unit: ' s',
    xterm: 55.4,
    ghosttyWeb: 20.3,
    ghostty: 25.6
  },
  {
    label: 'Ctrl+C response mid-flood',
    note: 'ms until prompt is back · lower is better',
    higherBetter: false,
    unit: ' ms',
    xterm: pty && pty.sizeMB > 500 ? pty.xterm.interruptMs : 1124,
    ghosttyWeb: pty && pty.sizeMB > 500 ? pty.ghosttyWeb?.interruptMs : 424,
    ghostty: pty && pty.sizeMB > 500 ? pty.ghostty.interruptMs : 47
  }
];

const THEMES = {
  light: { xterm: '#2a78d6', ghosttyWeb: '#eda100', ghostty: '#1baf7a', text: '#1f2328', secondary: '#59636e', track: '#d1d9e0' },
  dark: { xterm: '#3987e5', ghosttyWeb: '#bf8300', ghostty: '#199e70', text: '#e6edf3', secondary: '#9198a1', track: '#3d444d' }
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

// Series draw order per row: baseline first, native last. ghosttyWeb drops
// out of a row only when the platform that produced results/ couldn't run it.
const seriesFor = (row) => [
  { key: 'xterm', value: row.xterm },
  ...(row.ghosttyWeb != null ? [{ key: 'ghosttyWeb', value: row.ghosttyWeb }] : []),
  { key: 'ghostty', value: row.ghostty }
];

const rowHeight = (row) => ROW_H + (seriesFor(row).length - 2) * (BAR_H + BAR_GAP);

function render(theme) {
  const c = THEMES[theme];
  const font = `font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`;
  const parts = [];
  const H = TOP + ROWS.reduce((h, row) => h + rowHeight(row), 0) + 8;

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Benchmark comparison of xterm.js, ghostty-web (WASM), and libghostty in Electron">`);
  parts.push(`<text x="${LEFT}" y="24" ${font} font-size="15" font-weight="600" fill="${c.text}">xterm.js vs ghostty-web vs libghostty, all inside Electron</text>`);
  parts.push(`<text x="${LEFT}" y="42" ${font} font-size="12" fill="${c.secondary}">macOS, Apple Silicon @2x — same payloads, same grid, presentation-confirmed finish lines</text>`);

  // Legend (values are also direct-labeled on every bar).
  const legendX = W - 210;
  parts.push(`<rect x="${legendX}" y="8" width="10" height="10" rx="2" fill="${c.xterm}"/>`);
  parts.push(`<text x="${legendX + 16}" y="17" ${font} font-size="12" fill="${c.text}">xterm.js + WebGL</text>`);
  parts.push(`<rect x="${legendX}" y="26" width="10" height="10" rx="2" fill="${c.ghosttyWeb}"/>`);
  parts.push(`<text x="${legendX + 16}" y="35" ${font} font-size="12" fill="${c.text}">ghostty-web (WASM)</text>`);
  parts.push(`<rect x="${legendX}" y="44" width="10" height="10" rx="2" fill="${c.ghostty}"/>`);
  parts.push(`<text x="${legendX + 16}" y="53" ${font} font-size="12" fill="${c.text}">libghostty + sharedTexture</text>`);

  let y = TOP;
  for (const row of ROWS) {
    const series = seriesFor(row);
    const max = Math.max(...series.map((s) => s.value));
    // Headline ratio stays native-vs-xterm regardless of extra series.
    const ratio = row.higherBetter ? row.ghostty / row.xterm : row.xterm / row.ghostty;

    parts.push(`<text x="${LEFT}" y="${y + 12}" ${font} font-size="13" font-weight="600" fill="${c.text}">${esc(row.label)}</text>`);
    parts.push(`<text x="${LEFT}" y="${y + 27}" ${font} font-size="11" fill="${c.secondary}">${esc(row.note)}</text>`);

    const bY = y + 34;
    series.forEach((s, j) => {
      const w = Math.max(4, (s.value / max) * BAR_MAX);
      const sy = bY + j * (BAR_H + BAR_GAP);
      parts.push(bar(LEFT, sy, w, BAR_H, c[s.key]));
      parts.push(`<text x="${LEFT + w + 8}" y="${sy + BAR_H - 3}" ${font} font-size="12" fill="${c.text}">${s.value}${row.unit}</text>`);
    });

    const barsMid = bY + (series.length * BAR_H + (series.length - 1) * BAR_GAP) / 2;
    parts.push(`<text x="${W - LEFT}" y="${barsMid + 5}" ${font} font-size="14" font-weight="600" text-anchor="end" fill="${c.text}">${ratio.toFixed(ratio >= 10 ? 0 : 1)}×</text>`);
    y += rowHeight(row);
  }

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
