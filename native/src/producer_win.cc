/**
 * Windows presentation layer: renders the terminal grid with DirectWrite/
 * Direct2D into shared D3D11 textures that Electron's sharedTexture module
 * imports zero-copy (handle.ntHandle is a Buffer holding the process-local
 * NT HANDLE from IDXGIResource1::CreateSharedHandle).
 *
 * Mirrors the macOS producer: HiDPI physical pixels, double buffering,
 * dirty-row incremental redraws with per-row clipping, geometric box/block/
 * braille drawing, styles, selection inversion, cursor shapes. Rendering
 * happens through D2D on a hardware device when available, else WARP — so
 * the pixel-level tests run headless on CI.
 */
#include <d2d1_1.h>
#include <d3d11.h>
#include <dwrite.h>
#include <dxgi1_2.h>
#include <windows.h>

#include <cmath>
#include <cstring>
#include <string>

extern "C" {
#include "session.h"
}

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "dwrite.lib")
#pragma comment(lib, "dxgi.lib")

namespace {

template <typename T>
struct Com {
  T *p = nullptr;
  ~Com() { reset(); }
  void reset() { if (p) { p->Release(); p = nullptr; } }
  T **operator&() { reset(); return &p; }
  T *operator->() const { return p; }
  operator T *() const { return p; }
};

struct WinState {
  Com<ID3D11Device> device;
  Com<ID3D11DeviceContext> context;
  Com<ID2D1Factory1> d2dFactory;
  Com<ID2D1Device> d2dDevice;
  Com<ID2D1DeviceContext> d2dCtx;
  Com<IDWriteFactory> dwrite;
  Com<IDWriteTextFormat> formats[FONT_COUNT];
  Com<ID2D1SolidColorBrush> brush;

