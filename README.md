# ghostty-xterm-bench

**Experimental, pure research.** This repo answers one question:

> Can you embed a native terminal engine in Electron — without forking
> Chromium — and get its frames into the sandboxed DOM zero-copy?

Answer: yes. [ghostty](https://github.com/ghostty-org/ghostty) runs
headlessly inside an Electron app and owns *everything* — PTY + shell,
VT parsing, key/mouse encoding, selection, fonts/shaping, **Metal (GPU)
rendering** — and each presented IOSurface is imported into a fully
sandboxed `<canvas>` as a W3C `VideoFrame` via Electron's
[`sharedTexture`](https://electronjs.org/docs/latest/api/shared-texture)
module (Electron ≥ 41; the same path `<video>` frames take). No pixels
are ever copied over IPC. By default the engine doesn't even run in the
Electron main process: it lives in a **utilityProcess**, so a busy or
crashed terminal can't stall window management — and the zero-copy
property survives the process boundary (what crosses per frame is a
`uint32` IOSurface ID).

The embedding lives in [`packages/electron-ghostty`](packages/electron-ghostty)
as a reusable (deliberately unpublished) package; the demo and tests
consume it like a dependency. The repo also carries DOM-terminal
benchmarks (xterm.js + WebGL, ghostty-web WASM) used for the historical
comparison below.

## Motivation

VS Code's terminal keeps everything — VT parsing, buffer state,
rendering — on the renderer process's JavaScript thread. Heavy output
floods are parse-bound in JS and saturate the same thread that handles
keystrokes, so the terminal feels worst exactly when it's busiest.
Proposals to swap in a native terminal engine were historically
dismissed as "you'd have to fork Chromium to get native pixels into the
DOM" (microsoft/vscode#236991 was closed as out of scope).

That premise changed with Electron's `sharedTexture` module. This repo
is the working proof — plus an attempt to measure honestly what the
architecture buys and what it doesn't.

## What works today (macOS)

- `npm run demo` — a real interactive shell in an Electron window,
  rendered by ghostty's own Metal renderer. Typing, paste, mouse
  clicks/drag/wheel (through ghostty's mouse encoder — try htop or
  `vim` with `:set mouse=a`), window resize with grid reflow +
  SIGWINCH, scrollback. `--engine=main` runs the engine in-process
  instead of the default utilityProcess.
- `npm run bench` — DOM-terminal flood benchmark (xterm.js and
  ghostty-web), burst + sustained modes.
- `node bench/engine-placement.js` — the engine-placement benchmark
  (see below).
- `npm run bench:stock` — Electron overhead vs stock Ghostty.app.
- `npm test` + `npm run test:integration` — 7 e2e tests against real
  IOSurface pixels (spawn, input roundtrip, key encoding, resize
  reflow, scrollback, process exit) and 5 Electron integration tests
  (DOM benches + demo smoke in **both** engine placements).

Not implemented yet (contributions/discussion welcome): clipboard
integration, window-title/pwd/bell events, link clicking, IME
composition, focus reporting, multiple terminals per window, config
passthrough beyond font size. See `packages/electron-ghostty/README.md`.

## Measured: does the engine's process placement matter?

The one benchmark maintained against the current tree
(`bench/engine-placement.js`, chart via
`scripts/engine-placement-chart.js`). Same embedding, same zero-copy
path — the engine in the Electron main process vs a utilityProcess.
Median of 5 interleaved runs, real `zsh -f`, 100 MiB sustained `cat`,
Apple Silicon @2x, Electron 42:

| metric (median of 5) | main | utility |
|---|---|---|
| 100 MiB flood → presented | 1,664 ms | 1,682 ms (~1%, noise) |
| main process blocked at terminal spawn | 28.9 ms | **4.2 ms (7×)** |
| first frame presented | 281 ms | 236 ms |
| main-loop lag p99 during flood | 1.7 ms | 1.6 ms (wash) |

The honest read: **throughput is identical** — ghostty's IO/render
threads were never on the main process's JS thread to begin with. What
the utilityProcess buys is crash isolation (kill the engine, the app
survives — tested), 7× less main-process blocking at spawn, and
protection against a wedged engine. That, not raw speed, is the reason
it's the default.

## Historical results (not reproducible from HEAD)

Earlier iterations of this repo benchmarked a different architecture:
**libghostty-vt parsing in the main process + a hand-rolled CPU
rasterizer** presenting via sharedTexture, raced against xterm.js and
ghostty-web with VS Code-style flow control, conformance/fuzz-tested
against `@xterm/headless`. Those harnesses (parser suite, 1 GiB PTY
race, input latency, leak soak, render stress, the Windows D3D11
producer, and the conformance/fuzz layers) were **removed** in the
move to full-ghostty embedding
([`c116b9f`](../../commit/c116b9f)); they last exist at
[`1a4357c`](../../tree/1a4357c), where every number below was
measured and can be reproduced.

Headlines from that iteration (macOS, Apple Silicon @2x, medians;
details and method in the [`1a4357c` README](../../blob/1a4357c/README.md)):

- Parser only: libghostty-vt 237 MB/s vs xterm.js headless 19.7 MB/s
  (~12×), ghostty-web WASM between the two (58.4 MB/s).
- 10 MiB in-terminal flood: 66 ms vs 1,200 ms e2e (~18×).
- 1 GiB PTY `cat`: 25.6 s vs 55.4 s (~2.2×, pipe-bound; ghostty-web
  actually completed fastest at 20.3 s).
- Ctrl+C under flood: 47 ms vs 1,124 ms recovery (~24×) — **but see
  the caveat below**.
- Input latency under load: 11.6 ms vs 36.1 ms p50.

**Caveat on the 24× interrupt number
([#10](https://github.com/mxschmitt/ghostty-xterm-bench/issues/10)):**
the xterm.js flow control used a 32 MiB pause watermark — ~335× VS
Code's real 100 KB constant. A large window flatters xterm's
*throughput* (fewer pauses) but plausibly inflates its *interrupt
latency* (more queued backlog to chew through before your Ctrl+C's
effect is visible). Whether 24× survives at VS Code's actual constants
is a hypothesis, not a measurement, until the PTY race harness is
rebuilt with the watermarks as sweep-able flags. Treat the interrupt
row accordingly.

The current architecture (full ghostty, Metal renderer, utilityProcess)
should meet or beat those numbers — the parser is the same and the
renderer is strictly better — but that's an expectation, not a
measurement. Rebuilding the cross-terminal harnesses against the new
embedding is the main open workstream.

## How it works

```
┌────────────────────────┐   uint32 IOSurfaceID    ┌───────────────────┐
│ utilityProcess (host)  │ ──── parentPort ──────► │ main process      │
│  ghostty:              │ ◄─── frame-ack ──────── │  IOSurfaceLookup  │
│   PTY + shell          │                         │  sharedTexture    │
│   VT parse, input enc  │                         │  .importShared…   │
│   fonts, Metal render  │                         └────────┬──────────┘
│   → IOSurface          │                                  │ zero-copy
└────────────────────────┘                                  ▼
                                                   ┌───────────────────┐
                                                   │ sandboxed renderer│
                                                   │  VideoFrame →     │
                                                   │  <canvas>         │
                                                   └───────────────────┘
```

Two small patches to a pinned ghostty checkout make this possible
(`patches/`, applied by `npm run setup:ghostty`):

1. **`0001` — headless apprt platform.** `GHOSTTY_PLATFORM_HEADLESS`
   (a surface with no NSView; the Metal backend's IOSurfaceLayer works
   standalone) plus `ghostty_surface_headless_frame()` returning the
   last presented IOSurface. This is the piece worth proposing
   upstream — small, additive, independently useful for screenshots,
   testing, and embedding.
2. **`0002` — global IOSurfaces for headless targets.** Frames must be
   representable cross-process; `kIOSurfaceIsGlobal` makes a frame a
   lookup-able `uint32`. ⚠️ Deprecated by Apple and **insecure** (any
   local process that guesses an ID can read the terminal's pixels) —
   acceptable for research, not for shipping. The production path is a
   mach-port handoff (`IOSurfaceCreateMachPort`), which needs a small
   native channel since Electron's `parentPort` can't carry mach
   send-rights.

The N-API addon (`packages/electron-ghostty/src/addon.c`, ~700 lines)
is pure marshalling around `ghostty.h` — ghostty does the work.

## Platform matrix (honest)

| | status |
|---|---|
| macOS (arm64) | ✅ working end-to-end: Metal render, IOSurface zero-copy, CI runs e2e + integration + DOM benches |
| Linux | 🟡 the patched libghostty **compiles** in CI and the DOM baselines run under xvfb; native presentation needs an EGL/GBM/dmabuf presenter (probe experiments in `native/renderer-poc/`, not yet reproducible/integrated) |
| Windows | ⬜ no presentation path in the current architecture. (The previous CPU-rasterizer iteration had a working D3D11/DirectWrite producer — last at [`1a4357c`](../../tree/1a4357c); porting that idea to ghostty's D3D backend is unexplored) |

## Fairness engineering

Most of the historical numbers' credibility work is documented in the
[`1a4357c` README](../../blob/1a4357c/README.md) ("Fairness
engineering": same pixels, same finish line, flow control for xterm,
`zsh -f` + READY handshakes, backgroundThrottling off, inert
sentinels, pipe-ceiling controls). Two rules carried into the current
benchmarks:

- **Same finish line** — the clock stops when output is *presented*
  (frame confirmed), or at a state ghostty itself observes (shell
  exit), never "the bytes were swallowed".
- **Interleaved runs** — A,B,A,B per iteration so machine drift hits
  both configurations equally (`bench/engine-placement.js`).

## Run it

macOS (arm64 tested) — Node ≥ 20, Xcode CLT,
[zig](https://ziglang.org) matching ghostty's pin (0.15.2):

```bash
npm install
npm run setup:ghostty  # clone ghostty into vendor/, apply patches, zig build (~5 min)
npm run build:native   # node-gyp build of the N-API addon
npm run payload        # generate the 1 MiB test payload
npm test               # e2e against real IOSurface pixels, no GUI needed
npm run demo           # a live shell, ghostty-rendered, in Electron
npm run bench          # DOM flood benchmarks (xterm.js, ghostty-web)
node bench/engine-placement.js   # engine placement comparison (5x2 runs)
```

On Linux the same steps build the fork and run the DOM benchmarks
under xvfb; the native embedding is macOS-only for now.

## Layout

```
packages/electron-ghostty/  the embedding as a reusable package
  index.js                    GhosttyTerminal (engines, present loop, input)
  host.js                     utilityProcess engine host (default placement)
  preload.js                  sandboxed renderer side (canvas paint + input)
  src/addon.c                 N-API wrapper around patched libghostty
demo-ghostty-renderer/      live interactive shell using the package
bench/                      flood (DOM terminals) + engine-placement
patches/                    the two ghostty fork patches
scripts/                    ghostty build, payload gen, chart gen, CI summary
test/                       e2e (pixels) + Electron integration suites
docs/                       design notes (see header disclaimers for age)
native/renderer-poc/        Linux EGL/headless probe experiments
```

## Caveats

- Research-grade. The package is not published and its API will change.
- Patch `0002`'s global IOSurfaces mean terminal pixels are readable by
  any local process — do not ship this as-is (see above).
- ghostty is pinned (`scripts/setup-ghostty.sh`); the embedding pokes
  one private detail (the IOSurfaceLayer `contents` property) that an
  upstream API should replace.
- Absolute wall times vary with machine load; per-run pairings and
  ratios are the stable result.
