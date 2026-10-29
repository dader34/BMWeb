#!/usr/bin/env python3
"""Lay every chassis's SP-Daten module folders out on bmw-files, loose.

    python3 tools/export/spdaten_all.py <dir of <CHASSIS>.tar.zst> <bmw-files sp-daten dir>

e.g. "~/Development/code/BMWFILES/sp-daten merge (compressed)"  ~/Development/code/BMWFILES/sp-daten

kfp_spdaten.py does this for one chassis already unpacked, and only for the
families WebKFP programs. This streams each chassis archive once and writes
all of its module folders -- data/<family>/, the ZB table, its histories and
the .0PA/.0DA/.0BA files -- to <out>/<CHASSIS>/<family>/, byte for byte,
leaving out data/gdaten (WinKFP's own configuration) and data/konv* (its
scratch). index.json gains every folder, as kfp_spdaten.py writes it, with
the ZB table KFCONF names for the family (its own <family>.DAT when KFCONF
does not list it, none when there is neither).

An archive without module folders adds nothing. Running it again rewrites
the same files and the same index entries.
"""
import io
import json
import os
import re
import subprocess
import sys
import tarfile

SKIP = re.compile(r"^(gdaten|konv)", re.I)


def kfconf_tables(conf_text):
    """KFCONF*.DA2: family folder -> its ZB table."""
    out = {}
    for line in conf_text.splitlines():
        c = line.split()
        if len(c) >= 10 and c[0] == "ME":
            out.setdefault(c[4].upper(), c[9])
    return out


def export(archive, out_root):
    chassis = os.path.basename(archive).split(".")[0].upper()
    # -f: also through a symlink, which zstd otherwise refuses
    proc = subprocess.Popen(["zstd", "-dcf", archive], stdout=subprocess.PIPE)
    folders = {}
    conf = {}
    with tarfile.open(fileobj=proc.stdout, mode="r|") as tar:
        for m in tar:
            parts = m.name.split("/")
            # <CHASSIS>/data/<family>/<file>
            if len(parts) != 4 or parts[1].lower() != "data" or not m.isfile():
                continue
            family, name = parts[2], parts[3]
            if SKIP.match(family):
                if re.match(r"KFCONF.*\.DA2$", name, re.I):
                    conf.update(kfconf_tables(tar.extractfile(m).read().decode("latin-1")))
                continue
            dest = os.path.join(out_root, chassis, family)
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, name), "wb") as f:
                f.write(tar.extractfile(m).read())
            folders.setdefault(family, {})[name] = m.size
    proc.wait()
    entries = {}
    for family, files in folders.items():
        upper = {n.upper(): n for n in files}
        table = conf.get(family.upper()) or f"{family}.DAT"
        entries[family] = {
            "path": f"{chassis}/{family}/",
            "table": upper.get(table.upper()),
            "files": dict(sorted(files.items())),
        }
    return chassis, entries


def main(argv):
    if len(argv) != 2:
        sys.exit(__doc__)
    src, out = argv
    index_path = os.path.join(out, "index.json")
    index = {"version": 1, "modules": {}}
    if os.path.exists(index_path):
        with open(index_path) as f:
            index = json.load(f)
    archives = sorted(
        (os.path.join(src, n) for n in os.listdir(src) if n.endswith(".tar.zst")),
        key=os.path.getsize,
    )
    for archive in archives:
        chassis, entries = export(archive, out)
        for family, entry in entries.items():
            index["modules"].setdefault(family, {})[chassis] = entry
        n = sum(len(e["files"]) for e in entries.values())
        size = sum(sum(e["files"].values()) for e in entries.values()) / 1e9
        print(f"{chassis}: {len(entries)} families, {n} files, {size:.2f} GB", flush=True)
        # the index after every chassis, so a stopped run leaves a usable one
        with open(index_path, "w") as f:
            json.dump(index, f, separators=(",", ":"), sort_keys=True)
    print(f"index -> {index_path}: {len(index['modules'])} families")


if __name__ == "__main__":
    main(sys.argv[1:])
