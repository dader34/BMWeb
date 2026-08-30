#!/usr/bin/env python3
"""Derive the ORPHAN SGBDs -- every .prg BMW ships that no chassis config names.

The app is a straight .IPO emulator: a group's IDENTIFIKATION runs live over the
wire and the ECU names its own variant, so whatever the wire resolves to must
have its data present. ecu_tree.all_sgbds() is the whole corpus (~1006 .prg);
ecu_tree.owners() is only the ~427 an INPA menu or a group's tables name. The
difference are ORPHANS: real, derivable .prg with no chassis home, so nothing
packed them into a .chassis archive and nothing listed them in ecu-index.json --
loadEcu(<orphan>) 404s, and the live resolve dead-ends on data that was never
shipped.

This writes each orphan's derived data into data/ecu-src/ -- the COMMITTED,
per-SGBD source that build_ecu_tree.py fans out and web_export.py packs. The
three kinds are exactly what an owned SGBD carries:

    <sgbd>.job-code.json.gz   the VM's op array   (sgbd_code.export, offline)
    <sgbd>.meta.json.gz       job/result schema   (sgbd_meta.parse, offline)
    <sgbd>.tables.json.gz     SGBD tables         (_prg_tables off the .prg)

Everything here is OFFLINE: the embedded engine reads the .prg from vendor/, no
running app, no BMACW_PORT, no cable. web_export.py then packs the orphans into a
synthetic "_SGBD" catch-all .chassis and indexes them, so loadEcu(any_shipped)
resolves.

    python3 tools/export/orphan_ecus.py            # derive every orphan
    python3 tools/export/orphan_ecus.py 02dde701   # a named subset (still
                                                     # only if it IS an orphan)
    python3 tools/export/orphan_ecus.py --list      # just print the orphan set

A handful of .prg genuinely will not load ("no such SGBD", a malformed
container): those are collected, printed, and make the exit nonzero, but never
abort the sweep -- a partial derivation you know about beats one you find in
production.
"""
import os
import glob
import sys
import gzip
import json
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, os.path.join(HERE, "..", "sgbd"))
sys.path.insert(0, HERE)

import ecu_tree as ET                                          # noqa: E402
import sgbd_spec as SP                                         # noqa: E402
import sgbd_code as C                                          # noqa: E402
import sgbd_meta as M                                          # noqa: E402
from sgbd_export import _prg_tables                            # noqa: E402

SRC = os.path.join(ROOT, "data", "ecu-src")


def orphans():
    """all_sgbds() - owners(): the corpus minus every SGBD a car claims."""
    return sorted(set(ET.all_sgbds()) - set(ET.owners().keys()))


def _write_gz(sgbd, kind, payload):
    """payload -> data/ecu-src/<sgbd>.<kind>.json.gz (bytes or str)."""
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    dest = os.path.join(SRC, f"{sgbd}.{kind}.json.gz")
    with open(dest, "wb") as f:
        f.write(gzip.compress(payload, 6))
    return len(payload)


def derive_one(sgbd):
    """Write job-code + meta + tables for one orphan. Returns a summary dict.

    Any single kind that fails to derive is recorded, not fatal: an SGBD with
    job-code but no tables is still loadable and still better than a 404. The
    whole SGBD only counts as failed when it cannot be loaded at all (no .prg,
    a container the engine rejects), in which case job-code -- the one kind the
    VM cannot run without -- is absent.
    """
    r = {"sgbd": sgbd, "code": 0, "meta": 0, "tables": 0, "errors": []}
    # Load once so a broken container fails here rather than three times.
    try:
        data, _jobs = SP.load(sgbd)
    except SystemExit as e:
        r["errors"].append(f"load: {e}")
        return r
    except (ValueError, struct.error) as e:
        r["errors"].append(f"load: {type(e).__name__}: {e}")
        return r

    # -- job-code: the VM's op array. sgbd_code.export with an explicit dest
    #    bypasses write_ecu (which would DROP an orphan) and writes the gzipped
    #    blob straight to our ecu-src path, the exact format an owned SGBD's
    #    job-code.json.gz has.
    dest = os.path.join(SRC, f"{sgbd}.job-code.json.gz")
    try:
        res = C.export(sgbd, all_jobs=True, dest=dest)
        if res:
            r["code"] = res[1]        # job count
        else:
            r["errors"].append("code: no jobs")
    except SystemExit as e:
        r["errors"].append(f"code: {e}")
    except (ValueError, struct.error) as e:
        r["errors"].append(f"code: {type(e).__name__}: {e}")

    # -- meta: job/result/argument schema, read straight from the .prg
    #    description block. sgbd_meta.export writes through write_ecu (drops
    #    orphans), so parse() directly and gzip to ecu-src ourselves.
    try:
        meta = M.parse(data)
        if meta.get("jobs"):
            meta["format"] = 1
            meta["sgbd"] = sgbd
            r["meta"] = _write_gz(sgbd, "meta", json.dumps(
                meta, ensure_ascii=False, separators=(",", ":")))
        else:
            r["errors"].append("meta: no jobs")
    except (ValueError, struct.error) as e:
        r["errors"].append(f"meta: {type(e).__name__}: {e}")

    # -- tables: every table the .prg carries, parsed OFFLINE off the container
    #    (the same code path --groups uses for group-local tables, validated
    #    cell-for-cell against the engine). A .prg with no tables is normal.
    path = SP.S.sgbd_path(sgbd)
    if path and os.path.exists(path):
        try:
            tables = _prg_tables(path)
            if tables:
                r["tables"] = _write_gz(sgbd, "tables", json.dumps(
                    tables, ensure_ascii=False, separators=(",", ":")))
        except (ValueError, struct.error) as e:
            r["errors"].append(f"tables: {type(e).__name__}: {e}")
    return r


