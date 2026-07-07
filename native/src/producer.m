/**
 * ghostty_producer — native terminal frame producer.
 *
 * libghostty-vt parses the VT stream and maintains terminal state; this addon
 * renders the visible grid with CoreText into an IOSurface that Electron's
 * sharedTexture module can import zero-copy (handle.ioSurface is a Buffer
 * holding the process-local IOSurfaceRef).
 *
 * Frames are double-buffered: render() alternates between two IOSurfaces so
 * the GPU can scan out frame N while we draw frame N+1.
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

typedef struct {
  GhosttyTerminal terminal;
  GhosttyRenderState render_state;
  GhosttyRenderStateRowIterator row_iter;
  GhosttyRenderStateRowCells cells;

  IOSurfaceRef surfaces[2];
  int surface_index;

  CGColorSpaceRef colorspace;
  CTFontRef font;
  CTFontRef font_bold;

  uint16_t cols, rows;
  double cell_w, cell_h, ascent;
  size_t px_w, px_h;
} Session;

static GhosttyColorRgb resolve_color(GhosttyStyleColor color,
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

static void session_free(Session *s) {
  if (!s) return;
  if (s->cells) ghostty_render_state_row_cells_free(s->cells);
  if (s->row_iter) ghostty_render_state_row_iterator_free(s->row_iter);
  if (s->render_state) ghostty_render_state_free(s->render_state);
  if (s->terminal) ghostty_terminal_free(s->terminal);
  for (int i = 0; i < 2; i++)
    if (s->surfaces[i]) CFRelease(s->surfaces[i]);
  if (s->font) CFRelease(s->font);
  if (s->font_bold) CFRelease(s->font_bold);
  if (s->colorspace) CGColorSpaceRelease(s->colorspace);
  free(s);
}

static void finalize_session(napi_env env, void *data, void *hint) {
  session_free((Session *)data);
}

/** create(cols, rows, fontSizePx) → { session, width, height, cellWidth, cellHeight } */
static napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 3, "create(cols, rows, fontSizePx)");

  uint32_t cols, rows;
  double font_size;
  NAPI_CALL(env, napi_get_value_uint32(env, argv[0], &cols));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[1], &rows));
  NAPI_CALL(env, napi_get_value_double(env, argv[2], &font_size));

  Session *s = calloc(1, sizeof(Session));
  THROW_IF(env, !s, "out of memory");
  s->cols = (uint16_t)cols;
  s->rows = (uint16_t)rows;

  s->font = CTFontCreateWithName(CFSTR("Menlo"), font_size, NULL);
  s->font_bold = CTFontCreateCopyWithSymbolicTraits(
      s->font, font_size, NULL, kCTFontBoldTrait, kCTFontBoldTrait);
  if (!s->font_bold) s->font_bold = (CTFontRef)CFRetain(s->font);

  // Cell metrics from the advance of 'M' and the font's vertical metrics.
  UniChar m_char = 'M';
  CGGlyph m_glyph;
  CTFontGetGlyphsForCharacters(s->font, &m_char, &m_glyph, 1);
  CGSize advance;
  CTFontGetAdvancesForGlyphs(s->font, kCTFontOrientationHorizontal, &m_glyph,
                             &advance, 1);
  s->ascent = CTFontGetAscent(s->font);
  s->cell_w = ceil(advance.width);
  s->cell_h = ceil(s->ascent + CTFontGetDescent(s->font) +
                   CTFontGetLeading(s->font));
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

  GhosttyTerminalOptions opts = {
      .cols = s->cols,
      .rows = s->rows,
      .max_scrollback = 1000,
  };
  if (ghostty_terminal_new(NULL, &s->terminal, opts) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &s->render_state) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &s->row_iter) !=
          GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &s->cells) != GHOSTTY_SUCCESS) {
    session_free(s);
    napi_throw_error(env, NULL, "libghostty-vt initialization failed");
    return NULL;
  }

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

/** write(session, buffer) — feed VT bytes into the terminal. */
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

