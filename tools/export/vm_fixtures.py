#!/usr/bin/env python3
"""Bundle engine ground truth for the VM differential test.

The bulk verifier already discovered a request telegram per job, synthesised
a response, and saved both as a .sim -- and the engine's own decode of those
bytes is reproducible from them. This collects, per job: the telegrams and
the result sets the REAL ENGINE produced. tools/test_bestvm.js replays the
identical bytes through the JS VM and diffs every result.

Reuses data/sim-captures/bulk/<sgbd>_<job>/ so no new engine discovery is
needed; jobs whose fixture the engine rejects are still included, because
"the engine returned nothing" is itself behaviour the VM must reproduce.

    python3 tools/vm_fixtures.py > data/sim-captures/vmfix.json
"""
import os
import re
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # tools/, for sibling modules
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import sgbd_bulk_verify as B                                  # noqa: E402

ROOT = os.path.join(HERE, "..", "..", "..")
BULK = os.path.join(ROOT, "data", "sim-captures", "bulk")


def sim_pairs(d):
    """[(request, response)] from a .sim directory, in order."""
    sims = [x for x in os.listdir(d)
            if x.endswith(".sim") and not x.startswith("obd")]
    if not sims:
        return []
    txt = open(os.path.join(d, sims[0])).read()
    if "[RESPONSE]" not in txt:
        return []
    head, tail = txt.split("[RESPONSE]", 1)
    req = dict(re.findall(r"^(R\d+) = ([0-9A-Fa-f,]+)$", head, re.M))
    rsp = dict(re.findall(r"^(R\d+) = ([0-9A-Fa-f,]+)$", tail, re.M))
    out = []
    for k in sorted(req, key=lambda s: int(s[1:])):
        if k in rsp:
            out.append(([int(x, 16) for x in req[k].split(",")],
                        [int(x, 16) for x in rsp[k].split(",")]))
    return out


def main():
    dirs = [d for d in sorted(os.listdir(BULK))
            if os.path.isdir(os.path.join(BULK, d)) and "_" in d]
    only = [a.lower() for a in sys.argv[1:] if not a.startswith("--")]
    jobs = []
    for d in dirs:
        sgbd, job = d.split("_", 1)
        if only and sgbd not in only:
            continue
        p = os.path.join(BULK, d)
        pairs = sim_pairs(p)
        if not pairs:
            continue
        jobs.append({"sgbd": sgbd, "job": job, "sim": p, "pairs": pairs})
    # one engine process for the whole corpus
    reqs = [{"sgbd": j["sgbd"], "job": j["job"], "sim": j["sim"]}
            for j in jobs]
    results = B.batch(reqs)
    by = {}
    for r in results:
        by[(r.get("sgbd"), r.get("job"))] = r
    cases = []
    for j in jobs:
        r = by.get((j["sgbd"], j["job"])) or {}
        cases.append({
            "sgbd": j["sgbd"], "job": j["job"],
            "telegrams": [{"request": q, "response": a} for q, a in j["pairs"]],
            "sets": r.get("sets") or [],
        })
    json.dump({"cases": cases}, sys.stdout)
    print(f"\n{len(cases)} cases, "
          f"{sum(len(c['sets']) for c in cases)} engine sets",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
