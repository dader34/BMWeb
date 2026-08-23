#!/usr/bin/env python3
"""Derive EXECUTED screens into the shipped IR.

The static miner reads a screen's token stream and infers what it would draw;
the VM runs it and records what it drew. This stage runs every screen through
the VM at build time and ships the result as `vmScreens` alongside the mined
`screens` in data/inpa-ir/<ECU>.json -- derivation before shipping, so the
app never touches raw .IPO bytes. The renderer swaps a screen for its
executed twin only behind the interpreted-screens flag.

Each screen is run TWICE:

  once against the OK host      -> the lines it draws when jobs succeed,
                                   the jobs it ran, the dialogs it shows
  once against a FAILING host   -> the dialogs of the error arm

The difference between the two message lists is `errorMessages`: the boxes
INPA pops when a job fails ("Fehler beim Lesen von Job: ..."), which the
static miner never captured because it never took the branch. The app shows
them when a live job actually fails, which is the faithful behaviour.

    python3 tools/decompile/ipo_vm_ir.py --write          # whole corpus
    python3 tools/decompile/ipo_vm_ir.py --write zke5 KOMBI
"""

import glob
import gzip
import json
import os
import sys

R = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path[:0] = [os.path.join(R, "tools", "decompile")]
import ipo_vm as V                                              # noqa: E402
from ipo_ir import _is_write                                    # noqa: E402

IR_DIR = os.path.join(R, "data", "inpa-ir")


class _FailHost(V.Host):
    """Every job fails. Whatever the screen does now is its error arm."""

    def status(self):
        return "ERROR_ECU_NICHT_VORHANDEN"


def _fresh(proto, host, base=None):
    vm = V.VM.__new__(V.VM)
    vm.__dict__.update(proto.__dict__)
    vm.globals = dict(base["globals"]) if base else {}
    vm.out = V.Emissions()
    vm.entered = set()
    vm.binds = {}
    vm.files = ({k: list(v) for k, v in base["files"].items()}
                if base else {})
    vm.fh = None
    vm.strArrays = ({k: dict(v) for k, v in base["arrays"].items()}
                    if base else {})
    vm._arrN = base["arrN"] if base else 0
    vm.steps = 0
    vm.host = host
    return vm


def _init_state(proto, host):
    """The state inpainit leaves behind -- INPA runs it before any screen.

    LSZ's lamp screens read their state words from a string array inpainit
    builds; deriving the screen without it looked up an empty table and every
    lamp row vanished. Screens are derived from a CLONE of this state, so one
    screen's stores cannot leak into the next.
    """
    vm = _fresh(proto, host)
    if "inpainit" in vm.procs:
        try:
            vm.run("inpainit")
        except Exception:                                       # noqa: BLE001
            pass
    return {"globals": dict(vm.globals),
            "files": {k: list(v) for k, v in vm.files.items()},
            "arrays": {k: dict(v) for k, v in vm.strArrays.items()},
            "arrN": vm._arrN}


# the renderer's names for what the VM calls warnLo/warnHi: the band INPA
# paints green (irRows reads okMin/okMax)
_RENAME = {"warnLo": "okMin", "warnHi": "okMax"}


def _clean_lines(lines):
    """The VM's lines, in the renderer's vocabulary (caption, not label)."""
    out = []
    for ln in lines:
        els = [{_RENAME.get(k, k): v for k, v in e.items() if v is not None}
               for e in (ln.get("elements") or [])]
        if not els and not ln.get("label"):
            continue
        d = {"elements": els}
        if ln.get("label"):
            d["caption"] = ln["label"]
        out.append(d)
    return out


def _jobs(emissions):
    seen, out = set(), []
    for j in emissions.jobs:
        name = j.get("job")
        if not name:
            continue
        key = (name, j.get("arg") or "")
        if key in seen:
            continue
        seen.add(key)
        d = {"name": name}
        if j.get("arg"):
            d["arg"] = j["arg"]
        if _is_write(name):
            d["write"] = True
        out.append(d)
    return out


def derive(ecu, budget=20000):
    """{screen: vmScreen} for one ECU, or None if the VM cannot load it."""
    try:
        proto = V.VM(ecu, budget=budget)
    except Exception:                                           # noqa: BLE001
        return None
    out = {}
    screens = [n for (o, t, n, p) in proto.decls if t == "screen"]
    base_ok = _init_state(proto, V.Host())
    base_bad = _init_state(proto, _FailHost())
    for name in screens:
        try:
            vm = _fresh(proto, V.Host(), base_ok)
            ok = vm.run(name)
            vm2 = _fresh(proto, _FailHost(), base_bad)
            bad = vm2.run(name)
        except Exception:                                       # noqa: BLE001
            continue
        lines = _clean_lines(ok.lines)
        okmsg = [m for m in ok.messages if m.get("title")]
        seen = {(m.get("title"), m.get("body")) for m in okmsg}
        errmsg = [m for m in bad.messages if m.get("title")
                  and (m.get("title"), m.get("body")) not in seen]
        # most error arms PRINT rather than pop a box ("Fehler beim Lesen von
        # Job: ..." is an ftextout) -- ship the fail-arm's lines when they
        # differ, so a live failure can draw what INPA would have drawn
        errlines = _clean_lines(bad.lines)
        if errlines == lines:
            errlines = None
        if not lines and not okmsg and not errmsg:
            continue                    # nothing executed is nothing to ship
        scr = {"lines": lines, "jobs": _jobs(ok)}
        if ok.title:
            scr["title"] = ok.title
        if okmsg:
            scr["messages"] = okmsg
        if errmsg:
            scr["errorMessages"] = errmsg
        if errlines:
            scr["errorLines"] = errlines
        out[name] = scr
    return out


def main(argv):
    if "--write" not in argv:
        raise SystemExit(__doc__)
    # the tree mixes casings (ZKE5.json, kombi46r.json) and the filesystem
    # hides that -- match names case-insensitively
    only = {a.lower() for a in argv[1:] if not a.startswith("-")}
    paths = sorted(glob.glob(os.path.join(IR_DIR, "*.json")))
    n_ecu = n_scr = n_err = 0
    for p in paths:
        ecu = os.path.basename(p)[:-5]
        if ecu == "_build" or (only and ecu.lower() not in only):
            continue
        try:
            ir = json.load(open(p, encoding="utf-8"))
        except Exception:                                       # noqa: BLE001
            continue
        vs = derive(ecu)
        if vs is None:
            continue
        ir["vmScreens"] = vs
        blob = json.dumps(ir, ensure_ascii=False,
                          separators=(",", ":")).encode("utf-8")
        with open(p, "wb") as f:
            f.write(blob)
        # the .gz twin ships in the web export; writing both here is what
        # keeps them from drifting
        gz = p + ".gz"
        if os.path.exists(gz):
            with gzip.open(gz, "wb", compresslevel=6) as f:
                f.write(blob)
        n_ecu += 1
        n_scr += len(vs)
        n_err += sum(1 for s in vs.values() if s.get("errorMessages"))
    print(f"vmScreens: {n_ecu} ECUs, {n_scr} screens executed, "
          f"{n_err} carry error dialogs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
