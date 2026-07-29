#!/usr/bin/env python3
"""Value-level differential: does a lifted spec decode bytes like the engine?

tools/sgbd_diff.py proves a spec knows WHICH results a job produces. This
proves it decodes them to the SAME VALUES -- the gate for calling a spec
verified, and the only check that exercises scale, offset and field extraction.

Method, no car required:

  1. Write a .sim file (EdiabasLib simulation) pairing request telegrams with
     responses we choose, so the "ECU" answers known bytes.
  2. `inpamac simrun <JOB> <sgbd> --sim <dir>` runs the REAL engine against it
     and prints the result sets as JSON.
  3. Decode the same response bytes with the lifted spec.
  4. Compare. Any disagreement is the spec's, since the bytes are identical.

Discovering a job's request telegram is itself done by the engine: run once
with --trace, read `(Send sim)` out of ifh.trc, and that is the request key the
.sim needs. Guessing telegrams by hand does not work -- MS450's STATUS_UBATT
sends `82 12 F1 21 A3` (KWP2000 service 0x21, PID 0xA3), not the DS2 shape its
job name suggests.

    python3 tools/sgbd_value_diff.py ms450ds0 STATUS_UBATT --raw 76,0A
    python3 tools/sgbd_value_diff.py --selftest

The harness is deliberately small: it verifies the CASES WE HAVE BYTES FOR.
Broad verification needs captures from a real car (record `_TEL_AUFTRAG` /
`_TEL_ANTWORT` during a live session and replay them here), which is the
honest limit of what can be claimed without one.
"""
import os
import re
import sys
import json
import glob
import struct
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, HERE)
import sgbd_spec as SP                                        # noqa: E402

SIM_DIR = os.path.join(ROOT, "data", "sim-captures")
CLI = os.path.join(ROOT, "src", "InpaMac.Cli")


def fast_telegram(dst, src, payload):
    """BMW-FAST frame: [0x80|len, dst, src, (len), payload..., sum]."""
    n = len(payload)
    tel = ([0x80 | n, dst, src] if n <= 0x3f else [0x80, dst, src, n]) + payload
    return tel + [sum(tel) & 0xff]


def hexcsv(bs):
    return ",".join(f"{b:02X}" for b in bs)


def write_sim(sim_dir, sgbd, pairs):
    """pairs: [(request_bytes, response_bytes)] -> <sgbd>.sim and obd.sim.

    Both files are needed: EdiabasLib looks up an INTERFACE sim file named
    after the interface type (obd.sim) at connect time, and an SGBD sim file
    named after the .prg. Bytes are COMMA separated -- space separated values
    parse as one oversized token and the file is silently rejected (IFH-0026).
    """
    os.makedirs(sim_dir, exist_ok=True)
    req = "\n".join(f"R{i+1} = {hexcsv(q)}" for i, (q, _) in enumerate(pairs))
    rsp = "\n".join(f"R{i+1} = {hexcsv(a)}" for i, (_, a) in enumerate(pairs))
    body = f"[REQUEST]\n{req}\n\n[RESPONSE]\n{rsp}\n"
    for name in (sgbd.lower() + ".sim", "obd.sim"):
        with open(os.path.join(sim_dir, name), "w") as f:
            f.write(body)
    return body


def run_engine(sgbd, job, sim_dir, arg=None, trace_dir=None):
    """The real EDIABAS engine's result sets for a job, against sim_dir."""
    cmd = ["dotnet", "run", "--project", CLI, "--", "simrun", job, sgbd,
           "--sim", sim_dir]
    if arg:
        cmd += ["--arg", arg]
    if trace_dir:
        cmd += ["--trace", trace_dir]
    env = dict(os.environ, DOTNET_ROLL_FORWARD="Major")
    out = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=ROOT)
    for line in out.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    return {"error": (out.stdout + out.stderr).strip().splitlines()[-1:]}


def sent_telegram(trace_dir):
    """The request the engine last put on the wire, from its own IFH trace."""
    path = os.path.join(trace_dir, "ifh.trc")
    if not os.path.exists(path):
        return None
    sends = re.findall(r"\(Send sim\):\s*([0-9A-Fa-f ]+)",
                       open(path, errors="replace").read())
    return [int(b, 16) for b in sends[-1].split()] if sends else None


