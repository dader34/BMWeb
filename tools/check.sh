#!/bin/bash
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
# so the fixture cannot be regenerated. It left git with the rest of the
# generated data (2026-09-28) and now comes with it:
# python3 scripts/setup/fetch_repo_data.py
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
# Removed 2026-11-21, the same way: ipo_recognize.py, ipo_status.py,
# ipo_rootmenu.py and ipo_layout.py -- the first, inference-by-recognition
# pass over the .IPO files (1,073 lines). Nothing imported them and nothing
# read the _recognized/_status/_rootmenus/_submenus.json they wrote; the IR
# is built by executing the scripts (ir_build) and has been since 2026-09.
cd "$(dirname "$0")/.."

# Every check runs, and the failures are listed together at the end: a run
# that stopped at the first one hid every other, and a machine without the
# BMW originals stopped before any of the app's own tests.
#
# IN PARALLEL. The script below does not run anything itself: `section` and
# `run` write a plan, the plan is run CHECK_JOBS at a time (every core by
# default), and each check's output is then printed whole, in the order it
# is written here. The checks only read the tree (the one that builds, the
# CLI, builds into its own folder), so the order they finish in changes
# nothing; a run took 3 min 50 s one at a time. CHECK_JOBS=1 is that again,
# for a failure that looks like two checks meeting.
#
#   CHECK_JOBS=1 tools/check.sh      one at a time
#   tools/check.sh test_gs20         only the checks whose command says so
PLAN=$(mktemp -d "${TMPDIR:-/tmp}/bmweb-check.XXXXXX")
trap 'rm -rf "$PLAN"' EXIT
ONLY="${1:-}"
STEP=0
section() {
  if [ -n "$ONLY" ]; then return; fi # a filtered run prints its checks alone
  STEP=$((STEP + 1))
  printf '\n%s\n' "$*" > "$PLAN/$(printf %04d "$STEP").head"
}
run() {
  if [ -n "$ONLY" ] && [[ "$*" != *"$ONLY"* ]]; then return; fi
  STEP=$((STEP + 1))
  # the command as a script: quoted, so an argument with a space stays one
  printf '%q ' "$@" > "$PLAN/$(printf %04d "$STEP").cmd"
}
# A CHECK THAT NEEDS WHAT ONLY THE GENERATING MACHINE HAS is skipped where
# that is absent, and listed at the end -- not failed:
#
#   needs <path> [<path>...] run <command...>
#
# Two things are like that. BMW's originals (vendor/) cannot be fetched, so
# every check that reads them, or that asks whether the generated data is in
# step with them, belongs to the machine that generates. And a few extracts
# are not in the published data. Everything else -- the app's own tests, and
# every check of the fetched data -- must pass on any checkout: that is what
# lets the deploy run this whole file (it used to run nine tests picked by
# hand, because one missing original failed the run). A fetched fixture that
# is missing is still a failure: it can be fetched.
needs() {
  local missing=""
  while [ "$#" -gt 0 ] && [ "$1" != "run" ]; do
    [ -e "$1" ] || missing="${missing:+$missing, }$1"
    shift
  done
  shift # the word "run"
  if [ -z "$missing" ]; then
    run "$@"
    return
  fi
  if [ -n "$ONLY" ] && [[ "$*" != *"$ONLY"* ]]; then return; fi
  STEP=$((STEP + 1))
  printf '%s   (no %s)\n' "$*" "$missing" > "$PLAN/$(printf %04d "$STEP").skip"
}

# The .IPO compiler + constant editor round-trip against a committed corpus,
# so this one runs BEFORE the vendor gate -- it needs no BMW originals. Point
# BMWEB_IPO_CORPUS at vendor/EC-APPS/INPA/SGDAT to run it over the real tree.
section "== .IPO compiler / editor round-trip =="
run python3 tools/verify/test_ipo_roundtrip.py

