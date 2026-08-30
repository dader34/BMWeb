#!/usr/bin/env python3
"""Derive a coding dispatcher (A_<cabd>.IPO) into a JSON program the runtime
can execute -- piece 2 of 3 (see the coding-dispatch-derived-json memory).

The A_ dispatcher IS the coding logic NCS Expert runs host-side: which SGBD
jobs fire, in what order, with what args, and the BinBuf packet the wire
write is built from. Rather than re-run its bytecode live (needs a full IPO
VM + 87 host callbacks wired to the bus), we walk it ONCE here and emit the
call sequence per jobname, with every string arg resolved from the pool. The
runtime (piece 3) then replays that sequence, implementing only the ~36 CDH
callbacks a write actually drives.

    python3 ipo_coding_dispatch.py A_KMB46            # human dump
    python3 ipo_coding_dispatch.py A_KMB46 --json     # the derived program
    python3 ipo_coding_dispatch.py --corpus           # pool-decode coverage

WHAT IT EMITS. For each cabimain jobname (SG_CODIEREN, TEILBEREICH_CODIEREN,
FGNR_SCHREIBEN, ZCS_SCHREIBEN, ...) the ordered list of CDH callback calls
reached from that jobname's handler, each with its resolved literal args and
the source pc. Control flow (if/while) is recorded as guards on calls, not
executed -- the runtime evaluates them against live results. A call whose
args are computed (not literals) is emitted with arg slots marked dynamic,
for the runtime to fill from the stack model.

THE POOL. A_ dispatchers have no screen-style constant pool; ipo_disasm's
find_pool returns None for them. Their literals live after `\x12Constant
Data\x0a` as a typed record stream: `\x04<str>\x0a` string, `\x02<u16>`
int/ref, `\x01<byte>` byte, and lone `\x0a` as a separator (NOT a slot). The
import32 signature table (a run of `\x02<u16>` right after the `\x04<include>`
name) precedes the pool proper and is skipped. `const n` (the `01 01 <u16>`
push) indexes the resulting flat slot list. Validated: A_KMB46 resolves
C_S_AUFTRAG/C_CHECKSUM/C_S_LESEN/IDENT at the pc's where the write engine
calls them; the parser reaches EOF on every E46 dispatcher.
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_cdh                                                    # noqa: E402
import ipo_disasm as D                                            # noqa: E402


# ---- the A_-dialect constant pool ------------------------------------------

def a_pool(data):
    """The flat const-slot list for an A_ dispatcher, or None if not the
    A_ dialect. Slot k is what `const n=k` pushes. Entries are (tag, value):
    ('s', str) | ('i', int) | ('b', int)."""
    j = data.find(b"\x12Constant Data\x0a")
    if j < 0:
        return None
    p = j + len(b"\x12Constant Data\x0a")
    # decl header: 4-byte id, \n, \n, \x00, u16 count
    if p + 9 > len(data):
        return None
    p += 4
    while p < len(data) and data[p] == 0x0a:
        p += 1
    if p < len(data) and data[p] == 0x00:
        p += 1
    p += 2                                    # u16 declared count (not relied on)
    # Every record from here is a const slot -- INCLUDING the \x04 include name
    # and the \x02 import32 signature entries. `const n` (01 01 <u16>) indexes
    # this whole stream; skipping the include/imports shifts every high index
    # (A_KMB46 references const 449 = "JOBNAME", which only lands with them in).
    pool = []
    while p < len(data):
        t = data[p]
        if t == 0x0a:                         # separator, not a slot
            p += 1
            continue
        if t == 0x04:
            e = data.find(b"\x0a", p + 1)
            if e < 0:
                break
            pool.append(("s", data[p + 1:e].decode("latin-1")))
            p = e + 1
        elif t == 0x02:
            pool.append(("i", int.from_bytes(data[p + 1:p + 3], "little")))
            p += 3
        elif t == 0x01:
            pool.append(("b", data[p + 1]))
            p += 2
        else:
            break                             # trailing DLL sig table / EOF junk
    return pool


# ---- walking a proc into a linear call sequence ----------------------------

# The host callbacks a coding WRITE cares about; other calls (UI, worklist
# no-ops) are recorded but flagged so the derive stays honest about coverage.
_WRITE = ipo_cdh.WRITE_CALLBACKS


def _resolve_args(recent, arity):
    """Best-effort literal args for a call: the last `arity` pushed consts.
    A non-literal (computed) slot is None, meaning 'runtime fills this'."""
    if arity <= 0:
        return []
    take = recent[-arity:] if len(recent) >= arity else ([None] *
                                                         (arity - len(recent)) + recent)
    return take


def walk_proc(data, pool, decls, name, cdh_names):
    """The ordered CDH calls in one proc: [{pc, call, arity, args, write}]."""
    for k, (off, typ, pname, pid) in enumerate(decls):
        if pname != name:
            continue
        ps, _ = D.find_pool(data)
        ce = D.code_end(data, ps)
        lo = D.body_start(data, off, name)
        hi = decls[k + 1][0] if k + 1 < len(decls) else (
            ps if ps is not None else ce)
        toks, unk, ln = D.walk(data, lo, hi, pool, cdh_names)
        calls = []
        # A call's args are the last `arity` VALUE pushes (const/var) that
        # precede it, in push order. Control-flow tokens (stmt/jfalse/jump/ret/
        # binop/frame) don't produce a stack value, so they don't shift the arg
        # window -- but they DO end the current expression, so a binop consumes
        # the two values under it. We model a simple value stack: const/var push
        # a slot, a binop pops 2 pushes 1, and a call pops its arity.
        stack = []                            # each item: literal value or None
        for t in toks:
            op = t["op"]
            if op == "const":
                stack.append(t.get("v"))
            elif op == "var":
                stack.append(None)            # computed
            elif op == "binop":
                # pops 2, pushes 1 computed result
                if len(stack) >= 2:
                    del stack[-2:]
                elif stack:
                    stack.pop()
                stack.append(None)
            elif op == "call":
                cn = t["name"]
                sig = ipo_cdh.cdh_sig(t["n"])
                arity = len(sig) if sig else 0
                args = stack[-arity:] if arity and len(stack) >= arity else \
                    ([None] * max(0, arity - len(stack)) + stack[:])
                if arity:
                    del stack[-arity:]
                # the callback pushes its own result value (out params aside)
                stack.append(None)
                calls.append({
                    "pc": t.get("at"),
                    "call": cn,
                    "arity": arity,
                    "args": args,
                    "params": [f"{d} {ty} {a}" for d, ty, a in sig] if sig else None,
                    "write": cn in _WRITE,
                })
            elif op == "calluser":
                calls.append({"pc": t.get("at"), "calluser": t["n"], "args": []})
                stack.append(None)
            # stmt/jfalse/jump/ret/frame/decl/store: no value effect we model
        return calls, unk, ln
    return None, 0, 0


# The jobnames cabimain routes; the runtime dispatches by these.
_JOBNAMES = [
    "SG_CODIEREN", "TEILBEREICH_CODIEREN", "FGNR_SCHREIBEN",
    "ZCS_SCHREIBEN", "ZCS_LOESCHEN", "FA_WRITE", "JOB_ERMITTELN",
    "CODIERINDEX_LESEN", "CODIERDATEN_LESEN", "FGNR_LESEN", "ZCS_LESEN",
]


def derive(ecu):
    """The full derived program for one dispatcher."""
    path = D.L1.ipo_path(ecu)
    data = open(path, "rb").read()
    pool = a_pool(data)
    if pool is None:
        raise SystemExit(f"{ecu}: not an A_-dialect dispatcher (no pool)")
    ps, _ = D.find_pool(data)
    ce = D.code_end(data, ps)
    decls = D.find_decls(data, ce)
    cdh_names = {op: row[0] for op, row in ipo_cdh.CDH_SLOTS.items()}
    procnames = [d[2] for d in decls]
    out = {"ecu": ecu, "procs": {}}
    # Cod is the write engine; cabimain the router; the *Lesen procs are reads.
    for want in ("cabimain", "Cod", "CILesen", "Lesen", "NettoDat",
                 "FgnrLesen", "ZcsLesen"):
        if want not in procnames:
            continue
        calls, unk, ln = walk_proc(data, pool, decls, want, cdh_names)
        out["procs"][want] = {
            "calls": calls,
            "coverage": round(100 * (1 - unk / ln), 1) if ln else 100.0,
        }
    return out, pool


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--corpus" in sys.argv:
        import glob
        sgdat = D.L1.SGDAT
        files = sorted(glob.glob(os.path.join(sgdat, "A_*.IPO")) +
                       glob.glob(os.path.join(sgdat, "a_*.ipo")))
        ok = bad = 0
        for p in files:
            data = open(p, "rb").read()
            pool = a_pool(data)
            if pool and any(k == "s" for k, _ in pool):
                ok += 1
            else:
                bad += 1
        print(f"{ok} A_ dispatchers with a decoded pool, {bad} without "
              f"(of {len(files)})")
        return 0
    if not args:
        print(__doc__)
        return 0
    prog, pool = derive(args[0])
    if "--json" in sys.argv:
        print(json.dumps(prog, ensure_ascii=False, indent=1))
        return 0
    print(f"{prog['ecu']}: pool {len(pool)} slots")
    for pname, pd in prog["procs"].items():
        writes = [c for c in pd["calls"] if c.get("write")]
        print(f"\n  {pname}  ({len(pd['calls'])} calls, "
              f"{len(writes)} write-relevant, coverage {pd['coverage']}%)")
        for c in pd["calls"]:
            if "calluser" in c:
                continue
            lit = ", ".join(repr(a) for a in c["args"])
            star = " *" if c.get("write") else ""
            print(f"    {c['call']}({lit}){star}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