  Com<ID3D11Texture2D> textures[2];
  Com<ID2D1Bitmap1> targets[2];
  HANDLE ntHandles[2] = {nullptr, nullptr};
};

WinState *ws(Session *s) { return static_cast<WinState *>(s->win); }

D2D1_COLOR_F rgb(GhosttyColorRgb c, float a = 1.0f) {
  return D2D1::ColorF(c.r / 255.0f, c.g / 255.0f, c.b / 255.0f, a);
}

/* ── Cell snapshot (mirror of the macOS renderer) ─────────────────────── */
struct CellSnap {
  char utf8[16];
  uint8_t utf8_len;
  bool is_ascii;
  uint32_t cp;
  GhosttyColorRgb fg;
  GhosttyColorRgb bg;
  bool has_bg;
  bool bold, italic, underline, strikethrough;
};

uint32_t utf8_first_cp(const char *sp, uint8_t len) {
  const uint8_t *b = (const uint8_t *)sp;
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

GhosttyColorRgb resolve_style_color(GhosttyStyleColor color,
                                    const GhosttyRenderStateColors *colors,
                                    GhosttyColorRgb fallback) {
  switch (color.tag) {
    case GHOSTTY_STYLE_COLOR_RGB: return color.value.rgb;
    case GHOSTTY_STYLE_COLOR_PALETTE: return colors->palette[color.value.palette];
    default: return fallback;
  }
}

bool rgb_eq(GhosttyColorRgb a, GhosttyColorRgb b) {
  return a.r == b.r && a.g == b.g && a.b == b.b;
}

int font_variant(const CellSnap *c) {
  if (c->bold && c->italic) return FONT_BOLD_ITALIC;
  if (c->bold) return FONT_BOLD;
  if (c->italic) return FONT_ITALIC;
  return FONT_REGULAR;
}

void snapshot_row(Session *s, const GhosttyRenderStateColors *colors,
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
      GhosttyBuffer buf = {(uint8_t *)snap->utf8, sizeof(snap->utf8), 0};
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
        s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_HAS_STYLING, &has_styling);
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

/* ── Geometric glyphs (same table as the macOS renderer) ─────────────── */
enum { BOX_U = 1, BOX_D = 2, BOX_L = 4, BOX_R = 8, BOX_HEAVY = 16 };

int box_flags(uint32_t cp) {
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

/** D2D uses top-down y (unlike CoreGraphics): rects are in screen space. */
bool draw_geometric_cell(Session *s, uint32_t cp, GhosttyColorRgb fg,
                         float x, float y_top, float w, float h) {
  WinState *W = ws(s);
  auto fill = [&](float rx, float ry, float rw, float rh) {
    W->brush->SetColor(rgb(fg));
    W->d2dCtx->FillRectangle(D2D1::RectF(rx, ry, rx + rw, ry + rh), W->brush);
  };

  int flags = cp >= 0x2500 && cp <= 0x257F ? box_flags(cp) : 0;
  if (flags) {
    float t = (float)fmax(1.0, round(s->scale));
    if (flags & BOX_HEAVY) t *= 2;
    float xc = x + w / 2 - t / 2;
    float yc = y_top + h / 2 - t / 2;
    if (flags & BOX_L) fill(x, yc, xc - x + t, t);
    if (flags & BOX_R) fill(xc, yc, x + w - xc, t);
    if (flags & BOX_U) fill(xc, y_top, t, yc - y_top + t);
    if (flags & BOX_D) fill(xc, yc, t, y_top + h - yc);
    return true;
  }

  if (cp >= 0x2580 && cp <= 0x259F) {
    if (cp == 0x2580) { fill(x, y_top, w, h / 2); return true; }
    if (cp >= 0x2581 && cp <= 0x2588) {
      float k = (cp - 0x2580) / 8.0f;
      fill(x, y_top + h * (1 - k), w, h * k);
      return true;
    }
    if (cp >= 0x2589 && cp <= 0x258F) {
      float k = (8 - (cp - 0x2588)) / 8.0f;
      fill(x, y_top, w * k, h);
      return true;
    }
    if (cp == 0x2590) { fill(x + w / 2, y_top, w / 2, h); return true; }
    if (cp >= 0x2591 && cp <= 0x2593) {
      W->brush->SetColor(rgb(fg, (cp - 0x2590) * 0.25f));
      W->d2dCtx->FillRectangle(D2D1::RectF(x, y_top, x + w, y_top + h), W->brush);
      return true;
    }
    if (cp == 0x2594) { fill(x, y_top, w, h / 8); return true; }
    if (cp == 0x2595) { fill(x + w * 7 / 8, y_top, w / 8, h); return true; }
    static const uint8_t QUAD[10] = {4, 8, 1, 13, 9, 7, 11, 2, 6, 14};
    uint8_t q = QUAD[cp - 0x2596];
    if (q & 1) fill(x, y_top, w / 2, h / 2);
    if (q & 2) fill(x + w / 2, y_top, w / 2, h / 2);
    if (q & 4) fill(x, y_top + h / 2, w / 2, h / 2);
    if (q & 8) fill(x + w / 2, y_top + h / 2, w / 2, h / 2);
    return true;
  }

  if (cp >= 0x2800 && cp <= 0x28FF) {
    W->brush->SetColor(rgb(fg));
    uint32_t bits = cp - 0x2800;
    static const uint8_t DOT_COL[8] = {0, 0, 0, 1, 1, 1, 0, 1};
    static const uint8_t DOT_ROW[8] = {0, 1, 2, 0, 1, 2, 3, 3};
    float r = (float)fmax(s->scale, fmin(w, h / 2) * 0.18);
    for (int i = 0; i < 8; i++) {
      if (!(bits & (1u << i))) continue;
      float cx = x + w * (DOT_COL[i] ? 0.72f : 0.28f);
      float cy = y_top + h * ((DOT_ROW[i] + 0.5f) / 4.0f);
      W->d2dCtx->FillEllipse(D2D1::Ellipse(D2D1::Point2F(cx, cy), r, r), W->brush);
    }
    return true;
  }

  return false;
}

std::wstring utf8_to_wide(const char *s8, int len) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s8, len, nullptr, 0);
  std::wstring out(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s8, len, &out[0], n);
  return out;
}

void draw_text_run(Session *s, const std::wstring &text, int variant,
                   GhosttyColorRgb fg, float x, float y_top) {
  WinState *W = ws(s);
  Com<IDWriteTextLayout> layout;
  if (FAILED(W->dwrite->CreateTextLayout(
          text.c_str(), (UINT32)text.size(), W->formats[variant],
          (float)(s->px_w), (float)s->cell_h, &layout)))
    return;
  W->brush->SetColor(rgb(fg));
  W->d2dCtx->DrawTextLayout(D2D1::Point2F(x, y_top), layout, W->brush,
                            D2D1_DRAW_TEXT_OPTIONS_CLIP);
}

void draw_row(Session *s, int row_index, const GhosttyRenderStateColors *colors,
              const CellSnap *snaps, int cursor_col,
              GhosttyRenderStateCursorVisualStyle cursor_style,
              GhosttyColorRgb cursor_color) {
  WinState *W = ws(s);
  const float y_top = (float)(row_index * s->cell_h);
  const float cw = (float)s->cell_w, ch = (float)s->cell_h;

  // Clip to the row rect: same invariant as macOS — incremental output must
  // be pixel-identical to a full redraw regardless of glyph overhang.
  W->d2dCtx->PushAxisAlignedClip(
      D2D1::RectF(0, y_top, (float)s->px_w, y_top + ch),
      D2D1_ANTIALIAS_MODE_ALIASED);

  W->brush->SetColor(rgb(colors->background));
  W->d2dCtx->FillRectangle(D2D1::RectF(0, y_top, (float)s->px_w, y_top + ch),
                           W->brush);
  for (int c = 0; c < s->cols;) {
    if (!snaps[c].has_bg) { c++; continue; }
    int run = c + 1;
    while (run < s->cols && snaps[run].has_bg && rgb_eq(snaps[run].bg, snaps[c].bg))
      run++;
    W->brush->SetColor(rgb(snaps[c].bg));
    W->d2dCtx->FillRectangle(
        D2D1::RectF(c * cw, y_top, run * cw, y_top + ch), W->brush);
    c = run;
  }

  // Glyphs: batch consecutive cells sharing variant + color into one DWrite
  // layout; geometry cells break runs.
  std::wstring run_text;
  int run_start = 0, run_variant = -1;
  GhosttyColorRgb run_fg = colors->foreground;
  auto flush = [&]() {
    if (!run_text.empty())
      draw_text_run(s, run_text, run_variant, run_fg, run_start * cw, y_top);
    run_text.clear();
  };

  for (int c = 0; c < s->cols; c++) {
    const CellSnap *snap = &snaps[c];
    if (snap->utf8_len == 0 || (snap->is_ascii && snap->utf8[0] == ' ')) {
      flush();
      continue;
    }
    if (draw_geometric_cell(s, snap->cp, snap->fg, c * cw, y_top, cw, ch)) {
      flush();
      continue;
    }
    int variant = font_variant(snap);
    if (run_text.empty() || variant != run_variant || !rgb_eq(snap->fg, run_fg)) {
      flush();
      run_start = c;
      run_variant = variant;
      run_fg = snap->fg;
    }
    // Monospace layout assumption holds for ASCII; non-ASCII cells flush
    // into their own single-cell run so positioning stays exact.
    if (!snap->is_ascii) {
      flush();
      run_start = c;
      run_variant = variant;
      run_fg = snap->fg;
      run_text = utf8_to_wide(snap->utf8, snap->utf8_len);
      flush();
      continue;
    }
    run_text += (wchar_t)snap->utf8[0];
  }
  flush();

  // Decorations.
  float u_thick = (float)s->scale;
  float baseline = y_top + (float)s->ascent;
  for (int c = 0; c < s->cols;) {
    if (!snaps[c].underline && !snaps[c].strikethrough) { c++; continue; }
    bool ul = snaps[c].underline, st = snaps[c].strikethrough;
    int run = c + 1;
    while (run < s->cols && snaps[run].underline == ul &&
           snaps[run].strikethrough == st && rgb_eq(snaps[run].fg, snaps[c].fg))
      run++;
    W->brush->SetColor(rgb(snaps[c].fg));
    if (ul)
      W->d2dCtx->FillRectangle(
          D2D1::RectF(c * cw, baseline + u_thick, run * cw, baseline + 2 * u_thick),
          W->brush);
    if (st)
      W->d2dCtx->FillRectangle(
          D2D1::RectF(c * cw, baseline - (float)s->ascent * 0.3f,
                      run * cw, baseline - (float)s->ascent * 0.3f + u_thick),
          W->brush);
    c = run;
  }

  // Cursor.
  if (cursor_col >= 0 && cursor_col < s->cols) {
    float cx = cursor_col * cw;
    W->brush->SetColor(rgb(cursor_color));
    switch (cursor_style) {
      case GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR:
        W->d2dCtx->FillRectangle(
            D2D1::RectF(cx, y_top, cx + 2 * (float)s->scale, y_top + ch), W->brush);
        break;
      case GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_UNDERLINE:
        W->d2dCtx->FillRectangle(
            D2D1::RectF(cx, y_top + ch - 2 * (float)s->scale, cx + cw, y_top + ch),
            W->brush);
        break;
      case GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK_HOLLOW:
        W->d2dCtx->DrawRectangle(
            D2D1::RectF(cx + 0.5f, y_top + 0.5f, cx + cw - 0.5f, y_top + ch - 0.5f),
            W->brush, (float)s->scale);
        break;
      default: {
        W->d2dCtx->FillRectangle(D2D1::RectF(cx, y_top, cx + cw, y_top + ch),
                                 W->brush);
        const CellSnap *snap = &snaps[cursor_col];
        if (snap->utf8_len > 0 && snap->is_ascii && snap->utf8[0] != ' ') {
          std::wstring g(1, (wchar_t)snap->utf8[0]);
          draw_text_run(s, g, font_variant(snap), colors->background, cx, y_top);
        }
        break;
      }
    }
  }

  W->d2dCtx->PopAxisAlignedClip();
}

bool create_shared_texture(Session *s, int i, napi_env env) {
  WinState *W = ws(s);
  D3D11_TEXTURE2D_DESC desc = {};
  desc.Width = (UINT)s->px_w;
  desc.Height = (UINT)s->px_h;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
  if (FAILED(W->device->CreateTexture2D(&desc, nullptr, &W->textures[i]))) {
    napi_throw_error(env, NULL, "CreateTexture2D failed");
    return false;
  }

  Com<IDXGIResource1> res;
  if (FAILED(W->textures[i]->QueryInterface(__uuidof(IDXGIResource1),
                                            (void **)&res)) ||
      FAILED(res->CreateSharedHandle(
          nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
          nullptr, &W->ntHandles[i]))) {
    napi_throw_error(env, NULL, "CreateSharedHandle failed");
    return false;
  }

  Com<IDXGISurface> surface;
  if (FAILED(W->textures[i]->QueryInterface(__uuidof(IDXGISurface),
                                            (void **)&surface))) {
    napi_throw_error(env, NULL, "IDXGISurface query failed");
    return false;
  }
  D2D1_BITMAP_PROPERTIES1 props = D2D1::BitmapProperties1(
      D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
      D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED));
  if (FAILED(W->d2dCtx->CreateBitmapFromDxgiSurface(surface, &props,
                                                    &W->targets[i]))) {
    napi_throw_error(env, NULL, "CreateBitmapFromDxgiSurface failed");
    return false;
  }
  return true;
}

}  // namespace

