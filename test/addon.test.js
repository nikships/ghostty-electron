'use strict';
/**
 * Native addon tests — run in plain Node (no Electron/GUI needed).
 * Validates terminal state, pixel output (via readPixels), cursor, dirty
 * tracking, scrollback, resize, and mode-aware key encoding.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));

function makeTerm(cols = 80, rows = 24, fontSize = 13, scale = 2) {
  return addon.create(cols, rows, fontSize, scale);
}

// Rendering exists where a platform producer is built (macOS IOSurface,
// Windows D3D11); VT state, text readout, key encoding and selection are
// cross-platform everywhere.
const RENDER = typeof addon.render === 'function' ? {} : { skip: 'no platform renderer' };

function write(t, s) {
  addon.write(t.session, Buffer.from(s, 'utf8'));
}

/** Count pixels in a cell-rect matching an rgb predicate. Pixels are BGRA. */
function countPixels(t, pixels, col, row, predicate) {
  const cw = Math.round(t.cellWidth);
  const ch = Math.round(t.cellHeight);
  let count = 0;
  for (let y = row * ch; y < (row + 1) * ch; y++) {
    for (let x = col * cw; x < (col + 1) * cw; x++) {
      const i = (y * pixels.width + x) * 4;
      const b = pixels.data[i], g = pixels.data[i + 1], r = pixels.data[i + 2];
      if (predicate(r, g, b)) count++;
    }
  }
  return count;
}

test('create returns HiDPI-scaled dimensions', () => {
  const t1 = makeTerm(80, 24, 13, 1);
  const t2 = makeTerm(80, 24, 13, 2);
  assert.ok(Math.abs(t2.cellWidth - 2 * t1.cellWidth) <= 1, `2x cell width (${t2.cellWidth} vs ${t1.cellWidth})`);
  assert.strictEqual(t2.width, Math.round(t2.cellWidth) * 80);
  assert.strictEqual(t2.height, Math.round(t2.cellHeight) * 24);
});

test('getText reflects written content', () => {
  const t = makeTerm();
  write(t, 'hello\r\nworld');
  const lines = addon.getText(t.session);
  assert.strictEqual(lines.length, 24);
  assert.strictEqual(lines[0], 'hello');
  assert.strictEqual(lines[1], 'world');
  assert.strictEqual(lines[2], '');
});

test('render produces frames only when dirty', RENDER, () => {
  const t = makeTerm();
  write(t, 'hi');
  const f1 = addon.render(t.session);
  assert.ok(f1, 'first render returns a frame');
  assert.strictEqual(f1.handle.length, 8, 'IOSurfaceRef pointer');
  assert.ok(f1.rowsDrawn > 0);

  const f2 = addon.render(t.session);
  assert.strictEqual(f2, null, 'clean state renders nothing');

  write(t, ' more');
  assert.ok(addon.render(t.session), 'dirty again after write');
});

test('red SGR text produces red pixels in the right cell', RENDER, () => {
  const t = makeTerm();
  write(t, '\x1b[31mMMMM\x1b[0m');
  addon.render(t.session);
  const px = addon.readPixels(t.session);
  assert.strictEqual(px.width, t.width);

  const red = countPixels(t, px, 0, 0, (r, g, b) => r > 120 && g < 80 && b < 80);
  assert.ok(red > 5, `expected red pixels in cell (0,0), got ${red}`);
  const redElsewhere = countPixels(t, px, 10, 5, (r, g, b) => r > 120 && g < 80 && b < 80);
  assert.strictEqual(redElsewhere, 0, 'no red pixels in an empty cell');
});

test('background color fills cell', RENDER, () => {
  const t = makeTerm();
  write(t, '\x1b[44m  \x1b[0m'); // blue background, two cells
  addon.render(t.session);
  const px = addon.readPixels(t.session);
  // Theme-agnostic: blue-dominant and clearly not the default background.
  const blue = countPixels(t, px, 0, 0, (r, g, b) => b > 120 && b > r + 30);
  const cellArea = Math.round(t.cellWidth) * Math.round(t.cellHeight);
  assert.ok(blue > cellArea * 0.9, `bg should fill the cell (${blue}/${cellArea})`);
});

