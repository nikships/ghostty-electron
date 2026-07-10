'use strict';
/**
 * Render the README hero chart (assets/benchmarks-light.svg + -dark.svg)
 * from the CURRENT harnesses' results:
 *   results/summary.json           (bench/run.js flood --runs N)
 *   results/pty-race-summary.json  (bench/run.js pty)
 *   results/pty-sweep.json         (bench/run.js pty --sweep) [panel 4]
 *
 * Every number on the chart is reproducible from HEAD — that's the
 * point (the previous hero chart cited harnesses that had been
 * deleted). Panels are small multiples with per-panel axes.
 *
 * Usage: node scripts/hero-chart.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'results', f), 'utf8'));

const flood = read('summary.json');
const pty = read('pty-race-summary.json');
let sweep = null;
try { sweep = read('pty-sweep.json'); } catch {}

// ── palette (dataviz reference instance; light + dark selected) ─────
const MODES = {
  light: {
    surface: '#fcfcfb', inkPrimary: '#0b0b0b', inkSecondary: '#52514e',
    muted: '#898781', grid: '#e1e0d9', baseline: '#c3c2b7',
    series: { xterm: '#2a78d6', ghosttyWeb: '#1baf7a', ghostty: '#eda100' },
  },
  dark: {
    surface: '#1a1a19', inkPrimary: '#ffffff', inkSecondary: '#c3c2b7',
    muted: '#898781', grid: '#2c2c2a', baseline: '#383835',
    series: { xterm: '#3987e5', ghosttyWeb: '#199e70', ghostty: '#c98500' },
  },
};
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
// key = flood summary field (resultKey); ptyKey = pty summary field
// (backend.key) where they differ.
const SERIES = [
  { key: 'xterm', label: 'xterm.js + WebGL (DOM)' },
  { key: 'ghosttyWeb', ptyKey: 'ghostty-web', label: 'ghostty-web WASM (DOM)' },
  { key: 'ghostty', label: 'ghostty embedded (Metal, via PTY)' },
];

const W = 920, PANEL_W = 410, PANEL_H = 190, GAP_X = 60, GAP_Y = 44;
const MARGIN = { top: 108, left: 30, bottom: 24 };
const BAR_H = 18, BAR_GAP = 10, LABEL_W = 46;

const fmt = (v) => v >= 1000 ? Math.round(v).toLocaleString('en-US')
  : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(0) : v.toFixed(1);

function render(mode) {
  const C = MODES[mode];
  let s = '';
  const text = (x, y, t, { size = 12, fill = C.inkSecondary, weight = 400, anchor = 'start' } = {}) => {
    const esc = String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    s += `<text x="${x}" y="${y}" font-family='${FONT}' font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${esc}</text>\n`;
  };

  const PANELS = [
    {
      title: 'In-terminal flood, 10 MiB sustained',
      unit: 'ms · lower is better',
      rows: SERIES.map(ser => ({
        key: ser.key,
        value: flood.sustained?.[ser.key]?.e2eMs,
      })).filter(r => r.value != null),
      note: 'bytes → last frame presented. ghostty row includes real-PTY overhead the DOM rows don\'t pay.',
    },
    {
      title: `PTY race: cat ${pty.mb} MiB through zsh`,
      unit: 'ms · lower is better',
      rows: SERIES.map(ser => ({
        key: ser.key,
        value: pty[ser.ptyKey ?? ser.key]?.catMs,
      })).filter(r => r.value != null),
      note: 'same shell, same finish line (sentinel visible). DOM flow control = VS Code\'s real constants.',
    },
    {
      title: 'Ctrl+C under flood → response visible',
      unit: 'ms · lower is better',
      rows: SERIES.map(ser => ({
        key: ser.key,
        value: pty[ser.ptyKey ?? ser.key]?.interruptMs,
      })).filter(r => r.value != null),
      note: 'how fast you get control back mid-flood.',
    },
  ];
  if (sweep) {
    PANELS.push({
      title: 'xterm.js watermark sweep (issue #10)',
      unit: 'interrupt ms at each HIGH watermark',
      rows: sweep.points.map(pt => ({
        key: 'xterm', label: pt.label, value: pt.interruptMs,
      })).concat([{ key: 'ghostty', label: 'ghostty (no knob)', value: sweep.ghostty.interruptMs }]),
      note: 'flow-control window size vs interrupt latency; throughput in results/pty-sweep.json.',
    });
  }

  const rowsMax = Math.max(...PANELS.map(p => p.rows.length));
  const panelH = Math.max(PANEL_H, 74 + rowsMax * (BAR_H + BAR_GAP) + 26);
  const H = MARGIN.top + 2 * panelH + GAP_Y + MARGIN.bottom;

  s += `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n`;
  s += `<rect width="${W}" height="${H}" fill="${C.surface}"/>\n`;

  text(MARGIN.left, 34, 'Terminal architectures in Electron, measured', { size: 18, fill: C.inkPrimary, weight: 600 });
  text(MARGIN.left, 54, 'Three engines, same Electron, same payloads, same finish line (frame presented). Reproducible from HEAD:', { size: 11.5 });
  text(MARGIN.left, 69, 'npm run bench · node bench/run.js pty [--sweep]. Apple Silicon @2x, medians.', { size: 11.5 });

  let lx = MARGIN.left;
  for (const ser of SERIES) {
    s += `<rect x="${lx}" y="${79}" width="10" height="10" rx="2" fill="${C.series[ser.key]}"/>\n`;
    text(lx + 15, 88, ser.label, { size: 11.5, fill: C.inkPrimary });
    lx += 15 + ser.label.length * 5.7 + 24;
  }

  PANELS.forEach((panel, pi) => {
    const px = MARGIN.left + (pi % 2) * (PANEL_W + GAP_X);
    const py = MARGIN.top + Math.floor(pi / 2) * (panelH + GAP_Y);
    const plotX = px + LABEL_W + 40, plotW = PANEL_W - LABEL_W - 40 - 76;

    text(px, py + 4, panel.title, { size: 12.5, fill: C.inkPrimary, weight: 600 });
    text(px, py + 19, panel.unit, { size: 10.5, fill: C.muted });

    const max = Math.max(...panel.rows.map(r => r.value));
    const xFor = (v) => plotX + (v / (max * 1.14)) * plotW;
    const y0 = py + 30;
    const yBot = y0 + panel.rows.length * (BAR_H + BAR_GAP) + 4;

    const step = max > 4000 ? 2000 : max > 1000 ? 1000 : max > 200 ? 100 : max > 50 ? 25 : 5;
    for (let v = step; v <= max * 1.14; v += step) {
      s += `<line x1="${xFor(v)}" y1="${y0}" x2="${xFor(v)}" y2="${yBot}" stroke="${C.grid}" stroke-width="1"/>\n`;
      text(xFor(v), yBot + 12, fmt(v), { size: 9.5, fill: C.muted, anchor: 'middle' });
    }
    s += `<line x1="${plotX}" y1="${y0}" x2="${plotX}" y2="${yBot}" stroke="${C.baseline}" stroke-width="1"/>\n`;

    panel.rows.forEach((r, ri) => {
      const y = y0 + 4 + ri * (BAR_H + BAR_GAP);
      const bw = Math.max(2, xFor(r.value) - plotX);
      s += `<path d="M ${plotX} ${y} h ${Math.max(0, bw - 4)} a 4 4 0 0 1 4 4 v ${BAR_H - 8} a 4 4 0 0 1 -4 4 h ${-Math.max(0, bw - 4)} z" fill="${C.series[r.key]}"/>\n`;
      const tag = r.label ?? SERIES.find(x => x.key === r.key).label.split(' ')[0];
      text(plotX - 8, y + BAR_H / 2 + 4, tag, { size: 10.5, fill: C.inkSecondary, anchor: 'end' });
      text(xFor(r.value) + 8, y + BAR_H / 2 + 4, `${fmt(r.value)}`, { size: 11.5, fill: C.inkPrimary, weight: 600 });
    });

    // wrapped footnote
    const words = panel.note.split(' ');
    let line = '', ly = yBot + 28;
    for (const w of words) {
      if ((line + ' ' + w).length > 74) {
        text(px, ly, line, { size: 9.5, fill: C.muted });
        ly += 12;
        line = w;
      } else line = line ? `${line} ${w}` : w;
    }
    if (line) text(px, ly, line, { size: 9.5, fill: C.muted });
  });

  s += '</svg>\n';
  return s;
}

fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
for (const mode of ['light', 'dark']) {
  const out = path.join(ROOT, 'assets', `benchmarks-${mode}.svg`);
  fs.writeFileSync(out, render(mode));
  console.log(`wrote ${out}`);
}
