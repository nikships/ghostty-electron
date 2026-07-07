# ghostty-xterm-bench

A fair, measured comparison of two terminal architectures inside Electron:

1. **xterm.js + WebGL addon** — parse *and* render inside the Chromium
   renderer process. This is how VS Code's integrated terminal works today.
2. **libghostty-vt + sharedTexture** — [libghostty-vt](https://github.com/ghostty-org/ghostty)
   (ghostty's native VT engine) parses in the main process, a native addon
   draws the grid into an **IOSurface**, and Electron's `sharedTexture`
   module transfers it **zero-copy** into a fully sandboxed renderer
   `<canvas>` as a `VideoFrame`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/benchmarks-dark.svg">
  <img alt="Benchmark results: parser throughput 11x, 10MiB flood 18x, 1GiB PTY cat 2.2x, Ctrl+C response 21x in ghostty's favor" src="assets/benchmarks-light.svg">
</picture>

## Motivation

VS Code's terminal keeps everything — VT parsing, buffer state, rendering —
on the renderer process's JavaScript thread. That has two structural costs:
heavy output floods are parse-bound in JS, and they saturate the same thread
that handles your keystrokes, so the terminal feels worst exactly when it's
busiest. Proposals to swap in a native terminal engine were historically
dismissed as "you'd have to fork Chromium to get native pixels into the DOM"
(microsoft/vscode#236991 was closed as out of scope).

That premise changed: Electron ≥41 ships a `sharedTexture` module that turns
a native GPU surface (macOS `IOSurface`, Windows D3D11 `NT HANDLE`, Linux
dmabuf) into a W3C `VideoFrame` the sandboxed renderer can paint zero-copy —
the same path `<video>` and WebRTC frames use. So the interesting question
became answerable without forking anything:

> If a native terminal engine parsed in the main process and shipped frames
> to the DOM via sharedTexture, how would it actually compare to xterm.js —
> measured end-to-end, fairly?

This repo is that measurement: both terminals run in the same Electron
(42.5.0), on the same payloads, with the same grid (120×30 at
`devicePixelRatio`), and finish lines that mean "the frame was actually
presented", not "the bytes were swallowed".

## The three benchmark layers

Each layer isolates one slice of the stack. All numbers below: macOS,
Apple Silicon (M-series) @2x, attended runs, medians. Reproduce with the
commands shown; raw JSON lands in `results/`.

### 1. Parser only — `npm run bench:parse` (any OS, no GUI)

The identical byte stream through both VT engines in plain Node:

| | xterm.js headless | libghostty-vt | ratio |
|---|---|---|---|
| macOS arm64 (M-series) | 20.1 MB/s | 219.3 MB/s | **10.9×** |
| Windows x64 (CI runner) | 4.0 MB/s | 98.5 MB/s | **24.4×** |

The gap *widens* on Windows: the native parser loses less to the slower
hardware than the JS one does. (Windows numbers come from the GitHub-hosted
runner via CI — see any run's job summary; the Windows xterm-in-Electron
baseline also runs there: 1 MiB burst ≈ 423 ms e2e.)

### 2. In-terminal flood — `npm run bench` (Electron, macOS)

Feed the payload directly to each terminal at full speed and stop the clock
when the final frame is confirmed presented (double-rAF / frame ack):

| mode | xterm.js parse / e2e | ghostty parse / e2e | e2e speedup |
|---|---|---|---|
| burst (1 MiB) | 104.6 / 113.7 ms | 8.1 / 20.9 ms | **5.4×** |
| sustained (10 MiB) | 1170 / 1183 ms | 53.6 / 65.1 ms | **18.2×** |

ghostty's native draw cost for the entire sustained run is ~3 ms — dirty-row
tracking plus glyph runs make presentation nearly free; the gap is the parser.

### 3. The full-stack PTY race — `npm run bench:pty` (Electron, macOS)

A real zsh on a real PTY (node-pty). `cat` a 1 GiB file; the clock stops when
the completion sentinel is **visible on screen**. A separate run measures
interrupt recovery: Ctrl+C mid-flood, then time until a fresh echo is visible.

| terminal | cat 1 GiB | MB/s | Ctrl+C→response | CPU | mem growth |
|---|---|---|---|---|---|
| xterm.js | 54.9 s | 18.6 | 1007 ms | 5.9 s | 369 MB |
| ghostty | **24.6 s** | 41.6 | **48 ms** | 2.8 s | 49 MB |

Through a real PTY the plumbing dominates: node-pty delivers ~1 KB chunks and
caps the pipe at ~50–65 MB/s (a control run reports this ceiling), so the
completion gap compresses to **2.2×** — and at small sizes (≤8 MiB) vanishes
entirely. The metrics that stay dramatic are the responsiveness ones:
**21× faster interrupt recovery** (xterm has to chew its flow-control backlog
before your keystroke's effect appears), at ~2× less CPU and ~7× less memory
growth. This is the honest headline: *architecture buys you latency under
load more than it buys you raw completion time.*

### Input latency — `npm run bench:pty -- --latency` (macOS)

Keystroke → echo visible on screen, at an idle prompt and under a
2 000 lines/s "build output" load (under an *unthrottled* flood the screen
scrolls millions of lines/s and a typed echo never lands on a presented
frame in any terminal — unmeasurable by definition):

| terminal | idle p50 | busy p50 |
|---|---|---|
| xterm.js | 32.5 ms | 36.1 ms |
| ghostty | **17 ms** | **11.6 ms** |

### Leak soak — `npm run bench:pty -- --soak-min 10`

Ten minutes of continuous full-speed output per terminal, memory sampled
every 2 s, least-squares slope after warm-up must stay under 10 MB/min:
ghostty consumed **28.2 GB** (slope 0.29 MB/min), xterm 15.2 GB (slope 0) —
both flat, no leaks. CI runs a 2-minute version on every push.

### vs stock Ghostty.app — `npm run bench:stock` (macOS)

How much does Electron cost? Same 256 MiB, same write-side finish line
(`cat` completes; stock apps' screens can't be read programmatically):

| | stock Ghostty (native) | ghostty-in-Electron | xterm-in-Electron |
|---|---|---|---|
| cat 256 MiB | **3.5 s** | 5.6 s | 11.3 s |

Electron + node-pty's ~1 KB chunking costs the libghostty pipeline ~1.6×
vs the fully native app; xterm.js doubles it again.

### Does the CPU rasterizer need a GPU replacement? — `npm run bench:render`

Worst case by construction: 4K-equivalent surface, every cell changing
every frame (zero dirty-row savings). Result: **325 full redraws/s
(3.07 ms avg)** against the 8.3 ms 120 Hz budget — the CPU rasterizer holds
120 Hz at 4K full damage with ~2.7× headroom. Measured evidence that a
Metal/GPU pass isn't needed at current targets.

### Feel it yourself — `npm run demo` (macOS)

Two windows, each a real interactive shell: left xterm.js, right ghostty —
with mouse selection, double-click word selection, Cmd+C/Cmd+V, Cmd+F
search over scrollback, Cmd+click to open URLs, IME composition, cursor
blink, wheel scrollback, and mode-aware arrow keys for vim/less. Run
`time cat payload.txt`, `find /`, or hold a key in vim, side by side.

## Platform matrix

All three OSes run in CI on every push:

| | macOS (arm64) | Windows (x64) | Linux |
|---|---|---|---|
| libghostty-vt build (zig) | ✅ | ✅ (msvc ABI) | ✅ |
| parser benchmark + conformance/fuzz tests | ✅ | ✅ | ✅ |
| xterm.js baseline benchmark | ✅ | ✅ | ✅ (xvfb + SwiftShader) |
| native presentation producer | ✅ IOSurface + CoreText | ✅ D3D11 + DirectWrite — pixel + render-equivalence tests pass on CI (WARP) | ⬜ needs dmabuf |
| in-Electron sharedTexture GUI | ✅ | 🟡 implemented; validation on GPU-less runners in progress | ⬜ |
| PTY race + latency + soak | ✅ | 🟡 runs, but **ConPTY caps the pipe at ~0.1 MB/s** on runners — Windows PTY numbers measure ConPTY, not the terminals | ⬜ |

The addon split: `native/src/vt.c` (session, parsing, text readout, key
encoding, selection, search) builds everywhere; `producer_mac.m` (CoreText →
IOSurface) and `producer_win.cc` (DirectWrite/D2D → shared D3D11 textures,
hardware with WARP fallback) are the presentation layers; `producer_stub.c`
covers Linux until a dmabuf producer exists. The same pixel-level and
incremental-vs-full-redraw equivalence tests run against both renderers.

## Fairness engineering

Getting these numbers to mean something was most of the work. Everything
below is baked into the harnesses because we hit it:

- **Same pixels:** both render at `devicePixelRatio` (an early version ran
  ghostty at 1× — a 4× pixel discount, in ghostty's favor, fixed).
- **Same finish line:** "sentinel visible on screen", detected in the grid
  and confirmed presented — never "cat exited", which on a backlogged
  terminal happens minutes early.
- **Flow control for xterm:** VS Code-style PTY pause/resume + 4 ms IPC
  batching. Without it, per-chunk IPC collapses xterm's throughput ~250×
  and a 1 GiB flood OOMs the renderer. ghostty needs neither — main-process
  parse gives inherent backpressure.
- **`zsh -f` + READY handshake:** rc-file startup otherwise buffers the
  command for seconds and pollutes t₀.
- **`backgroundThrottling: false` everywhere:** an occluded window gets its
  rAF suspended — an unattended overnight run once reported xterm 11.9×
  slower at 1 GiB when ~18 of its 20 minutes were our detector waiting for a
  frame Chromium had parked. The corrected, attended number is 2.2×. (VS
  Code disables backgroundThrottling for the same class of reason.)
- **Inert sentinels:** written as `$((…))` arithmetic so the echoed command
  line can never false-match; matched with `endsWith` so a missing trailing
  newline can't hang detection.
- **Pipe-ceiling control:** the same file through node-pty into a no-op
  consumer, reported next to the results, so pipe-bound results are legible
  as such.

## What's proven, and how

Four test layers (`npm test` + `npm run test:integration`, all in CI):

1. **Addon tests** — pixel-level assertions against the actual IOSurface
   (`readPixels`): SGR colors land in the right cells, cursor drawn, box
   drawing renders as aligned geometry; dirty tracking across double
   buffering; scrollback; resize; selection; **mode-aware key encoding**
   (ArrowUp flips `\e[A`→`\eOA` under DECCKM, like vim expects).
2. **Render-equivalence invariant** — after any incremental update sequence,
   the frame must be pixel-identical to a from-scratch full redraw. This is
   the regression net for the entire "corrupted TUI" bug class (glyph bleed,
   dirty-tracking misses) — we caught real bugs with it.
3. **Conformance + fuzz** — curated VT streams *and* 40 seeded random
   streams diffed row-by-row against `@xterm/headless` (the exact emulator
   VS Code ships), including the full 1 MiB benchmark payload. The speed
   comparison only counts because both engines demonstrably do the same
   work. The fuzzer found two genuine emulator divergences (DECRC after a
   DECSTBM scroll; DECOM homing after DECSTBM) — both pinned as tests and
   written up with minimal repros in `docs/upstream-divergences.md`.
4. **Electron integration** — the real apps run end-to-end on CI: both
   benchmarks produce sane per-stage stats and screenshots, the PTY race
   completes at 8 MiB with valid metrics, and the demo round-trips a live
   zsh echo through both keyboard→PTY→parser→render pipelines.

CI runs the full suite on macOS (Apple Silicon runner, including the
Electron GUI apps and benchmarks — numbers in each run's job summary) and
the portable subset plus xterm baseline on Windows.

CI also runs the input-latency probe, a 2-minute soak, the render-stress
benchmark, and compares every metric against the previous main run in the
job summary (drift >20% gets flagged). See `docs/npm-package-plan.md` for
the plan to extract all of this into a reusable `electron-ghostty` package.

## Run it

macOS (arm64 tested) — Node ≥ 20, Xcode CLT, [zig](https://ziglang.org)
matching ghostty's pin (0.15.2):

```bash
npm install
npm run payload        # generate the 1 MiB test file
npm run setup:ghostty  # clone ghostty into vendor/ and build libghostty-vt
npm run build:native   # build the N-API addon
npm test               # addon + conformance + fuzz (fast, no GUI)
npm run bench:parse    # parser-only comparison (any OS)
npm run bench          # in-terminal burst + sustained (Electron)
npm run bench:pty      # the 1 GiB PTY race (add --mb 64 for a quick run)
npm run demo           # side-by-side live shells
```

On Windows, the same steps run everything except `bench`, `bench:pty`, and
`demo` (they need the macOS producer for the ghostty side).

## Layout

```
native/src/vt.c            platform-independent libghostty-vt session (all OSes)
native/src/producer_mac.m  macOS: CoreText → IOSurface presentation layer
native/src/producer_stub.c non-mac: VT-only until a platform producer exists
scripts/                   payload gen, ghostty build, parse bench, chart gen
xterm-bench/               baseline Electron app (xterm.js + WebGL addon)
ghostty-bench/             sharedTexture Electron app (producer in main process)
pty-bench/                 end-to-end race: cat via real PTYs, sentinel-timed
demo/                      side-by-side interactive shells (node-pty)
test/                      addon, conformance, fuzz, integration suites
bench.js                   in-terminal runner (burst + sustained) + table
```

## Caveats

- libghostty-vt is alpha; its headers warn of breaking changes. Pin the
  vendor checkout for stability.
- The macOS renderer is a CPU rasterizer into an IOSurface — already cheap
  enough (~sub-ms/frame incremental) to vanish in these numbers; ghostty's
  real GPU renderer isn't exposed through libghostty yet.
- Not implemented (doesn't affect the numbers): links, search, IME
  composition, ligatures, kitty graphics, blinking cursor.
- Absolute wall times vary with machine load; the per-run pairings and the
  ratios are the stable result. Every table above says which run produced it,
  and CI reproduces the small/medium configurations on every push.
