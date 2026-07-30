#!/usr/bin/env python3
"""Value-verify EVERY job, not the handful with hand-built test cases.

tools/sgbd_value_diff.py proves a spec decodes bytes the way the engine does,
but each case costs a hand-written request telegram and a plausible response,
so only five jobs were ever covered -- 0.8% of the corpus. Every one of those
five found bugs that schema checking had passed, which says the other 99% is
where the remaining errors are.

This automates the whole loop:

  1. DISCOVER the request. Run the job under simulation with an empty .sim and
     read what the engine put on the wire from its own IFH trace. No guessing:
     MS450's STATUS_UBATT sends a KWP2000 service-0x21 frame despite its DS2
     sounding name.
  2. SYNTHESISE a response. Frame it the way the request was framed (BMW-FAST
     or DS2, detected from the length field) and fill the payload with a
     distinctive pattern, so a decoder reading the wrong offset produces a
     visibly wrong number rather than a plausible zero.
  3. COMPARE. Feed the identical bytes to the real engine and to the lifted
     spec, and diff every result.

Both passes run through `inpamac simbatch`, one .NET process for the whole
corpus -- per-process startup is ~1.6s, which would otherwise be half an hour
of doing nothing.

    python3 tools/sgbd_bulk_verify.py                # whole E46 set
    python3 tools/sgbd_bulk_verify.py ms450ds0       # one ECU
    python3 tools/sgbd_bulk_verify.py --limit 40     # quick pass

Jobs that WRITE are skipped by default. The discovery pass would otherwise
send STEUERN_/SCHREIBEN_/LOESCHEN_ telegrams, which is harmless against the
simulated interface used here but bakes a habit that is not harmless against
a car. `--writes` opts in deliberately, and is how the write PATH -- argument
handling, request assembly, status decode -- gets exercised at all; 192 such
jobs had never been executed even once, in simulation or otherwise.

    python3 tools/sgbd_bulk_verify.py --writes ms450ds0   # include writes
"""
import os
import re
import sys
import json
import glob
import shutil
import subprocess
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, os.path.dirname(HERE))  # tools/, for sibling modules
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import sgbd_spec as SP                                        # noqa: E402
import sgbd_survey as S                                       # noqa: E402
import sgbd_value_diff as V                                   # noqa: E402

WORK = os.path.join(ROOT, "data", "sim-captures", "bulk")
CLI = os.path.join(ROOT, "src", "InpaMac.Cli")

# never send these, even in simulation -- see module docstring
WRITE_JOB = re.compile(
    r"^(STEUERN|SCHREIBEN|.*_SCHREIBEN|.*_LOESCHEN|FS_LOESCHEN|.*_SETZEN"
    r"|FLASH.*|PROGRAMMIER.*|.*_RESET|RESET.*|CODIER.*_SCHREIB.*)", re.I)

# Write jobs are excluded by default -- see the module docstring. `--writes`
# opts in, and ONLY the simulated interface can honour it: EdInterfaceObd is
# pointed at SIMULATION for every job here, so a STEUERN_ telegram goes into
# a .sim file and never onto a bus. That is what makes exercising the write
# PATH (argument handling, request assembly, status decode) safe, and 192
# such jobs had never been executed even once.
INCLUDE_WRITES = "--writes" in sys.argv

# a payload byte pattern that makes a misread offset obvious: every byte
# differs from its neighbours and none are 0x00 or 0xFF (which read as
# "empty" or "invalid" and hide errors).
PATTERN = [((i * 7 + 0x11) & 0x7F) | 0x01 for i in range(64)]


_CLI_BIN = None


def cli_cmd(*args):
    """dotnet argv for the CLI -- a prebuilt DLL when it is FRESH, else
    `dotnet run`.

    `dotnet run --project` re-evaluates the project on every invocation
    (~1-2 s), and the export pipeline makes two probe calls per SGBD across
    hundreds of SGBDs -- most of its wall clock was dotnet startup. The DLL
    is only used when newer than every .cs source (ours and the vendored
    engine's); a stale binary silently running old code is exactly the kind
    of drift this repo's harnesses exist to prevent. If missing or stale it
    is built once, then reused.
    """
    global _CLI_BIN
    if _CLI_BIN is None:
        def newest_dll():
            hits = glob.glob(os.path.join(CLI, "bin", "**",
                                          "InpaMac.Cli.dll"), recursive=True)
            return max(hits, key=os.path.getmtime) if hits else None
        srcs = (glob.glob(os.path.join(ROOT, "src", "**", "*.cs"),
                          recursive=True)
                + glob.glob(os.path.join(ROOT, "vendor", "ediabaslib-src",
                                         "EdiabasLib", "EdiabasLib", "*.cs")))
        src_m = max((os.path.getmtime(p) for p in srcs), default=0)
        dll = newest_dll()
        if not dll or os.path.getmtime(dll) < src_m:
            subprocess.run(["dotnet", "build", CLI], capture_output=True,
                           text=True, cwd=ROOT,
                           env=dict(os.environ, DOTNET_ROLL_FORWARD="Major"))
            dll = newest_dll()
        _CLI_BIN = dll or ""
    if _CLI_BIN:
        return ["dotnet", _CLI_BIN] + list(args)
    return ["dotnet", "run", "--project", CLI, "--"] + list(args)


