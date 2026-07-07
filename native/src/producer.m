/**
 * ghostty_producer — native terminal frame producer.
 *
 * libghostty-vt parses the VT stream and maintains terminal state; this addon
 * renders the visible grid with CoreText into IOSurfaces that Electron's
 * sharedTexture module imports zero-copy (handle.ioSurface is a Buffer
 * holding the process-local IOSurfaceRef).
 *
 * Rendering model:
 *  - HiDPI aware: all pixel dimensions are physical (logical size × scale).
 *  - Double-buffered: render() alternates between two IOSurfaces so the GPU
 *    can scan out frame N while frame N+1 is drawn.
 *  - Dirty-row incremental: each surface only redraws rows modified since
 *    that surface was last rendered (row modification sequence numbers make
 *    dirty tracking compatible with double buffering).
 *  - Glyph runs: ASCII fast path uses a per-font glyph cache and batched
 *    CTFontDrawGlyphs runs; non-ASCII (CJK/emoji/graphemes) falls back to
 *    per-cell CTLine drawing.
 *  - Styles: fg/bg (palette + truecolor), bold (incl. bold-in-bright-colors
 *    like xterm.js), italic, inverse, underline, strikethrough, cursor
 *    (block/bar/underline/hollow).
 *
 * Also exposes: getText/readPixels/getCursor (testing), resize, scroll, and
 * mode-aware key encoding via libghostty's key encoder.
 */
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#import <CoreFoundation/CoreFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreText/CoreText.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>

#include <ghostty/vt.h>

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

  IOSurfaceRef surfaces[2];
  int surface_index;

  CGColorSpaceRef colorspace;
  CTFontRef fonts[FONT_COUNT];
  CGGlyph ascii_glyphs[FONT_COUNT][95];  // glyph cache for 0x20..0x7E

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
} Session;

/* ── Cell snapshot used during row drawing ────────────────────────────── */
typedef struct {
  char utf8[16];
  uint8_t utf8_len;   // 0 = empty cell
  bool is_ascii;      // single printable ASCII byte
  uint32_t cp;        // first codepoint (0 = none)
  GhosttyColorRgb fg;
  GhosttyColorRgb bg;
  bool has_bg;
  bool bold, italic, underline, strikethrough;
} CellSnap;

static uint32_t utf8_first_cp(const char *s, uint8_t len) {
  const uint8_t *b = (const uint8_t *)s;
  if (len == 0) return 0;
  if (b[0] < 0x80) return b[0];
  if ((b[0] & 0xE0) == 0xC0 && len >= 2)
    return ((uint32_t)(b[0] & 0x1F) << 6) | (b[1] & 0x3F);
  if ((b[0] & 0xF0) == 0xE0 && len >= 3)
    return ((uint32_t)(b[0] & 0x0F) << 12) | ((uint32_t)(b[1] & 0x3F) << 6) |
           (b[2] & 0x3F);
  if ((b[0] & 0xF8) == 0xF0 && len >= 4)
    return ((uint32_t)(b[0] & 0x07) << 18) | ((uint32_t)(b[1] & 0x3F) << 12) |
           ((uint32_t)(b[2] & 0x3F) << 6) | (b[3] & 0x3F);
  return 0;
}

/** Wide property of the row-cells iterator's current cell. */
static GhosttyCellWide current_cell_wide(Session *s) {
  GhosttyCell raw = 0;
  GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
  if (ghostty_render_state_row_cells_get(
          s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw) ==
      GHOSTTY_SUCCESS)
    ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
  return wide;
}

static GhosttyColorRgb resolve_style_color(GhosttyStyleColor color,
                                           const GhosttyRenderStateColors *colors,
                                           GhosttyColorRgb fallback) {
  switch (color.tag) {
    case GHOSTTY_STYLE_COLOR_RGB:
      return color.value.rgb;
    case GHOSTTY_STYLE_COLOR_PALETTE:
      return colors->palette[color.value.palette];
    default:
      return fallback;
  }
}

static IOSurfaceRef create_surface(size_t width, size_t height) {
  NSDictionary *props = @{
    (id)kIOSurfaceWidth : @((unsigned long)width),
    (id)kIOSurfaceHeight : @((unsigned long)height),
    (id)kIOSurfaceBytesPerElement : @4,
    (id)kIOSurfacePixelFormat : @((uint32_t)'BGRA'),
  };
  return IOSurfaceCreate((__bridge CFDictionaryRef)props);
}

static void set_fill_rgb(CGContextRef ctx, GhosttyColorRgb c) {
  CGContextSetRGBFillColor(ctx, c.r / 255.0, c.g / 255.0, c.b / 255.0, 1.0);
}

static void cache_ascii_glyphs(Session *s, int variant) {
  UniChar chars[95];
  for (int i = 0; i < 95; i++) chars[i] = (UniChar)(0x20 + i);
  CTFontGetGlyphsForCharacters(s->fonts[variant], chars,
                               s->ascii_glyphs[variant], 95);
}

static void session_free(Session *s) {
  if (!s) return;
  if (s->key_event) ghostty_key_event_free(s->key_event);
  if (s->key_encoder) ghostty_key_encoder_free(s->key_encoder);
  if (s->cells) ghostty_render_state_row_cells_free(s->cells);
  if (s->row_iter) ghostty_render_state_row_iterator_free(s->row_iter);
  if (s->render_state) ghostty_render_state_free(s->render_state);
  if (s->terminal) ghostty_terminal_free(s->terminal);
  for (int i = 0; i < 2; i++)
    if (s->surfaces[i]) CFRelease(s->surfaces[i]);
  for (int i = 0; i < FONT_COUNT; i++)
    if (s->fonts[i]) CFRelease(s->fonts[i]);
  if (s->colorspace) CGColorSpaceRelease(s->colorspace);
  free(s->row_modified);
  free(s);
}

static void finalize_session(napi_env env, void *data, void *hint) {
  session_free((Session *)data);
}

/* ── Dirty accumulation ───────────────────────────────────────────────── */

/**
 * Pull dirty state out of the terminal into our sequence-number model and
 * reset libghostty's dirty flags. Called by render() and getText() so text
 * readout never eats a pending present.
 */
