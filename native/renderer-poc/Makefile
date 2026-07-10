# Build + run the headless-embedding proof of concept (macOS only),
# plus the Linux probes (cross-compiled / run in Docker — see
# docs/ghostty-renderer-reuse.md).
#
# Prereqs:
#   npm run setup:ghostty                   # clone + build vendor/ghostty
#   bash scripts/apply-ghostty-patches.sh   # fork patch + full libghostty.a

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

clean:
	rm -rf $(BIN)

.PHONY: all test clean
