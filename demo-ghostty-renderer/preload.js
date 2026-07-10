'use strict';
/**
 * Sandboxed consumer for the approach-A demo: paints ghostty-rendered
 * shared textures into the canvas and forwards raw input events to the
 * main process, where ghostty's own encoders (kitty keyboard protocol,
 * mouse tracking modes, scrollback routing) handle them.
 */
const { sharedTexture, ipcRenderer } = require('electron');

sharedTexture.setSharedTextureReceiver(async (data) => {
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

/* DOM KeyboardEvent.code -> macOS virtual keycode. Ghostty's embedded
 * API takes native keycodes and maps them to physical keys itself
 * (apprt/embedded.zig keycode table). Covers the practical set. */
const MAC_KEYCODE = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7,
  KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
  KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
  Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27,
  Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32,
  BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38,
  Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44,
  KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50,
  Backspace: 51, Escape: 53, F5: 96, F6: 97, F7: 98, F3: 99, F8: 100,
  F9: 101, F11: 103, F10: 109, F12: 111, Home: 115, PageUp: 116,
  Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
};

function domMods(e) {
  // ghostty_input_mods_e bitmask
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) |
         (e.metaKey ? 8 : 0);
}

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('terminal-canvas');

  window.addEventListener('keydown', (e) => {
    if (e.metaKey) return; // Cmd shortcuts stay with the app
    const keycode = MAC_KEYCODE[e.code];
    if (keycode === undefined && e.key.length !== 1) return;
    e.preventDefault();
    ipcRenderer.send('key', {
      action: 1, // press
      keycode: keycode ?? 0,
      mods: domMods(e),
      // Printable text: ghostty's encoder uses it for the byte stream.
      text: e.key.length === 1 && !e.ctrlKey ? e.key : undefined,
      unshiftedCodepoint:
        e.key.length === 1 ? e.key.toLowerCase().codePointAt(0) : 0,
    });
  });

  window.addEventListener('keyup', (e) => {
    const keycode = MAC_KEYCODE[e.code];
    if (keycode === undefined) return;
    ipcRenderer.send('key', { action: 0, keycode, mods: domMods(e) });
  });

  window.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (text) ipcRenderer.send('text', text);
  });

  const rel = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = rel(e);
    // Ghostty expects scroll deltas with up = positive.
    ipcRenderer.send('mouse-scroll', { ...p, dx: -e.deltaX, dy: -e.deltaY });
  }, { passive: false });

  // DOM button -> ghostty_input_mouse_button_e (1=left 2=right 3=middle)
  const GHOSTTY_BUTTON = [1, 3, 2, 4, 5];
  canvas.addEventListener('mousedown', (e) => {
    ipcRenderer.send('mouse-button', {
      action: 1, button: GHOSTTY_BUTTON[e.button] ?? 0, mods: domMods(e),
    });
  });
  canvas.addEventListener('mouseup', (e) => {
    ipcRenderer.send('mouse-button', {
      action: 0, button: GHOSTTY_BUTTON[e.button] ?? 0, mods: domMods(e),
    });
  });
  canvas.addEventListener('mousemove', (e) => {
    ipcRenderer.send('mouse-pos', { ...rel(e), mods: domMods(e) });
  });

  requestAnimationFrame(() => requestAnimationFrame(() => {
    ipcRenderer.send('renderer-ready');
  }));
});
