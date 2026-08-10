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
# app/renderer/data/wiring is a gitignored dev-machine build of the wiring
# archives. Do NOT bundle it: StaticHost registers app/renderer BEFORE
# dist-web, so a copy here would shadow dist-web's at runtime -- and a dev
# machine has it while CI does not, which let dev DMGs mask CI wiring
# failures. The DMG's wiring comes from dist-web/data/wiring only.
rm -rf "$DATA/app/renderer/data/wiring"
if [ ! -d "$ROOT/dist-web/api" ]; then
  echo "error: dist-web/ is missing or empty. Build it first:" >&2
  echo "       scripts/build/build-web.sh" >&2
  exit 1
fi
# web_export.py creates dist-web/api/ unconditionally before doing any work,
# so the directory existing proves nothing. Count the chassis archives: an
# export that died early leaves too few (pages.yml holds the same line).
N_CHASSIS=$(find "$ROOT/dist-web/api" -name '*.chassis' | wc -l | tr -d ' ')
if [ "$N_CHASSIS" -lt 21 ]; then
  echo "error: dist-web/api holds $N_CHASSIS chassis archives, need >= 21." >&2
  echo "       The export died early or exported nothing. Rebuild it:" >&2
  echo "       scripts/build/build-web.sh" >&2
  exit 1
fi
# THE GENERATED DATA, NOT THE RENDERER. dist-web is a BUILD of the renderer
# (build-web.sh copies app/renderer into it and adds api/), so copying the
# whole tree would bundle the renderer twice. StaticHost serves app/renderer
# for the app's own files and this directory for everything generated
# beside them.
#
# api/ is the frozen API. data/wiring/ is BMW's schematics: ~150 MB for all
# 15 cars as published, and most of what makes this DMG large. It was left out when this copy was narrowed to
# api/ alone, which quietly made the app the only build with no Wiring
# section; the renderer asks for data/wiring/<id>.wiring and got a 404.
mkdir -p "$DATA/dist-web"
cp -R "$ROOT/dist-web/api"                 "$DATA/dist-web/api"
if [ -d "$ROOT/dist-web/data/wiring" ]; then
  mkdir -p "$DATA/dist-web/data"
  cp -R "$ROOT/dist-web/data/wiring"       "$DATA/dist-web/data/wiring"
  echo "==> wiring: $(du -sh "$DATA/dist-web/data/wiring" | cut -f1)"
fi
# A DMG without wiring already shipped once (v0.9.1) and looked fine until a
# user opened the Wiring section. Fail LOUDLY instead, on dev machines and CI
# alike: the packaged app must hold at least one .wiring archive.
N_WIRING=$(find "$DATA/dist-web/data/wiring" -name '*.wiring' 2>/dev/null | wc -l | tr -d ' ')
if [ "$N_WIRING" -eq 0 ]; then
  echo "error: no wiring archives packaged. Put the .wiring files in" >&2
  echo "       dist-web/data/wiring first -- in CI the workflow downloads" >&2
  echo "       them from the wiring-images release; locally copy your" >&2
  echo "       app/renderer/data/wiring build there or run:" >&2
  echo "       gh release download wiring-latest --repo dader34/BMacW-wiring-images \\" >&2
  echo "         --pattern '*.wiring' --dir dist-web/data/wiring" >&2
  exit 1
fi
echo "==> wiring archives: $N_WIRING"

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
