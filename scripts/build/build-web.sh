#!/bin/bash
# Build the browser version: the same renderer, no server.
#
#   scripts/build/build-web.sh              -> dist-web/   (static, serve anywhere)
#   BMACW_PORT=51234 scripts/build/build-web.sh
#
# The macOS app ships a C# server that answers /api/*. A browser has no such
# thing, so the web build replaces it with two pieces:
#
#   tools/export/web_export.py   freezes every GET the renderer makes into static
#                         JSON (chassis config, job metadata, tables, IR)
#   app/renderer/core/webshim.js  intercepts fetch: static files for reads, and
#                         our BEST2 VM over Web Serial for job runs
#
# Nothing in the renderer changes. webshim.js installs over window.fetch
# before core.js loads, so api() cannot tell the difference.
#
# REQUIRES THE APP RUNNING: the chassis config is resolved from INPA's CFGDAT
# against the .prg tree at request time, which is exactly what gets frozen.
# Everything else is already a generated file.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"
OUT="dist-web"

# Find the running app if the caller did not name it. Its port is random.
if [ -z "${BMACW_PORT:-}" ]; then
  PID=$(pgrep -f "BMacW.app/Contents/MacOS/InpaMac.App" | head -1 || true)
  if [ -n "$PID" ]; then
    BMACW_PORT=$(lsof -nP -iTCP -sTCP:LISTEN -a -p "$PID" 2>/dev/null \
      | grep -oE "127\.0\.0\.1:[0-9]+" | head -1 | cut -d: -f2 || true)
  fi
fi
if [ -z "${BMACW_PORT:-}" ]; then
  echo "error: no running app found and BMACW_PORT not set." >&2
  echo "       start it first:  dotnet run --project src/InpaMac.App" >&2
  exit 1
fi
export BMACW_PORT
echo "==> using the app on 127.0.0.1:$BMACW_PORT to resolve chassis config"

rm -rf "$OUT"
mkdir -p "$OUT"

echo "==> freezing the API surface"
python3 tools/export/web_export.py --out "$OUT" "$@"

echo "==> copying the renderer"
cp -R "$ROOT/app/renderer/." "$OUT/"
# The relay is not part of the product any more: it needed node running
# beside the page, which no phone can do. Kept in the repo for anyone who
# still starts one by hand (?relay=1), but not shipped.
rm -f "$OUT/thor_bridge.js"

# Stamp the version into the web build. The native app injects window.bmacw
# (with .version) at document start; a web build has no host, so index.html sees
# window.BMACW_VERSION instead -- settings and the offline export both fall back
# to it. Read from the csproj so there is ONE version source.
VERSION=$(sed -n 's:.*<ApplicationDisplayVersion>\(.*\)</ApplicationDisplayVersion>.*:\1:p' \
  "$ROOT/src/InpaMac.App/InpaMac.App.csproj")
printf 'window.BMACW_VERSION=%s;\n' "\"${VERSION:-web}\"" > "$OUT/version.js"
# load it before app.js reads it (right after the opening <head>, cheap + early)
if ! grep -q 'version.js' "$OUT/index.html"; then
  # macOS/BSD sed: insert the tag after the first <head>
  sed -i.bak 's#<head>#<head>\n  <script src="version.js"></script>#' "$OUT/index.html"
  rm -f "$OUT/index.html.bak"
fi
# index.html already loads webshim.js: BOTH builds need it now. The macOS app
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
prove what landed. Demo mode works with no car attached.

Files: $RAW  Size: $SIZE
EOF

echo
echo "==> web build ready: $OUT ($SIZE, $RAW files)"
echo "    serve it:  python3 -m http.server -d $OUT 8080"
