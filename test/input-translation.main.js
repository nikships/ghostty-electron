'use strict';
/**
 * Verbose input-translation verification: does every input event
 * arrive at the APPLICATION side of the PTY as exactly the byte
 * sequence a real terminal would deliver?
 *
 * Method: the terminal runs
 *     stty raw -echo; cat > $CAPTURE
 * so every byte the application reads from the PTY is appended to a
 * file this test reads back — no pixels, no OCR, exact bytes. `stty
 * raw` turns off ISIG/ICANON, so Ctrl+C arrives as 0x03 instead of
 * signaling, and bytes flush per read.
 *
 * Probes:
 *  - keyboard: macOS keycodes through ghostty's key encoder (the same
 *    calls the preload makes) — plain keys, ctrl chords, arrows with
 *    modifier encodings, nav/function keys, alt-as-ESC, UTF-8 text.
 *  - mouse: SGR tracking enabled via an injected escape (written to
 *    the PTY slave by printf before cat starts); clicks at computed
 *    cell centers verify CSS→surface-px→cell coordinate translation;
 *    wheel verifies scroll button encoding.
 *
 * Per-probe verbose PASS/FAIL with expected vs actual bytes, for both
 * engine placements. Exit 0 iff all pass. Driven by
 * test/integration.test.js; results/input-translation.json.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const { GhosttyTerminal } = require('electron-ghostty');

const results = [];
let failures = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const show = (buf) => JSON.stringify(buf.toString('latin1'))
  .replace(/\\u001b/g, 'ESC').replace(/\\u000f/g, '^O');

/* macOS virtual keycodes (same table as the preload). */
const KC = {
  a: 0, c: 8, z: 6, Enter: 36, Tab: 48, Space: 49, Escape: 53,
  Backspace: 51, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125,
  ArrowUp: 126, Home: 115, End: 119, PageUp: 116, PageDown: 121,
  F1: 122, F5: 96, Delete: 117,
};
const CTRL = 2, SHIFT = 1, ALT = 4;

function pressKey(term, keycode, mods = 0, text, unshifted) {
  term.key({ action: 1, keycode, mods, text, unshiftedCodepoint: unshifted ?? 0 });
  term.key({ action: 0, keycode, mods });
}

const E = '\x1b';
const KEY_PROBES = [
  { name: 'plain letter a', input: (t) => pressKey(t, KC.a, 0, 'a', 97), expect: 'a' },
  { name: 'Ctrl+A → SOH', input: (t) => pressKey(t, KC.a, CTRL, undefined, 97), expect: '\x01' },
  { name: 'Ctrl+C → ETX (raw mode: byte, not signal)', input: (t) => pressKey(t, KC.c, CTRL, undefined, 99), expect: '\x03' },
  { name: 'Ctrl+Z → SUB', input: (t) => pressKey(t, KC.z, CTRL, undefined, 122), expect: '\x1a' },
  { name: 'Escape', input: (t) => pressKey(t, KC.Escape), expect: E },
  { name: 'Tab', input: (t) => pressKey(t, KC.Tab), expect: '\t' },
  { name: 'Enter → CR', input: (t) => pressKey(t, KC.Enter), expect: '\r' },
  { name: 'Backspace → DEL', input: (t) => pressKey(t, KC.Backspace), expect: '\x7f' },
  { name: 'ArrowUp → CSI A', input: (t) => pressKey(t, KC.ArrowUp), expect: `${E}[A` },
  { name: 'ArrowDown → CSI B', input: (t) => pressKey(t, KC.ArrowDown), expect: `${E}[B` },
  { name: 'ArrowRight → CSI C', input: (t) => pressKey(t, KC.ArrowRight), expect: `${E}[C` },
  { name: 'ArrowLeft → CSI D', input: (t) => pressKey(t, KC.ArrowLeft), expect: `${E}[D` },
  { name: 'Shift+ArrowUp → CSI 1;2A', input: (t) => pressKey(t, KC.ArrowUp, SHIFT), expect: `${E}[1;2A` },
  { name: 'Alt+ArrowUp → CSI 1;3A', input: (t) => pressKey(t, KC.ArrowUp, ALT), expect: `${E}[1;3A` },
  { name: 'Ctrl+ArrowRight → CSI 1;5C', input: (t) => pressKey(t, KC.ArrowRight, CTRL), expect: `${E}[1;5C` },
  { name: 'Home → CSI H', input: (t) => pressKey(t, KC.Home), expect: `${E}[H` },
  { name: 'End → CSI F', input: (t) => pressKey(t, KC.End), expect: `${E}[F` },
  { name: 'PageUp → CSI 5~', input: (t) => pressKey(t, KC.PageUp), expect: `${E}[5~` },
  { name: 'PageDown → CSI 6~', input: (t) => pressKey(t, KC.PageDown), expect: `${E}[6~` },
  { name: 'Delete forward → CSI 3~', input: (t) => pressKey(t, KC.Delete), expect: `${E}[3~` },
  { name: 'F1 → SS3 P', input: (t) => pressKey(t, KC.F1), expect: `${E}OP` },
  { name: 'F5 → CSI 15~', input: (t) => pressKey(t, KC.F5), expect: `${E}[15~` },
  { name: 'Alt+a → ESC a', input: (t) => pressKey(t, KC.a, ALT, undefined, 97), expect: `${E}a` },
  { name: 'text() UTF-8 é (2 bytes)', input: (t) => t.text('é'), expect: 'é' },
  { name: 'text() emoji 🚀 (4 bytes)', input: (t) => t.text('🚀'), expect: '🚀' },
];

