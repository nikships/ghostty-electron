# Reusing ghostty's real renderer: three approaches, measured

> **Outcome (this document is the historical record):** the repo now
> ships **approach A only** — ghostty embedded headlessly, owning
> PTY, parsing, input encoding, fonts, and Metal rendering, with a
> minimal ~350-line additive fork patch. Approaches B and C, the
> hand-written CoreText/D2D producers they were compared against, and
> the B benchmark harness were removed after the evaluation concluded
> (they live in git history). The analysis and measured numbers below
> are what drove that decision.

Goal: stop reimplementing terminal rendering in `producer_mac.m` /
`producer_win.cc` and call **ghostty's own rendering logic**
(GenericRenderer → Metal/OpenGL: font discovery, harfbuzz shaping, glyph
atlas, damage-tracked instanced GPU draws, IOSurface presentation)
through a C API — ideally the *identical* code path stock Ghostty.app
uses.

Status at evaluation time: all three approaches were implemented and
**verified on macOS** (each PoC rendered real content headlessly and
asserted on IOSurface pixels). Windows/Linux analysis below is from
source inspection plus runtime probes of the same fork.

The fork is a small additive patch series on ghostty `c41c6b8`,
applied by `scripts/apply-ghostty-patches.sh`, split upstream-shaped:
`patches/0001-build-install-libghostty-static-on-macos.patch` (the
build change alone) and
`patches/0002-apprt-embedded-headless-platform.patch` (the headless
platform + `ghostty_surface_headless_frame()`, ~300 lines; non-Darwin
targets get error.UnsupportedPlatform instead of a GL panic).

## What the patch adds (shared by A and B)

- `GHOSTTY_PLATFORM_HEADLESS`: an embedded-apprt surface with **no
  NSView**. The Metal backend already presents by assigning an
  IOSurface to a standalone `CALayer` — the view was only ever a place
  to hang that layer, so headless just skips the attach.
- `Metal.setLayerSize()`: headless surfaces have no view layout to set
  layer bounds; the renderer derives its target size from them.
- `ghostty_surface_headless_frame()`: returns the last **presented**
  IOSurface (CFRetained for the caller) + size/scale.
- `ghostty_standalone_renderer_*`: renderer-as-a-library (approach B).
- macOS now installs `libghostty.a` (full lib; previously only the
  Xcode-consumed xcframework path built it).

## Approach A — headless embedded surface (max ghostty reuse)

`ghostty_surface_new(app, {platform_tag: HEADLESS, command: ...})`.
**Ghostty owns everything**: PTY spawn, IO thread, VT parsing, fonts,
GPU rendering, damage, presentation. We own only an event loop that
ticks the app and reads frames.

- PoC: `native/renderer-poc/headless_a.c` — spawns a real shell
  command through ghostty's PTY, reads the rendered marker text back
  from the IOSurface. **PASS** (800×400@2x, correct size, text pixels
  present).
- This is the "least renderer logic in our code" option: our Electron
  main process would keep node-pty *out* entirely and let ghostty run
  the shell; frames go straight into `importSharedTexture({ioSurface})`.
- Cost: we inherit the whole app model (config system, sentry, app
  mailbox, actions we must ignore). Input must go through
  `ghostty_surface_key()` etc. — which is a feature (ghostty's full
  key encoding) but a migration for our IPC.

## Approach B — standalone renderer library (ghostty renders + owns the PTY)

`ghostty_standalone_renderer_new({cols, rows, px, scale, font_size})`,
then either `_write(bytes)` (embedder-owned byte source) or —
since the PTY milestone — **`_spawn(command)`**: ghostty opens its own
PTY (`pty.zig`), fork/execs the command, and reads + parses output on
a **native thread**, so output bytes never touch the JS thread; an
atomic `_seq()` counter lets the embedder poll for damage, `_input()`
writes keystrokes back, `_exited()` observes child exit, and
`_resize()` propagates winsize (SIGWINCH). No App/Surface/termio: the
patch constructs `Terminal` + `SharedGridSet` (ghostty's font
discovery/shaping/atlas) + `GenericRenderer(Metal)` directly, with a
stub apprt surface (headless platform) and a real-but-undrained
mailbox.

