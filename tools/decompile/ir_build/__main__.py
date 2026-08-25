"""Write the execution-derived IR for the corpus, or dump one ECU.

    python3 -m ir_build --write            # whole corpus -> data/inpa-ir/
    python3 -m ir_build --write zke5 KOMBI # just these
    python3 -m ir_build zke5               # dump one ECU's IR to stdout

Each ECU's IR is written to data/inpa-ir/<ECU>.json (and its .gz twin, kept in
step so the web export never ships a stale copy). i18n runs AFTER this to
resolve captions -- see check.sh.
"""

import glob
import gzip
import json
import os
import sys

R = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
sys.path[:0] = [os.path.join(R, "tools", "decompile")]

from ir_build import build_ir, vmpool                          # noqa: E402
from ir_build.stamp import write_stamp                         # noqa: E402

sys.path[:0] = [os.path.join(R, "tools", "export")]
import ipo_exec                                                 # noqa: E402

IR_DIR = os.path.join(R, "data", "inpa-ir")


def _corpus_stems():
    """Every SGDAT .IPO stem, deduped case-insensitively (the tree mixes
    .IPO and .ipo, and a case-sensitive glob would see only one spelling)."""
    sgdat = os.path.join(R, "vendor", "EC-APPS", "INPA", "SGDAT")
    seen, stems = set(), []
    for path in sorted(glob.glob(os.path.join(sgdat, "*.IPO"))
                       + glob.glob(os.path.join(sgdat, "*.ipo"))):
        stem = os.path.basename(path)[:-4]
        if stem.lower() not in seen:
            seen.add(stem.lower())
            stems.append(stem)
    return stems


def _write_one(ecu):
    """Build and write one ECU's IR; return (screens, menus) or None."""
    ir = build_ir(ecu)
    if ir is None:
        return None
    blob = json.dumps(ir, ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")
    path = os.path.join(IR_DIR, ecu + ".json")
    with open(path, "wb") as f:
        f.write(blob)
    gz = path + ".gz"
    if os.path.exists(gz):
        with gzip.open(gz, "wb", compresslevel=6) as f:
            f.write(blob)

    # The runnable twin of the frozen IR: the same decoded token tape ipovm.js
    # executes live. build_ir just built (and vmpool cached) this ECU's VM, so
    # prototype() hands back that SAME decoded VM for free rather than
    # re-disassembling the whole file -- ipo_exec.export reuses it. Shipped
    # gzipped because, like job-code.json, it is large and read by the machine,
    # never by eye.
    dump = ipo_exec.export(ecu, vm=vmpool.prototype(ecu))
    xblob = json.dumps(dump, ensure_ascii=False,
                       separators=(",", ":")).encode("utf-8")
    with gzip.open(os.path.join(IR_DIR, ecu + ".ipoexec.json.gz"),
                   "wb", compresslevel=6) as f:
        f.write(xblob)

    return len(ir.get("screens") or {}), len(ir.get("menus") or {})


def _write(only):
    os.makedirs(IR_DIR, exist_ok=True)
    stems = [s for s in _corpus_stems()
             if not only or s.lower() in only]
    n_ecu = n_scr = 0
    for stem in stems:
        res = _write_one(stem)
        if res is None:
            continue
        n_ecu += 1
        n_scr += res[0]
    write_stamp()
    print(f"ir_build: wrote {n_ecu} ECUs, {n_scr} screens -> {IR_DIR}")
    return 0


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("-")]
    if "--check" in argv:
        from ir_build.checks import run
        return 1 if run() else 0
    if "--write" in argv:
        return _write({a.lower() for a in args})
    if args:
        print(json.dumps(build_ir(args[0]), indent=1, ensure_ascii=False))
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
