'use strict';
/**
 * electron-ghostty engine host — the utilityProcess entry point.
 *
 * Runs the entire terminal engine (ghostty: PTY + shell, VT parsing,
 * input encoding, fonts, Metal rendering) OUTSIDE the Electron main
 * process, so a busy or crashing terminal can't stall window
 * management. The main process stays a thin presenter: we post the
 * global IOSurfaceID of each presented frame over parentPort; the main
 * side re-derives a local IOSurfaceRef via IOSurfaceLookup and imports
 * it into sharedTexture — still zero-copy, frames never leave the GPU.
 *
 * Frame flow control: one frame in flight — we don't post the next
 * frame until the parent acks the previous one, so a slow presenter
 * degrades to skipped frames instead of a queue of stale messages.
 *
 * Protocol (parentPort messages, all {type, ...}):
 *   in : create {opts} | frame-ack | key/text/mouse-* {..} |
 *        resize {widthPx,heightPx} | draw | read-pixels {id} |
 *        size {id} | destroy
 *   out: created | frame {surfaceId,width,height,scale} | exit |
 *        reply {id, result} | error {message}
 */
const { load } = require('./addon');

const PRESENT_INTERVAL_MS = 8; // ~120Hz poll of ghostty's swap chain

const addon = load();
addon.init();

let session = null;
let presentTimer = null;
let lastFramePtr = null;
let awaitingAck = false;
let exited = false;

function post(msg) {
  process.parentPort.postMessage(msg);
}

function presentTick() {
  if (!session) return;
  // Ghostty's render thread presents via dispatch_async to the main
  // queue; plain Node has no run loop, so pump it or frames never land.
  addon.pumpMainQueue();
  addon.tick(session);
  if (addon.processExited(session)) {
    if (!exited) {
      exited = true;
      post({ type: 'exit' });
    }
    return;
  }
  if (awaitingAck) return;
  const frame = addon.frame(session);
  if (!frame) return;
  const ptr = frame.handle.toString('hex');
  if (ptr === lastFramePtr) return;
  lastFramePtr = ptr;
  awaitingAck = true;
  post({
    type: 'frame',
    surfaceId: frame.surfaceId,
    width: frame.width,
    height: frame.height,
    scale: frame.scale,
  });
}

const handlers = {
  create({ opts }) {
    session = addon.create(opts);
    presentTimer = setInterval(presentTick, PRESENT_INTERVAL_MS);
    post({ type: 'created' });
  },
  'frame-ack'() {
    awaitingAck = false;
  },
  key({ event }) { addon.key(session, event); },
  text({ text }) { addon.text(session, text); },
  'mouse-button'({ action, button, mods }) {
    addon.mouseButton(session, action, button, mods);
  },
  'mouse-pos'({ x, y, mods }) { addon.mousePos(session, x, y, mods); },
  'mouse-scroll'({ x, y, dx, dy }) {
    addon.mouseScroll(session, x, y, dx, dy);
  },
  resize({ widthPx, heightPx }) {
    // The swap chain is rebuilt on resize: the previous frame's surface
    // ID is stale the moment this returns.
    addon.resize(session, widthPx, heightPx);
  },
  draw() { addon.draw(session); },
  'read-pixels'({ id }) {
    addon.tick(session);
    addon.draw(session);
    post({ type: 'reply', id, result: addon.readPixels(session) });
  },
  size({ id }) {
    post({ type: 'reply', id, result: addon.size(session) });
  },
  destroy() {
    teardown();
    process.exit(0);
  },
};

function teardown() {
  if (presentTimer) clearInterval(presentTimer);
  presentTimer = null;
  if (session) {
    try { addon.destroy(session); } catch {}
    session = null;
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data;
  const handler = handlers[msg?.type];
  if (!handler) return;
  try {
    handler(msg);
  } catch (err) {
    post({ type: 'error', message: `${msg.type}: ${err.message}` });
  }
});

// If the main process dies, don't leave an orphaned shell behind.
process.parentPort.on('close', () => {
  teardown();
  process.exit(0);
});
