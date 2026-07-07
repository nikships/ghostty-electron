# Bug: TUI (htop) renders blank/stale for seconds after launch

**Status:** Reproduced, root-caused, minimal pure-Electron repro built. Fix
validated in the minimal repro; **not yet applied to this repo's apps** —
that's the remaining work (do it on Linux where you have an Electron build to
also confirm the platform-independence).

## Symptom

Launch the demo (`npm run demo`) and run `htop` in the right (ghostty) pane.
For several seconds htop shows a half-drawn skeleton: the F-key bar at the
bottom has the cyan/colored button *backgrounds* but **no label text**
("F1Help F2Setup…" missing), and the process list is empty. After a few
seconds (htop's next repaint) it fills in and is fine thereafter. The left
(xterm.js) pane draws htop correctly almost immediately.

## What it is NOT (ruled out with evidence)

- **Not the addon / libghostty rendering.** The grid is correct the whole
  time: `addon.getText()` returns the full `"F1Help F2Setup…"` bar while the
  screen shows empty buttons. Every headless replay of htop's real output
  through the addon (including through a faithful copy of the demo's
  ack-gated double-buffer present loop) produces pixel-identical output to a
  reference full render — `0` differing pixels. The addon is provably
  correct.
- **Not missing query responses.** Initial hypothesis was ncurses stalling on
  DSR/DA queries. htop's captured startup stream contains **no** device
  queries, so that wasn't the htop cause. (We *did* find and fix a real,
  separate issue here — libghostty ignores query sequences unless effects are
  registered — see "Bonus fix" below. Keep it; it's correct and needed for
  other apps, just not the htop symptom.)
- **Not `sendSharedTexture` latency.** Measured send + ack at ~1 ms each
  during startup.

## Root cause

A **producer-side frame-drop in the present loop**, not an Electron bug.

The present loop is ack-gated to keep one `sendSharedTexture` in flight at a
time (part of the double-buffering scheme: only render the back surface once
its last frame was acked). When a new frame becomes available *while a send
is in flight*, the current code **drops it** and relies on a *future* tick to
render the newer state.

That assumption breaks when the producer goes **idle**. htop draws its entire
screen in one burst of paints and then stops repainting (until its ~1 Hz
refresh). If the last frame of that burst is dropped because a send was in
flight, there is no subsequent paint/tick to re-send it — so the consumer
canvas is left showing an *earlier, half-drawn* frame from the burst until
htop's next repaint. The dropped frame *is* the fully-drawn screen.

This is why:
- xterm.js is fine — it renders in-process, no cross-process ack-gated
  forwarding with a drop.
- it "fixes itself after a few seconds" — htop's next 1 Hz repaint produces a
  fresh frame that isn't dropped.
- headless replays never caught it — they render on every step; only the
  *timing* of a drop landing on the final burst frame triggers it.

The Electron docs confirm the lifetime contract we're working within: the
`paint` texture must be released, and an imported texture kept alive until
`allReferencesReleased`. Nothing there is violated — the bug is purely our
"drop the frame and hope a later tick redraws it" logic.

## Minimal reproduction (pure Electron, no libghostty)

`../electron-sharedtexture-repro/` — run `npm start`. Shape mirrors the app:

- **producer**: offscreen `BrowserWindow`, `offscreen.useSharedTexture: true`,
  draws an incrementing frame number (encoded in pixel blocks + visible text).
