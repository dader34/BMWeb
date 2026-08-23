#!/usr/bin/env python3
"""Execute an .IPO instead of pattern-matching it.

WHY THIS EXISTS. ipo_ir.py reconstructs what a script WOULD do by reading its
token stream and applying inference rules -- which string is the job name,
which literal is a variant, which caption is chrome. Every rule is a claim we
derived rather than observed, and each wrong claim needs another rule to
correct it. That layer grew to twenty-odd regexes and still shipped 190 ECU
entries pointing at the wrong SGBD, 1,409 job-status constants recorded as
vehicle variants, and 535 menu keys hidden because their caption did not match
a word list.

The program already knows all of it. `setmenutitle("Activate")` IS the title;
ITEM 1 IS an item; the arm of the dispatch that runs IS the one for this car's
VARIANTE. Running the script and recording what it emits replaces inference
with observation.

WHAT IT IS NOT. A single run tells you one path. INPA branches on VARIANTE, so
building a complete IR means exploring every arm -- bind VARIANTE to each
candidate, run, record. That is what explore() does, and it is why the output
still carries per-variant guards: not because a regex guessed them, but
because we executed with that variant bound and this is what happened.

SAFETY. Jobs do not reach a car from here. run() calls the host's job hook,
and the offline host answers from recorded/synthetic data. Driving hardware
stays behind bestvm's write gate in the app, unchanged.
"""

import os
import sys

sys.path[:0] = [os.path.join(os.path.dirname(os.path.abspath(__file__)), d)
                for d in (".",)]
import ipo_disasm as D                                          # noqa: E402


class _Slot:
    """A global slot pushed with nothing in it -- carries its own number so a
    later draw can ask which result key was bound to it.

    AN UNSET SLOT READS AS EMPTY TEXT. Offline, most globals are unset, and a
    script that builds a path or a caption out of one still has to produce a
    usable string -- msd87's s_fdyn opens `<install dir> + "DDLI.TXT"` and got
    a slot object as its filename. Being empty rather than absent is also what
    the script itself sees: INPA initialises its globals to "".
    """

    __slots__ = ("sc", "n")

    def __init__(self, sc, n):
        self.sc = 2 if sc == 2 else 0
        self.n = n

    def __repr__(self):
        return f"<slot {self.sc}:{self.n}>"

    def __str__(self):
        return ""


class _Bound(str):
    """Text that still remembers where it came from.

    `slot` is the slot it was built from; `key` is the result key a Result*
    read bound to it. The key travels with the VALUE because scripts reuse one
    scratch slot for every row of a screen -- see _b_result.
    """

    def __new__(cls, slot, text, key=None):
        o = super().__new__(cls, text)
        o.slot = slot
        o.key = key
        return o


class Halt(Exception):
    """The script asked to stop (exit, or a step budget ran out)."""


# scope 0 is the script's globals; 2 and 3 are the frame's own slots. A proc
# gets fresh 2/3 on entry, which is what makes recursion and reentry safe.
GLOBAL, LOCAL, LOCAL3 = 0, 2, 3


class Emissions:
    """What one execution produced -- the raw material of the IR."""

    def __init__(self):
        self.title = None
        self.items = []          # {nr, label, ...} in emission order
        self.lines = []          # screen text, in emission order
        self.jobs = []           # {job, arg, sgbd} as the script ran them
        self.menu = None         # setmenu target
        self.screen = None       # setscreen target
        self.messages = []       # dialogs the script raised
        self.calls = []          # every builtin, for coverage measurement
        self.states = []         # named states the run parked at

    def as_dict(self):
        return {"title": self.title, "items": self.items, "lines": self.lines,
                "jobs": self.jobs, "menu": self.menu, "screen": self.screen,
                "messages": self.messages}


