#!/usr/bin/env python3
"""Survey pass for jobs-to-JSON: how much of each SGBD is declarative?

Walks the compiled BEST2 bytecode of every job in a set of .prg files (format
learned from EdiabasNet.cs: job table at *0x88, 0x44-byte entries, stream
XOR 0xF7, 2-byte op header + addressing-mode-sized operands, job ends at two
consecutive `eoj`) and classifies each job by what its code DOES:

    static       no bus traffic at all -- results computed locally
    fixed_read   sends telegrams, takes no arguments, straight-line code
    param_read   same, but job arguments (par*) feed the request
    looped_read  result loop (back-branch around erg* stores) -- FS_LESEN shape
    computed     dense bit/arith work or external procedure calls: real code
                 (seed-key login, checksummed writes, flash primitives)

The first four reduce to declarative JSON specs (request template + response
field extraction, plus a repeat construct for looped_read); `computed` is the
tail that keeps an engine or a hand-written handler.

A second cut weights by the jobs the IR actually references -- the jobs the
product runs -- because a .prg ships dozens of dev/EOL jobs nobody calls.

    python3 tools/sgbd_survey.py                  # E46 set (from CFGDAT config)
    python3 tools/sgbd_survey.py ms450ds0 ...     # explicit SGBDs
    python3 tools/sgbd_survey.py --all            # every .prg in vendor
    python3 tools/sgbd_survey.py --dump ms450ds0 STATUS_LESEN   # disassemble
"""
import os
import re
import sys
import json
import glob
import struct
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..", "..")
ECU_DIR = os.path.join(ROOT, "vendor", "EDIABAS", "Ecu")
IR_DIR = os.path.join(ROOT, "data", "inpa-ir")
CFG = os.path.join(ROOT, "vendor", "EC-APPS", "INPA", "CFGDAT", "E46.ENG")

# opcode number -> name, transcribed from EdiabasNet.cs OcList (184 entries)
OPS = json.load(open(os.path.join(HERE, "best2_ops.json"))) \
    if os.path.exists(os.path.join(HERE, "best2_ops.json")) else None

# operand byte counts per addressing mode (EdiabasNet.GetOpArg). ImmStr is
# 2-byte length + payload, handled inline.
MODE_LEN = {0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 2, 7: 4, 8: None,
            9: 3, 10: 2, 11: 4, 12: 5, 13: 4, 14: 4, 15: 3}

SENDS = {"xsend", "xsendf", "xsendr", "xsendex", "xrequf", "xraw"}
RECVS = {"xrecv", "xrecvex"}
PARAMS = {"parb", "parl", "parn", "parr", "pars", "parw", "pary"}
RESULTS = {"ergb", "ergc", "ergd", "ergi", "ergl", "ergr", "ergs",
           "ergw", "ergy", "ergsysi"}
TABLES = {"tabset", "tabsetex", "tabseek", "tabseeku", "tabget", "tabline",
          "tabcols", "tabrows"}
FLOATS = {"fadd", "fsub", "fmul", "fdiv", "fix2flt", "flt2fix", "y42flt",
          "y82flt", "flt2y4", "flt2y8", "flt2a", "a2flt", "setflt"}
INTMATH = {"adds", "subb", "mult", "divs", "addc", "subc"}
BITOPS = {"and", "or", "xor", "not", "asl", "asr", "lsl", "lsr"}
# shmget/shmset are NOT here: shared-memory state shows up in ordinary job
# prologues (MS450 IDENT uses it) and is host-local bookkeeping, not logic.
EXTCALL = {"pcall", "plink", "plinkv", "pjtsr"}
JUMPS = {"jump", "ja", "jae", "jbe", "jc", "jg", "jge", "jl", "jle",
         "jmi", "jnt", "jnv", "jnz", "jpl", "jt", "jv", "jz"}

WRITEISH = re.compile(
    r"SCHREIBEN|LOESCHEN|STEUERN|RESET|PROGRAMMIER|FLASH|CODIER|SETZEN"
    r"|LOGIN|AUTHENT|_WRITE|_CLEAR", re.I)


