'use strict';
/**
 * Engine-placement benchmark: the SAME ghostty embedding, run with
 * engine:'main' (in the Electron main process, the original mode) vs
 * engine:'utility' (in a utilityProcess, the default). One Electron
 * app per (engine, run); results land in results/engine-placement.json.
 *
 * Per run:
 *   1. spawn a real shell in a real window (sandboxed renderer,
 *      sharedTexture presentation — the full production path)
 *   2. t0: send `cat payload.txt` x REPEAT (10 MiB) + exit via the PTY
 *   3. finish: the shell's exit observed by ghostty (both engines poll
 *      processExited at the same 8 ms interval, so the detection cost
 *      is identical)
 *   4. throughout, a 10 ms setInterval in the MAIN process records
 *      event-loop lag — the metric the utility process exists for:
 *      can a busy terminal stall window management?
 *
 * Usage: electron bench/engine-placement.js --engine main|utility
 *        node bench/engine-placement.js            (orchestrates 5x each)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESULT = path.join(ROOT, 'results', 'engine-placement.json');
const REPEAT = 100; // 100 x 1 MiB payload — a few seconds of sustained flood
const RUNS = 5;

const argv = process.argv;
const engineArg = argv.includes('--engine')
  ? argv[argv.indexOf('--engine') + 1]
  : null;

if (!engineArg) {
  // Orchestrator (plain node): run each engine RUNS times, interleaved
  // A,B,A,B,… so machine drift hits both placements equally.
  const { execFileSync } = require('child_process');
  const electron = require('electron');
  const all = { main: [], utility: [] };
  for (let i = 0; i < RUNS; i++) {
    for (const engine of ['main', 'utility']) {
      process.stdout.write(`run ${i + 1}/${RUNS} engine=${engine}\n`);
      execFileSync(electron, [__filename, '--engine', engine], {
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 300_000,
      });
      all[engine].push(JSON.parse(fs.readFileSync(RESULT, 'utf8')));
    }
  }
  fs.writeFileSync(
    path.join(ROOT, 'results', 'engine-placement-all.json'),
    JSON.stringify(all, null, 2));
  summarize(all);
  return;
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function summarize(all) {
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const engine of ['main', 'utility']) {
    const rs = all[engine];
    console.log(`\n=== engine: ${engine} (${rs.length} runs) ===`);
    console.log(`flood 100 MiB e2e  median ${med(rs.map(r => r.floodMs)).toFixed(0)} ms  [${rs.map(r => r.floodMs.toFixed(0)).join(', ')}]`);
    console.log(`create block       median ${med(rs.map(r => r.createBlockMs)).toFixed(1)} ms  [${rs.map(r => r.createBlockMs.toFixed(0)).join(', ')}]`);
    console.log(`first frame        median ${med(rs.map(r => r.firstFrameMs)).toFixed(0)} ms  [${rs.map(r => r.firstFrameMs.toFixed(0)).join(', ')}]`);
    console.log(`main-loop lag p50  median ${med(rs.map(r => r.lag.p50)).toFixed(1)} ms`);
    console.log(`main-loop lag p99  median ${med(rs.map(r => r.lag.p99)).toFixed(1)} ms`);
    console.log(`main-loop lag max  median ${med(rs.map(r => r.lag.max)).toFixed(1)} ms  [${rs.map(r => r.lag.max.toFixed(0)).join(', ')}]`);
    console.log(`frames presented   median ${med(rs.map(r => r.frames))}`);
  }
}

// ── Electron app: one measured run ──────────────────────────────────
const { app, BrowserWindow, screen } = require('electron');
const { GhosttyTerminal } = require('electron-ghostty');

app.whenReady().then(async () => {
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const payload = path.join(ROOT, 'payload.txt');
  if (!fs.existsSync(payload)) throw new Error('run `npm run payload` first');

  const createdAt = Date.now();
  // zsh -f: no rc files — the user's prompt plugins otherwise eat or
  // delay the typed command nondeterministically (README "Fairness
  // engineering": rc-file startup buffers the command and pollutes t0).
  //
  // createBlockMs: how long the constructor synchronously blocks THIS
  // process. In 'main' mode that's ghostty init + font discovery +
  // Metal setup + shell spawn on the main thread; in 'utility' mode
  // it's a utilityProcess.fork + one postMessage.
  const tCreate = process.hrtime.bigint();
  const term = new GhosttyTerminal({
    scale, fontSize: 13, engine: engineArg, command: '/bin/zsh -f',
  });
  const createBlockMs = Number(process.hrtime.bigint() - tCreate) / 1e6;

  const win = new BrowserWindow({
    width: 984,
    height: 608,
    show: true,
    title: `engine-placement: ${engineArg}`,
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
      preload: require.resolve('electron-ghostty/preload'),
    },
  });

  let firstFrameAt = 0;
  let frames = 0;
  term.on('frame', () => {
    frames++;
    if (!firstFrameAt) firstFrameAt = Date.now();
  });

  // Main-process event-loop lag probe: a 10 ms timer; anything beyond
  // the interval is time the main process was blocked (by the engine's
  // tick/present work in 'main' mode, by nothing much in 'utility').
  const LAG_INTERVAL = 10;
  const lags = [];
  let lagTimer = null;
  let lastTick = 0;
  function startLagProbe() {
    lastTick = process.hrtime.bigint();
    lagTimer = setInterval(() => {
      const now = process.hrtime.bigint();
      const deltaMs = Number(now - lastTick) / 1e6;
      lastTick = now;
      lags.push(Math.max(0, deltaMs - LAG_INTERVAL));
    }, LAG_INTERVAL);
  }

  term.once('ready', async () => {
    // Wait for the shell prompt (first frames flowing), then race.
    await new Promise(r => setTimeout(r, 1500));
    startLagProbe();
    const t0 = Date.now();
    // Two gotchas in driving a real interactive shell:
    //  - canonical-mode TTYs cap an input line at 1024 bytes
    //    (MAX_CANON), so keep the command short;
    //  - zsh's ZLE enables bracketed paste, and ghostty delivers
    //    surface_text as a paste — a pasted trailing \r does NOT
    //    execute, it sits in the edit buffer. Send the command as
    //    text, then a real Enter through ghostty's key encoder.
    term.text(
      `for i in $(seq ${REPEAT}); do cat ${JSON.stringify(payload)}; done; exit`);
    term.key({ action: 1, keycode: 36, mods: 0 }); // Enter press
    term.key({ action: 0, keycode: 36, mods: 0 });

    // Exit detection: the 'exit' event, with a processExited poll as
    // backstop (belt and suspenders — the event rides the same 8 ms
    // tick, but a lost event must fail a run loudly, not hang it).
    let finished = false;
    const poll = setInterval(async () => {
      if (!finished && term.processExited()) onShellExit();
    }, 250);
    term.once('exit', onShellExit);

    async function onShellExit() {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      const floodMs = Date.now() - t0;
      clearInterval(lagTimer);
      lags.sort((a, b) => a - b);
      const out = {
        engine: engineArg,
        floodMs,
        createBlockMs,
        firstFrameMs: firstFrameAt - createdAt,
        frames,
        lag: {
          samples: lags.length,
          p50: quantile(lags, 0.5),
          p99: quantile(lags, 0.99),
          max: lags[lags.length - 1] ?? 0,
        },
        payloadBytes: fs.statSync(payload).size * REPEAT,
        electronVersion: process.versions.electron,
      };
      fs.mkdirSync(path.dirname(RESULT), { recursive: true });
      fs.writeFileSync(RESULT, JSON.stringify(out, null, 2));
      console.log(JSON.stringify(out));
      term.destroy();
      app.exit(0);
    }
  });

  term.attach(win.webContents);
  win.loadFile(path.join(ROOT, 'bench', 'engine-placement.html'));

  setTimeout(() => { console.error('timeout'); app.exit(1); }, 240_000);
});

app.on('window-all-closed', () => app.quit());
