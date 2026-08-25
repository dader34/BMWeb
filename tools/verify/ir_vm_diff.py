#!/usr/bin/env python3
"""Where does EXECUTING an .IPO disagree with INFERRING its IR?

ipo_ir.py reconstructs a script's menus by reading its token stream and
applying inference rules. ipo_vm.py runs the script and records what it
emits. Both claim to describe the same program, so every disagreement is a
bug in one of them -- and which one is a question the bytecode settles.

This is the evidence for migrating from the first to the second. It is not a
pass/fail test: early on the VM will be missing builtins and the inference
will be right more often. What matters is the SHAPE of the disagreement --
which fields drift, on how many ECUs, and in whose favour.

    python3 tools/verify/ir_vm_diff.py sm46          # one ECU, verbose
    python3 tools/verify/ir_vm_diff.py --corpus      # every ECU, summary
    python3 tools/verify/ir_vm_diff.py --corpus --field job

Menus only, for now. Screens execute but their line model needs the same
treatment before a comparison would mean anything.
"""

import json
import os
import sys
import time
from collections import Counter

R = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
sys.path[:0] = [os.path.join(R, "tools", "decompile")]
import ipo_disasm as D                                          # noqa: E402
import ipo_vm as V                                              # noqa: E402

IR_DIR = os.path.join(R, "data", "inpa-ir")

# what a menu item claims, and which of those the VM currently models
FIELDS = ("label", "job", "jobArg", "menu", "screen", "action", "appTool")


_VM_CACHE = {}


def _fresh(ecu, budget=20000):
    """A VM for `ecu` with clean state but a SHARED decode.

    Loading an .IPO disassembles every proc, which for MEVD17KW is 0.16s --
    and it has 105 menus. Building a VM per menu re-did that 105 times and
    made one ECU take 20s; 84% of the corpus run was re-disassembling files
    it had already read. The decode is immutable, so it is cached and only
    the mutable state (globals, emissions, step count) is reset.
    """
    proto = _VM_CACHE.get(ecu)
    if proto is None:
        proto = V.VM(ecu, budget=budget)
        _VM_CACHE[ecu] = proto
    vm = V.VM.__new__(V.VM)
    vm.__dict__.update(proto.__dict__)
    vm.globals = {}
    vm.out = V.Emissions()
    vm.entered = set()
    # binds is per-RUN state like the rest: sharing it across screens let
    # one screen's JOB_STATUS binding leak into every later screen of the
    # same ECU, which is why ACC_E65 reported 797 copies of it per page.
    vm.binds = {}
    vm.steps = 0
    vm.budget = budget
    return vm


def vm_menu(ecu, name, variant=None, calls=None, budget=20000,
             presence=True):
    """Run one menu and return {nr: item}, or None if it would not run."""
    try:
        vm = _fresh(ecu, budget)
    except Exception:                                           # noqa: BLE001
        return None
    # ASSUME EVERYTHING IS FITTED. A menu's items are frequently guarded by
    # module-presence flags (ACC2's GroupCheck probes its siblings and sets
    # global219/220/221), and those are a property of the CAR, not the file.
    # Starting them empty makes every guarded item vanish -- which is what
    # the whole `screen differ=6,909` column turned out to be. Binding them
    # true enumerates the maximal menu, which is what an offline IR should
    # describe; a live run overwrites them with what the car actually says.
    if presence:
        # Globals run well past 255 -- mevd172 gates a menu item on g355 --
        # so the preset covers the range the file actually stores into
        # rather than a round number.
        for g in range(vm._maxglobal + 1):
            vm.globals.setdefault(g, True)
    if variant is not None:
        # the global the dispatch tests; bound so a per-variant arm is taken
        slot = _variant_slot(vm)
        if slot is not None:
            vm.globals[slot] = variant
    try:
        out = vm.run(name)
    except Exception:                                           # noqa: BLE001
        return None
    if calls is not None:
        for c in out.calls:
            if c not in V._BUILTINS:
                calls[c] += 1
    items = {}
    for it in out.items:
        nr = it.get("nr")
        if nr is None:
            continue
        # a later emission for the same key refines the earlier one
        items.setdefault(nr, {}).update({k: v for k, v in it.items()
                                         if v is not None})
    return items