test('block cursor is drawn', RENDER, () => {
  const t = makeTerm();
  write(t, 'ab');
  const cur = addon.getCursor(t.session);
  assert.deepStrictEqual({ x: cur.x, y: cur.y, visible: cur.visible }, { x: 2, y: 0, visible: true });

  addon.render(t.session);
  const px = addon.readPixels(t.session);
  // Block cursor = cell filled with foreground color (bright pixels).
  const bright = countPixels(t, px, 2, 0, (r, g, b) => r > 150 && g > 150 && b > 150);
  const cellArea = Math.round(t.cellWidth) * Math.round(t.cellHeight);
  assert.ok(bright > cellArea * 0.8, `cursor block should fill cell (${bright}/${cellArea})`);
  // The cell after the cursor is plain background.
  const brightAfter = countPixels(t, px, 3, 0, (r, g, b) => r > 150 && g > 150 && b > 150);
  assert.strictEqual(brightAfter, 0);
});

test('cursor movement dirties old and new rows', RENDER, () => {
  const t = makeTerm();
  write(t, 'line1\r\nline2\r\nline3');
  addon.render(t.session);
  write(t, 'x'); // warm the second surface
  addon.render(t.session);
  write(t, 'x');
  addon.render(t.session); // both surfaces now warm and closely in sync

  write(t, '\x1b[1;1H'); // move cursor from row 2 to row 0, no content change
  const f = addon.render(t.session);
  assert.ok(f, 'cursor move alone must produce a frame');
  assert.ok(f.rowsDrawn >= 2 && f.rowsDrawn <= 4, `only cursor rows redraw (got ${f.rowsDrawn})`);
});

test('dirty-row tracking survives double buffering', RENDER, () => {
  const t = makeTerm();
  // Fill all rows.
  for (let i = 0; i < 24; i++) write(t, `row ${i}\r\n`);
  addon.render(t.session);
  write(t, '\x1b[1;1HX');
  addon.render(t.session); // surface B: first render → full redraw is fine
  write(t, '\x1b[2;1HY');
  const f = addon.render(t.session); // surface A: should only redraw touched rows
  assert.ok(f.rowsDrawn < 24, `incremental redraw expected (got ${f.rowsDrawn}/24)`);
});

// Regression: a non-ASCII cell goes through the CTLine path, which mutates the
// context text matrix. If it isn't reset, the batched CTFontDrawGlyphs runs for
// every LATER row draw off-surface and render blank — htop's process list and
// F-bar buttons showed as empty until an unrelated repaint (the "blank buttons"
// bug). A non-ASCII glyph on row 0 must not suppress ASCII text on row 5.
test('non-ASCII glyph does not blank later rows (text-matrix leak)', RENDER, () => {
  const t = makeTerm();
  write(t, '▽');               // row 0: ▽ (non-ASCII → CTLine path)
  write(t, '\x1b[6;1H\x1b[37mMMMM'); // row 5: white ASCII text via batched path
  addon.render(t.session);
  const px = addon.readPixels(t.session);
  const light = countPixels(t, px, 1, 5, (r, g, b) => r > 150 && g > 150 && b > 150);
  assert.ok(light > 5, `row 5 ASCII text must render after a non-ASCII cell (got ${light} light px)`);
});

test('scrollback: wheel scrolling moves the viewport', () => {
  const t = makeTerm(80, 24);
  for (let i = 1; i <= 50; i++) write(t, `line-${i}\r\n`);
  let lines = addon.getText(t.session);
  assert.strictEqual(lines[0], 'line-28', 'viewport at bottom'); // 50 lines + prompt row, 24 visible

  addon.scroll(t.session, -10);
  lines = addon.getText(t.session);
  assert.strictEqual(lines[0], 'line-18', 'scrolled up 10 rows');

  addon.scroll(t.session, 1000);
  lines = addon.getText(t.session);
  assert.strictEqual(lines[0], 'line-28', 'clamped back to bottom');
});

