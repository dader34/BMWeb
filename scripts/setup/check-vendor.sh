#!/bin/bash
# Are BMW's original files in place? Say exactly what is missing and where it goes.
#
#   scripts/setup/check-vendor.sh
#
# These are BUILD INPUTS. Everything the app ships (dist-web/, data/) is
# generated from them, so you only need them to build from source or to
# regenerate data. They are not in the repo: 605 MB of BMW's own files that
# cannot be redistributed here.
set -uo pipefail
cd "$(dirname "$0")/../.."

miss=0
need () {   # path  minimum-file-count  glob  what-it-is
  n=$(find "$1" -maxdepth 2 -iname "$3" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -lt "$2" ]; then
    printf '  MISSING  %-34s expected >=%s %s (%s)\n' "$1" "$2" "$3" "$4"
    miss=$((miss+1))
  else
    printf '  ok       %-34s %s files\n' "$1" "$n"
  fi
}

echo "BMW originals (build inputs):"
need vendor/EDIABAS/Ecu            500 '*.prg'  "ECU modules: job code, tables, metadata"
need vendor/EC-APPS/INPA/SGDAT    1000 '*.ipo'  "INPA screens: the decompiled UI"
need vendor/EC-APPS/INPA/CFGDAT     10 '*.eng'  "chassis config: which ECUs each car has"

if [ "$miss" -gt 0 ]; then
  cat >&2 <<'EOF'

Missing files above. They come from BMW Standard Tools, which ships an
EDIABAS directory and an EC-APPS directory. Copy them in so the tree looks
like this:

  vendor/
    EDIABAS/
      Ecu/                  *.prg          (Bin/ and Hardware/ are Win32, skip them)
    EC-APPS/
      INPA/
        SGDAT/              *.IPO, *.ini
        CFGDAT/             *.ENG

Case does not matter; the tools match either. One source is linked in the
README. You do NOT need these to RUN a release build: the shipped app reads
only the generated data.
EOF
  exit 1
fi
echo "all present"