def _variant_slot(vm):
    """The global INPAapiJob's results are compared against (see ipo_ir)."""
    for name in ("inpainit", "__inpa_startup__"):
        toks = vm.procs.get(name) or []
        dest = None
        for i, t in enumerate(toks):
            if t["op"] == "call" and t.get("name") in (
                    "INP1apiResultText", "INPAapiResultText"):
                seg = D.frame_of(toks, i)
                strs = [x["v"] for x in seg
                        if x["op"] == "const" and x.get("t") == "s"]
                if "VARIANTE" in strs:
                    refs = [x for x in seg if x["op"] == "procref"]
                    if refs:
                        dest = refs[-1]["n"]
            elif dest is not None and t["op"] == "store" \
                    and t.get("sc") == 0:
                prev = toks[max(0, i - 3):i]
                if any(x["op"] == "var" and x.get("sc") == 2
                       and x["n"] == dest for x in prev):
                    return t["n"]
    return None


SCREEN_FIELDS = ("keys", "gauges", "lamps", "texts")


def vm_screen(ecu, name, budget=20000):
    """Run one screen and summarise what it drew, or None if it would not run."""
    try:
        vm = _fresh(ecu, budget)
        out = vm.run(name)
    except Exception:                                           # noqa: BLE001
        return None
    els = [e for ln in out.lines for e in (ln.get("elements") or [])]
    return {
        "keys": [e["key"] for e in els if e.get("key")],
        "gauges": sum(1 for e in els if e.get("t") == "gauge"),
        "lamps": sum(1 for e in els if e.get("t") == "lamp"),
        "texts": sum(1 for e in els if e.get("t") == "text"),
    }


def ir_screen(scr):
    els = [e for ln in (scr.get("lines") or []) for e in (ln.get("elements") or [])]
    return {
        "keys": [e["key"] for e in els if e.get("key")],
        "gauges": sum(1 for e in els if e.get("t") == "gauge"),
        "lamps": sum(1 for e in els if e.get("t") == "lamp"),
        "texts": sum(1 for e in els if e.get("t") == "text"),
    }


def compare_screens(ecu):
    """Counter of verdicts over one ECU's screens."""
    path = os.path.join(IR_DIR, ecu + ".json")
    if not os.path.exists(path):
        return None
    try:
        ir = json.load(open(path, encoding="utf-8"))
    except Exception:                                           # noqa: BLE001
        return None
    t = Counter()
    for name, scr in (ir.get("screens") or {}).items():
        got = vm_screen(ecu, name)
        if got is None:
            t["vm-cannot-run"] += 1
            continue
        want = ir_screen(scr)
        t["screens"] += 1
        if want["keys"] == got["keys"]:
            t["keys-exact"] += 1
        elif set(want["keys"]) == set(got["keys"]):
            t["keys-same-set"] += 1
        elif set(want["keys"]) <= set(got["keys"]):
            t["vm-superset"] += 1
        elif set(got["keys"]) <= set(want["keys"]):
            t["vm-subset"] += 1
        else:
            t["keys-differ"] += 1
        # COVERAGE, MEASURED ON THE SET. Exact-order agreement scores the VM
        # against a reference that repeats 14.6% of its own keys -- the static
        # miner walked loop bodies it never executed, so s63tu's
        # s_msa2_hist_no_stop lists each row's caption/value pair twice. A key
        # the VM found is the thing worth counting, once.
        iw, gw = set(want["keys"]), set(got["keys"])
        if iw or gw:
            t["covered"] += len(iw & gw)
            t["ir-only"] += len(iw - gw)
            t["vm-only"] += len(gw - iw)
        t["ir-keys"] += len(want["keys"])
        t["vm-keys"] += len(got["keys"])
        t["ir-uniq"] += len(iw)
        t["vm-uniq"] += len(gw)
        for f in ("gauges", "lamps"):
            if want[f] == got[f]:
                t[f + "-same"] += 1
            else:
                t[f + "-differ"] += 1
    return t