static bool accumulate_dirty(Session *s) {
  if (ghostty_render_state_update(s->render_state, s->terminal) !=
      GHOSTTY_SUCCESS)
    return false;

  GhosttyRenderStateDirty dirty;
  if (ghostty_render_state_get(s->render_state,
                               GHOSTTY_RENDER_STATE_DATA_DIRTY,
                               &dirty) != GHOSTTY_SUCCESS)
    return false;

  s->mod_seq++;

  if (dirty != GHOSTTY_RENDER_STATE_DIRTY_FALSE) s->needs_present = true;

  // Global and per-row dirty are independent layers: even on a FULL frame the
  // per-row flags must be read and cleared, or they leak into later frames.
  if (dirty != GHOSTTY_RENDER_STATE_DIRTY_FALSE) {
    bool full = dirty == GHOSTTY_RENDER_STATE_DIRTY_FULL;
    ghostty_render_state_get(s->render_state,
                             GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                             &s->row_iter);
    uint16_t row = 0;
    while (ghostty_render_state_row_iterator_next(s->row_iter) &&
           row < s->rows) {
      bool row_dirty = false;
      ghostty_render_state_row_get(s->row_iter,
                                   GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
                                   &row_dirty);
      if (full || row_dirty) s->row_modified[row] = s->mod_seq;
      if (row_dirty) {
        bool clean = false;
        ghostty_render_state_row_set(
            s->row_iter, GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY, &clean);
      }
      row++;
    }
  }

  // Cursor movement must dirty both the vacated and the entered row even if
  // libghostty didn't flag them (e.g. pure cursor repositioning).
  bool cur_valid = false;
  uint16_t cx = 0, cy = 0;
  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
                           &cur_valid);
  if (cur_valid) {
    ghostty_render_state_get(s->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X, &cx);
    ghostty_render_state_get(s->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y, &cy);
  }
  if (cur_valid != s->prev_cursor_valid || cx != s->prev_cursor_x ||
      cy != s->prev_cursor_y) {
    if (s->prev_cursor_valid && s->prev_cursor_y < s->rows)
      s->row_modified[s->prev_cursor_y] = s->mod_seq;
    if (cur_valid && cy < s->rows) s->row_modified[cy] = s->mod_seq;
    s->needs_present = true;
    s->prev_cursor_valid = cur_valid;
    s->prev_cursor_x = cx;
    s->prev_cursor_y = cy;
  }

  GhosttyRenderStateDirty clean_state = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  ghostty_render_state_set(s->render_state, GHOSTTY_RENDER_STATE_OPTION_DIRTY,
                           &clean_state);
  return true;
}

/* ── Row drawing ──────────────────────────────────────────────────────── */

/** Read the current row's cells into snapshots. Returns cell count. */
static int snapshot_row(Session *s, const GhosttyRenderStateColors *colors,
                        CellSnap *snaps) {
  ghostty_render_state_row_get(s->row_iter, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                               &s->cells);
  int col = 0;
  while (ghostty_render_state_row_cells_next(s->cells) && col < s->cols) {
    CellSnap *snap = &snaps[col];
    memset(snap, 0, sizeof(*snap));
    snap->fg = colors->foreground;

    GhosttyCellWide wide = current_cell_wide(s);
    bool is_spacer = wide == GHOSTTY_CELL_WIDE_SPACER_TAIL ||
                     wide == GHOSTTY_CELL_WIDE_SPACER_HEAD;

    uint32_t glen = 0;
    ghostty_render_state_row_cells_get(
        s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &glen);
    if (glen > 0 && !is_spacer) {
      GhosttyBuffer buf = {.ptr = (uint8_t *)snap->utf8,
                           .cap = sizeof(snap->utf8),
                           .len = 0};
      if (ghostty_render_state_row_cells_get(
              s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8,
              &buf) == GHOSTTY_SUCCESS) {
        snap->utf8_len = (uint8_t)buf.len;
        snap->is_ascii = buf.len == 1 && snap->utf8[0] >= 0x20 &&
                         snap->utf8[0] <= 0x7E;
        snap->cp = utf8_first_cp(snap->utf8, snap->utf8_len);
      }
    }

    bool has_styling = false;
    ghostty_render_state_row_cells_get(
        s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_HAS_STYLING,
        &has_styling);
    if (has_styling) {
      GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
      ghostty_render_state_row_cells_get(
          s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);

      snap->bold = style.bold;
      snap->italic = style.italic;
      snap->underline = style.underline != 0;
      snap->strikethrough = style.strikethrough;

      GhosttyColorRgb fg =
          resolve_style_color(style.fg_color, colors, colors->foreground);
      // Match xterm.js drawBoldTextInBrightColors: bold + palette 0-7 →
      // bright variant.
      if (style.bold && style.fg_color.tag == GHOSTTY_STYLE_COLOR_PALETTE &&
          style.fg_color.value.palette < 8)
        fg = colors->palette[style.fg_color.value.palette + 8];

      bool has_bg = style.bg_color.tag != GHOSTTY_STYLE_COLOR_NONE;
      GhosttyColorRgb bg =
          resolve_style_color(style.bg_color, colors, colors->background);

      if (style.inverse) {
        snap->fg = has_bg ? bg : colors->background;
        snap->bg = fg;
        snap->has_bg = true;
      } else {
        snap->fg = fg;
        snap->bg = bg;
        snap->has_bg = has_bg;
      }
      if (style.faint) {
        snap->fg.r = (uint8_t)((snap->fg.r + colors->background.r) / 2);
        snap->fg.g = (uint8_t)((snap->fg.g + colors->background.g) / 2);
        snap->fg.b = (uint8_t)((snap->fg.b + colors->background.b) / 2);
      }
    }
    col++;
  }
  for (; col < s->cols; col++) {
    memset(&snaps[col], 0, sizeof(CellSnap));
    snaps[col].fg = colors->foreground;
  }

  // Selection highlight: invert fg/bg for the row-local selected range.
  GhosttyRenderStateRowSelection sel =
      GHOSTTY_INIT_SIZED(GhosttyRenderStateRowSelection);
  if (ghostty_render_state_row_get(s->row_iter,
                                   GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION,
                                   &sel) == GHOSTTY_SUCCESS) {
    for (int c = sel.start_x; c <= sel.end_x && c < s->cols; c++) {
      GhosttyColorRgb fg = snaps[c].fg;
      snaps[c].fg = snaps[c].has_bg ? snaps[c].bg : colors->background;
      snaps[c].bg = fg;
      snaps[c].has_bg = true;
    }
  }
  return s->cols;
}

static bool rgb_eq(GhosttyColorRgb a, GhosttyColorRgb b) {
  return a.r == b.r && a.g == b.g && a.b == b.b;
}

