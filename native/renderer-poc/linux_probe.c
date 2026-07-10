/* Probe 2: how far does a HEADLESS surface get on Linux?
 * Expected cliff: GenericRenderer(OpenGL) init makes GL calls with no
 * GL context/loader -> deterministic zig panic. Anything past
 * "surface_new..." that isn't a PASS tells us the exact missing layer. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

typedef void *ghostty_app_t;
typedef void *ghostty_surface_t;
typedef void *ghostty_config_t;
typedef struct { void *v; } dummy_s;

typedef struct {
  void *userdata;
  bool supports_selection_clipboard;
  void (*wakeup_cb)(void *);
  bool (*action_cb)(ghostty_app_t, dummy_s, dummy_s);
  bool (*read_clipboard_cb)(void *, int, void *);
  void (*confirm_read_clipboard_cb)(void *, const char *, void *, int);
  void (*write_clipboard_cb)(void *, int, const void *, size_t, bool);
  void (*close_surface_cb)(void *, bool);
} runtime_config_s;

/* Mirror of embedded Surface.Options (extern struct). */
typedef union {
  struct { void *nsview; } macos;
  struct { void *uiview; } ios;
  struct { void *reserved; } headless;
} platform_u;

typedef struct {
  int platform_tag;
  platform_u platform;
  void *userdata;
  double scale_factor;
  float font_size;
  const char *working_directory;
  const char *command;
  void *env_vars;
  size_t env_var_count;
  const char *initial_input;
  bool wait_after_command;
  int context;
} surface_config_s;

extern int ghostty_init(uintptr_t, char **);
extern ghostty_config_t ghostty_config_new(void);
extern void ghostty_config_finalize(ghostty_config_t);
extern ghostty_app_t ghostty_app_new(const runtime_config_s *, ghostty_config_t);
extern surface_config_s ghostty_surface_config_new(void);
extern ghostty_surface_t ghostty_surface_new(ghostty_app_t, const surface_config_s *);

static void wakeup(void *ud) { (void)ud; }
static bool action(ghostty_app_t a, dummy_s t, dummy_s ac) { (void)a; (void)t; (void)ac; return false; }
static bool rdclip(void *u, int l, void *s) { (void)u; (void)l; (void)s; return false; }
static void cfclip(void *u, const char *s, void *st, int r) { (void)u; (void)s; (void)st; (void)r; }
static void wrclip(void *u, int l, const void *c, size_t n, bool cf) { (void)u; (void)l; (void)c; (void)n; (void)cf; }
static void closesurf(void *u, bool a) { (void)u; (void)a; }

int main(int argc, char **argv) {
  if (ghostty_init((uintptr_t)argc, argv) != 0) { printf("STAGE-FAIL: init\n"); return 1; }
  printf("STAGE-OK: ghostty_init\n");
  ghostty_config_t config = ghostty_config_new();
  ghostty_config_finalize(config);
  printf("STAGE-OK: config\n");

  runtime_config_s rt = {0};
  rt.wakeup_cb = wakeup; rt.action_cb = action;
  rt.read_clipboard_cb = rdclip; rt.confirm_read_clipboard_cb = cfclip;
  rt.write_clipboard_cb = wrclip; rt.close_surface_cb = closesurf;

  ghostty_app_t app = ghostty_app_new(&rt, config);
  if (!app) { printf("STAGE-FAIL: app_new\n"); return 1; }
  printf("STAGE-OK: app_new\n");

  surface_config_s sc = ghostty_surface_config_new();
  sc.platform_tag = 3; /* GHOSTTY_PLATFORM_HEADLESS */
  sc.platform.headless.reserved = NULL;
  sc.scale_factor = 1.0;
  sc.command = "printf HELLO; sleep 5";
  fflush(stdout);

  ghostty_surface_t surface = ghostty_surface_new(app, &sc);
  if (!surface) { printf("STAGE-FAIL: surface_new returned null\n"); return 1; }
  printf("STAGE-OK: surface_new — headless surface exists on Linux!\n");
  return 0;
}
