#!/bin/bash
# Build the browser version: the same renderer, no server.
#
#   scripts/build/build-web.sh              -> dist-web/   (static, serve anywhere)
#   BMACW_PORT=51234 scripts/build/build-web.sh
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
# No app is needed: web_export.py reads the committed chassis-config cache
# (data/chassis-config), the same way CI does (scripts/build/ci-dist-web.sh).
# Set BMACW_PORT to freeze against a running engine instead, which also
# refreshes that cache.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"
OUT="dist-web"

if [ -n "${BMACW_PORT:-}" ]; then
  export BMACW_PORT
  echo "==> using the engine on 127.0.0.1:$BMACW_PORT to resolve chassis config"
else
  echo "==> no BMACW_PORT: using the committed chassis-config cache"
fi

rm -rf "$OUT"
mkdir -p "$OUT"

echo "==> freezing the API surface"
python3 tools/export/web_export.py --out "$OUT" "$@"

echo "==> copying the renderer"
cp -R "$ROOT/app/renderer/." "$OUT/"

# Stamp the version into the web build: index.html reads window.BMACW_VERSION
# and settings and the offline export both fall back to it. Read from
# package.json so there is ONE version source.
VERSION=$(node -p "require('$ROOT/package.json').version")
printf 'window.BMACW_VERSION=%s;\n' "\"${VERSION:-web}\"" > "$OUT/version.js"
# load it before app.js reads it (right after the opening <head>, cheap + early)
if ! grep -q 'version.js' "$OUT/index.html"; then
  # macOS/BSD sed: insert the tag after the first <head>
  sed -i.bak 's#<head>#<head>\n  <script src="version.js"></script>#' "$OUT/index.html"
  rm -f "$OUT/index.html.bak"
fi
# index.html already loads the shim (core/webshim/): BOTH builds need it now. The macOS app
# dropped its C# API too, so the shim is the only thing answering /api/* in
# either host -- it picks its transport at load (Web Serial in a browser, the
# native bridge inside the app).

# faultinfo.js is 60 MB of ISTA fault detail and faultmeta.js another 14 MB.
# They load lazily in the app; on a static host they are just weight, so ship
# them gzipped beside the original the way job code already does.
#
# The .gz siblings are an OPTIMISATION, not a requirement: StaticHost only
# rewrites a request onto foo.gz when the plain file is MISSING, and gzip -k
# keeps the original, so a build without them still serves everything -- just
# uncompressed. That is why absence is fine but a failure HERE is not: a
# broken gzip should fail the build, not quietly ship the fat site.
# Bundle the renderer scripts into one $OUT/bundle.js (index.html load order)
# and collapse $OUT/index.html to a single <script> tag. The dev source keeps
# its individual tags; only the shipped copy is bundled.
echo "==> bundling the renderer"
node "$ROOT/scripts/build/bundle-renderer.mjs" "$OUT" "$OUT/bundle.js"
node "$ROOT/scripts/build/bundle-index.mjs" "$OUT/index.html"
grep -q 'bundle.js' "$OUT/index.html"

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