/* ── Geometric glyphs ─────────────────────────────────────────────────────
 * Box drawing, block elements, and braille are drawn as geometry instead of
 * font glyphs: font fallback misplaces them (wrong baseline/advance), which
 * wrecks TUI borders, and glyph bleed breaks partial-row redraws. Terminals
 * (including ghostty itself) custom-draw these ranges for exactly this
 * reason. Returns true when the codepoint was handled. */

enum { BOX_U = 1, BOX_D = 2, BOX_L = 4, BOX_R = 8, BOX_HEAVY = 16 };

static int box_flags(uint32_t cp) {
  switch (cp) {
    case 0x2500: case 0x2550: return BOX_L | BOX_R;
    case 0x2501: return BOX_L | BOX_R | BOX_HEAVY;
    case 0x2502: case 0x2551: return BOX_U | BOX_D;
    case 0x2503: return BOX_U | BOX_D | BOX_HEAVY;
    case 0x250C: case 0x2554: case 0x256D: return BOX_D | BOX_R;
    case 0x2510: case 0x2557: case 0x256E: return BOX_D | BOX_L;
    case 0x2514: case 0x255A: case 0x2570: return BOX_U | BOX_R;
    case 0x2518: case 0x255D: case 0x256F: return BOX_U | BOX_L;
    case 0x251C: case 0x2560: return BOX_U | BOX_D | BOX_R;
    case 0x2524: case 0x2563: return BOX_U | BOX_D | BOX_L;
    case 0x252C: case 0x2566: return BOX_D | BOX_L | BOX_R;
    case 0x2534: case 0x2569: return BOX_U | BOX_L | BOX_R;
    case 0x253C: case 0x256C: return BOX_U | BOX_D | BOX_L | BOX_R;
    case 0x2574: return BOX_L;
    case 0x2575: return BOX_U;
    case 0x2576: return BOX_R;
    case 0x2577: return BOX_D;
    default: return 0;
  }
}

static bool draw_geometric_cell(CGContextRef ctx, uint32_t cp,
                                GhosttyColorRgb fg, double x, double cg_y,
                                double w, double h, double scale) {
  // Box drawing U+2500–U+257F (common subset; doubles drawn as singles).
  int flags = cp >= 0x2500 && cp <= 0x257F ? box_flags(cp) : 0;
  if (flags) {
    set_fill_rgb(ctx, fg);
    double t = fmax(1.0, round(scale));
    if (flags & BOX_HEAVY) t *= 2;
    double xc = x + w / 2 - t / 2;
    double yc = cg_y + h / 2 - t / 2;
    if (flags & BOX_L) CGContextFillRect(ctx, CGRectMake(x, yc, xc - x + t, t));
    if (flags & BOX_R) CGContextFillRect(ctx, CGRectMake(xc, yc, x + w - xc, t));
    // Screen "up" is +y in CG's bottom-up space.
    if (flags & BOX_U) CGContextFillRect(ctx, CGRectMake(xc, yc, t, cg_y + h - yc));
    if (flags & BOX_D) CGContextFillRect(ctx, CGRectMake(xc, cg_y, t, yc - cg_y + t));
    return true;
  }

  // Block elements U+2580–U+259F.
  if (cp >= 0x2580 && cp <= 0x259F) {
    set_fill_rgb(ctx, fg);
    if (cp == 0x2580) { CGContextFillRect(ctx, CGRectMake(x, cg_y + h / 2, w, h / 2)); return true; }
    if (cp >= 0x2581 && cp <= 0x2588) { // lower eighths
      double k = (cp - 0x2580) / 8.0;
      CGContextFillRect(ctx, CGRectMake(x, cg_y, w, h * k));
      return true;
    }
    if (cp >= 0x2589 && cp <= 0x258F) { // left eighths
      double k = (8 - (cp - 0x2588)) / 8.0;
      CGContextFillRect(ctx, CGRectMake(x, cg_y, w * k, h));
      return true;
    }
    if (cp == 0x2590) { CGContextFillRect(ctx, CGRectMake(x + w / 2, cg_y, w / 2, h)); return true; }
    if (cp >= 0x2591 && cp <= 0x2593) { // shades
      double alpha = (cp - 0x2590) * 0.25;
      CGContextSetRGBFillColor(ctx, fg.r / 255.0, fg.g / 255.0, fg.b / 255.0, alpha);
      CGContextFillRect(ctx, CGRectMake(x, cg_y, w, h));
      return true;
    }
    if (cp == 0x2594) { CGContextFillRect(ctx, CGRectMake(x, cg_y + h * 7 / 8, w, h / 8)); return true; }
    if (cp == 0x2595) { CGContextFillRect(ctx, CGRectMake(x + w * 7 / 8, cg_y, w / 8, h)); return true; }
    // Quadrants: bit 0=UL, 1=UR, 2=LL, 3=LR.
    static const uint8_t QUAD[10] = {
        /*2596 ▖*/ 4, /*2597 ▗*/ 8, /*2598 ▘*/ 1, /*2599 ▙*/ 13,
        /*259A ▚*/ 9, /*259B ▛*/ 7, /*259C ▜*/ 11, /*259D ▝*/ 2,
        /*259E ▞*/ 6, /*259F ▟*/ 14};
    uint8_t q = QUAD[cp - 0x2596];
    if (q & 1) CGContextFillRect(ctx, CGRectMake(x, cg_y + h / 2, w / 2, h / 2));
    if (q & 2) CGContextFillRect(ctx, CGRectMake(x + w / 2, cg_y + h / 2, w / 2, h / 2));
    if (q & 4) CGContextFillRect(ctx, CGRectMake(x, cg_y, w / 2, h / 2));
    if (q & 8) CGContextFillRect(ctx, CGRectMake(x + w / 2, cg_y, w / 2, h / 2));
    return true;
  }

  // Braille U+2800–U+28FF: 2×4 dot matrix.
  if (cp >= 0x2800 && cp <= 0x28FF) {
    set_fill_rgb(ctx, fg);
    uint32_t bits = cp - 0x2800;
    // (col,row) for bits 0..7: dots 1,2,3 = col0 rows0-2; 4,5,6 = col1
    // rows0-2; 7 = col0 row3; 8 = col1 row3.
    static const uint8_t DOT_COL[8] = {0, 0, 0, 1, 1, 1, 0, 1};
    static const uint8_t DOT_ROW[8] = {0, 1, 2, 0, 1, 2, 3, 3};
    double r = fmax(scale, fmin(w, h / 2) * 0.18);
    for (int i = 0; i < 8; i++) {
      if (!(bits & (1u << i))) continue;
      double cx = x + w * (DOT_COL[i] ? 0.72 : 0.28);
      double cy = cg_y + h * (1.0 - (DOT_ROW[i] + 0.5) / 4.0);
      CGContextFillEllipseInRect(ctx, CGRectMake(cx - r, cy - r, 2 * r, 2 * r));
    }
    return true;
  }

  return false;
}

