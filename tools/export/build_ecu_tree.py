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
    # the runnable twin ir_build writes beside each IR: <stem>.ipoexec.json.gz.
    # keyed the same way so ir_for() can resolve it by the same code/sgbd rules.
    xstems = {}
    if os.path.isdir(ir_dir):
        for f in os.listdir(ir_dir):
            if f.endswith(".ipoexec.json.gz"):
                xstems.setdefault(f[:-len(".ipoexec.json.gz")].lower(),
                                  os.path.join(ir_dir, f))
            elif f.endswith(".json"):
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
        except (OSError, ValueError) as e:
            # a corrupt fault map used to vanish here without a trace --
            # its ECU folders simply had no faults.json and nothing said why
            print(f"  WARNING: fault map {p} unreadable "
                  f"({type(e).__name__}: {e}) -- skipped")

    # per-kind accounting. load() returning None is normal for ONE ecu (not
    # every SGBD has specs or tables), but a kind that loads for NOBODY
    # means its source folder is gone -- the state that once wrote a whole
    # tree of hollow folders with exit 0.
    kind_hit = {kind: 0 for _, kind in SOURCES}
    kind_miss = {kind: 0 for _, kind in SOURCES}
    empty_dirs = []

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
            n_content = 0        # files besides ecu.json (which is derived
            #                      from the config, so it proves nothing)
            for name, kind in SOURCES:
                b = load(kind, sgbd)
                if not b:
                    kind_miss[kind] += 1
                    continue
                kind_hit[kind] += 1
                n_content += 1
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
                n_content += 1
            # the runnable dump ships gzipped as-is (already .gz on disk, and
            # it is machine-read and large, exactly like job-code.json.gz)
            xp = ir_for(code, sgbd, xstems)
            if xp:
                with open(xp, "rb") as f:
                    put("ipoexec.json.gz", f.read())
                n_file += 1
                n_content += 1
            for src, name in ((i18n, "i18n.json"), (faults, "faults.json")):
                q = src.get(code.lower()) or src.get(sgbd)
                if q:
                    with open(q, "rb") as f:
                        put(name, f.read())
                    n_file += 1
                    n_content += 1
            if not n_content:
                # a folder holding only ecu.json says "this ECU exists" and
                # nothing else -- every source failed to resolve for it
                empty_dirs.append(f"{cid}/{code}")
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
            # its runnable twin, if ir_build wrote one for this stem
            xp = xstems.get(stem)
            if xp:
                with open(xp, "rb") as f:
                    _write(d, "ipoexec.json.gz", f.read())
                n_file += 1
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
                kind_hit[kind] += 1
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

    # -- honesty check -------------------------------------------------------
    # The old exit was 0 no matter what: load() returning None for EVERY
    # kind still wrote a tree of ecu.json-only folders and CI deployed it.
    # Two states are unambiguously broken and fail the build:
    #   - a source kind that loaded for zero ECUs (its input folder is gone
    #     or empty -- run the generator, or data-cache.sh expand)
    #   - an ECU folder with nothing in it but ecu.json
    bad = False
    for _, kind in SOURCES:
        h, m = kind_hit[kind], kind_miss[kind]
        tag = ""
        if h == 0:
            tag = "  MISSING ENTIRELY (is data/ecu-src populated?)"
            bad = True
        print(f"  {kind:12} {h:4} loaded, {m:4} absent{tag}")
    if empty_dirs:
        bad = True
        print(f"  {len(empty_dirs)} ECU folders got NO data at all: "
              f"{', '.join(empty_dirs[:10])}"
              + (" ..." if len(empty_dirs) > 10 else ""))
    if bad:
        print("TREE INCOMPLETE: exiting 1")
        return 1
    return 0


def _write(d, name, payload):
    with open(os.path.join(d, name), "wb") as f:
        f.write(payload)


def _by_chassis():
    """{chassis: [(code, sgbd, ecu_meta), ...]} from the resolved config."""
    import glob
    out = {}
    gvars = T.group_variants()
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
                # Every variant this entry's group can IDENTIFY gets a folder
                # of its own, named for the SGBD the car reports (see
                # ecu_tree.group_variants). Without this the tree has no
                # ecu.json for them, write_ecu treats the folder as
                # unclaimed, and the module the car names stays unexported.
                #
                # The label carries the menu entry it is a variant of, so a
                # screen showing "Airbag · mrs4" still reads like the car
                # rather than like a bare SGBD name.
                own = sgbd
                for v in sorted(gvars.get((e.get("group") or "").lower(), ())):
                    if v == own or any(r[1] == v for r in rows):
                        continue
                    rows.append((v, v, {
                        "code": v, "label": f"{e.get('label')} ({v})",
                        "section": sec.get("name"), "sgbd": v,
                        "group": e.get("group"), "chassis": cid,
                        "identifiedVariantOf": e["code"]}))
        out[cid] = rows
    return out


if __name__ == "__main__":
    sys.exit(main())