class VM:
    """Executes one proc of one .IPO.

    The token stream from ipo_disasm is the instruction tape: jump targets are
    already resolved to byte offsets, so control flow is a matter of moving an
    index. Everything else is a stack machine -- pushes accumulate into the
    current call frame, a call consumes them.
    """

    def __init__(self, ecu, host=None, budget=200000):
        self.ecu = ecu
        self.host = host or Host()
        self.budget = budget
        data, ps, pool, decls = D.load(ecu)
        if ps is None:
            raise ValueError(f"{ecu}: no constant pool")
        self.data, self.ps, self.pool, self.decls = data, ps, pool, decls
        self.procs = {}          # name -> tokens
        self.byid = {}           # (type, id) -> name
        for k, (off, typ, name, pid) in enumerate(decls):
            lo = off + 1 + len(name) + 1 + 4 + 1
            hi = decls[k + 1][0] if k + 1 < len(decls) else ps
            self.procs[name] = D.walk(data, lo, hi, pool)[0]
            self.byid[(typ, pid)] = name
        self.globals = {}
        self.out = Emissions()
        self.steps = 0
        self.entered = set()     # state procs already entered (loop guard)
        self.binds = {}          # global slot -> the result key read into it
        self.files = {}          # path -> lines, for scripts that keep lists
        self.fh = None           # the one open handle INPA scripts use
        # highest global slot this file touches, so a caller preseeding
        # presence flags knows how far the range goes
        self._maxglobal = 0
        for toks in self.procs.values():
            for t in toks:
                if t["op"] in ("var", "store") and t.get("sc", 0) == 0:
                    if t["n"] > self._maxglobal:
                        self._maxglobal = t["n"]

    # ---------------------------------------------------------------- run --

    def run(self, proc, args=None):
        """Execute one proc to completion. Returns its Emissions."""
        toks = self.procs.get(proc)
        if toks is None:
            raise KeyError(proc)
        frame = dict(enumerate(args or []))
        try:
            self._exec(toks, frame)
        except Halt:
            pass
        return self.out

    def _exec(self, toks, frame):
        # the frame a builtin's destination ref writes into (Result* targets
        # frame slots far more often than globals)
        prev_frame, self.frame = getattr(self, "frame", None), frame
        try:
            return self._exec_in(toks, frame)
        finally:
            self.frame = prev_frame

    def _exec_in(self, toks, frame):
        # byte offset -> token index, so a resolved jump target is a seek
        index = {t["at"]: i for i, t in enumerate(toks) if "at" in t}
        # STOP AT THE FIRST UNDECODED BYTE. A proc's block header sizes only
        # its OWN section -- each ITEM opens another -- so it cannot bound the
        # proc, but garbage can: __inpa_shutdown__ ends after two dwords and
        # is followed by the pool's trailing bytes ("Global Data"), which
        # decode as `unk` and then as a jump back into themselves. Executing
        # that spins forever. Every proc we actually run decodes cleanly, so
        # the first unk IS the end of the code.
        end = len(toks)
        for j, t in enumerate(toks):
            if t["op"] == "unk":
                end = j
                break
        stack = []               # the current call frame's pushed values
        i = 0
        cur_item = None
        while i < end:
            self.steps += 1
            if self.steps > self.budget:
                raise Halt("step budget")
            t = toks[i]
            op = t["op"]

            if op == "frame":
                stack = []
            elif op == "const":
                stack.append(t.get("v"))
            elif op == "var":
                val = self._read(t, frame)
                # an UNSET global still identifies its slot: a draw needs to
                # know which slot it was handed, so a Result* binding can be
                # looked up. Once something stores a real value, that wins.
                if val is None:
                    val = _Slot(t.get("sc", 0), t["n"])
                stack.append(val)
            elif op == "procref":
                stack.append(("ref", t.get("kind"), t["n"]))
            elif op == "store":
                val = stack.pop() if stack else None
                self._write(t, frame, val)
            elif op == "binop":
                b = stack.pop() if stack else None
                a = stack.pop() if stack else None
                stack.append(_binop(t.get("name"), a, b))
            elif op == "jfalse":
                cond = stack.pop() if stack else False
                if not _truthy(cond):
                    nxt = index.get(t["to"])
                    if nxt is None:
                        raise Halt("bad jump")
                    i = nxt
                    continue
            elif op == "jump":
                nxt = index.get(t["to"])
                if nxt is None:
                    raise Halt("bad jump")
                i = nxt
                continue
            elif op == "ITEM":
                cur_item = {"nr": t.get("nr"), "label": t.get("label")}
                self.out.items.append(cur_item)
                stack = []
            elif op == "LINE":
                self.out.lines.append({"label": t.get("label"), "elements": []})
                stack = []
            elif op == "call":
                self._builtin(t, stack, cur_item)
                stack = []
            elif op == "calluser":
                # A CALL IS NOT A NEW BUDGET. The callee ran on a shallow copy
                # of the VM, so `steps` was copied by value and reset on every
                # call -- a loop inside a helper could spin without ever
                # tripping the budget (mevd172_alt's Ausgabe_NN emitted 1,022
                # rows of a 12-row screen). Only the frame is per-call; the
                # step counter belongs to the run.
                name = self.byid.get(("func", t["n"]))
                if name and name in self.procs:
                    self._exec(self.procs[name], dict(enumerate(stack)))
                stack = []
            elif op == "state":
                # A YIELD, NOT A LOOP. INPA state machines park at a named
                # state and wait to be driven again -- ENDE_BEHANDLER is
                # `%WARTEN; jump back`, an event loop that is SUPPOSED to
                # spin. Executing it straight runs forever, so the run stops
                # here and records where it parked; a host that wants the
                # next state resumes from it. Recording the state is also
                # what makes STEUERN_IO's component picker reachable: those
                # screens ARE the machine, not a static tree.
                self.out.states.append(t.get("name"))
                raise Halt("yield at %s" % t.get("name"))
            elif op == "ret":
                return
            # block/decl/stmt/unk/dllcall carry no runtime effect here
            i += 1

    # ------------------------------------------------------------ storage --

    def _read(self, t, frame):
        sc = t.get("sc", GLOBAL)
        if sc == GLOBAL:
            return self.globals.get(t["n"])
        return frame.get(t["n"])

    def _write(self, t, frame, val):
        sc = t.get("sc", GLOBAL)
        if sc == GLOBAL:
            self.globals[t["n"]] = val
        else:
            frame[t["n"]] = val

    # ----------------------------------------------------------- builtins --

    def _builtin(self, t, stack, cur_item):
        name = t.get("name") or ("builtin_%02x" % t["n"])
        self.out.calls.append(name)
        fn = _BUILTINS.get(name)
        if fn:
            fn(self, stack, cur_item)

    def target(self, ref, kind_name):
        """Resolve a procref pushed onto the stack to a proc name."""
        if isinstance(ref, tuple) and ref[0] == "ref":
            return self.byid.get((kind_name, ref[2]))
        return None


