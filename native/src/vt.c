/**
 * Platform-independent core of the ghostty_producer addon: libghostty-vt
 * session lifecycle, VT parsing, grid text/cursor readout, viewport
 * scrolling, resize, selection, and mode-aware key encoding.
 *
 * Rendering lives in the platform layer (see session.h).
 */
#include <string.h>

#include "session.h"

Session *gxb_get_session(napi_env env, napi_value ext) {
  void *data = NULL;
  if (napi_get_value_external(env, ext, &data) != napi_ok || !data) {
    napi_throw_error(env, NULL, "invalid session");
    return NULL;
  }
  return (Session *)data;
}

GhosttyCellWide gxb_current_cell_wide(Session *s) {
  GhosttyCell raw = 0;
  GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
  if (ghostty_render_state_row_cells_get(
          s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw) ==
      GHOSTTY_SUCCESS)
    ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
  return wide;
}

/**
 * Pull dirty state out of the terminal into our sequence-number model and
 * reset libghostty's dirty flags. Called by render() and getText() so text
 * readout never eats a pending present.
 */
bool gxb_accumulate_dirty(Session *s) {
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

static void session_free(Session *s) {
  if (!s) return;
  if (s->key_event) ghostty_key_event_free(s->key_event);
  if (s->key_encoder) ghostty_key_encoder_free(s->key_encoder);
  if (s->cells) ghostty_render_state_row_cells_free(s->cells);
  if (s->row_iter) ghostty_render_state_row_iterator_free(s->row_iter);
  if (s->render_state) ghostty_render_state_free(s->render_state);
  if (s->terminal) ghostty_terminal_free(s->terminal);
  gxb_platform_free(s);
  free(s->row_modified);
  free(s);
}

static void finalize_session(napi_env env, void *data, void *hint) {
  session_free((Session *)data);
}

/* ── create ───────────────────────────────────────────────────────────── */

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

  // Platform layer sets cell metrics (fonts on macOS, nominal elsewhere).
  if (!gxb_platform_init(env, s, font_size)) {
    session_free(s);
    return NULL;  // platform layer threw
  }
  s->px_w = (size_t)(s->cell_w * cols);
  s->px_h = (size_t)(s->cell_h * rows);
  if (!gxb_platform_resize(env, s)) {
    session_free(s);
    return NULL;
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

/* ── write ────────────────────────────────────────────────────────────── */

static napi_value WriteVt(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 2, "write(session, buffer)");

  Session *s = gxb_get_session(env, argv[0]);
  if (!s) return NULL;

  void *data;
  size_t len;
  NAPI_CALL(env, napi_get_buffer_info(env, argv[1], &data, &len));
  ghostty_terminal_vt_write(s->terminal, (const uint8_t *)data, len);
  return NULL;
}

/* ── getText ──────────────────────────────────────────────────────────── */

/** getText(session) → string[] — viewport rows as UTF-8 text (right-trimmed). */
static napi_value GetText(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = gxb_get_session(env, argv[0]);
  if (!s) return NULL;

  THROW_IF(env, !gxb_accumulate_dirty(s), "render state update failed");

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
      GhosttyCellWide wide = gxb_current_cell_wide(s);
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

/* ── getCursor ────────────────────────────────────────────────────────── */

/** getCursor(session) → { x, y, visible, style } */
static napi_value GetCursor(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = gxb_get_session(env, argv[0]);
  if (!s) return NULL;

  THROW_IF(env, !gxb_accumulate_dirty(s), "render state update failed");

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

/* ── resize ───────────────────────────────────────────────────────────── */

/** resize(session, cols, rows) → { width, height } */
static napi_value Resize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 3, "resize(session, cols, rows)");

  Session *s = gxb_get_session(env, argv[0]);
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

  if (!gxb_platform_resize(env, s)) return NULL;
  s->surface_seq[0] = 0;
  s->surface_seq[1] = 0;

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

/* ── scroll ───────────────────────────────────────────────────────────── */

/** scroll(session, deltaRows) — negative scrolls up (into scrollback). */
static napi_value Scroll(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  THROW_IF(env, argc < 2, "scroll(session, deltaRows)");

  Session *s = gxb_get_session(env, argv[0]);
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

/* ── selection ────────────────────────────────────────────────────────── */

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

  Session *s = gxb_get_session(env, argv[0]);
  if (!s) return NULL;

  uint32_t coords[4];
  for (int i = 0; i < 4; i++)
    NAPI_CALL(env, napi_get_value_uint32(env, argv[i + 1], &coords[i]));

  GhosttyGridRef refs[2];
  for (int i = 0; i < 2; i++) {
    // GHOSTTY_INIT_SIZED is already a typed compound literal; an extra cast
    // is an (illegal) struct-to-struct conversion under MSVC.
    refs[i] = GHOSTTY_INIT_SIZED(GhosttyGridRef);
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

  Session *s = gxb_get_session(env, argv[0]);
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

  Session *s = gxb_get_session(env, argv[0]);
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

/* ── encodeKey ────────────────────────────────────────────────────────── */

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

  Session *s = gxb_get_session(env, argv[0]);
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
      {"getText", NULL, GetText, NULL, NULL, NULL, napi_default, NULL},
      {"getCursor", NULL, GetCursor, NULL, NULL, NULL, napi_default, NULL},
      {"resize", NULL, Resize, NULL, NULL, NULL, napi_default, NULL},
      {"scroll", NULL, Scroll, NULL, NULL, NULL, napi_default, NULL},
      {"encodeKey", NULL, EncodeKey, NULL, NULL, NULL, napi_default, NULL},
      {"setSelection", NULL, SetSelection, NULL, NULL, NULL, napi_default, NULL},
      {"clearSelection", NULL, ClearSelection, NULL, NULL, NULL, napi_default, NULL},
      {"getSelectionText", NULL, GetSelectionText, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  gxb_platform_register(env, exports);  // render/readPixels on macOS
  return exports;
}
