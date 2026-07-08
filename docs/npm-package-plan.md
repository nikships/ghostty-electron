# Investigation: a reusable npm package for ghostty-in-Electron

Goal: `npm install electron-ghostty` (name TBD) and get a fast, sandboxed,
libghostty-backed terminal inside any Electron app — the way `@xterm/xterm`
is consumed today, but with parsing and rasterization out of the renderer.

This is a plan, not an implementation.

## What we already have (in this repo)

The demo is accidentally ~70% of the package:

| Piece | Where it lives today | Package-ready? |
|---|---|---|
| VT session core (parse, text, keys, selection, search hooks) | `native/src/vt.c` | yes — platform-independent, tested |
| macOS presenter (CoreText → IOSurface, dirty rows) | `native/src/producer_mac.m` | yes |
| Present loop (dirty-gated, ack-gated double buffering) | duplicated in `demo/` and `bench/` (flood-native + pty native runner) | needs extraction into one module |
| Renderer consumer (VideoFrame → canvas, acks) | `demo/preload-ghostty.js` | needs extraction + de-demo-ing |
| Input (mode-aware keys, selection, IME, scroll, search) | demo main + preload | needs API-ification |
| Tests (pixel, conformance, fuzz, equivalence) | `test/` | reusable nearly as-is |

## Proposed package shape

One package, three entry points (mirrors how Electron apps are structured):

```
electron-ghostty/
  main.js        // main-process side
  renderer.js    // renderer/preload side
  native/        // N-API addon (prebuilt per platform)
```

**Main process** — owns the session and the present loop:

```js
const { GhosttyTerminal } = require('electron-ghostty/main');

const term = new GhosttyTerminal({ cols: 120, rows: 30, fontSize: 13 });
term.attach(win.webContents);        // starts the sharedTexture present loop
term.write(chunk);                    // PTY data in (from node-pty etc.)
term.onInput((bytes) => pty.write(bytes)); // encoded keys out
term.resize(cols, rows);
term.dispose();
// plus: selection events, getText(), search(), scroll()
```

**Renderer** — a custom element / mount function:

```js
import { mount } from 'electron-ghostty/renderer';
mount(document.getElementById('terminal')); // canvas + input + IME + acks
```

The package does NOT own the PTY (bring your own node-pty), matching
xterm.js's separation and keeping node-pty's platform baggage out.

## Work plan

1. **Extract the present loop** into `main.js` (one copy instead of three);
   the demo/benches in this repo become its first consumers. (S)
2. **Extract the consumer** (`renderer.js`): canvas mount, frame receive +
   ack, input capture (keys, mouse selection, wheel, IME, Cmd shortcuts as
   configurable), stats hook. (M)
3. **API design pass**: events (`onSelection`, `onTitle`, `onBell`),
   theming (palette override), font config. (M)
4. **Prebuilds**: `prebuildify`/`node-gyp-build` for darwin-arm64/x64 —
   the addon is NAPI so one prebuild per platform covers all Electron
   versions. libghostty-vt is statically linked, so consumers never need
   zig. CI already builds all three OSes. (M)
5. **Windows/Linux presenters** (D3D11+DirectWrite / dmabuf) — the addon's
   platform-hook interface is already in place; ship VT-only on those
   platforms first (`term.getText()` works everywhere; rendering
   availability is feature-detected via `render` export presence). (L, per
   platform)
6. **Docs + example app** (a 50-line terminal). (S)

Total effort estimate: items 1–4 + 6 ≈ a focused week; presenters are the
long pole and can ship after v0.1.

## Risks and open questions

- **libghostty-vt is alpha, untagged, with an unstable ABI.** The package
  must pin an exact ghostty commit and vendor the built static lib in the
  prebuilds. Every ghostty bump is a potential breaking change until
  upstream tags releases. This is THE risk; everything else is engineering.
- **Electron floor: ≥41** (sharedTexture module) — enforce via
  `peerDependencies` note and a runtime feature check with a clear error.
- **`backgroundThrottling: false` requirement** for the consumer window (or
  frame acks stall when occluded) — document loudly; possibly auto-warn.
- **License**: ghostty is MIT — compatible with an MIT package; keep
  upstream attribution for the vendored static lib.
- **Name/scope**: `electron-ghostty` implies official ghostty backing —
  consider `@mxschmitt/electron-ghostty` or a neutral name, and talk to the
  ghostty project before taking the bare name.
- **Sandboxed-preload constraint**: `renderer.js` must work in
  `sandbox: true` preloads (only bundled requires) — it already does in the
  demo; keep it dependency-free.
- **Multiple terminals per window**: the receiver API
  (`setSharedTextureReceiver`) is per-frame global — needs a demux layer
  (seq → terminal id in the transfer metadata) before v0.1 supports splits.

## Verdict

Feasible and mostly extraction work; the performance/correctness core is
already built and CI-proven here. The alpha-ness of libghostty-vt makes this
a "pin-and-vendor" package for now, honest about its experimental status —
which is also exactly the artifact that would make an upstream conversation
(VS Code, ghostty) concrete.