- **main**: on each `paint`, imports the texture and forwards it to the
  consumer with one-in-flight ack gating — and **drops** paints that arrive
  while a send is in flight (exactly the app's logic).
- **consumer**: sandboxed visible window; `drawImage(videoFrame)` → canvas,
  reads back the encoded frame number, acks.

The harness runs 20 "bursts": draw frames for ~300 ms, then go **idle**, then
compare the highest frame the producer drew against the last frame the
consumer showed. On macOS ~15–20% of burst tails settle on a stale (behind)
frame:

```
BURST 3: drew=22 shown=21 ... STALE
BURST 16: drew=20 shown=19 ... STALE
BURST 20: drew=19 shown=18 ... STALE
3/20 bursts left the consumer showing a stale frame.
BUG REPRODUCED
```

`main.js` is the buggy version; `main-fixed.js` is the fix (below). Diff them.

> On Linux: the offscreen shared-texture path needs
> `enable-features=UseGpuMemoryBufferForOffscreenRendering` +
> `ignore-gpu-blocklist` (already set in `main.js` for `process.platform ===
> 'linux'`), and a real GPU or a software GL fallback. Confirm the repro
> reproduces there before/after the fix — that tells us whether the drop
> logic is the whole story on Linux too, or whether the dmabuf path adds its
> own recycling wrinkle.

## The fix (validated in the minimal repro)

Don't drop a frame that arrives during an in-flight send — **keep the newest
one as `pending` and flush it when the in-flight frame acks.** This guarantees
the last state always reaches the consumer even if the producer then goes
idle. Coalescing to only the newest keeps it O(1) and never backs up.

In the minimal repro (`main-fixed.js`), the change is:

```js
// paint handler: instead of  if (inFlight) { tex.release(); return; }
if (inFlight) {
  if (pending) pending.release();   // supersede older pending
  pending = tex;                    // keep newest
  return;
}
forward(tex);

// on ack:
inFlight = false;
if (pending) { const t = pending; pending = null; forward(t); }
```

### Applying it to this repo

The app's present loop is pull-based (a `setInterval` tick that calls
`addon.render()`), not push-based like the repro, so the fix is even simpler:
**after an ack, if the terminal is dirty, tick again immediately instead of
waiting for the next interval** — and more importantly, ensure a final render
happens after output goes idle. Concretely, in `demo/main.js` (and the same
loop copied into `pty-bench/main.js` and `ghostty-bench/main.js`):

- The gate `if (surfaceSeq[nextIndex] > maxAckedSeq) return;` correctly waits
  for the back surface's ack. The gap is that once that ack arrives, nothing
  guarantees a *re-render* if the terminal became dirty during the wait and no
  further interval tick produces a new frame before the producer idles.
- Fix option A (minimal): in the `frame-presented` handler, call
  `presentTick()` once more (it's a no-op if `addon.render()` returns null
  because nothing is dirty). This drains any state that changed during the
  send.
- Fix option B (robust): track a `dirtySinceLastRender` flag and, on ack, if
  set, force a tick. `addon.render()` already returns `null` when clean, so a
  spurious tick is cheap.

Prefer A for a one-liner; verify with the htop repro below.

## How to verify the fix in the app

There's a debug harness already wired for this (env-gated, no effect
normally): `GXB_AUTOTYPE='htop\r' electron demo/main.js` auto-types htop and
saves timed screenshots to `results/`. Before the fix, an early screenshot
shows the empty F-bar while `addon.getText()[29]` already contains the
labels. After the fix, the screen should match the grid within one frame of
the burst ending. (The harness lives behind `if (process.env.GXB_AUTOTYPE)`
in `demo/main.js` — currently reverted to clean; re-add if useful, or just
launch htop by hand.)

## Bonus fix already committed (keep it)

While chasing this we found and fixed a genuine, separate issue: libghostty
ignores VT sequences that require responses (DSR/CPR, device attributes)
unless "effects" are registered, so ncurses apps that *do* query the terminal
would stall. The addon now registers `GHOSTTY_TERMINAL_OPT_WRITE_PTY` +
`DEVICE_ATTRIBUTES`, buffers responses during `write()`, returns them, and the
apps feed them back to the PTY. Regression-tested (CPR/DA1/DA2). This is
correct and worth keeping regardless of the htop bug.

## Files touched during investigation

- `../electron-sharedtexture-repro/` — the minimal repro (its own git repo).
- `native/src/vt.c`, `session.h`, `producer_mac.m` — the query-response bonus
  fix (committed).
- `demo/main.js` — investigation instrumentation was added then reverted; it's
  back at the committed state. The present-loop fix still needs to be applied
  here.