def main():
    argv = sys.argv[1:]
    if "--list" in argv:
        for o in orphans():
            print(o)
        print(f"\n{len(orphans())} orphans", file=sys.stderr)
        return 0
    named = [a.lower() for a in argv if not a.startswith("--")]
    # --missing: every corpus SGBD with no job code in ecu-src, OWNED OR NOT.
    # A car's group can identify a variant its menu never lists (telibus2 on
    # the E46's D_00C8, the whole GS8/DDE family on D_0032/D_0012); owners()
    # claims those, so they were not orphans, and the IR-filtered lifter gave
    # them one job and nothing was written. 53 SGBDs, all in car configs,
    # all identifiable on the wire, all "not in build". Same derivation as
    # an orphan: all jobs, offline, into the committed source.
    if "--missing" in sys.argv:
        have = {os.path.basename(f).split(".")[0]
                for f in glob.glob(os.path.join(SRC, "*.job-code.json.gz"))}
        names = sorted(s for s in ET.all_sgbds() if s.lower() not in have)
        print(f"{len(names)} SGBDs without job code in ecu-src", file=sys.stderr)
        results = [derive_one(s) for s in names]
        bad = [r for r in results if not r["code"]]
        for r in results:
            print(f"  {r['sgbd']:12} code {r['code']:3} jobs  meta {r['meta']//1024:4} KB  "
                  f"tables {r['tables']//1024:4} KB" + (f"  {r['errors']}" if r["errors"] else ""))
        print(f"derived {len(results) - len(bad)}/{len(results)}", file=sys.stderr)
        return 1 if bad else 0

    orph = set(orphans())
    if named:
        # only derive names that ARE orphans -- an owned SGBD already has a car
        # folder and must not be duplicated into the catch-all
        targets = [n for n in named if n in orph]
        skipped = [n for n in named if n not in orph]
        for s in skipped:
            print(f"  {s}: not an orphan (owned by a chassis) -- skipped")
    else:
        targets = sorted(orph)
    os.makedirs(SRC, exist_ok=True)

    tot_code = tot_meta = tot_tab = 0
    n_code = n_meta = n_tab = 0
    failed = []                     # could not load the .prg at all
    partial = []                    # loaded, but job-code missing
    for i, sgbd in enumerate(targets):
        r = derive_one(sgbd)
        if r["code"]:
            n_code += 1
            tot_code += 1
        if r["meta"]:
            n_meta += 1
            tot_meta += r["meta"]
        if r["tables"]:
            n_tab += 1
            tot_tab += r["tables"]
        # a summary line per SGBD, but throttled so a 579-SGBD sweep is readable
        if r["errors"] or (i % 50 == 0):
            flag = ("  ERR " + "; ".join(r["errors"])) if r["errors"] else ""
            print(f"  [{i+1}/{len(targets)}] {sgbd:14} "
                  f"{r['code']:3} jobs  meta={'y' if r['meta'] else '-'}  "
                  f"tables={'y' if r['tables'] else '-'}{flag}")
        if not r["code"]:
            # no job-code means the VM cannot run this SGBD -- the one kind
            # that makes an ECU loadable in any useful sense
            (failed if any(e.startswith("load") for e in r["errors"])
             else partial).append((sgbd, "; ".join(r["errors"]) or "no jobs"))

    print(f"\norphans derived: {n_code} with job-code, {n_meta} with meta, "
          f"{n_tab} with tables (of {len(targets)} targeted)")
    print(f"  meta {tot_meta//1024} KB, tables {tot_tab//1024} KB")
    if partial:
        print(f"\n{len(partial)} loaded but produced NO job-code:",
              file=sys.stderr)
        for s, msg in partial[:40]:
            print(f"  {s}: {msg}", file=sys.stderr)
    if failed:
        print(f"\n{len(failed)} could not load at all:", file=sys.stderr)
        for s, msg in failed[:40]:
            print(f"  {s}: {msg}", file=sys.stderr)
    # exit nonzero when anything failed to yield job-code, so a scripted build
    # cannot mistake a partial derivation for a complete corpus
    return 1 if (failed or partial) else 0


if __name__ == "__main__":
    sys.exit(main())