/* ── Platform hooks ───────────────────────────────────────────────────── */

extern "C" bool gxb_platform_init(napi_env env, Session *s, double font_size) {
  WinState *W = new WinState();
  s->win = W;

  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  static const D3D_DRIVER_TYPE tries[] = {D3D_DRIVER_TYPE_HARDWARE,
                                          D3D_DRIVER_TYPE_WARP};
  HRESULT hr = E_FAIL;
  for (auto type : tries) {
    hr = D3D11CreateDevice(nullptr, type, nullptr, flags, nullptr, 0,
                           D3D11_SDK_VERSION, &W->device, nullptr, &W->context);
    if (SUCCEEDED(hr)) break;
  }
  if (FAILED(hr)) {
    napi_throw_error(env, NULL, "D3D11CreateDevice failed (hardware and WARP)");
    return false;
  }

  if (FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED,
                               __uuidof(ID2D1Factory1), nullptr,
                               (void **)&W->d2dFactory))) {
    napi_throw_error(env, NULL, "D2D1CreateFactory failed");
    return false;
  }
  Com<IDXGIDevice> dxgiDevice;
  if (FAILED(W->device->QueryInterface(__uuidof(IDXGIDevice),
                                       (void **)&dxgiDevice)) ||
      FAILED(W->d2dFactory->CreateDevice(dxgiDevice, &W->d2dDevice)) ||
      FAILED(W->d2dDevice->CreateDeviceContext(
          D2D1_DEVICE_CONTEXT_OPTIONS_NONE, &W->d2dCtx))) {
    napi_throw_error(env, NULL, "D2D device context creation failed");
    return false;
  }

  if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED,
                                 __uuidof(IDWriteFactory),
                                 (IUnknown **)&W->dwrite))) {
    napi_throw_error(env, NULL, "DWriteCreateFactory failed");
    return false;
  }

  float px = (float)(font_size * s->scale);
  struct { DWRITE_FONT_WEIGHT w; DWRITE_FONT_STYLE st; } variants[FONT_COUNT] = {
      {DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL},
      {DWRITE_FONT_WEIGHT_BOLD, DWRITE_FONT_STYLE_NORMAL},
      {DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_ITALIC},
      {DWRITE_FONT_WEIGHT_BOLD, DWRITE_FONT_STYLE_ITALIC},
  };
  for (int i = 0; i < FONT_COUNT; i++) {
    if (FAILED(W->dwrite->CreateTextFormat(
            L"Consolas", nullptr, variants[i].w, variants[i].st,
            DWRITE_FONT_STRETCH_NORMAL, px, L"en-us", &W->formats[i]))) {
      napi_throw_error(env, NULL, "CreateTextFormat failed");
      return false;
    }
  }

  // Cell metrics from a reference layout of 'M'.
  Com<IDWriteTextLayout> layout;
  if (FAILED(W->dwrite->CreateTextLayout(L"M", 1, W->formats[FONT_REGULAR],
                                         1000, 1000, &layout))) {
    napi_throw_error(env, NULL, "metric layout failed");
    return false;
  }
  DWRITE_TEXT_METRICS tm;
  layout->GetMetrics(&tm);
  DWRITE_LINE_METRICS lm;
  UINT32 lineCount = 1;
  layout->GetLineMetrics(&lm, 1, &lineCount);
  s->cell_w = ceil(tm.widthIncludingTrailingWhitespace);
  s->cell_h = ceil(lm.height);
  s->ascent = lm.baseline;
  return true;
}

