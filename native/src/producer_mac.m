/**
 * macOS presentation layer: renders the terminal grid with CoreText into
 * IOSurfaces that Electron's sharedTexture module imports zero-copy
 * (handle.ioSurface is a Buffer holding the process-local IOSurfaceRef).
 *
 * Rendering model:
 *  - HiDPI aware: all pixel dimensions are physical (logical size × scale).
 *  - Double-buffered: render() alternates between two IOSurfaces so the GPU
 *    can scan out frame N while frame N+1 is drawn.
 *  - Dirty-row incremental: each surface only redraws rows modified since
 *    that surface was last rendered; row draws are clipped so output is
 *    pixel-identical to a full redraw (test-enforced).
 *  - Glyph runs: ASCII fast path uses a per-font glyph cache and batched
 *    CTFontDrawGlyphs runs; box drawing/blocks/braille are drawn as geometry
 *    (font fallback misplaces them); other non-ASCII goes through CTLine.
 *  - Styles: fg/bg (palette + truecolor), bold (incl. bold-in-bright-colors
 *    like xterm.js), italic, inverse, faint, underline, strikethrough,
 *    selection inversion, cursor (block/bar/underline/hollow).
 */
#include <string.h>

#import <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>

#include "session.h"

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

/* ── Platform hooks ───────────────────────────────────────────────────── */

bool gxb_platform_init(napi_env env, Session *s, double font_size) {
  s->fonts[FONT_REGULAR] =
      CTFontCreateWithName(CFSTR("Menlo"), font_size * s->scale, NULL);
  CTFontSymbolicTraits traits[FONT_COUNT] = {
      0, kCTFontBoldTrait, kCTFontItalicTrait,
      kCTFontBoldTrait | kCTFontItalicTrait};
  for (int i = 1; i < FONT_COUNT; i++) {
    s->fonts[i] = CTFontCreateCopyWithSymbolicTraits(
        s->fonts[FONT_REGULAR], font_size * s->scale, NULL, traits[i],
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

  s->colorspace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  return true;
}

void gxb_platform_free(Session *s) {
  for (int i = 0; i < 2; i++)
    if (s->surfaces[i]) CFRelease(s->surfaces[i]);
  for (int i = 0; i < FONT_COUNT; i++)
    if (s->fonts[i]) CFRelease(s->fonts[i]);
  if (s->colorspace) CGColorSpaceRelease(s->colorspace);
}

bool gxb_platform_resize(napi_env env, Session *s) {
  for (int i = 0; i < 2; i++) {
    if (s->surfaces[i]) CFRelease(s->surfaces[i]);
    s->surfaces[i] = create_surface(s->px_w, s->px_h);
    if (!s->surfaces[i]) {
      napi_throw_error(env, NULL, "IOSurfaceCreate failed");
      return false;
    }
  }
  return true;
}

/* ── Row drawing ──────────────────────────────────────────────────────── */

/** Read the current row's cells into snapshots. */
static void snapshot_row(Session *s, const GhosttyRenderStateColors *colors,
                         CellSnap *snaps) {
  ghostty_render_state_row_get(s->row_iter, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                               &s->cells);
  int col = 0;
  while (ghostty_render_state_row_cells_next(s->cells) && col < s->cols) {
    CellSnap *snap = &snaps[col];
    memset(snap, 0, sizeof(*snap));
    snap->fg = colors->foreground;

    GhosttyCellWide wide = gxb_current_cell_wide(s);
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
  // CTFontDrawGlyphs runs; everything else goes through geometry or CTLine.
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

/* ── N-API: render ────────────────────────────────────────────────────── */

/**
 * render(session) → { handle, width, height, rowsDrawn, renderMs, surfaceIndex } | null
 * null = nothing changed since the last render.
 */
static napi_value Render(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = gxb_get_session(env, argv[0]);
  if (!s) return NULL;

  double t0 = CFAbsoluteTimeGetCurrent();

  THROW_IF(env, !gxb_accumulate_dirty(s), "render state update failed");
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

/* ── N-API: readPixels ────────────────────────────────────────────────── */

/** readPixels(session) → { width, height, data: Buffer } — BGRA, tightly packed, from the last-rendered surface. */
static napi_value ReadPixels(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = gxb_get_session(env, argv[0]);
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

void gxb_platform_register(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"render", NULL, Render, NULL, NULL, NULL, napi_default, NULL},
      {"readPixels", NULL, ReadPixels, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
}
