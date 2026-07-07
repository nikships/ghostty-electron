/**
 * Shared session state and platform hooks for the ghostty_producer addon.
 *
 * vt.c            — platform-independent: libghostty-vt session, parsing,
 *                   text/cursor readout, key encoding, selection, dirty
 *                   accounting. Builds on every OS.
 * producer_mac.m  — macOS presentation: CoreText → IOSurface rendering.
 * producer_stub.c — every other OS: nominal cell metrics, no rendering
 *                   (render/readPixels are absent from the exports).
 */
#ifndef GXB_SESSION_H
#define GXB_SESSION_H

#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#include <ghostty/vt.h>

#ifdef __APPLE__
#import <CoreGraphics/CoreGraphics.h>
#import <CoreText/CoreText.h>
#import <IOSurface/IOSurface.h>
#endif

#define NAPI_CALL(env, call)                                       \
  do {                                                             \
    napi_status _st = (call);                                      \
    if (_st != napi_ok) {                                          \
      napi_throw_error((env), NULL, "N-API call failed: " #call);  \
      return NULL;                                                 \
    }                                                              \
  } while (0)

#define THROW_IF(env, cond, msg)          \
  do {                                    \
    if (cond) {                           \
      napi_throw_error((env), NULL, msg); \
      return NULL;                        \
    }                                     \
  } while (0)

enum { FONT_REGULAR = 0, FONT_BOLD, FONT_ITALIC, FONT_BOLD_ITALIC, FONT_COUNT };

typedef struct {
  GhosttyTerminal terminal;
  GhosttyRenderState render_state;
  GhosttyRenderStateRowIterator row_iter;
  GhosttyRenderStateRowCells cells;
  GhosttyKeyEncoder key_encoder;
  GhosttyKeyEvent key_event;

  uint16_t cols, rows;
  double scale;
  double cell_w, cell_h, ascent;
  size_t px_w, px_h;

  // Dirty tracking across double buffering: rows carry the sequence number
  // of their last modification; each surface carries the sequence it was
  // last rendered at. A surface redraws rows with row_modified > its seq.
  uint64_t mod_seq;
  uint64_t *row_modified;
  uint64_t surface_seq[2];
  bool needs_present;

  // Cursor state from the previous accumulate, to dirty vacated rows.
  bool prev_cursor_valid;
  uint16_t prev_cursor_x, prev_cursor_y;

  // Host-driven blink phase: when set, render() skips the cursor.
  bool cursor_hidden;

  // Query responses (DSR/CPR/DA/…) generated during vt_write, buffered here
  // by the write_pty effect and returned to JS from write() so the host can
  // feed them back to the PTY. Without this, ncurses apps stall waiting for
  // answers (htop's multi-second blank startup).
  uint8_t *resp;
  size_t resp_len, resp_cap;

#ifdef __APPLE__
  IOSurfaceRef surfaces[2];
  int surface_index;
  CGColorSpaceRef colorspace;
  CTFontRef fonts[FONT_COUNT];
  CGGlyph ascii_glyphs[FONT_COUNT][95];  // glyph cache for 0x20..0x7E
#elif defined(_WIN32)
  // Opaque C++ state (D3D11/D2D/DWrite COM objects) owned by producer_win.cc.
  void *win;
  int surface_index;
#endif
} Session;

/* vt.c — shared helpers used by the platform layer. */
Session *gxb_get_session(napi_env env, napi_value ext);
bool gxb_accumulate_dirty(Session *s);
GhosttyCellWide gxb_current_cell_wide(Session *s);

/* Platform hooks (producer_mac.m / producer_stub.c). */

/** Fonts/metrics/surfaces. Must set cell_w/cell_h/ascent (px_w/px_h are
 *  derived by the caller). Returns false on failure (throws). */
bool gxb_platform_init(napi_env env, Session *s, double font_size);
void gxb_platform_free(Session *s);
/** Recreate presentation surfaces after px_w/px_h changed. */
bool gxb_platform_resize(napi_env env, Session *s);
/** Register platform-specific exports (render/readPixels on macOS). */
void gxb_platform_register(napi_env env, napi_value exports);

#endif /* GXB_SESSION_H */
