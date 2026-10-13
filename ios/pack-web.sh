#!/bin/sh
# Assemble the web app the iOS shell carries: the shell, the E46 chassis and
# its control units' data. The 1 GB of wiring, ETK and ISTA stays behind.
# Run after `node scripts/build/bundle-renderer.mjs app/renderer dist-web/bundle.js`.
set -e
cd "$(dirname "$0")/.."
SRC=dist-web
DST=ios/BMWeb/Web
rm -rf "$DST"
mkdir -p "$DST/api/chassis" "$DST/data/ecu-src"
cp "$SRC"/index.html "$SRC"/bundle.js "$SRC"/manifest.webmanifest "$SRC"/logo.svg "$DST"/
# the version stamp from package.json, not dist-web's copy: a dev dist-web
# keeps whatever version it was last built at, and a report from the phone
# then names the wrong one
printf 'window.BMWEB_VERSION="%s";\n' "$(node -p "require('./package.json').version")" > "$DST/version.js"
cp -R "$SRC"/css "$SRC"/core "$SRC"/img "$SRC"/vendor "$SRC"/ui "$DST"/ 2>/dev/null || true
cp "$SRC"/api/chassis.json "$SRC"/api/chassis-configs.json "$SRC"/api/ecu-index.json "$DST"/api/
cp "$SRC"/api/chassis/E46.chassis "$DST"/api/chassis/
for f in codingmap.js datenmap.js envmap.js faultdb.js; do [ -f "$SRC/data/$f" ] && cp "$SRC/data/$f" "$DST/data/"; done
python3 - "$SRC" "$DST" <<'PY'
import json, glob, shutil, sys, os
src, dst = sys.argv[1:3]
import zipfile
idx = json.load(open(f"{src}/api/ecu-index.json"))
# every control unit the E46 archive carries is found there, not in another car's archive
carried = {n[4:-4].lower() for n in zipfile.ZipFile(f"{src}/api/chassis/E46.chassis").namelist() if n.startswith("ecu/") and n.endswith(".ecu")}
for k in list(idx):
    if k.lower() in carried: idx[k] = "E46"
json.dump(idx, open(f"{dst}/api/ecu-index.json", "w"), separators=(",", ":"))
sgbds = carried | {k.lower() for k, v in idx.items() if v == "E46"}
n = 0
for s in sorted(sgbds):
    for f in glob.glob(f"{src}/data/ecu-src/{s}.*"):
        shutil.copy(f, f"{dst}/data/ecu-src/"); n += 1
print(f"{len(sgbds)} control units, {n} data files")
PY
du -sh "$DST"