static int font_variant(const CellSnap *c) {
  if (c->bold && c->italic) return FONT_BOLD_ITALIC;
  if (c->bold) return FONT_BOLD;
  if (c->italic) return FONT_ITALIC;
  return FONT_REGULAR;
}

/** Draw one snapshotted row (bg runs, glyph runs, decorations, cursor). */
static void draw_row(Session *s, CGContextRef ctx, int row_index,
                     const GhosttyRenderStateColors *colors,
                     const CellSnap *snaps, int cursor_col,
                     GhosttyRenderStateCursorVisualStyle cursor_style,
                     GhosttyColorRgb cursor_color) {
  double y_top = row_index * s->cell_h;              // top-down pixel space
  double cg_y = s->px_h - y_top - s->cell_h;         // CG is bottom-up
  double baseline = s->px_h - y_top - s->ascent;

  // Clip to the row rect: glyphs (esp. via font fallback) can bleed outside
  // their line box, and with partial-row redraws any bleed makes the frame
  // depend on redraw history instead of grid state alone.
  CGContextSaveGState(ctx);
  CGContextClipToRect(ctx, CGRectMake(0, cg_y, s->px_w, s->cell_h));

  // Row background: default fill, then runs of non-default bg.
  set_fill_rgb(ctx, colors->background);
  CGContextFillRect(ctx, CGRectMake(0, cg_y, s->px_w, s->cell_h));
  for (int c = 0; c < s->cols;) {
    if (!snaps[c].has_bg) { c++; continue; }
    int run = c + 1;
    while (run < s->cols && snaps[run].has_bg &&
           rgb_eq(snaps[run].bg, snaps[c].bg))
      run++;
    set_fill_rgb(ctx, snaps[c].bg);
    CGContextFillRect(ctx, CGRectMake(c * s->cell_w, cg_y,
                                      (run - c) * s->cell_w, s->cell_h));
    c = run;
  }

  // Glyphs: batch consecutive ASCII cells with identical variant+color into
  // CTFontDrawGlyphs runs; everything else goes through CTLine.
  CGGlyph glyphs[512];
  CGPoint positions[512];
  int run_len = 0, run_variant = -1;
  GhosttyColorRgb run_fg = colors->foreground;

#define FLUSH_RUN()                                                        \
  do {                                                                     \
    if (run_len > 0) {                                                     \
      set_fill_rgb(ctx, run_fg);                                           \
      CTFontDrawGlyphs(s->fonts[run_variant], glyphs, positions,           \
                       run_len, ctx);                                      \
      run_len = 0;                                                         \
    }                                                                      \
  } while (0)

  for (int c = 0; c < s->cols; c++) {
    const CellSnap *snap = &snaps[c];
    if (snap->utf8_len == 0 || (snap->is_ascii && snap->utf8[0] == ' '))
      continue;

    if (snap->is_ascii) {
      int variant = font_variant(snap);
      if (run_len > 0 &&
          (variant != run_variant || !rgb_eq(snap->fg, run_fg) ||
           run_len == 512))
        FLUSH_RUN();
      run_variant = variant;
      run_fg = snap->fg;
      glyphs[run_len] = s->ascii_glyphs[variant][snap->utf8[0] - 0x20];
      positions[run_len] = CGPointMake(c * s->cell_w, baseline);
      run_len++;
    } else {
      FLUSH_RUN();
      // Box drawing / block elements / braille → geometry, not font glyphs.
      if (draw_geometric_cell(ctx, snap->cp, snap->fg, c * s->cell_w, cg_y,
                              s->cell_w, s->cell_h, s->scale))
        continue;
      // Non-ASCII: CTLine per cell (handles CJK, emoji, graphemes).
      CFStringRef str = CFStringCreateWithBytes(
          NULL, (const UInt8 *)snap->utf8, snap->utf8_len,
          kCFStringEncodingUTF8, false);
      if (!str) continue;
      CGColorRef color = CGColorCreate(
          s->colorspace, (CGFloat[]){snap->fg.r / 255.0, snap->fg.g / 255.0,
                                     snap->fg.b / 255.0, 1.0});
      CFStringRef keys[] = {kCTFontAttributeName,
                            kCTForegroundColorAttributeName};
      CFTypeRef values[] = {s->fonts[font_variant(snap)], color};
      CFDictionaryRef attrs = CFDictionaryCreate(
          NULL, (const void **)keys, (const void **)values, 2,
          &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
      CFAttributedStringRef astr =
          CFAttributedStringCreate(NULL, str, attrs);
      CTLineRef line = CTLineCreateWithAttributedString(astr);
      CGContextSetTextPosition(ctx, c * s->cell_w, baseline);
      CTLineDraw(line, ctx);
      CFRelease(line);
      CFRelease(astr);
      CFRelease(attrs);
      CGColorRelease(color);
      CFRelease(str);
    }
  }
  FLUSH_RUN();
#undef FLUSH_RUN

  // Decorations: underline / strikethrough runs.
  double u_thick = s->scale;
  for (int c = 0; c < s->cols;) {
    if (!snaps[c].underline && !snaps[c].strikethrough) { c++; continue; }
    bool ul = snaps[c].underline, st = snaps[c].strikethrough;
    int run = c + 1;
    while (run < s->cols && snaps[run].underline == ul &&
           snaps[run].strikethrough == st &&
           rgb_eq(snaps[run].fg, snaps[c].fg))
      run++;
    set_fill_rgb(ctx, snaps[c].fg);
    if (ul)
      CGContextFillRect(ctx, CGRectMake(c * s->cell_w, baseline - 2 * u_thick,
                                        (run - c) * s->cell_w, u_thick));
    if (st)
      CGContextFillRect(ctx,
                        CGRectMake(c * s->cell_w, baseline + s->ascent * 0.3,
                                   (run - c) * s->cell_w, u_thick));
    c = run;
  }

  // Cursor.
  if (cursor_col >= 0 && cursor_col < s->cols) {
    double cx = cursor_col * s->cell_w;
    set_fill_rgb(ctx, cursor_color);
    switch (cursor_style) {
      case GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR:
        CGContextFillRect(ctx, CGRectMake(cx, cg_y, 2 * s->scale, s->cell_h));
        break;
      case GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_UNDERLINE:
        CGContextFillRect(ctx,
                          CGRectMake(cx, cg_y, s->cell_w, 2 * s->scale));
        break;
      case GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK_HOLLOW:
        CGContextStrokeRectWithWidth(
            ctx, CGRectMake(cx + 0.5, cg_y + 0.5, s->cell_w - 1,
                            s->cell_h - 1),
            s->scale);
        break;
      case GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK:
      default: {
        CGContextFillRect(ctx, CGRectMake(cx, cg_y, s->cell_w, s->cell_h));
        // Redraw the covered glyph in the background color.
        const CellSnap *snap = &snaps[cursor_col];
        if (snap->utf8_len > 0 && snap->is_ascii && snap->utf8[0] != ' ') {
          set_fill_rgb(ctx, colors->background);
          CGGlyph g =
              s->ascii_glyphs[font_variant(snap)][snap->utf8[0] - 0x20];
          CGPoint p = CGPointMake(cx, baseline);
          CTFontDrawGlyphs(s->fonts[font_variant(snap)], &g, &p, 1, ctx);
        }
        break;
      }
    }
  }

  CGContextRestoreGState(ctx);  // row clip
}

/* ── N-API: create ────────────────────────────────────────────────────── */

/** create(cols, rows, fontSizePt, scale) → { session, width, height, cellWidth, cellHeight, scale } */
static napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 4, "create(cols, rows, fontSizePt, scale)");

  uint32_t cols, rows;
  double font_size, scale;
  NAPI_CALL(env, napi_get_value_uint32(env, argv[0], &cols));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[1], &rows));
  NAPI_CALL(env, napi_get_value_double(env, argv[2], &font_size));
  NAPI_CALL(env, napi_get_value_double(env, argv[3], &scale));
  THROW_IF(env, cols == 0 || rows == 0 || scale <= 0, "invalid dimensions");

  Session *s = calloc(1, sizeof(Session));
  THROW_IF(env, !s, "out of memory");
  s->cols = (uint16_t)cols;
  s->rows = (uint16_t)rows;
  s->scale = scale;

  s->fonts[FONT_REGULAR] =
      CTFontCreateWithName(CFSTR("Menlo"), font_size * scale, NULL);
  CTFontSymbolicTraits traits[FONT_COUNT] = {
      0, kCTFontBoldTrait, kCTFontItalicTrait,
      kCTFontBoldTrait | kCTFontItalicTrait};
  for (int i = 1; i < FONT_COUNT; i++) {
    s->fonts[i] = CTFontCreateCopyWithSymbolicTraits(
        s->fonts[FONT_REGULAR], font_size * scale, NULL, traits[i],
        kCTFontBoldTrait | kCTFontItalicTrait);
    if (!s->fonts[i]) s->fonts[i] = (CTFontRef)CFRetain(s->fonts[FONT_REGULAR]);
  }
  for (int i = 0; i < FONT_COUNT; i++) cache_ascii_glyphs(s, i);

  UniChar m_char = 'M';
  CGGlyph m_glyph;
  CTFontGetGlyphsForCharacters(s->fonts[FONT_REGULAR], &m_char, &m_glyph, 1);
  CGSize advance;
  CTFontGetAdvancesForGlyphs(s->fonts[FONT_REGULAR],
                             kCTFontOrientationHorizontal, &m_glyph, &advance,
                             1);
  s->ascent = CTFontGetAscent(s->fonts[FONT_REGULAR]);
  s->cell_w = ceil(advance.width);
  s->cell_h = ceil(s->ascent + CTFontGetDescent(s->fonts[FONT_REGULAR]) +
                   CTFontGetLeading(s->fonts[FONT_REGULAR]));
  s->px_w = (size_t)(s->cell_w * cols);
  s->px_h = (size_t)(s->cell_h * rows);

  s->colorspace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  for (int i = 0; i < 2; i++) {
    s->surfaces[i] = create_surface(s->px_w, s->px_h);
    if (!s->surfaces[i]) {
      session_free(s);
      napi_throw_error(env, NULL, "IOSurfaceCreate failed");
      return NULL;
    }
  }

  s->row_modified = calloc(rows, sizeof(uint64_t));

  GhosttyTerminalOptions opts = {
      .cols = s->cols,
      .rows = s->rows,
      .max_scrollback = 10000,
  };
  if (ghostty_terminal_new(NULL, &s->terminal, opts) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &s->render_state) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &s->row_iter) !=
          GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &s->cells) != GHOSTTY_SUCCESS ||
      ghostty_key_encoder_new(NULL, &s->key_encoder) != GHOSTTY_SUCCESS ||
      ghostty_key_event_new(NULL, &s->key_event) != GHOSTTY_SUCCESS) {
    session_free(s);
    napi_throw_error(env, NULL, "libghostty-vt initialization failed");
    return NULL;
  }
  ghostty_terminal_resize(s->terminal, s->cols, s->rows,
                          (uint32_t)s->cell_w, (uint32_t)s->cell_h);

  napi_value session_ext, result, v;
  NAPI_CALL(env, napi_create_external(env, s, finalize_session, NULL,
                                      &session_ext));
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_set_named_property(env, result, "session", session_ext));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_w, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", v));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_h, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", v));
  NAPI_CALL(env, napi_create_double(env, s->cell_w, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "cellWidth", v));
  NAPI_CALL(env, napi_create_double(env, s->cell_h, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "cellHeight", v));
  NAPI_CALL(env, napi_create_double(env, s->scale, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "scale", v));
  return result;
}

