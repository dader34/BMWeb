#!/usr/bin/env python3
"""Lay WebKFP's SP-Daten out on bmw-files, one loose file per file.

    python3 tools/export/kfp_spdaten.py <SP-Daten chassis dir> <bmw-files sp-daten dir>

e.g. ~/.../spd/E46  ~/Development/code/BMWFILES/sp-daten

The SP-Daten on bmw-files are whole-chassis .tar.zst archives, and a browser
cannot take one file out of those. WebKFP needs only a module family's folder (its
ZB table and the .0PA/.0DA one ZB number names), so those folders go up
loose, as <chassis>/<folder>/<file>, unchanged byte for byte.

index.json beside them lists every file and its size, so WebKFP knows what
is there from one small fetch and fetches a file only when it needs it:
the ZB table when the module's ZB numbers are first shown, the program and
data files when one is programmed. Running it again for another chassis
adds that chassis's folders to the same index.
"""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kfp_pabd import families  # noqa: E402


def main(argv):
    if len(argv) != 2:
        sys.exit(__doc__)
    src, out = argv
    chassis = os.path.basename(os.path.normpath(src)).upper()
    index_path = os.path.join(out, "index.json")
    index = {"version": 1, "modules": {}}
    if os.path.exists(index_path):
        with open(index_path) as f:
            index = json.load(f)
    # every family KFCONF10.DA2 names whose folder holds its ZB table
    for fam in families(src):
        folder, table = fam["folder"], fam["table"]
        d = os.path.join(src, "data", folder)
        dest = os.path.join(out, chassis, folder)
        os.makedirs(dest, exist_ok=True)
        files = {}
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            if not os.path.isfile(p):
                continue
            shutil.copy2(p, os.path.join(dest, name))
            files[name] = os.path.getsize(p)
        index["modules"].setdefault(folder, {})[chassis] = {
            "path": f"{chassis}/{folder}/",
            "table": table,
            "files": files,
        }
        size = sum(files.values()) / 1e6
        print(f"{chassis}/{folder}: {len(files)} files, {size:.1f} MB")
    with open(index_path, "w") as f:
        json.dump(index, f, separators=(",", ":"), sort_keys=True)
    print(f"index -> {index_path}")


if __name__ == "__main__":
    main(sys.argv[1:])