def read_jobs(path):
    """[(name, address)] from a .prg -- EdiabasNet.GetJobList."""
    data = open(path, "rb").read()
    (job_off,) = struct.unpack_from("<i", data, 0x88)
    if job_off < 0 or job_off >= len(data):
        return data, []
    (n,) = struct.unpack_from("<i", data, job_off)
    jobs, pos = [], job_off + 4
    for _ in range(max(0, n)):
        raw = bytes(b ^ 0xF7 for b in data[pos:pos + 0x44])
        if len(raw) < 0x44:
            break
        name = raw[:0x40].split(b"\0")[0].decode("latin-1", "replace")
        (addr,) = struct.unpack_from("<I", raw, 0x40)
        jobs.append((name, addr))
        pos += 0x44
    return data, jobs


REGS = json.load(open(os.path.join(HERE, "best2_regs.json"))) \
    if os.path.exists(os.path.join(HERE, "best2_regs.json")) else {}


def _reg(b):
    return REGS.get(str(b), f"r{b:02x}")


def walk(data, addr, limit=250_000):
    """Yield (op_addr, opname, args) until two consecutive eoj.

    `args` is a list of decoded operands, each a dict:
      {"m": mode, "v": int}            immediate
      {"m": mode, "r": "A0"}           register
      {"m": 8, "s": "TEXT"}            inline string
      {"m": mode, "r": .., "i": ..}    indexed forms (register + index/len)
    Jump targets are already resolved to absolute addresses in "v".
    """
    pos, eoj_run, seen = addr, 0, 0
    while seen < limit and pos + 2 <= len(data):
        start = pos
        op = data[pos] ^ 0xF7
        modes = data[pos + 1] ^ 0xF7
        pos += 2
        name = OPS.get(str(op))
        if name is None:
            return  # decode drifted: stop rather than emit garbage
        args = []
        for mode in ((modes & 0xF0) >> 4, modes & 0x0F):
            if mode == 0:
                continue
            if mode == 8:  # ImmStr: 2-byte length + payload
                if pos + 2 > len(data):
                    return
                (slen,) = struct.unpack("<h", bytes(
                    b ^ 0xF7 for b in data[pos:pos + 2]))
                pos += 2
                raw = bytes(b ^ 0xF7 for b in data[pos:pos + max(0, slen)])
                pos += max(0, slen)
                # "s" is the TEXT reading, NUL-terminated, which is what
                # every caller that wants a name or caption expects. But an
                # inline literal is also how a job carries a TELEGRAM
                # TEMPLATE, and those contain NULs as data -- ME9N45's
                # request is 83 12 F1 31 DA 00, which as text is just "\x83".
                # So the untruncated bytes ride along in "b" for callers
                # (tools/sgbd_code.py) that must reproduce them exactly.
                args.append({"m": mode,
                             "s": raw.split(b"\0")[0].decode("latin-1",
                                                             "replace"),
                             "b": list(raw)})
                continue
            ln = MODE_LEN.get(mode, 0)
            raw = bytes(b ^ 0xF7 for b in data[pos:pos + ln])
            pos += ln
            if len(raw) < ln:
                return
            if mode in (1, 2, 3, 4):                     # plain register
                args.append({"m": mode, "r": _reg(raw[0])})
            elif mode in (5, 6, 7):                      # immediate
                args.append({"m": mode,
                             "v": int.from_bytes(raw, "little")})
            elif mode == 9:                              # reg[#imm]
                args.append({"m": mode, "r": _reg(raw[0]),
                             "i": int.from_bytes(raw[1:3], "little")})
            elif mode == 10:                             # reg[reg]
                args.append({"m": mode, "r": _reg(raw[0]),
                             "ir": _reg(raw[1])})
            elif mode == 12:                             # reg[#idx]#len
                args.append({"m": mode, "r": _reg(raw[0]),
                             "i": int.from_bytes(raw[1:3], "little"),
                             "len": int.from_bytes(raw[3:5], "little")})
            elif mode == 13:                             # reg[#idx]lenreg
                args.append({"m": mode, "r": _reg(raw[0]),
                             "i": int.from_bytes(raw[1:3], "little"),
                             "lenr": _reg(raw[3])})
            elif mode == 14:                             # reg[idxreg]#len
                args.append({"m": mode, "r": _reg(raw[0]),
                             "ir": _reg(raw[1]),
                             "len": int.from_bytes(raw[2:4], "little")})
            else:                                        # 15: reg[idxreg]lenreg
                args.append({"m": mode, "r": _reg(raw[0]),
                             "ir": _reg(raw[1]), "lenr": _reg(raw[2])})
        # Jump targets are PC-RELATIVE and signed: EdiabasNet resolves them as
        # `labelAddress = pcCounter_after_operands + arg0` (Arg0IsNearAddress,
        # Imm32). Reading them as absolute made every backward branch look like
        # a jump into shared code far below the job -- which classified loops
        # as straight-line code and inflated the declarative share to 100%.
        if name in JUMPS and args and args[0].get("m") == 7:
            v = args[0]["v"]
            if v >= 0x80000000:
                v -= 0x100000000
            args[0]["v"] = pos + v
        yield start, name, args
        seen += 1
        if name == "eoj":
            eoj_run += 1
            if eoj_run >= 2:
                return
        else:
            eoj_run = 0