# --------------------------------------------------------------- operators --

def _truthy(v):
    if isinstance(v, str):
        return v not in ("", "0")
    return bool(v)


def _num(v):
    if isinstance(v, (int, float)):
        return v
    try:
        return float(str(v))
    except (TypeError, ValueError):
        return 0


def _binop(name, a, b):
    if name == "add":
        # INPA overloads + for both concatenation and arithmetic. A row is
        # often `<bound slot> + " Werte"`, so a slot that is concatenated
        # must keep its identity or the draw sees only text -- msd87's
        # s_fdyn loses all 102 of its rows that way. The result carries the
        # slot alongside the rendered string.
        slot = None
        for x in (a, b):
            if isinstance(x, _Slot):
                slot = x
            elif isinstance(x, _Bound):
                # a row is built up in several steps -- "Position " + <slot>
                # + "   " -- and _Bound is a str, so without this the SECOND
                # concatenation fell through to the plain-string branch and
                # the binding was lost one operation before the draw.
                slot = x.slot
            if slot is not None:
                break
        if slot is not None:
            return _Bound(slot, f"{'' if a is None else a}"
                                f"{'' if b is None else b}")
        if isinstance(a, str) or isinstance(b, str):
            return f"{'' if a is None else a}{'' if b is None else b}"
        return _num(a) + _num(b)
    if name == "sub":
        return _num(a) - _num(b)
    if name == "mul":
        return _num(a) * _num(b)
    if name == "div":
        return _num(a) / _num(b) if _num(b) else 0
    if name == "eq":
        return _cmp_eq(a, b)
    if name == "ne":
        return not _cmp_eq(a, b)
    if name == "lt":
        return _num(a) < _num(b)
    if name == "gt":
        return _num(a) > _num(b)
    if name == "le":
        return _num(a) <= _num(b)
    if name == "ge":
        return _num(a) >= _num(b)
    if name == "and":
        return _truthy(a) and _truthy(b)
    if name == "or":
        return _truthy(a) or _truthy(b)
    if name == "neg":
        return not _truthy(b if a is None else a)
    return None


