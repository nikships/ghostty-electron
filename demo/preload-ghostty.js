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
  canvas.style.cursor = 'text';
  canvas.focus();
  // Where the canvas landed (CSS px, window-relative): lets the main
  // process aim synthesized input events in the mouse-smoke test.
  const r = canvas.getBoundingClientRect();
  ipcRenderer.send('canvas-rect', { left: r.left, top: r.top });
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

  // Hidden textarea: the IME needs a focused editable element; composed text
  // (e.g. CJK via input methods) is committed on compositionend. Plain keys
  // still bubble to the window handler below.
  const ime = document.createElement('textarea');
  ime.style.cssText =
    'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
  ime.setAttribute('aria-hidden', 'true');
  document.body.appendChild(ime);
  ime.addEventListener('compositionend', (e) => {
    if (e.data) ipcRenderer.send('g-ime', e.data);
    ime.value = '';
  });
  const refocus = () => setTimeout(() => ime.focus(), 0);
  window.addEventListener('mousedown', refocus);
  refocus();

  // Cmd+F search bar.
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;top:6px;left:8px;display:none;z-index:20;' +
    'background:rgba(0,0,0,0.8);padding:4px 8px;border-radius:4px;' +
    'font:12px Menlo,monospace;color:#e6edf3;';
  bar.innerHTML = '<input id="search-input" style="background:#22272e;color:#e6edf3;' +
    'border:1px solid #444c56;border-radius:3px;font:12px Menlo,monospace;padding:2px 6px;width:200px;" ' +
    'placeholder="search"/> <span id="search-count" style="margin-left:6px;color:#9198a1;"></span>';
  document.body.appendChild(bar);
  const searchInput = bar.querySelector('#search-input');
  const searchCount = bar.querySelector('#search-count');
  const closeSearch = () => {
    bar.style.display = 'none';
    ipcRenderer.send('g-search-close');
    refocus();
  };
  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeSearch();
    else if (e.key === 'Enter') {
      ipcRenderer.send('g-search', { query: searchInput.value, dir: e.shiftKey ? -1 : 1 });
    }
  });
  ipcRenderer.on('search-result', (event, { count, idx }) => {
    searchCount.textContent = count ? `${idx}/${count}` : 'no matches';
  });

  window.addEventListener('keydown', (e) => {
    if (bar.style.display !== 'none' && e.target === searchInput) return;
    if (e.isComposing) return; // IME composition owns these keys
    if (MODIFIER_KEYS.has(e.key)) return;

    // Cmd+V pastes, Cmd+C copies, Cmd+F searches; other Cmd shortcuts
    // (Q, W, …) stay with the browser.
    if (e.metaKey) {
      if (e.code === 'KeyV') {
        e.preventDefault();
        ipcRenderer.send('g-paste');
      } else if (e.code === 'KeyC') {
        e.preventDefault();
        ipcRenderer.send('g-copy');
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        bar.style.display = 'block';
        searchInput.focus();
        searchInput.select();
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

  // Mouse: forward raw events with canvas-relative CSS pixel coords; main
  // arbitrates between app mouse tracking (encoded via libghostty and sent
  // to the PTY) and local behavior (selection, link clicks, scrollback).
  const canvas = document.getElementById('terminal-canvas');
  const mouseMsg = (type, e, extra) => {
    const rect = canvas.getBoundingClientRect();
    return {
      type,
      cssX: e.clientX - rect.left,
      cssY: e.clientY - rect.top,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      ...extra
    };
  };
  window.addEventListener('wheel', (e) => {
    ipcRenderer.send('g-wheel', mouseMsg('wheel', e, { deltaY: e.deltaY }));
  }, { passive: true });
  canvas.addEventListener('mousedown', (e) => {
    ipcRenderer.send('g-mouse', mouseMsg('down', e, { button: e.button }));
  });
  canvas.addEventListener('dblclick', (e) => {
    ipcRenderer.send('g-mouse', mouseMsg('dblclick', e, { button: e.button }));
  });
  window.addEventListener('mousemove', (e) => {
    ipcRenderer.send('g-mouse', mouseMsg('move', e, { buttons: e.buttons }));
  });
  window.addEventListener('mouseup', (e) => {
    ipcRenderer.send('g-mouse', mouseMsg('up', e, { button: e.button }));
  });
});
