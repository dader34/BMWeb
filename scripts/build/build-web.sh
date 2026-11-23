#!/bin/bash
# Build the browser version: the same renderer, no server.
#
#   scripts/build/build-web.sh              -> dist-web/   (static, serve anywhere)
#   BMWEB_PORT=51234 scripts/build/build-web.sh
#
# A browser has no server behind it, so the web build is two pieces:
#
#   tools/export/web_export.py   freezes every GET the renderer makes into static
#                         JSON (chassis config, job metadata, tables, IR)
#   app/renderer/core/webshim/    intercepts fetch: static files for reads, and
#                         our BEST2 VM over Web Serial for job runs
#
# Nothing in the renderer changes. The shim installs over window.fetch
# before core.js loads, so api() cannot tell the difference.
#
# No app is needed: web_export.py reads the fetched chassis-config cache
# (data/chassis-config), the same way CI does (scripts/build/ci-dist-web.sh).
# Set BMWEB_PORT to freeze against a running engine instead, which also
# refreshes that cache.
set -euo pipefail
# BMACW_PORT is the name before the rename; it still works
BMWEB_PORT="${BMWEB_PORT:-${BMACW_PORT:-}}"

cd "$(dirname "$0")/../.."
ROOT="$PWD"
OUT="dist-web"

if [ -n "${BMWEB_PORT:-}" ]; then
  export BMWEB_PORT
  echo "==> using the engine on 127.0.0.1:$BMWEB_PORT to resolve chassis config"
else
  echo "==> no BMWEB_PORT: using the fetched chassis-config cache"
fi

rm -rf "$OUT"
mkdir -p "$OUT"

echo "==> freezing the API surface"
python3 tools/export/web_export.py --out "$OUT" "$@"

echo "==> copying the renderer"
cp -R "$ROOT/app/renderer/." "$OUT/"
cp -R "$ROOT/app/site/." "$OUT/"   # the installer, docs and screenshots, beside the app

# index.html already loads the shim (core/webshim/): it is the only thing
# answering /api/* -- static files for reads, the BEST2 VM over Web Serial
# for job runs.

# The version (package.json is the one source: index.html, Settings and the
# offline export read window.BMWEB_VERSION), the scripts concatenated into
# one $OUT/bundle.js in index.html load order, and $OUT/index.html collapsed
# to that single tag. The dev source keeps its individual tags; only the
# shipped copy is bundled. One script does this for every build.
echo "==> stamping and bundling the renderer"
node "$ROOT/scripts/build/stamp-shell.mjs" "$OUT"

# faultinfo.js is 60 MB of ISTA fault detail and faultmeta.js another 14 MB.
# They load lazily in the app; on a static host they are just weight, so ship
# them gzipped beside the original the way job code already does.
#
# The .gz siblings are an OPTIMISATION, not a requirement: StaticHost only
# rewrites a request onto foo.gz when the plain file is MISSING, and gzip -k
# keeps the original, so a build without them still serves everything -- just
# uncompressed. That is why absence is fine but a failure HERE is not: a
# broken gzip should fail the build, not quietly ship the fat site.
echo "==> pre-compressing the large payloads"
find "$OUT" -name "*.js" -size +1M -print0 \
  | xargs -0 -P 8 -I{} gzip -9 -k -f {}
find "$OUT/api" "$OUT/data" -name "*.json" -size +256k -print0 \
  | xargs -0 -P 8 -I{} gzip -9 -k -f {}

SIZE=$(du -sh "$OUT" | cut -f1)
RAW=$(find "$OUT" -name "*.json" -o -name "*.js" | wc -l | tr -d ' ')
cat > "$OUT/README.txt" <<EOF
BMWeb build
===========

Static: serve this directory over HTTP and open index.html.

  python3 -m http.server -d $OUT 8080

Reading ECU data (screens, jobs, fault text) works with no cable and no
server. Running a job needs a K+DCAN cable and a browser with Web Serial
(Chrome/Edge desktop) -- click the cable control to pick the port.

Safety, in one line: unknown jobs are classified as writes and refused;
actuator tests confirm before firing and release when you leave the screen;
permanent writes always confirm; coding writes back up first and re-read to
prove what landed.

Files: $RAW  Size: $SIZE
EOF

echo
echo "==> web build ready: $OUT ($SIZE, $RAW files)"
echo "    serve it:  python3 -m http.server -d $OUT 8080"
