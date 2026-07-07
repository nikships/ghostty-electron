#!/usr/bin/env bash
# Clone ghostty and build libghostty-vt as a static library into
# vendor/ghostty/zig-out ready for the native addon to link against.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d vendor/ghostty ]; then
  git clone --depth 1 https://github.com/ghostty-org/ghostty vendor/ghostty
fi

cd vendor/ghostty
echo "building libghostty-vt (zig $(zig version))..."
zig build -Demit-lib-vt=true -Doptimize=ReleaseFast
ls -la zig-out/lib/
echo "done."
