# Bug: TUI (htop) renders blank/stale for ~1s after launch

**Status:** Reproduced and narrowed with hard evidence to the
sharedTexture→canvas **window-compositor-commit** layer, *below* our JS and
the addon. Speculative fixes tried and rejected (see "What didn't work").
Needs a source-level Electron build (Linux env) to fix properly. All
speculative hacks have been reverted; the repo is back to a clean state except
the one genuinely-correct side fix (query responses).

## Symptom

Demo (`npm run demo`), run `htop` in the right (ghostty) pane. For ~1 second
htop shows a half-drawn skeleton: the F-key bar has colored button
**backgrounds but no label text** ("F1Help F2Setup…" missing) and the process
list is empty. htop's next ~1 Hz repaint fills it in. The left (xterm.js) pane
is correct almost immediately.

## Hard evidence (what nails it)

Instrumented the real app to compare, per frame, **what the addon wrote to the
IOSurface** (`readPixels`) against **what the consumer decodes from the
received VideoFrame** (getImageData after `drawImage`). Ran 5×:

```
run 1: 0 STALE / 21 frames
run 2: 0 STALE / 20 frames
run 3: 0 STALE / 19 frames
run 4: 0 STALE / 19 frames
run 5: 0 STALE / 21 frames
```

Then changed the consumer to sample the **visible canvas** (not a fresh
readback) after `drawImage`: also **0 stale, 3/3 runs**. And the present-loop
log shows a full 30-row frame is rendered, imported, sent AND acked at
~1900 ms — yet a `capturePage()` screenshot at 2100 ms shows the empty F-bar.

Conclusion chain:
1. The addon renders correctly (grid + surface pixels correct throughout).
2. `sendSharedTexture` delivers the correct texture (VideoFrame decodes to the
   exact bytes the addon wrote — 0 mismatches in 100 frames).
3. `drawImage(videoFrame)` updates the canvas **backing store** correctly
   (getImageData on the visible canvas returns the right pixels).
4. **Yet the window shows the previous frame.** So the missing step is the
   **compositor commit / window present** for that canvas paint.

