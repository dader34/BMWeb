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
