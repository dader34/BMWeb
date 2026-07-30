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


def _export_one(sgbd):
    """Extract + probe one SGBD, write its spec file; returns a summary.

    Top-level so ProcessPoolExecutor can pickle it. Each worker spawns its
    own dotnet probes into per-SGBD scratch dirs (see sgbd_bulk_verify), so
    workers cannot trample each other.
    """
    try:
        data, jobs = SP.load(sgbd)
    except SystemExit:
        return (sgbd, None, 0, 0, False)
    ir = S.ir_jobs_for(sgbd)
    out = {"format": 1, "sgbd": sgbd, "jobs": {}}
    first_job = None
    n_res = n_dec = 0
    for name, addr in jobs:
        if name.startswith("_") or name.upper() not in ir:
            continue
        first_job = first_job or name
        try:
            spec = SP.extract(data, addr, sgbd, name)
        except Exception as e:                              # noqa: BLE001
            spec = {"sgbd": sgbd, "job": name,
                    "gaps": [f"extract failed: {e}"]}
        out["jobs"][name] = spec
        res = [r for r in spec.get("results", [])
               if not r.get("name", "").startswith("_")]
        n_res += len(res)
        n_dec += sum(1 for r in res if _decodable(r))
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
        except Exception:                                   # noqa: BLE001
            pass
    path = os.path.join(SPEC_DIR, f"{sgbd}.json")
    with open(path, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    return (sgbd, len(out["jobs"]), n_res, n_dec,
            bool(out.get("connection")))


def export_specs(targets):
    os.makedirs(SPEC_DIR, exist_ok=True)
    # Extraction is pure Python and the probes are dotnet subprocesses, so
    # a PROCESS pool parallelises both; the serial run spent most of its
    # wall clock waiting on one dotnet at a time.
    from concurrent.futures import ProcessPoolExecutor
    workers = min(6, os.cpu_count() or 4)
    grand_jobs = grand_res = grand_dec = 0
    # warm the CLI binary once, before workers race to build it
    B.cli_cmd("--version")
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for sgbd, nj, nr, nd, conn in ex.map(_export_one, targets):
            if nj is None:
                print(f"  {sgbd:12} -- no .prg, skipped")
                continue
            grand_jobs += nj
            grand_res += nr
            grand_dec += nd
            path = os.path.join(SPEC_DIR, f"{sgbd}.json")
            print(f"  {sgbd:12} {nj:3} jobs "
                  f"{os.path.getsize(path)//1024:5} KB "
                  f"conn={'yes' if conn else 'no'}")
    print(f"specs: {grand_jobs} jobs, {grand_res} results, "
          f"{grand_dec} decodable ({100*grand_dec/max(grand_res,1):.1f}%)")


def export_tables(targets):
    os.makedirs(TABLE_DIR, exist_ok=True)
    # table fetches are HTTP calls to the engine API: thread them
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(_export_tables_one, targets))


def _export_tables_one(sgbd):
    # EVERY table the .prg declares, not just the ones a lifted spec field
    # happens to name. MS450 declares 53 and the spec fields named 20, so a
    # third of its lookup text was missing -- STATUS_MESSWERTBLOCK's unit
    # column resolved to "" because the table holding it was never shipped.
    # The VM reaches tables the lifter never modelled, so the export has to
    # come from the SGBD, not from our summary of it.
    names = set()
    port = os.environ.get("BMACW_PORT")
    if port:
        import urllib.request
        try:
            listing = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/ecu/{sgbd}/tables", timeout=60))
            for t in (listing if isinstance(listing, list) else []):
                n = t if isinstance(t, str) else t.get("name")
                if n:
                    names.add(n)
        except Exception:                                   # noqa: BLE001
            pass
    path = os.path.join(SPEC_DIR, f"{sgbd}.json")
    if os.path.exists(path):
        spec_file = json.load(open(path))
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
        return
    tables = {}
    for t in sorted(names):
        try:
            rows = V.sgbd_table(sgbd, t)
        except Exception:                                   # noqa: BLE001
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


