# Security

This is an **experimental research project**, not a hardened product.
Do not ship it as-is. Below is the honest threat model so nothing in
the README reads as a stronger safety claim than the code makes.

## Reporting

Found something? Open a GitHub issue, or for anything sensitive email
the repo owner. No formal SLA — this is research.

## Threat model

**Trust boundary: same user.** The design protects a sandboxed
*renderer* from the terminal engine, not the machine from a local
attacker. A process running as the same user can already screenshot,
`ptrace`, or read the memory of this app; nothing here defends against
that, and it isn't meant to.

- **Renderer sandbox.** The renderer runs with `sandbox: true` and
  receives only presented GPU frames (as `VideoFrame`s via
  `sharedTexture`) plus input events — never a Node context, never the
  raw PTY. A compromised renderer cannot reach the shell directly.
- **Engine isolation.** By default the terminal engine (PTY + shell +
  parser + renderer) runs in an Electron `utilityProcess`, so a wedged
  or crashed terminal can't take down window management.
- **Cross-process frame handoff.** Frames move as mach send-rights
  (`IOSurfaceCreateMachPort` → `IOSurfaceLookupFromMachPort`). The mach
  port is an unguessable capability. The *bootstrap rendezvous name*
  the parent and child use to exchange it, however, lives in the
  shared per-user bootstrap namespace — so a same-user process that
  learned or guessed the name could look up the send right and
  intercept or inject frames. The name is randomized (16 bytes of
  `crypto.randomBytes`) to make that impractical, but it is **not**
  treated as a security boundary: the boundary is same-user trust. An
  earlier iteration used the deprecated global-IOSurface path (any
  process could look up a frame by a small integer ID); that was
  removed in favor of the mach-port handoff.

## Running untrusted input

`GhosttyTerminal({ command })` execs the command directly through
ghostty (login-shell exec), and `cwd`/`config` are passed to ghostty
unchanged. Treat these like any `child_process` spawn: do not build
them from untrusted input without your own validation.

## Known non-hardened areas (research-acceptable)

- The demo and benchmarks enable `nodeIntegration` in *their own* bench
  pages (`bench/*.html`) — those are measurement harnesses, not the
  `electron-ghostty` package, whose renderer preload is sandbox-safe.
- Fixed-size input buffers in the native addon truncate pathologically
  large single inputs (multi-KB keystrokes / clipboard); a real
  embedder should not feed unbounded strings through the input API.
- macOS only; the fork patches are pinned to one ghostty commit.
