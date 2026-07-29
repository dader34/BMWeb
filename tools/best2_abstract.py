#!/usr/bin/env python3
"""Abstract interpreter for BEST2 dataflow: which response bytes feed a result?

The direct lifter in tools/sgbd_spec.py resolves a result whose bytes are read
in its own block. It cannot resolve the other kind, where the value arrives
through several dataflow steps -- MS450's STATUS_MESSWERTBLOCK_0 emits
`ergr "STAT_MESSWERT0_WERT", F0`, and F0 was computed upstream from a scratch
slot that the operand stack filled.

This models enough of the machine to follow that chain:

  * the operand stack (push/pop/atsp)
  * L/I/A registers and S0 scratch slots
  * integer arithmetic on known values (adds/subb/mult/asl/lsr)
  * response-byte reads, which produce a SYMBOL rather than a number

Everything is an abstract value: a concrete int, a Byte(offset) symbol, a
Sum of those, or UNKNOWN. Arithmetic over Byte symbols is what makes a
cursor like "response[base + 2*i]" fall out.

The loop is real, not unrolled. STATUS_MESSWERTBLOCK_0 ends in a jump table
(`comp L0,#$10 / jz ...` sixteen times) whose targets are the sixteen emit
sites, and the tail jumps BACK to the body -- one shared block executed once
per measurement, with S0[#$2] the iteration counter and S0[#$4] a byte cursor
advanced by S0[#$8] each pass. So the sixteen results are sixteen ITERATIONS,
and their offsets differ by the stride.

    python3 tools/best2_abstract.py ms450ds0 STATUS_MESSWERTBLOCK_0
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sgbd_survey as S                                       # noqa: E402


class Unknown:
    """A value the interpreter cannot pin down. Poisons anything it touches."""
    _inst = None

    def __new__(cls):
        if cls._inst is None:
            cls._inst = super().__new__(cls)
        return cls._inst

    def __repr__(self):
        return "?"


UNKNOWN = Unknown()

# Conditional jumps. Their bodies are skipped by resolve_result_bytes: a
# linear walk that executes both sides of a branch corrupts the value it is
# trying to trace. `jump` is deliberately absent -- an unconditional jump is
# control flow the real machine always takes.
_COND_JUMPS = {"ja", "jae", "jbe", "jc", "jg", "jge", "jl", "jle", "jmi",
               "jnt", "jnv", "jnz", "jpl", "jt", "jv", "jz"}


class Byte:
    """One response byte, by offset. `scale` carries an applied shift/multiply
    so `resp[3]<<8 | resp[4]` stays symbolic instead of collapsing."""

    __slots__ = ("offset", "scale")

    def __init__(self, offset, scale=1):
        self.offset = offset
        self.scale = scale

    def __repr__(self):
        return f"resp[{self.offset}]" + (f"*{self.scale}" if self.scale != 1
                                         else "")

    def __eq__(self, o):
        return (isinstance(o, Byte) and o.offset == self.offset
                and o.scale == self.scale)

    def __hash__(self):
        return hash((self.offset, self.scale))


class Sum:
    """A sum of Byte terms plus an integer constant."""

    __slots__ = ("terms", "const")

    def __init__(self, terms, const=0):
        self.terms = list(terms)
        self.const = const

    def __repr__(self):
        parts = [repr(t) for t in self.terms]
        if self.const:
            parts.append(str(self.const))
        return " + ".join(parts) or "0"

    def bytes_used(self):
        return sorted({t.offset for t in self.terms})


def _add(a, b):
    """Abstract addition, keeping Byte symbols intact."""
    if a is UNKNOWN or b is UNKNOWN:
        return UNKNOWN
    if isinstance(a, int) and isinstance(b, int):
        return a + b
    ta, ca = ([], a) if isinstance(a, int) else (
        (a.terms, a.const) if isinstance(a, Sum) else ([a], 0))
    tb, cb = ([], b) if isinstance(b, int) else (
        (b.terms, b.const) if isinstance(b, Sum) else ([b], 0))
    return Sum(ta + tb, ca + cb)


def _mul(a, b):
    if a is UNKNOWN or b is UNKNOWN:
        return UNKNOWN
    if isinstance(a, int) and isinstance(b, int):
        return a * b
    if isinstance(a, Byte) and isinstance(b, int):
        return Byte(a.offset, a.scale * b)
    if isinstance(b, Byte) and isinstance(a, int):
        return Byte(b.offset, b.scale * a)
    return UNKNOWN


def _shl(a, b):
    return _mul(a, 1 << b) if isinstance(b, int) and b < 32 else UNKNOWN


# B/I/L registers are VIEWS over one shared byte array (EdiabasNet
# Register.GetValueData): B0 is byte 0, I0 is bytes 0-1, L0 is bytes 0-3. So
# `move B0, S1[L1]` -- how every single-byte response read is written -- also
# changes L0, which is what the following `push L0` then puts on the stack.
# Modelling them as independent registers made every such read a dead end.
def _overlaps(reg):
    """Registers whose storage a write to `reg` also changes."""
    kind, idx = reg[0], int(reg[1:], 16)
    if kind == "B":
        base = idx
    elif kind == "I":
        base = idx * 2
    elif kind == "L":
        base = idx * 4
    else:
        return {reg}
    width = {"B": 1, "I": 2, "L": 4}[kind]
    hit = set()
    for k, w in (("B", 1), ("I", 2), ("L", 4)):
        for i in range(16):
            lo = i * w
            if lo < base + width and base < lo + w:
                hit.add(f"{k}{i:X}")
    return hit


def _narrower(reg):
    """Views strictly narrower than `reg` that start at the same byte."""
    kind, idx = reg[0], int(reg[1:], 16)
    base = {"B": idx, "I": idx * 2, "L": idx * 4}.get(kind)
    if base is None:
        return set()
    out = set()
    for k, w in (("B", 1), ("I", 2)):
        if w < {"B": 1, "I": 2, "L": 4}[kind] and base % w == 0:
            out.add(f"{k}{base // w:X}")
    return out


class Machine:
    """Abstract machine state for one linear pass over a job's bytecode."""

    def __init__(self):
        self.stack = []
        self.regs = {}
        self.slots = {}          # S0[n] scratch
        self.resp_regs = set()   # registers holding the response telegram
        self.seen_send = False

    def setreg(self, reg, val):
        """Write a register and propagate to the views sharing its storage.

        A narrow write into a cleared wider register IS the wider value --
        `clear L0` then `move B0, S1[L1]` is exactly how a single response
        byte is loaded, and the following `push L0` expects to see it. Only
        views whose other bytes are non-zero become unknown.
        """
        if reg and reg[0] in "BIL":
            for other in _overlaps(reg):
                if other == reg:
                    continue
                if self.regs.get(other) in (0, None) or other in _narrower(reg):
                    self.regs[other] = val
                else:
                    self.regs.pop(other, None)
        self.regs[reg] = val

    def get(self, arg):
        if arg is None:
            return UNKNOWN
        if "v" in arg:
            return arg["v"]
        if "s" in arg:
            return UNKNOWN
        r = arg.get("r")
        if arg.get("m") == 9 and r == "S0":
            return self.slots.get(arg.get("i"), UNKNOWN)
        if arg.get("m") == 9 and r in self.resp_regs:
            # a direct response-byte read
            return Byte(arg.get("i"))
        if arg.get("m") == 10 and r in self.resp_regs:
            idx = self.regs.get(arg.get("ir"), UNKNOWN)
            return Byte(idx) if isinstance(idx, int) else UNKNOWN
        if arg.get("m") in (12, 13, 14, 15) and r in self.resp_regs:
            # ranged read `S1[L0]#L1` -- a substring of the response. Index
            # and length are either immediates or registers; both forms
            # appear, and AIF_LESEN's VIN fields are built this way.
            idx = arg.get("i")
            if idx is None:
                idx = self.regs.get(arg.get("ir"), UNKNOWN)
            ln = arg.get("len")
            if ln is None and arg.get("lenr"):
                ln = self.regs.get(arg["lenr"], UNKNOWN)
            if isinstance(idx, int) and isinstance(ln, int) and 0 < ln <= 64:
                return Sum([Byte(idx + k) for k in range(ln)])
            return UNKNOWN
        return self.regs.get(r, UNKNOWN)

    def step(self, name, args):
        a0 = args[0] if args else None
        a1 = args[1] if len(args) > 1 else None

        if name in ("xsend", "xsendf", "xsendr", "xsendex", "xrequf", "xraw"):
            # Clear request-phase scratch on the FIRST send only. A job that
            # exchanges several telegrams (AIF_LESEN sends twice) carries
            # values decoded from the first response into the second phase,
            # and wiping the slots at every send threw those away -- its
            # numeric fields all resolved to the pre-send initialiser instead.
            if not self.seen_send:
                self.slots.clear()
            self.seen_send = True
            if a0 and "r" in a0:
                self.resp_regs = {a0["r"]}
            self.stack.clear()
            return

        if name == "push":
            self.stack.append(self.get(a0))
        elif name == "pop":
            v = self.stack.pop() if self.stack else UNKNOWN
            if a0 and "r" in a0 and a0.get("m") in (1, 2, 3, 4):
                self.setreg(a0["r"], v)
        elif name == "atsp":
            # peek: copy top of stack into a register without popping
            v = self.stack[-1] if self.stack else UNKNOWN
            if a0 and "r" in a0:
                self.setreg(a0["r"], v)
        elif name == "clear":
            if a0 and "r" in a0:
                if a0.get("m") == 9 and a0["r"] == "S0":
                    self.slots[a0.get("i")] = 0
                else:
                    self.setreg(a0["r"], 0)
                    self.resp_regs.discard(a0["r"])
        elif name == "move" and a0 is not None and a1 is not None:
            val = self.get(a1)
            if a0.get("m") == 9 and a0.get("r") == "S0":
                self.slots[a0.get("i")] = val
            elif "r" in a0:
                self.setreg(a0["r"], val)
                # alias tracking: the response telegram gets copied around,
                # and results are read through the copy
                if a1.get("r") in self.resp_regs and a0["r"] != "S0":
                    self.resp_regs.add(a0["r"])
                elif a0["r"] in self.resp_regs and a1.get("r") not in self.resp_regs:
                    self.resp_regs.discard(a0["r"])
        elif name in ("adds", "addc") and a0 is not None:
            self.setreg(a0.get("r"), _add(self.get(a0), self.get(a1)))
        elif name in ("subb", "subc") and a0 is not None:
            x, y = self.get(a0), self.get(a1)
            self.setreg(a0.get("r"), x - y if isinstance(x, int)
                        and isinstance(y, int) else UNKNOWN)
        elif name == "mult" and a0 is not None:
            self.setreg(a0.get("r"), _mul(self.get(a0), self.get(a1)))
        elif name in ("asl", "lsl") and a0 is not None:
            self.setreg(a0.get("r"), _shl(self.get(a0), self.get(a1)))
        elif name in ("lsr", "asr") and a0 is not None:
            x, y = self.get(a0), self.get(a1)
            self.setreg(a0.get("r"), x >> y if isinstance(x, int)
                        and isinstance(y, int) else UNKNOWN)
        elif name in ("fix2flt", "flt2fix", "a2fix", "fix2dez", "ufix2dez"):
            # numeric conversions preserve which BYTES the value came from
            if a0 is not None and a1 is not None and "r" in a0:
                self.setreg(a0["r"], self.get(a1))
        elif name in ("fmul", "fadd", "fsub", "fdiv"):
            # Scaling: `fmul F2, F3` applies a constant to the raw value. The
            # NUMBER changes, but the byte provenance does not -- and that is
            # all this interpreter is asked for, so the symbol survives the
            # scale step instead of being poisoned by the unknown constant.
            if a0 is not None and "r" in a0:
                x, y = self.get(a0), self.get(a1) if a1 else UNKNOWN
                keep = x if isinstance(x, (Byte, Sum)) else (
                    y if isinstance(y, (Byte, Sum)) else UNKNOWN)
                self.setreg(a0["r"], keep)
        elif name.startswith("erg") or name in ("etag",):
            pass
        elif a0 is not None and "r" in a0 and a0.get("m") in (1, 2, 3, 4):
            # any other opcode writing a register makes it unknown
            self.setreg(a0["r"], UNKNOWN)


