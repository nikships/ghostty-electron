'use strict';
/**
 * Approach A demo: ghostty embedded headlessly — ghostty owns
 * EVERYTHING (PTY + shell, VT parsing, key/mouse encoding, selection,
 * fonts/shaping, Metal rendering, IOSurface presentation). All the
 * Electron glue (present loop, input routing, canvas-driven resize)
 * lives in packages/electron-ghostty; this demo is just a consumer:
 * create a terminal, attach it to a window whose preload is the
 * package's, done.
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const { GhosttyTerminal } = require('electron-ghostty');

// --smoke: run a marker command, wait until its output is visibly
// rendered (checked in the raw IOSurface), screenshot, write a result
// JSON, exit 0/1. Used by test/integration.test.js and CI.
const SMOKE = process.argv.includes('--smoke');
// --record-gif[=path]: drive a deterministic terminal animation and encode
// a GIF with ffmpeg. By default this captures renderer content; on macOS,
// --record-native-window tries to include the real native window frame.
const RECORD_GIF_ARGS = process.argv.filter(a => a === '--record-gif' || a.startsWith('--record-gif='));
const RECORD_GIF_ARG = RECORD_GIF_ARGS.at(-1);
const RECORD_GIF = !!RECORD_GIF_ARG;
const RECORD_GIF_PATH = RECORD_GIF_ARG?.includes('=')
  ? RECORD_GIF_ARG.split('=').slice(1).join('=')
  : null;
const RECORD_CONTENT_ONLY = process.argv.includes('--record-content-only');
const RECORD_NATIVE_WINDOW =
  process.argv.includes('--record-native-window') && !RECORD_CONTENT_ONLY;
// --engine=main|utility: where ghostty runs (default: utility process).
const ENGINE = (process.argv.find(a => a.startsWith('--engine=')) || '')
  .split('=')[1] || undefined;
const numberFlag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? Number(process.argv[i + 1]) : fallback;
};
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

app.whenReady().then(() => {
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const recordCommand = RECORD_GIF ? createRecordCommand() : null;

  const term = new GhosttyTerminal({
    scale,
    fontSize: 13,
    ...(ENGINE ? { engine: ENGINE } : {}),
    // No command: ghostty launches the user's shell like a real window.
    // Smoke mode runs a deterministic marker instead. Note: ghostty
    // execs the command directly (login-shell exec), so compound
    // commands must be wrapped in an explicit sh -c.
    ...(SMOKE
      ? { command: `/bin/sh -c 'printf "DEMO_SMOKE_MARKER\\n"; sleep 60'` }
      : RECORD_GIF
        ? { command: recordCommand }
        : {}),
  });

  function createRecordCommand() {
    const resultsDir = path.join(__dirname, '..', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const script = path.join(resultsDir, 'demo-gif-command.js');
    fs.writeFileSync(script, String.raw`#!/usr/bin/env node
'use strict';

const stdin = process.stdin;
const stdout = process.stdout;
let frame = 0;
let click = null;
let recentMouse = '';

const clean = () => {
  stdout.write('\x1b[?25h\x1b[?1002l\x1b[?1006l\x1b[?1049l');
};
process.on('exit', clean);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
stdin.resume();
stdin.on('data', (chunk) => {
  recentMouse += chunk.toString('utf8');
  const match = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(recentMouse);
  if (match) {
    click = { col: match[2], row: match[3] };
    recentMouse = recentMouse.slice(match.index + match[0].length);
  }
  if (recentMouse.length > 128) recentMouse = recentMouse.slice(-32);
});

const line = (text) => stdout.write(text + '\x1b[K\n');
const green = (text) => '\x1b[38;5;82m' + text + '\x1b[0m';
const yellow = (text) => '\x1b[38;5;220m' + text + '\x1b[0m';
const gray = (text) => '\x1b[38;5;245m' + text + '\x1b[0m';

stdout.write('\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[2J');

function render() {
  frame++;
  stdout.write('\x1b[H');
  line('Ghostty embedded in Electron');
  line('PTY + parser + input + fonts + Metal stay in Ghostty');
  line('Electron imports each IOSurface as a VideoFrame via sharedTexture');
  line('');
  if (click) {
    line(yellow('mouse click received at cell ' + click.col + ',' + click.row + ' via Ghostty input'));
  } else {
    line(gray('waiting for Electron click -> Ghostty mouse report'));
  }
  line('');

  const rows = 22;
  const start = Math.max(1, frame - rows + 1);
  for (let n = start; n < start + rows; n++) {
    line(green(String(n).padStart(4, '0')) + '  zero-copy frame path alive');
  }
}

render();
setInterval(render, 45);
`, { mode: 0o755 });
    return `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(script)}`;
  }

  const win = new BrowserWindow({
    width: 984,
    height: 608,
    title: 'ghostty embedded headless (approach A) inside Electron',
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
      preload: require.resolve('electron-ghostty/preload'),
    },
  });

  term.attach(win.webContents);
  term.on('exit', () => app.quit());
  term.on('present-error', (err) => console.error('present failed:', err.message));
  let framesPresented = 0;
  term.on('frame', () => framesPresented++);
  if (SMOKE) term.once('ready', runSmoke);
  if (RECORD_GIF) term.once('ready', runGifRecorder);

  async function runSmoke() {
    const t0 = Date.now();
    const deadline = t0 + 60_000;
    let fg = 0;
    // Wait until the marker output is visibly rendered in the IOSurface.
    while (Date.now() < deadline) {
      const px = await term.readPixelsAsync();
      if (px) {
        const bg = px.data.readUInt32LE(0);
        fg = 0;
        for (let i = 0; i < px.data.length; i += 4)
          if (px.data.readUInt32LE(i) !== bg) fg++;
        if (fg > 200) break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    // Let a frame reach the compositor, then screenshot the window.
    // The screenshot is the renderer's composited output — the pixel
    // count below proves the frame→sharedTexture→canvas path actually
    // painted, not just that ghostty rendered into its IOSurface.
    await new Promise(r => setTimeout(r, 300));
    const resultsDir = path.join(__dirname, '..', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    let rendererFg = 0;
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(resultsDir, 'demo-ghostty.png'), img.toPNG());
      const bmp = img.toBitmap(); // BGRA
      const rbg = bmp.readUInt32LE(0);
      for (let i = 0; i < bmp.length; i += 4)
        if (bmp.readUInt32LE(i) !== rbg) rendererFg++;
    } catch {}
    const ok = fg > 200 && framesPresented > 0 && rendererFg > 200;
    const out = {
      ok,
      foregroundPixels: fg,
      rendererForegroundPixels: rendererFg,
      framesPresented,
      elapsedMs: Date.now() - t0,
      size: await term.sizeAsync(),
      engine: term.engine,
      electronVersion: process.versions.electron,
      platform: process.platform,
    };
    fs.writeFileSync(
      path.join(resultsDir, 'demo-smoke.json'),
      JSON.stringify(out, null, 2),
    );
    console.log(JSON.stringify(out));
    app.exit(ok ? 0 : 1);
  }

  async function runGifRecorder() {
    const resultsDir = path.join(__dirname, '..', 'results');
    const framesDir = path.join(resultsDir, 'demo-gif-frames');
    const outGif = path.resolve(RECORD_GIF_PATH || path.join(resultsDir, 'demo-ghostty.gif'));
    const fps = numberFlag('--record-fps', 30);
    const seconds = numberFlag('--record-seconds', 5);
    const frameCount = Math.max(1, Math.round(fps * seconds));
    const { execFileSync } = require('child_process');

    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });
    fs.mkdirSync(path.dirname(outGif), { recursive: true });

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const demoClick = { x: 156, y: 132 };

    const windowCaptureRegion = () => {
      if (!RECORD_NATIVE_WINDOW || process.platform !== 'darwin') return null;
      const bounds = win.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const scale = display.scaleFactor || 1;
      // On macOS, Electron's reported y can correspond to the content
      // area for our screenshot purposes. Extend upward enough to
      // include the title bar and traffic-light controls.
      const titlebarPx = Math.round(30 * scale);
      return [
        Math.round(bounds.x * scale),
        Math.max(0, Math.round(bounds.y * scale) - titlebarPx),
        Math.round(bounds.width * scale),
        Math.round(bounds.height * scale) + titlebarPx,
      ].join(',');
    };
    const fullScreenCrop = () => {
      const bounds = win.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const scale = display.scaleFactor || 1;
      const titlebarPx = Math.round(30 * scale);
      return {
        x: Math.round(bounds.x * scale * scale),
        y: Math.max(0, Math.round((bounds.y * scale - titlebarPx) * scale)),
        w: Math.round(bounds.width * scale),
        h: Math.round(bounds.height * scale),
      };
    };
    const captureFrame = async (i) => {
      const file = path.join(framesDir, `frame-${String(i).padStart(3, '0')}.png`);
      const region = windowCaptureRegion();
      if (region) {
        // Fullscreen capture reliably includes the real macOS cursor.
        // Region capture is faster, but can omit the cursor; crop later.
        execFileSync('screencapture', ['-x', '-C', file]);
        return { file, nativeWindow: true, source: region, fullScreen: true };
      }
      const image = await win.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      return { file, nativeWindow: false, source: null, fullScreen: false };
    };
    const createCursorWarpHelper = () => {
      if (!RECORD_NATIVE_WINDOW || process.platform !== 'darwin') return null;
      const source = path.join(resultsDir, 'demo-gif-cursor-warp.c');
      const bin = path.join(resultsDir, 'demo-gif-cursor-warp');
      fs.writeFileSync(source, `#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc == 1) {
    CGEventRef event = CGEventCreate(NULL);
    if (!event) return 2;
    CGPoint p = CGEventGetLocation(event);
    CFRelease(event);
    printf("%.3f %.3f\\n", p.x, p.y);
    return 0;
  }
  if (argc != 3) return 2;
  CGPoint p = CGPointMake(atof(argv[1]), atof(argv[2]));
  CGWarpMouseCursorPosition(p);
  CGAssociateMouseAndMouseCursorPosition(true);
  return 0;
}
`);
      execFileSync('clang', [
        '-O2',
        source,
        '-framework',
        'ApplicationServices',
        '-o',
        bin,
      ]);
      return bin;
    };
    const writeCursorOverlay = () => {
      const cursorPam = path.join(resultsDir, 'demo-gif-cursor.pam');
      const width = 26;
      const height = 34;
      const data = Buffer.alloc(width * height * 4);
      const pointer = [[3, 2], [3, 27], [11, 20], [15, 33], [21, 30], [17, 19], [25, 19]];
      const pointInPolygon = (x, y, points) => {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[j];
          const crosses = (yi > y) !== (yj > y) &&
            x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
          if (crosses) inside = !inside;
        }
        return inside;
      };
      const fill = (points, [r, g, b, a]) => {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (!pointInPolygon(x + 0.5, y + 0.5, points)) continue;
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = a;
          }
        }
      };
      for (const dx of [-2, -1, 0, 1, 2]) {
        for (const dy of [-2, -1, 0, 1, 2]) {
          if (dx === 0 && dy === 0) continue;
          fill(pointer.map(([x, y]) => [x + dx, y + dy]), [255, 255, 255, 245]);
        }
      }
      fill(pointer, [10, 10, 10, 255]);
      const header = Buffer.from(
        `P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
        'ascii',
      );
      fs.writeFileSync(cursorPam, Buffer.concat([header, data]));
      return cursorPam;
    };
    const cursorHotspotAtFrame = (i, clickFrame) => {
      const linear = Math.min(i, clickFrame) / clickFrame;
      const t = linear * linear * (3 - 2 * linear);
      return {
        x: 764 + (demoClick.x - 764) * t,
        y: 95 + (demoClick.y - 95) * t,
      };
    };
    const nativeCursorPositionAtFrame = (i, clickFrame) => {
      const contentBounds = win.getContentBounds();
      const p = cursorHotspotAtFrame(i, clickFrame);
      return {
        x: contentBounds.x * scale + p.x,
        y: contentBounds.y * scale + p.y,
      };
    };
    const sendDemoClick = async () => {
      const { x, y } = demoClick;
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await sleep(90);
    };

    win.show();
    win.focus();
    await sleep(850);

    let nativeWindowCapture = false;
    let nativeFullScreenCapture = false;
    let captureSource = null;
    let didClick = false;
    const clickFrame = Math.max(1, Math.floor(frameCount * 0.62));
    const cursorWarp = createCursorWarpHelper();
    const originalCursor = cursorWarp
      ? execFileSync(cursorWarp, [], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
      : null;
    for (let i = 0; i < frameCount; i++) {
      if (cursorWarp) {
        const p = nativeCursorPositionAtFrame(i, clickFrame);
        execFileSync(cursorWarp, [String(p.x), String(p.y)]);
        await sleep(20);
      }
      if (!didClick && i >= clickFrame) {
        didClick = true;
        await sendDemoClick();
      }
      const captured = await captureFrame(i);
      nativeWindowCapture ||= captured.nativeWindow;
      nativeFullScreenCapture ||= captured.fullScreen;
      captureSource = captureSource || captured.source;
      await sleep(1000 / fps);
    }
    if (cursorWarp && originalCursor?.length === 2 && originalCursor.every(Number.isFinite)) {
      execFileSync(cursorWarp, originalCursor.map(String));
    }

    const inputPattern = path.join(framesDir, 'frame-%03d.png');
    const useCursorOverlay = !cursorWarp;
    const cursorOverlay = useCursorOverlay ? writeCursorOverlay() : null;
    const hotspotX = 3;
    const hotspotY = 2;
    const startX = 760;
    const startY = 92;
    const clickX = demoClick.x - hotspotX;
    const clickY = demoClick.y - hotspotY;
    const cursorProgress = `min(n\\,${clickFrame})/${clickFrame}`;
    const cursorEase = `(3*pow(${cursorProgress}\\,2)-2*pow(${cursorProgress}\\,3))`;
    const cursorX = `${startX}+(${clickX - startX})*${cursorEase}`;
    const cursorY = `${startY}+(${clickY - startY})*${cursorEase}`;
    try {
      const crop = nativeFullScreenCapture ? fullScreenCrop() : null;
      const baseInput = crop
        ? `[0:v]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},fps=${fps},scale=${win.getBounds().width}:-1:flags=lanczos[base];`
        : `[0:v]fps=${fps},scale=${win.getBounds().width}:-1:flags=lanczos[base];`;
      const filter = useCursorOverlay
        ? baseInput +
          `[1:v]format=rgba[cursor];` +
          `[base][cursor]overlay=x='${cursorX}':y='${cursorY}':eval=frame:shortest=1[with_cursor];` +
          `[with_cursor]split[s0][s1];[s0]palettegen[p];` +
          `[s1][p]paletteuse=dither=bayer:bayer_scale=5`
        : baseInput +
          `[base]split[s0][s1];` +
          `[s0]palettegen[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
      const ffmpegArgs = [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-framerate', String(fps), '-i', inputPattern,
      ];
      if (useCursorOverlay) ffmpegArgs.push('-loop', '1', '-i', cursorOverlay);
      ffmpegArgs.push(
        '-filter_complex',
        filter,
        '-frames:v', String(frameCount),
        outGif,
      );
      execFileSync('ffmpeg', [
        ...ffmpegArgs,
      ], { stdio: 'inherit' });
    } catch (err) {
      console.error('failed to encode GIF with ffmpeg:', err.message);
      console.error(`PNG frames remain in ${framesDir}`);
      app.exit(1);
      return;
    }

    const out = {
      ok: true,
      gif: outGif,
      frames: frameCount,
      fps,
      seconds,
      nativeWindowCapture,
      nativeFullScreenCapture,
      captureSource,
      interaction: didClick ? 'mouse-click' : null,
      cursorOverlay: useCursorOverlay,
      nativeCursor: !!cursorWarp,
      framesDir,
      engine: term.engine,
      electronVersion: process.versions.electron,
      platform: process.platform,
    };
    fs.writeFileSync(
      path.join(resultsDir, 'demo-gif.json'),
      JSON.stringify(out, null, 2),
    );
    console.log(JSON.stringify(out, null, 2));
    term.destroy();
    app.exit(0);
  }

  win.on('closed', () => {
    term.destroy(); // frees surface: ghostty kills+reaps the shell
  });

  win.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
