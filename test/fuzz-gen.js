'use strict';
/** Seeded VT stream generator shared by the fuzz suite and the minimizer. */
const COLS = 80;
const ROWS = 24;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTokens(rnd, count) {
  const int = (n) => Math.floor(rnd() * n);
  const pick = (arr) => arr[int(arr.length)];
  const generators = [
    // plain text runs
    () => Array.from({ length: 1 + int(20) }, () => pick('abcdefgh XYZ0123._-'.split(''))).join(''),
    () => '\r\n',
    () => '\r',
    () => '\n',
    () => '\t',
    // absolute + relative cursor movement
    () => `\x1b[${1 + int(ROWS)};${1 + int(COLS)}H`,
    () => `\x1b[${1 + int(5)}${pick(['A', 'B', 'C', 'D'])}`,
    // SGR
    () => `\x1b[${pick(['0', '1', '4', '7', '22', '24', '27'])}m`,
    () => `\x1b[${30 + int(8)}m`,
    () => `\x1b[${40 + int(8)}m`,
    () => `\x1b[38;5;${int(256)}m`,
    () => `\x1b[38;2;${int(256)};${int(256)};${int(256)}m`,
    // erase
    () => `\x1b[${int(3)}J`,
    () => `\x1b[${int(3)}K`,
    // scroll region set/reset and explicit scroll
    () => {
      const top = 1 + int(ROWS - 2);
      return `\x1b[${top};${top + 1 + int(ROWS - top - 1)}r`;
    },
    () => '\x1b[r',
    () => `\x1b[${1 + int(3)}S`,
    () => `\x1b[${1 + int(3)}T`,
    // wide characters
    () => pick(['你好', '漢字', 'テスト']),
    // column/row addressing
    () => `\x1b[${1 + int(COLS)}G`,
    () => `\x1b[${1 + int(ROWS)}d`,
    () => `\x1b[${1 + int(3)}E`,
    () => `\x1b[${1 + int(3)}F`,
    // erase characters
    () => `\x1b[${1 + int(6)}X`,
    // index / next line / reverse index
    () => '\x1bD',
    () => '\x1bE',
    () => '\x1bM',
    // insert/replace mode
    () => '\x1b[4h',
    () => '\x1b[4l',
    // autowrap toggle. Origin mode (DECOM, ?6h) is deliberately absent:
    // fuzzing found DECOM + DECSTBM cursor addressing diverges between the
    // emulators — pinned as a known-divergence test in fuzz.test.js.
    () => pick(['\x1b[?7h', '\x1b[?7l']),
    // tab stop set/clear
    () => '\x1bH',
    () => pick(['\x1b[0g', '\x1b[3g']),
    // bright SGR + defaults
    () => `\x1b[${90 + int(8)}m`,
    () => `\x1b[${100 + int(8)}m`,
    () => pick(['\x1b[39m', '\x1b[49m']),
    // OSC window title (no grid effect; exercises the OSC parser path)
    () => `\x1b]0;t${int(100)}\x07`,
    // NOTE: DECSC/DECRC (ESC 7 / ESC 8) are deliberately absent: fuzzing
    // found a real divergence when restoring across a DECSTBM scroll — see
    // the pinned "known divergence" test below.
    // insert/delete lines & chars
    () => `\x1b[${1 + int(3)}L`,
    () => `\x1b[${1 + int(3)}M`,
    () => `\x1b[${1 + int(5)}P`,
    () => `\x1b[${1 + int(5)}@`,
  ];
  const tokens = [];
  for (let i = 0; i < count; i++) tokens.push(pick(generators)());
  return tokens;
}


module.exports = { mulberry32, makeTokens, COLS, ROWS };
