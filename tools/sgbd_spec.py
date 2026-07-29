#!/usr/bin/env python3
"""Lift a job's BEST2 bytecode into a declarative spec (the jobs-to-JSON step).

docs/sgbd-to-json.md establishes that ~90% of the jobs the app runs are
declarative-shaped. This extracts that shape: what the job SENDS, how it
VALIDATES the answer, which BYTES become which results, and what SCALE and
UNIT each carries -- as data, so a spec walker can run the job without the
.prg and without a BEST2 interpreter.

SPEC (spec = 1)

    {
      "spec": 1, "sgbd": "ms450ds0", "job": "STATUS_UBATT",
      "archetype": "looped_read",
      "request": { "bytes": ["..."], "argSlots": [] },
      "validate": [ {"kind": "length", ...}, {"kind": "echo", ...} ],
      "statusTable": "JobResult",         // status byte -> JOB_STATUS text
      "results": [
        { "name": "STAT_UBATT_WERT", "type": "real",
          "scale": 3.97116e-4, "offset": 0.0, "unit": "V" }
      ],
      "confidence": "partial"             // never "full" until the harness says so
    }

WHAT THIS DOES NOT DO, deliberately: it does not guess. Every field it cannot
read out of the bytecode is omitted and the spec is marked partial. A spec is
only trustworthy once tools/sgbd_diff.py has run it against the real engine and
found the result sets identical -- that is what promotes it to "verified".

    python3 tools/sgbd_spec.py ms450ds0 STATUS_UBATT       # one job
    python3 tools/sgbd_spec.py ms450ds0 --all              # every job
    python3 tools/sgbd_spec.py ms450ds0 --write            # -> data/job-specs/
"""
import os
import re
import sys
import json
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sgbd_survey as S                                       # noqa: E402

OUT_DIR = os.path.join(HERE, "..", "data", "job-specs")

SPEC_VERSION = 1

# result-writing opcodes -> the EDIABAS result type they produce
ERG_TYPE = {"ergb": "byte", "ergw": "word", "ergd": "dword", "ergi": "int",
            "ergl": "long", "ergr": "real", "ergs": "string", "ergy": "binary",
            "ergc": "char"}

# results that are protocol bookkeeping rather than ECU data
INTERNAL = re.compile(r"^(_TEL_|JOB_|SAETZE|VARIANTE$)")


def _num(s):
    """EDIABAS writes float constants as strings, German decimal comma."""
    try:
        return float(s.replace(",", "."))
    except (ValueError, AttributeError):
        return None


