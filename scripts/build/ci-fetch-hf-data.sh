#!/bin/bash
# Fetch the datasets the hosted site streams from Hugging Face at runtime into
# dist-web/data, so an offline build is actually offline. Plain HTTPS, no token.
#
#   scripts/build/ci-fetch-hf-data.sh faults   fault lookup + ISTA + VIN index, ~110 MB
#   scripts/build/ci-fetch-hf-data.sh etk      the ETK parts tree, ~5.8 GB
#
# Layout matches what the renderer probes locally before falling back to HF:
# translate.js  -> data/fault{db,index,meta,info}.js
# lookup.js     -> data/ista/faulttests.json
# etk.js        -> data/etk/<id>.etk, index.json, vehicles.json, thumbs/, vin-index.json.gz
# wiring.js     -> data/etk/vin-index.json.gz (VIN search on the wiring picker)
set -euo pipefail
cd "$(dirname "$0")/../.."
DATASET="${HF_DATA:-CraigFf/bmweb-etk}"
BASE="https://huggingface.co/datasets/${DATASET}/resolve/main"
DIST="${DIST:-dist-web}"
test -d "$DIST" || { echo "error: $DIST missing; build it first" >&2; exit 1; }

get() {  # get <remote path> <local path> <min bytes>
  mkdir -p "$(dirname "$2")"
  curl -fsSL --retry 5 --retry-delay 3 -o "$2" "$BASE/$1"
  size=$(stat -c%s "$2" 2>/dev/null || stat -f%z "$2")
  test "$size" -ge "$3" || { echo "error: $1 is only $size bytes" >&2; exit 1; }
  printf '  %-28s %6d KB\n' "$1" $((size / 1024))
}

case "${1:-}" in
  faults)
    echo "==> fault lookup data -> $DIST/data"
    get faults/faultdb.js      "$DIST/data/faultdb.js"           1000000
    get faults/faultindex.js   "$DIST/data/faultindex.js"         500000
    get faults/faultmeta.js    "$DIST/data/faultmeta.js"        5000000
    get faults/faultinfo.js    "$DIST/data/faultinfo.js"       20000000
    get ista/faulttests.json   "$DIST/data/ista/faulttests.json" 5000000
    # the VIN index (11 MB) so the wiring picker's VIN search works offline;
    # it lives under data/etk/ but is tiny next to the parts tree, so it ships
    # with every variant, not only the complete build
    get vin-index.json.gz      "$DIST/data/etk/vin-index.json.gz" 3000000
    ;;
  etk)
    echo "==> ETK parts tree -> $DIST/data/etk"
    pip install -q 'huggingface_hub>=0.30'
    python3 - "$DATASET" "$DIST/data/etk" <<'PY'
import sys, os
from huggingface_hub import snapshot_download
repo, out = sys.argv[1:3]
snapshot_download(repo_id=repo, repo_type="dataset", local_dir=out,
                  ignore_patterns=["bundles/*", "faults/*", "ista/*", ".gitattributes", "README.md"],
                  max_workers=8)
n = sum(1 for f in os.listdir(out) if f.endswith(".etk"))
print(f"{n} .etk bundles")
assert n >= 200, "expected the full 246-chassis ETK set"
for f in ("index.json", "vehicles.json", "vin-index.json.gz"):
    assert os.path.exists(os.path.join(out, f)), f"missing {f}"
PY
    # snapshot_download leaves its bookkeeping beside the files; not shipped
    rm -rf "$DIST/data/etk/.cache"
    du -sh "$DIST/data/etk"
    ;;
  *) echo "usage: $0 faults|etk" >&2; exit 2 ;;
esac