static Session *get_session(napi_env env, napi_value ext) {
  void *data = NULL;
  if (napi_get_value_external(env, ext, &data) != napi_ok || !data) {
    napi_throw_error(env, NULL, "invalid session");
    return NULL;
  }
  return (Session *)data;
}

/* ── N-API: write ─────────────────────────────────────────────────────── */

static napi_value WriteVt(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 2, "write(session, buffer)");

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  void *data;
  size_t len;
  NAPI_CALL(env, napi_get_buffer_info(env, argv[1], &data, &len));
  ghostty_terminal_vt_write(s->terminal, (const uint8_t *)data, len);
  return NULL;
}

/* ── N-API: render ────────────────────────────────────────────────────── */

/**
 * render(session) → { handle, width, height, rowsDrawn, renderMs } | null
 * null = nothing changed since the last render.
 */
static napi_value Render(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  double t0 = CFAbsoluteTimeGetCurrent();

  THROW_IF(env, !accumulate_dirty(s), "render state update failed");
  if (!s->needs_present) {
    napi_value null_val;
    NAPI_CALL(env, napi_get_null(env, &null_val));
    return null_val;
  }

  GhosttyRenderStateColors colors = GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  THROW_IF(env,
           ghostty_render_state_colors_get(s->render_state, &colors) !=
               GHOSTTY_SUCCESS,
           "colors_get failed");

  // Cursor state for this frame.
  bool cur_visible = false, cur_valid = false;
  uint16_t ccx = 0, ccy = 0;
  GhosttyRenderStateCursorVisualStyle cur_style =
      GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
                           &cur_visible);
  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
                           &cur_valid);
  if (cur_visible && cur_valid) {
    ghostty_render_state_get(s->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X, &ccx);
    ghostty_render_state_get(s->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y, &ccy);
    ghostty_render_state_get(s->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
                             &cur_style);
  }
  GhosttyColorRgb cursor_color =
      colors.cursor_has_value ? colors.cursor : colors.foreground;

  s->surface_index ^= 1;
  IOSurfaceRef surface = s->surfaces[s->surface_index];
  uint64_t since = s->surface_seq[s->surface_index];

  IOSurfaceLock(surface, 0, NULL);
  CGContextRef ctx = CGBitmapContextCreate(
      IOSurfaceGetBaseAddress(surface), s->px_w, s->px_h, 8,
      IOSurfaceGetBytesPerRow(surface), s->colorspace,
      kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);

  CellSnap *snaps = malloc(sizeof(CellSnap) * s->cols);
  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                           &s->row_iter);
  int row = 0, rows_drawn = 0;
  while (ghostty_render_state_row_iterator_next(s->row_iter) &&
         row < s->rows) {
    if (s->row_modified[row] > since) {
      snapshot_row(s, &colors, snaps);
      int cursor_col =
          (cur_visible && cur_valid && ccy == row) ? (int)ccx : -1;
      draw_row(s, ctx, row, &colors, snaps, cursor_col, cur_style,
               cursor_color);
      rows_drawn++;
    }
    row++;
  }
  free(snaps);

  CGContextRelease(ctx);
  IOSurfaceUnlock(surface, 0, NULL);

  s->surface_seq[s->surface_index] = s->mod_seq;
  s->needs_present = false;

  double render_ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0;

  napi_value result, v, handle;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_buffer_copy(env, sizeof(IOSurfaceRef), &surface,
                                         NULL, &handle));
  NAPI_CALL(env, napi_set_named_property(env, result, "handle", handle));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_w, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", v));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_h, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", v));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)rows_drawn, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "rowsDrawn", v));
  NAPI_CALL(env, napi_create_double(env, render_ms, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "renderMs", v));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->surface_index, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "surfaceIndex", v));
  return result;
}

