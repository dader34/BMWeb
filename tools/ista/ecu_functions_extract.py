#!/usr/bin/env python3
"""ISTA's control-unit functions: what the ECU functions window lists.

The tool's window for one control unit (Diagnosis scan, Component
triggering) does not read the INPA script at all. Per ECU variant the
database carries:

    XEP_ECUVARFUNCTIONS      the variant by name (kombi46, ms450ds0 ...)
    XEP_REFECUFUNCSTRUCTS    -> its function groups
    XEP_ECUFUNCSTRUCTURES    the groups: ECUStateReadStructure (reads, the
                             "ECU function" list) and
                             ECUControllingActuatorStructure (actuators, the
                             "Component" list)
    XEP_ECUFIXEDFUNCTIONS    the leaves under a group (PARENTID), English
                             titled, e.g. "Terminal 15", "Fuel gauge"
    XEP_REFECUJOBS/ECUJOBS   the EDIABAS job a leaf runs (NAME)
    XEP_ECUPARAMETERS        the job's arguments, P1.. in order
    XEP_REFECURESULTS/ECURESULTS  the results the leaf shows, with their
                             English title, unit and format

So the window can be driven by the same data the tool uses, in English,
and each leaf is one job the app's VM already runs. Output, per variant:

    data/ista/ecufn/<variant>.json.gz
      {variant, title, reads: [group], acts: [group]}
      group = {title, items: [{title, job, args, results: [{name, title,
               unit, fmt}], ms}]}
    data/ista/ecufn/index.json   {variant: {title, reads, acts}}

Only the variants named in data/chassis-config/*.json are written (the
ones the app can open), unless --all.
"""
import argparse
import glob
import gzip
import json
import os
import sqlite3
import sys

READ_CLASS = "ECUStateReadStructure"
ACT_CLASS = "ECUControllingActuatorStructure"
# results every job carries and no window shows
SKIP_RESULTS = {"JOB_STATUS", "SAETZE", "_TEL_ANTWORT", "_TEL_AUFTRAG"}


def config_variants(root):
    """Every SGBD name the chassis configs mention, lowercased.

    @param root: the repo root
    """
    names = set()

    def walk(x):
        if isinstance(x, dict):
            if x.get("sgbd"):
                names.add(str(x["sgbd"]).lower())
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    for f in glob.glob(os.path.join(root, "data/chassis-config/*.json")):
        with open(f, encoding="utf-8") as fh:
            walk(json.load(fh))
    return names


def clean_title(t):
    """A group title without the "- " the tool prefixes its tree rows with.

    @param t: the stored title
    """
    t = (t or "").strip()
    return t[2:] if t.startswith("- ") else t


