#!/usr/bin/env python3
"""Freeze the app's API surface into static .chassis and .ecu ZIP archives.

Instead of writing thousands of separate JSON files, this tool packages:
- All assets for a single ECU (jobs, results, arguments, tables, IR, VM bytecode, SGBD tables) into `api/ecu/<sgbd>.ecu` (ZIP format).
- All ECUs for a chassis, along with its resolved configuration, into `api/chassis/<chassisId>.chassis` (ZIP format).
"""
import os
import sys
import json
import glob
import shutil
import urllib.request
import zipfile
import io
import gzip

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
CACHE = os.path.join(ROOT, "data", "chassis-config")
ECU_SRC = os.path.join(ROOT, "data", "ecu-src")

# The synthetic chassis id the orphan SGBDs are packed under. Not a real car:
# it is the catch-all that makes loadEcu(<any shipped SGBD>) resolve for the
# ~579 .prg no chassis config names. loadChassis uppercases the id, so this
# lives at api/chassis/_SGBD.chassis and ecu-index.json points orphans at it.
SGBD_CATCHALL = "_SGBD"

# every request that fell back to the committed cache while the app WAS
# running -- a mix of fresh and stale configs in one export must be loud
FALLBACKS = []

sys.path.insert(0, os.path.join(HERE, "..", "sgbd"))
import ecu_tree as T                                          # noqa: E402


def _orphan_sgbds():
    """Every .prg BMW ships that no chassis config names: the app must be able
    to load ANY shipped SGBD by name, because the live IDENTIFIKATION can
    resolve to a variant no menu ever listed. all_sgbds() is the corpus,
    owners() is what a car claims; the difference are the orphans."""
    return sorted(set(T.all_sgbds()) - set(T.owners().keys()))


def _ecu_src_read(sgbd, tree_name):
    """Decompressed bytes of one derived kind for an ORPHAN, from data/ecu-src.

    Orphans have no per-car folder, so their data lives only in the committed
    per-SGBD source (data/ecu-src/<sgbd>.<kind>.json.gz, always gzipped).
    Maps the tree filename build_ecu_contents asks for onto the ecu-src name.
    """
    kind = {
        "meta.json": "meta",
        "tables.json": "tables",
        "job-code.json.gz": "job-code",
        "screens.json": None,          # orphans carry no decompiled IR
        "ipoexec.json.gz": None,       # ... and no runnable twin of it either
    }.get(tree_name, None)
    if kind is None:
        return None
    p = os.path.join(ECU_SRC, f"{sgbd}.{kind}.json.gz")
    if not os.path.exists(p):
        return None
    with gzip.open(p, "rb") as f:
        return f.read()


def build_ecu_contents(sgbd, read):
    """Assemble one ECU's .ecu file map from a `read(tree_name) -> bytes|None`
    accessor, returning (contents, counts). Shared by the per-car tree path
    (owned SGBDs) and the ecu-src path (orphans) so the two cannot drift: the
    same jobs.json/meta/results/arguments/tables/table/ir/job-code/sgbd-tables
    layout the shim expects comes out of one place. `read` hands back the
    DECOMPRESSED bytes for a kind (job-code is stored gzipped in the tree,
    everything in ecu-src is gzipped -- the accessor hides that)."""
    ecu_contents = {}
    counts = {"jobs": 0, "results": 0, "tables": 0, "ir": 0}

    mb = read("meta.json")
    if mb:
        meta = json.loads(mb)
        jobs = meta.get("jobs", {})
        ecu_contents["jobs.json"] = json.dumps(
            sorted(jobs.keys()), separators=(",", ":"))
        counts["jobs"] = 1

        slim = {}
        for jname, j in jobs.items():
            rs = [{"name": r["name"], "comment": r.get("comment", "")}
                  for r in j.get("results", []) if r.get("name")]
            if rs:
                slim[jname.upper()] = {"results": rs}
        if slim:
            ecu_contents["meta.json"] = json.dumps(
                {"sgbd": sgbd, "jobs": slim}, separators=(",", ":"))

        for jname, j in jobs.items():
            lines = [f"{r['name']} : {r.get('comment', '')}"
                     for r in j.get("results", [])]
            if lines:
                ecu_contents[f"results/{jname.upper()}.json"] = json.dumps(
                    lines, separators=(",", ":"))
                counts["results"] += 1
            args = j.get("arguments") or []
            if args:
                rows = []
                for a in args:
                    row = {"ARG": a["name"], "ARGTYPE": a.get("type", "")}
                    for i, c in enumerate(a.get("comments", [])):
                        row[f"ARGCOMMENT{i}"] = c
                    rows.append(row)
                ecu_contents[f"arguments/{jname.upper()}.json"] = json.dumps(
                    {"job": jname, "arguments": rows}, separators=(",", ":"))

    tb = read("tables.json")
    if tb:
        tabs = json.loads(tb)
        ecu_contents["tables.json"] = json.dumps(
            sorted(tabs.keys()), separators=(",", ":"))
        for name, rows in tabs.items():
            ecu_contents[f"table/{name.upper()}.json"] = json.dumps(
                rows, separators=(",", ":"))
        # VM SGBD tables: the raw table map the walker reads at runtime
        ecu_contents["sgbd-tables.json"] = tb
        counts["tables"] = 1

    irb = read("screens.json")
    if irb:
        ecu_contents["ir.json"] = irb
        counts["ir"] = 1

    # the runnable execution-derived dump, alongside the frozen IR. Stored
    # decompressed inside the .ecu (the zip DEFLATEs it) exactly as job-code
    # and ir are -- read() hands back the decompressed bytes for it.
    xb = read("ipoexec.json.gz")
    if xb:
        ecu_contents["ipoexec.json"] = xb

    jcb = read("job-code.json.gz")
    if jcb:
        ecu_contents["job-code.json"] = jcb

    return ecu_contents, counts


