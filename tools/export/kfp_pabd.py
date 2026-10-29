#!/usr/bin/env python3
"""Export WinKFP's programming scripts (PABDs) for WebKFP.

    python3 tools/export/kfp_pabd.py <SP-Daten dir>

Reads <dir>/sgdat/<PABD>.IPO for every module family the SP-Daten carry
(every family in KFCONF10.DA2 whose folder holds its ZB table) and writes
app/renderer/data/kfp/<pabd>.json: the runnable token stream
(tools/export/ipo_exec.py --coding), which core/kfp/run.js executes on the
CDH host. The PABDs are CABD bytecode, the same dialect as the NCS coding
dispatchers, so the coding exporter reads them unchanged.

Which PABD a module uses is in <dir>/data/gdaten/KFCONF10.DA2
(ME <ecu> <addr> 01 <family> <PABD>.IPO <SGBD>.PRG ...).

The SGBD a PABD runs is no module of any car's menu, so no chassis archive
carries it; its job code and tables (data/ecu-src) are copied beside the
PABD as <sgbd>.job-code.json.gz and <sgbd>.tables.json.gz.

WinKFP shows a failed programming as COAPI error numbers with their text
from <dir>/cfgdat/coapierr.eng; that table goes beside them as coapierr.json.

families.json lists the families, with each one's ZB table, PABD, P-SGBD
and diagnosis address; WebKFP's family list is built from it.
"""
import json
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_exec  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "app", "renderer", "data", "kfp")

SRC = os.path.join(HERE, "..", "..", "data", "ecu-src")

# The diagnosis protocol WinKFP shows, where it is known; KFCONF does not say
PROTOCOLS = {"GD20": "DS2", "MDS451": "KWP2000*"}


def families(spd):
    """Every module family WinKFP programs, from KFCONF10.DA2, whose folder
    the SP-Daten carry: its ZB table, PABD, P-SGBD and diagnosis address."""
    conf = os.path.join(spd, "data", "gdaten", "KFCONF10.DA2")
    out = []
    with open(conf, encoding="latin-1") as f:
        for line in f:
            c = line.split()
            # ME <id> <address> 01 <family> <pabd>.IPO <sgbd>.PRG <flash> <his> <dat> ...
            if len(c) < 10 or c[0] != "ME":
                continue
            folder = c[4]
            if not os.path.isfile(os.path.join(spd, "data", folder, c[9])):
                continue
            out.append({
                "folder": folder,
                "table": c[9],
                "pabd": c[5].rsplit(".", 1)[0].lower(),
                "sgbd": c[6].rsplit(".", 1)[0].lower(),
                "address": c[2],
                "protocol": PROTOCOLS.get(folder, ""),
            })
    return out


def find(sgdat, stem):
    """The .IPO in `sgdat` named `stem`, whatever case it was shipped in."""
    for name in os.listdir(sgdat):
        if name.lower() == f"{stem.lower()}.ipo":
            return os.path.join(sgdat, name)
    raise SystemExit(f"no {stem}.IPO in {sgdat}")


def main(argv):
    if len(argv) != 1:
        print(__doc__)
        return 2
    sgdat = os.path.join(argv[0], "sgdat")
    os.makedirs(OUT, exist_ok=True)
    fams = families(argv[0])
    for fam in fams:
        stem = fam["pabd"]
        path = find(sgdat, stem)
        # ipo_exec resolves a path given without its extension
        data = ipo_exec.export(path[: -len(".ipo")], coding=True)
        data["ecu"] = stem
        unknown = sum(1 for toks in data["procs"].values() for t in toks if t.get("op") == "unk")
        if unknown:
            raise SystemExit(f"{stem}: {unknown} undecoded tokens")
        out = os.path.join(OUT, f"{stem}.json")
        with open(out, "w") as f:
            json.dump(data, f, separators=(",", ":"))
        print(f"{fam['folder']}: {stem.upper()}.IPO, {len(data['procs'])} procs -> {os.path.relpath(out)}")
    out = os.path.join(OUT, "families.json")
    with open(out, "w") as f:
        json.dump(fams, f, indent=1)
    print(f"{len(fams)} families -> {os.path.relpath(out)}")
    errs = os.path.join(argv[0], "cfgdat", "coapierr.eng")
    with open(errs, encoding="latin-1") as f:
        table = {k: v for k, v in re.findall(r"^\s*(\d+)\s*=\s*(.*?)\s*$", f.read(), re.M)}
    out = os.path.join(OUT, "coapierr.json")
    with open(out, "w") as f:
        json.dump(table, f, separators=(",", ":"), ensure_ascii=False)
    print(f"coapierr.eng: {len(table)} texts -> {os.path.relpath(out)}")
    for sgbd in sorted({fam["sgbd"] for fam in fams}):
        for kind in ("job-code", "tables"):
            name = f"{sgbd}.{kind}.json.gz"
            shutil.copyfile(os.path.join(SRC, name), os.path.join(OUT, name))
        print(f"{sgbd}: job code and tables -> {os.path.relpath(OUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
