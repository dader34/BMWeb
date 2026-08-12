#!/bin/bash
# Bundle the renderer's ES modules into a single IIFE with esbuild.
#
#   scripts/build/build-bundle.sh [srcdir] [outfile]
#
# The renderer is written as ES modules (app/renderer/main.js is the entry that
# imports the graph). Every host needs ONE classic <script> though: the offline
# single-file export inlines it, and inlining import/export is impossible. So we
# bundle to format=iife -- one self-contained script, no import statements,
# every module sharing the bundle's scope exactly like the old ambient globals.
#
# Called by build-web.sh (into dist-web) and by anyone building the offline
# copy. Fast (~15ms); safe to run on every change.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

SRC="${1:-app/renderer}"
OUT="${2:-$SRC/bundle.js}"
ENTRY="$SRC/main.js"

if [ ! -f "$ENTRY" ]; then
  echo "error: no entry at $ENTRY" >&2
  exit 1
fi

ESBUILD="$ROOT/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  echo "error: esbuild not installed. Run: npm install" >&2
  exit 1
fi

"$ESBUILD" "$ENTRY" \
  --bundle \
  --format=iife \
  --target=es2020 \
  --outfile="$OUT" \
  --sourcemap=linked \
  --log-level=warning

echo "==> bundled $ENTRY -> $OUT ($(du -h "$OUT" | cut -f1))"
