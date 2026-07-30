#!/usr/bin/env python3
"""Lay the generated data out by CAR: data/chassis/<CHASSIS>/<ECU>/.

The generators write one file per SGBD per kind (data/job-code/msd80.json,
data/job-meta/msd80.json, ...). This gathers them into one folder per ECU per
chassis, so everything about MSD80 in an E90 is in one place.

    python3 tools/export/build_ecu_tree.py            # all chassis
    python3 tools/export/build_ecu_tree.py E46 E90    # just these

Reads the .json working copies, so run scripts/setup/data-cache.sh expand
first if you have cleaned them.

An SGBD used by several cars is written into each of them: 310 distinct ECUs
become 1022 folders. That is the cost of the layout, paid once here rather
than by hand.
"""
import os
import sys
import json
import gzip
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "sgbd"))
ROOT = os.path.join(HERE, "..", "..")
import ecu_tree as T                                          # noqa: E402

# what lands in an ECU folder, and where it comes from
SOURCES = [
    ("job-code.json",  "job-code"),
    ("meta.json",      "job-meta"),
    ("tables.json",    "sgbd-tables"),
    ("specs.json",     "job-specs"),
]


# One copy per SGBD of everything the tree fans out. This is what is
# COMMITTED -- the tree itself is derived and gitignored, and storing it
# instead would put the 2.7x duplication into git permanently (252 MB against
# 32 MB here).
SRC = os.path.join(ROOT, "data", "ecu-src")

# tree filename -> the name it has in ecu-src
# the generator's directory name -> the file it becomes in an ECU folder
SRC_NAME = {
    "job-code": "job-code.json.gz",
    "job-meta": "meta.json.gz",
    "sgbd-tables": "tables.json.gz",
    "job-specs": "specs.json.gz",
}


def load(kind, sgbd):
    """A generator's output for one SGBD, decompressed."""
    name = SRC_NAME.get(kind)
    if name:
        p = os.path.join(SRC, f"{sgbd}.{name}")
        if os.path.exists(p):
            with gzip.open(p, "rb") as f:
                return f.read()
    # legacy flat folders, if someone still has them
    base = os.path.join(ROOT, "data", kind, f"{sgbd}.json")
    for q in (base, base + ".gz"):
        if os.path.exists(q):
            op = gzip.open if q.endswith(".gz") else open
            with op(q, "rb") as f:
                return f.read()
    return None


def ir_for(code, sgbd, stems):
    """The IR is named by IPO stem, which is the ECU code or an SGBD stem."""
    cand = [code.lower(), sgbd]
    for suf in ("ds0", "ds2", "ds1", "_n", "ds"):
        if sgbd.endswith(suf):
            cand.append(sgbd[:-len(suf)])
    for c in cand:
        if c in stems:
            return stems[c]
    return None


