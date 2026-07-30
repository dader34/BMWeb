#!/usr/bin/env python3
"""Differential check: a lifted job spec against the real EDIABAS engine.

A spec extracted by tools/sgbd_spec.py is a hypothesis. This is what turns it
into a fact -- the same method that got the .IPO decompiler to zero mismatches:
state what the spec claims, ask the engine the same question, and only trust
the spec where the two agree.

Two levels, because they need different things:

  schema   (offline, no cable) -- does the spec name exactly the results the
           SGBD declares, with compatible types? The engine answers _RESULTS
           as a pseudo-job with nothing plugged in, so this runs anywhere and
           covers every job in the corpus.

  values   (needs a car or a .sim file) -- feed the SAME response bytes to the
           engine and to the spec walker and diff the decoded values. This is
           the one that proves scale/offset/extraction, and it is the gate for
           marking a spec "verified".

Schema-level disagreement is already decisive: a spec that invents a result,
misses one, or gets its type wrong cannot be trusted to decode bytes either.

    python3 tools/sgbd_diff.py ms450ds0                 # every job, schema
    python3 tools/sgbd_diff.py ms450ds0 STATUS_UBATT    # one job, verbose
    BMACW_PORT=51881 python3 tools/sgbd_diff.py --e46   # the E46 set

Needs the app (or InpaMac.Server) running for the offline engine; set
BMACW_PORT, or it probes 8777 and the running app's port.
"""
import os
import re
import sys
import json
import glob
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # tools/, for sibling modules
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import sgbd_survey as S                                       # noqa: E402
import sgbd_spec as SP                                        # noqa: E402

INTERNAL = re.compile(r"^(_TEL_|JOB_|SAETZE$|VARIANTE$)")

# EDIABAS result types the engine reports, mapped onto the spec's vocabulary.
# The engine's _RESULTS comments do not carry types, so schema-level checking
# compares NAMES; types are compared only when the spec claims one and the
# value-level run can confirm it.


def api(port, path):
    url = f"http://127.0.0.1:{port}{path}"
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)


def find_port():
    if os.environ.get("BMACW_PORT"):
        return os.environ["BMACW_PORT"]
    for p in (8777,):
        try:
            api(p, "/api/health")
            return p
        except Exception:
            pass
    # the packaged app uses an ephemeral port; find it via lsof
    try:
        import subprocess
        pid = subprocess.run(["pgrep", "-f", "BMacW"], capture_output=True,
                             text=True).stdout.split()
        if pid:
            out = subprocess.run(["lsof", "-aPi", "-p", pid[0]],
                                 capture_output=True, text=True).stdout
            for line in out.splitlines():
                if "LISTEN" in line:
                    m = re.search(r":(\d+) \(LISTEN\)", line)
                    if m:
                        return m.group(1)
    except Exception:
        pass
    raise SystemExit("no running engine: start BMacW or InpaMac.Server, "
                     "or set BMACW_PORT")


def engine_results(port, sgbd, job):
    """Result names the SGBD declares for a job, from the engine's _RESULTS."""
    try:
        rows = api(port, f"/api/ecu/{sgbd}/results/{job}")
    except urllib.error.HTTPError:
        return None
    names = []
    for row in rows:
        nm = row.split(":", 1)[0].strip()
        if nm and not INTERNAL.match(nm):
            names.append(nm)
    return names


