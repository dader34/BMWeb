#!/bin/sh
# Every guard on the generated-screen pipeline, in one command.
#
# Run this after touching anything under tools/ipo_*.py, tools/sgbd_harvest.py
# or MenuGen's activation code. The generators write data for hundreds of ECUs
# at once, so a quiet mistake is a quiet mistake everywhere -- these are the
# checks that turn that into a loud one.
#
#   tools/check.sh
#
# Some checks need the app running (the EDIABAS engine answers _ARGUMENTS and
# _RESULTS offline, no cable required). Those SKIP rather than fail when it is
# not, so this is safe to run anywhere.
#
# SOME GENERATORS ARE RUN BY HAND and so are named by no code. They look
# orphaned to a grep -- a reference count says 1, itself -- but their output
# is load-bearing. Do not delete them:
#   sgbd_tables.py      -> data/inpa-screens/_tables.json  (NO readers today;
#                          kept as a reference dump, not consumed by anything)
#   ipo_actmenus.py     -> _actmenus.json  \  satellites of the DELETED
#   ipo_coding.py       -> _coding.json     > ipo_enrich.py pipeline (the app
#   ipo_submenus.py     -> _submenus.json  /  renders from the IR now), so
#                          these outputs have NO reader -- reference dumps.
#                          The one satellite output still live is
#                          ipo_gauges.py -> _gauges.json (read by ipo_ir.py).
#   vm_fixtures.py      -> vmfix.json      (input to test_bestvm.js)
#   sgbd_code.py        -> data/job-code/  (input to the VM)
# (actuator captions live in the IR itself now: ipo_ir.py emits steuernLabels)
#
# THE HAND-RUN GENERATORS ARE ORDERED. Regenerating everything before a build
# is not a set of independent commands -- three of them feed each other, and
# running them out of order silently ships worse data than doing nothing:
#
#   1. python3 tools/decompile/ipo_ir.py --write     -> data/inpa-ir/, i18n EMPTY plus a
#                                             `strings` hand-off list
#   2. node tools/decompile/ipo_i18n.js              -> RESOLVES those strings back INTO
#                                             the IR files and drops the list
#   3. python3 tools/export/build_ecu_tree.py -> assembles the finished IR into
#                                             data/chassis/<CAR>/<ECU>/, which is
#                                             what web_export.py and the tests read
#
# Run i18n before --write and step 1 overwrites its work: every IR lands with
# i18n {} and the app renders raw German captions ("Control zurück an DME").
# test_ir_render.js is what catches it -- and `git status` will NOT, because
# data/* and ecus/ are gitignored, so a clean tree says nothing about whether
# the generated content is right. Trust check.sh, not git.
#
# Removed 2026-07-29 as genuinely dead, after checking each for importers and
# for output anyone reads: inpa2json.py (superseded by ipo_ir.py),
# ipo_actions.py (its _actions.json was never written, let alone read),
# ipo_grid.py (no output on disk, no importer -- live.js only mentioned it in
# a comment describing the grid format).
set -e

cd "$(dirname "$0")/.."

# BMW originals are not in the repo; say so clearly before anything reads them
scripts/setup/check-vendor.sh >/dev/null 2>&1 || { scripts/setup/check-vendor.sh; exit 1; }

echo "== .IPO decompiler vs ground truth =="
python3 tools/verify/test_disasm.py

# the IPO Lab ships a COPY of the decompiler (it runs in-page via Pyodide);
# a drifted copy would decompile uploads differently than the shipped IRs
for f in ipo_screens.py ipo_disasm.py ipo_ir.py; do
  cmp -s "tools/decompile/$f" "app/renderer/data/ipolab/$f" \
    || { echo "IPO Lab copy of $f drifted -- re-run: cp tools/decompile/$f app/renderer/data/ipolab/"; exit 1; }
done

echo
echo "== IR emitter invariants =="
python3 tools/decompile/ipo_ir.py --check
node tools/decompile/ipo_i18n.js --check

echo
echo "== IR interpreter renders known screens =="
node tools/verify/test_ir_render.js

echo
echo "== INPA config export matches the shipped chassis-config =="
python3 tools/export/inpa_config.py --check || exit 1

if [ -n "$BMACW_PORT" ]; then
  echo
  echo "== job metadata matches the engine =="
  python3 tools/verify/test_meta.py || exit 1
  echo
  echo "== lifted specs decode bytes the way the engine does =="
  # needs the .NET engine (vendor/ediabaslib-src); returns 1 on disagreement
  python3 tools/verify/sgbd_value_diff.py --selftest || exit 1
else
  echo
  echo "SKIP (engine not running): test_meta.py, sgbd_value_diff.py --selftest"
  echo "      set BMACW_PORT to run the engine-backed checks"
fi

echo
echo "== the VM against captured telegrams =="
node tools/verify/test_bestvm.js || exit 1

echo
echo "== write gate: staged changes never reach the wire (safety) =="
node tools/verify/test_write_gate.js || exit 1

echo
echo "== renderer's VM bridge reconstructs frames the engine consumed =="
node tools/verify/test_vmbridge.js || exit 1

echo
echo "== the wire: framing, checksums, port settings, sessions =="
node tools/verify/test_transport.js || exit 1

echo
echo "== write guard holds =="
node tools/verify/test_writeguard.js || exit 1

# Table completeness: the VM reaches tables the lifter never modelled, so a
# shipped set that omits declared tables silently decodes lookups as "".
# Needs a running app for the ECU table API; skipped otherwise.
if [ -n "$BMACW_PORT" ] && [ -d data/sgbd-tables ]; then
  echo
  echo "== shipped tables cover what the SGBDs declare =="
  python3 tools/export/sgbd_export.py --audit || exit 1
else
  echo
  echo "SKIP (engine not running): sgbd_export.py --audit (table completeness)"
fi
