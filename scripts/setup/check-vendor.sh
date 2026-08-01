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

# Optional: reported, but never a reason to fail. The app builds and runs
# without it; only the wiring screen goes missing.
want () {   # path  minimum-file-count  glob  what-it-is
  n=$(find "$1" -maxdepth 2 -iname "$3" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -lt "$2" ]; then
    printf '  absent   %-34s optional: %s\n' "$1" "$4"
  else
    printf '  ok       %-34s %s files\n' "$1" "$n"
  fi
}

echo "BMW originals (build inputs):"
need vendor/EDIABAS/Ecu            500 '*.prg'  "ECU modules: job code, tables, metadata"
need vendor/EC-APPS/INPA/SGDAT    1000 '*.ipo'  "INPA screens: the decompiled UI"
need vendor/EC-APPS/INPA/CFGDAT     10 '*.eng'  "chassis config: which ECUs each car has"
want vendor/WDS/svg/sp           10000 '*.svgz' "WDS wiring diagrams (scripts/setup/fetch-wds.sh)"

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

# The wiring diagrams are separate: a different BMW product (WDS), a
# different download, and the only thing that needs them is the wiring
# screen. Check for the BUILT archives rather than the ISO -- those are what
# the app actually reads, and most people should download them rather than
# build them.
n_wiring=$(ls app/renderer/data/wiring/*.wiring 2>/dev/null | wc -l | tr -d ' ')
if [ "$n_wiring" -lt 1 ]; then
  cat <<'EOF'

Wiring diagrams are optional and not installed. To add them:

  scripts/setup/fetch-wiring.sh         # built archives, ~1 GB, ready to use
  scripts/setup/fetch-wiring.sh E46     # or just one car

Everything else builds and runs without them; only the Wiring screen is
missing until they are there. (To rebuild from BMW's ISO instead, see
scripts/setup/fetch-wds.sh -- that is 4.7 GB and only needed to regenerate.)
EOF
else
  echo "wiring: $n_wiring chassis installed"
fi

# The coding definitions are the same shape of thing: BMW's own, optional,
# and only the Coding screen needs them.
n_coding=$(ls -d vendor/EC-APPS/NCSEXPER/DATEN/*/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$n_coding" -lt 1 ]; then
  cat <<'EOF'

Coding definitions are optional and not installed. To add them:

  scripts/setup/fetch-coding.sh         # 5.6 MB, all 18 chassis
  tools/decompile/daten_map.py          # -> app/renderer/data/datenmap.js

Without them the Coding screen still works for the 32 ECUs whose SGBD names
its own values; these add BMW's own map for 35 more.
EOF
else
  echo "coding: $n_coding chassis installed"
fi
