#!/bin/bash
# Refresh a served dist-web/ IN PLACE: the renderer bundle, its gzip twin and
# the stylesheets -- nothing else. For the local server that serves dist-web
# (python3 -m http.server -d dist-web) between full builds.
#
#   scripts/build/deploy-inplace.sh            -> dist-web/
#   scripts/build/deploy-inplace.sh other-dir  -> that dist tree
#
# WHY NOT build-web.sh: that script starts with `rm -rf dist-web`, and the
# served tree holds hundreds of MB of fetched data (data/etk, data/kfp, the
# .wiring archives) that a rebuild would have to fetch again -- and a flash in
# progress would lose its page. This swaps the few files the renderer sources
# produce and leaves the data alone. The bundle is read from app/renderer's
# index.html (the dev page lists every script); dist-web's own index.html is
# the collapsed one-bundle page and is left as it is.
#
# The bundle is BUILD OUTPUT and is not tracked in git (it was, at 7 MB per
# deploy); CI builds its own in pages.yml. Run this after a change you want
# to see on the local server, or commit first and run it -- the two are
# independent.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-dist-web}"
test -f "$OUT/index.html" || { echo "no served tree at $OUT (run build-web.sh once first)"; exit 1; }

node scripts/build/bundle-modules.mjs
node scripts/build/bundle-renderer.mjs app/renderer "$OUT/bundle.js"
gzip -9 -k -f "$OUT/bundle.js"
mkdir -p "$OUT/css"
cp app/renderer/css/*.css "$OUT/css/"
echo "deployed in place to $OUT: bundle.js ($(du -h "$OUT/bundle.js" | cut -f1)), bundle.js.gz, css/"
