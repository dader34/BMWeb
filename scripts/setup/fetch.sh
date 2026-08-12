#!/bin/bash
# One place to get BMW's files. Everything comes from Hugging Face.
#
#   scripts/setup/fetch.sh                  # ask what you want
#   scripts/setup/fetch.sh --vendor         # SGBDs + INPA menus (rebuild data)
#   scripts/setup/fetch.sh --wiring         # every chassis' diagrams
#   scripts/setup/fetch.sh --wiring E46 E39 # just those
#   scripts/setup/fetch.sh --coding         # NCS coding descriptions
#   scripts/setup/fetch.sh --wds            # BMW's WDS ISO (4.7 GB)
#   scripts/setup/fetch.sh --all            # the lot (~7 GB)
#   scripts/setup/fetch.sh --list           # what is available, and sizes
#
# WHAT YOU ACTUALLY NEED, which is less than people assume:
#
#   Running BMacW ............ NOTHING. The app is self-contained; the
#                              renderer reads static JSON out of dist-web/.
#                              vendor/ is a BUILD input, not runtime data.
#   Wiring diagrams .......... --wiring. Optional, per chassis, and the only
#                              one an ordinary user is likely to want.
#   Rebuilding the ECU data .. --vendor. BMW's SGBDs and INPA's menu files.
#   Re-importing wiring ...... --wds, to run tools/wds_import.py against a
#                              newer WDS release. Rarely.
#
# WHY ONE HOST. These used to come from three: Google Drive (vendor), two
# GitHub release repos (wiring, coding). Drive rate-limits and rewrites its
# download URLs, and release assets need `gh` and an auth dance. Hugging Face
# serves plain HTTPS with resumable ranges and no login for a public dataset,
# so all of it is one curl away and a half-finished download can be resumed
# rather than restarted.
#
# Needs: curl, and 7z (brew install sevenzip) only for --vendor and --wds.
set -euo pipefail
cd "$(dirname "$0")/../.."

HF=https://huggingface.co/datasets/CraigFf/bmw-files/resolve/main
API=https://huggingface.co/api/datasets/CraigFf/bmw-files

# the wiring archives live under a directory whose name has spaces and
# parentheses; everything else is a plain path
enc() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"; }

say()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl not found"

# Resumable, and never leaves a half file where the real one goes: download
# to .part and rename only once curl exits clean. A truncated .wiring is
# worse than a missing one -- the app opens it and shows an empty tree.
get() {
  local url="$1" dest="$2" label="$3"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ]; then
    say "$label already present, skipping"
    return 0
  fi
  say "$label"
  curl -fL --progress-bar -C - -o "$dest.part" "$url" || {
    rm -f "$dest.part"
    die "download failed: $label"
  }
  mv "$dest.part" "$dest"
}

list_remote() {
  local sub="$1"
  curl -fsS "$API/tree/main/$sub" 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
for f in sorted(d, key=lambda x: x["path"]):
    if f.get("type") != "file": continue
    sz = (f.get("lfs") or {}).get("size") or f.get("size") or 0
    print(f["path"].split("/")[-1] + "\t" + str(sz))
'
}

do_list() {
  echo "==> wiring (app/renderer/data/wiring/) -- optional, per chassis"
  list_remote wiring | while IFS=$'\t' read -r n s; do
    printf '    %-22s %6.0f MB\n' "${n%.wiring}" "$((s))e-6"
  done 2>/dev/null || warn "could not reach Hugging Face"
  echo
  echo "==> coding (vendor/EC-APPS/NCSEXPER/DATEN/) -- NCS descriptions"
  list_remote coding | while IFS=$'\t' read -r n s; do
    printf '    %-22s %6.1f MB\n' "${n%.coding.tar.gz}" "$((s))e-6"
  done 2>/dev/null || true
  echo
  echo "==> vendor   ec-apps.zip              710 MB   BMW SGBDs + INPA menus"
  echo "==> wds      BMW_WDS_v15_English.iso  4.7 GB   only to re-import wiring"
}

# ---- vendor: BMW's SGBDs and INPA's menu files -----------------------------
# ec-apps.zip is the EXTRACTED tree, flat at its root. fetch-vendor.sh used to
# pull a 710 MB zip off Google Drive and dig EDIABAS/Ecu and EC-APPS/INPA out
# of it; same idea, one stable URL.
do_vendor() {
  command -v 7z >/dev/null 2>&1 || command -v 7zz >/dev/null 2>&1 \
    || die "7z not found (brew install sevenzip)"
  local SEVEN; SEVEN=$(command -v 7z || command -v 7zz)

  if [ -d vendor/EDIABAS/Ecu ] && [ -d vendor/EC-APPS/INPA ]; then
    say "vendor/ already populated (delete vendor/EDIABAS and vendor/EC-APPS to refetch)"
    return 0
  fi

  local zip=.cache/ec-apps.zip
  get "$HF/ec-apps.zip" "$zip" "ec-apps.zip (710 MB)"

  say "unpacking (needs ~4 GB free)"
  local tmp; tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  "$SEVEN" x -y -o"$tmp" "$zip" >/dev/null

  # case and nesting vary between packagings, so find them rather than assume
  local ECU INPA
  ECU=$(find "$tmp" -maxdepth 4 -type d -iname Ecu   | head -1)
  INPA=$(find "$tmp" -maxdepth 4 -type d -iname INPA | head -1)
  [ -n "$ECU" ]  || die "no Ecu/ directory inside ec-apps.zip"
  [ -n "$INPA" ] || die "no INPA/ directory inside ec-apps.zip"

  mkdir -p vendor/EDIABAS vendor/EC-APPS
  rm -rf vendor/EDIABAS/Ecu vendor/EC-APPS/INPA
  cp -R "$ECU"  vendor/EDIABAS/Ecu
  cp -R "$INPA" vendor/EC-APPS/INPA
  say "vendor/EDIABAS/Ecu and vendor/EC-APPS/INPA in place"
}

