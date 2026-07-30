#!/usr/bin/env python3
"""Does our description export say the same thing as the engine?

The metadata endpoints (/jobs, /results, /arguments) are what let the app
browse an ECU offline. Moving them off EDIABAS is only safe if the JSON we
ship carries the same job list and the same per-job result schema the engine
reports -- so this asks the running app for both and diffs them.

Needs the app running (BMACW_PORT); skips otherwise, like the rest of the
offline checks.

    BMACW_PORT=... python3 tools/test_meta.py [sgbd ...]
"""
import os
import sys
import json
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # tools/, for sibling modules
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import sgbd_survey as S                                       # noqa: E402
import sgbd_meta as M                                         # noqa: E402
import sgbd_spec as SP                                        # noqa: E402

ROOT = os.path.join(HERE, "..", "..", "..")


def engine(port, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",
                                    timeout=60) as r:
            return json.load(r)
    except Exception:                                       # noqa: BLE001
        return None


def main():
    port = os.environ.get("BMACW_PORT")
    if not port:
        print("BMACW_PORT not set; skipping metadata comparison")
        return 0
    args = [a.lower() for a in sys.argv[1:] if not a.startswith("--")]
    targets = args or S.e46_sgbds()[:12]

    tot_jobs = miss_jobs = extra_jobs = 0
    tot_res = miss_res = 0
    checked_ecus = 0
    for sgbd in targets:
        eng_jobs = engine(port, f"/api/ecu/{sgbd}/jobs")
        if not eng_jobs:
            continue
        try:
            data, _ = SP.load(sgbd)
        except SystemExit:
            continue
        meta = M.parse(data)
        if not meta["jobs"]:
            continue
        checked_ecus += 1
        # _JOBS is the engine's own synthetic entry, not a job of the ECU
        want = {j.upper() for j in eng_jobs if not j.startswith("_")}
        got = set(meta["jobs"].keys())
        tot_jobs += len(want)
        miss_jobs += len(want - got)
        extra_jobs += len(got - want)
        if want - got:
            print(f"  {sgbd}: {len(want - got)} jobs the engine has and we "
                  f"do not, e.g. {sorted(want - got)[:3]}")

        # result schema for a sample of jobs: the engine reports
        # "NAME : comment" lines
        for job in sorted(want)[:6]:
            lines = engine(port, f"/api/ecu/{sgbd}/results/{job}")
            if not lines:
                continue
            enames = {ln.split(":")[0].strip().upper() for ln in lines
                      if ":" in ln}
            gnames = {r["name"].upper()
                      for r in meta["jobs"].get(job, {}).get("results", [])}
            tot_res += len(enames)
            gap = enames - gnames
            miss_res += len(gap)
            if gap:
                print(f"  {sgbd}:{job} missing results {sorted(gap)[:4]}")

    print(f"ecus compared : {checked_ecus}")
    print(f"jobs          : {tot_jobs} engine, {miss_jobs} missing from ours,"
          f" {extra_jobs} extra")
    print(f"results       : {tot_res} engine, {miss_res} missing from ours")
    if not checked_ecus:
        # A COMPARISON AGAINST NOTHING IS NOT A PASS. The app no longer serves
        # /api/ecu/*/jobs from EDIABAS -- that endpoint went with InpaMac.Api --
        # so this reads zero engine answers and every difference count is
        # trivially zero. Say so instead of printing a green line: the engine
        # is still reachable through the CLI (src/InpaMac.Cli), which is what
        # sgbd_bulk_verify.py uses, and this check needs rewriting onto it.
        print("SKIPPED: no engine endpoint to compare against "
              "(InpaMac.Api removed; port served only static files)")
        return 0
    bad = miss_jobs or miss_res
    print("metadata matches the engine" if not bad else "MISMATCH")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