extern "C" void gxb_platform_free(Session *s) {
  WinState *W = ws(s);
  if (!W) return;
  for (int i = 0; i < 2; i++)
    if (W->ntHandles[i]) CloseHandle(W->ntHandles[i]);
  delete W;
  s->win = nullptr;
}

extern "C" bool gxb_platform_resize(napi_env env, Session *s) {
  WinState *W = ws(s);
  W->d2dCtx->SetTarget(nullptr);
  for (int i = 0; i < 2; i++) {
    if (W->ntHandles[i]) { CloseHandle(W->ntHandles[i]); W->ntHandles[i] = nullptr; }
    W->targets[i].reset();
    W->textures[i].reset();
    if (!create_shared_texture(s, i, env)) return false;
  }
  if (!W->brush) {
    if (FAILED(W->d2dCtx->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 1),
                                                &W->brush))) {
      napi_throw_error(env, NULL, "CreateSolidColorBrush failed");
      return false;
    }
  }
  return true;
}

/* ── render / readPixels ──────────────────────────────────────────────── */

static napi_value Render(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = gxb_get_session(env, argv[0]);
  if (!s) return NULL;
  WinState *W = ws(s);

  LARGE_INTEGER freq, t0, t1;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&t0);

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

  bool cur_visible = false, cur_valid = false;
  uint16_t ccx = 0, ccy = 0;
  GhosttyRenderStateCursorVisualStyle cur_style =
      GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE, &cur_visible);
  if (s->cursor_hidden) cur_visible = false;
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
  uint64_t since = s->surface_seq[s->surface_index];

  W->d2dCtx->SetTarget(W->targets[s->surface_index]);
  W->d2dCtx->BeginDraw();

  CellSnap *snaps = (CellSnap *)malloc(sizeof(CellSnap) * s->cols);
  ghostty_render_state_get(s->render_state,
                           GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &s->row_iter);
  int row = 0, rows_drawn = 0;
  while (ghostty_render_state_row_iterator_next(s->row_iter) && row < s->rows) {
    if (s->row_modified[row] > since) {
      snapshot_row(s, &colors, snaps);
      int cursor_col = (cur_visible && cur_valid && ccy == row) ? (int)ccx : -1;
      draw_row(s, row, &colors, snaps, cursor_col, cur_style, cursor_color);
      rows_drawn++;
    }
    row++;
  }
  free(snaps);

  W->d2dCtx->EndDraw();
  W->d2dCtx->SetTarget(nullptr);
  W->context->Flush();

  s->surface_seq[s->surface_index] = s->mod_seq;
  s->needs_present = false;

  QueryPerformanceCounter(&t1);
  double render_ms = (t1.QuadPart - t0.QuadPart) * 1000.0 / freq.QuadPart;

  HANDLE handle = W->ntHandles[s->surface_index];
  napi_value result, v, hbuf;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_buffer_copy(env, sizeof(HANDLE), &handle, NULL, &hbuf));
  NAPI_CALL(env, napi_set_named_property(env, result, "handle", hbuf));
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

