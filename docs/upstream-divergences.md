# Emulator divergences found by the fuzz suite

Both findings are pinned as `KNOWN DIVERGENCE` tests in `test/fuzz.test.js`,
so a behavior change in either emulator will surface in CI. This document is
the draft material for upstream issues (not yet filed — see status).

## 1. DECRC after a scroll inside DECSTBM

**Minimal repro** (80×24):

```
\n            cursor to row 1
ESC 7         DECSC — save cursor (row 1)
CSI 1;21 r    DECSTBM — scroll region rows 1–21 (homes cursor)
CSI 21;50 H   move to the region's bottom margin
\r\n          linefeed at bottom margin → region scrolls up one line
ESC 8         DECRC — restore cursor
MARK          write text at the restored position
```

- **ghostty (libghostty-vt)**: `MARK` lands on **row 1** — the absolute saved
  position, per DEC STD-070 (DECSC saves an absolute cursor position; nothing
  in the spec adjusts it when content scrolls).
- **xterm.js**: `MARK` lands on **row 0** — the saved position followed the
  scrolled content up one line (buffer-line anchored rather than
  screen-absolute).

**Assessment**: DEC STD-070 §"Cursor Save/Restore" describes DECSC as saving
the cursor *position* (with origin mode, charsets, SGR); classic xterm
restores absolutely. xterm.js's scroll-adjusted restore looks like an
artifact of anchoring the saved cursor to a buffer line object. Suggested
target: an xterm.js issue.

## 2. DECOM homing after DECSTBM

**Minimal repro** (80×24):

```
CSI ?6 h      DECOM — origin mode on
CSI 4;16 r    DECSTBM — scroll region rows 4–16 (homes cursor to region origin)
CSI 2 F       CPL 2 — cursor up two lines, column 1
MARK
```

- **ghostty**: `MARK` on **row 3** (region origin; with DECOM the home
  position is the region's top margin and CPL clamps there).
- **xterm.js**: `MARK` on **row 6** — three rows below the region origin.

**Assessment**: with origin mode set, DECSTBM must home the cursor to the
scrolling-region origin, and relative movement clamps at the margins.
ghostty's behavior matches DEC semantics and classic xterm; xterm.js appears
to mis-handle either the DECOM home or the CPL clamp. Suggested target: an
xterm.js issue.

## Status

Drafted, not filed. Before filing: reproduce both against classic xterm (the
C reference implementation) to confirm the "correct" column, then open
issues against xterm.js with these repros (and against ghostty instead if
classic xterm disagrees with it).