def fmt_arg(opname, a):
    """One operand, EdiabasNet GetOpArgText style."""
    m = a.get("m")
    if "s" in a:
        return f'"{a["s"]}"'
    if "v" in a:
        if opname in JUMPS:
            return f'L{a["v"]:06x}'
        return f'#${a["v"]:x}'
    idx = (f'#${a["i"]:x}' if "i" in a else a["ir"]) if ("i" in a or "ir" in a) \
        else None
    ln = (f'#${a["len"]:x}' if "len" in a else a.get("lenr"))
    if idx is not None:
        return f'{a["r"]}[{idx}]' + (f'#{ln}' if ln else "")
    return a.get("r", "?")


def classify(data, addr):
    """(archetype, features) for one job's bytecode."""
    f = collections.Counter()
    back_branch = loop_with_erg = False
    ops_seen = []
    ops = list(walk(data, addr))
    # loop bodies: the span of every backward branch that stays inside the job
    loops = [(a[0]["v"], st) for st, n, a in ops
             if n in JUMPS and a and "v" in a[0] and addr <= a[0]["v"] < st]

    def in_loop(a):
        return any(lo <= a <= hi for lo, hi in loops)

    for start, name, args in ops:
        imms = [a["v"] for a in args if "v" in a]
        # data-dependent math (both operands registers) inside a loop -- see
        # the note in the archetype decision below
        if name in (BITOPS | INTMATH) and not imms and in_loop(start):
            f["loopmath"] += 1
        ops_seen.append((start, name))
        f["ops"] += 1
        if name in SENDS:
            f["send"] += 1
        elif name in RECVS:
            f["recv"] += 1
        elif name in PARAMS:
            f["par"] += 1
        elif name in RESULTS:
            f["erg"] += 1
        elif name in TABLES:
            f["tab"] += 1
        elif name in FLOATS:
            f["flt"] += 1
        elif name in INTMATH:
            f["math"] += 1
        elif name in BITOPS:
            f["bit"] += 1
        elif name in EXTCALL:
            f["ext"] += 1
        elif name == "jtsr":
            f["sub"] += 1
        if name in JUMPS and imms:
            target = imms[0]
            # a REAL loop jumps backward to somewhere inside this job's own
            # body. A backward jump below the job's start address is a tail
            # jump into shared epilogue/error code, which nearly every job
            # has -- counting those classified 95% of the corpus as loops.
            if addr <= target < start:
                back_branch = True
                # a result-store between target and here = result loop
                if any(t >= target and n in RESULTS for t, n in ops_seen):
                    loop_with_erg = True
    if f["ops"] == 0:
        return "empty", f
    comm = f["send"] + f["recv"]
    # Code that COMPUTES, as opposed to code that extracts.
    #
    # The distinction that matters for a declarative spec, and the one a naive
    # op-density threshold gets wrong: `and A0, #$c0` is not computation, it is
    # a bit-FIELD -- every DS2 job masks the response header that way, and a
    # spec expresses it as {offset, mask}. What a spec cannot express is math
    # whose operands are both REGISTERS (data-dependent) running inside a loop:
    # BCD date unpacking in AIF_LESEN, the VIN nibble mill in FGNR_LESEN, the
    # gearbox shift sequences. Counting literal-operand ops as complexity put
    # 36% of the corpus in the "needs code" bucket; measuring data-dependent
    # loop math instead puts it at 9%, and every job in that 9% is nameable.
    if f["ext"] or (f["loopmath"] >= 6 and comm) or f["flt"] > 24:
        return "computed", f
    if comm == 0:
        return "static", f
    if loop_with_erg:
        return "looped_read", f
    if back_branch and comm:
        # loop around the comm itself (multi-telegram, block reads)
        return "looped_read", f
    if f["par"]:
        return "param_read", f
    return "fixed_read", f


