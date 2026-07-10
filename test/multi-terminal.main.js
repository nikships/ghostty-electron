/**
 * Two terminals in ONE page (split panes) — structurally impossible
 * before slot routing. Each runs a distinct marker command; both
 * slots' canvases must paint, verified in the composited window
 * screenshot per half. Result JSON to results/multi-terminal.json,
 * exit 0/1. Driven by test/integration.test.js.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { GhosttyTerminal } = require('electron-ghostty');

const html = `<!DOCTYPE html><html><head><style>
  html,body{height:100%;margin:0;display:flex}
  canvas{flex:1;min-width:0;height:100%}
</style></head><body>
  <canvas data-ghostty="left" tabindex="0"></canvas>
  <canvas data-ghostty="right" tabindex="0"></canvas>
</body></html>`;
const htmlPath = path.join(require('os').tmpdir(), 'electron-ghostty-multi-term.html');
fs.writeFileSync(htmlPath, html);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 500,
    webPreferences: {
      sandbox: true, backgroundThrottling: false,
      preload: require.resolve('electron-ghostty/preload'),
    },
  });
  const mk = (marker) => new GhosttyTerminal({
    scale: 2,
    command: `/bin/sh -c 'printf "${marker}\\n"; sleep 60'`,
  });
  const left = mk('LEFT_PANE_MARKER');
  const right = mk('RIGHT_PANE_MARKER');
  let leftFrames = 0, rightFrames = 0;
  left.on('frame', () => leftFrames++);
  right.on('frame', () => rightFrames++);
  left.attach(win.webContents, { slot: 'left' });
  right.attach(win.webContents, { slot: 'right' });
  win.loadFile(htmlPath);

  // Wait for both to render their markers (host-side pixels).
  const fg = async (t) => {
    const px = await t.readPixelsAsync();
    if (!px) return 0;
    const bg = px.data.readUInt32LE(0);
    let n = 0;
    for (let i = 0; i < px.data.length; i += 4)
      if (px.data.readUInt32LE(i) !== bg) n++;
    return n;
  };
  const t0 = Date.now();
  let l = 0, r = 0;
  while (Date.now() - t0 < 30000) {
    [l, r] = [await fg(left), await fg(right)];
    if (l > 200 && r > 200 && leftFrames > 0 && rightFrames > 0) break;
    await new Promise(res => setTimeout(res, 100));
  }
  await new Promise(res => setTimeout(res, 400));
  const img = await win.webContents.capturePage();
  const bmp = img.toBitmap();
  const w = img.getSize().width, h = img.getSize().height;
  // Count fg pixels separately for left/right halves of the window.
  const halfFg = (x0, x1) => {
    const bg = bmp.readUInt32LE(0);
    let n = 0;
    for (let y = 0; y < h; y++)
      for (let x = x0; x < x1; x++) {
        if (bmp.readUInt32LE((y * w + x) * 4) !== bg) n++;
      }
    return n;
  };
  const out = {
    ok: l > 200 && r > 200 && leftFrames > 0 && rightFrames > 0 &&
        halfFg(0, w >> 1) > 200 && halfFg(w >> 1, w) > 200,
    leftHostPx: l, rightHostPx: r, leftFrames, rightFrames,
    leftRendererPx: halfFg(0, w >> 1), rightRendererPx: halfFg(w >> 1, w),
  };
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results', 'multi-terminal.json'),
    JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
  left.destroy(); right.destroy();
  app.exit(out.ok ? 0 : 1);
});
setTimeout(() => { console.error('timeout'); process.exit(2); }, 60000);