test('resize changes grid and surface dimensions', () => {
  const t = makeTerm(80, 24);
  write(t, 'before resize');
  const dims = addon.resize(t.session, 100, 30);
  assert.strictEqual(dims.width, Math.round(t.cellWidth) * 100);
  assert.strictEqual(dims.height, Math.round(t.cellHeight) * 30);

  const lines = addon.getText(t.session);
  assert.strictEqual(lines.length, 30);
  assert.strictEqual(lines[0], 'before resize', 'content survives resize');

  if (typeof addon.render === 'function') {
    const f = addon.render(t.session);
    assert.ok(f, 'resize forces a present');
    assert.strictEqual(f.width, dims.width);
  }
});

test('wide characters occupy two cells', () => {
  const t = makeTerm();
  write(t, '你好');
  const lines = addon.getText(t.session);
  assert.strictEqual(lines[0], '你好');
  const cur = addon.getCursor(t.session);
  assert.strictEqual(cur.x, 4, 'two wide chars advance cursor by 4');
});

test('incremental rendering is pixel-identical to a full redraw', RENDER, () => {
  // Any divergence means a frame depends on redraw history instead of grid
  // state — the bug class behind corrupted TUIs (glyph bleed, dirty misses).
  const COLS = 60, ROWS = 10;
  const scenarios = {
    scroll: Array.from({ length: 30 }, (_, i) => `scroll line ${i}\r\n`),
    spinner: Array.from({ length: 20 }, (_, i) => `\x1b[5;10H(${i % 10}s . ${i * 7} tokens)`),
    'altscreen-tui': [
      '\x1b[?1049h\x1b[2J\x1b[H',
      '\x1b[1;1H╭' + '─'.repeat(COLS - 2) + '╮',
      ...Array.from({ length: ROWS - 2 }, (_, i) => `\x1b[${i + 2};1H│\x1b[${i + 2};${COLS}H│`),
      `\x1b[${ROWS};1H╰` + '─'.repeat(COLS - 2) + '╯',
      ...Array.from({ length: 15 }, (_, i) => `\x1b[3;20H(${i}s . ${i * 13} tokens)   `),
      '\x1b[5;5H\x1b[Kupdated content here'
    ],
    'erase-rewrite': ['a\r\nb\r\nc\r\n', '\x1b[2;1H\x1b[2Kreplaced\x1b[1;1H', '\x1b[2J\x1b[Hfresh\r\n'],
    'scroll-region': ['\x1b[1;8r\x1b[8;1H', ...Array.from({ length: 20 }, (_, i) => `region ${i}\r\n`), '\x1b[r\x1b[10;1Hstatus']
  };

  for (const [name, bursts] of Object.entries(scenarios)) {
    const inc = addon.create(COLS, ROWS, 13, 1);
    let all = '';
    for (const b of bursts) {
      all += b;
      addon.write(inc.session, Buffer.from(b, 'utf8'));
      addon.render(inc.session);
    }
    addon.render(inc.session);

    const ref = addon.create(COLS, ROWS, 13, 1);
    addon.write(ref.session, Buffer.from(all, 'utf8'));
    addon.render(ref.session);

    const a = addon.readPixels(inc.session);
    const b = addon.readPixels(ref.session);
    assert.deepStrictEqual(a.data.equals(b.data), true, `${name}: incremental != full redraw`);
  }
});

test('box drawing renders as geometry (aligned lines)', RENDER, () => {
  const t = makeTerm();
  write(t, '─│█');
  addon.render(t.session);
  const px = addon.readPixels(t.session);
  const cw = Math.round(t.cellWidth), ch = Math.round(t.cellHeight);
  const isFg = (r, g, b) => r > 120 && g > 120 && b > 120;

  // '─' paints the middle row of cell 0 edge-to-edge, nothing at the top.
  const midRow = Math.floor(ch / 2);
  let mid = 0, top = 0;
  for (let x = 0; x < cw; x++) {
    let i = (midRow * px.width + x) * 4;
    if (isFg(px.data[i + 2], px.data[i + 1], px.data[i])) mid++;
    i = (1 * px.width + x) * 4;
    if (isFg(px.data[i + 2], px.data[i + 1], px.data[i])) top++;
  }
  assert.strictEqual(mid, cw, 'horizontal line spans full cell width');
  assert.strictEqual(top, 0, 'no pixels at cell top');

  // '│' spans the full cell height at cell 1's center column.
  const centerX = cw + Math.floor(cw / 2);
  let vert = 0;
  for (let y = 0; y < ch; y++) {
    const i = (y * px.width + centerX) * 4;
    if (isFg(px.data[i + 2], px.data[i + 1], px.data[i])) vert++;
  }
  assert.strictEqual(vert, ch, 'vertical line spans full cell height');

  // '█' fills cell 2 completely.
  const full = countPixels(t, px, 2, 0, isFg);
  assert.strictEqual(full, cw * ch, 'full block fills the cell');
});

