#!/usr/bin/env python3
"""Freeze the app's API surface into static .chassis and .ecu ZIP archives.

Instead of writing thousands of separate JSON files, this tool packages:
- All assets for a single ECU (jobs, results, arguments, tables, IR, VM bytecode, SGBD tables) into `api/ecu/<sgbd>.ecu` (ZIP format).
- All ECUs for a chassis, along with its resolved configuration, into `api/chassis/<chassisId>.chassis` (ZIP format).
"""
import os
import sys
import json
import shutil
import urllib.request
import zipfile
import io
import gzip

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..", "..")
CACHE = os.path.join(ROOT, "data", "chassis-config")


def get(port, path):
    """Get the chassis config, from the running app or the committed cache."""
    if port:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",
                                         timeout=120) as r:
                return json.load(r)
        except Exception:
            pass
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
    except Exception:
        pass


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
        out = sys.argv[sys.argv.index("--out") + 1]
    api = os.path.join(out, "api")
    os.makedirs(api, exist_ok=True)

    ids = get(port, "/api/chassis")
    refresh_cache(port, ids)

    # 1. Write the main chassis listing (plain JSON so it loads instantly)
    with open(os.path.join(api, "chassis.json"), "w") as f:
        json.dump(ids, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  chassis.json written")

    # Gather all referenced SGBDs and resolve IR mappings
    sgbds = set()
    sgbd_to_ir = {}
    ir_dir = os.path.join(ROOT, "data", "inpa-ir")
    stems = {f[:-5].lower(): f for f in os.listdir(ir_dir)
             if f.endswith(".json")} if os.path.isdir(ir_dir) else {}

    chassis_configs = {}
    for cid in ids:
        cfg = get(port, f"/api/chassis/{cid}")
        chassis_configs[cid] = cfg
        for sec in cfg.get("sections", []):
            for e in sec.get("ecus", []):
                sgbd = (e.get("sgbd") or "").lower()
                if not sgbd:
                    continue
                sgbds.add(sgbd)
                
                # Match IR file
                cand = {e["code"].lower(), sgbd}
                for suf in ("ds0", "ds2", "ds1", "_n", "ds"):
                    if sgbd.endswith(suf):
                        cand.add(sgbd[:-len(suf)])
                hit = next((stems[c] for c in cand if c in stems), None)
                if hit:
                    sgbd_to_ir[sgbd] = hit

    # 2. Package each ECU into its own .ecu (zip) archive
    ecu_zips = {}
    njobs = nres = ntab = nir = 0
    os.makedirs(os.path.join(api, "ecu"), exist_ok=True)

    for sgbd in sorted(sgbds):
        ecu_contents = {}

        # Load job metadata
        mp = os.path.join(ROOT, "data", "job-meta", f"{sgbd}.json")
        if os.path.exists(mp):
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
        tp = os.path.join(ROOT, "data", "sgbd-tables", f"{sgbd}.json")
        if os.path.exists(tp):
            with open(tp) as f:
                tabs = json.load(f)
            ecu_contents["tables.json"] = json.dumps(sorted(tabs.keys()), separators=(",", ":"))
            for name, rows in tabs.items():
                ecu_contents[f"table/{name.upper()}.json"] = json.dumps(rows, separators=(",", ":"))
            ntab += 1

        # Add IR if matched
        if sgbd in sgbd_to_ir:
            ir_path = os.path.join(ir_dir, sgbd_to_ir[sgbd])
            with open(ir_path, "rb") as f:
                ecu_contents["ir.json"] = f.read()
            nir += 1

        # Decompress and embed the VM's job-code bytecode
        gp = os.path.join(ROOT, "data", "job-code", f"{sgbd}.json.gz")
        if os.path.exists(gp):
            with gzip.open(gp, "rb") as gf:
                ecu_contents["job-code.json"] = gf.read()

        # Embed VM SGBD tables
        vmtp = os.path.join(ROOT, "data", "sgbd-tables", f"{sgbd}.json")
        if os.path.exists(vmtp):
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

    total_size = sum(
        os.path.getsize(os.path.join(dirpath, filename))
        for dirpath, _, filenames in os.walk(api)
        for filename in filenames
    )
    print(f"api tree: {total_size // (1024 * 1024)} MB -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
