/**
 * Approach A verification: headless embedded ghostty surface.
 *
 * Creates a ghostty app + surface with GHOSTTY_PLATFORM_HEADLESS (no
 * NSView), runs a command that prints a sentinel, ticks the app loop,
 * forces a draw, and reads back the presented IOSurface via
 * ghostty_surface_headless_frame(). Success = the frame contains
 * non-background pixels (the rendered text) at the requested size.
 *
 * Ghostty owns: PTY, VT parsing, font discovery/shaping, GPU (Metal)
 * rendering, damage tracking, presentation. We own: this event loop.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>

#include <ghostty.h>

static bool wakeup_flag = false;

static void cb_wakeup(void *ud) {
  (void)ud;
  wakeup_flag = true;
}

static bool cb_action(ghostty_app_t app, ghostty_target_s target,
                      ghostty_action_s action) {
  (void)app;
  (void)target;
  (void)action;
  return false; // we handle no actions; ghostty carries on
}

static bool cb_read_clipboard(void *ud, ghostty_clipboard_e loc, void *state) {
  (void)ud;
  (void)loc;
  (void)state;
  return false;
}

static void cb_confirm_read_clipboard(void *ud, const char *str, void *state,
                                      ghostty_clipboard_request_e req) {
  (void)ud;
  (void)str;
  (void)state;
  (void)req;
}

static void cb_write_clipboard(void *ud, ghostty_clipboard_e loc,
                               const ghostty_clipboard_content_s *content,
                               size_t len, bool confirm) {
  (void)ud;
  (void)loc;
  (void)content;
  (void)len;
  (void)confirm;
}

static void cb_close_surface(void *ud, bool alive) {
  (void)ud;
  (void)alive;
}

int main(int argc, char **argv) {
  if (ghostty_init((uintptr_t)argc, argv) != 0) {
    fprintf(stderr, "FAIL: ghostty_init\n");
    return 1;
  }

  ghostty_config_t config = ghostty_config_new();
  // Keep the run self-contained: no user config.
  ghostty_config_finalize(config);

  ghostty_runtime_config_s runtime = {0};
  runtime.wakeup_cb = cb_wakeup;
  runtime.action_cb = cb_action;
  runtime.read_clipboard_cb = cb_read_clipboard;
  runtime.confirm_read_clipboard_cb = cb_confirm_read_clipboard;
  runtime.write_clipboard_cb = cb_write_clipboard;
  runtime.close_surface_cb = cb_close_surface;

  ghostty_app_t app = ghostty_app_new(&runtime, config);
  if (!app) {
    fprintf(stderr, "FAIL: ghostty_app_new\n");
    return 1;
  }

  ghostty_surface_config_s surface_config = ghostty_surface_config_new();
  surface_config.platform_tag = GHOSTTY_PLATFORM_HEADLESS;
  surface_config.platform.headless.reserved = NULL;
  surface_config.scale_factor = 2.0;
  surface_config.command =
      "printf 'GHOSTTY_HEADLESS_MARKER\\n'; sleep 30";

  ghostty_surface_t surface = ghostty_surface_new(app, &surface_config);
  if (!surface) {
    fprintf(stderr, "FAIL: ghostty_surface_new\n");
    return 1;
  }

  ghostty_surface_set_content_scale(surface, 2.0, 2.0);
  ghostty_surface_set_size(surface, 800, 400); // pixels
  ghostty_surface_set_focus(surface, true);

  // Drive the app loop from this thread (we are "the runtime"). The
  // command output arrives on the IO thread; ticks drain mailboxes.
  // CFRunLoop must turn so main-queue dispatch (IOSurfaceLayer
  // setSurface) executes.
  ghostty_headless_frame_s frame = {0};
  bool have_pixels = false;
  for (int i = 0; i < 300 && !have_pixels; i++) {
    ghostty_app_tick(app);
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
    ghostty_surface_draw(surface);
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);

    if (frame.iosurface) CFRelease(frame.iosurface);
    frame = ghostty_surface_headless_frame(surface);
    if (!frame.iosurface) continue;

    IOSurfaceRef s = (IOSurfaceRef)frame.iosurface;
    IOSurfaceLock(s, kIOSurfaceLockReadOnly, NULL);
    const uint8_t *base = IOSurfaceGetBaseAddress(s);
    size_t stride = IOSurfaceGetBytesPerRow(s);
    size_t w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s);

    // Count pixels that differ from the dominant (background) color.
    uint32_t bg = *(const uint32_t *)base;
    size_t diff = 0;
    for (size_t y = 0; y < h; y += 2) {
      const uint32_t *row = (const uint32_t *)(base + y * stride);
      for (size_t x = 0; x < w; x += 2)
        if (row[x] != bg) diff++;
    }
    IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, NULL);

    if (diff > 50) {
      printf("frame %zux%zu scale=%.1f foreground_pixels(sampled)=%zu\n",
             w, h, frame.scale, diff);
      have_pixels = true;
    }
  }

  if (!have_pixels) {
    fprintf(stderr, "FAIL: no rendered frame with content within timeout\n");
    return 1;
  }

  // Sanity: the reported size should match what we asked for.
  if (frame.width_px != 800 || frame.height_px != 400) {
    fprintf(stderr, "FAIL: frame size %ux%u != 800x400\n", frame.width_px,
            frame.height_px);
    return 1;
  }

  CFRelease(frame.iosurface);
  printf("PASS: approach A headless surface rendered text via ghostty's "
         "Metal renderer\n");
  return 0;
}