test('selection: set, render inverted, extract text, clear', RENDER, () => {
  const t = makeTerm();
  write(t, 'hello world\r\nsecond line');

  addon.setSelection(t.session, 0, 0, 4, 0); // "hello"
  assert.strictEqual(addon.getSelectionText(t.session), 'hello');

  addon.render(t.session);
  const px = addon.readPixels(t.session);
  // Selected cell bg becomes the (bright) foreground color.
  const cellArea = Math.round(t.cellWidth) * Math.round(t.cellHeight);
  const bright = countPixels(t, px, 1, 0, (r, g, b) => r > 120 && g > 120 && b > 120);
  assert.ok(bright > cellArea * 0.5, `selected cell is inverted (${bright}/${cellArea})`);
  const outside = countPixels(t, px, 6, 0, (r, g, b) => r > 120 && g > 120 && b > 120);
  assert.ok(outside < cellArea * 0.5, 'unselected cell is not inverted');

  // Multi-row selection.
  addon.setSelection(t.session, 6, 0, 5, 1);
  assert.strictEqual(addon.getSelectionText(t.session), 'world\nsecond');

  addon.clearSelection(t.session);
  assert.strictEqual(addon.getSelectionText(t.session), null);
  const f = addon.render(t.session);
  assert.ok(f, 'clearing selection re-renders');
});

test('query responses: CPR and DA are returned from write()', () => {
  // ncurses apps (htop) send these at startup and stall for seconds if the
  // terminal never answers — write() must return the generated responses so
  // the host can feed them back to the PTY.
  const t = makeTerm();
  write(t, 'ab\r\ncd');

  const cpr = addon.write(t.session, Buffer.from('\x1b[6n'));
  assert.ok(cpr && cpr.length, 'CPR generates a response');
  assert.match(cpr.toString('latin1'), /^\x1b\[2;3R$/, 'reports row 2 col 3 (1-based)');

  const da1 = addon.write(t.session, Buffer.from('\x1b[c'));
  assert.match(da1.toString('latin1'), /^\x1b\[\?62;/, 'DA1 advertises VT220 class');

  const da2 = addon.write(t.session, Buffer.from('\x1b[>c'));
  assert.match(da2.toString('latin1'), /^\x1b\[>1;/, 'DA2 reports device type');

  // Plain content produces no response.
  assert.strictEqual(addon.write(t.session, Buffer.from('hello')), undefined);
});

test('key encoding: printables and control keys', () => {
  const t = makeTerm();
  const enc = (ev) => addon.encodeKey(t.session, ev).toString('latin1');

  assert.strictEqual(enc({ code: 'KeyA', utf8: 'a' }), 'a');
  assert.strictEqual(enc({ code: 'Enter' }), '\r');
  assert.strictEqual(enc({ code: 'Backspace' }), '\x7f');
  assert.strictEqual(enc({ code: 'KeyC', ctrl: true, utf8: 'c' }), '\x03', 'Ctrl+C');
  assert.strictEqual(enc({ code: 'Escape' }), '\x1b');
  assert.strictEqual(enc({ code: 'Tab' }), '\t');
});

test('key encoding is mode-aware (DECCKM application cursor keys)', () => {
  const t = makeTerm();
  const enc = (ev) => addon.encodeKey(t.session, ev).toString('latin1');

  assert.strictEqual(enc({ code: 'ArrowUp' }), '\x1b[A', 'normal mode');
  write(t, '\x1b[?1h'); // enable DECCKM (what vim/less do)
  assert.strictEqual(enc({ code: 'ArrowUp' }), '\x1bOA', 'application mode');
  write(t, '\x1b[?1l');
  assert.strictEqual(enc({ code: 'ArrowUp' }), '\x1b[A', 'back to normal');
});