def export_groups(chassis="E46"):
    """Export the GROUP files and the variant assignment table.

    This is how EDIABAS answers "which SGBD is this ECU?", and without it a
    client can only talk to an ECU whose variant it was already told. A .grp
    is the same container as a .prg (see sgbd_spec.load), so its
    IDENTIFIKATION job runs on the same VM; what it needs alongside is
    ZuordnungsTabelle from t_grtb, which maps the identification answer
    (ADR_VAR_DIAG) to a concrete SGBD name.
    """
    import urllib.request
    out_dir = os.path.join(ROOT, "data", "groups")
    os.makedirs(out_dir, exist_ok=True)
    # The assignment table lives in t_grtb, a separate SGBD that every group
    # reaches with `tabsetex "ZuordnungsTabelle", "t_grtb"`. Its key
    # ADR_VAR_DIAG is "<ecu addr> <id pattern> <code>", e.g. "12 .0W. 0010"
    # -> ME9N45, with '.' and '-' as wildcards; the group's IDENTIFIKATION
    # job assembles that key from the ECU's identification response and
    # looks up the concrete SGBD name.
    try:
        rows = V.sgbd_table("t_grtb", "ZuordnungsTabelle")
    except Exception:                                       # noqa: BLE001
        rows = None
    if rows:
        # keep only the rows for this chassis; the full table covers every
        # BMW platform and most of it is dead weight for one car
        want = [r for r in rows
                if str(r.get("BAUREIHE", "")).upper() == chassis.upper()]
        with open(os.path.join(out_dir, "variants.json"), "w") as f:
            json.dump({"chassis": chassis, "table": "ZuordnungsTabelle",
                       "keyColumn": "ADR_VAR_DIAG", "sgbdColumn": "SGBD",
                       "rows": want or rows}, f, ensure_ascii=False,
                      separators=(",", ":"))
        print(f"  variants.json  {len(want)} rows for {chassis}"
              f" (of {len(rows)} total)")
    # the group programs themselves
    # Which groups does this chassis actually use? The assignment table
    # names them, so ship those rather than all 248.
    used = sorted({str(r.get("GRUPPE", "")).lower()
                   for r in (want or rows or []) if r.get("GRUPPE")})
    import sgbd_code as C
    # every group also needs the assignment table alongside its code
    for g in used:
        if rows:
            with open(os.path.join(TABLE_DIR, f"{g}.json"), "w") as f:
                json.dump({"ZuordnungsTabelle": rows}, f,
                          ensure_ascii=False, separators=(",", ":"))
    made = []
    for g in used:
        try:
            r = C.export(g)
        except SystemExit:
            continue
        if r:
            made.append(r)
            print(f"  {r[0]:12} {r[1]:2} jobs {r[2]:6} ops {r[4]//1024:4} KB")
    print(f"groups: {len(made)} of {len(used)} referenced by {chassis}")
    return made


def audit_tables(targets):
    """Fail loudly when a shipped table set is missing declared tables.

    The VM reaches tables the lifter never modelled, so "the specs did not
    mention it" is not evidence a table is unused. This audit compares what
    each .prg DECLARES against what was exported -- the check that would
    have caught 523 missing tables corpus-wide instead of one ECU's unit
    column decoding as "".
    """
    import urllib.request
    port = os.environ.get("BMACW_PORT")
    if not port:
        print("audit needs BMACW_PORT")
        return 1
    bad = 0
    tot_decl = tot_ship = 0
    for sgbd in targets:
        p = os.path.join(TABLE_DIR, f"{sgbd}.json")
        shipped = set(json.load(open(p))) if os.path.exists(p) else set()
        try:
            listing = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/ecu/{sgbd}/tables", timeout=60))
        except Exception:                                   # noqa: BLE001
            continue
        decl = {(t if isinstance(t, str) else t.get("name"))
                for t in (listing if isinstance(listing, list) else [])}
        decl = {d for d in decl if d}
        up = {x.upper() for x in shipped}
        missing = []
        for d in sorted(decl):
            if d.upper() in up:
                continue
            # A table can be DECLARED and genuinely EMPTY in the .prg
            # (alc_60's FUMWELTMATRIX has zero rows). There is nothing to
            # ship, so that is complete, not missing -- but prove it by
            # reading rather than assuming.
            try:
                if not V.sgbd_table(sgbd, d):
                    continue
            except Exception:                               # noqa: BLE001
                pass
            missing.append(d)
        tot_decl += len(decl)
        tot_ship += len(decl) - len(missing)
        if missing:
            bad += 1
            print(f"  {sgbd:12} missing {len(missing):3} of {len(decl):3}"
                  f"  e.g. {', '.join(missing[:3])}")
    print(f"tables declared {tot_decl}, shipped {tot_ship}"
          f" ({100 * tot_ship / max(tot_decl, 1):.1f}%)"
          f" -- {bad} SGBDs incomplete")
    return 1 if bad else 0


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