The grown API surface: `_draw/_frame` (render + present IOSurface),
`_metrics` (cell px), `_resize` (grid reflow + target + SIGWINCH),
`_scroll` (viewport scrollback), `_mouse_state`/`_encode_mouse`
(ghostty's own mouse protocol encoder), `_spawn/_input/_seq/_exited`
(ghostty-owned PTY).

- PoC: `native/renderer-poc/standalone_b.c` — feeds SGR-colored text,
  box drawing, CJK, emoji; asserts red/green glyph pixels landed.
  **PASS** (8 397 foreground px, 2 359 red, 1 098 green at 800×480).
- E2E: `test/standalone.test.js` (in `npm test`) — 7 tests without
  Electron, asserting on read-back frame pixels: VT render, spawned
  command output, input echo roundtrip through the PTY, exit
  observability, resize + SIGWINCH (`stty size` reflects the new
  grid), SGR mouse encoding, scrollback vs alt-screen scroll.
- Live app: `demo-ghostty-renderer/` runs a real shell **without
  node-pty** — ghostty spawns it, JS polls `_seq` at the present tick
  and forwards input/mouse/resize.
- Cost: it links the full ~200 MB static archive (the renderer's
  dependency closure includes glslang/spirv-cross for custom-shader
  support, breakpad, etc. — dead-strippable but present), and the
  construction pokes ghostty internals (`renderer.Options.thread` is
  left undefined because init/update/draw never touch it — true today,
  enforced by nothing).

## Approach C — hidden NSView, zero patches

Stock `ghostty.h`: create a borderless NSWindow that is never ordered
front, hand its view to `ghostty_surface_new`, and read
`view.layer.contents` — which *is* the presented IOSurface — from the
embedder.

- PoC: `native/renderer-poc/hidden_view_c.m`. **PASS** against the
  unpatched API surface (the patch is additive; nothing in C uses it).
- Value: proves the fork is a convenience, not a requirement, on
  macOS. Also the fallback if upstream rejects everything.
- Cost: requires AppKit + a window server session (no true headless
  CI), relies on an undocumented detail (layer.contents is an
  IOSurface), no explicit present/ack hook.

## The cross-platform reality

| | macOS | Windows | Linux |
|---|---|---|---|
| A (headless surface) | ✅ verified | 🟡 DLL builds+exports; dies at first GL call (no context) | 🟡 runs to renderer init in Docker; dies at first GL call |
| B (standalone renderer) | ✅ verified | 🟡 same cliff | 🟡 same cliff |
| C (hidden view) | ✅ verified | ❌ needs a native window + working GL backend | ❌ same |
| Our existing native producers | ✅ | ✅ D2D/DirectWrite | ⬜ needs dmabuf |

Empirically measured (not just source-read). The patched fork
**cross-compiles for all three platforms** — `zig build
-Dtarget=x86_64-linux-gnu` / `aarch64-linux-gnu` /
`x86_64-windows-gnu` all produce the full library
(`ghostty-internal.so` / `.dll`) *including* the new
`ghostty_surface_headless_frame` and `ghostty_standalone_renderer_*`
exports. Compiling was never the barrier; a GL context is.

**Linux, measured in Docker (aarch64, GPU-less):** linking the
cross-compiled `.so` and driving the real C ABI:

```
STAGE-OK: ghostty_init
STAGE-OK: config
STAGE-OK: app_new
thread panic: attempt to use null value
  pkg/opengl/Buffer.zig:13 create        <- glad fn pointer is null
  src/renderer/generic.zig:347 FrameState.init
  src/Surface.zig:551 (renderer init)
```

Everything up to and including the App works on Linux today. The
surface dies at the renderer's *first GL call* because nothing loaded
GL function pointers: for `apprt.embedded` the OpenGL backend's
`surfaceInit`/`threadEnter` are explicit no-op TODOs ("libghostty is
strictly broken for rendering on this platform"), unlike GTK where
GDK owns context creation. A second probe confirms the missing layer
is cheap to provide even in CI: EGL `EGL_PLATFORM_SURFACELESS_MESA` +
llvmpipe hands out a **GL 4.5 core context in the same GPU-less
container**. So headless Linux = (1) create a surfaceless EGL context
and `prepareContext(eglGetProcAddress)` in the embedded+headless
branch, (2) replace `present()`'s default-framebuffer blit (meaningless
without a window surface) with reading/exporting the FBO — glReadPixels
for an MVP, GBM/dmabuf export for the zero-copy Electron path.
`generic.zig` itself needed no changes to get this far.

**Windows:** the DLL builds with the same exports, but hits the same
no-GL-context cliff with two extra layers on top: a WGL context needs
a (hidden) window + pixel format dance or ANGLE, and Electron needs a
`D3D11_RESOURCE_MISC_SHARED_NTHANDLE` texture, so even a working GL
frame requires WGL/EGL↔D3D interop ghostty has no notion of. PTY is
not the blocker (ghostty's pty.zig has a ConPTY implementation).
Verdict unchanged: keep `producer_win.cc` — our D2D producer is
already the pragmatic Windows path and passes ghostty-vt-driven pixel
tests on CI.

## Comparison

| | A: headless surface | B: standalone renderer | C: hidden view |
|---|---|---|---|
| Renderer logic in our code | none | none (byte loop only) | none |
| PTY / process ownership | ghostty (full termio) | flexible: embedder bytes (_write) or ghostty-owned PTY (_spawn — node-pty eliminated) | ghostty |
| Patch size | ~120 lines | ~350 lines (includes A's base) | **0** |
| Identical pixels to Ghostty.app | yes | yes (same GenericRenderer+fonts) | yes |
| Headless CI | yes | yes | no (needs window server) |
| Upstream-ability | good — small, additive, useful generally | medium — pokes internals, wants API blessing | n/a |
| Fit with our bench/demo architecture | replaces pty-bench plumbing too | **drop-in for producer_mac.m** | escape hatch |
| Frame pacing control | tick + draw + frame poll | explicit write→draw→frame | poll only |
| Link cost | full libghostty (~200 MB .a, strippable) | same | same |

## If the requirement is "all three OSes": which approach wins?

**C is disqualified** outright — it needs a native NSView and
`ghostty.h`'s platform union has no Linux/Windows arm at all.

**A and B share the same missing layer** on Linux/Windows (a GL
context + a way to export the frame), so the real differentiators are
what else each approach drags in:

| work item | A (ghostty owns PTY+all) | B (renderer-as-library) |
|---|---|---|
| macOS | ✅ done | ✅ done (+ mouse/scroll/resize APIs) |
| Linux: GL context | same patch for both: surfaceless-EGL + `prepareContext(eglGetProcAddress)` in the headless branch (~100 lines; llvmpipe gives GL 4.5, ghostty needs 4.3, so CI runs GPU-less) | same |
| Linux: frame export | same for both: replace `present()`'s default-FBO blit with a GBM-allocated dmabuf-backed renderbuffer → `nativePixmap` handle for Electron (~200–300 lines, the only genuinely new code) | same |
| Windows: GL context | WGL desktop GL 4.3 on a hidden window. ANGLE is NOT an option: ghostty's GL backend requires desktop GL 4.3 (`OpenGL.zig:37`), ANGLE exposes only GLES | same |
| Windows: frame export | `WGL_NV_DX_interop2` to share the GL renderbuffer with a D3D11 NT-handle texture — vendor-extension territory, driver-dependent on Intel/AMD | same |
| PTY + process mgmt | ghostty's termio on all 3 OSes — ConPTY path exists but is untested under libghostty; all input must go through ghostty's key encoding | flexible: _spawn uses ghostty's pty.zig (posix now; ConPTY same caveat as A) or keep embedder bytes via _write |
| Windows fallback if GL interop fails | none — A is all-or-nothing per OS | **keep `producer_win.cc`** behind the same `create/write/draw/frame` addon interface |
| Extra APIs we must keep growing | input, clipboard, selection, selectors already exist in ghostty.h | mouse/scroll/resize now exist; selection/links still to add |

The Windows column is what decides it. For A, Windows support is
blocked until desktop-GL-4.3-plus-DX-interop works everywhere — a
hard dependency on the flakiest graphics path in the stack (or on
upstream ghostty growing a D3D backend). For B, Windows simply keeps
our existing D2D producer behind the *same JS-facing interface*,
because B's seam (`create/write/draw/frame`) is exactly the seam
`producer_win.cc` already implements. The render-equivalence and
conformance tests keep the two backends honest against each other.

**Verdict for the 3-OS requirement: B, deployed as "ghostty's renderer
wherever it can run, our producer where it can't":**

- macOS: ghostty GenericRenderer(Metal) — working today (demo + bench).
- Linux: ghostty GenericRenderer(OpenGL) + the EGL/GBM headless
  presenter patch (~300–400 well-scoped lines in the fork; measured:
  everything up to the first GL call already works, and a GL 4.5
  context is obtainable in a GPU-less container).
- Windows: `producer_win.cc` (D2D/DirectWrite) behind the same addon
  API until either WGL/DX-interop proves reliable or upstream grows a
  D3D backend.

A remains the better *upstream proposal* (smallest additive API), but
it cannot honestly claim Windows in the foreseeable future, and its
Linux path needs the identical presenter work as B anyway.

## Measured performance (same harness, same machine, same run)

`bench-standalone/` is a byte-for-byte clone of `ghostty-bench/`
(payload, 120×30 grid, 64 KiB chunks, 16 ms present cadence,
double-rAF frame-ack finish line) with only the presentation swapped.
macOS arm64 @2x, attended, warm runs (first standalone run pays ~15 ms
one-time font discovery — excluded):

| burst 1 MiB | parse | render | e2e |
|---|---|---|---|
| our CoreText producer | ~9 ms | ~2.3 ms | **~22 ms** |
| **approach B (ghostty renderer)** | ~25 ms | ~16 ms | **~39 ms** |
| xterm.js WebGL | 139 ms | (in parse) | **155 ms** |

| sustained 10 MiB | e2e |
|---|---|
| our CoreText producer | ~66–115 ms (median ~73) |
| **approach B** | ~98–107 ms (median ~98) |
| xterm.js WebGL | ~1 153 ms |

Reading: approach B is ~1.5–1.8× slower end-to-end than our
special-purpose producer — unsurprising, since ghostty's pipeline does
real font shaping/fallback and full GPU cell rebuilds where our
producer batches raw CTFontDrawGlyphs on dirty rows only — and still
**~4× (burst) to ~12× (sustained) faster than xterm.js**. Two caveats:
`parseMs` differs for structural reasons (approach B parses through
ghostty's internal Terminal stream; the producer uses libghostty-vt's
C API), and per-frame render cost for B (~4–5 ms/frame) buys pixel
parity with Ghostty.app (ligatures, fallback, emoji) that the producer
simply doesn't have. Both are far inside the 60/120 Hz budget; neither
renderer is the bottleneck — the JS-thread parse loop is.

## Recommendation

> **Historical note:** this section's letters predate the final naming.
> What the paragraph below calls "B" (ghostty's renderer + ghostty's
> PTY, everything owned by ghostty) is what shipped and is labeled
> **approach A** everywhere else in the repo today. The `~17 ms` /
> `4–12×` numbers were measured with the pre-rewrite benchmark harness
> (last at commit `1a4357c`) and are not reproducible from HEAD.

**B is the one to integrate**, and it's now integrated end-to-end:
`demo-ghostty-renderer/` runs ghostty's renderer AND ghostty's PTY
(node-pty fully removed — output bytes never touch the JS thread;
input/mouse/resize forwarded through the addon), with 7 e2e tests in
`npm test` asserting on read-back frame pixels. The benchmark confirms
the renderer switch costs ~17 ms on a 1 MiB burst and stays 4–12×
ahead of xterm.js — an acceptable price for Ghostty.app-identical text
rendering. **A is the one to
propose upstream** — a headless surface + presented-frame getter is
small, additive, and independently useful (screenshots, testing,
embedding), and it carries the `setLayerSize`/headless-platform
groundwork B needs anyway. C needs nothing from anyone and remains the
proof that embedders aren't blocked on the fork.

One real risk to flag before productionizing B: the returned IOSurface
is one slot of ghostty's triple-buffered swap chain, reused two
presents later. For Electron that's fine (`importSharedTexture` +
release per frame, same discipline the demo already implements), but a
consumer that holds a frame across presents will see it overwritten —
the honest fix is an upstream API that hands out +1-retained surfaces
with an explicit release, which is exactly the shape
`ghostty_surface_headless_frame` already has.

## Reproduce

> **Historical note:** only the headless PoC survives in the tree
> (`native/renderer-poc/headless_a.c`, plus the Linux EGL probes); the
> B and C PoCs were removed with the decision (last at commit
> `1a4357c`). `make test` runs what remains.

```bash
npm run setup:ghostty                    # clone + build vendor/ghostty (applies patches)
cd native/renderer-poc && make test     # headless PoC, pixel-asserting
```
