'use strict';
/**
 * Grid conformance: feed identical VT streams to libghostty-vt and
 * @xterm/headless (the exact emulator VS Code uses) and diff the resulting
 * text grids. This is the correctness go/no-go for the benchmark — if the
 * grids diverge, the speed comparison is comparing different work.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const addon = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'ghostty_producer.node'));
const { Terminal } = require('@xterm/headless');

const COLS = 80;
const ROWS = 24;

function ghosttyGrid(input) {
  const t = addon.create(COLS, ROWS, 13, 1);
  addon.write(t.session, Buffer.from(input, 'utf8'));
  return addon.getText(t.session);
}

async function xtermGrid(input) {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true });
  await new Promise((resolve) => term.write(input, resolve));
  const lines = [];
  const buf = term.buffer.active;
  for (let i = 0; i < ROWS; i++) {
    const line = buf.getLine(buf.viewportY + i);
    lines.push(line ? line.translateToString(true) : '');
  }
  term.dispose();
  return lines;
}

async function assertGridsMatch(name, input) {
  const [g, x] = [ghosttyGrid(input), await xtermGrid(input)];
  for (let i = 0; i < ROWS; i++) {
    assert.strictEqual(g[i], x[i], `${name}: row ${i} diverges\n ghostty: ${JSON.stringify(g[i])}\n xterm:   ${JSON.stringify(x[i])}`);
  }
}

test('plain text with CRLF', async () => {
  await assertGridsMatch('crlf', 'hello world\r\nsecond line\r\nthird');
});

test('bare LF staircase (no PTY translation)', async () => {
  await assertGridsMatch('lf', 'one\ntwo\nthree');
});

test('CR overwrite', async () => {
  await assertGridsMatch('cr', 'hello\rHELLO\r\nabcdef\rxy');
});

test('SGR-heavy content keeps text intact', async () => {
  await assertGridsMatch('sgr',
    '\x1b[1;31mbold red\x1b[0m plain \x1b[4munder\x1b[24mline ' +
    '\x1b[38;2;10;20;30mtruecolor\x1b[0m \x1b[7minverse\x1b[27m\r\n' +
    '\x1b[32m[123]\x1b[0m ok');
});

test('cursor movement (CUP/CUU/CUF/CUB)', async () => {
  await assertGridsMatch('cursor',
    'base line\r\n\x1b[1;3Hxx\x1b[3;1Hthird\x1b[2Ayy\x1b[5Dzz\x1b[Bqq');
});

test('line wrap at right margin', async () => {
  await assertGridsMatch('wrap', 'x'.repeat(COLS * 2 + 10));
});

test('erase in display and line (ED/EL)', async () => {
  await assertGridsMatch('erase',
    'aaaa\r\nbbbb\r\ncccc\x1b[2;2H\x1b[K\x1b[1;1H\x1b[1Jrest');
});

test('scroll region (DECSTBM)', async () => {
  let input = '\x1b[2;5r\x1b[2;1H';
  for (let i = 0; i < 10; i++) input += `region-line-${i}\r\n`;
  input += '\x1b[r';
  await assertGridsMatch('decstbm', input);
});

test('tabs', async () => {
  await assertGridsMatch('tabs', 'a\tb\tc\td\r\n12345678\tx');
});

test('wide characters (CJK)', async () => {
  await assertGridsMatch('cjk', '你好世界 mixed 漢字テスト\r\nascii');
});

test('alternate screen round trip', async () => {
  await assertGridsMatch('altscreen',
    'primary content\r\n\x1b[?1049halt screen stuff\x1b[?1049l\r\nback');
});

test('scrollback overflow shows the same viewport', async () => {
  let input = '';
  for (let i = 1; i <= 100; i++) input += `scroll-line-${i}\r\n`;
  await assertGridsMatch('scrollback', input);
});

test('benchmark payload produces identical grids', async () => {
  const payloadPath = path.join(__dirname, '..', 'payload.txt');
  if (!fs.existsSync(payloadPath)) {
    console.log('payload.txt missing — run `npm run payload`; skipping');
    return;
  }
  const payload = fs.readFileSync(payloadPath, 'utf8');
  await assertGridsMatch('payload', payload);
});