def e46_sgbds():
    """sgbd names for the E46 set, via the resolved chassis config the app
    serves; fall back to scanning E46.ENG codes against the Ecu dir."""
    import urllib.request
    port = os.environ.get("BMACW_PORT")
    if port:
        try:
            # 60s, not 5: the app's FIRST /api/chassis call resolves every
            # ENTRY code against the .prg directory and can take tens of
            # seconds cold, while later calls answer in ~0.2s. A short timeout
            # silently fell back to the CFGDAT scan below, which finds 37 of
            # the 55 SGBDs -- so an identical command reported 628 or 701 jobs
            # depending only on whether the app happened to be warm.
            c = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/chassis/E46", timeout=60))
            return sorted({e["sgbd"].lower() for s in c["sections"]
                           for e in s["ecus"] if e.get("sgbd")})
        except Exception as ex:
            # loud, not silent: a partial ECU set makes every downstream
            # percentage wrong in a way that looks like a real result
            print(f"WARNING: chassis API failed ({type(ex).__name__}: {ex}); "
                  f"falling back to CFGDAT scan (fewer SGBDs)", file=sys.stderr)
    names = set()
    for m in re.finditer(r"^ENTRY=(\w+)", open(CFG, encoding="latin-1").read(),
                         re.M):
        code = m.group(1).lower()
        for cand in (code, code + "ds0"):
            if glob.glob(os.path.join(ECU_DIR, cand + ".prg")):
                names.add(cand)
    return sorted(names)


def all_shipped_sgbds():
    """Every SGBD named by an ECU in the ecus/ ship tree, all chassis.

    e46_sgbds() answers "what does the E46 need"; this answers "what can the
    app ever open". The VM's job code was generated from the former, so
    browsing any other chassis found no code and fell back to the engine --
    correct, but not coverage. Reads the shipped tree rather than the chassis
    API so it needs no running app and no cable.
    """
    names = set()
    for p in glob.glob(os.path.join(ROOT, "ecus", "*", "*", "ecu.json")):
        try:
            with open(p) as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        s = d.get("sgbd")
        if isinstance(s, str) and s:
            stem = s.lower()
            if stem.endswith(".prg"):
                stem = stem[:-4]
            # only what we can actually compile: the .prg must be present
            if glob.glob(os.path.join(ECU_DIR, stem + ".prg")):
                names.add(stem)
    return sorted(names)


