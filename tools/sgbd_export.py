#!/usr/bin/env python3
"""Emit the SHIPPABLE artifacts of the jobs-to-JSON work, and measure them.

Everything before this tool verified the extraction; this is the step that
actually produces what the web app downloads. Three commands:

    python3 tools/sgbd_export.py --specs      # data/job-specs/<sgbd>.json
    python3 tools/sgbd_export.py --tables     # data/sgbd-tables/<sgbd>.json
    python3 tools/sgbd_export.py --coverage   # what the IR SCREENS can show

--specs writes one JSON per E46 SGBD: every job the compiled INPA UI
references, each with its lifted spec, plus a "connection" block (protocol
framing and the init exchange the ECU demands, derived by running the real
engine against a stub simulator -- the same ground truth the value harness
uses). A job the spec format cannot express keeps its gaps; nothing is
guessed.

--tables exports every SGBD table the specs reference (status tables,
FUmweltTexte lookups) via the engine's table API, so the browser walker can
resolve runtime-keyed scales without the engine.

--coverage answers the question that matters for shipping: of the result
KEYS the IR screens actually display, how many does some job spec on that
screen decode? This is the user-facing number -- a result no screen shows
does not gate the web app, however interesting its bytecode is.
"""
import os
import sys
import json
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sgbd_survey as S                                       # noqa: E402
import sgbd_spec as SP                                        # noqa: E402
import sgbd_value_diff as V                                   # noqa: E402
import sgbd_bulk_verify as B                                  # noqa: E402

ROOT = os.path.join(HERE, "..")
SPEC_DIR = os.path.join(ROOT, "data", "job-specs")
TABLE_DIR = os.path.join(ROOT, "data", "sgbd-tables")
IR_DIR = os.path.join(ROOT, "data", "inpa-ir")


def _decodable(r):
    """Can a walker produce this result from a response?"""
    return (r.get("const") is not None or r.get("bytes")
            or r.get("enumMap") or r.get("values"))


def export_specs(targets):
    os.makedirs(SPEC_DIR, exist_ok=True)
    grand_jobs = grand_res = grand_dec = 0
    for sgbd in targets:
        try:
            data, jobs = SP.load(sgbd)
        except SystemExit:
            print(f"  {sgbd:12} -- no .prg, skipped")
            continue
        ir = S.ir_jobs_for(sgbd)
        out = {"format": 1, "sgbd": sgbd, "jobs": {}}
        first_job = None
        for name, addr in jobs:
            if name.startswith("_") or name.upper() not in ir:
                continue
            first_job = first_job or name
            try:
                spec = SP.extract(data, addr, sgbd, name)
            except Exception as e:                          # noqa: BLE001
                spec = {"sgbd": sgbd, "job": name,
                        "gaps": [f"extract failed: {e}"]}
            out["jobs"][name] = spec
            res = [r for r in spec.get("results", [])
                   if not r.get("name", "").startswith("_")]
            grand_res += len(res)
            grand_dec += sum(1 for r in res if _decodable(r))
        grand_jobs += len(out["jobs"])
        # The init exchange and framing, derived by running the REAL engine
        # against a stub sim -- what it sends first is what the ECU needs.
        if first_job:
            try:
                init = B.discover_init(sgbd, first_job)
                reqs = B.discover(sgbd, [first_job], init)
                probe = reqs.get(first_job)
                conn = {}
                if probe:
                    conn["protocol"] = "ds2" if B.is_ds2(probe) else "fast"
                    conn["address"] = probe[1] if conn["protocol"] == "fast" \
                        else probe[0]
                if init:
                    conn["init"] = [{"send": list(init[0]),
                                     "expect": list(init[1] or [])}]
                if conn:
                    out["connection"] = conn
            except Exception:                               # noqa: BLE001
                pass
        path = os.path.join(SPEC_DIR, f"{sgbd}.json")
        with open(path, "w") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  {sgbd:12} {len(out['jobs']):3} jobs "
              f"{os.path.getsize(path)//1024:5} KB "
              f"conn={'yes' if out.get('connection') else 'no'}")
    print(f"specs: {grand_jobs} jobs, {grand_res} results, "
          f"{grand_dec} decodable ({100*grand_dec/max(grand_res,1):.1f}%)")


