#!/bin/sh
# Every guard on the generated-screen pipeline, in one command.
#
# Run this after touching anything under tools/decompile, tools/sgbd or
# tools/export. The generators write data for hundreds of ECUs
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
#   sgbd_code.py        -> data/job-code/  (input to the VM)
# data/sim-captures/vmfix.json is a FETCHED capture: the result sets the
# real EDIABAS engine produced for the replayed telegrams. The engine that
# wrote it (the .NET reference CLI) was removed from the repo in 2026-09,
# so the fixture cannot be regenerated -- restore it from git.
# (actuator captions live in the IR itself now: ir_build emits them; the
# old reference-dump generators whose _*.json nothing read are gone)
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
# test_ir_i18n.js is what catches it -- and `git status` will NOT, because
# data/* and ecus/ are gitignored, so a clean tree says nothing about whether
# the generated content is right. Trust check.sh, not git.
#
# Removed 2026-07-29 as genuinely dead, after checking each for importers and
# for output anyone reads: inpa2json.py (superseded by ipo_ir.py),
# ipo_actions.py (its _actions.json was never written, let alone read),
# ipo_grid.py (no output on disk, no importer -- live.js only mentioned it in
# a comment describing the grid format).
cd "$(dirname "$0")/.."

# Every check runs, and the failures are listed together at the end: a run
# that stopped at the first one hid every other, and a machine without the
# BMW originals stopped before any of the app's own tests.
FAILED=""
run() {
  "$@" || FAILED="$FAILED
  $*"
}

# The .IPO compiler + constant editor round-trip against a committed corpus,
# so this one runs BEFORE the vendor gate -- it needs no BMW originals. Point
# BMWEB_IPO_CORPUS at vendor/EC-APPS/INPA/SGDAT to run it over the real tree.
echo "== .IPO compiler / editor round-trip =="
run python3 tools/verify/test_ipo_roundtrip.py
echo

# bmweb-cli runs COPIES of the renderer's scripts in node; its build and
# tests need no BMW originals either, so it also runs before the gate.
echo "== bmweb-cli: builds from the renderer's own files, tests pass, tarball is clean =="
run node tools/verify/test_cli.js
echo

# BMW originals are not in the repo; say so clearly before anything reads them
# (the checks that read them fail below and are listed; the rest still run)
if ! scripts/setup/check-vendor.sh >/dev/null 2>&1; then
  scripts/setup/check-vendor.sh
  echo
  echo "Continuing: the checks that need the originals will fail and be listed."
  echo
fi

echo "== .IPO decompiler vs ground truth =="
run python3 tools/verify/test_disasm.py
run python3 tools/verify/test_ipo_source.py

echo
echo "== IR emitter invariants =="
(cd tools/decompile && python3 -m ir_build --check)
run node tools/decompile/ipo_i18n.js --check

echo
echo "== offline export mirrors index.html =="
run node tools/verify/test_offline_shell.js

echo
echo "== freeze-frame (Umwelt) dictionary is a pure lookup =="
run node tools/verify/test_env_i18n.js

echo
echo "== captions translate through exact dictionaries only =="
run node tools/verify/test_ir_i18n.js

echo
echo "== ECU backup engine: crypto bit-exact, reads byte-identical, rails hold =="
run node tools/verify/test_flasher.js

echo
echo "== GS20 calibration engine: checksum pinned, write sequence, rails, baud change =="
run node tools/verify/test_gs20.js

echo
echo "== GS20 program / AIF / no-upshift / .0DA: checksums, records, patches, decode =="
run node tools/verify/test_gs20_program.js

echo
echo "== MS45 flashing engine: CRC-32, RSA signatures, EWS delete, exchange files =="
run node tools/verify/test_ms45_flash.js

echo
echo "== Map switch builder: byte-identical to the reference build, recognition, gates =="
run node tools/verify/test_mapswitch.js

echo
echo "== Live-tune client: open/sync/save against a faithful DME-service stub =="
run node tools/verify/test_livetune.js
run node tools/verify/test_livetune_cursor.js
run node tools/verify/test_livetune_correct.js
run node tools/verify/test_livetune_adapt.js
run node tools/verify/test_livetune_link.js
run node tools/verify/test_livetune_faults.js
run node tools/verify/test_logging_comfort.js
run node tools/verify/test_tuning_comfort.js
run node tools/verify/test_logging_replay.js
run node tools/verify/test_logging_tracer.js
run node tools/verify/test_flash_logview.js

