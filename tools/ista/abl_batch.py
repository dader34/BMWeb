#!/usr/bin/env python3
"""Recover ISTA test modules for one chassis, several, or the whole corpus.

    python3 tools/ista/abl_batch.py --chassis E46            # every module whose validity rule names E46
    python3 tools/ista/abl_batch.py --chassis E46,E39,E90
    python3 tools/ista/abl_batch.py --all                    # all 20,414 DLLs
    python3 tools/ista/abl_batch.py --chassis E46 --links-only   # refresh the per-chassis link lists only

Pipeline per module: DLL out of the installer archive (7zz) -> ilspycmd decompilation (cached) ->
abl_extract.extract_module -> data/ista/abl/<MODULE>.json.gz. Then data/ista/abl/index.json
(identifier -> {title, dll, chassis, steps, complete, findings}) and data/ista/abl/<CHASSIS>.json
(the chassis' modules with the diagnosis objects and fault codes that link to them, so the app can go
from a stored fault to its test modules). failures.json lists every module that is not complete with
the exact reason.

The decompilation cache is verified, not trusted. Handed several assemblies in one invocation,
ilspycmd truncates all but the last at a 4 KB boundary; the cut file still parses as C# and still
yields a plausible step graph, so the loss is silent and would be indistinguishable from a module
that genuinely ends there. Every cached file is therefore checked with cs_complete() and
re-decompiled when it fails, one assembly per invocation, and a module whose decompilation never
comes out whole is reported as a named failure rather than skipped.

Environment: BMWFILES (root of the BMW file store), ISTA_INSTALLER (the ISTA-D .7z), ILSPYCMD,
DOTNET_ROOT, ISTA_DIAGDOC, ISTA_XMLVAL_EN. Options: --dlls DIR (already extracted DLLs), --cs DIR
(decompilation cache), --out DIR, --jobs N.
"""
import argparse
import gzip
import json
import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import abl_extract as A  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
INSTALLER = os.environ.get("ISTA_INSTALLER", os.path.join(A.BMWFILES, "ista/installers/ISTA-D 4.15.16.7z"))
SEVENZ = os.environ.get("SEVENZ", "7zz")
CHASSIS = ["E31", "E34", "E36", "E38", "E39", "E46", "E52", "E53", "E60", "E65", "E70", "E83", "E85", "E87", "E89",
           "E90", "F01", "F07", "F10", "F25", "F30", "K25", "K40", "R50", "R56", "RR1"]


# ----------------------------------------------------------------------------
# database side: chassis ids, module sets, links
# ----------------------------------------------------------------------------

def chassis_ids(db):
    rows = db.execute("select NAME, ID from XEP_CHARACTERISTICS where NAME in (%s) and NODECLASS=40128130"
                      % ",".join("?" * len(CHASSIS)), CHASSIS).fetchall()
    ids = {name: cid for name, cid in rows}
    missing = [c for c in CHASSIS if c not in ids]
    if missing:
        raise SystemExit("chassis without a characteristic row: %s" % missing)
    return ids


def le_hex(cid):
    return struct.pack("<q", int(cid)).hex().upper()


def all_modules(db):
    """Every ABL infoobject with the chassis its validity rule names."""
    ids = chassis_ids(db)
    needles = {name: le_hex(cid) for name, cid in ids.items()}
    out = OrderedDict()
    q = ("select i.ID, i.IDENTIFIER, i.TITLE_ENGB, i.CONTROLID, hex(r.RULE) from XEP_INFOOBJECTS i "
         "left join XEP_RULES r on r.ID=i.ID where i.IDENTIFIER like 'ABL-%' order by i.IDENTIFIER")
    for iid, ident, title, control_id, rule in db.execute(q):
        chassis = [name for name, h in needles.items() if rule and h in rule]
        out[ident] = {"id": iid, "identifier": ident, "title": title, "control_id": control_id, "chassis": chassis}
    return out


def dll_name(identifier):
    return identifier.replace("-", "_", 2) + ".dll"