The paint happens inside the `setSharedTextureReceiver` callback (a plain
async IPC callback). When the producer (terminal) then goes idle right after —
htop draws its whole screen in one burst, then pauses ~1 s — nothing else
schedules a compositor frame, so the last canvas paint sits un-presented until
some unrelated event (htop's next repaint, a mouse move, a `capturePage`)
forces a commit.

This matches every observed detail: xterm.js is fine (in-process WebGL, no
cross-process canvas paint); it "fixes itself in a second" (htop's next
repaint); `getText()` shows labels while the screen doesn't; and it's timing
dependent (only when a paint lands right before idle).

## Sharpest evidence (added after deeper digging, 3–5 runs each)

Instrumented the consumer to decode the **received VideoFrame** and read back
its F-bar row, and the addon to report per-surface content:

- During htop's opening burst, every frame the present loop renders+sends has
  an **empty F-bar** (`teal=0`) — because htop hadn't emitted the F-bar bytes
  yet at those render instants.
- The F-bar bytes arrive in a later chunk of the same burst; `getText()`
  confirms they land in libghostty's grid.
- Exactly **one more `addon.render()` after the burst** produces a frame with
  the F-bar (`teal=224`), then `render()` returns null (clean). So the addon
  is correct — the fix is purely "send that one trailing frame."
- A faithful simulation of the demo present loop **with acks flowing** DOES
  send that trailing frame (final presented surface `teal=224`). It only fails
  when **acks stop**.

The ack comes from the consumer's `frame-presented`, historically sent from a
double-`requestAnimationFrame`. rAF only fires while the window is
compositing. So there is a **circular dependency**: present-loop gate waits
for ack → ack waits for rAF → rAF waits for the window to composite → which
won't happen again until a new frame is presented. When htop goes idle right
after its burst, that loop can wedge, and the trailing F-bar frame never ships.

BUT: acking immediately (no rAF) so acks always flow **still** left the F-bar
blank on screen (`present 0.8ms`, top rows updating, bottom blank). So even
with the trailing frame sent and acked, its pixels don't reach the window.
That is the residual, below-JS part.

## What didn't work (reverted — don't re-try these)

- **Surface ring / triple+ buffering** (rings of 3 and 8): hypothesis was that
  re-importing a recently-used IOSurface handle hit a stale cached GPU texture.
  Tested rings up to 8 — htop still blank. Ruled out; reverted the addon to 2
  surfaces.
- **`drawImage` inside `requestAnimationFrame`** (single rAF, and a continuous
  rAF paint loop): still blank at t=2100 in the demo. rAF *should* schedule a
  commit, but on macOS it didn't clear the symptom in the demo — either the
  rAF callback isn't driving a compositor frame for the sandboxed OSR-consumer
  window, or the commit is coalesced away when nothing else is animating.
- **`getContext('2d', { desynchronized: true })` + `clearRect`**: no change.
- **Full-canvas `fillRect` before `drawImage`** (force full damage rect): no change.
- **Continuous bounded rAF paint loop** redrawing the latest frame as an
  `ImageBitmap` for ~1.2s after each frame (keeps the compositor running): no
  change — F-bar still blank while the loop demonstrably runs.
- **Ack immediately instead of after double-rAF** (breaks the ack↔rAF↔commit
  circular stall so acks always flow): the trailing F-bar frame is now sent
  and acked, but the window STILL shows it blank. This is the key result that
  localizes the residual bug below the JS API.
- **Deferred VideoFrame/import release** (hold prev frame+import until next):
  **stalls** — holding the consumer's imported ref couples to the main
  process's 2-surface reuse gate and the ack loop wedges. (A ring of surfaces
  would be needed to even try this, and rings alone didn't help.)
- **`ImageBitmapRenderingContext.transferFromImageBitmap`** instead of 2D
  `drawImage` (the purpose-built decoded-frame display path, clean layer
  invalidation): F-bar still blank, though the *shape* of what's shown
  differs (the selection bar renders full-width where 2D cut it off) — so the
  canvas layer IS updating differently, just still not showing the trailing
  frame's bottom rows. Combined with immediate-ack: still blank.

## Strong caveat on the macOS observation method

Every screenshot here was taken with `webContents.capturePage()` from the
main process. That every single presentation path (2D drawImage, +fillRect,
bitmaprenderer, continuous rAF loop) and every ack strategy produced the
**identical** blank-F-bar `capturePage` output is itself suspicious — it may
mean `capturePage` is snapshotting a stale/cached compositor frame rather than
the live window, OR that the bug is truly universal below the JS layer. I
could not get an independent ground-truth observation on this machine
(`screencapture -R` needs screen-recording permission the sandbox lacks).

**FIRST thing to do on Linux:** get a ground-truth capture that does NOT go
through `capturePage` — an external screen grab, or an OS screenshot tool —
at the moment the F-bar is blank. If an external grab shows the F-bar present
while `capturePage` shows it blank, the "bug" in all my screenshots was a
capturePage artifact and the real remaining issue is narrower (or absent) than
it looks. If the external grab also shows it blank, it's the genuine
compositor-present bug described above. This disambiguation is cheap and
changes everything downstream.

Notably the stats overlay (`<div>`, updated every 500ms) DID keep updating in
all runs — so the window composites; only the canvas layer's content lags.
That argues the canvas layer isn't re-uploading/invalidating for the
sharedTexture-fed paint when the producer idles, which is the precise thing to
instrument in the Chromium canvas/`cc` layer code.
- **Present-loop ack-gate timeout / re-tick on ack**: these address a
  *different* (real but not-this) failure mode; didn't fix htop.
- **`webContents.invalidate()` on the consumer window after each ack**
  (docs: "Schedules a full repaint of the window"): tested on macOS — htop
  still blank at t=2100. Either the scheduled repaint hadn't landed by the
  time the screen was observed, or invalidate() doesn't drive a present for
  this sandboxed OSR-consumer window. Worth re-testing on Linux (behavior of
  invalidate differs by platform/compositor), but it did NOT work on macOS.

## Minimal reproduction (pure Electron, no libghostty)

`../electron-sharedtexture-repro/` — its own git repo. `npm start`
(add `--raf` to test the rAF paint mode, `--keep` to eyeball).

Offscreen producer → sharedTexture → sandboxed consumer that `drawImage`s in
the receiver callback, burst-then-idle, 20 trials. Main samples the **actual
window** via `capturePage()`.

**Measurement caveat (important for the Linux investigation):** in the real
demo the staleness shows up in `capturePage()` screenshots and by eye. In this
minimal harness, `capturePage()` from the main process appears to *force a
commit* before capturing, so it can report 0 stale even when a human eye would
see the stale frame. Use `--keep` and watch the window: if it visibly lags but
the harness prints "ok", that confirms the bug is a missing compositor commit
(canvas correct, window not presented), which is exactly the app's symptom.
A source-level Electron build can instrument the OSR consumer's
`BeginMainFrame` / compositor commit path directly.

> Linux: offscreen shared textures need
> `enable-features=UseGpuMemoryBufferForOffscreenRendering` +
> `ignore-gpu-blocklist` (already set in `main.js`), plus a GPU or software GL.

## Where to look / how to fix (on Linux with Electron source)

The question is: **why doesn't a `drawImage` into a canvas, performed in a
sharedTexture receiver callback, schedule a window present when nothing else
is animating?** Candidate areas:

1. The sandboxed consumer window may not be requesting BeginFrames when there's
   no rAF driver and no DOM invalidation the compositor recognizes — a canvas
   2D paint should dirty the layer, but the OSR/shared-texture consumer path
   may not be marking it. Instrument `cc`/`LayerTreeHost` needs-commit for that
   window.
2. `sendSharedTexture`/`getVideoFrame` may deliver on a path that updates the
   canvas resource without scheduling a compositor commit for the host window.
   See the impl: electron/electron#47317 and
   https://www.electronjs.org/docs/latest/api/shared-texture.
3. If it's genuinely app-fixable: find the API that forces a present for the
   consumer window after each frame. On macOS, neither `requestAnimationFrame`
   (single or continuous loop) nor `webContents.invalidate()` cleared it — so
   the app-level present hook is either the wrong one or not honored for this
   window type. On Linux, re-try both, and additionally check whether the
   consumer window being `sandbox:true` + receiving via sharedTexture changes
   whether canvas paints request BeginFrames.

## Bonus fix already committed (keep it — it's correct and unrelated)

libghostty ignores VT sequences that require responses (DSR/CPR, device
attributes) unless "effects" are registered, so ncurses apps that *query* the
terminal would stall. The addon now registers `GHOSTTY_TERMINAL_OPT_WRITE_PTY`
+ `DEVICE_ATTRIBUTES`, buffers responses during `write()`, returns them, and
the apps feed them back to the PTY. Regression-tested (CPR/DA1/DA2). Not the
htop cause (htop sends no queries), but a genuine correctness fix.

## Debug harness (env-gated, currently reverted out of demo/main.js)

`GXB_AUTOTYPE='htop\r' electron demo/main.js` auto-types htop and saves timed
screenshots to `results/` (gitignored). The demo is at its clean committed
state now; re-add the small `if (process.env.GXB_AUTOTYPE)` block (it typed
htop at ~1200 ms and screenshotted at dense intervals 1700–4000 ms) or just
launch htop by hand and watch.

## Reference

- Electron sharedTexture docs: https://www.electronjs.org/docs/latest/api/shared-texture
- Implementing PR: https://github.com/electron/electron/pull/47317