def trace_job(data, addr, limit=200_000):
    """Run the machine over a job; return (machine, per-op snapshots)."""
    m = Machine()
    snaps = []
    for i, (start, name, args) in enumerate(S.walk(data, addr, limit=limit)):
        m.step(name, args)
        snaps.append((start, name, args, dict(m.slots)))
    return m, snaps


def resolve_result_bytes(data, addr, want_consts=False):
    """{result_name: [byte offsets]} for results the direct lifter misses.

    Walks the job tracking the abstract state, and when an `erg*` stores from
    a register, reports the response bytes that register's value came from.

    Conditionally-executed instructions are SKIPPED rather than executed. The
    walk is linear, so it would otherwise run both sides of every branch --
    and the sign-extension idiom that follows nearly every signed read
        move B0, S0[#$2]      ; the value
        jpl  L...             ; skip if positive
        move I1, #$ffff       ; ONLY on negative: extend the sign
        move B1, #$ff
    would clobber the value with 0xFF on the way past. That is what left
    SMG2's ADAPTIONSWERTE_LESEN (112 results, the single largest unresolved
    job) reporting 255 instead of its response byte.
    """
    m = Machine()
    out = {}
    consts = {}
    skip_until = None
    for start, name, args in S.walk(data, addr):
        # resume exactly AT the branch target -- the instruction there is the
        # join point and belongs to both paths
        if skip_until is not None and start >= skip_until:
            skip_until = None
        # a forward conditional jump: ignore the instructions it may hop over.
        # Only short hops (the sign-extension idiom is two instructions); a
        # long forward jump is ordinary control flow whose body holds the
        # result stores, and skipping that resolves nothing at all.
        if name in _COND_JUMPS and args and "v" in args[0]:
            target = args[0]["v"]
            if start < target <= start + 32:
                skip_until = max(skip_until or 0, target)
            continue
        if skip_until is not None and start < skip_until:
            continue
        if name.startswith("erg") and args and "s" in args[0]:
            nm = args[0]["s"]
            src = args[1] if len(args) > 1 else None
            val = m.get(src) if src else UNKNOWN
            # LAST resolvable store wins, not the first. A job routinely
            # initialises a result to "" or 0 in one branch and computes the
            # real value in another -- AIF_LESEN writes AIF_FG_NR twice, an
            # empty string first and the VIN substring second. Keeping the
            # first store left 15 of its 16 results unresolved.
            if isinstance(val, Byte):
                out[nm] = [val.offset]
            elif isinstance(val, Sum):
                b = val.bytes_used()
                if b:
                    out[nm] = b
            elif isinstance(val, int) and name != "ergs":
                # Not every result comes off the wire. `move L0, #$0` then
                # `ergi "ID_OBD2", I0` says this ECU simply has no OBD2 --
                # a constant the SGBD states outright, and BMS46/MS420's
                # IDENT is full of them (ID_EWS_SS=3, ID_EML=0, ID_OBD2=0,
                # all confirmed against the engine).
                #
                # STRING results are excluded, and that exclusion is the whole
                # reason this is safe: checked against the engine, 8 of the
                # interpreter's 18 IDENT constants were right and 10 were
                # wrong -- every wrong one an `ergs` whose real value is
                # response data (ID_BMW_NR is a 7-byte part number) that the
                # interpreter had merely failed to track, leaving a stale 0.
                # Trusting those wholesale would have injected wrong data
                # under the appearance of extra coverage.
                consts[nm] = val
        m.step(name, args)
    return (out, consts) if want_consts else out


