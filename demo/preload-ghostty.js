'use strict';
/**
 * Sandboxed consumer preload for the demo's ghostty window: paints received
 * shared textures into the canvas, forwards keyboard/wheel input to the main
 * process (which encodes keys via libghostty and writes to the PTY), and
 * renders the stats overlay.
 */
const { sharedTexture, ipcRenderer } = require('electron');

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
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ipcRenderer.send('frame-presented', meta);
    }));
  } catch (err) {
    console.error('present error', err);
  } finally {
    imported.release();
  }
});

ipcRenderer.on('init', (event, { cssWidth, cssHeight }) => {
  const canvas = document.getElementById('terminal-canvas');
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';
  canvas.focus();
});

ipcRenderer.on('stats', (event, s) => {
  const el = document.getElementById('stats');
  if (el) {
    el.textContent =
      `${s.fps} fps · draw ${s.renderMs.toFixed(2)}ms · present ${s.presentMs.toFixed(1)}ms`;
  }
});

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

window.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ipcRenderer.send('renderer-ready');
  }));

  window.addEventListener('keydown', (e) => {
    if (MODIFIER_KEYS.has(e.key)) return;

    // Cmd+V pastes; other Cmd shortcuts (Q, W, C, …) stay with the browser.
    if (e.metaKey) {
      if (e.code === 'KeyV') {
        e.preventDefault();
        ipcRenderer.send('g-paste');
      }
      return;
    }

    e.preventDefault();
    ipcRenderer.send('g-key', {
      code: e.code,
      utf8: e.key.length === 1 ? e.key : '',
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      super: e.metaKey,
      action: e.repeat ? 'repeat' : 'press'
    });
  });

  window.addEventListener('wheel', (e) => {
    ipcRenderer.send('g-wheel', { deltaY: e.deltaY });
  }, { passive: true });
});
