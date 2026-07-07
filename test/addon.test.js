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

test('render produces frames only when dirty', () => {
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

test('red SGR text produces red pixels in the right cell', () => {
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

test('background color fills cell', () => {
  const t = makeTerm();
  write(t, '\x1b[44m  \x1b[0m'); // blue background, two cells
  addon.render(t.session);
  const px = addon.readPixels(t.session);
  // Theme-agnostic: blue-dominant and clearly not the default background.
  const blue = countPixels(t, px, 0, 0, (r, g, b) => b > 120 && b > r + 30);
  const cellArea = Math.round(t.cellWidth) * Math.round(t.cellHeight);
  assert.ok(blue > cellArea * 0.9, `bg should fill the cell (${blue}/${cellArea})`);
});

test('block cursor is drawn', () => {
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

test('cursor movement dirties old and new rows', () => {
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

test('dirty-row tracking survives double buffering', () => {
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

  const f = addon.render(t.session);
  assert.ok(f, 'resize forces a present');
  assert.strictEqual(f.width, dims.width);
});

test('wide characters occupy two cells', () => {
  const t = makeTerm();
  write(t, '你好');
  const lines = addon.getText(t.session);
  assert.strictEqual(lines[0], '你好');
  const cur = addon.getCursor(t.session);
  assert.strictEqual(cur.x, 4, 'two wide chars advance cursor by 4');
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
