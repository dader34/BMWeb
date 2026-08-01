#!/bin/bash
# Package BMWeb for Windows and Linux.
#
#   scripts/build/package-desktop.sh [win|linux|all]
#       -> dist-release/BMWeb-<version>-win-x64.zip
#          dist-release/BMWeb-<version>-linux-x64.tar.gz
#
# The macOS build is BMacW and has its own script (package-macos.sh): it is an
# AppKit app in a signed .app bundle. This is the same renderer and the same
# BMacW.Host core in a Photino window -- WebView2 on Windows, WebKitGTK on
# Linux -- and it is called BMWeb, like the browser build.
#
# CROSS-BUILDING IS FINE HERE. `dotnet publish -r` cross-compiles, and neither
# payload needs a platform toolchain: Photino ships prebuilt native libraries
# per RID, and everything else is managed code plus BMW's data files. So this
# runs on the Mac and produces both.
#
# WHAT THE USER STILL NEEDS, per platform:
#   Windows  the WebView2 runtime. Shipped with Windows 11 and current 10;
#            older machines get it from Microsoft's evergreen installer.
#   Linux    libwebkit2gtk-4.1 (Debian/Ubuntu: libwebkit2gtk-4.1-0), and
#            permission to open the cable -- see 99-bmacw-kdcan.rules.
#
# SIZE: the wiring diagrams are ~1 GB of the payload on their own. They are
# included by default because a diagnostics tool that cannot show you the
# circuit is half a tool -- but BMACW_NO_WIRING=1 leaves them out, which takes
# the archive from ~1.2 GB to ~180 MB. The app notices they are absent and
# hides the wiring screens rather than failing.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
PROJ="src/BMacW.Desktop"
OUT="dist-release"
TARGET="${1:-all}"
NO_WIRING="${BMACW_NO_WIRING:-0}"

VERSION=$(grep -o '<Version>[^<]*' "$PROJ/BMacW.Desktop.csproj" | head -1 | cut -d'>' -f2)
[ -n "$VERSION" ] || { echo "error: no <Version> in $PROJ" >&2; exit 1; }

if [ ! -d "$ROOT/dist-web/api" ]; then
  echo "error: dist-web/ is missing or empty. Build it first:" >&2
  echo "       scripts/build/build-web.sh" >&2
  exit 1
fi

mkdir -p "$OUT"

# One platform: publish, lay the data beside the binary, archive.
#
# The data goes in a `data/` folder next to the executable because that is one
# of the layouts AppPaths.FindRoot understands -- the same walk that finds
# Contents/Resources/data inside the mac bundle.
package () {
  local rid="$1" label="$2"
  local stage; stage=$(mktemp -d "${TMPDIR:-/tmp}/bmweb-$label.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$stage'" RETURN

  echo "==> publishing $label ($rid)"
  dotnet publish "$PROJ" -c Release -r "$rid" --self-contained true \
    -o "$stage/BMWeb" -v q

  echo "==> bundling renderer + data"
  local data="$stage/BMWeb/data"
  mkdir -p "$data/app" "$data/dist-web"
  cp -R "$ROOT/app/renderer" "$data/app/renderer"

  # THE FROZEN API ONLY. dist-web is a BUILD of the renderer -- build-web.sh
  # copies app/renderer into it and adds api/ -- so copying the whole thing
  # ships the renderer twice, and with it a second copy of the 1 GB of wiring
  # archives. StaticHost serves app/renderer for the app's own files and
  # dist-web only for the frozen API beside them, so that is all that travels.
  cp -R "$ROOT/dist-web/api" "$data/dist-web/api"

  if [ "$NO_WIRING" = "1" ]; then
    rm -rf "$data/app/renderer/data/wiring"
    echo "    (wiring diagrams left out: BMACW_NO_WIRING=1)"
  fi

  # the platform's icon, where Program.cs looks for it
  [ -f "$ROOT/app/icon.png" ] && cp "$ROOT/app/icon.png" "$data/app/icon.png"
  [ -f "$ROOT/app/icon.ico" ] && cp "$ROOT/app/icon.ico" "$data/app/icon.ico"

  cp "$ROOT/scripts/setup/99-bmacw-kdcan.rules" "$stage/BMWeb/" 2>/dev/null || true
  cp "$ROOT/scripts/build/desktop-README.txt" "$stage/BMWeb/README.txt" 2>/dev/null || true

  if [ "$label" = "win-x64" ]; then
    local zip="$OUT/BMWeb-$VERSION-win-x64.zip"
    rm -f "$zip"
    ( cd "$stage" && zip -qr "$ROOT/$zip" BMWeb )
    du -sh "$zip"
  else
    local tgz="$OUT/BMWeb-$VERSION-$label.tar.gz"
    rm -f "$tgz"
    # the launcher must stay executable through the archive
    chmod +x "$stage/BMWeb/BMWeb" 2>/dev/null || true
    ( cd "$stage" && tar czf "$ROOT/$tgz" BMWeb )
    du -sh "$tgz"
  fi
}

case "$TARGET" in
  win)   package win-x64   win-x64 ;;
  linux) package linux-x64 linux-x64 ;;
  all)   package win-x64   win-x64
         package linux-x64 linux-x64 ;;
  *) echo "usage: $0 [win|linux|all]" >&2; exit 1 ;;
esac

echo "==> done"
ls -1 "$OUT"/BMWeb-"$VERSION"-* 2>/dev/null || true