def extract(data, addr, sgbd, job):
    ops = list(S.walk(data, addr))
    arch, feats = S.classify(data, addr)
    spec = {"spec": SPEC_VERSION, "sgbd": sgbd, "job": job,
            "archetype": arch, "confidence": "partial"}
    gaps = []

    # ---- request ---------------------------------------------------------
    # The telegram is assembled into a string register byte by byte
    # (`move S2[#$n], #$val`) before the `etag "_TEL_AUFTRAG"` that publishes
    # it. Constant stores give the fixed template; stores from a register are
    # argument slots the caller fills.
    # `spaste S2[#$n], S1` splices a sub-telegram (an argument block) at n --
    # the same slot mechanism as a register store, so both mark argSlots.
    req, arg_slots = {}, []
    for start, name, args in ops:
        if name == "etag" and any(a.get("s") == "_TEL_AUFTRAG" for a in args):
            break
        if len(args) != 2:
            continue
        dst, src = args
        if dst.get("m") != 9:            # not reg[#imm]
            continue
        idx = dst.get("i")
        if name == "spaste":
            arg_slots.append(idx)
        elif name == "move":
            if "v" in src:
                req[idx] = src["v"]
            elif "r" in src:
                arg_slots.append(idx)
    if req:
        top = max(req) + 1
        spec["request"] = {
            "bytes": [req.get(i) for i in range(top)],
            "argSlots": sorted(set(arg_slots)),
        }
        if any(b is None for b in spec["request"]["bytes"]):
            gaps.append("request has unresolved byte positions")
    else:
        gaps.append("request template not recovered")

    # ---- validation + status table --------------------------------------
    checks = []
    for _, name, args in ops:
        if name != "ergs":
            continue
        lit = [a["s"] for a in args if "s" in a]
        if len(lit) >= 2 and lit[0] == "JOB_STATUS" and lit[1].startswith("ERROR_"):
            checks.append(lit[1])
    if checks:
        spec["validate"] = sorted(set(checks))
    tabs = [a["s"] for _, n, args in ops if n in ("tabset", "tabsetex")
            for a in args if "s" in a]
    if tabs:
        spec["statusTable"] = tabs[0]
        if len(set(tabs)) > 1:
            spec["tables"] = sorted(set(tabs))

    # ---- results ---------------------------------------------------------
    # Walk in order: a float constant loaded via a2flt is the pending scale,
    # an fmul/fadd consumes it, and the next erg* names the result. Units are
    # a literal `ergs "<NAME>_EINH", "V"` near their value.
    # A unit is written either inline (`ergs "X_EINH", "V"`) or -- more often --
    # staged through a register first (`move S1, "V"` then `ergs "X_EINH", S1`),
    # so track the last string literal moved into each register.
    results, pending_scale, pending_off = [], None, None
    units, reg_str = {}, {}
    for _, name, args in ops:
        strs = [a["s"] for a in args if "s" in a]
        if name == "move" and strs and len(args) == 2 and "r" in args[0]:
            reg_str[args[0]["r"]] = strs[-1]
        if name == "move" and strs:
            v = _num(strs[-1])
            if v is not None:
                pending_scale = v          # candidate; confirmed by fmul below
        elif name == "fmul" and pending_scale is not None:
            pending_off = pending_off or 0.0
        elif name == "fadd" and pending_scale is not None:
            pending_off = pending_scale
        elif name == "etag" and strs:
            # `etag #$c, "NAME"` gates a conditional result block: EDIABAS
            # asks "did the caller request NAME?" and the body that follows
            # computes it only if so. RDC's STATUS_IO produces STAT_FOLGAUS
            # exclusively through this path -- no erg* names it -- so a spec
            # built from erg* alone silently drops it.
            nm = strs[0]
            if not INTERNAL.match(nm) and nm not in {r["name"]
                                                     for r in results}:
                results.append({"name": nm, "conditional": True})
        elif name in ERG_TYPE:
            if not strs:
                continue
            nm = strs[0]
            if INTERNAL.match(nm):
                continue
            # an erg* store is authoritative over the etag placeholder
            for i, r in enumerate(results):
                if r["name"] == nm and r.get("conditional") and "type" not in r:
                    results.pop(i)
                    break
            if name == "ergs" and nm.endswith("_EINH"):
                val = strs[1] if len(strs) >= 2 else (
                    reg_str.get(args[1]["r"]) if len(args) > 1
                    and "r" in args[1] else None)
                if val:
                    units[nm[:-5]] = val   # STAT_X_EINH "V" -> unit of STAT_X
                # ...and the unit is ALSO a result in its own right: the engine
                # emits STAT_UBATT_EINH alongside STAT_UBATT_WERT, so a spec
                # that folded it into a `unit` field would produce a result set
                # the engine's consumers do not see. Emit both -- the spec's job
                # is to reproduce the engine's output, not to improve on it.
                results.append({"name": nm, "type": "string",
                                **({"const": val} if val else {})})
                continue
            r = {"name": nm, "type": ERG_TYPE[name]}
            if name == "ergr" and pending_scale is not None:
                r["scale"] = pending_scale
                if pending_off:
                    r["offset"] = pending_off
            results.append(r)
            pending_scale = pending_off = None
    # attach units to their value results (STAT_UBATT_WERT <- STAT_UBATT_EINH)
    for r in results:
        stem = r["name"][:-5] if r["name"].endswith("_WERT") else r["name"]
        for k, u in units.items():
            if k == stem or k == r["name"]:
                r["unit"] = u
                break
    if results:
        spec["results"] = results
    else:
        gaps.append("no ECU results recovered")

    if arch == "computed":
        gaps.append("archetype needs hand-written handler")
    if arch == "looped_read":
        spec["repeat"] = {"note": "result loop; iteration bounds not yet lifted"}
        gaps.append("loop bounds not lifted")
    if feats["par"]:
        spec["takesArguments"] = feats["par"]

    # A result the bytecode STORES but no etag ever gates, when the job gates
    # others, is dead: EDIABAS only hands back results the caller asked for by
    # the gated name. EKP_DS2's STATUS_MESSWERTE gates STAT_TEMP_UEBER_*_WERT
    # and then stores to STAT_UEBER_TEMP_*_WERT -- BMW transposed the words, so
    # those two values never reach anyone. Flagged rather than corrected: the
    # spec's job is to reproduce the engine, bug for bug.
    gated = {r["name"] for r in results if r.get("conditional")}
    if gated:
        for r in results:
            if r["name"] not in gated and "type" in r \
                    and not r["name"].endswith("_EINH"):
                near = [g for g in gated
                        if sorted(g.split("_")) == sorted(r["name"].split("_"))]
                if near:
                    r["deadStore"] = near[0]
                    gaps.append(f"{r['name']} is stored but gated as {near[0]}"
                                " (SGBD bug: never returned)")

    if gaps:
        spec["gaps"] = gaps
    return spec


def job_addr(data, jobs, want):
    return next((a for n, a in jobs if n.upper() == want.upper()), None)


def load(sgbd):
    path = next((p for p in glob.glob(os.path.join(S.ECU_DIR, "*.prg"))
                 + glob.glob(os.path.join(S.ECU_DIR, "*.PRG"))
                 if os.path.basename(p)[:-4].lower() == sgbd.lower()), None)
    if not path:
        raise SystemExit(f"no such SGBD: {sgbd}")
    return S.read_jobs(path)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 0
    sgbd = args[0].lower()
    data, jobs = load(sgbd)

    if "--all" in sys.argv or "--write" in sys.argv:
        specs = []
        for n, a in jobs:
            if n.startswith("_"):
                continue
            specs.append(extract(data, a, sgbd, n))
        clean = [s for s in specs if "gaps" not in s]
        print(f"{len(specs)} jobs, {len(clean)} extracted with no gaps")
        by_gap = {}
        for s in specs:
            for g in s.get("gaps", []):
                by_gap[g] = by_gap.get(g, 0) + 1
        for g, c in sorted(by_gap.items(), key=lambda kv: -kv[1]):
            print(f"  {c:4}  {g}")
        if "--write" in sys.argv:
            os.makedirs(OUT_DIR, exist_ok=True)
            out = os.path.join(OUT_DIR, sgbd + ".json")
            with open(out, "w", encoding="utf-8") as f:
                json.dump({"sgbd": sgbd, "spec": SPEC_VERSION, "jobs": specs},
                          f, ensure_ascii=False, indent=1)
            print(f"-> {os.path.relpath(out)}")
        return 0

    want = args[1]
    addr = job_addr(data, jobs, want)
    if addr is None:
        raise SystemExit(f"{sgbd} has no job {want}")
    print(json.dumps(extract(data, addr, sgbd, want.upper()),
                     ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