def _cmp_eq(a, b):
    if isinstance(a, str) or isinstance(b, str):
        return str('' if a is None else a) == str('' if b is None else b)
    return a == b


# ------------------------------------------------------------------- host --

class Host:
    """Where the script's questions about the car get answered.

    The default is OFFLINE: jobs return nothing and every result reads empty,
    which is enough to walk the menu tree and record its structure. A live
    host would run the job through bestvm and hand back real results -- the
    VM does not know the difference, which is the point.
    """

    def job(self, sgbd, job, arg, results):
        return {}

    def result(self, key, index=1, default=""):
        # JOB_STATUS IS THE ONE RESULT EVERY JOB RETURNS. Scripts branch on it
        # before touching anything else -- `if JOB_STATUS != "OKAY"` guards the
        # whole body of nearly every ident and memory screen -- so answering ""
        # sent all 489 of them down the error arm and skipped the real work.
        # It is also what status() already reports; the two must agree.
        if key == "JOB_STATUS":
            return self.status()
        return default

    def status(self):
        return "OKAY"

    def inputstate(self):
        return 0                 # the user accepted the dialog


# --------------------------------------------------------------- emissions --

def _b_setmenutitle(vm, stack, item):
    if stack:
        vm.out.title = stack[0]


def _b_settitle(vm, stack, item):
    if stack:
        vm.out.title = stack[0]


def _b_setitem(vm, stack, item):
    # setitem(nr, caption, enabled)
    nr = next((x for x in stack if isinstance(x, int)), None)
    cap = next((x for x in stack if isinstance(x, str)), None)
    if nr is not None:
        vm.out.items.append({"nr": nr, "label": cap, "fromSetitem": True})


def _b_setmenu(vm, stack, item):
    ref = next((x for x in stack if isinstance(x, tuple)), None)
    tgt = vm.target(ref, "menu")
    if tgt:
        vm.out.menu = tgt
        if item is not None:
            item["menu"] = tgt


def _b_setscreen(vm, stack, item):
    ref = next((x for x in stack if isinstance(x, tuple)), None)
    tgt = vm.target(ref, "screen")
    if tgt:
        vm.out.screen = tgt
        if item is not None:
            item["screen"] = tgt


def _b_job(vm, stack, item):
    # INPAapiJob(sgbd, job, argument, result_filter)
    sgbd = stack[0] if len(stack) > 0 else None
    job = stack[1] if len(stack) > 1 else None
    arg = stack[2] if len(stack) > 2 else None
    if not isinstance(job, str):
        return
    rec = {"job": job, "sgbd": sgbd if isinstance(sgbd, str) else None}
    if isinstance(arg, str) and arg:
        rec["arg"] = arg
    vm.out.jobs.append(rec)
    if item is not None and "job" not in item:
        item["job"] = job
        if rec.get("arg"):
            item["jobArg"] = rec["arg"]
    vm.globals["__last_job__"] = vm.host.job(sgbd, job, arg, None)


def _b_fsmode(vm, stack, item):
    # INPAapiFsMode(sgbd, mode, ?, ?, job) -- the fault reader, job LAST
    job = next((x for x in reversed(stack) if isinstance(x, str) and x), None)
    if job:
        vm.out.jobs.append({"job": job, "faultMode": True})
        if item is not None and "job" not in item:
            item["job"] = job


def _b_checkstatus(vm, stack, item):
    vm.globals["__status__"] = vm.host.status()


def _b_result(vm, stack, item):
    # INPAapiResult*(dest ref, KEY, index, default)
    key = next((x for x in stack if isinstance(x, str)), None)
    val = vm.host.result(key) if key else ""
    dest = _out_ref(stack)
    if dest is not None:
        sc = 2 if dest[1] == 2 else 0
        if key:
            # THE KEY TRAVELS ON THE VALUE, not in a slot-keyed side table.
            # A screen row is a loop -- read into a scratch local, draw it,
            # repeat -- and MSV80_alt's s_mode_9 runs all 124 of its reads
            # through the SAME destination ('ref', 2, 0). A map keyed by slot
            # can only ever hold the newest, so 122 of them were lost. Bound
            # to the value, slot reuse cannot clobber anything.
            val = _Bound(_Slot(sc, dest[2]),
                         "" if val is None else str(val), key)
            vm.binds[(sc, dest[2])] = key
        vm.globals[("ref", dest[2])] = val
        # WRITE INTO THE STORAGE A LATER `var` ACTUALLY READS. Parking the
        # value under ("ref", n) put it somewhere _read never looks, so the
        # draw only ever saw the empty slot.
        if sc == GLOBAL:
            vm.globals[dest[2]] = val
        elif vm.frame is not None:
            vm.frame[dest[2]] = val
    if key:
        vm.globals["__lastkey__"] = key


