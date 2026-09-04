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
#                          ipo_gauges.py -> _gauges.json is now a reference dump
#                          too: ir_build derives gauge bounds by executing the
#                          .IPO, so nothing reads _gauges.json any more.
#   vm_fixtures.py      -> vmfix.json      (input to test_bestvm.js)
#   sgbd_code.py        -> data/job-code/  (input to the VM)
# (actuator captions live in the IR itself now: ir_build emits them)
#
# THE HAND-RUN GENERATORS ARE ORDERED. Regenerating everything before a build
# is not a set of independent commands -- three of them feed each other, and
# running them out of order silently ships worse data than doing nothing:
#
#   1. (cd tools/decompile && python3 -m ir_build --write) -> data/inpa-ir/, i18n
#                                             EMPTY plus a `strings` hand-off list
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

# The .IPO compiler + constant editor round-trip against a committed corpus,
# so this one runs BEFORE the vendor gate -- it needs no BMW originals. Point
# BMACW_IPO_CORPUS at vendor/EC-APPS/INPA/SGDAT to run it over the real tree.
echo "== .IPO compiler / editor round-trip =="
python3 tools/verify/test_ipo_roundtrip.py
echo

# BMW originals are not in the repo; say so clearly before anything reads them
scripts/setup/check-vendor.sh >/dev/null 2>&1 || { scripts/setup/check-vendor.sh; exit 1; }

echo "== .IPO decompiler vs ground truth =="
python3 tools/verify/test_disasm.py

echo
echo "== IR emitter invariants =="
(cd tools/decompile && python3 -m ir_build --check)
node tools/decompile/ipo_i18n.js --check

echo
echo "== offline export mirrors index.html =="
node tools/verify/test_offline_shell.js

echo
echo "== freeze-frame (Umwelt) dictionary is a pure lookup =="
node tools/verify/test_env_i18n.js

echo
echo "== IR interpreter renders known screens =="
node tools/verify/test_ir_render.js

echo
echo "== no cross-file global-name collisions in the renderer =="
node tools/verify/test_global_collisions.js

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
echo "== group SGBDs resolve variants (address -> concrete SGBD) =="
node tools/verify/test_groups.js || exit 1

echo
echo "== whole-vehicle sweep plans every chassis from its own config =="
node tools/verify/test_sweep.js || exit 1

echo
echo "== export ships every variant a group can identify, not just the menu =="
python3 tools/verify/test_export_gate.py || exit 1

echo
echo "== coding encode is the exact inverse of decode (round-trip + Mod-36) =="
node tools/verify/test_coding_encode.js || exit 1

echo
echo "== write gate: staged changes never reach the wire (safety) =="
node tools/verify/test_write_gate.js || exit 1

echo
echo "== coding write dispatcher: per-family sequence, gate, prove-by-re-read =="
node tools/verify/test_coding_write.js || exit 1

echo
echo "== ZCS: validation, format, parse, SA code extraction, FA/ZCS filtering =="
node tools/verify/test_coding_zcs.js || exit 1

echo
echo "== ECU memory read: region units (word vs byte), chunking, refused reads =="
node tools/verify/test_tuning_memory.js || exit 1

echo
echo "== Web Serial read: a timed-out read is resumed, not orphaned (echo loss) =="
node tools/verify/test_readsome.js || exit 1

echo
echo "== ISO 9141 slow init: 5-baud wake, 10400 8N1, framing (E46 DME) =="
node tools/verify/test_iso9141.js || exit 1

echo
echo "== BMW-FAST long form (0xB8): XOR checksum, length byte, short->long fallback =="
node tools/verify/test_longform.js || exit 1

echo
echo "== prompted activations: INPA's own range, appended to the job argument =="
node tools/verify/test_irprompt.js || exit 1

echo
echo "== fault-read entries that carry no job (INPA shows the list implicitly) =="
node tools/verify/test_irfaultread.js || exit 1

echo
echo "== AUFTRAGSAUSDRUCK: byte-coded predicate, precedence, real SGET bytes =="
node tools/verify/test_coding_auftrag.js || exit 1

echo
echo "== SGET rows extract and every predicate parses =="
python3 tools/decompile/ncs_sget.py --check || exit 1

echo
echo "== SGFAM/AT/ZST tables parse, and the ZCS->SA bridge resolves =="
python3 tools/decompile/ncs_tables.py --check || exit 1

echo
echo "== Vehicle identity: masters, ZCS->SA bridge, FA round-trip, discovery =="
node tools/verify/test_vehicle_identity.js || exit 1

echo
echo "== Coding selection: SGET predicates pick the module and its coding file =="
node tools/verify/test_coding_select.js || exit 1

echo
echo "== renderer's VM bridge reconstructs frames the engine consumed =="
node tools/verify/test_vmbridge.js || exit 1

echo
echo "== the wire: framing, checksums, port settings, sessions =="
node tools/verify/test_transport.js || exit 1

echo
echo "== write guard holds =="
node tools/verify/test_writeguard.js || exit 1

echo
echo "== comm parameters decode the way EDIABAS reads them =="
node tools/verify/test_commpars.js || exit 1

echo
echo "== remote session seam: car routes wait for the owner, never go local =="
node tools/verify/test_remote.js || exit 1

echo
echo "== fault-report PDF: one fixed column grid, both render paths agree =="
node tools/verify/test_fault_report.js || exit 1

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