async function drainFile(file, prevLen, timeoutMs = 5000) {
  // Wait until the capture file grows past prevLen and stabilizes.
  const t0 = Date.now();
  let last = prevLen, stable = 0;
  for (;;) {
    await sleep(60);
    const len = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (len > prevLen && len === last) {
      if (++stable >= 2) return fs.readFileSync(file).subarray(prevLen);
    } else stable = 0;
    last = len;
    if (Date.now() - t0 > timeoutMs)
      return fs.existsSync(file)
        ? fs.readFileSync(file).subarray(prevLen)
        : Buffer.alloc(0);
  }
}

app.whenReady().then(async () => {
  for (const engine of ['utility', 'main']) {
    console.log(`\n━━━ engine: ${engine} ━━━`);
    const capture = path.join(os.tmpdir(), `ghostty-input-capture-${engine}-${process.pid}`);
    fs.writeFileSync(capture, '');

    /* ── keyboard ──────────────────────────────────────────────── */
    {
      const term = new GhosttyTerminal({
        scale: 2, engine,
        command: `/bin/sh -c "stty raw -echo; cat > ${capture}"`,
      });
      try {
        // Wait for the pipeline to be up: send a probe byte, watch it land.
        await sleep(1000);
        let pos = 0;
        term.text('!');
        const hello = await drainFile(capture, pos, 8000);
        if (hello.toString() !== '!') throw new Error(`pipeline not up: got ${show(hello)}`);
        pos += hello.length;

        for (const probe of KEY_PROBES) {
          probe.input(term);
          const got = await drainFile(capture, pos);
          pos += got.length;
          const ok = got.toString('utf8') === probe.expect;
          const exp = show(Buffer.from(probe.expect, 'utf8'));
          console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${engine}] ${probe.name}` +
            `\n         expected ${exp}${ok ? '' : `\n         actual   ${show(got)}`}`);
          results.push({ engine, kind: 'key', name: probe.name, ok,
                         expected: probe.expect, actual: got.toString('utf8') });
          if (!ok) failures++;
        }
      } finally { term.destroy(); }
    }

    /* ── mouse: coordinates + buttons + wheel via SGR tracking ──── */
    {
      fs.writeFileSync(capture, '');
      const term = new GhosttyTerminal({
        scale: 2, engine, widthPx: 1800, heightPx: 900,
        // Enable button-event tracking (1002) + SGR encoding (1006)
        // on the PTY before capturing.
        command: `/bin/sh -c "stty raw -echo; printf '\\033[?1002h\\033[?1006h'; cat > ${capture}"`,
      });
      try {
        await sleep(1200);
        let pos = 0;
        term.text('!');
        const hello = await drainFile(capture, pos, 8000);
        if (!hello.length) throw new Error('pipeline not up');
        pos += hello.length;
        const size = await term.sizeAsync();
        console.log(`  grid ${size.cols}x${size.rows}, cell ${size.cellWidth}x${size.cellHeight}px @2x`);

        // mousePos takes UNSCALED (CSS/point) coordinates — ghostty
        // applies content-scale itself (cursorPosToPixels). cellWidth/
        // cellHeight are surface pixels, so divide by scale.
        const cssX = (col) => (col * size.cellWidth + size.cellWidth / 2) / term.scale;
        const cssY = (row) => (row * size.cellHeight + size.cellHeight / 2) / term.scale;
        const clickAt = (col, row) => {
          term.mousePos(cssX(col), cssY(row), 0);
          term.mouseButton(1, 1, 0);
          term.mouseButton(0, 1, 0);
        };

        for (const [col, row] of [[0, 0], [4, 2], [19, 9], [size.cols - 1, size.rows - 1]]) {
          clickAt(col, row);
          const got = await drainFile(capture, pos);
          pos += got.length;
          const expect = `${E}[<0;${col + 1};${row + 1}M${E}[<0;${col + 1};${row + 1}m`;
          const ok = got.toString() === expect;
          console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${engine}] click cell(${col},${row}) → press+release SGR` +
            `\n         expected ${show(Buffer.from(expect))}${ok ? '' : `\n         actual   ${show(got)}`}`);
          results.push({ engine, kind: 'mouse', name: `click ${col},${row}`, ok,
                         expected: expect, actual: got.toString() });
          if (!ok) failures++;
        }

        // Wheel down at cell (9,4): SGR button 65, one report per unit.
        {
          const x = cssX(9), y = cssY(4);
          term.mousePos(x, y, 0);
          const posBefore = pos;
          term.mouseScroll(x, y, 0, -1);
          const got = await drainFile(capture, posBefore);
          pos = posBefore + got.length;
          const unit = `${E}[<65;10;5M`;
          const s = got.toString();
          const ok = s.length > 0 && s.split(unit).join('') === '';
          console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${engine}] wheel-down at cell(9,4) → ${show(Buffer.from(unit))} xN` +
            `${ok ? ` (got ${s.length / unit.length} report(s))` : `\n         actual   ${show(got)}`}`);
          results.push({ engine, kind: 'mouse', name: 'wheel', ok, actual: s });
          if (!ok) failures++;
        }

        // Drag: press at (2,2), move to (6,2) — expect press, motion
        // report(s) with button 32 (0+drag flag), release at target.
        {
          term.mousePos(cssX(2), cssY(2), 0);
          term.mouseButton(1, 1, 0);
          term.mousePos(cssX(4), cssY(2), 0);
          term.mousePos(cssX(6), cssY(2), 0);
          term.mouseButton(0, 1, 0);
          const got = await drainFile(capture, pos);
          pos += got.length;
          const s = got.toString();
          const ok = s.startsWith(`${E}[<0;3;3M`) &&
                     s.includes(`${E}[<32;5;3M`) &&
                     s.includes(`${E}[<32;7;3M`) &&
                     s.endsWith(`${E}[<0;7;3m`);
          console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${engine}] drag cell(2,2)→(6,2) → press, motion(32), release` +
            `${ok ? '' : `\n         actual   ${show(got)}`}`);
          results.push({ engine, kind: 'mouse', name: 'drag', ok, actual: s });
          if (!ok) failures++;
        }
      } finally { term.destroy(); }
      try { fs.unlinkSync(capture); } catch {}
    }
  }

  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results', 'input-translation.json'),
    JSON.stringify({ failures, probes: results }, null, 2));
  console.log(`\n${results.length} probes, ${failures} failures`);
  app.exit(failures ? 1 : 0);
});

setTimeout(() => { console.error('input-translation: global timeout'); process.exit(2); }, 240_000);