def decode_with_spec(spec, telegram):
    """Decode a full response TELEGRAM per the lifted spec.

    `bytes` on a result are absolute offsets into the telegram, exactly as the
    bytecode indexes it -- so the caller passes the whole frame, not a
    hand-sliced payload. Anything the spec did not pin down decodes to None
    and the comparison reports it as unknown rather than pretending.
    """
    # How far into the frame the spec's offsets are measured from depends on
    # the PROTOCOL, which is why one hardcoded strip could not satisfy both:
    #
    #   BMW-FAST  [0x80|len, dst, src, ...data]  the bytecode strips the
    #             3-byte header into its own register, so offsets are
    #             payload-relative (MS450 STATUS_UBATT reads [2,3] of the data)
    #   DS2       [addr, len, ...data, xor]      the bytecode indexes the frame
    #             directly, so offsets are frame-relative (BMS46 IDENT reads
    #             [3..9], which IS the frame, header included)
    #
    # Detected from the frame itself: BMW-FAST always sets bit 7 of byte 0.
    fast = bool(telegram) and (telegram[0] & 0x80) == 0x80
    payload = telegram[3:] if fast and len(telegram) > 3 else telegram
    out = {}
    for r in spec.get("results", []):
        if r.get("const") is not None:
            out[r["name"]] = r["const"]
            continue
        offs = r.get("bytes")
        telegram_ = payload if r.get("base") == "payload" else telegram
        if not offs or any(o >= len(telegram_) for o in offs):
            out[r["name"]] = None
            continue
        if r.get("type") == "string":
            # a string result is the BYTES, not a number built from them:
            # AIF_FG_NR is a 7-byte VIN field, and folding it into an integer
            # produced 0 where the engine reports the (empty) text.
            # NUL-terminate only. `.strip()` looked harmless and silently ate
            # real payload: BMS46's ID_DIAG_INDEX is the two bytes 08,09, and
            # 0x09 is a TAB, so stripping whitespace deleted half the value and
            # reported a disagreement the lifted offsets had not caused.
            out[r["name"]] = bytes(telegram_[o] for o in offs) \
                .split(b"\0")[0].decode("latin-1", "replace")
            continue
        if r.get("ascii"):
            # the bytes are digit CHARACTERS parsed by a2fix, not a binary
            # number -- reading them as big-endian gives 1029 for "05"
            txt = bytes(telegram_[o] for o in offs).decode("latin-1", "replace")
            digits = "".join(c for c in txt if c.isdigit())
            out[r["name"]] = int(digits) if digits else 0
            continue
        raw = 0
        for o in offs:                      # big-endian, in bytecode read order
            raw = (raw << 8) | telegram_[o]
        if r.get("scale") is not None:
            out[r["name"]] = raw * r["scale"] + (r.get("offset") or 0.0)
        else:
            out[r["name"]] = raw
    return out


def compare(engine_sets, decoded, tol=1e-6):
    """(agree, disagree, unknown) comparing decoded values to the engine's."""
    eng = {}
    for s in engine_sets:
        for k, v in s.items():
            if not k.startswith("_") and k not in ("SAETZE", "JOBSTATUS"):
                eng.setdefault(k, v)
    agree, disagree, unknown = [], [], []
    for name, val in decoded.items():
        if name not in eng:
            unknown.append((name, val, None))
            continue
        want = eng[name]
        if val is None:
            unknown.append((name, val, want))
            continue
        try:
            if abs(float(val) - float(want)) <= max(tol, abs(float(want)) * 1e-6):
                agree.append((name, val, want))
            else:
                disagree.append((name, val, want))
        except (TypeError, ValueError):
            (agree if str(val) == str(want) else disagree).append(
                (name, val, want))
    return agree, disagree, unknown


INIT_PAIR = ([0x82, 0x12, 0xF1, 0x1A, 0x80], None)   # response filled in below