static napi_value ReadPixels(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  Session *s = gxb_get_session(env, argv[0]);
  if (!s) return NULL;
  WinState *W = ws(s);

  D3D11_TEXTURE2D_DESC desc = {};
  W->textures[s->surface_index]->GetDesc(&desc);
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.MiscFlags = 0;

  Com<ID3D11Texture2D> staging;
  THROW_IF(env, FAILED(W->device->CreateTexture2D(&desc, nullptr, &staging)),
           "staging texture failed");
  W->context->CopyResource(staging, W->textures[s->surface_index]);

  D3D11_MAPPED_SUBRESOURCE map;
  THROW_IF(env, FAILED(W->context->Map(staging, 0, D3D11_MAP_READ, 0, &map)),
           "Map failed");

  napi_value data;
  void *out;
  NAPI_CALL(env, napi_create_buffer(env, s->px_w * s->px_h * 4, &out, &data));
  for (size_t y = 0; y < s->px_h; y++)
    memcpy((uint8_t *)out + y * s->px_w * 4,
           (const uint8_t *)map.pData + y * map.RowPitch, s->px_w * 4);
  W->context->Unmap(staging, 0);

  napi_value result, v;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_w, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", v));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)s->px_h, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", v));
  NAPI_CALL(env, napi_set_named_property(env, result, "data", data));
  return result;
}

extern "C" void gxb_platform_register(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"render", NULL, Render, NULL, NULL, NULL, napi_default, NULL},
      {"readPixels", NULL, ReadPixels, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
}