/* ── N-API: selection ─────────────────────────────────────────────────── */

static void dirty_all_rows(Session *s) {
  s->mod_seq++;
  for (uint16_t i = 0; i < s->rows; i++) s->row_modified[i] = s->mod_seq;
  s->needs_present = true;
}

/** setSelection(session, startX, startY, endX, endY) — viewport cell coords, end inclusive. */
static napi_value SetSelection(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 5, "setSelection(session, sx, sy, ex, ey)");

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  uint32_t coords[4];
  for (int i = 0; i < 4; i++)
    NAPI_CALL(env, napi_get_value_uint32(env, argv[i + 1], &coords[i]));

  GhosttyGridRef refs[2];
  for (int i = 0; i < 2; i++) {
    refs[i] = (GhosttyGridRef)GHOSTTY_INIT_SIZED(GhosttyGridRef);
    GhosttyPoint pt = {
        .tag = GHOSTTY_POINT_TAG_VIEWPORT,
        .value = {.coordinate = {.x = (uint16_t)coords[i * 2],
                                 .y = (uint16_t)coords[i * 2 + 1]}},
    };
    THROW_IF(env,
             ghostty_terminal_grid_ref(s->terminal, pt, &refs[i]) !=
                 GHOSTTY_SUCCESS,
             "grid_ref failed");
  }

  GhosttySelection sel = GHOSTTY_INIT_SIZED(GhosttySelection);
  sel.start = refs[0];
  sel.end = refs[1];
  THROW_IF(env,
           ghostty_terminal_set(s->terminal, GHOSTTY_TERMINAL_OPT_SELECTION,
                                &sel) != GHOSTTY_SUCCESS,
           "set selection failed");
  dirty_all_rows(s);
  return NULL;
}

/** clearSelection(session) */
static napi_value ClearSelection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  ghostty_terminal_set(s->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, NULL);
  dirty_all_rows(s);
  return NULL;
}

/** getSelectionText(session) → string | null */
static napi_value GetSelectionText(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  napi_value null_val;
  NAPI_CALL(env, napi_get_null(env, &null_val));

  GhosttySelection sel = GHOSTTY_INIT_SIZED(GhosttySelection);
  if (ghostty_terminal_get(s->terminal, GHOSTTY_TERMINAL_DATA_SELECTION,
                           &sel) != GHOSTTY_SUCCESS)
    return null_val;

  GhosttyFormatterTerminalOptions opts =
      GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  opts.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  opts.trim = true;
  opts.unwrap = true;
  opts.selection = &sel;

  GhosttyFormatter formatter;
  if (ghostty_formatter_terminal_new(NULL, &formatter, s->terminal, opts) !=
      GHOSTTY_SUCCESS)
    return null_val;

  uint8_t *buf = NULL;
  size_t len = 0;
  napi_value result = null_val;
  if (ghostty_formatter_format_alloc(formatter, NULL, &buf, &len) ==
          GHOSTTY_SUCCESS &&
      buf) {
    napi_create_string_utf8(env, (const char *)buf, len, &result);
    ghostty_free(NULL, buf, len);
  }
  ghostty_formatter_free(formatter);
  return result;
}

/* ── N-API: getText ───────────────────────────────────────────────────── */

