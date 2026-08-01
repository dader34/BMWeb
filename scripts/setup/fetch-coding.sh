#!/bin/bash
# Fetch BMW's coding definitions and put them where the build expects.
#
#   scripts/setup/fetch-coding.sh            # every chassis (5.6 MB)
#   scripts/setup/fetch-coding.sh E46 E60    # just these
#   scripts/setup/fetch-coding.sh --list     # what is available
#
# WHAT THESE ARE. A module hands back its coding as a binary blob and says
# nothing about it. These files are what NCS Expert reads to turn that into
# "fold mirrors on lock": which bit at which address carries which function,
# and what the settings are called.
#
#     E46/LSZ.C26   block 0 word 1 byte 1 mask 0x02
#                   FEHLER_STANDLICHT   melden=00  nicht_melden=01
#
# WHY A DOWNLOAD AND NOT A CHECKOUT: same reason as vendor/EDIABAS. They are
# BMW's files, they are build inputs rather than something the app ships, and
# they are not in this repository. This just automates the fetching, from a
# 17.7 MB slice of SP-Daten v74 rather than the 16 GB distribution (almost
# all of which is ECU firmware for reprogramming, which nothing here uses).
#
# THE KEYWORD TABLE IS PER CHASSIS and each archive carries its own: E39 uses
# SWTFSW01, E46 SWTFSW06, E60 SWTFSW05, E70 SWTFSW11. Reading a module
# against the wrong one does not fail loudly -- it returns real keywords
# belonging to some other function -- so chassis and table travel together.
#
# Needs: gh (brew install gh), authenticated or not; the release is public.
set -euo pipefail
cd "$(dirname "$0")/../.."

REPO=dader34/BMacW-coding-data
TAG=coding-latest
DEST="vendor/EC-APPS/NCSEXPER/DATEN"

command -v gh >/dev/null 2>&1 || {
  echo "error: gh not found. brew install gh" >&2
  echo "       (or download from https://github.com/$REPO/releases/tag/$TAG" >&2
  echo "        and extract into $DEST/)" >&2
  exit 1; }

if [ "${1:-}" = "--list" ]; then
  echo "==> chassis available in $TAG"
  gh release view "$TAG" --repo "$REPO" --json assets \
    --jq '.assets[].name | select(endswith(".coding.tar.gz"))' \
    | sed 's/\.coding\.tar\.gz//' | grep -v '^all$' | sort | tr '\n' ' '
  echo
  exit 0
fi

mkdir -p "$DEST"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/bmacw-coding.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

if [ $# -eq 0 ]; then
  echo "==> downloading every chassis (5.6 MB)"
  gh release download "$TAG" --repo "$REPO" --pattern 'all.coding.tar.gz' \
    --dir "$WORK" --clobber
  # COPYFILE_DISABLE keeps macOS from unpacking ._ resource forks beside
  # every file, which the decoder would then try to read as coding data.
  COPYFILE_DISABLE=1 tar xzf "$WORK/all.coding.tar.gz" -C "$DEST"
else
  for ch in "$@"; do
    up=$(echo "$ch" | tr '[:lower:]' '[:upper:]')
    echo "==> downloading $up"
    if ! gh release download "$TAG" --repo "$REPO" \
         --pattern "$up.coding.tar.gz" --dir "$WORK" --clobber 2>/dev/null; then
      echo "    no coding data for $up (try --list)" >&2
      continue
    fi
    COPYFILE_DISABLE=1 tar xzf "$WORK/$up.coding.tar.gz" -C "$DEST"
  done
fi

echo "==> installed"
total=0
for d in "$DEST"/*/; do
  ch=$(basename "$d")
  n=$(find "$d" -maxdepth 1 -name '*.C[0-9][0-9]' 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" = "0" ] && continue
  tab=$(find "$d" -maxdepth 1 -iname 'SWTFSW*' -exec basename {} \; 2>/dev/null | head -1)
  printf '    %-5s %4s files  %s\n' "$ch" "$n" "${tab:-no keyword table}"
  total=$((total + n))
done
echo "    $total module files in $DEST"
echo
echo "Next: tools/decompile/daten_map.py   # -> app/renderer/data/datenmap.js"