def export_tables(targets):
    os.makedirs(TABLE_DIR, exist_ok=True)
    for sgbd in targets:
        path = os.path.join(SPEC_DIR, f"{sgbd}.json")
        if not os.path.exists(path):
            continue
        spec_file = json.load(open(path))
        names = set()
        for spec in spec_file.get("jobs", {}).values():
            if spec.get("statusTable"):
                names.add(spec["statusTable"])
            for t in spec.get("tables", []):
                names.add(t)
            for r in spec.get("results", []):
                lk = r.get("lookup")
                if lk and lk.get("table"):
                    names.add(lk["table"])
        if not names:
            continue
        tables = {}
        for t in sorted(names):
            try:
                rows = V.sgbd_table(sgbd, t)
            except Exception:                               # noqa: BLE001
                rows = None
            if rows:
                tables[t] = rows
        if tables:
            tp = os.path.join(TABLE_DIR, f"{sgbd}.json")
            with open(tp, "w") as f:
                json.dump(tables, f, ensure_ascii=False,
                          separators=(",", ":"))
            print(f"  {sgbd:12} {len(tables):2} tables "
                  f"{os.path.getsize(tp)//1024:5} KB")


def coverage(targets):
    """Of the result keys the IR screens display, how many decode?"""
    total = covered = 0
    rows = []
    for sgbd in targets:
        path = os.path.join(SPEC_DIR, f"{sgbd}.json")
        if not os.path.exists(path):
            continue
        specs = json.load(open(path)).get("jobs", {})
        # result name -> decodable, across every job in the SGBD (INPA
        # screens pull results by NAME from whichever job produced them)
        dec_names = {}
        for spec in specs.values():
            for r in spec.get("results", []):
                nm = r.get("name", "").upper()
                dec_names[nm] = dec_names.get(nm) or bool(_decodable(r))
        stems = {sgbd}
        for suf in ("ds0", "ds2", "ds1", "_n", "ds"):
            if sgbd.endswith(suf):
                stems.add(sgbd[:-len(suf)])
        t = c = 0
        misses = {}
        for f in glob.glob(os.path.join(IR_DIR, "*.json")):
            if os.path.basename(f)[:-5].lower() not in stems:
                continue
            ir = json.load(open(f))
            for scr in ir.get("screens", {}).values():
                for line in scr.get("lines", []):
                    for el in (line.get("elements") or []):
                        key = (el.get("key") or "").upper()
                        if not key:
                            continue
                        # JOB_STATUS is produced by every job's validation
                        if key == "JOB_STATUS":
                            t += 1
                            c += 1
                            continue
                        t += 1
                        if dec_names.get(key):
                            c += 1
                        else:
                            misses[key] = misses.get(key, 0) + 1
        if t:
            rows.append((sgbd, c, t, misses))
            total += t
            covered += c
    rows.sort(key=lambda x: x[1] / x[2])
    for sgbd, c, t, misses in rows:
        line = f"  {sgbd:12} {c:5}/{t:<5} ({100*c/t:5.1f}%)"
        if misses:
            top = ", ".join(k for k, _ in sorted(misses.items(),
                                                 key=lambda kv: -kv[1])[:3])
            line += f"  missing: {top}"
        print(line)
    print(f"\nIR screen keys decodable: {covered}/{total} "
          f"({100*covered/max(total,1):.1f}%)")


def main():
    targets = [a.lower() for a in sys.argv[1:] if not a.startswith("--")] \
        or S.e46_sgbds()
    if "--specs" in sys.argv:
        export_specs(targets)
    if "--tables" in sys.argv:
        export_tables(targets)
    if "--coverage" in sys.argv:
        coverage(targets)
    if len(sys.argv) < 2:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