def extract_variant(con, var_id):
    """The window's two lists for one variant function id.

    @param con: an open DiagDocDb connection
    @param var_id: XEP_ECUVARFUNCTIONS.ID
    """
    groups = con.execute(
        "SELECT g.ID, n.NAME, g.TITLE_ENGB, g.SORT_ORDER "
        "FROM XEP_REFECUFUNCSTRUCTS r "
        "JOIN XEP_ECUFUNCSTRUCTURES g ON g.ID=r.ECUFUNCSTRUCTID "
        "JOIN XEP_NODECLASSES n ON n.ID=g.NODECLASS "
        "WHERE r.ID=? ORDER BY g.SORT_ORDER, g.ID",
        (var_id,),
    ).fetchall()
    reads, acts = [], []
    for gid, cls, gtitle, _order in groups:
        items = []
        leaves = con.execute(
            "SELECT l.ID, l.TITLE_ENGB, l.ACTIVATION_DURATION_MS "
            "FROM XEP_ECUFIXEDFUNCTIONS l WHERE l.PARENTID=? "
            "ORDER BY l.SORT_ORDER, l.ID",
            (gid,),
        ).fetchall()
        for lid, ltitle, ms in leaves:
            job = con.execute(
                "SELECT j.ID, j.NAME FROM XEP_REFECUJOBS rj "
                "JOIN XEP_ECUJOBS j ON j.ID=rj.ECUJOBID "
                "WHERE rj.ID=? ORDER BY rj.RANK LIMIT 1",
                (lid,),
            ).fetchone()
            if not job:
                continue
            jid, jname = job
            params = con.execute(
                "SELECT NAME, PARAMVALUE FROM XEP_ECUPARAMETERS "
                "WHERE ECUJOBID=? ORDER BY NAME",
                (jid,),
            ).fetchall()
            args = ";".join(str(v if v is not None else "") for _n, v in params)
            results = []
            for rname, rtitle, unit, uname, fmt in con.execute(
                "SELECT res.NAME, res.TITLE_ENGB, res.UNIT, res.UNITNAME, "
                "res.FORMAT FROM XEP_REFECURESULTS rr "
                "JOIN XEP_ECURESULTS res ON res.ID=rr.ECURESULTID "
                "WHERE rr.ID=? ORDER BY res.NAME",
                (lid,),
            ):
                if not rname or rname.upper() in SKIP_RESULTS:
                    continue
                row = {"name": rname, "title": rtitle or rname}
                u = uname or unit
                if u:
                    row["unit"] = str(u)
                if fmt:
                    row["fmt"] = str(fmt)
                results.append(row)
            item = {"title": ltitle or jname, "job": jname, "args": args}
            if results:
                item["results"] = results
            if ms:
                item["ms"] = int(ms)
            items.append(item)
        if not items:
            continue
        group = {"title": clean_title(gtitle), "items": items}
        (reads if cls == READ_CLASS else acts).append(group)
    return reads, acts


def write_json_gz(path, obj):
    """Write compact JSON, gzipped, deterministically.

    @param path: destination
    @param obj: the value
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    with gzip.GzipFile(path, "wb", mtime=0) as fh:
        fh.write(raw.encode("utf-8"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--diagdoc", required=True, help="DiagDocDb.decrypted.sqlite")
    ap.add_argument("--out", default="data/ista/ecufn", help="output folder")
    ap.add_argument("--all", action="store_true", help="every variant, not just the configs'")
    ap.add_argument("--only", help="one variant name, for a smoke run")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    con = sqlite3.connect(f"file:{args.diagdoc}?mode=ro", uri=True)
    wanted = None if args.all else config_variants(root)
    if args.only:
        wanted = {args.only.lower()}
    index = {}
    stats = {"variants": 0, "reads": 0, "acts": 0, "no_data": []}
    rows = con.execute(
        "SELECT v.ID, v.NAME, COALESCE(e.TITLE_ENGB, '') FROM XEP_ECUVARFUNCTIONS v "
        "LEFT JOIN XEP_ECUVARIANTS e ON lower(e.NAME)=lower(v.NAME)"
    ).fetchall()
    seen = set()
    for vid, name, title in rows:
        key = (name or "").lower()
        if not key or key in seen:
            continue
        if wanted is not None and key not in wanted:
            continue
        reads, acts = extract_variant(con, vid)
        if not reads and not acts:
            stats["no_data"].append(key)
            continue
        seen.add(key)
        n_r = sum(len(g["items"]) for g in reads)
        n_a = sum(len(g["items"]) for g in acts)
        write_json_gz(
            os.path.join(args.out, f"{key}.json.gz"),
            {"variant": key, "title": title, "reads": reads, "acts": acts},
        )
        index[key] = {"title": title, "reads": n_r, "acts": n_a}
        stats["variants"] += 1
        stats["reads"] += n_r
        stats["acts"] += n_a
        if args.verbose:
            print(f"  {key:12} {n_r:4} reads {n_a:4} actuators", file=sys.stderr)
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, sort_keys=True, indent=1)
    if wanted is not None:
        stats["missing"] = sorted(wanted - seen)
    print(json.dumps({k: v for k, v in stats.items() if k != "no_data"}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
