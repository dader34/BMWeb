#!/usr/bin/env python3
"""Freeze the app's API surface into static JSON, so it can run in a browser.

The macOS app answers the renderer from a local C# server. In a browser there
is no server, so every GET the renderer makes has to already exist as a file.
This writes that tree.

Almost everything is already static: job code, tables, metadata and IR are all
generated files, and `ecus/` holds the per-ECU screens. Only two endpoints are
computed at request time, and both are cheap to freeze:

    /api/chassis        the list of chassis ids
    /api/chassis/{id}   sections -> ecus, plus variantGroups

`ecus/<id>/index.json` is nearly that shape already but drops `sgbd` and
`group` (it lists which PARTS shipped instead) and has no variantGroups, so
this reads the running app once and writes the real answers.

    BMACW_PORT=... python3 tools/web_export.py            # -> dist-web/api/
    BMACW_PORT=... python3 tools/web_export.py --out DIR

Needs the app running: the chassis config is resolved from INPA's CFGDAT
against the .prg tree, which is exactly the work being frozen.
"""
import os
import sys
import json
import shutil
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")


def get(port, path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",
                                timeout=120) as r:
        return json.load(r)


def write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    return os.path.getsize(path)


def main():
    port = os.environ.get("BMACW_PORT")
    if not port:
        print("BMACW_PORT not set: start the app first, the chassis config is "
              "resolved by it", file=sys.stderr)
        return 1
    out = os.path.join(ROOT, "dist-web")
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    api = os.path.join(out, "api")

    total = 0
    ids = get(port, "/api/chassis")
    # A directory and a file cannot share one name: /api/chassis/{id} needs
    # `chassis/` to be a directory, so the list itself is chassis.json and the
    # fetch shim appends ".json" to every API path.
    total += write(os.path.join(api, "chassis.json"), ids)
    for cid in ids:
        total += write(os.path.join(api, "chassis", f"{cid}.json"),
                       get(port, f"/api/chassis/{cid}"))
    print(f"  chassis     {len(ids)} ids + configs")

    # Per-ECU metadata the renderer asks for by name. Job code and tables are
    # copied as-is below; these are the ones with a per-JOB path.
    sgbds = set()
    for cid in ids:
        cfg = get(port, f"/api/chassis/{cid}")
        for sec in cfg.get("sections", []):
            for e in sec.get("ecus", []):
                if e.get("sgbd"):
                    sgbds.add(e["sgbd"].lower())
    njobs = nres = 0
    for sgbd in sorted(sgbds):
        mp = os.path.join(ROOT, "data", "job-meta", f"{sgbd}.json")
        if not os.path.exists(mp):
            continue
        with open(mp) as f:
            meta = json.load(f)
        jobs = meta.get("jobs", {})
        total += write(os.path.join(api, "ecu", sgbd, "jobs.json"),
                       sorted(jobs.keys()))
        njobs += 1
        for jname, j in jobs.items():
            # the engine's "NAME : comment" line shape the renderer parses
            lines = [f"{r['name']} : {r.get('comment', '')}"
                     for r in j.get("results", [])]
            if lines:
                total += write(
                    os.path.join(api, "ecu", sgbd, "results",
                                 f"{jname.upper()}.json"), lines)
                nres += 1
            args = j.get("arguments") or []
            if args:
                rows = []
                for a in args:
                    row = {"ARG": a["name"], "ARGTYPE": a.get("type", "")}
                    for i, c in enumerate(a.get("comments", [])):
                        row[f"ARGCOMMENT{i}"] = c
                    rows.append(row)
                total += write(
                    os.path.join(api, "ecu", sgbd, "arguments",
                                 f"{jname.upper()}.json"),
                    {"job": jname, "arguments": rows})
    print(f"  metadata    {njobs} ecus, {nres} job result schemas")

    # /tables and /table/{name}: live.js resolves a status table by name to
    # turn a raw code into its text, so a missing one silently blanks a value.
    ntab = 0
    for sgbd in sorted(sgbds):
        tp = os.path.join(ROOT, "data", "sgbd-tables", f"{sgbd}.json")
        if not os.path.exists(tp):
            continue
        with open(tp) as f:
            tabs = json.load(f)
        total += write(os.path.join(api, "ecu", sgbd, "tables.json"),
                       sorted(tabs.keys()))
        for name, rows in tabs.items():
            total += write(os.path.join(api, "ecu", sgbd, "table",
                                        f"{name.upper()}.json"), rows)
        ntab += 1
    print(f"  tables      {ntab} ecus")

    # IR: served by /api/ecu/{sgbd}/ir, named by IPO stem rather than sgbd, so
    # resolve the same way ConfigEndpoints does and write it under the sgbd.
    ir_dir = os.path.join(ROOT, "data", "inpa-ir")
    stems = {f[:-5].lower(): f for f in os.listdir(ir_dir)
             if f.endswith(".json")} if os.path.isdir(ir_dir) else {}
    nir = 0
    for cid in ids:
        cfg = get(port, f"/api/chassis/{cid}")
        for sec in cfg.get("sections", []):
            for e in sec.get("ecus", []):
                sgbd = (e.get("sgbd") or "").lower()
                if not sgbd:
                    continue
                cand = {e["code"].lower(), sgbd}
                for suf in ("ds0", "ds2", "ds1", "_n", "ds"):
                    if sgbd.endswith(suf):
                        cand.add(sgbd[:-len(suf)])
                hit = next((stems[c] for c in cand if c in stems), None)
                if not hit:
                    continue
                dst = os.path.join(api, "ecu", sgbd, "ir.json")
                if os.path.exists(dst):
                    continue
                shutil.copyfile(os.path.join(ir_dir, hit), dst)
                total += os.path.getsize(dst)
                nir += 1
    print(f"  ir          {nir} ecus")

    # The VM's own inputs, at the paths vmbridge.js already fetches.
    for sub in ("job-code", "sgbd-tables"):
        src = os.path.join(ROOT, "data", sub)
        if not os.path.isdir(src):
            continue
        dst = os.path.join(out, "data", sub)
        os.makedirs(dst, exist_ok=True)
        n = 0
        for f in os.listdir(src):
            # job code ships gzipped only -- 456 MB raw vs 21 MB, and a static
            # host serves .gz with Content-Encoding just as ServeDataFile did
            if sub == "job-code" and not (f.endswith(".gz")
                                          or f == "index.json"):
                continue
            shutil.copyfile(os.path.join(src, f), os.path.join(dst, f))
            total += os.path.getsize(os.path.join(dst, f))
            n += 1
        print(f"  {sub:11} {n} files")

    print(f"api tree: {total // (1024 * 1024)} MB -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
