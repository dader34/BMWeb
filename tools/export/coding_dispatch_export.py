#!/usr/bin/env python3
"""Ship the derived coding dispatchers the runtime executes.

For every codable control unit BMW's SGFAM lists, this writes the runnable
form of its A_<cabd> dispatcher to data/coding-dispatch/<sgbd>.json, keyed by
the CODING SGBD name (the CABD, e.g. c_kmb46) -- which is the name the write
path holds once the car's variant is resolved. The file is the same
{procs, byid, coding:true} shape ipo_exec.py --coding emits, plus dataOrg from
the CABD's SPEICHERORG so the runtime frames the wire packet at the module's
real word width.

    python3 tools/export/coding_dispatch_export.py            # all chassis
    python3 tools/export/coding_dispatch_export.py E46 E90    # just these

The mapping, all from BMW's own tables:
  SGFAM  SG -> {asw, cabd}   asw IS the dispatcher IPO name (A_AKMB46), cabd
                             the coding descriptor (C_KMB46).
  dispatcher = asw.IPO under NCSEXPER/SGDAT (INPA ships the twin under
               EC-APPS/INPA/SGDAT, which is what the decompiler reads).
  dataOrg    = ncs_daten.speicherorg(<cabd>.C0x).

A dispatcher with no shippable pool or no cabimain/Cod is skipped (logged).
Read-only: decompiles files, writes JSON. No car is touched.
"""
import os
import sys
import json
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, os.path.join(HERE, "..", "decompile"))
sys.path.insert(0, HERE)
import ncs_tables as NT                                          # noqa: E402
import ncs_daten as ND                                          # noqa: E402
import ipo_exec as EX                                           # noqa: E402
import ipo_coding_dispatch as CD                                # noqa: E402
import ipo_screens as L1                                        # noqa: E402

OUT = os.path.join(ROOT, "data", "coding-dispatch")
DATEN = os.path.join(ROOT, "vendor", "EC-APPS", "NCSEXPER", "DATEN")


def dispatcher_exists(asw):
    """asw is the dispatcher IPO name; true if the decompiler can load it."""
    for ext in (".IPO", ".ipo"):
        if os.path.exists(os.path.join(L1.SGDAT, asw + ext)):
            return True
    return False


def cabd_c0x(cabd):
    """The CABD's .C0x descriptor path, or None. The .C0x file name is not the
    CABD name -- C_KMB46's descriptor is KMB_E46.C0x -- so try the common
    manglings BMW uses (strip the C_ prefix, add the chassis suffix)."""
    base = cabd[2:] if cabd.upper().startswith("C_") else cabd
    cands = [cabd, base, base + "_E46", base.rstrip("0123456789"),
             base.rstrip("0123456789") + "_E46"]
    for c in dict.fromkeys(cands):
        g = sorted(glob.glob(os.path.join(DATEN, "*", f"{c}.C0*")))
        if g:
            return g[0]
    return None


def data_org(cabd):
    p = cabd_c0x(cabd)
    if not p:
        return None
    try:
        return ND.speicherorg(open(p, "rb").read())
    except OSError:
        return None


def build_one(asw, cabd):
    """The shippable program for one dispatcher, or None if it has no runnable
    coding body."""
    prog = EX.export(asw, coding=True)
    if not prog.get("coding") or "cabimain" not in prog["procs"] \
            or "Cod" not in prog["procs"]:
        return None
    org = data_org(cabd)
    if org:
        prog["dataOrg"] = org
    # the file is keyed by the CABD name the write path uses; record it
    prog["cabd"] = cabd
    return prog


def codable_units(chassis):
    """[(sg, asw, cabd)] for the chassis's SGFAM rows that have a dispatcher."""
    corpus = NT.corpus()
    if chassis not in corpus or "sgfam" not in corpus[chassis]:
        return []
    sgfam = NT.parse_sgfam(corpus[chassis]["sgfam"])
    out = []
    for sg, info in sgfam.items():
        asw, cabd = info.get("asw"), info.get("cabd")
        if asw and cabd and dispatcher_exists(asw):
            out.append((sg, asw, cabd))
    return out


def main(argv):
    chassis = argv or sorted(NT.corpus().keys())
    os.makedirs(OUT, exist_ok=True)
    written = {}      # cabd(lower) -> asw, so we build each CABD once
    skipped = []
    for ch in chassis:
        for sg, asw, cabd in codable_units(ch):
            key = cabd.lower()
            if key in written:
                continue
            try:
                prog = build_one(asw, cabd)
            except Exception as e:                       # noqa: BLE001
                skipped.append((cabd, f"{type(e).__name__}: {e}"))
                continue
            if prog is None:
                skipped.append((cabd, "no cabimain/Cod"))
                continue
            path = os.path.join(OUT, f"{key}.json")
            with open(path, "w") as f:
                json.dump(prog, f)
            written[key] = (asw, prog.get("dataOrg"))
    # a manifest so the renderer can tell "not built" from "not codable"
    manifest = sorted(written.keys())
    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump(manifest, f)
    print(f"wrote {len(written)} coding dispatchers to data/coding-dispatch/")
    for key, (asw, org) in sorted(written.items()):
        print(f"  {key:14} <- {asw:12} dataOrg={org}")
    if skipped:
        print(f"skipped {len(skipped)}:")
        for cabd, why in skipped[:20]:
            print(f"  {cabd:14} {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main([a for a in sys.argv[1:] if not a.startswith("--")]))