/** getText(session) → string[] — viewport rows as UTF-8 text (right-trimmed). */
static napi_value GetText(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  THROW_IF(env, !accumulate_dirty(s), "render state update failed");

  napi_value lines;
  NAPI_CALL(env, napi_create_array_with_length(env, s->rows, &lines));

  char *line = malloc((size_t)s->cols * 16 + 1);
  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                           &s->row_iter);
  uint32_t row = 0;
  while (ghostty_render_state_row_iterator_next(s->row_iter) &&
         row < s->rows) {
    ghostty_render_state_row_get(s->row_iter,
                                 GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                                 &s->cells);
    size_t len = 0;
    while (ghostty_render_state_row_cells_next(s->cells)) {
      // Spacer cells (after a wide char / at a soft-wrap boundary) contribute
      // no column to the text, matching xterm's translateToString().
      GhosttyCellWide wide = current_cell_wide(s);
      if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL ||
          wide == GHOSTTY_CELL_WIDE_SPACER_HEAD)
        continue;
      char utf8[16];
      GhosttyBuffer buf = {.ptr = (uint8_t *)utf8, .cap = sizeof(utf8), .len = 0};
      if (ghostty_render_state_row_cells_get(
              s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8,
              &buf) == GHOSTTY_SUCCESS &&
          buf.len > 0) {
        memcpy(line + len, utf8, buf.len);
        len += buf.len;
      } else {
        line[len++] = ' ';
      }
    }
    while (len > 0 && line[len - 1] == ' ') len--;  // right-trim

    napi_value str;
    NAPI_CALL(env, napi_create_string_utf8(env, line, len, &str));
    NAPI_CALL(env, napi_set_element(env, lines, row, str));
    row++;
  }
  free(line);
  return lines;
}

/* ── N-API: readPixels ────────────────────────────────────────────────── */

/** readPixels(session) → { width, height, data: Buffer } — BGRA, tightly packed, from the last-rendered surface. */
static napi_value ReadPixels(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  IOSurfaceRef surface = s->surfaces[s->surface_index];
  IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL);
  const uint8_t *base = IOSurfaceGetBaseAddress(surface);
  size_t stride = IOSurfaceGetBytesPerRow(surface);

  napi_value data;
  void *out;
  NAPI_CALL(env, napi_create_buffer(env, s->px_w * s->px_h * 4, &out, &data));
  for (size_t y = 0; y < s->px_h; y++)
    memcpy((uint8_t *)out + y * s->px_w * 4, base + y * stride, s->px_w * 4);
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);

  napi_value result, v;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_w, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", v));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_h, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", v));
  NAPI_CALL(env, napi_set_named_property(env, result, "data", data));
  return result;
}

/* ── N-API: getCursor ─────────────────────────────────────────────────── */

/** getCursor(session) → { x, y, visible, style } */
static napi_value GetCursor(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  THROW_IF(env, !accumulate_dirty(s), "render state update failed");

  bool visible = false, valid = false;
  uint16_t x = 0, y = 0;
  GhosttyRenderStateCursorVisualStyle style =
      GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE, &visible);
  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
                           &valid);
  if (valid) {
    ghostty_render_state_get(s->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X, &x);
    ghostty_render_state_get(s->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y, &y);
    ghostty_render_state_get(s->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
                             &style);
  }

  const char *style_name = "block";
  if (style == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR) style_name = "bar";
  else if (style == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_UNDERLINE)
    style_name = "underline";
  else if (style == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK_HOLLOW)
    style_name = "hollow";

  napi_value result, v;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_int32(env, valid ? x : -1, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "x", v));
  NAPI_CALL(env, napi_create_int32(env, valid ? y : -1, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "y", v));
  NAPI_CALL(env, napi_get_boolean(env, visible && valid, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "visible", v));
  NAPI_CALL(env, napi_create_string_utf8(env, style_name, NAPI_AUTO_LENGTH, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "style", v));
  return result;
}

/* ── N-API: resize ────────────────────────────────────────────────────── */

/** resize(session, cols, rows) → { width, height } */
static napi_value Resize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 3, "resize(session, cols, rows)");

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  uint32_t cols, rows;
  NAPI_CALL(env, napi_get_value_uint32(env, argv[1], &cols));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[2], &rows));
  THROW_IF(env, cols == 0 || rows == 0, "invalid dimensions");

  THROW_IF(env,
           ghostty_terminal_resize(s->terminal, (uint16_t)cols, (uint16_t)rows,
                                   (uint32_t)s->cell_w,
                                   (uint32_t)s->cell_h) != GHOSTTY_SUCCESS,
           "terminal resize failed");

  s->cols = (uint16_t)cols;
  s->rows = (uint16_t)rows;
  s->px_w = (size_t)(s->cell_w * cols);
  s->px_h = (size_t)(s->cell_h * rows);

  for (int i = 0; i < 2; i++) {
    CFRelease(s->surfaces[i]);
    s->surfaces[i] = create_surface(s->px_w, s->px_h);
    s->surface_seq[i] = 0;
  }
  free(s->row_modified);
  s->row_modified = calloc(rows, sizeof(uint64_t));
  s->mod_seq++;
  for (uint32_t i = 0; i < rows; i++) s->row_modified[i] = s->mod_seq;
  s->needs_present = true;

  napi_value result, v;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_w, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", v));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_h, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", v));
  return result;
}

/* ── N-API: scroll ────────────────────────────────────────────────────── */

/** scroll(session, deltaRows) — negative scrolls up (into scrollback). */
static napi_value Scroll(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 2, "scroll(session, deltaRows)");

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  int32_t delta;
  NAPI_CALL(env, napi_get_value_int32(env, argv[1], &delta));

  GhosttyTerminalScrollViewport behavior = {
      .tag = GHOSTTY_SCROLL_VIEWPORT_DELTA,
      .value = {.delta = (intptr_t)delta},
  };
  ghostty_terminal_scroll_viewport(s->terminal, behavior);
  return NULL;
}

/* ── N-API: encodeKey ─────────────────────────────────────────────────── */

typedef struct {
  const char *code;
  GhosttyKey key;
} KeyMapEntry;

static const KeyMapEntry KEY_MAP[] = {
    {"Backquote", GHOSTTY_KEY_BACKQUOTE},
    {"Backslash", GHOSTTY_KEY_BACKSLASH},
    {"BracketLeft", GHOSTTY_KEY_BRACKET_LEFT},
    {"BracketRight", GHOSTTY_KEY_BRACKET_RIGHT},
    {"Comma", GHOSTTY_KEY_COMMA},
    {"Equal", GHOSTTY_KEY_EQUAL},
    {"Minus", GHOSTTY_KEY_MINUS},
    {"Period", GHOSTTY_KEY_PERIOD},
    {"Quote", GHOSTTY_KEY_QUOTE},
    {"Semicolon", GHOSTTY_KEY_SEMICOLON},
    {"Slash", GHOSTTY_KEY_SLASH},
    {"Backspace", GHOSTTY_KEY_BACKSPACE},
    {"Enter", GHOSTTY_KEY_ENTER},
    {"Space", GHOSTTY_KEY_SPACE},
    {"Tab", GHOSTTY_KEY_TAB},
    {"Delete", GHOSTTY_KEY_DELETE},
    {"End", GHOSTTY_KEY_END},
    {"Home", GHOSTTY_KEY_HOME},
    {"Insert", GHOSTTY_KEY_INSERT},
    {"PageDown", GHOSTTY_KEY_PAGE_DOWN},
    {"PageUp", GHOSTTY_KEY_PAGE_UP},
    {"ArrowDown", GHOSTTY_KEY_ARROW_DOWN},
    {"ArrowLeft", GHOSTTY_KEY_ARROW_LEFT},
    {"ArrowRight", GHOSTTY_KEY_ARROW_RIGHT},
    {"ArrowUp", GHOSTTY_KEY_ARROW_UP},
    {"Escape", GHOSTTY_KEY_ESCAPE},
    {"NumpadEnter", GHOSTTY_KEY_NUMPAD_ENTER},
};

