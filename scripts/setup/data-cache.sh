#!/bin/bash
# Expand or drop the working copies of the generated ECU data.
#
#   scripts/setup/data-cache.sh expand   # .json.gz -> .json   (before tools/check.sh)
#   scripts/setup/data-cache.sh clean    # delete the .json, keep the .gz
#   scripts/setup/data-cache.sh status
#
# The generated data is committed GZIPPED (38 MB); the .json beside it is a
# working copy, gitignored and regenerable. Both existing at once is 565 MB of
# duplication, which is most of what makes data/ feel crammed.
#
# The tools read .json -- web_export.py, test_ir_render.js, sgbd_export.py,
# test_bestvm.js, test_writeguard.js -- so expand before running them and
# clean when the disk matters. The Pages workflow does its own expand for
# exactly this reason.
set -euo pipefail
cd "$(dirname "$0")/../.."

# groups ships/loads as .json.gz directly (bytecode + local tables +
# variants); it is listed so tests that want a readable .json can expand it,
# and clean keeps only ever removing a .json that has a .gz twin -- which
# leaves variants.json and index.json (committed plain) alone.
DIRS="job-code job-meta sgbd-tables inpa-ir groups"

case "${1:-status}" in
  expand)
    for d in $DIRS; do
      [ -d "data/$d" ] || continue
      find "data/$d" -name '*.json.gz' -print0 \
        | xargs -0 -r -P 8 -I{} gzip -dkf {}
    done
    echo "expanded: $(find $(printf 'data/%s ' $DIRS) -name '*.json' 2>/dev/null | wc -l | tr -d ' ') files"
    ;;
  clean)
    # only ever removes a .json that HAS a .gz twin: an unpaired .json is
    # something a generator just wrote and has not been compressed yet.
    n=0
    for d in $DIRS; do
      [ -d "data/$d" ] || continue
      for f in data/$d/*.json; do
        [ -e "$f" ] || continue
        case "$f" in */index.json) continue;; esac
        if [ -e "$f.gz" ]; then rm -f "$f"; n=$((n+1)); fi
      done
    done
    echo "removed $n working copies; $(du -sh data | cut -f1) left in data/"
    ;;
  status)
    printf '%-16s %8s %8s\n' dir raw gz
    for d in $DIRS; do
      [ -d "data/$d" ] || continue
      printf '%-16s %8s %8s\n' "$d" \
        "$(ls data/$d/*.json 2>/dev/null | wc -l | tr -d ' ')" \
        "$(ls data/$d/*.gz 2>/dev/null | wc -l | tr -d ' ')"
    done
    echo "data/ total: $(du -sh data | cut -f1)"
    ;;
  *)
    echo "usage: $0 {expand|clean|status}" >&2; exit 2;;
esac
