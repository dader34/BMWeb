#!/usr/bin/env python3
"""Export WinKFP's programming scripts (PABDs) for every family WebKFP can
fetch online, from every chassis's SP-Daten.

    python3 tools/export/kfp_pabd_all.py <dir of <CHASSIS>.tar.zst> <sp-daten index.json> [meta dir]

kfp_pabd.py does one unpacked chassis. This reads each chassis archive's
KFCONF*.DA2 (which family uses which PABD and P-SGBD) and its sgdat/ (the
PABDs), and for every family the online index has files for:

  - finds its PABD in whichever chassis carries it (KFCONF names every
    family in every chassis; only some chassis ship the script),
  - converts it (ipo_exec --coding) and keeps it only when nothing is left
    undecoded,
  - keeps it only when its P-SGBD's job code is in data/ecu-src,

then writes data/kfp/<pabd>.json, copies each SGBD's job code and tables
beside them, and writes families.json with every family that passed. The
ones that did not are listed with the reason.

[meta dir] is a folder already holding <CHASSIS>/sgdat and
<CHASSIS>/gdaten (KFCONF) -- the archives are streamed only without it.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ipo_exec  # noqa: E402
from kfp_pabd import PROTOCOLS  # noqa: E402

OUT = os.path.join(HERE, "..", "..", "app", "renderer", "data", "kfp")
SRC = os.path.join(HERE, "..", "..", "data", "ecu-src")


def extract_meta(archives, meta):
    """Each archive's sgdat/ and data/gdaten/KFCONF*.DA2, to meta/<CHASSIS>/."""
    for n in sorted(os.listdir(archives)):
        if not n.endswith(".tar.zst"):
            continue
        chassis = n.split(".")[0].upper()
        proc = subprocess.Popen(["zstd", "-dcf", os.path.join(archives, n)], stdout=subprocess.PIPE)
        with tarfile.open(fileobj=proc.stdout, mode="r|") as tar:
            for m in tar:
                parts = m.name.split("/")
                if not m.isfile():
                    continue
                if len(parts) == 3 and parts[1].lower() == "sgdat":
                    sub = "sgdat"
                elif (len(parts) == 4 and parts[1].lower() == "data" and parts[2].lower() == "gdaten"
                      and re.match(r"KFCONF.*\.DA2$", parts[3], re.I)):
                    sub = "gdaten"
                else:
                    continue
                d = os.path.join(meta, chassis, sub)
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, parts[-1]), "wb") as f:
                    f.write(tar.extractfile(m).read())
        proc.wait()
        print(f"{chassis}: KFCONF and sgdat read", flush=True)


def main(argv):
    if len(argv) not in (2, 3):
        sys.exit(__doc__)
    archives, index_path = argv[0], argv[1]
    with open(index_path) as f:
        online = json.load(f)["modules"]
    online_upper = {k.upper(): k for k in online}
    tmp = None
    meta = argv[2] if len(argv) == 3 else None
    if not meta:
        tmp = meta = tempfile.mkdtemp(prefix="kfp-meta-")
        extract_meta(archives, meta)
    try:
        chassis = sorted(os.listdir(meta))
        pabds = {}
        for ch in chassis:
            sg = os.path.join(meta, ch, "sgdat")
            if os.path.isdir(sg):
                for n in os.listdir(sg):
                    pabds.setdefault(n.upper(), os.path.join(sg, n))
        # every chassis's KFCONF line for a family: they differ (E89 names
        # CID90's script 110000CID90.ipo where E60 says 00CID90.IPO), and
        # only some name a script that some chassis ships
        rows = {}
        for ch in chassis:
            g = os.path.join(meta, ch, "gdaten")
            if not os.path.isdir(g):
                continue
            for conf in sorted(os.listdir(g)):
                with open(os.path.join(g, conf), encoding="latin-1") as f:
                    for line in f:
                        c = line.split()
                        # ME <id> <address> 01 <family> <pabd>.IPO <sgbd>.PRG <flash> <his> <dat> ...
                        if len(c) >= 10 and c[0] == "ME" and c[4].upper() in online_upper:
                            fam_rows = rows.setdefault(online_upper[c[4].upper()], [])
                            if c not in fam_rows:
                                fam_rows.append(c)
        ecu = {n.split(".")[0].lower() for n in os.listdir(SRC) if n.endswith(".job-code.json.gz")}
        os.makedirs(OUT, exist_ok=True)
        fams, skipped, sgbds = [], defaultdict(list), set()
        for folder, cands in sorted(rows.items()):
            # the first line whose script exists and whose SGBD we have,
            # else the first whose script exists, else the first
            def rank(c):
                there = c[5].upper() in pabds
                sg = c[6].rsplit(".", 1)[0].lower() in ecu
                return (not there, not sg)
            c = sorted(cands, key=rank)[0]
            pabd_name, prg = c[5], c[6]
            stem = pabd_name.rsplit(".", 1)[0].lower()
            sgbd = prg.rsplit(".", 1)[0].lower()
            if not pabd_name.upper().endswith(".IPO"):
                skipped["not an IPO PABD"].append(folder)
                continue
            path = pabds.get(pabd_name.upper())
            if not path:
                skipped["PABD in no chassis"].append(folder)
                continue
            # BMW ships some as placeholders: MDS410's 00MDS410.IPO (and its
            # .PRG) is a bare CRLF, 2 bytes -- nothing to convert
            if os.path.getsize(path) < 0x100:
                skipped["placeholder PABD"].append(f"{folder}({os.path.getsize(path)} bytes)")
                continue
            if sgbd not in ecu:
                skipped["SGBD not in data/ecu-src"].append(f"{folder}({sgbd})")
                continue
            out = os.path.join(OUT, f"{stem}.json")
            if not os.path.exists(out):
                try:
                    data = ipo_exec.export(path[: -len(".ipo")], coding=True)
                except Exception as e:  # a script the converter cannot read
                    skipped["conversion failed"].append(f"{folder}({e})")
                    continue
                if "cabimain" not in data.get("procs", {}):
                    skipped["no cabimain in the script"].append(folder)
                    continue
                unknown = sum(1 for toks in data["procs"].values() for t in toks if t.get("op") == "unk")
                if unknown:
                    skipped["undecoded tokens"].append(f"{folder}({unknown})")
                    continue
                data["ecu"] = stem
                with open(out, "w") as f:
                    json.dump(data, f, separators=(",", ":"))
            by_chassis = online[folder]
            first = by_chassis[sorted(by_chassis)[0]]
            fams.append({
                "folder": folder,
                "table": first.get("table") or f"{folder}.DAT",
                "pabd": stem,
                "sgbd": sgbd,
                "address": c[2],
                "protocol": PROTOCOLS.get(folder, ""),
            })
            sgbds.add(sgbd)
        for sgbd in sorted(sgbds):
            for kind in ("job-code", "tables"):
                name = f"{sgbd}.{kind}.json.gz"
                if os.path.exists(os.path.join(SRC, name)):
                    shutil.copyfile(os.path.join(SRC, name), os.path.join(OUT, name))
        with open(os.path.join(OUT, "families.json"), "w") as f:
            json.dump(fams, f, indent=1)
        print(f"{len(fams)} families -> {os.path.relpath(os.path.join(OUT, 'families.json'))}, "
              f"{len(sgbds)} SGBDs")
        for why, which in sorted(skipped.items()):
            print(f"left out, {why}: {len(which)}: {' '.join(which)}")
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv[1:])