# bmweb-cli runs COPIES of the renderer's scripts in node; its build and
# tests need no BMW originals either, so it also runs before the gate.
section "== bmweb-cli: builds from the renderer's own files, tests pass, tarball is clean =="
run node tools/verify/test_cli.js

# BMW originals are not in the repo; say so clearly before anything reads them
# (the checks that read them are skipped below and listed; the rest still
# run). CI=true is a runner, which never has them: no need to say so there.
if [ -z "${CI:-}" ] && ! scripts/setup/check-vendor.sh >/dev/null 2>&1; then
  scripts/setup/check-vendor.sh
  echo
  echo "Continuing: the checks that need the originals are skipped and listed."
  echo
fi
SGDAT=vendor/EC-APPS/INPA/SGDAT
NCSDATEN=vendor/EC-APPS/NCSEXPER/DATEN

section "== .IPO decompiler vs ground truth =="
needs "$SGDAT" run python3 tools/verify/test_disasm.py
run python3 tools/verify/test_ipo_source.py

section "== IR emitter invariants =="
# (this one ran outside `run` until 2026-11: its failure was printed and
# then forgotten, so the run still ended "all checks passed")
needs "$SGDAT" run sh -c 'cd tools/decompile && python3 -m ir_build --check'
# Is the IR in step with the caption dictionaries? A question about what the
# generators last wrote, answered by running them again (ipo_i18n.js), so it
# is asked where they run. (Asked of the PUBLISHED data on 2026-11-23 the
# answer was no for 222 ECUs: a dictionary gained captions after the IR was
# resolved. That is fixed by regenerating and republishing, not by a deploy.)
needs "$SGDAT" run node tools/decompile/ipo_i18n.js --check

section "== offline export mirrors index.html =="
run node tools/verify/test_offline_shell.js
run node tools/verify/test_chunks.js

section "== freeze-frame (Umwelt) dictionary is a pure lookup =="
run node tools/verify/test_env_i18n.js

section "== captions translate through exact dictionaries only =="
run node tools/verify/test_ir_i18n.js

section "== ECU backup engine: crypto bit-exact, reads byte-identical, rails hold =="
run node tools/verify/test_flasher.js
run node tools/verify/test_bytes.js
run node tools/verify/test_workspace_bus.js
run node tools/verify/test_modules_built.js
run node tools/verify/test_nrv2b.js
run node tools/verify/test_fast_flasher.js
run node tools/verify/test_trigger.js
run node tools/verify/test_aif_log_wire.js
run node tools/verify/test_flash_screens.js
run node tools/verify/test_flash_history.js
run node tools/verify/test_backup.js
run node tools/verify/test_oneclick.js
run node tools/verify/test_push_resume.js
run node tools/verify/test_fast_line_errors.js
run node tools/verify/test_fast_read_resume.js
run node tools/verify/test_relay.js

section "== GS20 calibration engine: checksum pinned, write sequence, rails, baud change =="
run node tools/verify/test_gs20.js

section "== GS20 program / AIF / no-upshift / .0DA: checksums, records, patches, decode =="
run node tools/verify/test_gs20_program.js

section "== MS45 flashing engine: CRC-32, RSA signatures, EWS delete, exchange files =="
run node tools/verify/test_ms45_flash.js

section "== Map switch builder: byte-identical to the reference build, recognition, gates =="
run node tools/verify/test_mapswitch.js