def _b_textout(vm, stack, item):
    """ftextout(text, row, col, ...) -- printed text, or a printed VALUE.

    A screen row is often `INPAapiResultText(->slot, KEY); ftextout(slot,...)`:
    the read binds a slot and the draw prints it. Recording only literal
    strings lost every such row -- GSDS2's whole Identification page is nine
    of them -- so a draw whose argument is a BOUND SLOT emits a value element
    carrying the key it was bound to, which is what the row actually shows.
    """
    # A BOUND VALUE WINS OVER A LITERAL. The row is usually
    # `"Position " + <bound slot>`, so the frame holds both a caption and the
    # value -- taking the first string emitted the caption and dropped the
    # reading. ABSASC4's pedal-travel row and 2,995 others were lost that way.
    key = None
    for x in stack:
        if isinstance(x, _Bound) and x.key:
            key = x.key                      # the value carries its own key
            break
        sl = x.slot if isinstance(x, _Bound) else (
            x if isinstance(x, _Slot) else None)
        if sl is not None:
            key = vm.binds.get((sl.sc, sl.n))
            if key:
                break
    lit = next((x for x in stack
                if isinstance(x, str) and not isinstance(x, _Bound)), None)
    if key is None and lit is None:
        return
    if not vm.out.lines:
        vm.out.lines.append({"label": None, "elements": []})
    if key:
        vm.out.lines[-1]["elements"].append({"t": "value", "key": key})
    else:
        vm.out.lines[-1]["elements"].append({"t": "text", "s": lit})


def _b_analogout(vm, stack, item):
    """analogout(value, row, col, min, max, wlo, whi, fmt) -- a scaled bar.

    FOUR bounds, not two: the scale the bar spans, then the band INPA draws
    green. MS450's rough running is (0, 8, 0, 5) -- green to 5, red on to 8 --
    so the threshold the gauge exists to show lives in the second pair.

    Any of them can be a VARIABLE rather than a literal (GSDS2's wheel-speed
    bars take their maximum from global 21). The static miner has to remember
    the last constant stored into each slot to resolve those; executing the
    script means the value is simply in scope, which is the whole reason to
    run it rather than read it.
    """
    el = _field(vm, stack, "analog")
    nums = [x for x in stack[3:] if isinstance(x, (int, float))
            and not isinstance(x, bool)]
    if len(nums) >= 2:
        el["min"], el["max"] = nums[0], nums[1]
    if len(nums) >= 4:
        # the green band; equal to the scale means the whole bar is green
        el["warnLo"], el["warnHi"] = nums[2], nums[3]
    fmt = next((x for x in stack if isinstance(x, str) and x.strip()), None)
    if fmt:
        el["fmt"] = fmt.strip()


def _b_multianalogout(vm, stack, item):
    """multianalogout(...) -- several analog series drawn by one call.

    The argument list is analogout's tail repeated per series, so the row is
    split on the format string that terminates each one and each group emits
    its own gauge. Drawing a single lamp here (the name this opcode carried
    before) collapsed every series onto one element.
    """
    group, drawn = [], 0
    for x in stack:
        group.append(x)
        if isinstance(x, str) and x.strip():
            _b_analogout(vm, group, item)
            drawn += 1
            group = []
    if not drawn:
        _b_analogout(vm, stack, item)


def _b_digitalout(vm, stack, item):
    # digitalout(value, row, col, on, off)
    _field(vm, stack, "digital")


