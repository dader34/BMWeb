#!/usr/bin/env python3
"""Measure the execution-derived IR against the inpax reference decoder.

inpax IS ground truth. This compares ir_build's screens (keys drawn per
screen) against the reference's per-screen result keys, and reports the gap:
what the VM misses (ref-only, the real defects) and what it emits the
reference does not (vm-only, to audit for over-emission).

    XREF_CMD='node /path/to/inpax decompile {ipo} --no-color --no-raw' \\
        python3 tools/verify/ir_vs_ref.py           # whole corpus
        python3 tools/verify/ir_vs_ref.py LWS5      # one ECU, verbose diff
"""

import glob
import os
import sys

R = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path[:0] = [os.path.join(R, "tools", "decompile"),
                os.path.join(R, "tools", "verify")]
import ipo_disasm as D                                          # noqa: E402
import xref_diff as X                                           # noqa: E402
from ir_build import build_ir                                   # noqa: E402


def _vm_keys(scr):
    keys = set()
    for ln in scr.get("lines", []):
        for e in ln.get("elements", []):
            if e.get("key"):
                keys.add(e["key"])
            if e.get("unit"):        # a value's paired unit is a read key too
                keys.add(e["unit"])
    return keys


# screens whose keys are assembled at runtime (strcat), excluded from static
# comparison by the format spec -- see ipo-bytecode-format notes.
_STRCAT_SCREENS = {"s_svk_lesen", "s_fehlerbehandlung"}


def _classify_miss(key, vk):
    """Why the reference names a key we don't -- artifact, excluded, or real.

    'truncated': the reference key is a prefix of a fuller key we DO emit --
    inpax clips long result names, so a set-diff flags a false miss when our
    key is the more complete one. 'genuine': a key we should have and don't.
    """
    if any(v.startswith(key) and v != key for v in vk):
        return "truncated"
    return "genuine"


def _one(ecu):
    """(both, vm_only, ref_only, genuine, per-screen misses) for one ECU."""
    ref = X.xref_screens(D.L1.ipo_path(ecu))
    vm = build_ir(ecu)
    if not vm:
        return None
    vs = vm.get("screens") or {}
    both = vmo = refo = genuine = 0
    misses = {}
    for name in set(ref) & set(vs):
        rk = set(ref[name]["keys"])
        vk = _vm_keys(vs[name])
        both += len(rk & vk)
        vmo += len(vk - rk)
        miss = rk - vk
        refo += len(miss)
        if name in _STRCAT_SCREENS:            # runtime-built keys, excluded
            continue
        real = [k for k in miss if _classify_miss(k, vk) == "genuine"]
        genuine += len(real)
        if real:
            misses[name] = sorted(real)
    return both, vmo, refo, genuine, misses


def _corpus():
    sgdat = os.path.join(R, "vendor", "EC-APPS", "INPA", "SGDAT")
    stems = sorted({os.path.basename(p)[:-4]
                    for p in glob.glob(os.path.join(sgdat, "*.IPO"))
                    + glob.glob(os.path.join(sgdat, "*.ipo"))})
    both = vmo = refo = genuine = 0
    for i, ecu in enumerate(stems):
        try:
            res = _one(ecu)
        except Exception:                                     # noqa: BLE001
            continue
        if res:
            both += res[0]
            vmo += res[1]
            refo += res[2]
            genuine += res[3]
        if i % 150 == 0:
            print(f"  {i}/{len(stems)}", flush=True)
    artifact = refo - genuine
    covered = both / (both + genuine) * 100 if both + genuine else 100.0
    print(f"\nkeys both={both}  vm-only={vmo}  ref-only(missed)={refo}")
    print(f"  of missed: genuine={genuine}  "
          f"artifact/excluded={artifact} (inpax truncation + strcat)")
    print(f"  meaningful coverage (both / both+genuine) = {covered:.2f}%")
    return 0


def main(argv):
    if not X.XREF_CMD:
        raise SystemExit("set XREF_CMD to the reference decoder command")
    ecu = next((a for a in argv[1:] if not a.startswith("-")), None)
    if not ecu:
        return _corpus()
    res = _one(ecu)
    if not res:
        print(f"{ecu}: no IR")
        return 1
    both, vmo, refo, genuine, misses = res
    print(f"{ecu}: both={both} vm-only={vmo} ref-only={refo} "
          f"(genuine misses={genuine})")
    for name, keys in misses.items():
        print(f"  {name}: missing {keys}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