def main():
    want = {a.upper() for a in sys.argv[1:] if not a.startswith("-")}

    ir_dir = os.path.join(ROOT, "data", "inpa-ir")
    stems = {}
    if os.path.isdir(ir_dir):
        for f in os.listdir(ir_dir):
            if f.endswith(".json"):
                stems[f[:-5].lower()] = os.path.join(ir_dir, f)
            elif f.endswith(".json.gz"):
                stems.setdefault(f[:-8].lower(), os.path.join(ir_dir, f))

    i18n_dir = os.path.join(ROOT, "data", "inpa-i18n")
    i18n = {f[:-5].lower(): os.path.join(i18n_dir, f)
            for f in os.listdir(i18n_dir)} if os.path.isdir(i18n_dir) else {}

    # fault maps declare the sgbd they cover
    faults = {}
    for p in [q for d in os.walk(os.path.join(ROOT, "data", "faults"))
              for q in (os.path.join(d[0], f) for f in d[2])
              if q.endswith(".json")]:
        try:
            with open(p) as f:
                faults[(json.load(f).get("sgbd") or "").lower()] = p
        except (OSError, ValueError):
            pass

    n_ecu = n_file = 0
    for cid, ecus in sorted(_by_chassis().items()):
        if want and cid.upper() not in want:
            continue
        for code, sgbd, meta in ecus:
            d = os.path.join(T.TREE, cid, code)
            os.makedirs(d, exist_ok=True)
            put = lambda name, payload: _write(d, name, payload)   # noqa: E731

            put("ecu.json", json.dumps(meta, ensure_ascii=False,
                                       separators=(",", ":")).encode())
            n_file += 1
            for name, kind in SOURCES:
                b = load(kind, sgbd)
                if not b:
                    continue
                # job-code is BEST2 bytecode as JSON: 1.26 GB across the tree
                # raw, 4% of that gzipped, and it is read by machines rather
                # than by eye. Everything else stays plain text so the folder
                # is still worth opening.
                if name == "job-code.json":
                    put(name + ".gz", gzip.compress(b, 6))
                else:
                    put(name, b)
                n_file += 1
            p = ir_for(code, sgbd, stems)
            if p:
                b = (gzip.open(p, "rb") if p.endswith(".gz")
                     else open(p, "rb")).read()
                put("screens.json", b)
                n_file += 1
            for src, name in ((i18n, "i18n.json"), (faults, "faults.json")):
                q = src.get(code.lower()) or src.get(sgbd)
                if q:
                    with open(q, "rb") as f:
                        put(name, f.read())
                    n_file += 1
            n_ecu += 1
        print(f"  {cid:6} {len(ecus):3} ecus")

    # -- ECUs no chassis claims ---------------------------------------------
    # data/inpa-ir holds 832 decompiled ECUs; only ~356 are named by a chassis
    # config. The rest are real decompiler output for ECUs INPA ships but no
    # car in CFGDAT references: other models, other markets, or variants BMW
    # never wired into a chassis file. They do not ship, but dropping them
    # from the tree would make the layout a lie -- "everything we decompiled"
    # would silently mean "everything some car mentions".
    if not want:
        claimed = set()
        for cid, ecus in _by_chassis().items():
            for code, sgbd, _ in ecus:
                claimed.add(code.lower())
                claimed.add(sgbd)
        # BMW also ships an .IPO per CAR, not per ECU: the whole-vehicle
        # screens you see before picking a module (E90.IPO is a two-screen
        # "ID Lesen / Anzeigen / Drucken" page, e46.IPO an Information /
        # Fehlerspeicher menu). They are not ECUs and do not belong beside
        # one, so they get their own bucket rather than being swept into
        # other/ with the genuine orphans.
        chassis_ids = {os.path.basename(q)[:-5].upper()
                       for q in glob.glob(os.path.join(T.CONFIG, "*.json"))} - {"INDEX"}

        def bucket(stem_name):
            u = stem_name.upper()
            if u in chassis_ids or any(u.startswith(c + "_") for c in chassis_ids):
                return "vehicle"
            return "other"

        n_other = 0
        counts = {}
        for stem, p in sorted(stems.items()):
            if stem in claimed:
                continue
            name0 = os.path.basename(p).split(".")[0]
            d = os.path.join(T.TREE, bucket(name0), name0)
            os.makedirs(d, exist_ok=True)
            b = (gzip.open(p, "rb") if p.endswith(".gz") else open(p, "rb")).read()
            _write(d, "screens.json", b)
            kind0 = bucket(name0)
            _write(d, "ecu.json", json.dumps(
                {"code": name0, "sgbd": stem, "chassis": None,
                 "kind": kind0,
                 "note": ("INPA's whole-vehicle screens for this car, not an "
                          "ECU") if kind0 == "vehicle" else
                         "decompiled, but no chassis config references it"},
                ensure_ascii=False, separators=(",", ":")).encode())
            n_file += 2
            # a handful do have compiled code and metadata
            for name, kind in SOURCES:
                raw = load(kind, stem)
                if not raw:
                    continue
                if name == "job-code.json":
                    _write(d, name + ".gz", gzip.compress(raw, 6))
                else:
                    _write(d, name, raw)
                n_file += 1
            counts[kind0] = counts.get(kind0, 0) + 1
            n_other += 1
        for b in ("other", "vehicle"):
            if counts.get(b):
                what = ("no chassis references them" if b == "other"
                        else "whole-vehicle INPA screens, not ECUs")
                print(f"  {b:7} {counts[b]:3} ({what})")
        if n_other:
            n_ecu += n_other

    print(f"\n{n_ecu} ecu folders, {n_file} files -> data/chassis/")
    return 0


def _write(d, name, payload):
    with open(os.path.join(d, name), "wb") as f:
        f.write(payload)


def _by_chassis():
    """{chassis: [(code, sgbd, ecu_meta), ...]} from the resolved config."""
    import glob
    out = {}
    for p in sorted(glob.glob(os.path.join(T.CONFIG, "*.json"))):
        cid = os.path.basename(p)[:-5]
        if cid == "index":
            continue
        with open(p) as f:
            cfg = json.load(f)
        rows = []
        for sec in cfg.get("sections", []):
            for e in sec.get("ecus", []):
                sgbd = (e.get("sgbd") or "").lower()
                if not sgbd:
                    continue
                rows.append((e["code"], sgbd, {
                    "code": e["code"], "label": e.get("label"),
                    "section": sec.get("name"), "sgbd": sgbd,
                    "group": e.get("group"), "chassis": cid}))
        out[cid] = rows
    return out


if __name__ == "__main__":
    sys.exit(main())