def get(port, path):
    """Get the chassis config, from the running app or the committed cache."""
    if port:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",
                                         timeout=120) as r:
                return json.load(r)
        except Exception as e:
            # the app is up but this ONE request failed: serving the cached
            # copy instead silently mixes fresh and stale configs
            print(f"  WARNING: {path} failed ({type(e).__name__}: {e}); "
                  f"using the committed cache")
            FALLBACKS.append(path)
    name = "index" if path == "/api/chassis" else path.rsplit("/", 1)[-1]
    p = os.path.join(CACHE, f"{name}.json")
    if not os.path.exists(p):
        raise SystemExit(
            f"no app on 127.0.0.1:{port or '-'} and no cached {name}.json.\n"
            f"Start the app and re-run to populate {CACHE}.")
    with open(p) as f:
        return json.load(f)


def refresh_cache(port, ids):
    """Keep the committed cache in step whenever the app IS running."""
    if not port:
        return
    os.makedirs(CACHE, exist_ok=True)
    try:
        with open(os.path.join(CACHE, "index.json"), "w") as f:
            json.dump(ids, f, ensure_ascii=False, separators=(",", ":"))
        for cid in ids:
            cfg = get(port, f"/api/chassis/{cid}")
            with open(os.path.join(CACHE, f"{cid}.json"), "w") as f:
                json.dump(cfg, f, ensure_ascii=False, separators=(",", ":"))
    except Exception as e:
        print(f"  WARNING: cache refresh failed ({type(e).__name__}: {e}); "
              f"the committed chassis-config cache may be stale")
        FALLBACKS.append("cache-refresh")


def make_zip(contents_dict, compress=True):
    """Build a zip archive in memory from a dict of {rel_path: string/bytes}."""
    zip_buffer = io.BytesIO()
    compress_type = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    with zipfile.ZipFile(zip_buffer, "w", compress_type) as zf:
        for rel_path, content in contents_dict.items():
            if isinstance(content, str):
                content = content.encode("utf-8")
            zf.writestr(rel_path, content)
    return zip_buffer.getvalue()


