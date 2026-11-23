#!/bin/bash
# Assemble dist-web the way CI does it, with no running app: fetch and expand
# the generated data, build the per-car tree, freeze the API into static JSON,
# lay the renderer over it and stamp the version. Used by release-web.yml;
# pages.yml runs the same steps inline.
set -euo pipefail
cd "$(dirname "$0")/../.."

# data/ is not in the repo: it is one pinned archive in the bmw-files dataset
python3 scripts/setup/fetch_repo_data.py

find data/inpa-ir -name '*.json.gz' -print0 | xargs -0 -r -P 4 -I{} gzip -dkf {}
echo "expanded: $(find data/inpa-ir -name '*.json' | wc -l) IR files"

# The exported API tree (the per-car tree + web_export, ~50 s) depends only
# on the fetched data and the exporter's sources, so CI caches it: EXPORT_DIR
# names the cached directory (pages.yml and release-web.yml key it the same
# way, so a release restores what the last Pages deploy built). A restored
# export is hard-linked into dist-web rather than rebuilt; an empty EXPORT_DIR
# is built into and left for the cache to save. Unset, everything is built
# straight into dist-web as before.
EXPORT_DIR="${EXPORT_DIR:-}"
rm -rf dist-web && mkdir -p dist-web
if [ -n "$EXPORT_DIR" ] && [ -d "$EXPORT_DIR/api/chassis" ]; then
  echo "exported tree: $(du -sh "$EXPORT_DIR" | cut -f1), restored from the cache"
else
  python3 tools/export/build_ecu_tree.py
  test -d data/chassis/E46
  if [ -n "$EXPORT_DIR" ]; then
    mkdir -p "$EXPORT_DIR"
    python3 tools/export/web_export.py --out "$EXPORT_DIR"
    echo "exported tree: $(du -sh "$EXPORT_DIR" | cut -f1), built"
  else
    python3 tools/export/web_export.py --out dist-web
  fi
fi
if [ -n "$EXPORT_DIR" ]; then cp -al "$EXPORT_DIR/." dist-web/; fi
# Over the hard links: cp -R writes the renderer's copy of a shared file in
# place, which would reach the cached export too. The export writes api/ and
# a few things under data/; app/renderer/data is gitignored, so a CI checkout
# has none of those and nothing is written through. (A dev tree with
# app/renderer/data filled should not set EXPORT_DIR.)
cp -R app/renderer/. dist-web/
cp -R app/site/. dist-web/   # the installer, docs and screenshots, beside the app

# WDS wiring VIN-applicability index (SP-doc -> chassis/engine, from ISTA). The
# .wiring bundles it filters are downloaded into dist-web/data/wiring/ later by
# release-web.yml; the index is small and already fetched, so place it now.
if [ -f data/wiring-applicability.json.gz ]; then
  mkdir -p dist-web/data/wiring
  cp data/wiring-applicability.json.gz dist-web/data/wiring/applicability.json.gz
fi

# ISTA reference-document bundles (one .docs per chassis). They came with the
# repo data above, so copy them straight in.
if ls data/docs/*.docs >/dev/null 2>&1; then
  mkdir -p dist-web/data/docs
  cp data/docs/*.docs dist-web/data/docs/
fi
# the in-page exporter is what THIS replaces
rm -f dist-web/core/offline-export.js

# The version stamp (package.json is the one source; Settings and
# OFFLINE-README both read it), the renderer scripts bundled into one
# dist-web/bundle.js in index.html load order, and dist-web/index.html
# collapsed to that single tag -- one request instead of hundreds. The
# individual source files are left in the tree (the SW may still hold them
# from a prior version and offline zips copy the whole dir), but the page no
# longer requests them. scripts/build/stamp-shell.mjs is the one copy of
# these steps.
node scripts/build/stamp-shell.mjs dist-web
VERSION=$(node -p "require('./package.json').version")
echo "dist-web ${VERSION}: $(du -sh dist-web | cut -f1)"
