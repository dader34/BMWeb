"""Decode an .IPO once, clone a fresh VM per run.

Building the IR runs a menu many times (once per variant candidate) and every
screen twice (ok + fail host). Constructing V.VM(ecu) each time re-disassembles
the whole file -- KLIMA_5B's explore did that ~440 times and hung. The decode
is immutable, so it is loaded once into a prototype and each run clones the
prototype with only the mutable per-run state reset.
"""

import ipo_vm as V

_PROTO = {}          # ecu -> a decoded prototype VM


def prototype(ecu, budget=20000):
    """The decoded, immutable VM for `ecu`. Cached across the whole build."""
    vm = _PROTO.get(ecu)
    if vm is None:
        vm = V.VM(ecu, budget=budget)
        _PROTO[ecu] = vm
    return vm


def fresh(proto, host=None, base=None, budget=20000):
    """A VM sharing proto's decode with clean per-run state.

    `host` answers the car's questions (see hosts.py); `base` seeds the state
    inpainit leaves behind (globals/files/arrays) so a screen derives from the
    same start INPA gives it.
    """
    vm = V.VM.__new__(V.VM)
    vm.__dict__.update(proto.__dict__)
    vm.globals = dict(base["globals"]) if base else {}
    vm.out = V.Emissions()
    vm.entered = set()
    vm.binds = {}
    vm.files = {k: list(v) for k, v in base["files"].items()} if base else {}
    vm.fh = None
    vm.strArrays = {k: dict(v) for k, v in base["arrays"].items()} if base \
        else {}
    vm._arrN = base["arrN"] if base else 0
    vm.steps = 0
    vm.budget = budget
    vm.host = host or V.Host()
    return vm


def init_state(proto, host, budget=20000):
    """The state inpainit leaves behind -- INPA runs it before any screen.

    LSZ's lamp screens read their state words from a string array inpainit
    builds; deriving a screen without it looks up an empty table. Each screen
    is derived from a CLONE of this so one screen's stores cannot leak forward.
    """
    vm = fresh(proto, host, budget=budget)
    if "inpainit" in vm.procs:
        try:
            vm.run("inpainit")
        except Exception:                                      # noqa: BLE001
            pass
    return {
        "globals": dict(vm.globals),
        "files": {k: list(v) for k, v in vm.files.items()},
        "arrays": {k: dict(v) for k, v in vm.strArrays.items()},
        "arrN": vm._arrN,
    }