# A module never names a document. It asks the DocumentHandler for a CLASS
# (a wiring diagram, a functional description) and the tool resolves that
# through the links: module -> diagnosis object -> documents. These are the
# classes those links reach, mapped to the pane each one fills, so the app
# picks by class and never by a document's name.
DOC_CLASSES = {
    "Schaltplan": "diagram",
    "SchaltplanLanguage": "diagram",
    "Funktionsbeschreibung": "function",
    "Einbauort": "location",
    "Steckeransicht": "connector",
    "Pinbelegung": "pinout",
    "Fehlerbehebung": "troubleshooting",
    "Reparaturanleitung": "repair",
    "Serviceinformation": "service",
    "Reparaturhinweis": "repairnote",
    "FahrzeugtechnikDiagnose": "diagnosis",
}


def links_for(db, module_rows):
    """diagnosis objects and fault codes linking to the given modules (by infoobject id)."""
    ids = [m["id"] for m in module_rows]
    db.execute("drop table if exists temp.mods")
    db.execute("create temp table mods (ID integer primary key)")
    db.executemany("insert into temp.mods values (?)", [(i,) for i in ids])
    diag = {}
    q = ("select r.INFOOBJECTID, d.ID, d.CONTROLID, d.NAME, d.TITLE_ENGB from XEP_REFINFOOBJECTS r "
         "join temp.mods m on m.ID=r.INFOOBJECTID join XEP_DIAGNOSISOBJECTS d on d.CONTROLID=r.ID "
         "where r.LINK_TYPE_ID='DiagobjServiceprogramLink'")
    for mid, did, dcid, dname, dtitle in db.execute(q):
        diag.setdefault(mid, []).append({"id": did, "control_id": dcid, "name": dname, "title": dtitle})
    faults = {}
    # fault code -> diagnosis object -> module
    q = ("select r.INFOOBJECTID, f.CODE, v.NAME, f.ID from XEP_REFINFOOBJECTS r "
         "join temp.mods m on m.ID=r.INFOOBJECTID "
         "join XEP_REFDIAGOBJECTS rd on rd.DIAGNOSISOBJECTCONTROLID=r.ID "
         "join XEP_FAULTCODES f on f.ID=rd.ID left join XEP_ECUVARIANTS v on v.ID=f.ECUVARIANTID "
         "where r.LINK_TYPE_ID='DiagobjServiceprogramLink'")
    for mid, code, variant, fid in db.execute(q):
        faults.setdefault(mid, {})[(code, variant)] = {"code": code, "ecu_variant": variant, "fault_id": fid, "via": "diagobj"}
    # fault code -> module directly (fault-symptom modules)
    q = ("select r.INFOOBJECTID, f.CODE, v.NAME, f.ID from XEP_REFINFOOBJECTS r "
         "join temp.mods m on m.ID=r.INFOOBJECTID join XEP_FAULTCODES f on f.ID=r.ID "
         "left join XEP_ECUVARIANTS v on v.ID=f.ECUVARIANTID where r.LINK_TYPE_ID='FaultcodeFkbLink'")
    for mid, code, variant, fid in db.execute(q):
        faults.setdefault(mid, {}).setdefault((code, variant), {"code": code, "ecu_variant": variant, "fault_id": fid, "via": "fkb"})
    # second hop: the documents those diagnosis objects link to. This is the
    # whole of the app's document resolution, and the reason a pane can say
    # "the module asked for a wiring diagram" and open the right one.
    docs = {}
    seen = set()
    q = ("select r.INFOOBJECTID, io.ID, io.IDENTIFIER, io.TITLE_ENGB, n.NAME "
         "from XEP_REFINFOOBJECTS r "
         "join temp.mods m on m.ID=r.INFOOBJECTID "
         "join XEP_REFINFOOBJECTS rd on rd.ID=r.ID "
         "  and rd.LINK_TYPE_ID='DiagobjDocumentLink' "
         "join XEP_INFOOBJECTS io on io.ID=rd.INFOOBJECTID "
         "join XEP_NODECLASSES n on n.ID=io.NODECLASS "
         "where r.LINK_TYPE_ID='DiagobjServiceprogramLink'")
    for mid, did, dident, dtitle, cls in db.execute(q):
        if (mid, did) in seen:
            continue
        seen.add((mid, did))
        docs.setdefault(mid, []).append({
            "id": did,
            "identifier": dident or "",
            "title": (dtitle or "").strip(),
            "type": DOC_CLASSES.get(cls, cls.lower()),
        })
    # THE ORDER IS A CHOICE, SO IT IS MADE ONCE AND MADE STABLE. The link
    # rows carry a PRIORITY column and it is NULL on every one of them, so
    # the tool has no order to honour and the database returns rows in
    # whatever order it likes. The app opens the FIRST document of the class
    # a step asked for, so an unstable order means a rebuild quietly changes
    # which diagram a technician is shown. Sorting on the identifier fixes
    # that: the same input gives the same document, every time.
    for row in docs.values():
        row.sort(key=lambda d: (d["type"], d["identifier"], d["id"]))
    return diag, faults, docs


