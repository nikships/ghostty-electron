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

if [ ! -d vendor/ghostty ]; then
  git clone https://github.com/ghostty-org/ghostty vendor/ghostty
  git -C vendor/ghostty checkout "$PIN"
fi

bash scripts/apply-ghostty-patches.sh