section "== Live-tune client: open/sync/save against a faithful DME-service stub =="
run node tools/verify/test_livetune.js
run node tools/verify/test_livetune_cursor.js
run node tools/verify/test_livetune_correct.js
run node tools/verify/test_livetune_adapt.js
run node tools/verify/test_livetune_link.js
run node tools/verify/test_livetune_faults.js
run node tools/verify/test_logging_comfort.js
run node tools/verify/test_logging.js
run node tools/verify/test_tuning_comfort.js
run node tools/verify/test_logging_replay.js
run node tools/verify/test_logging_tracer.js
run node tools/verify/test_flash_logview.js
run node tools/verify/test_faults_page.js
run node tools/verify/test_tcu_identify.js
run node tools/verify/test_scanner.js
run node tools/verify/test_scanner_proc.js
run node tools/verify/test_scanner_carinfo.js
run node tools/verify/test_scanner_faults.js
run node tools/verify/test_scanner_scan.js
run node tools/verify/test_recovery.js
run node tools/verify/test_scanner_unit.js
run node tools/verify/test_scanner_eeprom.js
run node tools/verify/test_shell_globals.js

section "== Engine protection builder: byte-identical to the emulator-tested build, gates, config =="
run node tools/verify/test_ms45_protect.js
run node tools/verify/test_flash_ops.js

section "== EWS/ISN matcher client: DS2 0x44 dialect, ISN read/write, sync, match state =="
run node tools/verify/test_ews.js

section "== DME identity vault: EEPROM dump through READ bit 30, 3-copy scan, blocks =="
run node tools/verify/test_eeprom.js

section "== ISN alignment: voting triples picked and rewritten, both repair flows =="
run node tools/verify/test_pairing.js

section "== MS45 image validation math: CRC-32/MPEG-2, RSA signature, region/address =="
run node tools/verify/test_ms45_bin.js

section "== XDF parser + raw<->engineering codec the Tuning screen writes through =="
run node tools/verify/test_xdf.js

section "== no cross-file global-name collisions in the renderer =="
run node tools/verify/test_global_collisions.js

section "== INPA config export matches the shipped chassis-config =="
needs vendor/EC-APPS/INPA/CFGDAT vendor/EDIABAS/Ecu run python3 tools/export/inpa_config.py --check

section "== the VM against captured telegrams =="
run node tools/verify/test_bestvm.js
run node tools/verify/test_tabline.js
run node tools/verify/test_vm_config.js
run node tools/verify/test_fa_stream.js

section "== group SGBDs resolve variants (address -> concrete SGBD) =="
run node tools/verify/test_groups.js

section "== whole-vehicle sweep plans every chassis from its own config =="
run node tools/verify/test_sweep.js
run node tools/verify/test_fault_read_arg.js
run node tools/verify/test_report_noise.js
run node tools/verify/test_fault_code.js

section "== export ships every variant a group can identify, not just the menu =="
run python3 tools/verify/test_export_gate.py

section "== coding encode is the exact inverse of decode (round-trip + Mod-36) =="
run node tools/verify/test_coding_encode.js

section "== write gate: staged changes never reach the wire (safety) =="
run node tools/verify/test_write_gate.js

section "== coding write dispatcher: per-family sequence, gate, prove-by-re-read =="
run node tools/verify/test_coding_write.js
run node tools/verify/test_coding_block.js
run node tools/verify/test_coding_image.js

section "== ZCS: validation, format, parse, SA code extraction, FA/ZCS filtering =="
run node tools/verify/test_coding_zcs.js

section "== custom coding parameters encode through the real codec (mask/shift) =="
run node tools/verify/test_coding_custom.js

section "== coding dispatch: derived A_<cabd> program runs end-to-end, frames the request =="
run node tools/verify/test_coding_dispatch.js

section "== every shipped coding script: no unserved call mid-write, order/ident preflight =="
run node tools/verify/test_coding_scripts.js

section "== WebKFP: flash-file reader, ZB table, CDH host data pump, WinKFP's own logic, every exported script served =="
run node tools/verify/test_kfp.js
# an offline build's packed data, read back through the app's own loaders
# (reference zstd), and the zstd decoder the app ships against the reference
run node tools/verify/test_packs.js
run node tools/verify/test_fzstd.js

section "== coding UI -> write flow: review builds the payload, write needs confirmed =="
run node tools/verify/test_coding_ui_flow.js

