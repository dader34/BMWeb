#!/usr/bin/env python3
"""Export each job's BEST2 instruction stream as executable JSON.

WHY THIS EXISTS, given tools/sgbd_spec.py already lifts declarative specs:
lifting cannot reach 100%. After exhausting every idiom the corpus shows,
~71% of results resolve; the tail is structural -- layouts that depend on a
branch, multi-telegram streaming, strings assembled byte by byte in a loop.
INPA is flawless because EDIABAS EXECUTES the job program rather than
summarising it. So we ship the program.

This is the VM's input format. Per SGBD:

    {
      "format": 1, "sgbd": "ms450ds0",
      "ops": [[opcode, [operand, ...]], ...],     // whole file, one array
      "jobs": {"STATUS_UBATT": 1423, ...},        // name -> index into ops
      "strings": ["...", ...]                     // dedup pool, see below
    }

Operands are compact arrays, not objects, because there are ~1.6M of them
across the corpus and JSON key repetition would triple the download:

    [MODE, ...payload]   payload by mode:
      imm      [v]                    5,6,7
      reg      [regName]              1,2,3,4
      str      [poolIndex]            8
      reg[imm] [regName, idx]         9
      reg[reg] [regName, idxReg]      10
      ranged   [regName, idx|idxReg, len|lenReg]   12,13,14,15
               (a null idx means "use the register named next"; the VM
                distinguishes by mode, exactly as the operand decoder does)

JUMP TARGETS ARE REWRITTEN TO OPS INDICES. In the .prg they are PC-relative
byte offsets, which a VM would have to re-derive; here arg0 of every jump is
the index of the target instruction. A target that does not land on an
instruction boundary would be a decode bug, so it is reported rather than
silently clamped.

    python3 tools/sgbd_code.py ms450ds0            # one, to stdout stats
    python3 tools/sgbd_code.py --all               # -> data/job-code/
"""
import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sgbd_survey as S                                       # noqa: E402
import sgbd_spec as SP                                        # noqa: E402

ROOT = os.path.join(HERE, "..")
OUT_DIR = os.path.join(ROOT, "data", "job-code")

# Modes whose payload is a jump target rather than a plain immediate are
# handled by the JUMPS set from the survey; every other mode-7 immediate
# stays a number.


def encode(data, addr_list):
    """Decode a whole .prg region into (ops, addr->index) form.

    Walks from each job entry, but into ONE shared ops array: jobs overlap
    (shared subroutine tails are normal in these files), and duplicating
    them would both bloat the download and let two copies drift.
    """
    ops = []
    index = {}          # byte address -> ops index
    strings = []
    spool = {}

    def sref(s):
        if s not in spool:
            spool[s] = len(strings)
            strings.append(s)
        return spool[s]

    def enc_arg(name, a):
        m = a.get("m")
        if "s" in a:
            return [m, sref(a["s"])]
        if "v" in a:
            return [m, a["v"]]
        r = a.get("r")
        if m == 9:
            return [m, r, a.get("i")]
        if m == 10:
            return [m, r, a.get("ir")]
        if m in (12, 13, 14, 15):
            return [m, r,
                    a.get("i") if a.get("i") is not None else a.get("ir"),
                    a.get("len") if a.get("len") is not None
                    else a.get("lenr")]
        return [m, r]

    pending = list(addr_list)
    seen = set()
    while pending:
        start = pending.pop(0)
        if start in seen:
            continue
        for st, name, args in S.walk(data, start):
            if st in index:
                break               # already encoded from another entry
            index[st] = len(ops)
            seen.add(st)
            ops.append([name, [enc_arg(name, a) for a in args]])
    return ops, index, strings


def relocate(ops, index, data):
    """Rewrite jump operands from byte offsets to ops indices."""
    unresolved = 0
    for i, (name, args) in enumerate(ops):
        if name in S.JUMPS and args and args[0][0] == 7:
            tgt = args[0][1]
            if tgt in index:
                args[0] = [7, index[tgt]]
            else:
                # a jump into a region no entry point reaches: keep the raw
                # offset, flag it, and let the VM fail loudly if taken
                args[0] = [7, None]
                unresolved += 1
    return unresolved


def export(sgbd, write=True):
    data, jobs = SP.load(sgbd)
    ir = S.ir_jobs_for(sgbd)
    wanted = [(n, a) for n, a in jobs
              if not n.startswith("_") and n.upper() in ir]
    if not wanted:
        return None
    ops, index, strings = encode(data, [a for _, a in wanted])
    unresolved = relocate(ops, index, data)
    out = {"format": 1, "sgbd": sgbd,
           "jobs": {n: index[a] for n, a in wanted if a in index},
           "ops": ops, "strings": strings}
    if unresolved:
        out["unresolvedJumps"] = unresolved
    if write:
        os.makedirs(OUT_DIR, exist_ok=True)
        p = os.path.join(OUT_DIR, f"{sgbd}.json")
        with open(p, "w") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        return (sgbd, len(out["jobs"]), len(ops), unresolved,
                os.path.getsize(p))
    return (sgbd, len(out["jobs"]), len(ops), unresolved, 0)


def main():
    args = [a.lower() for a in sys.argv[1:] if not a.startswith("--")]
    targets = args or S.e46_sgbds()
    tot_ops = tot_bytes = tot_unres = 0
    for sgbd in targets:
        try:
            r = export(sgbd)
        except SystemExit:
            continue
        if not r:
            continue
        name, njobs, nops, unres, size = r
        tot_ops += nops
        tot_bytes += size
        tot_unres += unres
        flag = f"  UNRESOLVED {unres}" if unres else ""
        print(f"  {name:12} {njobs:3} jobs {nops:6} ops "
              f"{size//1024:5} KB{flag}")
    print(f"code: {tot_ops} ops, {tot_bytes//1024} KB, "
          f"{tot_unres} unresolved jumps")
    return 0


if __name__ == "__main__":
    sys.exit(main())