static GhosttyKey map_key_code(const char *code) {
  // KeyA..KeyZ / Digit0..Digit9 / F1..F12 handled arithmetically.
  if (strncmp(code, "Key", 3) == 0 && code[3] >= 'A' && code[3] <= 'Z' &&
      code[4] == 0)
    return (GhosttyKey)(GHOSTTY_KEY_A + (code[3] - 'A'));
  if (strncmp(code, "Digit", 5) == 0 && code[5] >= '0' && code[5] <= '9' &&
      code[6] == 0)
    return (GhosttyKey)(GHOSTTY_KEY_DIGIT_0 + (code[5] - '0'));
  if (code[0] == 'F' && code[1] >= '1' && code[1] <= '9') {
    int n = atoi(code + 1);
    if (n >= 1 && n <= 12) return (GhosttyKey)(GHOSTTY_KEY_F1 + (n - 1));
  }
  for (size_t i = 0; i < sizeof(KEY_MAP) / sizeof(KEY_MAP[0]); i++)
    if (strcmp(code, KEY_MAP[i].code) == 0) return KEY_MAP[i].key;
  return GHOSTTY_KEY_UNIDENTIFIED;
}

/**
 * encodeKey(session, { code, utf8?, shift?, ctrl?, alt?, super?, action? })
 *   → Buffer (may be empty)
 * Mode-aware: encoder options are refreshed from the terminal each call, so
 * DECCKM / keypad / kitty protocol states are respected.
 */
static napi_value EncodeKey(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 2, "encodeKey(session, event)");

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  char code[32] = {0};
  char utf8[16] = {0};
  size_t utf8_len = 0;
  bool shift = false, ctrl = false, alt = false, superk = false;
  char action[16] = "press";

  napi_value v;
  bool has;
  NAPI_CALL(env, napi_has_named_property(env, argv[1], "code", &has));
  if (has) {
    NAPI_CALL(env, napi_get_named_property(env, argv[1], "code", &v));
    napi_get_value_string_utf8(env, v, code, sizeof(code), NULL);
  }
  NAPI_CALL(env, napi_has_named_property(env, argv[1], "utf8", &has));
  if (has) {
    NAPI_CALL(env, napi_get_named_property(env, argv[1], "utf8", &v));
    napi_get_value_string_utf8(env, v, utf8, sizeof(utf8), &utf8_len);
  }
  NAPI_CALL(env, napi_has_named_property(env, argv[1], "action", &has));
  if (has) {
    NAPI_CALL(env, napi_get_named_property(env, argv[1], "action", &v));
    napi_get_value_string_utf8(env, v, action, sizeof(action), NULL);
  }
#define GET_BOOL(name, out)                                              \
  do {                                                                   \
    NAPI_CALL(env, napi_has_named_property(env, argv[1], name, &has));   \
    if (has) {                                                           \
      NAPI_CALL(env, napi_get_named_property(env, argv[1], name, &v));   \
      napi_get_value_bool(env, v, &(out));                               \
    }                                                                    \
  } while (0)
  GET_BOOL("shift", shift);
  GET_BOOL("ctrl", ctrl);
  GET_BOOL("alt", alt);
  GET_BOOL("super", superk);
#undef GET_BOOL

  // Refresh encoder options from current terminal modes (DECCKM etc.).
  ghostty_key_encoder_setopt_from_terminal(s->key_encoder, s->terminal);

  GhosttyKeyAction act = GHOSTTY_KEY_ACTION_PRESS;
  if (strcmp(action, "release") == 0) act = GHOSTTY_KEY_ACTION_RELEASE;
  else if (strcmp(action, "repeat") == 0) act = GHOSTTY_KEY_ACTION_REPEAT;

  GhosttyMods mods = 0;
  if (shift) mods |= GHOSTTY_MODS_SHIFT;
  if (ctrl) mods |= GHOSTTY_MODS_CTRL;
  if (alt) mods |= GHOSTTY_MODS_ALT;
  if (superk) mods |= GHOSTTY_MODS_SUPER;

  ghostty_key_event_set_action(s->key_event, act);
  ghostty_key_event_set_key(s->key_event, map_key_code(code));
  ghostty_key_event_set_mods(s->key_event, mods);
  ghostty_key_event_set_utf8(s->key_event, utf8, utf8_len);

  char out[128];
  size_t written = 0;
  GhosttyResult res = ghostty_key_encoder_encode(s->key_encoder, s->key_event,
                                                 out, sizeof(out), &written);
  if (res != GHOSTTY_SUCCESS) written = 0;

  napi_value buf;
  void *data;
  NAPI_CALL(env, napi_create_buffer_copy(env, written, out, &data, &buf));
  return buf;
}

/* ── Module init ──────────────────────────────────────────────────────── */

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"create", NULL, Create, NULL, NULL, NULL, napi_default, NULL},
      {"write", NULL, WriteVt, NULL, NULL, NULL, napi_default, NULL},
      {"render", NULL, Render, NULL, NULL, NULL, napi_default, NULL},
      {"getText", NULL, GetText, NULL, NULL, NULL, napi_default, NULL},
      {"readPixels", NULL, ReadPixels, NULL, NULL, NULL, napi_default, NULL},
      {"getCursor", NULL, GetCursor, NULL, NULL, NULL, napi_default, NULL},
      {"resize", NULL, Resize, NULL, NULL, NULL, napi_default, NULL},
      {"scroll", NULL, Scroll, NULL, NULL, NULL, napi_default, NULL},
      {"encodeKey", NULL, EncodeKey, NULL, NULL, NULL, napi_default, NULL},
      {"setSelection", NULL, SetSelection, NULL, NULL, NULL, napi_default, NULL},
      {"clearSelection", NULL, ClearSelection, NULL, NULL, NULL, napi_default, NULL},
      {"getSelectionText", NULL, GetSelectionText, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