def all_chassis():
    import urllib.request
    port = os.environ.get("BMACW_PORT")
    return json.load(urllib.request.urlopen(
        f"http://127.0.0.1:{port}/api/chassis", timeout=60))


def chassis_sgbds(chassis):
    import urllib.request
    port = os.environ.get("BMACW_PORT")
    c = json.load(urllib.request.urlopen(
        f"http://127.0.0.1:{port}/api/chassis/{chassis}", timeout=300))
    return sorted({(e.get("sgbd") or "").lower()
                   for s in c.get("sections", [])
                   for e in s.get("ecus", []) if e.get("sgbd")})


def ship(chassis="E46"):
    """Assemble data/ecus/<CHASSIS>/<ECU>/ -- one self-contained folder per
    ECU holding EVERYTHING the web app needs for it:

        ecu.json       identity (code, label, section, sgbd, group)
        screens.json   the decompiled INPA UI (IR)
        jobs.json      the lifted job specs + connection block
        tables.json    the SGBD tables those specs reference
        i18n.json      per-ECU caption translations (hand-written source)
        faults.json    fault-code map (linked by the sgbd it declares)

    plus <CHASSIS>/index.json, the single entry point listing sections and
    their ECUs. Sources stay where their generators put them; this is the
    packaging step, so regenerating any input and re-running --ship keeps
    the tree honest.
    """
    import urllib.request
    port = os.environ.get("BMACW_PORT")
    if not port:
        raise SystemExit("--ship needs BMACW_PORT (chassis config API)")
    cfg = json.load(urllib.request.urlopen(
        f"http://127.0.0.1:{port}/api/chassis/{chassis}", timeout=60))
    # fault maps self-declare the sgbd they cover
    faults_by_sgbd = {}
    for p in glob.glob(os.path.join(ROOT, "data", "faults",
                                    chassis.lower(), "*.json")):
        try:
            faults_by_sgbd[json.load(open(p)).get("sgbd", "").lower()] = p
        except Exception:                                   # noqa: BLE001
            pass
    root = os.path.join(ROOT, "ecus", chassis)
    os.makedirs(root, exist_ok=True)
    index = {"chassis": chassis, "sections": []}
    for sec in cfg.get("sections", []):
        entry = {"name": sec["name"], "ecus": []}
        for e in sec.get("ecus", []):
            code = e["code"]
            sgbd = (e.get("sgbd") or "").lower()
            d = os.path.join(root, code)
            os.makedirs(d, exist_ok=True)
            parts = {"ecu": True}

            def put(name, obj):
                with open(os.path.join(d, name + ".json"), "w") as f:
                    json.dump(obj, f, ensure_ascii=False,
                              separators=(",", ":"))
                parts[name] = True

            put("ecu", {"code": code, "label": e.get("label"),
                        "section": sec["name"], "sgbd": sgbd,
                        "group": e.get("group")})
            # the IR is named by IPO stem: the code, or an sgbd stem
            stems = {code.lower(), sgbd}
            for suf in ("ds0", "ds2", "ds1", "_n", "ds"):
                if sgbd.endswith(suf):
                    stems.add(sgbd[:-len(suf)])
            for f in glob.glob(os.path.join(IR_DIR, "*.json")):
                if os.path.basename(f)[:-5].lower() in stems:
                    put("screens", json.load(open(f)))
                    break
            sp = os.path.join(SPEC_DIR, f"{sgbd}.json")
            spec = None
            if sgbd and os.path.exists(sp):
                spec = json.load(open(sp))
            # KEEP THE DATA EVEN WHEN THERE IS NO SCREEN TO SHOW IT ON.
            # Spec lifting is driven by what a screen invokes, so an ECU BMW
            # never drew a UI for lifts zero specs -- 15 of them, marked
            # ScreenCount=0 in BMW's own .ini. They still DECLARE plenty of
            # real work (hud_70 98 jobs, ulf_60 80 including BT_ANTENNA_TEST,
            # elv 13 with FS_LESEN/IDENT), all of it described in the .prg and
            # already exported to data/job-meta. Shipping an empty jobs.json
            # threw that away at the last step. Fall back to the metadata so
            # the job list survives into ecus/ -- INPA shows no screen for
            # these and neither do we, but the data is there to drive one.
            if not (spec or {}).get("jobs"):
                mp = os.path.join(ROOT, "data", "job-meta", f"{sgbd}.json")
                if sgbd and os.path.exists(mp):
                    meta = json.load(open(mp))
                    if meta.get("jobs"):
                        spec = {"format": 1, "sgbd": sgbd,
                                "source": "job-meta",
                                "jobs": meta["jobs"]}
            if spec:
                put("jobs", spec)
            tp = os.path.join(TABLE_DIR, f"{sgbd}.json")
            if sgbd and os.path.exists(tp):
                put("tables", json.load(open(tp)))
            for f in glob.glob(os.path.join(ROOT, "data", "inpa-i18n",
                                            "*.json")):
                if os.path.basename(f)[:-5].lower() in stems:
                    put("i18n", json.load(open(f)))
                    break
            if sgbd in faults_by_sgbd:
                put("faults", json.load(open(faults_by_sgbd[sgbd])))
            entry["ecus"].append({"code": code, "label": e.get("label"),
                                  "parts": sorted(k for k, v in parts.items()
                                                  if v)})
            missing = [k for k in ("screens", "jobs") if k not in parts]
            note = f"  MISSING {','.join(missing)}" if missing else ""
            print(f"  {code:12} {' '.join(sorted(parts))}{note}")
        index["sections"].append(entry)
    with open(os.path.join(root, "index.json"), "w") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    total = sum(os.path.getsize(os.path.join(dp, fn))
                for dp, _, fns in os.walk(root) for fn in fns)
    print(f"shipped {root}: {total//1024} KB")


def main():
    targets = [a.lower() for a in sys.argv[1:] if not a.startswith("--")]
    if not targets:
        if "--all-chassis" in sys.argv:
            targets = sorted({g for ch in all_chassis()
                              for g in chassis_sgbds(ch)})
            if "--force" not in sys.argv:
                # keep what an earlier run already extracted
                targets = [t for t in targets if not os.path.exists(
                    os.path.join(SPEC_DIR, f"{t}.json"))]
        else:
            targets = S.e46_sgbds()
    if "--specs" in sys.argv:
        export_specs(targets)
    if "--tables" in sys.argv:
        export_tables(targets)
    if "--coverage" in sys.argv:
        coverage(targets)
    if "--groups" in sys.argv:
        export_groups()
    if "--audit" in sys.argv:
        return audit_tables(targets)
    if "--ship" in sys.argv:
        chs = [a for a in sys.argv[1:]
               if not a.startswith("--") and a.upper() == a and len(a) <= 4]
        for ch in (chs or all_chassis()):
            print(f"[{ch}]")
            try:
                ship(ch)
            except Exception as e:                          # noqa: BLE001
                print(f"  {ch}: {e}")
    if len(sys.argv) < 2:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
