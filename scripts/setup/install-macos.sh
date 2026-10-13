#!/bin/bash
# Clears the download quarantine flag so macOS stops calling BMWeb "damaged".
# The app is unsigned (no Apple Developer account); this is the standard step
# for any unsigned Mac app. Run it after dragging BMWeb to Applications.
#
#   scripts/setup/install-macos.sh [/path/to/BMWeb.app]
#
# Input: the app bundle (default /Applications/BMWeb.app). Output: the same
# bundle with its quarantine attribute cleared and an ad-hoc signature.
set -euo pipefail

APP="${1:-/Applications/BMWeb.app}"

if [ ! -d "$APP" ]; then
  echo "BMWeb not found at $APP"
  echo "Drag BMWeb to your Applications folder first, or pass the path:"
  echo "  ./install-macos.sh /path/to/BMWeb.app"
  exit 1
fi

echo "Clearing quarantine on $APP ..."
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Re-signing ad-hoc ..."
codesign --force --deep --sign - "$APP"

echo "Done. You can launch BMWeb now."
