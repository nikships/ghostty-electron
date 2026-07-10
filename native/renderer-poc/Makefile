# Build + run the headless-embedding proof of concept (macOS), plus
# the Linux probes (see docs/ghostty-renderer-reuse.md).
#
# Prereqs (macOS targets):
#   npm run setup:ghostty     # clone vendor/ghostty, apply patches, zig build
#
# Linux targets (run inside docker, or any Linux with mesa + EGL headers):
#   make egl_probe            # headless GL 3.3 via EGL surfaceless/llvmpipe
#   make linux_probe          # how far the headless platform gets on Linux
#   make docker-probes        # both, reproducibly, in ubuntu:24.04
#     (linux_probe needs the fork built for Linux inside the container:
#      the target clones+builds it on first run — slow but reproducible)

GHOSTTY := ../../vendor/ghostty
FRAMEWORKS := -framework CoreFoundation -framework CoreGraphics \
  -framework CoreText -framework CoreVideo -framework QuartzCore \
  -framework IOSurface -framework Metal -framework MetalKit \
  -framework AppKit -framework Carbon
LDFLAGS := -L$(GHOSTTY)/zig-out/lib -lghostty -lc++ $(FRAMEWORKS)
CFLAGS := -I$(GHOSTTY)/include -Wall

BIN := build

all: $(BIN)/headless_a

$(BIN):
	mkdir -p $(BIN)

$(BIN)/headless_a: headless_a.c | $(BIN)
	cc $(CFLAGS) -o $@ $< $(LDFLAGS)

test: all
	$(BIN)/headless_a

# ── Linux probes (build on Linux; see docker-probes for a clean env) ──
egl_probe: | $(BIN)
	cc -Wall -o $(BIN)/egl_probe egl_probe.c -lEGL -lGL
	$(BIN)/egl_probe

linux_probe: | $(BIN)
	cc -Wall -o $(BIN)/linux_probe linux_probe.c \
	  -L$(GHOSTTY)/zig-out/lib -lghostty-internal -lstdc++ -lm
	LD_LIBRARY_PATH=$(GHOSTTY)/zig-out/lib $(BIN)/linux_probe

docker-probes:
	docker run --rm -v $(CURDIR)/../..:/repo -w /repo/native/renderer-poc \
	  ubuntu:24.04 bash -c "\
	    apt-get update -q && apt-get install -qy gcc make \
	      libegl-dev libgl-dev libegl-mesa0 mesa-utils > /dev/null && \
	    make egl_probe"

clean:
	rm -rf $(BIN)

.PHONY: all test egl_probe linux_probe docker-probes clean
