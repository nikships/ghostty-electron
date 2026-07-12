#!/usr/bin/env bash
# Clone ghostty (pinned), apply our fork patches (headless embedding
# platform), and build the full libghostty static library (terminal +
# fonts + Metal renderer) that the N-API addon links against.
#
# The build runs on any OS (the library cross-compiles), but headless
# rendering currently works on macOS only (Metal); Linux needs the
# EGL/GBM presenter — see docs/ghostty-renderer-reuse.md.
set -euo pipefail

cd "$(dirname "$0")/.."

PIN=c41c6b81a4642ccba18d47b375d9495664de72a0

if [ -e vendor/ghostty ] && [ ! -d vendor/ghostty/.git ]; then
  echo "vendor/ghostty exists but is not a git checkout; move it aside and rerun" >&2
  exit 1
fi

if [ ! -d vendor/ghostty/.git ]; then
  git clone https://github.com/ghostty-org/ghostty vendor/ghostty
fi

if ! git -C vendor/ghostty cat-file -e "$PIN^{commit}" 2>/dev/null; then
  git -C vendor/ghostty fetch --depth 1 origin "$PIN"
fi

if ! git -C vendor/ghostty merge-base --is-ancestor "$PIN" HEAD; then
  if ! git -C vendor/ghostty diff --quiet ||
     ! git -C vendor/ghostty diff --cached --quiet; then
    echo "vendor/ghostty is not based on the pinned commit and has local changes." >&2
    echo "Move it aside or clean it before running setup." >&2
    exit 1
  fi
  git -C vendor/ghostty checkout "$PIN"
fi

bash scripts/apply-ghostty-patches.sh
