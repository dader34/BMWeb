#!/bin/bash
# Fetch BMW's originals and put them where the build expects.
#
#   scripts/fetch-vendor.sh
#
# Downloads ec-apps.zip (~750 MB) from the public Google Drive folder linked in
# the README and unpacks EDIABAS/Ecu and EC-APPS/INPA out of it into vendor/.
#
# NOT the BMW_Standard_Tools_Setup .exe in the same folder: that is a 32 MB
# InnoSetup STUB that downloads its payload at install time, so it contains no
# .prg and no .IPO and 7z cannot even list it. ec-apps.zip is the extracted
# data, which is what we need.
#
# WHY A SCRIPT AND NOT A GIT CHECKOUT: these are BMW's files, ~605 MB of them,
# and they are build inputs rather than something the app ships. They are not
# in the repository, so anyone building from source supplies their own copy.
# This just automates the fetching.
#
# The folder is publicly shared, so no Google sign-in is involved. If that ever
# changes the download step will fail with an HTML page instead of an .exe, and
# the check below catches it.
#
# Needs: curl, 7z (brew install sevenzip), ~4 GB free while unpacking
# (the zip plus its expansion; the script tells you where to delete it after).
set -euo pipefail
cd "$(dirname "$0")/../.."

FOLDER=1Odd9etzajiDBUYiso5NsTMZSoTOkeTXl
WORK="${TMPDIR:-/tmp}/bmacw-vendor"
ZIP="$WORK/ec-apps.zip"

command -v 7z >/dev/null 2>&1 || command -v 7zz >/dev/null 2>&1 || {
  echo "error: 7z not found. brew install sevenzip" >&2; exit 1; }
SEVEN=$(command -v 7z || command -v 7zz)

if scripts/setup/check-vendor.sh >/dev/null 2>&1; then
  echo "vendor/ already complete; nothing to do."
  echo "(delete vendor/EDIABAS and vendor/EC-APPS to force a refetch)"
  exit 0
fi

mkdir -p "$WORK"

if [ ! -s "$ZIP" ]; then
  echo "==> finding the installer in the shared folder"
  # The folder page embeds each file's id next to its name. Pull the id that
  # sits nearest the installer's filename rather than guessing the first id on
  # the page, which is the folder's own.
  ID=$(curl -sL --max-time 120 \
        "https://drive.google.com/drive/folders/$FOLDER" \
       | grep -oE 'data-id="[A-Za-z0-9_-]{25,45}"[^>]*ec-apps' \
       | head -1 | grep -oE '[A-Za-z0-9_-]{25,45}' | head -1)
  [ -n "$ID" ] || { echo "error: could not find the installer's file id. The
       folder may have changed or is no longer public. Download ec-apps.zip by hand
       from https://drive.google.com/drive/folders/$FOLDER and place it at
       $EXE, then re-run." >&2; exit 1; }

  echo "==> downloading ec-apps.zip (~710 MB, this takes a while)"
  # Anything over ~100 MB gets an interstitial instead of the bytes. It used to
  # carry a "confirm=" token in the URL; Google now serves a POST FORM to
  # drive.usercontent.google.com with a per-request uuid, so read the fields
  # out of that page rather than guessing a query string.
  COOK="$WORK/cookies"
  PAGE="$WORK/interstitial.html"
  curl -sL -c "$COOK" --max-time 180 \
    "https://drive.google.com/uc?export=download&id=$ID" -o "$PAGE"

  field () { grep -oE "name=\"$1\" value=\"[^\"]*\"" "$PAGE" | head -1 \
             | sed -E "s/.*value=\"([^\"]*)\"/\1/"; }
  UUID=$(field uuid)
  CONF=$(field confirm)
  ACTION=$(grep -oE 'action="[^"]+"' "$PAGE" | head -1 | cut -d'"' -f2)
  ACTION=${ACTION:-https://drive.usercontent.google.com/download}

  if [ -n "$UUID" ]; then
    curl -L -b "$COOK" --max-time 3600 --retry 3 -o "$ZIP" \
      "$ACTION?id=$ID&export=download&confirm=${CONF:-t}&uuid=$UUID"
  else
    # small enough to come straight back, or no interstitial this time
    curl -L -b "$COOK" --max-time 3600 --retry 3 -o "$ZIP" \
      "https://drive.google.com/uc?export=download&id=$ID"
  fi

  # A sign-in wall or a quota error arrives as a small HTML page, not an .exe
  if [ "$(wc -c < "$ZIP")" -lt 300000000 ]; then
    echo "error: download is only $(du -h "$ZIP" | cut -f1) -- that is a web
       page, not the installer. Fetch it by hand from
       https://drive.google.com/drive/folders/$FOLDER, save it to
       $ZIP, and re-run this script." >&2
    exit 1
  fi
fi

echo "==> unpacking (only the two trees we need)"
rm -rf "$WORK/x"
"$SEVEN" x -y -o"$WORK/x" "$ZIP" >/dev/null 2>&1 || true

# The installer lays its payload out under {app}/ or app/ depending on the
# 7z version, and the case of EDIABAS/EC-APPS varies. Find them rather than
# hardcoding a path that works on one machine.
find_tree () {
  find "$WORK/x" -maxdepth 6 -type d -iname "$1" 2>/dev/null | head -1
}
ECU=$(find_tree Ecu)
INPA=$(find_tree INPA)
[ -n "$ECU" ] && [ -n "$INPA" ] || {
  echo "error: unpacked, but could not find Ecu/ and INPA/ inside $WORK/x.
       Extract the installer by hand and copy them per the README." >&2
  exit 1; }

# NCS Expert's tree, which the same archive carries. DATEN holds what a
# module's coding MEANS -- which bit at which address is which function --
# for the ECUs whose SGBD does not say so itself. Optional: nothing that
# exists today reads it, and its absence is not an error.
NCS=$(find_tree NCSEXPER)

echo "==> installing into vendor/"
mkdir -p vendor/EDIABAS vendor/EC-APPS
rm -rf vendor/EDIABAS/Ecu vendor/EC-APPS/INPA
cp -R "$ECU"  vendor/EDIABAS/Ecu
cp -R "$INPA" vendor/EC-APPS/INPA
if [ -n "$NCS" ]; then
  # DATEN and CFGDAT only: SGDAT here is a second copy of INPA's screens and
  # BIN is Win32 executables, neither of which anything reads.
  rm -rf vendor/EC-APPS/NCSEXPER
  mkdir -p vendor/EC-APPS/NCSEXPER
  for sub in DATEN CFGDAT; do
    [ -d "$NCS/$sub" ] && cp -R "$NCS/$sub" "vendor/EC-APPS/NCSEXPER/$sub"
  done
  echo "    NCSEXPER: $(find vendor/EC-APPS/NCSEXPER -type f | wc -l | tr -d ' ') coding files"
else
  echo "    (no NCSEXPER in this archive; coding data will be absent)"
fi

echo "==> verifying"
scripts/setup/check-vendor.sh
echo
echo "Working files are in $WORK; delete it when you are done."
