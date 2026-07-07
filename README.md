# ghostty-xterm-bench

`cat` a file in an Electron terminal, two ways:

1. **xterm.js + WebGL addon** — parse *and* render inside the Chromium renderer
   process (this is how VS Code's terminal works today).
2. **libghostty-vt + sharedTexture** — [libghostty-vt](https://github.com/ghostty-org/ghostty)
   parses the VT stream in the main process, a native addon draws the grid with
   CoreText into an **IOSurface** (HiDPI, dirty-row incremental), and Electron's
   `sharedTexture` module transfers it **zero-copy** into a sandboxed renderer
   `<canvas>` as a `VideoFrame`.

Same payload, same 120×30 grid, same physical pixel count (both render at
`devicePixelRatio`), same finish line (frame confirmed presented via
double-`requestAnimationFrame`). Everything is measured; nothing is modeled.

## Results (macOS arm64, M-series @2x, Electron 42.5.0 / Chromium 148)

**Burst — cat 1 MiB once** (median of 3):

```
  backend                                         parse ms    e2e ms    MB/s  frames
  ──────────────────────────────────────────────────────────────────────────────────
  xterm.js + WebGL (in-renderer DOM)                 104.6     113.7     8.8      14
  libghostty-vt + IOSurface + sharedTexture            8.1      20.9    47.8       2
  ──────────────────────────────────────────────────────────────────────────────────
  parse speedup: 12.9×   e2e speedup: 5.4×
```

**Sustained — cat 1 MiB ×10 back-to-back** (median of 3):

```
  backend                                         parse ms    e2e ms    MB/s  frames
  ──────────────────────────────────────────────────────────────────────────────────
  xterm.js + WebGL (in-renderer DOM)                1170.2    1183.3     8.5     129
  libghostty-vt + IOSurface + sharedTexture           53.6      65.1   153.7       5
  ──────────────────────────────────────────────────────────────────────────────────
  parse speedup: 21.8×   e2e speedup: 18.2×
  ghostty per-stage: write 44.8ms · render 2.8ms · send 6.3ms · present p50 15.9ms
```

Reproduce with `npm run bench`. Numbers land in `results/summary.json`.

**Reading the numbers:**
- The dominant cost of `cat`-ing a file is the **VT parser**, not pixels.
- The gap *widens* under sustained load: ghostty finishes the whole 10 MiB in
  65 ms — before xterm is 6% through its parse. The native renderer is nearly
  free (2.8 ms total draw time) thanks to dirty-row tracking + glyph runs.
- Per-frame present latency of the sharedTexture path is ~1 vsync (p50 ≈ 16 ms),
  measured send → consumer double-rAF ack.
- Frame counts differ because total wall time differs; both present at display
  cadence while working.

## Try it yourself — interactive demo

```bash
npm run demo
```

Two windows open side by side, each running **your real shell** via node-pty:
left = xterm.js + WebGL, right = libghostty + sharedTexture (stats overlay in
the corner: fps, native draw ms, present latency). Things worth feeling:

```bash
time cat payload.txt        # the benchmark, live
find / 2>/dev/null | head -100000
yes | head -1000000
vim / less / htop           # arrows work via mode-aware key encoding (DECCKM)
```

Scroll wheel scrolls ghostty's real scrollback; Cmd+V pastes.

## Architecture

```
xterm baseline:   PTY ──IPC──▶ xterm.js parser ──▶ WebGL atlas renderer ──▶ DOM canvas
                               └────────── all inside the renderer process ──────────┘

ghostty path:     PTY ──▶ libghostty-vt (main proc, native) ──▶ CoreText → IOSurface
                          importSharedTexture → sendSharedTexture ──▶ sandboxed renderer
                          getVideoFrame() ──▶ ctx.drawImage(frame) → <canvas>  (zero-copy)
                  keys:  DOM keydown ──IPC──▶ ghostty_key_encoder (mode-aware) ──▶ PTY
```

The ghostty-side renderer implements: fg/bg colors (palette + truecolor),
bold (incl. bold-in-bright-colors), italic, inverse, faint, underline,
strikethrough, wide chars/graphemes (CJK, emoji), cursor (block/bar/underline/
hollow), scrollback viewport, resize, HiDPI, double-buffered IOSurfaces with
dirty-row-only redraws. The renderer stays fully **sandboxed** — no native code
in the renderer; it only receives a GPU texture handle per frame.

**Non-goals (so far):** mouse selection/copy, links, search, IME composition,
ligatures, kitty graphics, blinking cursor. None of these affect the parse/
present numbers above.

## Run it

Requires macOS (arm64 tested), Node ≥ 20, Xcode CLT, and [zig](https://ziglang.org)
matching ghostty's pinned version (0.15.2 at time of writing).

```bash
npm install            # also fixes the exec bit npm strips from node-pty's spawn-helper
npm run payload        # generate the 1 MiB test file
npm run setup:ghostty  # clone ghostty into vendor/ and build libghostty-vt
npm run build:native   # build the N-API IOSurface producer addon
npm run bench          # burst + sustained comparison table
npm run demo           # side-by-side live shells
```

## Tests

```bash
npm test                    # fast, no GUI: addon + conformance (node:test)
npm run test:integration    # launches real Electron apps (windows will flash)
```

Three layers:

1. **Addon tests** (`test/addon.test.js`) — plain Node against the native
   addon: pixel assertions via `readPixels()` (SGR colors land in the right
   cells, bg fills, block cursor drawn), grid text via `getText()`, dirty
   tracking across double buffering, scrollback, resize, wide chars, and
   **mode-aware key encoding** (ArrowUp flips `\e[A` → `\eOA` when the app
   enables DECCKM, like vim).
2. **Conformance tests** (`test/conformance.test.js`) — identical VT streams
   into libghostty-vt and `@xterm/headless` (VS Code's exact emulator), grids
   diffed row-by-row: cursor movement, wraps, erases, scroll regions, tabs,
   CJK, alt screen, scrollback overflow, **and the full 1 MiB benchmark
   payload**. This is the correctness go/no-go: the speed comparison only
   means something if both emulators do the same work.
3. **Integration tests** (`test/integration.test.js`) — spawns the real
   Electron apps: both benchmarks produce sane per-stage numbers and screenshots,
   sustained mode works, and the demo's `--smoke` mode round-trips a `zsh`
   echo through both PTY→parser→renderer pipelines.

## Layout

```
scripts/gen-payload.js     1 MiB newline-dense payload with SGR colors
scripts/setup-ghostty.sh   clone + build libghostty-vt (static) into vendor/
native/                    N-API addon: libghostty-vt + CoreText → IOSurface
                           (+ key encoder, scrollback, resize, test hooks)
xterm-bench/               baseline Electron app (xterm.js + WebGL addon)
ghostty-bench/             sharedTexture Electron app (producer in main process)
demo/                      side-by-side interactive demo (node-pty shells)
test/                      addon + conformance + integration suites
bench.js                   unified runner (burst + sustained) + table
```

## Caveats

- libghostty-vt is alpha; its header warns of breaking changes. Pin the vendor
  checkout if you need stability.
- The native renderer is a CPU rasterizer into an IOSurface. It's already fast
  enough to be invisible in the numbers; ghostty's real GPU renderer (not yet
  exposed via libghostty) would lower frame cost further at high fps.
- No PTY in the *benchmark* path (raw bytes, so both parsers see identical
  input, and kernel PTY buffering stays out of the measurement). The *demo*
  uses real PTYs.