echo
echo "== Engine protection builder: byte-identical to the emulator-tested build, gates, config =="
run node tools/verify/test_ms45_protect.js
run node tools/verify/test_flash_ops.js

echo
echo "== MS45 image validation math: CRC-32/MPEG-2, RSA signature, region/address =="
run node tools/verify/test_ms45_bin.js

echo
echo "== XDF parser + raw<->engineering codec the Tuning screen writes through =="
run node tools/verify/test_xdf.js

echo
echo "== no cross-file global-name collisions in the renderer =="
run node tools/verify/test_global_collisions.js

echo
echo "== INPA config export matches the shipped chassis-config =="
run python3 tools/export/inpa_config.py --check

echo
echo "== the VM against captured telegrams =="
run node tools/verify/test_bestvm.js
run node tools/verify/test_tabline.js
run node tools/verify/test_vm_config.js
run node tools/verify/test_fa_stream.js

echo
echo "== group SGBDs resolve variants (address -> concrete SGBD) =="
run node tools/verify/test_groups.js

echo
echo "== whole-vehicle sweep plans every chassis from its own config =="
run node tools/verify/test_sweep.js
run node tools/verify/test_fault_read_arg.js
run node tools/verify/test_report_noise.js

echo
echo "== export ships every variant a group can identify, not just the menu =="
run python3 tools/verify/test_export_gate.py

echo
echo "== coding encode is the exact inverse of decode (round-trip + Mod-36) =="
run node tools/verify/test_coding_encode.js

echo
echo "== write gate: staged changes never reach the wire (safety) =="
run node tools/verify/test_write_gate.js

echo
echo "== coding write dispatcher: per-family sequence, gate, prove-by-re-read =="
run node tools/verify/test_coding_write.js

echo
echo "== ZCS: validation, format, parse, SA code extraction, FA/ZCS filtering =="
run node tools/verify/test_coding_zcs.js

echo
echo "== custom coding parameters encode through the real codec (mask/shift) =="
run node tools/verify/test_coding_custom.js

echo
echo "== coding dispatch: derived A_<cabd> program runs end-to-end, frames the request =="
run node tools/verify/test_coding_dispatch.js

echo
echo "== coding UI -> write flow: review builds the payload, write needs confirmed =="
run node tools/verify/test_coding_ui_flow.js

echo
echo "== ECU memory read: region units (word vs byte), chunking, refused reads =="
run node tools/verify/test_tuning_memory.js

echo
echo "== ECU read dialog: count/range comments, profile regions, status origin, identify =="
run node tools/verify/test_tuning_read.js

echo
echo "== Web Serial read: a timed-out read is resumed, not orphaned (echo loss) =="
run node tools/verify/test_readsome.js

echo
echo "== ISO 9141 slow init: 5-baud wake, 10400 8N1, framing (E46 DME) =="
run node tools/verify/test_iso9141.js

echo
echo "== BMW-FAST long form (0xB8): XOR checksum, length byte, short->long fallback =="
run node tools/verify/test_longform.js

echo
echo "== AUFTRAGSAUSDRUCK: byte-coded predicate, precedence, real SGET bytes =="
run node tools/verify/test_coding_auftrag.js

echo
echo "== SGET rows extract and every predicate parses =="
run python3 tools/decompile/ncs_sget.py --check

echo
echo "== SGFAM/AT/ZST tables parse, and the ZCS->SA bridge resolves =="
run python3 tools/decompile/ncs_tables.py --check

echo
echo "== Vehicle identity: masters, ZCS->SA bridge, FA round-trip, discovery =="
run node tools/verify/test_vehicle_identity.js

echo
echo "== identity screen end to end: shipped tables + fa decode against a stubbed E46 =="
run node tools/verify/test_identity_screen.js

echo
echo "== Coding selection: SGET predicates pick the module and its coding file =="
run node tools/verify/test_coding_select.js