def compare(ecu, verbose=False, want_calls=False):
    """{field: Counter(verdict)}, examples, and unmodelled builtins."""
    path = os.path.join(IR_DIR, ecu + ".json")
    if not os.path.exists(path):
        return (None, [], Counter()) if want_calls else (None, [])
    try:
        ir = json.load(open(path, encoding="utf-8"))
    except Exception:                                           # noqa: BLE001
        return (None, [], Counter()) if want_calls else (None, [])
    tally = {f: Counter() for f in FIELDS}
    tally["_item"] = Counter()
    examples = []
    unmodelled = Counter()
    for mname, menu in (ir.get("menus") or {}).items():
        got = vm_menu(ecu, mname, calls=unmodelled if want_calls else None)
        if got is None:
            tally["_item"]["vm-cannot-run"] += 1
            continue
        want = {i.get("nr"): i for i in (menu.get("items") or [])}
        for nr in sorted(set(want) | set(got)):
            a, b = want.get(nr), got.get(nr)
            if a is None:
                tally["_item"]["vm-only"] += 1
                if verbose and len(examples) < 40:
                    examples.append((mname, nr, "vm-only", None, b.get("label")))
                continue
            if b is None:
                tally["_item"]["ir-only"] += 1
                if verbose and len(examples) < 40:
                    examples.append((mname, nr, "ir-only", a.get("label"), None))
                continue
            tally["_item"]["both"] += 1
            for f in FIELDS:
                x, y = a.get(f), b.get(f)
                if x == y:
                    tally[f]["same"] += 1
                elif y is None:
                    tally[f]["vm-missing"] += 1
                    if verbose and len(examples) < 40:
                        examples.append((mname, nr, f + ":vm-missing", x, y))
                elif x is None:
                    tally[f]["vm-extra"] += 1
                    if verbose and len(examples) < 40:
                        examples.append((mname, nr, f + ":vm-extra", x, y))
                else:
                    tally[f]["differ"] += 1
                    if verbose and len(examples) < 40:
                        examples.append((mname, nr, f + ":differ", x, y))
    return (tally, examples, unmodelled) if want_calls \
        else (tally, examples)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    verbose = not ("--corpus" in sys.argv)
    only = None
    if "--field" in sys.argv:
        only = sys.argv[sys.argv.index("--field") + 1]

    if "--screens" in sys.argv:
        names = sorted(f[:-5] for f in os.listdir(IR_DIR)
                       if f.endswith(".json"))
        tot = Counter()
        t0 = time.time()
        for n, ecu in enumerate(names, 1):
            t = compare_screens(ecu)
            if t:
                tot.update(t)
            if n % 100 == 0:
                el = time.time() - t0
                print(f"  [{n:4}/{len(names)}] {el:5.0f}s, "
                      f"~{el / n * (len(names) - n):4.0f}s left", flush=True)
        sc = tot["screens"] or 1
        print(f"\n{tot['screens']} screens compared "
              f"({tot['vm-cannot-run']} the VM could not run)\n")
        print(f"  keys exact order   {tot['keys-exact']:6}  "
              f"({100 * tot['keys-exact'] / sc:5.1f}%)")
        print(f"  keys same set      {tot['keys-same-set']:6}")
        print(f"  vm found MORE      {tot['vm-superset']:6}")
        print(f"  vm found FEWER     {tot['vm-subset']:6}")
        print(f"  keys disjoint      {tot['keys-differ']:6}")
        print(f"\n  total keys  IR={tot['ir-keys']}  VM={tot['vm-keys']}")
        print(f"  unique keys IR={tot['ir-uniq']}  VM={tot['vm-uniq']}")
        both = tot["covered"] + tot["ir-only"]
        if both:
            print(f"  of the IR's unique keys the VM also found "
                  f"{tot['covered']} ({100 * tot['covered'] / both:.1f}%); "
                  f"missed {tot['ir-only']}; found {tot['vm-only']} more")
        print(f"  gauges same={tot['gauges-same']} differ={tot['gauges-differ']}")
        print(f"  lamps  same={tot['lamps-same']} differ={tot['lamps-differ']}")
        return 0

    if "--corpus" in sys.argv:
        names = sorted(f[:-5] for f in os.listdir(IR_DIR)
                       if f.endswith(".json"))
        total = {f: Counter() for f in list(FIELDS) + ["_item"]}
        unhandled = Counter()
        ran = 0
        slow = []
        t0 = time.time()
        # STREAM, DO NOT BATCH. 1,124 ECUs at ~0.2s each is fine, but the
        # modern DME scripts run 10-20s apiece (many state procs, each
        # burning the step budget before it parks), and a run that prints
        # only at the end is indistinguishable from a hung one.
        # scratch output, not a build artifact: keep it out of the repo
        dest = os.environ.get("IR_VM_DIFF_OUT") or os.path.join(
            os.environ.get("TMPDIR", "/tmp"), "ir_vm_diff.jsonl")
        out = open(dest, "w", encoding="utf-8")
        for n, ecu in enumerate(names, 1):
            s0 = time.time()
            t, _, u = compare(ecu, want_calls=True)
            dt = time.time() - s0
            if not t:
                continue
            ran += 1
            unhandled.update(u)
            for f, c in t.items():
                total[f].update(c)
            if dt > 5:
                slow.append((round(dt, 1), ecu))
            rec = {"ecu": ecu, "secs": round(dt, 2),
                   "items": dict(t["_item"]),
                   "fields": {f: dict(t[f]) for f in FIELDS if t[f]}}
            out.write(json.dumps(rec) + "\n")
            out.flush()
            if n % 25 == 0 or dt > 5:
                el = time.time() - t0
                rate = el / n
                print(f"  [{n:4}/{len(names)}] {el:5.0f}s elapsed, "
                      f"~{rate * (len(names) - n):4.0f}s left"
                      f"{'  SLOW ' + ecu + f' {dt:.0f}s' if dt > 5 else ''}",
                      flush=True)
        out.close()
        print(f"\n{ran} ECUs compared in {time.time() - t0:.0f}s "
              f"(per-ECU detail in {dest})\n")
        if slow:
            slow.sort(reverse=True)
            print("slowest:", ", ".join(f"{e} {d}s" for d, e in slow[:6]), "\n")
        if unhandled:
            tot = sum(unhandled.values())
            print(f"BUILTINS the VM does not model: {len(unhandled)} distinct, "
                  f"{tot} calls")
            for k, v in unhandled.most_common(12):
                print(f"  {v:7}  {k}")
            print()
        it = total["_item"]
        print(f"ITEMS  both={it['both']}  ir-only={it['ir-only']}  "
              f"vm-only={it['vm-only']}  menus-vm-cannot-run="
              f"{it['vm-cannot-run']}\n")
        print(f"{'field':10} {'same':>8} {'differ':>8} {'vm-missing':>11} "
              f"{'vm-extra':>9}")
        for f in FIELDS:
            if only and f != only:
                continue
            c = total[f]
            print(f"{f:10} {c['same']:8} {c['differ']:8} "
                  f"{c['vm-missing']:11} {c['vm-extra']:9}")
        return 0

    if not args:
        print(__doc__)
        return 0
    ecu = args[0]
    t, ex = compare(ecu, verbose=verbose)
    if not t:
        print(f"{ecu}: no IR to compare against")
        return 1
    it = t["_item"]
    print(f"{ecu}: both={it['both']} ir-only={it['ir-only']} "
          f"vm-only={it['vm-only']} cannot-run={it['vm-cannot-run']}")
    for f in FIELDS:
        c = t[f]
        if c["differ"] or c["vm-missing"] or c["vm-extra"]:
            print(f"  {f:9} same={c['same']:4} differ={c['differ']:3} "
                  f"vm-missing={c['vm-missing']:3} vm-extra={c['vm-extra']:3}")
    if ex:
        print("\nexamples:")
        for m, nr, what, x, y in ex[:25]:
            print(f"  {m} F{nr} {what}\n      ir={x!r}\n      vm={y!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
