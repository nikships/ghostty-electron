# ghostty-xterm-bench

`cat` a 1 MiB newline-heavy file in an Electron terminal, two ways:

1. **xterm.js + WebGL addon** — parse *and* render inside the Chromium renderer
   process (this is how VS Code's terminal works today).
2. **libghostty-vt + sharedTexture** — [libghostty-vt](https://github.com/ghostty-org/ghostty)
   parses the VT stream in the main process, a native addon draws the grid with
   CoreText into an **IOSurface**, and Electron's `sharedTexture` module transfers
   it **zero-copy** into a sandboxed renderer `<canvas>` as a `VideoFrame`.

Same payload, same 120×30 grid, same finish line (frame actually presented by the
compositor, confirmed via double-`requestAnimationFrame`). Everything is measured;
nothing is modeled.

## Results (macOS arm64, M-series, Electron 42.5.0 / Chromium 148)

```
  backend                                        parse ms   e2e ms    MB/s  frames
  ────────────────────────────────────────────────────────────────────────────────
  xterm.js + WebGL (in-renderer DOM)                105.6    119.2     8.4      14
  libghostty-vt + IOSurface + sharedTexture           9.5     26.4    37.9       2
  ────────────────────────────────────────────────────────────────────────────────
  parse speedup (ghostty vs xterm):  11.1×
  e2e speedup   (ghostty vs xterm):  4.5×
```

Median of 5 runs. Reproduce with `npm run bench`.

**Reading the numbers:**
- The dominant cost of `cat`-ing a file is the **VT parser**, not pixels.
  libghostty-vt's parser is ~11× faster than xterm.js's JS parser on this payload.
- End-to-end, ghostty+sharedTexture finishes 4.5× sooner. Its e2e is bounded by
  presentation latency (~2 vsyncs of the final-frame ack), not by parsing.
- Both backends produce the same final screen (see `results/*-frame.png` after
  `npm run bench -- --screenshot`) — same content, same SGR colors.

## Architecture

```
xterm baseline:   payload ──write()──▶ xterm.js parser ──▶ WebGL atlas renderer ──▶ DOM canvas
                                └────────────── all inside the renderer process ─────────────┘

ghostty path:     payload ──▶ libghostty-vt (main proc, native) ──▶ CoreText → IOSurface
                              importSharedTexture → sendSharedTexture ──▶ sandboxed renderer
                              getVideoFrame() ──▶ ctx.drawImage(frame) → <canvas>   (zero-copy)
```

Key properties of the ghostty path:
- The renderer stays fully **sandboxed** — no native code in the renderer; it only
  receives a GPU texture handle.
- The IOSurface handle transfer is ~1 KB of metadata per frame instead of megabytes
  of bitmap IPC.
- Frames are double-buffered (two IOSurfaces) so the compositor can scan out frame
  N while frame N+1 is drawn.

## Run it

Requires macOS (arm64 tested), Node ≥ 20, Xcode CLT, and [zig](https://ziglang.org)
matching ghostty's pinned version (0.15.2 at time of writing).

```bash
npm install
npm run payload        # generate the 1 MiB test file
npm run setup:ghostty  # clone ghostty into vendor/ and build libghostty-vt
npm run build:native   # build the N-API IOSurface producer addon
npm run bench          # run both backends (median of 3) and print the table
```

Individual backends: `npm run bench:xterm`, `npm run bench:ghostty`
(add `-- --screenshot` to dump the final frame to `results/`).

## Fairness notes & caveats

- Both backends receive the identical byte stream in 64 KiB chunks with **no PTY**
  in between (so `\n` is a bare line feed — the staircase effect is identical on
  both sides and exercises the same parse/scroll path).
- Both timers start after the window's first paint (double-rAF handshake) and stop
  when the frame containing the final payload state is confirmed presented.
- The ghostty renderer here is a **minimal CoreText CPU rasterizer into an
  IOSurface** (full-viewport redraw per frame, fg/bg/bold only — no underline,
  no wide-char/grapheme shaping, no cursor). A production renderer (e.g. ghostty's
  own GPU renderer, or dirty-row-only updates — libghostty-vt exposes per-row
  dirty state) would only widen the gap.
- xterm.js renders at rAF cadence (14 frames during the flood); the ghostty path
  presents at a 16 ms cadence during feeding (2 frames, because parsing finishes
  in ~10 ms). Frame counts differ because the backends spend such different
  amounts of time parsing — that asymmetry *is* the result.
- libghostty-vt is alpha; its header warns of breaking changes. Pin the vendor
  checkout if you need stability.

## Layout

```
scripts/gen-payload.js     1 MiB newline-dense payload with SGR colors
scripts/setup-ghostty.sh   clone + build libghostty-vt (static) into vendor/
native/                    N-API addon: libghostty-vt + CoreText → IOSurface
xterm-bench/               baseline Electron app (xterm.js + WebGL addon)
ghostty-bench/             sharedTexture Electron app (producer in main process)
bench.js                   unified runner + comparison table
```