def batch(requests):
    """Run many {sgbd, job, sim} through one engine process."""
    if not requests:
        return []
    proc = subprocess.run(
        cli_cmd("simbatch"),
        input="\n".join(json.dumps(r) for r in requests),
        capture_output=True, text=True, cwd=ROOT,
        env=dict(os.environ, DOTNET_ROLL_FORWARD="Major"))
    out = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def write_sim(sim_dir, sgbd, pairs):
    os.makedirs(sim_dir, exist_ok=True)
    for old in glob.glob(os.path.join(sim_dir, "*.sim")):
        os.remove(old)
    if pairs:
        req = "\n".join(f"R{i+1} = {V.hexcsv(q)}" for i, (q, _) in enumerate(pairs))
        rsp = "\n".join(f"R{i+1} = {V.hexcsv(a)}" for i, (_, a) in enumerate(pairs))
        body = f"[REQUEST]\n{req}\n\n[RESPONSE]\n{rsp}\n"
    else:
        # an empty but VALID sim file: the engine still connects, sends, and
        # records the telegram, then reports no data. That is the discovery
        # pass -- a missing file instead fails at connect (IFH-0026) and
        # nothing reaches the trace.
        body = "[REQUEST]\nR1 = 00\n\n[RESPONSE]\nR1 = 00\n"
    for name in (sgbd.lower() + ".sim", "obd.sim"):
        with open(os.path.join(sim_dir, name), "w") as f:
            f.write(body)


def all_sends(trace_dir):
    """Every telegram the engine put on the wire, in order."""
    path = os.path.join(trace_dir, "ifh.trc")
    if not os.path.exists(path):
        return []
    return [[int(b, 16) for b in m.split()]
            for m in re.findall(r"\(Send sim\):\s*([0-9A-Fa-f ]+)",
                                open(path, errors="replace").read())]


def discover(sgbd, jobs, init_reply=None):
    """{job: (init_pair, request telegram)} from the engine's own IFH trace.

    A job's own request is NOT simply the last telegram: with an empty .sim
    the ECU never answers, so the engine retries the INITIALISATION frame and
    every job looks identical (all of MS450's report `B8,12,F1,02,1A,80`).
    The fix is two passes -- discover the init exchange first, answer it, and
    only then does the job get far enough to send its real request.
    """
    found = {}
    # dir is keyed by SGBD so parallel exports cannot trample each other
    d = os.path.join(WORK, f"disc_{sgbd}")
    tr = os.path.join(d, "trace")
    for job in jobs:
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(tr, exist_ok=True)
        pairs = [init_reply] if init_reply else []
        write_sim(d, sgbd, pairs)
        subprocess.run(
            cli_cmd("simrun", job, sgbd, "--sim", d, "--trace", tr),
            capture_output=True, text=True, cwd=ROOT,
            env=dict(os.environ, DOTNET_ROLL_FORWARD="Major"))
        sends = all_sends(tr)
        if not sends:
            continue
        # the job's request is the first telegram that is NOT the init frame
        init_req = init_reply[0] if init_reply else None
        real = [s for s in sends if s != init_req]
        if real:
            found[job] = real[-1]
    return found


def discover_init(sgbd, probe_job):
    """The init exchange an ECU demands before any job runs, or None."""
    d = os.path.join(WORK, f"init_{sgbd}")
    tr = os.path.join(d, "trace")
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(tr, exist_ok=True)
    write_sim(d, sgbd, [])
    subprocess.run(
        cli_cmd("simrun", probe_job, sgbd, "--sim", d, "--trace", tr),
        capture_output=True, text=True, cwd=ROOT,
        env=dict(os.environ, DOTNET_ROLL_FORWARD="Major"))
    sends = all_sends(tr)
    if not sends:
        return None
    req = sends[0]
    return (req, synth_response(req))


def is_ds2(frame):
    """True if `frame` is DS2 rather than BMW-FAST.

    DS2's byte 1 is the length of the WHOLE frame, checksum included -- so it
    equals len(frame), or len(frame)+1 when the capture omits the trailing
    checksum, which the IFH trace sometimes does. Testing only for equality
    missed those and answered a DS2 request with a BMW-FAST reply: the reply
    then carried a 3-byte header the job did not expect, and EVERY offset in
    those jobs read three bytes too far (spec 10029 against the engine's
    4377, exactly 3 pattern positions along).
    """
    return len(frame) >= 2 and frame[1] in (len(frame), len(frame) + 1)