# ----------------------------------------------------------------------------
# file side: extraction, decompilation, workers
# ----------------------------------------------------------------------------

def extract_dlls(names, dll_dir):
    missing = [n for n in names if not os.path.exists(os.path.join(dll_dir, n))]
    if not missing:
        return 0
    os.makedirs(dll_dir, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".list", delete=False) as fh:
        for n in missing:
            fh.write("Rheingold/Testmodule/%s\n" % n)
        lst = fh.name
    subprocess.run([SEVENZ, "e", "-y", "-o" + dll_dir, INSTALLER, "@" + lst], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    os.unlink(lst)
    return len(missing)


cs_complete = A.cs_complete


def cs_path(cs_dir, dll, verify=True):
    base = os.path.splitext(dll)[0]
    for cand in (base + ".decompiled.cs", base + ".cs"):
        p = os.path.join(cs_dir, cand)
        if os.path.exists(p) and os.path.getsize(p) > 0 and (not verify or cs_complete(p)):
            return p
    return None


def decompile_all(names, dll_dir, cs_dir, jobs, rounds=3):
    """Decompile whatever is not already cached whole, retrying files that came out truncated.

    One DLL per ilspycmd invocation, deliberately. Passing several assemblies to one invocation
    truncates all but the last output file at a 4 KB boundary: the writer does not flush a file
    before moving to the next assembly. The truncated file still parses as C# and still yields a
    step graph, so the damage is silent, which is why every cached file is checked with cs_complete
    before it is trusted and re-decompiled when it fails. Parallelism comes from running many
    single-assembly invocations, which is just as fast and always whole.
    """
    os.makedirs(cs_dir, exist_ok=True)
    env = dict(os.environ, DOTNET_ROOT=A.DOTNET_ROOT)

    def run(name):
        subprocess.run([A.ILSPY, "-o", cs_dir, os.path.join(dll_dir, name)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, check=False)

    done = 0
    for _ in range(rounds):
        todo = [n for n in names
                if cs_path(cs_dir, n) is None and os.path.exists(os.path.join(dll_dir, n))]
        if not todo:
            break
        with ThreadPoolExecutor(max_workers=jobs) as ex:
            list(ex.map(run, todo))
        done += len(todo)
    return done


_TEXTS = None


def _worker(args):
    global _TEXTS
    cs, dll, chassis, out_dir = args
    try:
        if _TEXTS is None:
            _TEXTS = A.Texts()
        result = A.extract_module(cs, _TEXTS, dll=dll, chassis=chassis)
        name = result["module"]
        with gzip.open(os.path.join(out_dir, name + ".json.gz"), "wt", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
        io = result.get("infoobject") or {}
        return {"identifier": result["identifier"], "module": name, "title": io.get("title"), "dll": dll,
                "chassis": chassis, "steps": len(result["step_order"]), "complete": result["complete"],
                "findings": result["findings"], "dead_steps": result["dead_steps"],
                "texts_missing": len(result.get("texts_missing", [])), "infoobject": bool(io)}
    except Exception as ex:  # noqa
        return {"identifier": A.identifier_of(os.path.splitext(dll)[0]), "module": os.path.splitext(dll)[0], "dll": dll,
                "chassis": chassis, "steps": 0, "complete": False,
                "findings": [{"step": "*", "reason": "crash", "detail": "%s: %s" % (type(ex).__name__, ex)}], "dead_steps": []}


# ----------------------------------------------------------------------------
# outputs
# ----------------------------------------------------------------------------

def write_index(out_dir, rows):
    path = os.path.join(out_dir, "index.json")
    index = {}
    if os.path.exists(path):
        index = json.load(open(path))
    for r in rows:
        index[r["identifier"]] = {"title": r.get("title"), "dll": r["dll"], "chassis": r["chassis"], "steps": r["steps"],
                                  "complete": r["complete"], "findings": r["findings"], "dead_steps": r["dead_steps"]}
    with open(path, "w") as fh:
        json.dump(OrderedDict(sorted(index.items())), fh, indent=0, ensure_ascii=False)
    return index


def write_failures(out_dir, index):
    fails = OrderedDict((k, v) for k, v in sorted(index.items()) if not v["complete"])
    with open(os.path.join(out_dir, "failures.json"), "w") as fh:
        json.dump(fails, fh, indent=1, ensure_ascii=False)
    return fails


def write_chassis(db, out_dir, chassis, modules, index):
    rows = [m for m in modules.values() if chassis in m["chassis"]]
    diag, faults, docs = links_for(db, rows)
    entries = []
    for m in rows:
        ix = index.get(m["identifier"], {})
        entries.append(OrderedDict([
            ("identifier", m["identifier"]), ("title", m["title"]), ("dll", dll_name(m["identifier"])),
            ("steps", ix.get("steps")), ("complete", ix.get("complete")),
            ("diag_objects", diag.get(m["id"], [])),
            ("documents", docs.get(m["id"], [])),
            ("fault_codes", sorted(faults.get(m["id"], {}).values(), key=lambda f: (f["ecu_variant"] or "", f["code"] or ""))),
        ]))
    # The app reads this file, so it is written in the shape the app reads:
    # modules keyed by identifier with only the fields a PLAN ROW and the
    # module window need, and a fault -> modules table the test-plan
    # calculation looks up directly. The wide per-module records above stay
    # as the tool's own record under <CHASSIS>.full.json.
    with open(os.path.join(out_dir, chassis + ".full.json"), "w") as fh:
        json.dump({"chassis": chassis, "modules": entries}, fh, ensure_ascii=False)

    app_modules = OrderedDict()
    for e in sorted(entries, key=lambda x: x["identifier"]):
        objs = e["diag_objects"]
        app_modules[e["identifier"]] = OrderedDict([
            ("complete", e["complete"]),
            # the component the row sits under is the diagnosis object the
            # module belongs to, named in the technician's language
            ("component", (objs[0]["title"] if objs else "") or ""),
            ("documents", e["documents"]),
            ("priority", 0),
            ("steps", e["steps"]),
            ("title", e["title"]),
        ])
        if not e["documents"]:
            del app_modules[e["identifier"]]["documents"]

    # fault code -> the modules that test it, which is the whole of
    # "calculate test plan": a fault the car reported names its procedures
    # THE DATABASE STORES THE FAULT CODE IN DECIMAL; EVERY SCREEN READS HEX.
    # XEP_FAULTCODES.CODE for the MS45 misfire fault the app shows as 27C3
    # is the string "10179". Writing the stored digits through unchanged is
    # not a formatting nit: the app looks a fault up by the hex it displays,
    # so a decimal key means no plan row is ever found, for any fault.
    #
    # Both forms are written. The same code means different things on
    # different ECU variants, so the variant-qualified key is what a caller
    # that knows the variant should use; the bare key is what the fault
    # table can offer, since its Code column carries no variant.
    by_fault = {}
    for e in entries:
        for f in e["fault_codes"]:
            if f["code"] is None:
                continue
            try:
                code = format(int(str(f["code"])), "X")
            except ValueError:
                code = str(f["code"]).upper()
            by_fault.setdefault(code, set()).add(e["identifier"])
            variant = f["ecu_variant"]
            if variant:
                key = "%s:%s" % (variant, code)
                by_fault.setdefault(key, set()).add(e["identifier"])
    faults = OrderedDict((k, sorted(v)) for k, v in sorted(by_fault.items()))

    with open(os.path.join(out_dir, chassis + ".json"), "w") as fh:
        json.dump(
            {"chassis": chassis, "faults": faults, "modules": app_modules},
            fh, ensure_ascii=False,
        )
    return entries


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chassis", help="comma separated chassis names (see CHASSIS)")
    ap.add_argument("--all", action="store_true", help="the whole corpus")
    ap.add_argument("--dlls", default=os.path.join(ROOT, "data/ista/abl-work/dlls"))
    ap.add_argument("--cs", default=os.path.join(ROOT, "data/ista/abl-work/cs"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data/ista/abl"))
    ap.add_argument("--jobs", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    ap.add_argument("--links-only", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="first N modules only (smoke test)")
    args = ap.parse_args(argv)
    if not args.chassis and not args.all:
        ap.error("--chassis or --all")
    t0 = time.time()
    db = sqlite3.connect(A.DIAGDOC)
    modules = all_modules(db)
    wanted = list(CHASSIS) if args.all else [c.strip().upper() for c in args.chassis.split(",")]
    for c in wanted:
        if c not in CHASSIS:
            ap.error("unknown chassis %s" % c)
    if args.all:
        selected = list(modules.values())
    else:
        selected = [m for m in modules.values() if any(c in m["chassis"] for c in wanted)]
    if args.limit:
        selected = selected[: args.limit]
    os.makedirs(args.out, exist_ok=True)
    print("modules: %d selected of %d in the database (%s)" % (len(selected), len(modules), "all" if args.all else ",".join(wanted)))
    if not args.links_only:
        names = [dll_name(m["identifier"]) for m in selected]
        t = time.time()
        n = extract_dlls(names, args.dlls)
        have = [nm for nm in names if os.path.exists(os.path.join(args.dlls, nm))]
        print("dlls: %d extracted now, %d present, %d missing from the archive (%.0fs)" % (n, len(have), len(names) - len(have), time.time() - t))
        t = time.time()
        n = decompile_all(names, args.dlls, args.cs, args.jobs)
        print("decompiled: %d now (%.0fs)" % (n, time.time() - t))
        work, undecompiled = [], []
        for m in selected:
            dll = dll_name(m["identifier"])
            cs = cs_path(args.cs, dll)
            if cs:
                work.append((cs, dll, m["chassis"], args.out))
            else:
                # no whole decompilation: the DLL is absent from the archive, or ilspy could not
                # finish it. Never silently drop it; it is a failure with a name and a reason.
                reason = ("dll-missing" if not os.path.exists(os.path.join(args.dlls, dll))
                          else "decompile-incomplete")
                undecompiled.append({"identifier": m["identifier"], "module": os.path.splitext(dll)[0],
                                     "title": m["title"], "dll": dll, "chassis": m["chassis"], "steps": 0,
                                     "complete": False, "dead_steps": [], "texts_missing": 0, "infoobject": True,
                                     "findings": [{"step": "*", "reason": reason, "detail": dll}]})
        if undecompiled:
            print("no decompilation: %d modules (%s)" % (len(undecompiled),
                  ", ".join(sorted({u["findings"][0]["reason"] for u in undecompiled}))))
        t = time.time()
        with Pool(args.jobs) as pool:
            rows = pool.map(_worker, work, chunksize=8)
        print("recovered: %d modules (%.0fs), complete %d, not complete %d" % (len(rows), time.time() - t,
              sum(1 for r in rows if r["complete"]), sum(1 for r in rows if not r["complete"])))
        index = write_index(args.out, rows + undecompiled)
    else:
        index = json.load(open(os.path.join(args.out, "index.json"))) if os.path.exists(os.path.join(args.out, "index.json")) else {}
    fails = write_failures(args.out, index)
    for c in wanted:
        entries = write_chassis(db, args.out, c, modules, index)
        done = sum(1 for e in entries if e["complete"] is not None)
        comp = sum(1 for e in entries if e["complete"])
        print("%s: %d modules, %d recovered, %d complete, %d with fault links" % (c, len(entries), done, comp, sum(1 for e in entries if e["fault_codes"])))
    size = sum(os.path.getsize(os.path.join(args.out, f)) for f in os.listdir(args.out))
    print("failures: %d | data/ista/abl: %.1f MB | total %.0fs" % (len(fails), size / 1e6, time.time() - t0))
    for k, v in list(fails.items())[:60]:
        gaps = [f for f in v["findings"] if f["reason"] not in A.DEAD_REASONS]
        print("  %s: %s" % (k, "; ".join("%s %s: %s" % (f["reason"], f["step"], f["detail"][:80]) for f in gaps)[:300]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