def _field(vm, stack, kind):
    """A drawn readout. The value pushed first is the slot a Result* filled,
    so the key comes from the binding rather than from the caption beside it."""
    ints = [x for x in stack if isinstance(x, int) and not isinstance(x, bool)]
    strs = [x for x in stack if isinstance(x, str)]
    el = {"t": "gauge" if kind == "analog" else "lamp"}
    if len(ints) >= 2:
        el["row"], el["col"] = ints[0], ints[1]
    # THE VALUE BEING DRAWN NAMES ITSELF. `__lastkey__` is one global holding
    # whichever read ran most recently, so a screen that reads five values and
    # then draws five gauges labelled all of them with the fifth key. Taking
    # the key off the drawn value is right however the reads are ordered.
    key = _keyed(stack)
    if key is None:
        sl = next((x.slot for x in stack if isinstance(x, _Bound) and x.slot),
                  None) or next((x for x in stack if isinstance(x, _Slot)),
                                None)
        if sl is not None:
            key = vm.binds.get((sl.sc, sl.n))
    if key:
        el["key"] = key
    if kind == "digital" and len(strs) >= 2:
        el["on"], el["off"] = strs[-2].strip(), strs[-1].strip()
    if not vm.out.lines:
        vm.out.lines.append({"label": None, "elements": []})
    vm.out.lines[-1]["elements"].append(el)
    return el


def _b_strlen(vm, stack, item):
    s = next((x for x in stack if isinstance(x, str)), "")
    _store_out(vm, stack, len(s))


def _b_midstr(vm, stack, item):
    # midstr(dest, source, start, count) -- INPA is 1-based
    strs = [x for x in stack if isinstance(x, str)]
    ints = [x for x in stack if isinstance(x, int)]
    src = strs[-1] if strs else ""
    a = (ints[0] - 1) if ints else 0
    n = ints[1] if len(ints) > 1 else len(src)
    _store_out(vm, stack, src[max(0, a):max(0, a) + max(0, n)], _keyed(stack))


def _keyed(stack):
    """The result key of the first argument that carries one.

    A CONVERSION MUST NOT LOSE THE BINDING. Screens read a value, convert it,
    then draw the converted copy -- MSV80_alt's s_mode_9 does that 124 times
    (`INPAapiResultInt` -> `inttostring` -> `textout`). Dropping the key at
    the conversion made every one of those rows anonymous text.
    """
    return next((x.key for x in stack if isinstance(x, _Bound) and x.key),
                None)


def _out_ref(stack):
    """The destination a builtin writes through, or None.

    INPA builtins DO NOT RETURN VALUES -- they take an out-parameter. Both
    `INPAapiResultInt(->dest, KEY, i)` and `inttostring(src, ->dest)` push a
    procref for the destination and store through it, so there is one rule
    for all of them rather than a return-value convention that no opcode
    consumes.
    """
    return next((x for x in stack if isinstance(x, tuple)
                 and len(x) == 3 and x[0] == "ref"), None)


def _store_out(vm, stack, val, key=None):
    """Write a builtin's answer through its out-parameter.

    Returns the slot written, or None when the call had no destination.
    """
    dest = _out_ref(stack)
    if dest is None:
        return None
    sc = LOCAL if vm.frame is not None else GLOBAL
    n = dest[2]
    if key is not None:
        val = _Bound(_Slot(sc, n), "" if val is None else str(val), key)
        vm.binds[(sc, n)] = key
    if sc == GLOBAL:
        # AN OFFLINE NON-ANSWER MUST NOT OVERWRITE A PRESET. The menu walk
        # binds module-presence globals true because fitment is a property of
        # the car, not the file; a Result* that returns "" offline would erase
        # that and hide every guarded item (13,185 jobs vanished this way).
        # A real value still wins.
        if val not in ("", None) or n not in vm.globals:
            vm.globals[n] = val
    else:
        vm.frame[n] = val
    return n


def _b_inttostring(vm, stack, item):
    n = next((x for x in stack if isinstance(x, (int, float))), None)
    if n is None:
        n = next((x for x in stack if isinstance(x, str)), 0)
        try:
            n = float(n)
        except (TypeError, ValueError):
            n = 0
    _store_out(vm, stack, str(int(n)), _keyed(stack))