def diff_job(port, data, addr, sgbd, job):
    spec = SP.extract(data, addr, sgbd, job)
    want = engine_results(port, sgbd, job)
    got = [r["name"] for r in spec.get("results", [])]
    if want is None:
        return spec, "no-schema", [], []
    # Compare case-insensitively: BMW ships mixed-case result names
    # ("STAT_IFFHMax_WERT" on ZKE5) and the engine's _RESULTS listing reports
    # a different casing than the bytecode's own string constant. EDIABAS
    # itself resolves results case-insensitively, so a casing difference is
    # not a disagreement about WHICH result the job produces.
    # a result the spec marked dead (stored under a name no etag gates) is not
    # something the engine returns either, so it is not an invention
    got = [n for n in got
           if n and not any(r["name"] == n and "deadStore" in r
                            for r in spec.get("results", []))]
    wl = {n.upper(): n for n in want}
    gl = {n.upper(): n for n in got}
    missing = [wl[k] for k in wl if k not in gl]
    extra = [gl[k] for k in gl if k not in wl]
    if not want and got:
        # The SGBD declares no _RESULTS for this job but its bytecode plainly
        # writes some (BMBT46's STATUS_LESEN_SG stores fourteen). The schema
        # segment is optional and BMW left it empty here, so there is nothing
        # to disagree WITH -- and the lifted spec is strictly more informative
        # than the engine's own metadata. Not a failure; just unverifiable at
        # schema level, so it waits for the value-level run like everything else.
        return spec, "no-schema-declared", [], []
    if not missing and not extra:
        # Includes the both-empty case, which is a real match rather than a
        # failure: an actuator command (STEUERN_X_ENDE, FS_LOESCHEN) declares
        # no results of its own, so a spec that lifts none agrees with the
        # engine exactly. Counting those as "lifted nothing" hid 46 correct
        # specs behind a scary-looking number.
        verdict = "schema-match" if got else "match-no-results"
    elif not got:
        verdict = "no-results-lifted"
    elif not missing and extra:
        verdict = "over-lifted"
    elif missing and not extra:
        verdict = "under-lifted"
    else:
        verdict = "mismatch"
    return spec, verdict, missing, extra


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = find_port()

    targets = S.e46_sgbds() if "--e46" in sys.argv else (
        [args[0].lower()] if args else [])
    if not targets:
        print(__doc__)
        return 0

    # one job, verbose
    if len(args) >= 2 and "--e46" not in sys.argv:
        sgbd, job = args[0].lower(), args[1].upper()
        data, jobs = SP.load(sgbd)
        addr = SP.job_addr(data, jobs, job)
        if addr is None:
            raise SystemExit(f"{sgbd} has no job {job}")
        spec, verdict, missing, extra = diff_job(port, data, addr, sgbd, job)
        print(json.dumps(spec, ensure_ascii=False, indent=1))
        print(f"\nverdict: {verdict}")
        if missing:
            print(f"  engine declares, spec missed : {missing}")
        if extra:
            print(f"  spec invented, engine has not: {extra}")
        return 0

    totals = {}
    per_ecu = []
    for sgbd in targets:
        try:
            data, jobs = SP.load(sgbd)
        except SystemExit:
            continue
        ir = S.ir_jobs_for(sgbd)
        counts = {}
        for n, a in jobs:
            if n.startswith("_") or n.upper() not in ir:
                continue          # the jobs the product actually runs
            _, verdict, _, _ = diff_job(port, data, a, sgbd, n)
            counts[verdict] = counts.get(verdict, 0) + 1
            totals[verdict] = totals.get(verdict, 0) + 1
        if counts:
            per_ecu.append((sgbd, counts))

    order = ["schema-match", "match-no-results", "no-schema-declared",
             "under-lifted", "over-lifted", "mismatch", "no-results-lifted",
             "no-schema"]
    print(f"{'SGBD':14} " + " ".join(f"{k[:11]:>12}" for k in order))
    for sgbd, c in per_ecu:
        print(f"{sgbd:14} " + " ".join(f"{c.get(k, 0):>12}" for k in order))
    n = sum(totals.values())
    ok = totals.get("schema-match", 0) + totals.get("match-no-results", 0)
    print(f"\n{n} IR-referenced jobs checked against the engine's own schema")
    for k in order:
        if totals.get(k):
            print(f"  {totals[k]:5}  {k}")
    if n:
        print(f"\nresult names lifted exactly: {ok}/{n} = {100*ok/n:.1f}%")
        print("NOTE: schema agreement is necessary, not sufficient. No spec is "
              "'verified' until a value-level run (car or .sim) confirms the "
              "decoded values match the engine's.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