section "== BMWeb Coding (NCS): FSW_PSW.TRC/.MAN round trip, edits, warnings =="
run node tools/verify/test_ncs.js
run node tools/verify/test_coding_labels.js
run node tools/verify/test_ncs_factory.js
run node tools/verify/test_ncs_slots.js

section "== ZCS_SCHREIBEN / ZCS_LOESCHEN: BMW's cluster script writes the key (and only it) =="
run node tools/verify/test_ncs_zcs.js

section "== Web Serial read: a timed-out read is resumed, not orphaned (echo loss) =="
run node tools/verify/test_readsome.js

section "== ISO 9141 slow init: 5-baud wake, 10400 8N1, framing (E46 DME) =="
run node tools/verify/test_iso9141.js

section "== PA Soft V14x cable (WebUSB): scramble, frames, readers, retries =="
run node tools/verify/test_pasoft_usb.js

section "== BMW-FAST long form (0xB8): XOR checksum, length byte, short->long fallback =="
run node tools/verify/test_longform.js

section "== AUFTRAGSAUSDRUCK: byte-coded predicate, precedence, real SGET bytes =="
run node tools/verify/test_coding_auftrag.js

section "== SGET rows extract and every predicate parses =="
needs "$NCSDATEN" run python3 tools/decompile/ncs_sget.py --check

section "== CVT: each coding function's value per car decodes, and evaluates =="
needs "$NCSDATEN" run python3 tools/decompile/ncs_cvt.py --check
run node tools/verify/test_coding_cvt.js
run node tools/verify/test_ncs_key.js

section "== SGFAM/AT/ZST tables parse, and the ZCS->SA bridge resolves =="
needs "$NCSDATEN" run python3 tools/decompile/ncs_tables.py --check

section "== Vehicle identity: masters, ZCS->SA bridge, FA round-trip, discovery =="
run node tools/verify/test_vehicle_identity.js


section "== Coding selection: SGET predicates pick the module and its coding file =="
run node tools/verify/test_coding_select.js

section "== service functions: the catalogue, its per-chassis resolution, the app =="
run node tools/verify/test_service_functions.js

section "== live .IPO runtime: entry, keys, screens, machines, scriptchange =="
run node tools/verify/test_ipo_runtime.js
run node tools/verify/test_items.js

section "== .IPO reader: a dropped script decodes to the same tokens the exporter ships =="
run node tools/verify/test_ipofile.js

section "== .IPO writer: a decoded script re-encodes to its own bytes =="
run node tools/verify/test_ipo_encode.js

section "== INPA source compiler: decompile, recompile, and drive the car the same way =="
run node tools/verify/test_ips_compile.js

section "== guided procedures: suspend on every job, honour waits, resolve segment jumps =="
run node tools/verify/test_guided.js

section "== renderer's VM bridge reconstructs frames the engine consumed =="
run node tools/verify/test_vmbridge.js

section "== the wire: framing, checksums, port settings, sessions =="
run node tools/verify/test_transport.js
run node tools/verify/test_port_label.js
run node tools/verify/test_read_pending.js
run node tools/verify/test_reopen_closed_port.js

section "== write guard holds =="
run node tools/verify/test_writeguard.js

section "== comm parameters decode the way EDIABAS reads them =="
run node tools/verify/test_commpars.js

section "== remote session seam: car routes wait for the owner, never go local =="
run node tools/verify/test_remote.js

section "== beta journal: VINs scrubbed, ring bounded, report shape =="
run node tools/verify/test_journal.js

section "== the feedback prompt: when it asks, what it sends, and the collector that shelves it =="
run node tools/verify/test_feedback.js
run node tools/verify/test_beta_worker.mjs

section "== what a failure is called: each message the app throws gets the explanation that fits =="
run node tools/verify/test_errors.js

section "== fault-report PDF: one fixed column grid, both render paths agree =="
run node tools/verify/test_fault_report.js