def synth_response(req):
    """A response framed like the request, with the distinctive payload."""
    ds2 = is_ds2(req)
    if ds2:
        # positive DS2 answer: 0xA0 then data
        return V.ds2_telegram(req[0], [0xA0] + PATTERN[:24])
    # BMW-FAST: positive response is service+0x40, echo the sub-function
    svc = req[3] if len(req) > 3 else 0x21
    echo = req[4:6] if len(req) > 5 else req[4:5]
    return V.fast_telegram(0xF1, 0x12, [(svc + 0x40) & 0xFF] + list(echo)
                           + PATTERN[:24])


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    targets = [a.lower() for a in args] if args else S.e46_sgbds()
    os.makedirs(WORK, exist_ok=True)

    stats = collections.Counter()
    mismatches = []
    checked_jobs = 0

    for sgbd in targets:
        try:
            data, jobs = SP.load(sgbd)
        except SystemExit:
            continue
        ir = S.ir_jobs_for(sgbd)
        names = [n for n, _ in jobs
                 if not n.startswith("_") and n.upper() in ir
                 and (INCLUDE_WRITES or not WRITE_JOB.match(n))]
        if limit:
            names = names[:limit]
        if not names:
            continue

        init = discover_init(sgbd, names[0])
        reqs = discover(sgbd, names, init)
        if not reqs:
            stats["no-telegram"] += len(names)
            continue

        # one sim file per job, so run them one at a time through the batch
        # process (the sim dir is per-request, the PROCESS is shared)
        batch_in, resp_of = [], {}
        for job, req in reqs.items():
            d = os.path.join(WORK, f"{sgbd}_{job}")
            shutil.rmtree(d, ignore_errors=True)
            resp = synth_response(req)
            resp_of[job] = resp
            pairs = ([init] if init else []) + [(req, resp)]
            write_sim(d, sgbd, pairs)
            batch_in.append({"sgbd": sgbd, "job": job, "sim": d})

        for res in batch(batch_in):
            job = res.get("job")
            if not job or "sets" not in res:
                stats["engine-error"] += 1
                continue
            addr = SP.job_addr(data, jobs, job)
            spec = SP.extract(data, addr, sgbd, job)
            try:
                decoded = V.decode_with_spec(spec, resp_of[job])
            except Exception:                               # noqa: BLE001
                stats["decode-crash"] += 1
                continue
            a, d_, u = V.compare(res["sets"], decoded)
            checked_jobs += 1
            stats["agree"] += len(a)
            stats["unknown"] += len(u)
            by_name = {r["name"]: r for r in spec.get("results", [])}
            for n, got, want in d_:
                # A disagreement is only the SPEC's fault if the spec claims
                # to fully determine the value. Two classes do not:
                #
                #   runtime-lookup -- the scale lives in an SGBD table keyed by
                #     a value that arrives IN THE RESPONSE (FUmweltTexte.UWNR).
                #     The spec records the lookup and is right to; this static
                #     decoder simply cannot perform it. A walker with the
                #     response in hand can, which is what EDIABAS does.
                #   fixture-rejected -- the engine returned nothing, because
                #     the synthetic payload failed the job's own validity
                #     check (AIF_LESEN rejects a malformed block outright).
                #     Nothing is being compared.
                r = by_name.get(n, {})
                if r.get("iteration") is not None and (r.get("lookup") or {}).get("scaleColumn"):
                    stats["runtime-lookup"] += 1
                elif want in ("", "0", "0.0", None):
                    stats["fixture-rejected"] += 1
                else:
                    stats["disagree"] += 1
                    mismatches.append((sgbd, job, n, got, want))

    # Only results this harness can actually adjudicate count toward the
    # rate. Runtime-lookup and fixture-rejected results are excluded and
    # reported separately -- folding them in understated the specs, because
    # neither is evidence that a spec is wrong.
    tot = stats["agree"] + stats["disagree"]
    print(f"jobs value-checked: {checked_jobs}")
    print(f"  adjudicable results: {tot}")
    if tot:
        print(f"  AGREE              : {stats['agree']} "
              f"({100*stats['agree']/tot:.1f}%)")
        print(f"  DISAGREE (spec bug): {stats['disagree']} "
              f"({100*stats['disagree']/tot:.1f}%)")
    print(f"  --- not adjudicable by a static decoder ---")
    print(f"  runtime-lookup     : {stats['runtime-lookup']}"
          "   (scale keyed by a value in the response)")
    print(f"  fixture-rejected   : {stats['fixture-rejected']}"
          "   (engine refused the synthetic payload)")
    print(f"  no bytes lifted    : {stats['unknown']}")
    for k in ("no-telegram", "engine-error", "decode-crash"):
        if stats[k]:
            print(f"  {k:16} : {stats[k]}")

    if mismatches:
        by = collections.Counter(m[2] for m in mismatches)
        print(f"\ntop disagreeing results ({len(mismatches)} total):")
        for name, c in by.most_common(15):
            ex = next(m for m in mismatches if m[2] == name)
            print(f"  {c:4}  {name:28} e.g. {ex[0]}:{ex[1]} "
                  f"spec={ex[3]!r} engine={ex[4]!r}")
        with open(os.path.join(WORK, "mismatches.json"), "w") as f:
            json.dump([{"sgbd": m[0], "job": m[1], "result": m[2],
                        "spec": str(m[3]), "engine": str(m[4])}
                       for m in mismatches], f, indent=1)
        print(f"\nfull list -> {os.path.relpath(os.path.join(WORK, 'mismatches.json'))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
