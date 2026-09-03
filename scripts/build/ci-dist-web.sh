#!/bin/bash
# Assemble dist-web the way CI does it, with no running app: expand the
# committed data, build the per-car tree, freeze the API into static JSON,
# lay the renderer over it and stamp the version. Used by release-web.yml;
# pages.yml runs the same steps inline.
set -euo pipefail
cd "$(dirname "$0")/../.."

find data/inpa-ir -name '*.json.gz' -print0 | xargs -0 -r -P 4 -I{} gzip -dkf {}
echo "expanded: $(find data/inpa-ir -name '*.json' | wc -l) IR files"

python3 tools/export/build_ecu_tree.py
test -d data/chassis/E46

rm -rf dist-web && mkdir -p dist-web
python3 tools/export/web_export.py --out dist-web
cp -R app/renderer/. dist-web/

# WDS wiring VIN-applicability index (SP-doc -> chassis/engine, from ISTA). The
# .wiring bundles it filters are downloaded into dist-web/data/wiring/ later by
# release-web.yml; the index is small and committed, so place it now.
if [ -f data/wiring-applicability.json.gz ]; then
  mkdir -p dist-web/data/wiring
  cp data/wiring-applicability.json.gz dist-web/data/wiring/applicability.json.gz
fi
# the relay is not shipped, and the in-page exporter is what THIS replaces
rm -f dist-web/thor_bridge.js dist-web/core/offline-export.js

# one version source: the csproj. Settings and OFFLINE-README both read it.
VERSION=$(sed -n 's:.*<ApplicationDisplayVersion>\(.*\)</ApplicationDisplayVersion>.*:\1:p' src/InpaMac.App/InpaMac.App.csproj)
printf 'window.BMACW_VERSION=%s;\n' "\"${VERSION}\"" > dist-web/version.js
grep -q 'version.js' dist-web/index.html \
  || sed -i.bak 's#<head>#<head>\n  <script src="version.js"></script>#' dist-web/index.html
rm -f dist-web/index.html.bak
test -s dist-web/index.html
grep -q webshim.js dist-web/index.html
echo "dist-web ${VERSION}: $(du -sh dist-web | cut -f1)"