/** Draw one row's cells into the CG context. */
static void draw_row(Session *s, CGContextRef ctx, int row_index,
                     const GhosttyRenderStateColors *colors) {
  double y_top = row_index * s->cell_h;          // top-down pixel space
  double cg_baseline = s->px_h - y_top - s->ascent;  // CG is bottom-up

  // Collect the row's codepoints (UTF-32) and per-cell styles.
  uint32_t *cps = malloc(sizeof(uint32_t) * s->cols);
  GhosttyStyle *styles = malloc(sizeof(GhosttyStyle) * s->cols);

  ghostty_render_state_row_get(s->row_iter, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                               &s->cells);
  int col = 0;
  while (ghostty_render_state_row_cells_next(s->cells) && col < s->cols) {
    uint32_t grapheme_len = 0;
    ghostty_render_state_row_cells_get(
        s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
        &grapheme_len);

    GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
    ghostty_render_state_row_cells_get(
        s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
    styles[col] = style;

    if (grapheme_len == 0) {
      cps[col] = ' ';
    } else {
      uint32_t buf[32];
      ghostty_render_state_row_cells_get(
          s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, buf);
      cps[col] = buf[0];  // first codepoint; combining marks skipped
    }
    col++;
  }
  for (; col < s->cols; col++) {
    cps[col] = ' ';
    styles[col] = (GhosttyStyle)GHOSTTY_INIT_SIZED(GhosttyStyle);
  }

  // Background rects for cells whose bg differs from the default.
  for (int c = 0; c < s->cols; c++) {
    if (styles[c].bg_color.tag == GHOSTTY_STYLE_COLOR_NONE) continue;
    GhosttyColorRgb bg = resolve_color(styles[c].bg_color, colors,
                                       colors->background);
    CGContextSetRGBFillColor(ctx, bg.r / 255.0, bg.g / 255.0, bg.b / 255.0, 1);
    CGContextFillRect(ctx, CGRectMake(c * s->cell_w,
                                      s->px_h - y_top - s->cell_h,
                                      s->cell_w, s->cell_h));
  }

  // Text: one attributed string per row, colored per style run.
  CFStringRef str = CFStringCreateWithBytes(
      NULL, (const UInt8 *)cps, s->cols * sizeof(uint32_t),
      kCFStringEncodingUTF32LE, false);
  if (!str) {
    free(cps);
    free(styles);
    return;
  }

  CFMutableAttributedStringRef attr =
      CFAttributedStringCreateMutable(NULL, 0);
  CFAttributedStringReplaceString(attr, CFRangeMake(0, 0), str);
  CFIndex str_len = CFAttributedStringGetLength(attr);
  CFAttributedStringSetAttribute(attr, CFRangeMake(0, str_len),
                                 kCTFontAttributeName, s->font);

  // NOTE: UTF-16 index == column only for BMP content; fine for this bench.
  for (int c = 0; c < s->cols && c < str_len; c++) {
    GhosttyColorRgb fg =
        resolve_color(styles[c].fg_color, colors, colors->foreground);
    CGFloat comps[4] = {fg.r / 255.0, fg.g / 255.0, fg.b / 255.0, 1.0};
    CGColorRef color = CGColorCreate(s->colorspace, comps);
    CFAttributedStringSetAttribute(attr, CFRangeMake(c, 1),
                                   kCTForegroundColorAttributeName, color);
    CGColorRelease(color);
    if (styles[c].bold) {
      CFAttributedStringSetAttribute(attr, CFRangeMake(c, 1),
                                     kCTFontAttributeName, s->font_bold);
    }
  }

  CTLineRef line = CTLineCreateWithAttributedString(attr);
  CGContextSetTextPosition(ctx, 0, cg_baseline);
  CTLineDraw(line, ctx);

  CFRelease(line);
  CFRelease(attr);
  CFRelease(str);
  free(cps);
  free(styles);
}

/**
 * render(session) → { handle, width, height } | null
 *
 * Updates render state from the terminal; if anything changed, draws the full
 * viewport into the back IOSurface and returns its handle. Returns null when
 * the frame is clean (caller keeps presenting the previous surface).
 */
static napi_value Render(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  THROW_IF(env,
           ghostty_render_state_update(s->render_state, s->terminal) !=
               GHOSTTY_SUCCESS,
           "render_state_update failed");

  GhosttyRenderStateDirty dirty;
  THROW_IF(env,
           ghostty_render_state_get(s->render_state,
                                    GHOSTTY_RENDER_STATE_DATA_DIRTY,
                                    &dirty) != GHOSTTY_SUCCESS,
           "render_state_get(DIRTY) failed");
  if (dirty == GHOSTTY_RENDER_STATE_DIRTY_FALSE) {
    napi_value null_val;
    NAPI_CALL(env, napi_get_null(env, &null_val));
    return null_val;
  }

  GhosttyRenderStateColors colors = GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  THROW_IF(env,
           ghostty_render_state_colors_get(s->render_state, &colors) !=
               GHOSTTY_SUCCESS,
           "colors_get failed");

  // Flip buffers and draw the whole viewport (double buffering keeps the
  // in-flight frame stable; full redraw keeps buffer contents consistent).
  s->surface_index ^= 1;
  IOSurfaceRef surface = s->surfaces[s->surface_index];

  IOSurfaceLock(surface, 0, NULL);
  CGContextRef ctx = CGBitmapContextCreate(
      IOSurfaceGetBaseAddress(surface), s->px_w, s->px_h, 8,
      IOSurfaceGetBytesPerRow(surface), s->colorspace,
      kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);

  CGContextSetRGBFillColor(ctx, colors.background.r / 255.0,
                           colors.background.g / 255.0,
                           colors.background.b / 255.0, 1);
  CGContextFillRect(ctx, CGRectMake(0, 0, s->px_w, s->px_h));

  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                           &s->row_iter);
  int row_index = 0;
  while (ghostty_render_state_row_iterator_next(s->row_iter)) {
    draw_row(s, ctx, row_index, &colors);
    bool clean = false;
    ghostty_render_state_row_set(s->row_iter,
                                 GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY, &clean);
    row_index++;
  }

  CGContextRelease(ctx);
  IOSurfaceUnlock(surface, 0, NULL);

  GhosttyRenderStateDirty clean_state = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  ghostty_render_state_set(s->render_state, GHOSTTY_RENDER_STATE_OPTION_DIRTY,
                           &clean_state);

  napi_value result, v, handle;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_buffer_copy(env, sizeof(IOSurfaceRef), &surface,
                                         NULL, &handle));
  NAPI_CALL(env, napi_set_named_property(env, result, "handle", handle));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_w, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", v));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_h, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", v));
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"create", NULL, Create, NULL, NULL, NULL, napi_default, NULL},
      {"write", NULL, WriteVt, NULL, NULL, NULL, napi_default, NULL},
      {"render", NULL, Render, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(ghostty_producer, Init)
