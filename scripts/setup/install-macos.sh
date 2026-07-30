#!/bin/bash
# Clears the download quarantine flag so macOS stops calling BMacW "damaged".
# The app is unsigned (no Apple Developer account); this is the standard step
# for any unsigned Mac app. Run it after dragging BMacW to Applications.
set -e

APP="${1:-/Applications/BMacW.app}"

if [ ! -d "$APP" ]; then
  echo "BMacW not found at $APP"
  echo "Drag BMacW to your Applications folder first, or pass the path:"
  echo "  ./install-macos.sh /path/to/BMacW.app"
  exit 1
fi

echo "Clearing quarantine on $APP ..."
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Re-signing ad-hoc ..."
codesign --force --deep --sign - "$APP"

echo "Done. You can launch BMacW now."