def main():
    port = os.environ.get("BMACW_PORT")
    if not port:
        print("  (no BMACW_PORT: using cached chassis config)")
    out = os.path.join(ROOT, "dist-web")
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        if i + 1 >= len(sys.argv):
            # a trailing --out used to die with a bare IndexError
            raise SystemExit("--out needs a directory argument")
        out = sys.argv[i + 1]
    api = os.path.join(out, "api")
    os.makedirs(api, exist_ok=True)

    ids = get(port, "/api/chassis")
    refresh_cache(port, ids)

    # 1. Write the main chassis listing (plain JSON so it loads instantly)
    with open(os.path.join(api, "chassis.json"), "w") as f:
        json.dump(ids, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  chassis.json written")

    # Gather all referenced SGBDs. (The IR itself ships from the per-car
    # tree's screens.json below, so nothing here resolves IR files.)
    sgbds = set()
    chassis_configs = {}
    for cid in ids:
        cfg = get(port, f"/api/chassis/{cid}")
        chassis_configs[cid] = cfg
        for sec in cfg.get("sections", []):
            for e in sec.get("ecus", []):
                sgbd = (e.get("sgbd") or "").lower()
                if sgbd:
                    sgbds.add(sgbd)

    # EVERY SGBD ecu_tree ASSIGNS TO A CAR, not just the menu's own names. A
    # group variant a car's IDENTIFIKATION can name (ecu_tree.group_variants:
    # gs20 via d_0032, and the rest) has a per-car folder in the tree but never
    # appears in a chassis config's `sgbd` field -- so the menu-only set above
    # never built its .ecu, step 3 found nothing in ecu_zips to pack, and the
    # module the car reports resolved to a 404. The index comment downstream
    # has always CLAIMED to ship these; this is what actually builds them.
    for sgbd, places in T.owners().items():
        if places:
            sgbds.add(sgbd.lower())

    # 2. Package each ECU into its own .ecu (zip) archive
    ecu_zips = {}
    njobs = nres = ntab = nir = 0
    os.makedirs(os.path.join(api, "ecu"), exist_ok=True)

    for sgbd in sorted(sgbds):
        # EVERYTHING COMES FROM THE PER-CAR TREE. data/chassis/<C>/<ECU>/ is
        # the source of truth now; the flat per-kind folders it was built from
        # are gone. tree_read() finds the file in whichever car folder holds
        # this SGBD -- the copies are written together, so any one will do --
        # and returns its DECOMPRESSED bytes so build_ecu_contents does not
        # have to know whether a kind is stored gzipped (job-code) or plain.
        def tree_read(name, _sgbd=sgbd):
            for d in T.ecu_dirs(_sgbd):
                q = os.path.join(d, name)
                if os.path.exists(q):
                    if q.endswith(".gz"):
                        with gzip.open(q, "rb") as f:
                            return f.read()
                    with open(q, "rb") as f:
                        return f.read()
            return None

        ecu_contents, counts = build_ecu_contents(sgbd, tree_read)
        njobs += counts["jobs"]
        nres += counts["results"]
        ntab += counts["tables"]
        nir += counts["ir"]

        # Build the .ecu zip. Held in memory only: every one of these goes
        # inside its chassis archive below, and writing them loose as well
        # duplicated all 310 for 47 MB with nothing reading them -- the shim
        # takes an ECU from the chassis bundle it already has cached.
        if ecu_contents:
            ecu_zips[sgbd] = make_zip(ecu_contents, compress=True)

    # 2b. THE ORPHANS. Every .prg BMW ships but no chassis config names --
    # ecu_tree.all_sgbds() minus ecu_tree.owners(). The app is a straight .IPO
    # emulator: a group's IDENTIFIKATION runs live and the ECU names its own
    # variant, so whatever the wire resolves to must have its data present, not
    # just the variants a menu happens to list. On a real E46 the airbag group
    # answered mrs4, the climate group ihka46_3 -- neither in any menu, both
    # orphans -- and without this they loadEcu-404, so the module identified
    # correctly and then could not read a single fault. Their data is derived
    # OFFLINE into data/ecu-src by tools/export/orphan_ecus.py; read it the same
    # way build_ecu_contents reads an owned SGBD, then pack them all into one
    # synthetic "_SGBD" chassis below (step 3b) and index them (step 3c).
    orphan_zips = {}
    n_orphan = 0
    for sgbd in _orphan_sgbds():
        def src_read(name, _sgbd=sgbd):
            return _ecu_src_read(_sgbd, name)
        ecu_contents, counts = build_ecu_contents(sgbd, src_read)
        # job-code is the one kind the VM cannot run without; an orphan with no
        # job-code is not loadable in any useful sense, so it does not ship
        if "job-code.json" not in ecu_contents:
            continue
        njobs += counts["jobs"]
        nres += counts["results"]
        ntab += counts["tables"]
        orphan_zips[sgbd] = make_zip(ecu_contents, compress=True)
        n_orphan += 1
    ecu_zips.update(orphan_zips)

    print(f"  packaged {len(ecu_zips)} .ecu archives "
          f"({n_orphan} orphans; {njobs} jobs, {nres} result schemas, "
          f"{ntab} tables, {nir} IRs)")

    # 3. Package each chassis configuration and its ECUs into a .chassis archive
    os.makedirs(os.path.join(api, "chassis"), exist_ok=True)
    # WHAT EACH CHASSIS ACTUALLY SHIPS, recorded as it is packed so the index
    # below indexes reality rather than the menu (see ecu-index.json).
    chassis_ecus = {}
    # every SGBD ecu_tree assigns to a car -- the menu's own names PLUS every
    # variant that car's groups can identify (ecu_tree.group_variants)
    tree_owner = {}
    for sgbd, places in T.owners().items():
        for c, _code in places:
            tree_owner.setdefault(c.upper(), set()).add(sgbd.lower())

    for cid in ids:
        cfg = chassis_configs[cid]
        chassis_contents = {
            "config.json": json.dumps(cfg, separators=(",", ":"))
        }

        # Pack referenced SGBD .ecu files
        want = set()
        for sec in cfg.get("sections", []):
            for e in sec.get("ecus", []):
                sgbd = (e.get("sgbd") or "").lower()
                if sgbd:
                    want.add(sgbd)
        want |= tree_owner.get(cid.upper(), set())
        packed = set()
        for sgbd in sorted(want):
            if sgbd in ecu_zips:
                chassis_contents[f"ecu/{sgbd}.ecu"] = ecu_zips[sgbd]
                packed.add(sgbd)
        chassis_ecus[cid] = packed

        # Build .chassis ZIP. We use STORED mode since the internal .ecu files are already zipped.
        chassis_zip_bytes = make_zip(chassis_contents, compress=False)
        with open(os.path.join(api, "chassis", f"{cid}.chassis"), "wb") as f:
            f.write(chassis_zip_bytes)

    # 3b. THE ORPHAN CATCH-ALL. Every orphan .ecu (packed in step 2b) goes
    # into one synthetic "_SGBD" chassis, so loadEcu(<orphan>) resolves through
    # exactly the same path an owned SGBD does: ecu-index.json names _SGBD, the
    # shim downloads _SGBD.chassis once, and every orphan is then cached. It
    # carries an empty config so cacheChassis' `config.json` requirement is met;
    # nothing renders a menu from it -- it is reached only by name via loadEcu.
    orphan_packed = set()
    if orphan_zips:
        catchall_contents = {"config.json": json.dumps(
            {"chassis": SGBD_CATCHALL, "sections": [],
             "note": "synthetic catch-all: every .prg no chassis config names, "
                     "so the live IDENTIFIKATION always lands on shipped data"},
            separators=(",", ":"))}
        for sgbd in sorted(orphan_zips):
            catchall_contents[f"ecu/{sgbd}.ecu"] = orphan_zips[sgbd]
            orphan_packed.add(sgbd)
        catchall_bytes = make_zip(catchall_contents, compress=False)
        with open(os.path.join(api, "chassis",
                               f"{SGBD_CATCHALL}.chassis"), "wb") as f:
            f.write(catchall_bytes)
        print(f"  packaged {SGBD_CATCHALL}.chassis "
              f"({len(orphan_packed)} orphan ECUs, "
              f"{len(catchall_bytes)//(1024*1024)} MB)")

    print(f"  packaged {len(ids)} .chassis archives"
          + (f" + {SGBD_CATCHALL}" if orphan_packed else ""))

    # Which car owns each SGBD. ECUs live only inside their chassis archive,
    # so opening one the shim has not cached means finding its owner; without
    # this it would try chassis archives in turn, downloading up to 122 MB to
    # find a 116 KB ECU. 5 KB answers it in one lookup.
    # BUILT FROM WHAT THE ARCHIVES HOLD, NOT FROM THE MENU. This used to walk
    # the chassis configs, so it could only ever list SGBDs a menu names --
    # the same gate ecu_tree.owners() had. Every variant a group can IDENTIFY
    # but the menu never listed (ihka46_3, gs20, mrs4 ...) was packaged into
    # the .chassis archives and then left out of the index, so loadEcu could
    # not find its owner and webRunJob answered "no job code shipped".
    #
    # On a real E46 that meant the climate unit identified correctly as
    # ihka46_3 and then reported a CLEAN FAULT MEMORY for a module holding two
    # present faults -- the worst thing this app can say. ecu_zips is what was
    # actually written, so index that.
    owner = {}
    for cid in ids:
        for sgbd in sorted(chassis_ecus.get(cid, ())):
            if sgbd not in owner:
                owner[sgbd] = cid
    # THE ORPHANS point at the synthetic catch-all. A real chassis always wins
    # (an orphan is by definition unowned, so this only ever adds new keys) --
    # keeping the guard means a future name collision surfaces as a real chassis
    # owner rather than being silently redirected into _SGBD.
    for sgbd in sorted(orphan_packed):
        owner.setdefault(sgbd, SGBD_CATCHALL)
    with open(os.path.join(api, "ecu-index.json"), "w") as f:
        json.dump(owner, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  ecu-index.json: {len(owner)} sgbds "
          f"({len(orphan_packed)} via {SGBD_CATCHALL})")

    # 4. Copy the global job-code index
    src_idx = os.path.join(ROOT, "data", "job-code", "index.json")
    if os.path.exists(src_idx):
        dst_dir = os.path.join(out, "data", "job-code")
        os.makedirs(dst_dir, exist_ok=True)
        shutil.copyfile(src_idx, os.path.join(dst_dir, "index.json"))
        print("  copied data/job-code/index.json")

    # 5. Ship the group SGBDs whole: data/groups/<g>.json.gz (VM bytecode +
    #    group-local tables), variants.json (the t_grtb assignment table),
    #    index.json (the fetch-gate manifest). This is how the renderer
    #    resolves a diagnostic address to a concrete variant -- run the
    #    group's IDENTIFIKATION in bestvm, look the answer up in variants --
    #    so a build without them can only open an ECU it was already told
    #    about. The renderer fetches these paths directly (they are already
    #    gzipped), so they copy as-is rather than going through the .ecu
    #    archives. Regenerate with: sgbd_export.py --groups.
    problems = []
    groups_src = os.path.join(ROOT, "data", "groups")
    gfiles = sorted(glob.glob(os.path.join(groups_src, "*.json.gz")))
    extras = [p for p in (os.path.join(groups_src, "variants.json"),
                          os.path.join(groups_src, "index.json"))
              if os.path.exists(p)]
    if gfiles and len(extras) == 2:
        gdst = os.path.join(out, "data", "groups")
        os.makedirs(gdst, exist_ok=True)
        for p in gfiles + extras:
            shutil.copyfile(p, os.path.join(gdst, os.path.basename(p)))
        print(f"  copied {len(gfiles)} group SGBDs + variants.json")
    else:
        # data/groups is generated (sgbd_export.py --groups) and currently
        # GITIGNORED (data/* with no carve-out), so a checkout that never
        # ran the exporter -- the Pages build -- has nothing to copy. That
        # ships a build whose group resolution dead-ends on fetch, which is
        # the broken-dist-web pattern again: fail, do not warn-and-exit-0.
        problems.append(
            f"data/groups incomplete ({len(gfiles)} .json.gz, "
            f"{len(extras)}/2 of variants.json+index.json): run "
            "sgbd_export.py --groups, and commit the outputs once "
            ".gitignore carves data/groups out of data/*")

    total_size = sum(
        os.path.getsize(os.path.join(dirpath, filename))
        for dirpath, _, filenames in os.walk(api)
        for filename in filenames
    )
    print(f"api tree: {total_size // (1024 * 1024)} MB -> {out}")
    if problems:
        print("EXPORT INCOMPLETE:")
        for p in problems:
            print(f"  - {p}")
        if "--allow-partial" not in sys.argv:
            print("  exiting 1; pass --allow-partial to ship without "
                  "group resolution")
            return 1
        print("  continuing anyway (--allow-partial)")
    if FALLBACKS:
        print(f"  WARNING: {len(FALLBACKS)} request(s) fell back to the "
              f"committed cache: {', '.join(FALLBACKS[:8])}"
              + (" ..." if len(FALLBACKS) > 8 else ""))
        # the app WAS running and some requests still came from the cache:
        # the api tree now mixes fresh and stale configs, which is the
        # dist-web regression this warning was written about. A WARNING
        # that exits 0 is how it shipped -- fail instead. (A run with no
        # BMACW_PORT at all reads the cache uniformly and records no
        # fallbacks, so the offline CI path is untouched.)
        if "--allow-stale" not in sys.argv:
            print("  exiting 1; pass --allow-stale to accept the mixed tree")
            return 1
        print("  continuing anyway (--allow-stale)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