def detect_loop(data, addr):
    """Describe a per-iteration read loop, or None.

    The measurement-block jobs read one record per pass: a scratch slot holds
    a byte CURSOR that is advanced by a second slot (the record width) each
    iteration, while a third counts iterations. The sixteen STAT_MESSWERTn
    results are that one body executed sixteen times, dispatched through a
    jump table -- so they share bytecode and differ only by cursor position.

    The stride is not a constant: it is read from the response (the ECU says
    how wide each record is), so the spec records WHICH slot carries it rather
    than a number that would be wrong for every other car.
    """
    # A loop needs a backward branch. The slot-advance pattern alone is not
    # enough evidence: straight-line jobs re-fill the same scratch slot before
    # each result (SMG2's ADAPTIONSWERTE_LESEN refills S0[2] 100+ times with no
    # branch at all), and calling that a loop invented a cursor and stride for
    # a job that simply reads consecutive bytes.
    has_back_branch = any(
        n in S.JUMPS and a and "v" in a[0] and addr <= a[0]["v"] < st
        for st, n, a in S.walk(data, addr))
    if not has_back_branch:
        return None

    cursor = counter = stride_slot = None
    prev_slots = []
    for start, name, args in S.walk(data, addr):
        if name == "move" and len(args) == 2 and args[1].get("m") == 9 \
                and args[1].get("r") == "S0":
            prev_slots.append(args[1].get("i"))
        if name == "move" and len(args) == 2 and args[0].get("m") == 9 \
                and args[0].get("r") == "S0" and len(prev_slots) >= 2:
            dst = args[0].get("i")
            if dst == prev_slots[-2] and prev_slots[-1] != dst:
                cursor, stride_slot = dst, prev_slots[-1]
            elif dst == prev_slots[-1]:
                counter = dst
            prev_slots = []
    if cursor is None:
        return None
    return {"cursorSlot": cursor, "strideSlot": stride_slot,
            "counterSlot": counter}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return 0
    import sgbd_spec as SP
    sgbd, job = args[0].lower(), args[1].upper()
    data, jobs = SP.load(sgbd)
    addr = SP.job_addr(data, jobs, job)
    if addr is None:
        raise SystemExit(f"{sgbd} has no job {job}")
    res = resolve_result_bytes(data, addr)
    print(f"{sgbd}:{job} -- {len(res)} results resolved by dataflow")
    for k, v in list(res.items())[:24]:
        print(f"  {k:34} bytes={v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
