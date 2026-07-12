#!/usr/bin/env bash
# Apply our ghostty fork patches (headless renderer C API) to the
# vendor/ghostty checkout and rebuild the full libghostty static lib.
#
# Idempotent: skips patches whose changes are already applied.
#
# Requires zig matching ghostty's pin (0.15.2). The full lib is a
# different artifact than libghostty-vt: it contains the entire
# terminal + font + Metal renderer stack.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
REQUIRED_ZIG=0.15.2

if ! command -v zig >/dev/null 2>&1; then
  echo "zig not found — install zig $REQUIRED_ZIG and put it on PATH" >&2
  exit 1
fi

ZIG_VERSION="$(zig version)"
if [ "$ZIG_VERSION" != "$REQUIRED_ZIG" ]; then
  echo "zig $REQUIRED_ZIG required by the pinned ghostty checkout; found $ZIG_VERSION" >&2
  echo "On Homebrew: PATH=\"/opt/homebrew/opt/zig@0.15/bin:\$PATH\" npm run setup:ghostty" >&2
  exit 1
fi

if [ ! -d vendor/ghostty ]; then
  echo "vendor/ghostty missing — run npm run setup:ghostty first" >&2
  exit 1
fi

cd vendor/ghostty

# Absolute path: vendor/ may be a symlink (worktree setups), which
# would make a relative ../../patches resolve somewhere else.
for patch in "$REPO_ROOT"/patches/*.patch; do
  if git apply --check "$patch" 2>/dev/null; then
    echo "applying $(basename "$patch")"
    # CI runners have no git identity; -c supplies one for the am commit.
    git -c user.name=patch-bot -c user.email=patch@localhost am "$patch" \
      || { git am --abort 2>/dev/null || true; git apply "$patch"; }
  elif git apply --check --reverse "$patch" 2>/dev/null; then
    echo "already applied: $(basename "$patch")"
  else
    echo "PATCH CONFLICT: $(basename "$patch") no longer applies to this ghostty checkout." >&2
    echo "Rebase the patch against vendor/ghostty HEAD ($(git rev-parse --short HEAD))." >&2
    exit 1
  fi
done

echo "building full libghostty (terminal + fonts + renderer)..."
zig build -Dapp-runtime=none -Demit-macos-app=false -Demit-xcframework=false \
  -Demit-exe=false -Doptimize=ReleaseFast
if [ "$(uname)" = "Darwin" ]; then
  ls -la zig-out/lib/libghostty.a
else
  ls -la zig-out/lib/ghostty-internal.* 2>/dev/null || true
fi
echo "done. Header: vendor/ghostty/include/ghostty.h"