def ir_jobs_for(sgbd):
    """Jobs the decompiled INPA UI actually runs for this SGBD, by stem."""
    stems = {sgbd}
    for suf in ("ds0", "ds2", "ds1", "_n", "ds"):
        if sgbd.endswith(suf):
            stems.add(sgbd[:-len(suf)])
    jobs = set()
    for f in glob.glob(os.path.join(IR_DIR, "*.json")):
        if os.path.basename(f)[:-5].lower() not in stems:
            continue
        ir = json.load(open(f))
        for scr in ir.get("screens", {}).values():
            for j in scr.get("jobs", []):
                jobs.add(j["name"].upper())
            for d in (scr.get("dispatch") or {}).values():
                if d.get("job"):
                    jobs.add(d["job"].upper())
        for menu in ir.get("menus", {}).values():
            for it in menu.get("items", []):
                if it.get("job"):
                    jobs.add(it["job"].upper())
        if ir.get("variantJob"):
            jobs.add(ir["variantJob"].upper())
    return jobs


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]

    if "--dump" in sys.argv:
        sgbd, want = args[0].lower(), args[1].upper()
        # .grp group files share the .prg container (see sgbd_spec.load)
        path = next(p for pat in ("*.prg", "*.PRG", "*.grp", "*.GRP")
                    for p in glob.glob(os.path.join(ECU_DIR, pat))
                    if os.path.basename(p)[:-4].lower() == sgbd)
        data, jobs = read_jobs(path)
        addr = next(a for n, a in jobs if n.upper() == want)
        # label every branch target so loop structure is visible in the listing
        targets = {a[0]["v"] for _, n, a in walk(data, addr)
                   if n in JUMPS and a and "v" in a[0]}
        for start, name, args in walk(data, addr):
            print(("L%06x:" % start if start in targets else " " * 8)
                  + f" {start:06x}  {name:9} " + ", ".join(fmt_arg(name, a)
                                                           for a in args))
        return 0

    if "--all" in sys.argv:
        targets = sorted(os.path.basename(p)[:-4].lower()
                         for p in glob.glob(os.path.join(ECU_DIR, "*.prg")))
    elif args:
        targets = [a.lower() for a in args]
    else:
        targets = e46_sgbds()

    order = ["fixed_read", "param_read", "looped_read", "static",
             "computed", "empty"]
    total = collections.Counter()
    ir_total = collections.Counter()
    per_ecu = []
    examples = collections.defaultdict(list)
    for sgbd in targets:
        path = next((p for p in glob.glob(os.path.join(ECU_DIR, "*.prg"))
                     + glob.glob(os.path.join(ECU_DIR, "*.PRG"))
                     if os.path.basename(p)[:-4].lower() == sgbd), None)
        if not path:
            continue
        data, jobs = read_jobs(path)
        counts = collections.Counter()
        ir_ref = ir_jobs_for(sgbd)
        ir_counts = collections.Counter()
        for name, addr in jobs:
            arch, f = classify(data, addr)
            counts[arch] += 1
            total[arch] += 1
            if name.upper() in ir_ref:
                ir_counts[arch] += 1
                ir_total[arch] += 1
                if len(examples[arch]) < 6:
                    examples[arch].append(f"{sgbd}:{name}")
        per_ecu.append((sgbd, len(jobs), counts, len(ir_ref), ir_counts))

    print(f"{'SGBD':14} {'jobs':>5}  "
          + " ".join(f"{k[:6]:>6}" for k in order)
          + "   | IR-used: total  declarative")
    for sgbd, n, c, nir, irc in per_ecu:
        decl = sum(irc[k] for k in ("fixed_read", "param_read",
                                    "looped_read", "static"))
        used = sum(irc.values())
        print(f"{sgbd:14} {n:>5}  "
              + " ".join(f"{c[k]:>6}" for k in order)
              + f"   |           {used:>3}       {decl:>3}")

    n_all = sum(total.values())
    decl_all = sum(total[k] for k in ("fixed_read", "param_read",
                                      "looped_read", "static"))
    n_ir = sum(ir_total.values())
    decl_ir = sum(ir_total[k] for k in ("fixed_read", "param_read",
                                        "looped_read", "static"))
    print(f"\nALL JOBS      {n_all:>6}: "
          + "  ".join(f"{k}={total[k]}" for k in order))
    if n_all:
        print(f"  declarative {decl_all}/{n_all} = {100*decl_all/n_all:.1f}%")
    print(f"IR-REFERENCED {n_ir:>6}: "
          + "  ".join(f"{k}={ir_total[k]}" for k in order))
    if n_ir:
        print(f"  declarative {decl_ir}/{n_ir} = {100*decl_ir/n_ir:.1f}%")
    print("\nIR-referenced examples per archetype:")
    for k in order:
        if examples[k]:
            print(f"  {k:12} {', '.join(examples[k])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
