# electron-ghostty

**Experimental — pure research, not published, expect breakage.**

This package exists to prove one thing: you can reuse essentially all
of [ghostty](https://github.com/ghostty-org/ghostty) — PTY + shell, VT
parsing, key/mouse encoding, selection, fonts/shaping, Metal (GPU)
rendering — inside an Electron app, and use Electron purely as the
window/compositor. No forked Chromium, no pixels copied over IPC:
ghostty presents into an IOSurface and Electron's
[`sharedTexture`](https://electronjs.org/docs/latest/api/shared-texture)
module imports it **zero-copy** into a sandboxed `<canvas>` as a W3C
`VideoFrame` (the same path `<video>` frames take).

What's left for this package is only the glue: tick ghostty's app
loop, forward input, ship each presented frame.

macOS-only for now (Metal + IOSurface); Linux needs an EGL/GBM
presenter, Windows a D3D11 one — see `docs/ghostty-renderer-reuse.md`
at the repo root.

## Usage

Main process:

```js
const { app, BrowserWindow, screen } = require('electron');
const { GhosttyTerminal } = require('electron-ghostty');

app.whenReady().then(() => {
  const term = new GhosttyTerminal({
    scale: screen.getPrimaryDisplay().scaleFactor,
    fontSize: 13,
    // command: 'htop',  // default: the user's shell, like a real window
  });

  const win = new BrowserWindow({
    webPreferences: {
      sandbox: true,               // stays fully sandboxed — frames are
      backgroundThrottling: false, // GPU surfaces, not pixels over IPC
      preload: require.resolve('electron-ghostty/preload'),
    },
  });

  term.attach(win.webContents);
  term.on('exit', () => app.quit());
  win.on('closed', () => term.destroy());
  win.loadFile('index.html');
});
```

Renderer: any sandboxed page with a canvas marked for ghostty. The
canvas element's CSS size drives the terminal size — resize it (flexbox,
ResizeObserver-visible changes, anything) and ghostty reflows the grid
and resizes the PTY (SIGWINCH) automatically:

```html
<canvas data-ghostty tabindex="0" style="width: 100%; height: 100%"></canvas>
```

That's all: the preload paints frames into that canvas and forwards
keyboard/mouse/paste events to ghostty's own encoders (kitty keyboard
protocol, mouse tracking modes, scrollback routing).

## API

`new GhosttyTerminal(opts)` — spawns the shell immediately.

| option | |
|---|---|
| `scale` | devicePixelRatio of the target display (default 2) |
| `fontSize?` | pt |
| `command?` | run this instead of the user's shell. Ghostty execs it directly (login-shell exec), so compound commands need `sh -c '…'` |
| `widthPx?`, `heightPx?` | initial surface size; the attached canvas takes over as soon as the renderer reports |

Methods/events on the instance:

- `attach(webContents)` — bind to a window; the present loop starts when
  the preload signals ready.
- `resize(widthPx, heightPx)`, `size()` → `{cols, rows, widthPx,
  heightPx, cellWidth, cellHeight}` (ghostty derives the grid).
- `text(str)`, `key(event)`, `mouseButton/mousePos/mouseScroll(…)` —
  programmatic input, same encoders as the preload path.
- `destroy()` — synchronous teardown; ghostty kills + reaps the shell.
- events: `ready`, `exit` (child process ended), `present-error`.

Low-level: `require('electron-ghostty/addon')` exposes the raw N-API
binding (`load()`, `available()`) for tests and embedders that run the
tick/present loop themselves — see `src/addon.c` for that surface.

## Building

The addon links a **patched** libghostty (headless apprt platform —
`patches/` at the repo root adds `ghostty_surface_headless_frame()`):

```bash
npm run setup:ghostty   # repo root: clone ghostty, apply patch, zig build
npm run build:native    # node-gyp rebuild of this package
```
