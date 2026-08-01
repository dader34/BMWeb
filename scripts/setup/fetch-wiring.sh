#!/bin/bash
# Fetch the built wiring diagrams, ready to use.
#
#   scripts/setup/fetch-wiring.sh            # every chassis (~1 GB)
#   scripts/setup/fetch-wiring.sh E46 E39    # just these
#   scripts/setup/fetch-wiring.sh --list     # what is available
#
# WHY THIS EXISTS ALONGSIDE fetch-wds.sh. That one downloads BMW's WDS ISO
# (4.7 GB) so tools/wds_import.py can BUILD these archives, which takes half
# an hour. You only need that to regenerate from a newer WDS. To just have
# working wiring diagrams, download what was already built: one .wiring per
# car, 2 to 115 MB each, straight into place.
#
# WHICH ARCHIVES THESE ARE. The wiring-full release carries diagrams,
# descriptions AND the component photographs, so the app works with no
# network. The wiring-latest release holds the same archives WITHOUT photos
# (144 MB all told) and exists for the hosted site: GitHub Pages allows 1 GB
# per site, and the photos are 878 MB on their own, so that build fetches
# them from jsDelivr at runtime instead. Nothing here needs that.
#
# Needs: gh (brew install gh). The release is public, so no login required.
set -euo pipefail
cd "$(dirname "$0")/../.."

REPO=dader34/BMacW-wiring-images
TAG=wiring-full
DEST="app/renderer/data/wiring"

command -v gh >/dev/null 2>&1 || {
  echo "error: gh not found. brew install gh" >&2
  echo "       (or download from https://github.com/$REPO/releases/tag/$TAG" >&2
  echo "        and put the .wiring files in $DEST/)" >&2
  exit 1; }

if [ "${1:-}" = "--list" ]; then
  echo "==> chassis available in $TAG"
  gh release view "$TAG" --repo "$REPO" --json assets \
    --jq '.assets[] | select(.name | endswith(".wiring"))
          | "  \(.name | sub("\\.wiring$";""))  \(.size/1048576|floor) MB"' \
    | sort
  exit 0
fi

mkdir -p "$DEST"

if [ $# -eq 0 ]; then
  echo "==> downloading every chassis (~1 GB, this takes a while)"
  gh release download "$TAG" --repo "$REPO" --pattern '*.wiring' \
    --dir "$DEST" --clobber
else
  for ch in "$@"; do
    up=$(echo "$ch" | tr '[:lower:]' '[:upper:]')
    echo "==> downloading $up"
    if ! gh release download "$TAG" --repo "$REPO" --pattern "$up.wiring" \
         --dir "$DEST" --clobber 2>/dev/null; then
      echo "    no wiring data for $up (try --list)" >&2
    fi
  done
fi

echo "==> installed"
n=0
for f in "$DEST"/*.wiring; do
  [ -f "$f" ] || continue
  sz=$(( $(wc -c < "$f") / 1048576 ))
  printf '    %-14s %4s MB\n' "$(basename "$f")" "$sz"
  n=$((n + 1))
done
if [ "$n" = "0" ]; then
  echo "    nothing downloaded" >&2
  exit 1
fi
echo "    $n chassis in $DEST"
echo
echo "The Wiring screen finds these on its own; nothing else to run."
