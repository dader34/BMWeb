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
#   ipo_extract_all.py  -> data/inpa-layouts/   (served by ConfigEndpoints.cs)
#   sgbd_tables.py      -> data/inpa-screens/_tables.json (test_activations_safe)
#   ipo_actmenus.py     -> _actmenus.json  \
#   ipo_coding.py       -> _coding.json     > all consumed by ipo_enrich.py
#   ipo_submenus.py     -> _submenus.json  /
#   dump_specs.py       -> specdump.json   (input to test_specwalk.js)
#   vm_fixtures.py      -> vmfix.json      (input to test_bestvm.js)
#   sgbd_code.py        -> data/job-code/  (input to the VM)
# (actuator captions live in the IR itself now: ipo_ir.py emits steuernLabels)
#
# Removed 2026-07-29 as genuinely dead, after checking each for importers and
# for output anyone reads: inpa2json.py (superseded by ipo_ir.py),
# ipo_actions.py (its _actions.json was never written, let alone read),
# ipo_grid.py (no output on disk, no importer -- live.js only mentioned it in
# a comment describing the grid format).
set -e
cd "$(dirname "$0")/.."

echo "== MS45 ground truth (recall, no invented fields, known gaps) =="
python3 tools/test_ipo_recognize.py

echo
echo "== generated screens stay reads-only =="
python3 tools/test_activations_safe.py

echo
echo "== .IPO decompiler vs ground truth =="
python3 tools/test_disasm.py

echo
echo "== IR emitter invariants =="
python3 tools/ipo_ir.py --check
node tools/ipo_i18n.js --check

echo
echo "== IR interpreter renders known screens =="
node tools/test_ir_render.js

if [ -n "$BMACW_PORT" ]; then
  echo
  echo "== job metadata matches the engine =="
  python3 tools/test_meta.py || exit 1
fi

echo
echo "== renderer's VM bridge reconstructs frames the engine consumed =="
node tools/test_vmbridge.js || exit 1

echo
echo "== write guard holds =="
node tools/test_writeguard.js || exit 1

# Table completeness: the VM reaches tables the lifter never modelled, so a
# shipped set that omits declared tables silently decodes lookups as "".
# Needs a running app for the ECU table API; skipped otherwise.
if [ -n "$BMACW_PORT" ] && [ -d data/sgbd-tables ]; then
  echo
  echo "== shipped tables cover what the SGBDs declare =="
  python3 tools/sgbd_export.py --audit || exit 1
fi
