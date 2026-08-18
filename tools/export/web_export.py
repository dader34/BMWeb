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

# every request that fell back to the committed cache while the app WAS
# running -- a mix of fresh and stale configs in one export must be loud
FALLBACKS = []

sys.path.insert(0, os.path.join(HERE, "..", "sgbd"))
import ecu_tree as T                                          # noqa: E402


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

    # 2. Package each ECU into its own .ecu (zip) archive
    ecu_zips = {}
    njobs = nres = ntab = nir = 0
    os.makedirs(os.path.join(api, "ecu"), exist_ok=True)

    for sgbd in sorted(sgbds):
        ecu_contents = {}

        # EVERYTHING COMES FROM THE PER-CAR TREE. data/chassis/<C>/<ECU>/ is
        # the source of truth now; the flat per-kind folders it was built from
        # are gone. src() finds the file in whichever car folder holds this
        # SGBD -- the copies are written together, so any one of them will do.
        def src(name):
            for d in T.ecu_dirs(sgbd):
                q = os.path.join(d, name)
                if os.path.exists(q):
                    return q
            return None

        mp = src("meta.json")
        if mp:
            with open(mp) as f:
                meta = json.load(f)
            jobs = meta.get("jobs", {})
            ecu_contents["jobs.json"] = json.dumps(sorted(jobs.keys()), separators=(",", ":"))
            njobs += 1

            slim = {}
            for jname, j in jobs.items():
                rs = [{"name": r["name"], "comment": r.get("comment", "")}
                      for r in j.get("results", []) if r.get("name")]
                if rs:
                    slim[jname.upper()] = {"results": rs}
            if slim:
                ecu_contents["meta.json"] = json.dumps({"sgbd": sgbd, "jobs": slim}, separators=(",", ":"))

            for jname, j in jobs.items():
                lines = [f"{r['name']} : {r.get('comment', '')}" for r in j.get("results", [])]
                if lines:
                    ecu_contents[f"results/{jname.upper()}.json"] = json.dumps(lines, separators=(",", ":"))
                    nres += 1
                args = j.get("arguments") or []
                if args:
                    rows = []
                    for a in args:
                        row = {"ARG": a["name"], "ARGTYPE": a.get("type", "")}
                        for i, c in enumerate(a.get("comments", [])):
                            row[f"ARGCOMMENT{i}"] = c
                        rows.append(row)
                    ecu_contents[f"arguments/{jname.upper()}.json"] = json.dumps(
                        {"job": jname, "arguments": rows}, separators=(",", ":")
                    )

        # Load tables
        tp = src("tables.json")
        if tp:
            with open(tp) as f:
                tabs = json.load(f)
            ecu_contents["tables.json"] = json.dumps(sorted(tabs.keys()), separators=(",", ":"))
            for name, rows in tabs.items():
                ecu_contents[f"table/{name.upper()}.json"] = json.dumps(rows, separators=(",", ":"))
            ntab += 1

        # Add IR if matched
        ir_path = src("screens.json")
        if ir_path:
            with open(ir_path, "rb") as f:
                ecu_contents["ir.json"] = f.read()
            nir += 1

        # Decompress and embed the VM's job-code bytecode
        gp = src("job-code.json.gz")
        if gp:
            with gzip.open(gp, "rb") as gf:
                ecu_contents["job-code.json"] = gf.read()

        # Embed VM SGBD tables
        vmtp = src("tables.json")
        if vmtp:
            with open(vmtp, "rb") as tf:
                ecu_contents["sgbd-tables.json"] = tf.read()

        # Build the .ecu zip. Held in memory only: every one of these goes
        # inside its chassis archive below, and writing them loose as well
        # duplicated all 310 for 47 MB with nothing reading them -- the shim
        # takes an ECU from the chassis bundle it already has cached.
        if ecu_contents:
            ecu_zips[sgbd] = make_zip(ecu_contents, compress=True)

    print(f"  packaged {len(ecu_zips)} .ecu archives ({njobs} jobs, {nres} result schemas, {ntab} tables, {nir} IRs)")

    # 3. Package each chassis configuration and its ECUs into a .chassis archive
    os.makedirs(os.path.join(api, "chassis"), exist_ok=True)
    for cid in ids:
        cfg = chassis_configs[cid]
        chassis_contents = {
            "config.json": json.dumps(cfg, separators=(",", ":"))
        }

        # Pack referenced SGBD .ecu files
        for sec in cfg.get("sections", []):
            for e in sec.get("ecus", []):
                sgbd = (e.get("sgbd") or "").lower()
                if sgbd in ecu_zips:
                    chassis_contents[f"ecu/{sgbd}.ecu"] = ecu_zips[sgbd]

        # Build .chassis ZIP. We use STORED mode since the internal .ecu files are already zipped.
        chassis_zip_bytes = make_zip(chassis_contents, compress=False)
        with open(os.path.join(api, "chassis", f"{cid}.chassis"), "wb") as f:
            f.write(chassis_zip_bytes)

    print(f"  packaged {len(ids)} .chassis archives")

    # Which car owns each SGBD. ECUs live only inside their chassis archive,
    # so opening one the shim has not cached means finding its owner; without
    # this it would try chassis archives in turn, downloading up to 122 MB to
    # find a 116 KB ECU. 5 KB answers it in one lookup.
    owner = {}
    for cid in ids:
        for sec in chassis_configs[cid].get("sections", []):
            for e in sec.get("ecus", []):
                sgbd = (e.get("sgbd") or "").lower()
                if sgbd and sgbd not in owner:
                    owner[sgbd] = cid
    with open(os.path.join(api, "ecu-index.json"), "w") as f:
        json.dump(owner, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  ecu-index.json: {len(owner)} sgbds")

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
