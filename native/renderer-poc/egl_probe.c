/* Can we get a headless GL 3.3 context on GPU-less Linux via EGL
 * surfaceless + llvmpipe? This is the exact context the ghostty
 * OpenGL backend would need for a headless Linux presenter. */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GL/gl.h>
#include <stdio.h>
int main(void) {
  EGLDisplay dpy = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA,
                                         EGL_DEFAULT_DISPLAY, NULL);
  if (dpy == EGL_NO_DISPLAY) { printf("FAIL: no surfaceless display\n"); return 1; }
  if (!eglInitialize(dpy, NULL, NULL)) { printf("FAIL: eglInitialize\n"); return 1; }
  eglBindAPI(EGL_OPENGL_API);
  EGLint cattr[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3,
                    EGL_CONTEXT_OPENGL_PROFILE_MASK,
                    EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE};
  EGLContext ctx = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, cattr);
  if (ctx == EGL_NO_CONTEXT) { printf("FAIL: create context\n"); return 1; }
  if (!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) {
    printf("FAIL: make current\n"); return 1;
  }
  printf("PASS: GL context: %s | %s\n", glGetString(GL_VERSION), glGetString(GL_RENDERER));
  return 0;
}
