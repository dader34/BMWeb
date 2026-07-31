#!/bin/bash
# Fetch BMW's WDS (Wiring Diagram System) and put it where the importer expects.
#
#   scripts/setup/fetch-wds.sh
#
# Downloads the WDS v15 English ISO (4.7 GB), mounts it, and copies the
# release tree into vendor/WDS/. tools/wds_import.py then turns that into the
# .wiring archives the app reads.
#
# WHAT IS IN IT: 23,926 wiring schematics as .svgz (gzipped SVG, which the
# renderer draws natively), 20,296 functional descriptions, and one document
# tree per chassis -- 18 of them, E38 through F01.
#
# OPTIONAL. Everything else builds and runs without this; only the Wiring
# screen needs it. That is why it is a separate script from fetch-vendor.sh:
# different BMW product, different download, and 4.7 GB nobody should pull
# unless they want the diagrams.
#
# WHY A SCRIPT AND NOT A CHECKOUT: BMW's files, not ours to redistribute.
# This automates the fetching; the copy is yours.
#
# Needs: curl, hdiutil (macOS), ~11 GB free while working (the ISO plus the
# copied tree; the script says where to delete the ISO afterwards).
set -euo pipefail
cd "$(dirname "$0")/../.."

# WDS v15 English, as posted publicly on DHTauto. Same shape of link as the
# Standard Tools package in fetch-vendor.sh: a public Drive file, no sign-in.
FILE_ID=17_Izw6azfcN0ZLtdBuZX0jPQN4UWSYsT
WORK="${TMPDIR:-/tmp}/bmacw-wds"
ISO="$WORK/BMW_WDS_v15_English.iso"
MNT="$WORK/mnt"

have_wds () {
  [ "$(find vendor/WDS/svg/sp -maxdepth 2 -iname '*.svgz' 2>/dev/null \
      | wc -l | tr -d ' ')" -ge 10000 ]
}

if have_wds; then
  echo "vendor/WDS is already installed; nothing to do."
  echo "(delete vendor/WDS to force a refetch)"
  exit 0
fi

command -v hdiutil >/dev/null 2>&1 || {
  echo "error: hdiutil not found. This script mounts an ISO and is macOS-only.
       On Linux: mount the ISO yourself and copy its release/us tree to
       vendor/WDS, then run tools/wds_import.py." >&2; exit 1; }

mkdir -p "$WORK"

if [ ! -s "$ISO" ]; then
  echo "==> downloading WDS v15 English (4.7 GB, this takes a while)"
  # Anything over ~100 MB gets an interstitial instead of the bytes: Google
  # serves a POST form to drive.usercontent.google.com carrying a per-request
  # uuid, so read the fields out of that page rather than guessing a query
  # string. Same dance as fetch-vendor.sh.
  COOK="$WORK/cookies"
  PAGE="$WORK/interstitial.html"
  curl -sL -c "$COOK" --max-time 180 \
    "https://drive.usercontent.google.com/download?id=$FILE_ID&export=download" \
    -o "$PAGE"

  field () { grep -oE "name=\"$1\" value=\"[^\"]*\"" "$PAGE" | head -1 \
             | sed -E "s/.*value=\"([^\"]*)\"/\1/"; }
  UUID=$(field uuid)
  CONF=$(field confirm)
  ACTION=$(grep -oE 'action="[^"]+"' "$PAGE" | head -1 | cut -d'"' -f2)
  ACTION=${ACTION:-https://drive.usercontent.google.com/download}

  # -C - resumes a part-finished file, which at this size matters
  curl -L -b "$COOK" -C - --max-time 7200 --retry 5 --retry-delay 5 -o "$ISO" \
    "$ACTION?id=$FILE_ID&export=download&confirm=${CONF:-t}${UUID:+&uuid=$UUID}"

  # a sign-in wall or quota error arrives as a small HTML page, not an ISO
  if [ "$(wc -c < "$ISO")" -lt 4000000000 ]; then
    echo "error: download is only $(du -h "$ISO" | cut -f1) -- that is a web
       page or a truncated file, not the ISO. Fetch it by hand from
       https://drive.google.com/file/d/$FILE_ID/view, save it to
       $ISO, and re-run this script." >&2
    exit 1
  fi
fi

echo "==> mounting"
mkdir -p "$MNT"
# -nobrowse keeps it out of Finder; the mount point is ours to clean up
hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$ISO" >/dev/null
trap 'hdiutil detach "$MNT" >/dev/null 2>&1 || true' EXIT

# The ISO's volume layout is "WDS BMW/release/<lang>/", and the English tree
# is under us/. Find it rather than hardcoding a path: other releases of the
# same disc name the volume differently.
REL=$(find "$MNT" -maxdepth 4 -type d -iname us \
      -path '*release*' 2>/dev/null | head -1)
[ -n "$REL" ] || REL=$(find "$MNT" -maxdepth 4 -type d -iname 'release' \
                       2>/dev/null | head -1)
[ -n "$REL" ] && [ -d "$REL/svg/sp" ] || {
  echo "error: mounted, but could not find the release tree (release/us with
       svg/sp inside) under $MNT. Copy it to vendor/WDS by hand." >&2
  exit 1; }

echo "==> installing into vendor/WDS (about 200 MB of the 4.7 GB)"
# Only what the importer reads: the shared document stores and the per-chassis
# trees. The rest of the disc is the Java applet, stylesheets and the frameset,
# all of which the app replaces with its own viewer.
rm -rf vendor/WDS
mkdir -p vendor/WDS
cp -R "$REL/svg"   vendor/WDS/svg
cp -R "$REL/zinfo" vendor/WDS/zinfo
for d in "$REL"/*/; do
  [ -d "$d/tree" ] || continue
  name=$(basename "$d")
  mkdir -p "vendor/WDS/$name"
  cp -R "$d/tree" "vendor/WDS/$name/tree"
done

echo "==> verifying"
if have_wds; then
  n=$(find vendor/WDS/svg/sp -iname '*.svgz' | wc -l | tr -d ' ')
  c=$(find vendor/WDS -maxdepth 2 -type d -name tree | wc -l | tr -d ' ')
  echo "  ok  $n diagrams, $c chassis trees"
else
  echo "error: the copy looks incomplete; see $MNT" >&2
  exit 1
fi

cat <<EOF

Now build the app's wiring archives:

  tools/wds_import.py --wds vendor/WDS

The ISO is still at $ISO ($(du -h "$ISO" | cut -f1)); delete it when you are done.
EOF
