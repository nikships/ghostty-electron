'use strict';
/**
 * In-terminal flood, native backend: the ghostty embedding
 * (packages/electron-ghostty) rendering into a real sandboxed window
 * via sharedTexture — the production path.
 *
 * Methodological difference vs the DOM backends, stated up front:
 * DOM terminals get payload bytes written straight into their parser
 * (term.write()); ghostty owns its PTY, so the payload goes through
 * `cat payload` in a real shell — the native number INCLUDES
 * PTY/kernel-pipe overhead the DOM numbers don't pay. parseMs is
 * structurally unmeasurable here (parsing happens on ghostty's IO
 * thread, interleaved with render) and is reported as null.
 *
 * Finish line matches the DOM harness: last frame actually presented
 * (shell exit observed by ghostty, then the final frame lands; frames
 * are counted at sharedTexture import time).
 *
 * Usage: electron bench/flood-native-main.js [--repeat N] [--engine main|utility]
 */
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { GhosttyTerminal } = require('electron-ghostty');

const PAYLOAD = path.join(__dirname, '..', 'payload.txt');
if (!fs.existsSync(PAYLOAD)) {
  console.error('payload.txt not found — run `npm run payload` first');
  process.exit(1);
}

const argv = process.argv;
const intFlag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 ? parseInt(argv[i + 1], 10) : fallback;
};
const REPEAT = intFlag('--repeat', 1);
const engineIdx = argv.indexOf('--engine');
const ENGINE = engineIdx !== -1 ? argv[engineIdx + 1] : undefined;

setTimeout(() => {
  console.error('watchdog: benchmark did not complete within 180s');
  app.exit(1);
}, 180_000);

app.whenReady().then(async () => {
  const scale = screen.getPrimaryDisplay().scaleFactor;

  // Match the DOM harness's grid as closely as ghostty's cell metrics
  // allow: the DOM benches run 120x30-ish in a 1000x700 window @2x.
  const term = new GhosttyTerminal({
    scale,
    fontSize: 13,
    ...(ENGINE ? { engine: ENGINE } : {}),
    command: '/bin/zsh -f',
  });

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: true,
    title: 'ghostty flood',
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
      preload: require.resolve('electron-ghostty/preload'),
    },
  });

  let frames = 0;
  term.on('frame', () => frames++);

  term.once('ready', async () => {
    // Let the prompt settle so shell startup isn't in the measurement.
    await new Promise(r => setTimeout(r, 1500));
    const framesBefore = frames;
    const t0 = performance.now();
    term.text(
      `for i in $(seq ${REPEAT}); do cat ${JSON.stringify(PAYLOAD)}; done; exit`);
    term.key({ action: 1, keycode: 36, mods: 0 }); // Enter
    term.key({ action: 0, keycode: 36, mods: 0 });

    // Exit detection: the 'exit' event with a processExited poll as
    // backstop (same flake class as bench/engine-placement.js — a
    // lost event must fail loudly, not hang the watchdog).
    let finished = false;
    const poll = setInterval(() => {
      if (!finished && term.processExited()) onShellExit();
    }, 250);
    term.once('exit', onShellExit);

    async function onShellExit() {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      // Shell exited (ghostty observed the PTY close). Let the final
      // frame present, then stop the clock at the last frame count
      // change — the same "presented, not swallowed" line as the DOM
      // harness's double-rAF.
      let lastFrames = frames;
      let settle = 0;
      while (settle < 3) {
        await new Promise(r => setTimeout(r, 16));
        if (frames === lastFrames) settle++;
        else { lastFrames = frames; settle = 0; }
      }
      const e2eMs = performance.now() - t0;
      const size = await term.sizeAsync().catch(() => null);
      const out = {
        backend: 'ghostty embedded (Metal, sharedTexture)',
        mode: REPEAT > 1 ? 'sustained' : 'burst',
        payloadBytes: fs.statSync(PAYLOAD).size * REPEAT,
        parseMs: null, // interleaved on ghostty's IO thread; not separable
        e2eMs,
        frames: frames - framesBefore,
        cols: size?.cols, rows: size?.rows,
        scale,
        engine: term.engine,
        electronVersion: process.versions.electron,
        chromiumVersion: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
      };
      console.log(JSON.stringify(out, null, 2));
      const resultsDir = path.join(__dirname, '..', 'results');
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(resultsDir, 'ghostty.json'), JSON.stringify(out, null, 2));
      term.destroy();
      app.exit(0);
    }
  });

  term.attach(win.webContents);
  win.loadFile(path.join(__dirname, 'engine-placement.html'));
});

app.on('window-all-closed', () => app.quit());