def _b_fileopen(vm, stack, item):
    """fileopen(path, mode) -- INPA scripts keep user data in text files.

    The offline host has no filesystem, so files live in vm.files: a screen
    that writes a measurement list and reads it back (msd87's s_fdyn and
    DDLI.TXT) sees its own writes, and one that reads a list the user never
    created correctly takes the empty branch instead of stalling on an
    unimplemented builtin.
    """
    # AN UNSET GLOBAL IS AN EMPTY STRING, NOT A POISON VALUE. INPA builds the
    # path as `<install dir global> + "DDLI.TXT"`; offline that global is
    # unset, so the concatenation yields a bare slot and the filename is lost.
    path = "".join(str(x) for x in stack
                   if isinstance(x, (str, _Slot)) and x not in ("r", "w", "a"))
    mode = next((x for x in reversed(stack)
                 if isinstance(x, str) and x in ("r", "w", "a")), "r")
    if mode == "w":
        vm.files[path] = []
    elif mode == "a":
        vm.files.setdefault(path, [])
    vm.fh = {"path": path, "mode": mode, "line": 0}


def _b_fileclose(vm, stack, item):
    vm.fh = None


def _b_filewrite(vm, stack, item):
    if not vm.fh or vm.fh["mode"] == "r":
        return
    txt = next((x for x in stack if isinstance(x, str)), "")
    vm.files.setdefault(vm.fh["path"], []).append(txt)


def _b_fileread(vm, stack, item):
    """fileread(->dest, ...) -- next line, or "" at end of file."""
    line = ""
    if vm.fh and vm.fh["mode"] == "r":
        lines = vm.files.get(vm.fh["path"], [])
        if vm.fh["line"] < len(lines):
            line = lines[vm.fh["line"]]
            vm.fh["line"] += 1
    _store_out(vm, stack, line)


def _b_getinputstate(vm, stack, item):
    """0 means the user accepted the dialog -- anything else is a cancel.

    Leaving this a noop left the destination slot unset, so a script that
    branches on it took whichever arm an empty slot happened to select.
    """
    _store_out(vm, stack, vm.host.inputstate())


def _b_noop(vm, stack, item):
    """Structure packers, view/box chrome, timers -- no effect on the IR.

    Listed explicitly rather than ignored by default, so an unrecognised
    builtin still shows up in coverage as something nobody has looked at.
    """


def _b_message(vm, stack, item):
    strs = [x for x in stack if isinstance(x, str)]
    if strs:
        vm.out.messages.append({"title": strs[0],
                                "body": strs[1] if len(strs) > 1 else None})
        if item is not None:
            item.setdefault("messages", []).append(strs[0])


def _b_setstate(vm, stack, item):
    """setstate(<state proc>) -- hand control to a state machine.

    TRUE EXECUTION, not a reachability scan. The machine is entered and run
    from its entry point; whatever job it fires before parking at its first
    yield is the job this key runs. That is the difference from the static
    reading, which unions every job reachable anywhere in the machine and
    attributes the lot to every key that touches it -- in mevd172 four keys
    including "Zurück" all claimed MESSWERTBLOCK_LESEN and the same five
    candidates, and corpus-wide 359 of 461 such items share a job with a
    sibling while 21 are Back/Exit/Print chrome.

    Re-entry is guarded: a machine that setstates back into one already on
    the stack is looping, and the yield handles that case.
    """
    ref = next((x for x in stack if isinstance(x, tuple) and x[1] in (66, 67)),
               None)
    if ref is None:
        return
    name = vm.byid.get(("state", ref[2]))
    if not name or name not in vm.procs:
        return
    if name in vm.entered:
        return
    vm.entered.add(name)
    before = len(vm.out.jobs)
    try:
        vm._exec(vm.procs[name], {})
    except Halt:
        pass
    # the first job the machine actually ran is this key's job
    if item is not None and "job" not in item and len(vm.out.jobs) > before:
        j = vm.out.jobs[before]
        item["job"] = j["job"]
        item["stateJob"] = True
        if j.get("arg"):
            item.setdefault("jobArg", j["arg"])


def _b_start(vm, stack, item):
    """start() -- run the state machine already selected by setstate."""
    _b_setstate(vm, stack, item)


def _b_exit(vm, stack, item):
    if item is not None:
        item["action"] = "exit"


def _b_print(vm, stack, item):
    if item is not None:
        item["action"] = "printscreen"


def _b_scriptchange(vm, stack, item):
    if item is not None:
        item["appTool"] = True


