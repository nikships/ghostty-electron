/**
 * Non-macOS platform layer: VT parsing, text readout, key encoding, and
 * selection all work (used by conformance tests and the parser benchmark);
 * rendering does not exist yet, so render/readPixels are not exported.
 *
 * A Windows presentation port would produce D3D11 shared textures
 * (handle.ntHandle) and draw with DirectWrite — same architecture, different
 * platform APIs.
 */
#include "session.h"

bool gxb_platform_init(napi_env env, Session *s, double font_size) {
  // Nominal monospace metrics; only meaningful for size reports.
  (void)font_size;
  s->cell_w = (double)(long)(8 * s->scale + 0.5);
  s->cell_h = (double)(long)(16 * s->scale + 0.5);
  s->ascent = s->cell_h * 0.8;
  return true;
}

void gxb_platform_free(Session *s) { (void)s; }

bool gxb_platform_resize(napi_env env, Session *s) {
  (void)env;
  (void)s;
  return true;
}

void gxb_platform_register(napi_env env, napi_value exports) {
  (void)env;
  (void)exports;
}