# (sgbd, job, request telegram, response payload). Requests are the ones the
# engine itself put on the wire (captured with --trace); payloads are chosen so
# each scaled result lands on a recognisable value.
CASES = [
    ("ms450ds0", "STATUS_UBATT",
     [0x82, 0x12, 0xF1, 0x21, 0xA3],
     [0x61, 0xA3, 0x76, 0x0A]),
    ("ms450ds0", "STATUS_MOTORDREHZAHL",
     [0x83, 0x12, 0xF1, 0x22, 0x40, 0x00],
     [0x62, 0x40, 0x00] + [0] * 7 + [0x0F, 0xA0, 0x0B, 0xB8]),
    # AIF_LESEN: the programming-log block. Its own size check rejects
    # arbitrary payloads (ERROR_SIZE_UIF), so the count byte must be 1 --
    # which is also how the engine was made to answer OKAY here at all.
    # Exercises the multi-byte STRING results (the VIN fields).
    ("ms450ds0", "AIF_LESEN",
     [0x86, 0x12, 0xF1, 0x23, 0x00, 0x00, 0x00, 0x07, 0x40],
     [0x63, 0x01] + [0x00] * 30),
    # A DS2 ECU, to keep the two framings honest: DS2 offsets are
    # FRAME-relative where BMW-FAST's are payload-relative, and one hardcoded
    # header strip cannot serve both.
    ("bms46ds0", "IDENT", [0x12, 0x04, 0x00],
     [0xA0, 0x12, 0x34, 0x56, 0x78, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
      0x07, 0x08, 0x09, 0x0A], "ds2"),
]


def ds2_telegram(addr, payload):
    """DS2 frame: [addr, len, ...payload, xor-of-all-preceding]."""
    tel = [addr, len(payload) + 3] + list(payload)
    x = 0
    for b in tel:
        x ^= b
    return tel + [x]


def run_case(sgbd, job, req, payload, verbose=True, ds2=False):
    data, jobs = SP.load(sgbd)
    addr = SP.job_addr(data, jobs, job)
    if addr is None:
        print(f"{sgbd}:{job} absent")
        return 0, 0, 0
    spec = SP.extract(data, addr, sgbd, job)
    if ds2:
        # DS2 ECUs need no init exchange and frame differently
        resp = ds2_telegram(0x12, payload)
        write_sim(SIM_DIR, sgbd, [(req, resp)])
    else:
        resp = fast_telegram(0xF1, 0x12, payload)
        init = (INIT_PAIR[0], fast_telegram(0xF1, 0x12, [0x5A, 0x80] + [0] * 10))
        write_sim(SIM_DIR, sgbd, [init, (req, resp)])
    res = run_engine(sgbd, job, SIM_DIR)
    if "sets" not in res:
        print(f"{sgbd}:{job} engine run failed: {res}")
        return 0, 1, 0
    agree, disagree, unknown = compare(res["sets"], decode_with_spec(spec, resp))
    if verbose:
        print(f"{sgbd}:{job}")
        for n, got, want in agree:
            print(f"  AGREE     {n:30} spec={got}  engine={want}")
        for n, got, want in disagree:
            print(f"  DISAGREE  {n:30} spec={got}  engine={want}")
        for n, got, want in unknown:
            print(f"  UNKNOWN   {n:30} spec={got}  engine={want}")
    return len(agree), len(disagree), len(unknown)


def selftest():
    """Every case must decode to exactly what the engine decodes."""
    ta = td = tu = 0
    for case in CASES:
        sgbd, job, req, payload = case[:4]
        a, d, u = run_case(sgbd, job, req, payload,
                           ds2=(len(case) > 4 and case[4] == "ds2"))
        ta, td, tu = ta + a, td + d, tu + u
    print(f"\n{ta} agree, {td} disagree, {tu} not decodable from the spec yet")
    return 1 if td else 0


def main():
    if "--selftest" in sys.argv or len(sys.argv) == 1:
        return selftest()
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sgbd, job = args[0].lower(), args[1].upper()
    raw = []
    if "--raw" in sys.argv:
        raw = [int(x, 16) for x in
               sys.argv[sys.argv.index("--raw") + 1].split(",")]
    data, jobs = SP.load(sgbd)
    addr = SP.job_addr(data, jobs, job)
    if addr is None:
        raise SystemExit(f"{sgbd} has no job {job}")
    spec = SP.extract(data, addr, sgbd, job)
    print(json.dumps(decode_with_spec(spec, raw), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