def _b_callwin(vm, stack, item):
    if item is not None:
        item["appTool"] = True


_BUILTINS = {
    "setmenutitle": _b_setmenutitle,
    "settitle": _b_settitle,
    "setitem": _b_setitem,
    "setmenu": _b_setmenu,
    "setscreen": _b_setscreen,
    "INPAapiJob": _b_job,
    "INP1apiJob": _b_job,
    "INPAapiFsMode": _b_fsmode,
    "INPAapiCheckJobStatus": _b_checkstatus,
    "INPAapiResultText": _b_result,
    "INPAapiResultAnalog": _b_result,
    "INPAapiResultDigital": _b_result,
    "INPAapiResultInt": _b_result,
    "INP1apiResultText": _b_result,
    "ftextout": _b_textout,
    "textout": _b_textout,
    "text": _b_textout,
    "userboxftextout": _b_textout,
    "messagebox": _b_message,
    "builtin_53": _b_message,
    "exit": _b_exit,
    "printscreen": _b_print,
    "scriptchange": _b_scriptchange,
    "callwin": _b_callwin,
    "analogout": _b_analogout,
    "digitalout": _b_digitalout,
    "multianalogout": _b_multianalogout,
    "strlen": _b_strlen,
    "midstr": _b_midstr,
    "inttostring": _b_inttostring,
    "inttolong": _b_inttostring,
    "bytetoint": _b_inttostring,
    # no IR effect, but known and accounted for
    "SetStructureMode": _b_noop, "CreateStructure": _b_noop,
    "StructureByte": _b_noop, "StructureString": _b_noop,
    "StructureInt": _b_noop, "StructureLong": _b_noop,
    "userboxopen": _b_noop, "userboxclose": _b_noop,
    "viewopen": _b_noop, "viewclose": _b_noop,
    "setstate": _b_setstate, "start": _b_start,
    "select": _b_noop, "deselect": _b_noop,
    "INPAapiInit": _b_noop, "INPAapiEnd": _b_noop,
    "INPAapiFsLesen": _b_noop, "INP1apiErrorText": _b_noop,
    "getinputstate": _b_getinputstate, "inputhex": _b_noop,
    "fileopen": _b_fileopen, "fileclose": _b_fileclose,
    "filewrite": _b_filewrite, "fileread": _b_fileread,
    "hexdump": _b_noop, "printfile": _b_noop,
    "setstatemachine": _b_noop, "StrArrayCreate": _b_noop,
    "StrArrayDestroy": _b_noop, "StrArrayRead": _b_noop,
    "StrArrayWrite": _b_noop, "realtostring": _b_inttostring,
    "INP1apiResultInt": _b_result,
    "INPAapiResultBinary": _b_noop,
}


# ------------------------------------------------------------------- main --

def coverage(ecu):
    """What executing every proc of one ECU touches. Measurement, not IR."""
    vm = VM(ecu)
    handled, unhandled = {}, {}
    for name in list(vm.procs):
        v = VM(ecu)
        try:
            v.run(name)
        except Exception as e:                                  # noqa: BLE001
            unhandled.setdefault(f"!{type(e).__name__}", 0)
            unhandled[f"!{type(e).__name__}"] += 1
            continue
        for c in v.out.calls:
            d = handled if c in _BUILTINS else unhandled
            d[c] = d.get(c, 0) + 1
    return handled, unhandled


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 0
    ecu = args[0]
    if "--coverage" in sys.argv:
        h, u = coverage(ecu)
        th, tu = sum(h.values()), sum(u.values())
        print(f"{ecu}: {th} handled calls, {tu} unhandled "
              f"({100 * th / (th + tu or 1):.1f}% covered)")
        print("\nunhandled:")
        for k, v in sorted(u.items(), key=lambda x: -x[1]):
            print(f"  {v:5}  {k}")
        return 0
    proc = args[1] if len(args) > 1 else "m_main"
    vm = VM(ecu)
    out = vm.run(proc)
    print(f"{ecu} {proc}: title={out.title!r} menu={out.menu} "
          f"screen={out.screen}")
    for it in out.items:
        print("  ITEM", it)
    for j in out.jobs:
        print("  JOB ", j)
    for m in out.messages:
        print("  MSG ", m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
