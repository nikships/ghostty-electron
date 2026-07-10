'use strict';
/**
 * Render results/engine-placement-all.json as an SVG chart
 * (assets/engine-placement.svg): four small-multiple panels — the
 * metrics live on different scales, so each panel gets its own axis.
 * Two series (main / utility), 5-run dots over median bars.
 *
 * Usage: node scripts/engine-placement-chart.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const all = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'results', 'engine-placement-all.json'), 'utf8'));

const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ── palette (dataviz reference instance, light mode; validated) ─────
const C = {
  surface: '#fcfcfb',
  inkPrimary: '#0b0b0b',
  inkSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  series: { main: '#2a78d6', utility: '#1baf7a' }, // slots 1, 2
};
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

const PANELS = [
  {
    key: 'floodMs',
    title: 'Sustained flood, 100 MiB → presented',
    unit: 'ms',
    note: 'lower is better',
    value: (r) => r.floodMs,
  },
  {
    key: 'createBlockMs',
    title: 'Main process blocked at spawn',
    unit: 'ms',
    note: 'constructor, synchronous',
    value: (r) => r.createBlockMs,
  },
  {
    key: 'firstFrameMs',
    title: 'First frame presented',
    unit: 'ms',
    note: 'terminal create → pixels',
    value: (r) => r.firstFrameMs,
  },
  {
    key: 'lagP99',
    title: 'Main-loop lag during flood, p99',
    unit: 'ms',
    note: '10 ms timer overshoot',
    value: (r) => r.lag.p99,
  },
];

const SERIES = [
  { key: 'main', label: 'engine in main process' },
  { key: 'utility', label: 'engine in utilityProcess' },
];

// ── layout ──────────────────────────────────────────────────────────
const W = 920;
const PANEL_W = 410, PANEL_H = 150, PANEL_GAP_X = 60, PANEL_GAP_Y = 46;
const MARGIN = { top: 110, left: 30, bottom: 26 };
const H = MARGIN.top + 2 * PANEL_H + PANEL_GAP_Y + MARGIN.bottom;
const BAR_H = 22, BAR_GAP = 14;
const LABEL_W = 52; // series axis inset inside a panel

const fmt = (v) => v >= 100 ? Math.round(v).toLocaleString('en-US')
  : v >= 10 ? v.toFixed(0) : v.toFixed(1);

let s = '';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x, y, t, { size = 12, fill = C.inkSecondary, weight = 400, anchor = 'start' } = {}) => {
  s += `<text x="${x}" y="${y}" font-family='${FONT}' font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${esc(t)}</text>\n`;
};

s += `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n`;
s += `<rect width="${W}" height="${H}" fill="${C.surface}"/>\n`;

// title + subtitle
text(MARGIN.left, 34, 'Where should the terminal engine live?', { size: 18, fill: C.inkPrimary, weight: 600 });
text(MARGIN.left, 54, 'Same ghostty embedding, same zero-copy sharedTexture path — engine in the Electron main process vs a utilityProcess.', { size: 11.5 });
text(MARGIN.left, 69, 'Median of 5 interleaved runs (dots = individual runs), Apple Silicon @2x, Electron 42.', { size: 11.5 });

// legend
let lx = MARGIN.left;
const ly = 89;
for (const ser of SERIES) {
  s += `<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${C.series[ser.key]}"/>\n`;
  text(lx + 15, ly, ser.label, { size: 11.5, fill: C.inkPrimary });
  lx += 15 + ser.label.length * 5.6 + 26;
}

PANELS.forEach((panel, pi) => {
  const px = MARGIN.left + (pi % 2) * (PANEL_W + PANEL_GAP_X);
  const py = MARGIN.top + Math.floor(pi / 2) * (PANEL_H + PANEL_GAP_Y);
  const plotX = px + LABEL_W, plotW = PANEL_W - LABEL_W - 64;

  text(px, py + 4, panel.title, { size: 12.5, fill: C.inkPrimary, weight: 600 });
  text(px, py + 19, `${panel.unit} · ${panel.note}`, { size: 10.5, fill: C.muted });

  const values = {};
  for (const ser of SERIES) values[ser.key] = all[ser.key].map(panel.value);
  const max = Math.max(...SERIES.flatMap(ser => values[ser.key]));
  const xFor = (v) => plotX + (v / (max * 1.12)) * plotW;

  // gridlines: 3 clean ticks
  const step = max > 1000 ? 500 : max > 100 ? 100 : max > 10 ? 10 : 0.5;
  const y0 = py + 32, y1 = py + 32 + 2 * BAR_H + BAR_GAP + 18;
  for (let v = step; v <= max * 1.12; v += step) {
    const gx = xFor(v);
    s += `<line x1="${gx}" y1="${y0}" x2="${gx}" y2="${y1 - 14}" stroke="${C.grid}" stroke-width="1"/>\n`;
    text(gx, y1, fmt(v), { size: 9.5, fill: C.muted, anchor: 'middle' });
  }
  // baseline
  s += `<line x1="${plotX}" y1="${y0}" x2="${plotX}" y2="${y1 - 14}" stroke="${C.baseline}" stroke-width="1"/>\n`;

  SERIES.forEach((ser, si) => {
    const y = py + 36 + si * (BAR_H + BAR_GAP);
    const v = med(values[ser.key]);
    const bw = Math.max(2, xFor(v) - plotX);
    // bar: square at baseline, 4px rounded data end
    s += `<path d="M ${plotX} ${y} h ${bw - 4} a 4 4 0 0 1 4 4 v ${BAR_H - 8} a 4 4 0 0 1 -4 4 h ${-(bw - 4)} z" fill="${C.series[ser.key]}"/>\n`;
    // run dots: individual runs, surface ring for overlap legibility
    for (const rv of values[ser.key]) {
      s += `<circle cx="${xFor(rv)}" cy="${y + BAR_H / 2}" r="4" fill="${C.series[ser.key]}" stroke="${C.surface}" stroke-width="2"/>\n`;
    }
    // series tag + value label (text tokens, never series color)
    text(px + LABEL_W - 8, y + BAR_H / 2 + 4, ser.key === 'main' ? 'main' : 'utility', { size: 11, fill: C.inkSecondary, anchor: 'end' });
    text(xFor(Math.max(v, Math.max(...values[ser.key]))) + 8, y + BAR_H / 2 + 4, `${fmt(v)} ${panel.unit}`, { size: 11.5, fill: C.inkPrimary, weight: 600 });
  });
});

s += '</svg>\n';

fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
const out = path.join(ROOT, 'assets', 'engine-placement.svg');
fs.writeFileSync(out, s);
console.log(`wrote ${out}`);
