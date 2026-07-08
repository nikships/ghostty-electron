# FIXED: htop renders blank process list + blank F-bar buttons for ~1s

**Status: fixed and regression-tested.** Root cause was a **CoreText text-matrix
leak** in the macOS renderer — not the compositor, not sharedTexture, not
double-buffering, not dirty-tracking (all of which earlier guesses wrongly
blamed). One line in `producer_mac.m` fixes it; a deterministic test reproduces
the bug with no Electron/GUI and fails without the fix.

## Symptom

Demo (`npm run demo`), run `htop` in the ghostty pane. For ~1s the F-key bar
shows colored button backgrounds with **no label text** and the process list is
empty, then it fills in. Any interaction (mouse move, click, resize) makes it
appear instantly, and it self-heals after ~1s. The xterm.js pane is correct
immediately.

## Root cause: CTLineDraw leaves a non-identity text matrix

The renderer draws each cell row in `draw_row` (`native/src/producer_mac.m`):
- ASCII cells are batched into `CTFontDrawGlyphs` runs (fast path).
- Non-ASCII cells (CJK, symbols, and htop's `▽` column-sort indicator) go
  through a per-cell `CTLine` path.

`CTLineDraw` **mutates the CGContext's text matrix** to whatever the drawn run's
font implies. `CTFontDrawGlyphs` draws with the *current* text matrix and sets
none of its own. So the first non-ASCII cell in a frame leaves a non-identity
text matrix, and **every subsequent batched-ASCII run in that same frame draws
off-surface** — invisibly.

htop's column-header row contains `▽`. Once that row is drawn, the entire
process list below it and the F-bar labels (all batched ASCII) render blank.
It "self-healed" only because later htop repaints happened to redraw rows in an
order/state where the matrix wasn't yet corrupted, and interaction/`capturePage`
forced repaints that masked it.

### Why earlier investigations went wrong

Every prior hypothesis (producer-drop, compositor-below-JS, double-buffering
staleness, dirty-flag races) was "verified" with `webContents.capturePage()`,
which itself forces a compositor commit and repaint — masking the real defect
and mismeasuring fixes. The breakthrough was building a reliable observer:
capture htop's raw PTY byte stream once, replay it into a fresh session, and
read the rasterized IOSurface directly via `readPixels` — no Electron, no
compositor, no timing. That made the bug 100% deterministic and localized it to
`draw_row`, then to the single row containing a non-ASCII glyph, then to the
text-matrix leak.

## The fix

`native/src/producer_mac.m`, in the non-ASCII `CTLine` branch of `draw_row`,
after `CTLineDraw`:

```c
CGContextSetTextMatrix(ctx, CGAffineTransformIdentity);
```

Resets the text matrix so the batched ASCII runs that follow position
correctly. One line; no behavior change for any already-working content.

## Verification

- `test/addon.test.js`: new test **"non-ASCII glyph does not blank later rows
  (text-matrix leak)"** — writes `▽` on row 0, white ASCII on row 5, renders
  once, asserts row 5 has light pixels. Passes with the fix; **fails without
  it** (verified by removing the line and rebuilding).
- Deterministic htop replay (capture real bytes → replay → `readPixels`): before
  the fix only rows 1-5 rasterized text; after, the full process list and the
  `F1Help … F10Quit` F-bar render from a single all-at-once write.
- `npm test`: 73/73 pass (was 72; +1 regression test).

## Notes for other platforms

`producer_win.cc` (DirectWrite/D2D) uses a different text API and is not
affected by this specific CoreText behavior, but if a similar "everything after
the first complex glyph goes blank" symptom appears on Windows, check for
analogous per-run transform/state that isn't reset between the batched and
fallback text paths.

## Reference

- Electron sharedTexture docs: https://www.electronjs.org/docs/latest/api/shared-texture
- Implementing PR: https://github.com/electron/electron/pull/47317
