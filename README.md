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
| macOS arm64 | 20.1 MB/s | 219.3 MB/s | **10.9×** |
| Windows x64 (CI) | _see CI job summary_ | _see CI job summary_ | ~10× |

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

### Feel it yourself — `npm run demo` (macOS)

Two windows, each a real interactive shell: left xterm.js, right ghostty
(with mouse selection, Cmd+C/Cmd+V, scrollback, mode-aware arrow keys for
vim/less, stats overlays). Run `time cat payload.txt`, `find /`, or hold a
key in vim, side by side.

## Platform matrix

| | macOS (arm64) | Windows (x64) | Linux |
|---|---|---|---|
| libghostty-vt build (zig) | ✅ | ✅ | untested |
| parser benchmark + conformance/fuzz tests | ✅ | ✅ | untested |
| xterm.js baseline benchmark | ✅ | ✅ | untested |
| native presentation (sharedTexture producer) | ✅ IOSurface + CoreText | ⬜ needs a D3D11 + DirectWrite port | ⬜ needs dmabuf |
| PTY race + interactive demo | ✅ | ⬜ (ConPTY + producer port) | ⬜ |

The addon is split accordingly: `native/src/vt.c` (session, parsing, text
readout, key encoding, selection) builds everywhere; `producer_mac.m` is the
macOS presentation layer; `producer_stub.c` covers other platforms until
their producers exist. Electron's `sharedTexture` API takes a D3D11
`ntHandle` on Windows, so the port is "same architecture, different platform
APIs" — not a redesign.

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
   work. The fuzzer found one genuine divergence — **DECRC after a DECSTBM
   scroll** (ghostty restores the absolute saved row, xterm.js the
   scroll-adjusted one) — which is pinned in a dedicated test so a behavior
   change in either engine surfaces.
4. **Electron integration** — the real apps run end-to-end on CI: both
   benchmarks produce sane per-stage stats and screenshots, the PTY race
   completes at 8 MiB with valid metrics, and the demo round-trips a live
   zsh echo through both keyboard→PTY→parser→render pipelines.

CI runs the full suite on macOS (Apple Silicon runner, including the
Electron GUI apps and benchmarks — numbers in each run's job summary) and
the portable subset plus xterm baseline on Windows.

Worth adding as follow-ups: input-to-glass latency probes with an external
clock, long-run soak tests for leaks (the CPU/mem sampling is a start), a
Linux job, and tracking benchmark history across commits.

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