section "== control unit tree: layout, scan status join, extractor =="
run node tools/verify/test_ecu_tree.js
run node tools/verify/test_tree_scan.js

section "== navigation: a deep link to a variant, a screen that lost its turn, the job search =="
run node tools/verify/test_deep_link_variant.js
run node tools/verify/test_screen_owner.js
run node tools/verify/test_search.js

section "== Garage: saved cars, scan history, comparing two reads =="
run node tools/verify/test_garage.js

section "== ISTA shell: tab model, routes, favourites, banner and details text =="
run node tools/verify/test_ista.js

section "== ISTA vehicle test: the read runs in the shell and is kept on the car =="
run node tools/verify/test_ista_vehicle_test.js
# pages drawn from ISTA's own layout: the compiler (when the decompiled XAML
# is on this machine) and the renderer's split into content/status/buttons
run node tools/verify/test_ista_xaml.js

section "== repair manual: the extractor's document model, groups and pictures =="
run python3 tools/verify/test_repair_extract.py
run python3 tools/verify/test_ecu_functions_extract.py
run python3 tools/verify/test_repair_search_index.py

section "== repair manual: the browser's tree, the search scopes, the renderer =="
run node tools/verify/test_repair.js

section "== diagnosis structures: the tree joins, the document classes, the bodies =="
run node tools/verify/test_diag_structure.js

section "== ISTA test modules: flattening, the opaque switch, dispatch, the validator =="
run python3 tools/verify/test_abl_extract.py
run node tools/verify/test_abl_engine.js

section "== ISTA wiring: the designator index a clicked schematic resolves through =="
run python3 tools/verify/test_wiring_extract.py
run node tools/verify/test_wiring_applicability.js

section "== parts diagrams: callout hotspot file shape, the pos join, scale mapping =="
run node tools/verify/test_etk_hotspots.mjs
run node tools/verify/test_etk_lines.mjs
run node tools/verify/test_etk_identify.mjs
run node tools/verify/test_router_vin.js
run python3 tools/verify/test_etk_lines.py
run node tools/verify/test_etk_rules.mjs
run python3 tools/verify/test_etk_rules.py

section "== workshop documents: validity rules, the car filter, tree, renderers =="
run node tools/verify/test_techdata.js
# (the rule facts are an ISTA extract the published data does not carry)
needs app/renderer/data/ista/techdata/rulefacts.json run node tools/verify/test_techdata_rules.js
run python3 tools/verify/test_techdata_extract.py

# Table completeness: the VM reaches tables the lifter never modelled, so a
# shipped set that omits declared tables silently decodes lookups as "".
# Needs a running app for the ECU table API; skipped otherwise.
# BMACW_PORT is the name before the rename; it still works
BMWEB_PORT="${BMWEB_PORT:-${BMACW_PORT:-}}"
if [ -n "$BMWEB_PORT" ] && [ -d data/sgbd-tables ]; then
  section "== shipped tables cover what the SGBDs declare =="
  run python3 tools/export/sgbd_export.py --audit
else
  section "SKIP (engine not running): sgbd_export.py --audit (table completeness)"
fi

# A test file nothing above names never runs, and nobody notices: 17 of them
# had piled up by 2026-11, all passing, none run. Every tools/verify/test_*
# is in the plan or the run fails.
MISSING=""
for f in tools/verify/test_*; do
  grep -qF "$(basename "$f")" tools/check.sh || MISSING="$MISSING
  $f"
done