echo
echo "== service functions: the catalogue, its per-chassis resolution, the app =="
run node tools/verify/test_service_functions.js

echo
echo "== live .IPO runtime: entry, keys, screens, machines, scriptchange =="
run node tools/verify/test_ipo_runtime.js

echo
echo "== .IPO reader: a dropped script decodes to the same tokens the exporter ships =="
run node tools/verify/test_ipofile.js

echo
echo "== .IPO writer: a decoded script re-encodes to its own bytes =="
run node tools/verify/test_ipo_encode.js

echo
echo "== INPA source compiler: decompile, recompile, and drive the car the same way =="
run node tools/verify/test_ips_compile.js

echo
echo "== guided procedures: suspend on every job, honour waits, resolve segment jumps =="
run node tools/verify/test_guided.js

echo
echo "== renderer's VM bridge reconstructs frames the engine consumed =="
run node tools/verify/test_vmbridge.js

echo
echo "== the wire: framing, checksums, port settings, sessions =="
run node tools/verify/test_transport.js
run node tools/verify/test_port_label.js
run node tools/verify/test_read_pending.js

echo
echo "== write guard holds =="
run node tools/verify/test_writeguard.js

echo
echo "== comm parameters decode the way EDIABAS reads them =="
run node tools/verify/test_commpars.js

echo
echo "== remote session seam: car routes wait for the owner, never go local =="
run node tools/verify/test_remote.js

echo
echo "== beta journal: VINs scrubbed, ring bounded, report shape =="
run node tools/verify/test_journal.js

echo
echo "== fault-report PDF: one fixed column grid, both render paths agree =="
run node tools/verify/test_fault_report.js

echo
echo "== control unit tree: layout, scan status join, extractor =="
run node tools/verify/test_ecu_tree.js
run node tools/verify/test_tree_scan.js

echo
echo "== ISTA shell: tab model, routes, favourites, banner and details text =="
run node tools/verify/test_ista.js

echo
echo "== ISTA vehicle test: the read runs in the shell and is kept on the car =="
run node tools/verify/test_ista_vehicle_test.js

echo
echo "== repair manual: the extractor's document model, groups and pictures =="
run python3 tools/verify/test_repair_extract.py
run python3 tools/verify/test_ecu_functions_extract.py
run python3 tools/verify/test_repair_search_index.py

echo
echo "== repair manual: the browser's tree, the search scopes, the renderer =="
run node tools/verify/test_repair.js

echo
echo "== diagnosis structures: the tree joins, the document classes, the bodies =="
run node tools/verify/test_diag_structure.js

echo
echo "== ISTA test modules: flattening, the opaque switch, dispatch, the validator =="
run python3 tools/verify/test_abl_extract.py
run node tools/verify/test_abl_engine.js

echo
echo "== ISTA wiring: the designator index a clicked schematic resolves through =="
run python3 tools/verify/test_wiring_extract.py
run node tools/verify/test_wiring_applicability.js

echo
echo "== parts diagrams: callout hotspot file shape, the pos join, scale mapping =="
run node tools/verify/test_etk_hotspots.js
run node tools/verify/test_etk_lines.js
run node tools/verify/test_etk_identify.js
run node tools/verify/test_router_vin.js
run python3 tools/verify/test_etk_lines.py

echo
echo "== workshop documents: validity rules, the car filter, tree, renderers =="
run node tools/verify/test_techdata.js
run python3 tools/verify/test_techdata_extract.py

# Table completeness: the VM reaches tables the lifter never modelled, so a
# shipped set that omits declared tables silently decodes lookups as "".
# Needs a running app for the ECU table API; skipped otherwise.
# BMACW_PORT is the name before the rename; it still works
BMWEB_PORT="${BMWEB_PORT:-${BMACW_PORT:-}}"
if [ -n "$BMWEB_PORT" ] && [ -d data/sgbd-tables ]; then
  echo
  echo "== shipped tables cover what the SGBDs declare =="
  run python3 tools/export/sgbd_export.py --audit
else
  echo
  echo "SKIP (engine not running): sgbd_export.py --audit (table completeness)"
fi

echo
if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED"
  exit 1
fi
echo "all checks passed"
