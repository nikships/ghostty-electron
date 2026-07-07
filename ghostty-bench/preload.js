'use strict';
/**
 * Sandboxed consumer preload: receives shared textures from the main
 * process, paints them into the canvas as VideoFrames (zero-copy), and
 * acks each frame once it has actually been presented (double rAF).
 */
const { sharedTexture, ipcRenderer } = require('electron');

let lastMeta = null;

sharedTexture.setSharedTextureReceiver(async (data, meta) => {
  const { importedSharedTexture: imported } = data;
  try {
    const frame = imported.getVideoFrame();
    const canvas = document.getElementById('terminal-canvas');
    if (canvas) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      canvas.getContext('2d').drawImage(frame, 0, 0);
    }
    frame.close();
    lastMeta = meta;

    // Ack only after the drawn frame has reached the compositor.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ipcRenderer.send('frame-presented', meta);
    }));
  } catch (err) {
    ipcRenderer.send('bench-error', err.message + '\n' + err.stack);
  } finally {
    imported.release();
  }
});

// The main process signals this when the final state was already on screen
// (no new frame to draw): re-ack the last presented frame as final.
ipcRenderer.on('no-frame-final', () => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ipcRenderer.send('frame-presented', { ...(lastMeta || { seq: 0 }), isFinal: true });
  }));
});

// Signal ready only after the compositor has presented the initial page,
// so benchmark timing doesn't include first-paint warm-up.
window.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ipcRenderer.send('renderer-ready');
  }));
});