# ---- run the plan, CHECK_JOBS at a time --------------------------------------
JOBS="${CHECK_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
TOTAL=$(find "$PLAN" -name '*.cmd' | wc -l | tr -d ' ')
echo "running $TOTAL checks, $JOBS at a time"
# Slowest first, by how long each took last time (kept beside the installed
# tools, which no checkout tracks): the run cannot be shorter than its
# longest check, and one that only starts half way through adds its whole
# length to the wait. A check never timed runs in the order written.
TIMES=node_modules/.cache/bmweb-check-times
for f in "$PLAN"/*.cmd; do
  [ -f "$f" ] || continue
  secs=$(grep -F -m 1 "	$(cat "$f")" "$TIMES" 2>/dev/null | cut -f 1)
  printf '%s\t%s\n' "${secs:-0}" "$f"
done | sort -k1,1nr -k2,2 | cut -f 2 | xargs -P "$JOBS" -n 1 bash -c '
  f=$0; base=${f%.cmd}
  start=$(date +%s)
  bash "$f" > "$base.out" 2>&1; echo $? > "$base.rc"
  echo "$(( $(date +%s) - start ))" > "$base.secs"
'

# A CHECK THAT FAILED IN THE CROWD IS RUN ONCE MORE, ALONE. A few checks
# measure real time (a pacing gap, a read timeout), and a machine running
# every core flat out can sleep past a window that holds on a quiet one: a
# deploy must not hang on that. A real failure fails again and is reported as
# one; a check that passes alone is reported as passed AND named at the end,
# so one that keeps needing the second go is seen and made deterministic.
RETRIED=""
for f in "$PLAN"/*.rc; do
  [ -f "$f" ] || continue
  [ "$(cat "$f")" = "0" ] && continue
  base=${f%.rc}
  if bash "$base.cmd" > "$base.again" 2>&1; then
    mv "$base.again" "$base.out"
    echo 0 > "$f"
    RETRIED="$RETRIED
  $(bash -c "set -- $(cat "$base.cmd"); echo \"\$*\"")"
  fi
done

# ---- the report: every check's output, in the order written above ------------
FAILED=""
SKIPPED=""
for f in $(find "$PLAN" -name '*.head' -o -name '*.cmd' -o -name '*.skip' | sort); do
  case "$f" in
    *.head) cat "$f" ;;
    *.skip)
      echo "SKIP: $(cat "$f")"
      SKIPPED="$SKIPPED
  $(cat "$f")"
      ;;
    *.cmd)
      base=${f%.cmd}
      cat "$base.out"
      if [ "$(cat "$base.rc" 2>/dev/null)" != "0" ]; then
        # the command as it is written above, not as the plan quoted it
        cmd=$(bash -c "set -- $(cat "$f"); echo \"\$*\"")
        echo "FAIL: $cmd" >&2
        FAILED="$FAILED
  $cmd"
      fi
      ;;
  esac
done

# remember how long each took, for the next run's order
if [ -z "$ONLY" ] && mkdir -p "$(dirname "$TIMES")" 2>/dev/null; then
  for f in "$PLAN"/*.secs; do
    [ -f "$f" ] && printf '%s\t%s\n' "$(cat "$f")" "$(cat "${f%.secs}.cmd")"
  done > "$TIMES"
fi

# what the wait was for: the run is as long as its slowest checks
echo
echo "slowest:"
for f in "$PLAN"/*.secs; do
  [ -f "$f" ] || continue
  cmd=$(bash -c "set -- $(cat "${f%.secs}.cmd"); echo \"\$*\"")
  printf '%4ss  %s\n' "$(cat "$f")" "$cmd"
done | sort -rn | head -5

echo
if [ -n "$RETRIED" ]; then
  echo "FAILED WITH EVERY CORE BUSY, PASSED ALONE (timing? make it deterministic):$RETRIED"
  echo
fi
if [ -n "$SKIPPED" ]; then
  echo "SKIPPED (what each needs is not on this machine):$SKIPPED"
  echo
fi
if [ -z "$ONLY" ] && [ -n "$MISSING" ]; then
  echo "NOT RUN (add each to tools/check.sh):$MISSING"
fi
if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED"
  exit 1
fi
if [ -z "$ONLY" ] && [ -n "$MISSING" ]; then exit 1; fi
echo "all checks passed"
