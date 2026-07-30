#!/bin/bash
# Fetch BMW's originals and put them where the build expects.
#
#   scripts/fetch-vendor.sh
#
# Downloads BMW Standard Tools (a ~950 MB Windows installer) from the public
# Google Drive folder linked in the README, unpacks EDIABAS/Ecu and
# EC-APPS/INPA out of it, and drops them into vendor/.
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
# Needs: curl, 7z (brew install sevenzip), ~3 GB free while unpacking.
set -euo pipefail
cd "$(dirname "$0")/../.."

FOLDER=1Odd9etzajiDBUYiso5NsTMZSoTOkeTXl
WORK="${TMPDIR:-/tmp}/bmacw-vendor"
EXE="$WORK/BMW_Standard_Tools_Setup_2.12.0.exe"

command -v 7z >/dev/null 2>&1 || command -v 7zz >/dev/null 2>&1 || {
  echo "error: 7z not found. brew install sevenzip" >&2; exit 1; }
SEVEN=$(command -v 7z || command -v 7zz)

if scripts/setup/check-vendor.sh >/dev/null 2>&1; then
  echo "vendor/ already complete; nothing to do."
  echo "(delete vendor/EDIABAS and vendor/EC-APPS to force a refetch)"
  exit 0
fi

mkdir -p "$WORK"

if [ ! -s "$EXE" ]; then
  echo "==> finding the installer in the shared folder"
  # The folder page embeds each file's id next to its name. Pull the id that
  # sits nearest the installer's filename rather than guessing the first id on
  # the page, which is the folder's own.
  ID=$(curl -sL --max-time 120 \
        "https://drive.google.com/drive/folders/$FOLDER" \
       | grep -oE 'data-id="[A-Za-z0-9_-]{25,45}"[^>]*BMW_Standard_Tools' \
       | head -1 | grep -oE '[A-Za-z0-9_-]{25,45}' | head -1)
  [ -n "$ID" ] || { echo "error: could not find the installer's file id. The
       folder may have changed or is no longer public. Download it by hand
       from https://drive.google.com/drive/folders/$FOLDER and place it at
       $EXE, then re-run." >&2; exit 1; }

  echo "==> downloading (~950 MB, this takes a while)"
  # Anything over ~100 MB gets an interstitial "scan for viruses" page instead
  # of the bytes; the confirm token in that page is what unlocks the real
  # download, so fetch it, keep the cookies, and ask again.
  COOK="$WORK/cookies"
  TOKEN=$(curl -sc "$COOK" --max-time 120 \
            "https://drive.google.com/uc?export=download&id=$ID" \
          | grep -oE 'confirm=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2 || true)
  curl -Lb "$COOK" --max-time 3600 --retry 3 -o "$EXE" \
    "https://drive.google.com/uc?export=download&id=$ID${TOKEN:+&confirm=$TOKEN}"

  # A sign-in wall or a quota error arrives as a small HTML page, not an .exe
  if [ "$(wc -c < "$EXE")" -lt 100000000 ]; then
    echo "error: download is only $(du -h "$EXE" | cut -f1) -- that is a web
       page, not the installer. Fetch it by hand from
       https://drive.google.com/drive/folders/$FOLDER, save it to
       $EXE, and re-run this script." >&2
    exit 1
  fi
fi

echo "==> unpacking (InnoSetup archive, only the two trees we need)"
rm -rf "$WORK/x"
"$SEVEN" x -y -o"$WORK/x" "$EXE" >/dev/null 2>&1 || true

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

echo "==> installing into vendor/"
mkdir -p vendor/EDIABAS vendor/EC-APPS
rm -rf vendor/EDIABAS/Ecu vendor/EC-APPS/INPA
cp -R "$ECU"  vendor/EDIABAS/Ecu
cp -R "$INPA" vendor/EC-APPS/INPA

echo "==> verifying"
scripts/setup/check-vendor.sh
echo
echo "Working files are in $WORK; delete it when you are done."