# ---- wiring: one .wiring per chassis ---------------------------------------
# These carry the diagrams, the descriptions AND the component photographs, so
# the app needs no network once they are here.
do_wiring() {
  local want=("$@")
  local dest=app/renderer/data/wiring
  local names; names=$(list_remote wiring | cut -f1) || die "could not list wiring on Hugging Face"
  [ -n "$names" ] || die "no wiring archives found on Hugging Face"

  local got=0
  for n in $names; do
    local c="${n%.wiring}"
    if [ ${#want[@]} -gt 0 ]; then
      local match=0
      for w in "${want[@]}"; do
        [ "$(printf %s "$w" | tr a-z A-Z)" = "$(printf %s "$c" | tr a-z A-Z)" ] && match=1
      done
      [ $match -eq 1 ] || continue
    fi
    get "$HF/wiring/$n" "$dest/$n" "$c wiring"
    got=$((got+1))
  done
  [ $got -gt 0 ] || warn "nothing matched; try --list"
  say "$got wiring archive(s) in $dest"
}

# ---- coding: NCS Expert's parameter descriptions ---------------------------
do_coding() {
  local dest=vendor/EC-APPS/NCSEXPER/DATEN
  mkdir -p "$dest"
  local tgz=.cache/all.coding.tar.gz
  get "$HF/coding/all.coding.tar.gz" "$tgz" "coding descriptions"
  say "unpacking into $dest"
  tar xzf "$tgz" -C "$dest"

  # NCS Dummy's Translations.csv: daten_map.py reads it for English labels.
  # The archive is NCS Dummy 0.6.10 (exe, manual, translations), repacked
  # without its distributor's archive password; only the CSV is taken from
  # it. Optional: without 7z, or without the archive, the build still runs
  # and daten_map.py says what is missing.
  local SEVEN; SEVEN=$(command -v 7z || command -v 7zz || true)
  if [ -n "$SEVEN" ] && [ ! -f vendor/NCSDummy/Translations.csv ]; then
    local nd=.cache/NCS-Dummy-0.6.10.7z
    get "$HF/NCS-Dummy-0.6.10.7z" "$nd" "NCS Dummy (translations)"
    mkdir -p vendor/NCSDummy
    "$SEVEN" e -y -ovendor/NCSDummy \
      "$nd" 'NCSDummy 0.6.10/Translations.csv' >/dev/null \
      && say "vendor/NCSDummy/Translations.csv in place" \
      || warn "could not extract Translations.csv from $nd"
  elif [ -z "$SEVEN" ]; then
    warn "7z not found: skipping NCS Dummy translations (brew install sevenzip)"
  fi
  say "coding data in place"
}

# ---- wds: BMW's WDS ISO, only to re-run the importer -----------------------
do_wds() {
  local iso=vendor/WDS/BMW_WDS_v15_English.iso
  get "$HF/BMW_WDS_v15_English.iso" "$iso" "WDS ISO (4.7 GB)"
  say "mount it and point the importer at it:"
  say "  hdiutil attach '$iso'"
  say "  tools/wds_import.py --wds /Volumes/<mounted>"
}

# ---- menu ------------------------------------------------------------------
interactive() {
  echo "What do you need?"
  echo
  echo "  1) Wiring diagrams          ~1.1 GB   optional, per chassis"
  echo "  2) Vendor data (SGBDs)      710 MB    to rebuild the ECU data"
  echo "  3) Coding descriptions      ~10 MB    NCS Expert parameters"
  echo "  4) WDS ISO                  4.7 GB    only to re-import wiring"
  echo "  5) Everything               ~7 GB"
  echo "  0) Nothing, just show me what is available"
  echo
  echo "  (running BMacW itself needs none of these -- the app is self-contained)"
  echo
  printf 'choice [1]: '
  read -r choice
  case "${choice:-1}" in
    1) printf 'which chassis? (blank = all, e.g. "E46 E39"): '; read -r cs
       # shellcheck disable=SC2086
       do_wiring $cs ;;
    2) do_vendor ;;
    3) do_coding ;;
    4) do_wds ;;
    5) do_vendor; do_coding; do_wiring ;;
    0) do_list ;;
    *) die "unknown choice: $choice" ;;
  esac
}

mkdir -p .cache

if [ $# -eq 0 ]; then
  interactive
  exit 0
fi

case "$1" in
  --list)   do_list ;;
  --vendor) do_vendor ;;
  --coding) do_coding ;;
  --wds)    do_wds ;;
  --wiring) shift; do_wiring "$@" ;;
  --all)    do_vendor; do_coding; do_wiring ;;
  -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown option: $1 (try --help)" ;;
esac
