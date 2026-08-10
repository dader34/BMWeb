#!/usr/bin/env python3
"""Layer 3a: harvest job/result metadata from the SGBDs, offline.

The .IPO gives INPA's screens. The SGBD gives what the ECU can actually answer,
and the two do not fully overlap: MS45's Ident card shows five fields that are
NOT in the bytecode at all (ID_EWS_SS, ID_SG_ADR, PRUEFCODE, HARDWARE_REFERENZ,
DATEN_REFERENZ). They came from the SGBD's own job schemas.

The .prg files are compiled EDIABAS objects -- result names are not plain
strings, so they cannot be regexed the way .IPO can. Instead this asks the
running engine, which answers _JOBS/_RESULTS/_ARGUMENTS as pseudo-jobs with NO
CABLE ATTACHED. That is why this is a build script and not a runtime feature.

Every field it emits carries source="sgbd", so a consumer can always tell what
INPA showed from what the ECU merely supports.

    python3 tools/sgbd_harvest.py                 # summary (needs the app running)
    python3 tools/sgbd_harvest.py ms450ds0        # one SGBD
    python3 tools/sgbd_harvest.py --write         # data/inpa-screens/_sgbd.json
"""
import os
import re
import sys
import json
import glob
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ECU_DIR = os.path.join(HERE, "..", "..", "vendor", "EDIABAS", "Ecu")
OUT = os.path.join(HERE, "..", "..", "data", "inpa-screens")

API = os.environ.get("BMACW_API")

# jobs worth harvesting result schemas for. Harvesting all 267 jobs of every
# SGBD would be mostly noise; these are the read jobs whose results end up on
# the identity/AIF/status cards the recognisers build.
READ_JOB = re.compile(r"^(IDENT|INFO|AIF_LESEN|STATUS_LESEN)$"
                      r"|_LESEN$|^STATUS_|^MW_", re.I)

# never harvest anything that writes, even for its schema: a decoded argument
# list is one copy-paste away from being run.
WRITE_JOB = re.compile(r"SCHREIBEN|LOESCHEN|_SETZEN|STEUERN|FLASH|PROGRAMMIER"
                       r"|RESET|AUTHENTIS|ABGLEICH|SLEEP", re.I)

# "KEY : description" is how the engine reports a job's result schema
_RESULT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$")


def _port():
    """The app binds an ephemeral port; find whoever is listening."""
    if API:
        return API
    import subprocess
    try:
        out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a",
                              "-c", "InpaMac.A"], capture_output=True,
                             text=True, timeout=15).stdout
        m = re.search(r"127\.0\.0\.1:(\d+)", out)
        if m:
            return f"http://127.0.0.1:{m.group(1)}"
    except Exception:                       # noqa: BLE001
        pass
    return None


def _get(base, path, timeout=90):
    with urllib.request.urlopen(base + path, timeout=timeout) as r:
        return json.load(r)


def harvest(base, sgbd):
    """One SGBD's read-job result schemas. Returns None if it will not load."""
    try:
        jobs = _get(base, f"/api/ecu/{sgbd}/jobs")
    except Exception:                       # noqa: BLE001 - unloadable SGBD
        return None
    if not isinstance(jobs, list):
        return None

    wanted = [j for j in jobs
              if not j.startswith("_") and READ_JOB.search(j)
              and not WRITE_JOB.search(j)]

    out = {}
    for job in wanted:
        try:
            rows = _get(base, f"/api/ecu/{sgbd}/results/{job}")
        except Exception:                   # noqa: BLE001 - job has no schema
            continue
        fields = []
        for row in rows:
            m = _RESULT.match(row.strip())
            if not m:
                continue
            key, desc = m.group(1), m.group(2).strip()
            if key.startswith("_") or key == "JOB_STATUS":
                continue
            fields.append({"key": key, "desc": desc, "job": job,
                           "source": "sgbd"})
        if fields:
            out[job] = fields
    return {"sgbd": sgbd, "jobs": len(jobs), "harvested": out}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    base = _port()
    if not base:
        print("the app is not running — start it so the EDIABAS engine can\n"
              "answer _JOBS/_RESULTS offline, or set BMACW_API.",
              file=sys.stderr)
        return 2

    if args:
        rec = harvest(base, args[0])
        if rec is None:
            print(f"could not load SGBD: {args[0]}", file=sys.stderr)
            return 1
        print(json.dumps(rec, ensure_ascii=False, indent=1))
        return 0

    # CASE-INSENSITIVE ON PURPOSE (same trap as ipo_ir.py --write): the
    # vendor tree mixes *.prg and *.PRG, and globbing one spelling silently
    # dropped 187 of the 1,006 SGBDs. Dedupe by lowered stem.
    names = sorted({os.path.basename(f)[:-4].lower()
                    for f in glob.glob(os.path.join(ECU_DIR, "*"))
                    if f.lower().endswith(".prg")})
    recs, failed, t0 = {}, 0, time.time()
    for i, sgbd in enumerate(names, 1):
        rec = harvest(base, sgbd)
        if rec is None or not rec["harvested"]:
            failed += 1
            continue
        recs[sgbd] = rec
        if i % 100 == 0:
            print(f"   {i}/{len(names)}…", file=sys.stderr)

    fields = sum(len(f) for r in recs.values() for f in r["harvested"].values())
    print(f"{len(names)} SGBDs, {len(recs)} harvested "
          f"({failed} with no readable schema) in {time.time() - t0:.0f}s\n")
    print(f"   jobs with schemas {sum(len(r['harvested']) for r in recs.values())}")
    print(f"   result fields     {fields}")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_sgbd.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(recs, f, ensure_ascii=False)
        print(f"\nwrote {len(recs)} SGBDs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
