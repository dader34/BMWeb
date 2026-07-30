#!/bin/bash
# Package BMacW.app for release: publish the native app, bundle the BMW data
# it reads at runtime, sign, and wrap in a drag-to-Applications DMG.
#
#   scripts/package-macos.sh            -> dist-release/BMacW-<version>-arm64.dmg
#
# The release .app is standalone: Contents/Resources/data mirrors the repo
# layout (vendor/, data/, tools/, app/renderer/), which Paths.FindRepoRoot
# resolves when the app runs outside the repo. Signing happens LAST — ad-hoc,
# after the data lands — because signing before copying ~600MB of resources
# breaks the seal and macOS reports the app as "damaged".
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PROJ="src/InpaMac.App"
OUT="dist-release"

echo "==> publishing InpaMac.App (Release, osx-arm64)"
dotnet publish "$PROJ" -c Release -v q

APP=$(find "$PROJ/bin/Release" -maxdepth 4 -name "BMacW.app" -path "*Release*" | head -1)
[ -n "$APP" ] || { echo "error: BMacW.app not found under $PROJ/bin/Release" >&2; exit 1; }
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
echo "==> bundle: $APP (v$VERSION)"

STAGE=$(mktemp -d /tmp/bmacw-pkg.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/BMacW.app"
RES="$STAGE/BMacW.app/Contents/Resources"

echo "==> bundling runtime data into Contents/Resources/data"
DATA="$RES/data"
mkdir -p "$DATA/vendor/EDIABAS" "$DATA/vendor" "$DATA/tools" \
         "$DATA/data/inpa-layouts" "$DATA/app"
#  - vendor/EDIABAS/Ecu: the SGBDs the engine interprets (skip Bin/Hardware:
#    Win32 tools and drivers, dead weight on macOS)
cp -R "$ROOT/vendor/EDIABAS/Ecu"           "$DATA/vendor/EDIABAS/Ecu"
#  - vendor/EC-APPS: INPA chassis config + SGDAT screen sources
cp -R "$ROOT/vendor/EC-APPS"               "$DATA/vendor/EC-APPS"
#  - community token translations MenuGen loads at runtime
cp -R "$ROOT/tools/translations"           "$DATA/tools/translations"
#  - mined + hand-curated screen layouts served by /api/ecu/{sgbd}/layout
cp -R "$ROOT/data/inpa-layouts/enriched"   "$DATA/data/inpa-layouts/enriched"
#  - the UI itself
cp -R "$ROOT/app/renderer"                 "$DATA/app/renderer"
#  - the BEST2 VM's inputs and the offline metadata endpoints' data, for all
#    21 chassis. Job code ships GZIPPED ONLY: 456 MB of JSON compresses to
#    21 MB, and ServeDataFile prefers a .json.gz sibling and sets
#    Content-Encoding so fetch() inflates it transparently. Copying the raw
#    .json too would add 456 MB to the bundle for no benefit.
mkdir -p "$DATA/data/job-code" "$DATA/data/job-meta" \
         "$DATA/data/sgbd-tables" "$DATA/data/inpa-ir"
cp "$ROOT/data/job-code/"*.json.gz          "$DATA/data/job-code/"
cp "$ROOT/data/job-code/index.json"         "$DATA/data/job-code/"
# job-meta is read SERVER-SIDE off disk (MetaDoc -> File.ReadAllText), not
# served through ServeDataFile, so it needs the plain .json -- shipping only
# the .gz would make every offline job list 404 to the engine fallback.
cp "$ROOT/data/job-meta/"*.json             "$DATA/data/job-meta/"
cp -R "$ROOT/data/sgbd-tables/."            "$DATA/data/sgbd-tables/"
cp -R "$ROOT/data/inpa-ir/."                "$DATA/data/inpa-ir/"
#  - the per-ECU ship tree the chassis screens read
cp -R "$ROOT/ecus"                          "$DATA/ecus"

echo "==> ad-hoc signing (after resources, so the seal matches final contents)"
codesign --force --deep --sign - "$STAGE/BMacW.app"
codesign --verify --deep "$STAGE/BMacW.app"

echo "==> building DMG"
mkdir -p "$OUT"
DMG="$OUT/BMacW-$VERSION-arm64.dmg"
rm -f "$DMG"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "BMacW" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"

du -sh "$DMG"
echo "==> done: $DMG"
echo "    (unsigned build: users clear quarantine once with"
echo "     xattr -dr com.apple.quarantine /Applications/BMacW.app)"
