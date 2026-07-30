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

cd "$(dirname "$0")/../.."
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
mkdir -p "$DATA/app"
# THE APP READS TWO THINGS. AppDelegate serves app/renderer over loopback and
# dist-web beside it; there is no engine and no API any more, so the .prg
# tree, EC-APPS, the MenuGen translations and the mined layouts are all build
# inputs now, not runtime data. Bundling vendor/EDIABAS/Ecu alone was 443 MB
# that nothing opened.
cp -R "$ROOT/app/renderer"                 "$DATA/app/renderer"
if [ ! -d "$ROOT/dist-web/api" ]; then
  echo "error: dist-web/ is missing or empty. Build it first:" >&2
  echo "       scripts/build/build-web.sh" >&2
  exit 1
fi
cp -R "$ROOT/dist-web"                     "$DATA/dist-web"

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
