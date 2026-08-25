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
        o.amap = None            # the string array a lookup came through
        # keys of OTHER reads concatenated into this one value. INPA draws a
        # composite field ("type / variant" = FAHRZEUG_TYP + ' / ' +
        # FAHRZEUG_VARIANTE) as one ftextout; only the carried key becomes the
        # element, but every folded key IS on screen, so the draw records them
        # all as drawn and the undrawn-read fold does not re-add a phantom row.
        o.extra = ()
        return o


class Halt(Exception):
    """The script asked to stop (exit, or a step budget ran out)."""


# scope 0 is the script's globals; 2 and 3 are the frame's own slots. A proc
# gets fresh 2/3 on entry, which is what makes recursion and reentry safe.
GLOBAL, LOCAL, LOCAL3 = 0, 2, 3


def _base(key):
    """A result key without its display-role suffix, so a value and its unit
    share a stem: STAT_TMOT_WERT and STAT_TMOT_EINH both reduce to STAT_TMOT.
    Only the display suffixes are stripped -- two readings never collide."""
    u = key.upper()
    for suf in ("_WERT", "_EINH", "_TEXT", "_EINHEIT"):
        if u.endswith(suf):
            return key[: -len(suf)]
    return key


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
        self.reads = []          # every result key read, in read order
        self.predicate_reads = set()   # keys read only to branch on (control
        #                                values: STAT_GETRIEBE_NR gates the
        #                                transmission block but is never shown)

    def as_dict(self):
        return {"title": self.title, "items": self.items, "lines": self.lines,
                "jobs": self.jobs, "menu": self.menu, "screen": self.screen,
                "messages": self.messages, "reads": self.reads}


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
        self.strArrays = {}      # handle -> {index: text} (StrArray* builtins)
        self._arrN = 0
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

    def run_item(self, menu_toks, start, end, item, presence=True):
        """Execute one menu item's body as if its F-key were pressed,
        resolving job/screen/action into `item`.

        Runs the FULL menu token list from the item's start (`start`) to the
        next item (`end`), not a sliced copy -- an item body's jumps target
        code outside itself (a shared confirm, another item), and a slice
        loses those targets ("bad jump"). Enable flags are preset true so the
        guarded blocks run; `item` is the current target so builtins attach to
        it. This is the build-time equivalent of pressing the key -- how the
        reference reaches an item's job/screen.
        """
        if presence:
            for g in range(self._maxglobal + 1):
                self.globals.setdefault(g, True)
        self._item_target = item
        try:
            self._exec(menu_toks, {}, start_at=start, stop_at=end)
        except Halt:
            pass
        finally:
            self._item_target = None
        return item

    def _exec(self, toks, frame, start_at=0, stop_at=None):
        # the frame a builtin's destination ref writes into (Result* targets
        # frame slots far more often than globals)
        prev_frame, self.frame = getattr(self, "frame", None), frame
        try:
            return self._exec_in(toks, frame, start_at, stop_at)
        finally:
            self.frame = prev_frame

    def _exec_in(self, toks, frame, start_at=0, stop_at=None):
        # byte offset -> token index, so a resolved jump target is a seek.
        # start_at/stop_at let run_item execute ONE item's body inside the
        # full menu token list (so its jumps resolve to real targets, which a
        # sliced copy could not) while beginning at the item and stopping at
        # the next one.
        index = {t["at"]: i for i, t in enumerate(toks) if "at" in t}
        # STOP AT THE FIRST UNDECODED BYTE. A proc's block header sizes only
        # its OWN section -- each ITEM opens another -- so it cannot bound the
        # proc, but garbage can: __inpa_shutdown__ ends after two dwords and
        # is followed by the pool's trailing bytes ("Global Data"), which
        # decode as `unk` and then as a jump back into themselves. Executing
        # that spins forever. Every proc we actually run decodes cleanly, so
        # the first unk IS the end of the code.
        end = len(toks) if stop_at is None else stop_at
        for j, t in enumerate(toks):
            if t["op"] == "unk" and j < end:
                end = j
                break
        stack = []               # the current call frame's pushed values
        i = start_at
        cur_item = getattr(self, "_item_target", None)
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
                # A RECORD INDEX THE KEY SELECTS. `const <v>; store <global>` in
                # an item body picks a record a shared screen then reads:
                # MS450's fifteen AIF keys each store their index (current=0,
                # "AIF 1"=1 ...) into global 55, and s_aif hands that slot to
                # AIF_LESEN. The value must be a bare literal -- a plain int/str,
                # not a _Bound (a read's result) or _Slot (an unset slot) -- the
                # store targets a GLOBAL, and the first such store per item wins,
                # matching a straight `const; store` in the bytecode.
                if (cur_item is not None and t.get("sc", GLOBAL) == GLOBAL
                        and "_sel" not in cur_item
                        and isinstance(val, (int, str))
                        and not isinstance(val, (bool, _Bound))):
                    cur_item["_sel"] = (t["n"], val)
                # A CODING IMAGE STORED FOR SLICED DISPLAY. INPAapiResultBinary
                # parks the coding key (DATEN) as pending and the page stores a
                # display string it then prints in chunks via midstr -- each
                # chunk is one coding-block row. Binding the pending key onto the
                # stored slot lets every slice carry DATEN, so the whole image
                # draws its blocks instead of collapsing to one anonymous row.
                pend = self.globals.get("__pending_binary__")
                if (pend and isinstance(val, str)
                        and not isinstance(val, _Bound)):
                    sc = t.get("sc", GLOBAL)
                    val = _Bound(_Slot(sc, t["n"]), val, pend)
                    self.binds[(sc, t["n"])] = pend
                    self.globals.pop("__pending_binary__", None)
                self._write(t, frame, val)
            elif op == "binop":
                b = stack.pop() if stack else None
                a = stack.pop() if stack else None
                # A READING CONSUMED BY A COMPARISON IS A CONTROL VALUE. The
                # script reads STAT_GETRIEBE_NR only to gate `if == 1` on the
                # transmission block, never to show it; recording the key here
                # lets the deriver tell a predicate read from a displayed one,
                # so a value never drawn is not surfaced as a phantom row.
                if t.get("name") in ("eq", "ne", "lt", "gt", "le", "ge"):
                    for x in (a, b):
                        if isinstance(x, _Bound) and x.key:
                            self.out.predicate_reads.add(x.key)
                stack.append(_binop(t.get("name"), a, b))
            elif op == "jfalse":
                cond = stack.pop() if stack else False
                if not _truthy(cond):
                    # THE SKIPPED ARM STILL NAMES REAL RESULTS. A read helper
                    # branches on a runtime value we don't have (DATA_ID picks
                    # which block DDE's data_id_lesen reads); executing one arm
                    # loses the keys the others read. inpax, decoding statically,
                    # sees them all. Harvest the skipped span's Result* keys so
                    # the union matches -- reads only, never running its draws.
                    nxt = index.get(t["to"], end)      # past-end target = exit
                    self._harvest_reads(toks, i + 1, nxt)
                    if nxt >= end:
                        return                         # skip-to-end: proc done
                    i = nxt
                    continue
            elif op == "jump":
                nxt = index.get(t["to"], end)          # past-end target = exit
                if nxt >= end:
                    return                             # an unconditional exit
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
                    # A CONVERSION HELPER TURNS A KEYED VALUE INTO A DISPLAY
                    # STRING through an out-ref. inttohexstring/bytetohexstring
                    # format their input via structure builtins the VM does not
                    # model, so the out-slot comes back unset -- yet the row
                    # still shows the value that went in (LWS5's checksum reads
                    # COD_CHECK, hex-formats it, draws it). When the callee left
                    # an out-ref slot unfilled and an INPUT carried a key, carry
                    # that key onto the out-slot so the draw is not anonymous.
                    in_key = next((x.key for x in stack
                                   if isinstance(x, _Bound) and x.key), None)
                    outs = [x for x in stack if isinstance(x, tuple)
                            and len(x) == 3 and x[0] == "ref"]
                    self._exec(self.procs[name], dict(enumerate(stack)))
                    if in_key:
                        for ref in outs:
                            dsc = LOCAL if ref[1] == 2 and \
                                getattr(self, "frame", None) is not None \
                                else GLOBAL
                            cur = (self.globals.get(ref[2]) if dsc == GLOBAL
                                   else self.frame.get(ref[2]))
                            if isinstance(cur, _Bound) and cur.key:
                                continue          # callee bound it itself
                            val = _Bound(_Slot(dsc, ref[2]), "0", in_key)
                            self.binds[(dsc, ref[2])] = in_key
                            if dsc == GLOBAL:
                                self.globals[ref[2]] = val
                            elif self.frame is not None:
                                self.frame[ref[2]] = val
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

    def _harvest_reads(self, toks, lo, hi, _seen=None):
        """Record the result keys an unexecuted span reads, without running it.

        A branch we skip may hold INPAapiResult* calls whose keys are real
        (the value simply isn't shown on the path we took). Scanning the span
        for those calls and their KEY constant unions the reads across arms --
        the same result inpax gets by decoding every branch statically. Only
        keys are taken; the span's draws, jobs and side effects are not run.

        A skipped span often just CALLS a helper that does the reading (a
        "write this block to file" arm delegates to rbmBlock1InDatei), so a
        calluser is followed into the callee's body -- guarded against
        recursion -- to reach the keys it reads.
        """
        if _seen is None:
            _seen = set()
        hi = min(hi, len(toks))
        for k in range(lo, hi):
            t = toks[k]
            op = t.get("op")
            if op == "calluser":
                name = self.byid.get(("func", t["n"]))
                if name and name in self.procs and name not in _seen:
                    _seen.add(name)
                    body = self.procs[name]
                    self._harvest_reads(body, 0, len(body), _seen)
                continue
            if op != "call" or "Result" not in (t.get("name") or ""):
                continue
            # the KEY is the first string constant pushed for this call, a few
            # tokens back (dest ref, KEY, index, default all precede the call)
            for b in range(k - 1, max(lo, k - 10) - 1, -1):
                v = toks[b].get("v") if toks[b].get("op") == "const" else None
                if isinstance(v, str) and v:
                    if v not in self.out.reads:
                        self.out.reads.append(v)
                    break

    def _read(self, t, frame):
        sc = t.get("sc", GLOBAL)
        if sc == GLOBAL:
            return self.globals.get(t["n"])
        return frame.get(t["n"])

    def _write(self, t, frame, val):
        # STORE THROUGH AN OUT-PARAMETER. INPA's string helpers all return by
        # writing into a ref the caller passed (inttohexstring(->dst) etc.); the
        # `ref` store's slot holds that ('ref', kind, n) tuple, so the write
        # lands in the CALLER's slot, not the local one. Without this the
        # conversion vanished and the caller kept whatever the slot held before
        # -- LWS5's checksum row drew the previous block's value (and its key)
        # because slot 20 was never updated by inttohexstring.
        if t.get("ref"):
            src = frame.get(t["n"]) if t.get("sc", GLOBAL) != GLOBAL \
                else self.globals.get(t["n"])
            if isinstance(src, tuple) and len(src) == 3 and src[0] == "ref":
                dsc = LOCAL if src[1] == 2 and frame is not None else GLOBAL
                n = src[2]
                # the written value carries its own binding if it has one; else
                # this slot no longer holds what a prior read bound to it, so
                # clear any stale binding a later draw would otherwise resurrect
                key = val.key if isinstance(val, _Bound) and val.key else None
                if key:
                    self.binds[(dsc, n)] = key
                else:
                    self.binds.pop((dsc, n), None)
                if dsc == GLOBAL:
                    self.globals[n] = val
                elif frame is not None:
                    frame[n] = val
                return
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


def _carry(a, b):
    """The (slot, key) an arithmetic result should keep from its operands.

    A drawn value is often a SCALED reading -- ABS wheel speed is
    `slot13 * scale`, the read's key STAT_RAD_GESCHW_VL_WERT living on slot13.
    Scaling with a plain number must not drop that identity, or every scaled
    readout draws unkeyed and the poller cannot fill it. Returns (slot, key)
    from whichever operand carries them, else (None, None).
    """
    for x in (a, b):
        if isinstance(x, _Bound) and (x.key or x.slot):
            return x.slot, x.key
        if isinstance(x, _Slot):
            return x, None
    return None, None


def _bound_num(value, a, b):
    """A numeric result, wrapped to keep an operand's slot/key when one had it."""
    slot, key = _carry(a, b)
    if slot is None and key is None:
        return value
    return _Bound(slot, str(value), key)


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
            _, key = _carry(a, b)
            out = _Bound(slot, f"{'' if a is None else a}"
                               f"{'' if b is None else b}", key)
            # remember every OTHER read folded into this concatenation, so a
            # composite draw (FAHRZEUG_TYP + ' / ' + FAHRZEUG_VARIANTE) reports
            # both halves as drawn -- the element carries `key`, the rest ride
            # on `extra` and are not re-added as phantom rows.
            folded = []
            for x in (a, b):
                if isinstance(x, _Bound):
                    if x.key and x.key != key:
                        folded.append(x.key)
                    folded.extend(k for k in x.extra if k != key)
            if folded:
                out.extra = tuple(dict.fromkeys(folded))
            return out
        if isinstance(a, str) or isinstance(b, str):
            return f"{'' if a is None else a}{'' if b is None else b}"
        return _bound_num(_num(a) + _num(b), a, b)
    if name == "sub":
        return _bound_num(_num(a) - _num(b), a, b)
    if name == "mul":
        return _bound_num(_num(a) * _num(b), a, b)
    if name == "div":
        return _bound_num(_num(a) / _num(b) if _num(b) else 0, a, b)
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

    def result(self, key, index=1, default="", integer=False):
        # JOB_STATUS IS THE ONE RESULT EVERY JOB RETURNS. Scripts branch on it
        # before touching anything else -- `if JOB_STATUS != "OKAY"` guards the
        # whole body of nearly every ident and memory screen -- so answering ""
        # sent all 489 of them down the error arm and skipped the real work.
        # It is also what status() already reports; the two must agree.
        if key == "JOB_STATUS":
            return self.status()
        if integer:
            # ONE OF EVERYTHING. An integer read frequently bounds a loop --
            # msd87's s_svk_lesen draws a row per ANZAHL_EINHEITEN -- and ""
            # coerces to 0, so every result-driven loop ran zero times and its
            # row template never appeared. Answering 1 is the same modelling
            # decision as presetting presence flags true for the menu walk:
            # the offline IR describes the maximal structure, one iteration of
            # each list; a live host overwrites this with what the car says.
            return 1
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
    # WHICH ARGUMENT FILLS THIS LINE. A coding page reads the same job once per
    # data block, the block index its only distinguishing argument (LWS5's
    # CODIERUNG_LESEN "0".."6"); the reads land on the line INPA is drawing, so
    # the line remembers the arg. The app reads each argument in its own pass --
    # without it, one block would overwrite another.
    #
    # A PER-WHEEL GRID IS A LOOP THAT NEVER OPENS A LINE. RDC's s_rad_io runs
    # `while i < 4: i += 1; INPAapiJob(STATUS_RAD_IO, i); draw row i` -- one job
    # per wheel, but the row is drawn by ftextout at an absolute (row, col), so
    # no LINE opcode ever fires and all four wheels pile onto the one open line.
    # The renderer splits a per-position screen into one poll per LINE-level arg,
    # so four wheels on one line collapse to a single read that overwrites every
    # wheel with the last. The job boundary IS the row boundary here: when this
    # job's argument differs from the wheel already drawn on the open line, the
    # loop has advanced to the next wheel, so open a fresh line for it. A line
    # still carrying only its heading text (no drawn value yet) is this wheel's
    # own line, not a previous one's, so it is filled rather than split off.
    if rec.get("arg"):
        last = vm.out.lines[-1] if vm.out.lines else None
        drawn = bool(last and last.get("elements"))
        if drawn and last.get("jobArg") not in (None, rec["arg"]):
            vm.out.lines.append({"label": None, "elements": []})
            last = vm.out.lines[-1]
        if last is not None and "jobArg" not in last:
            last["jobArg"] = rec["arg"]
    vm.globals["__last_job__"] = vm.host.job(sgbd, job, arg, None)


def _b_fsmode(vm, stack, item):
    """INPAapiFsMode -- selects the fault-memory mode for INPAapiFsLesen.

    NOT a job. INPA's fault reader is FsMode+FsLesen (writes na_fs.tmp, read
    back by viewopen); the item names no job and the app identifies it by its
    caption (IR_FAULT_READ). The old code took the last string arg as a job
    and captured the MODE letter ("w") -- a bogus one-char job on every
    fault-menu Read item. Mark the item a fault read and leave job alone.
    """
    if item is not None:
        item["faultRead"] = True


def _b_checkstatus(vm, stack, item):
    vm.globals["__status__"] = vm.host.status()


def _b_result(vm, stack, item, integer=False):
    # INPAapiResult*(dest ref, KEY, index, default)
    key = next((x for x in stack if isinstance(x, str)), None)
    val = vm.host.result(key, integer=integer) if key else ""
    refs = [x for x in stack if isinstance(x, tuple)
            and len(x) == 3 and x[0] == "ref"]
    if len(refs) >= 2:
        # the legacy two-ref form: INP1apiResultText(->ok, ->text, KEY, ...).
        # The FIRST ref is a success flag, the value goes through the SECOND.
        # Writing the text through the first left the flag holding a string
        # and the text slot unset, so `ok == 0 or text != "OKAY"` guards --
        # msd87's s_svk_lesen -- printed their error row for every job.
        _store_out(vm, [refs[0]], 1)
    dest = refs[-1] if refs else None
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
        # EVERY key the script reads counts, even one never drawn. A reading's
        # unit (STAT_..._EINH) is read into a slot and paired with the value
        # at display time -- INPA never draws it on its own line -- so a
        # draw-only IR loses it. Recording the read lets screens.py pair units
        # onto their value and surface any other read-but-undrawn result.
        vm.out.reads.append(key)


def _b_errorcode(vm, stack, item):
    """INP1apiErrorCode(->dest) -- 0 means the last call succeeded.

    The legacy API's twin of JOB_STATUS: scripts on the INP1 path branch on
    it before reading anything (msd87's s_svk_lesen prints "Fehler beim
    Lesen von Job" for every row when it is unset). It must agree with
    status(): the host that says OKAY has no error code to report.
    """
    _store_out(vm, stack, 0)


def _b_errortext(vm, stack, item):
    _store_out(vm, stack, "")


def _b_resultsets(vm, stack, item):
    """INP1apiResultSets(->ok, ->count) -- how many result sets came back.

    Two refs like the rest of the INP1 family: success flag first, then the
    count. Offline the count is 1 for the same reason an integer read
    answers 1: the maximal structure enumerates one of each list.
    """
    refs = [x for x in stack if isinstance(x, tuple)
            and len(x) == 3 and x[0] == "ref"]
    if len(refs) >= 2:
        _store_out(vm, [refs[0]], 1)
    _store_out(vm, [refs[-1]] if refs else [], 1)


def _b_strarraycreate(vm, stack, item):
    """StrArrayCreate(->ok, ->handle) -- a named list of strings.

    LSZ's whole lamp-status family reads through one: inpainit builds the
    state-word table (0 "OFF", 1 "SL", ...) and every s_stat_* screen maps
    each channel's value to its word. Without arrays the lookup answered
    nothing, which is why those screens decoded to zero keyed rows.
    """
    refs = [x for x in stack if isinstance(x, tuple)
            and len(x) == 3 and x[0] == "ref"]
    vm._arrN += 1
    vm.strArrays[vm._arrN] = {}
    if len(refs) >= 2:
        _store_out(vm, [refs[0]], 1)
    _store_out(vm, [refs[-1]] if refs else [], vm._arrN)


def _b_strarraywrite(vm, stack, item):
    # StrArrayWrite(handle, index, text)
    ints = [int(_num(x)) for x in stack
            if isinstance(x, (int, float, _Bound)) and not isinstance(x, bool)]
    txt = next((x for x in stack if isinstance(x, str)
                and not isinstance(x, _Bound)), None)
    if len(ints) >= 2 and txt is not None and ints[0] in vm.strArrays:
        vm.strArrays[ints[0]][ints[1]] = txt


def _b_strarrayread(vm, stack, item):
    """StrArrayRead(handle, index, ->dest) -- dest = table[index].

    A LOOKUP MUST NOT LOSE THE BINDING, same rule as a conversion: the index
    is the result a job returned (STAT_LV_7's value picks the word), so the
    word that comes out still carries that key -- and the whole table rides
    along as `amap`, which the derivation ships so a LIVE value can be
    rendered as INPA's word rather than a bare number.
    """
    # positional, per the signature -- picking by "which value looks like a
    # handle" broke the moment handle and index were both 1
    vals = [x for x in stack if not (isinstance(x, tuple)
            and len(x) == 3 and x[0] == "ref")]
    arr = vm.strArrays.get(int(_num(vals[0])), {}) if vals else {}
    text = arr.get(int(_num(vals[1])), "") if len(vals) > 1 else ""
    out = _Bound(None, text, _keyed(stack))
    out.amap = {str(k): v for k, v in arr.items()} or None
    _store_out(vm, stack, out, out.key)


def _b_result_int(vm, stack, item):
    """The integer reads -- INPAapiResultInt and kin -- marked as such so the
    offline host can answer a number rather than empty text."""
    _b_result(vm, stack, item, integer=True)


def _b_result_binary(vm, stack, item):
    """INPAapiResultBinary(KEY, index) -- a binary result read into an IMPLICIT
    buffer. It names no destination slot; GetBinaryDataString moves the value
    out afterwards. LWS5's coding page reads COD_DATEN this way once per block,
    then draws the seven blocks -- so the key is parked as PENDING here and the
    later GetBinaryDataString carries it onto the slot the draw actually shows.
    Every key read still counts (inpax counts them all), so it is recorded too.
    """
    key = next((x for x in stack
                if isinstance(x, str) and not isinstance(x, _Bound)), None)
    if key:
        vm.globals["__pending_binary__"] = key
        vm.out.reads.append(key)


def _b_getbinarydatastring(vm, stack, item):
    """GetBinaryDataString(->dst, ->src) -- format the binary buffer as a string
    into dst. Carry whatever key the src slot holds, or the one the preceding
    ResultBinary left pending, onto dst as a BOUND value -- so a later draw of
    dst (LWS5 draws it through ausgabe_formatiert) emits a value element keyed
    by the coding result rather than anonymous text.
    """
    refs = [x for x in stack if isinstance(x, tuple)
            and len(x) == 3 and x[0] == "ref"]
    if len(refs) < 2:
        return
    dst, src = refs[0], refs[1]
    dsc = LOCAL if dst[1] == 2 and vm.frame is not None else GLOBAL
    ssc = LOCAL if src[1] == 2 and vm.frame is not None else GLOBAL
    key = vm.binds.get((ssc, src[2])) or vm.globals.pop("__pending_binary__",
                                                        None)
    if not key:
        return
    # ONE OF EVERYTHING, as everywhere else offline: the binary buffer has at
    # least one byte on a real car, so the formatted string is non-empty. A
    # helper draws it a chunk at a time in a `while offset < len` loop
    # (LWS5's ausgabe_formatiert); an empty string runs that loop zero times
    # and the row never draws, so the placeholder must be non-empty to let the
    # keyed value reach a draw.
    val = _Bound(_Slot(dsc, dst[2]), "0", key)
    vm.binds[(dsc, dst[2])] = key
    if dsc == GLOBAL:
        vm.globals[dst[2]] = val
    elif vm.frame is not None:
        vm.frame[dst[2]] = val


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
    also = ()                                # other reads folded into this draw
    for x in stack:
        if isinstance(x, _Bound) and x.key:
            key = x.key                      # the value carries its own key
            also = tuple(k for k in getattr(x, "extra", ()) if k != key)
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
    # WHERE INPA DREW IT. ftextout(text, row, col, ...): the first two integers
    # are the cell. A caption printed as a whole ROW above its values (DWA4's
    # "Clamp R / Clamp 15 / Clamp 61" over three lamps) can only pair to the
    # right value by position, so the text must carry its row/col like a gauge
    # does -- without them the pairing falls back to reading order and hands
    # every lamp the LAST caption.
    ints = [x for x in stack if isinstance(x, int) and not isinstance(x, bool)]
    if not vm.out.lines:
        vm.out.lines.append({"label": None, "elements": []})
    # A DRAWN UNIT IS NOT A ROW OF ITS OWN. INPA reads a value's unit through a
    # companion _EINH result and prints it beside the number (RDC's coding page
    # draws MDOFFSET then MDOFFSET_EINH); it is the same reading, so the unit
    # folds onto the value element sharing its base rather than standing as a
    # second field. Without this the card counted six rows where INPA shows
    # five.
    if key and key.upper().endswith(("_EINH", "_EINHEIT")):
        host = next((e for e in reversed(vm.out.lines[-1]["elements"])
                     if e.get("key") and _base(e["key"]) == _base(key)
                     and not e["key"].upper().endswith(("_EINH", "_EINHEIT"))),
                    None)
        if host is not None:
            host["unit"] = key
            return
    if key:
        el = {"t": "value", "key": key}
        if also:
            el["also"] = list(also)          # composited reads, drawn with `key`
        amap = next((getattr(x, "amap", None) for x in stack
                     if getattr(x, "amap", None)), None)
        if amap:
            el["map"] = amap
    else:
        el = {"t": "text", "s": lit}
    if len(ints) >= 2:
        el["row"], el["col"] = ints[0], ints[1]
    vm.out.lines[-1]["elements"].append(el)


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
    # THE REF NAMES ITS OWN SCOPE. A procref is ('ref', kind, n) and kind 2
    # is a frame slot -- guessing from "is a frame active" wrote LSZ's array
    # handle into the frame while every reader loads global 46.
    sc = LOCAL if dest[1] == 2 and vm.frame is not None else GLOBAL
    n = dest[2]
    if key is not None:
        amap = getattr(val, "amap", None)
        val = _Bound(_Slot(sc, n), "" if val is None else str(val), key)
        val.amap = amap
        vm.binds[(sc, n)] = key
    if sc == GLOBAL:
        # AN OFFLINE NON-ANSWER MUST NOT OVERWRITE A PRESET. The menu walk
        # binds module-presence globals true because fitment is a property of
        # the car, not the file; a Result* that returns "" offline would erase
        # that and hide every guarded item (13,185 jobs vanished this way).
        # A real value still wins. The preset is literally the bool True --
        # anything else in the slot is real state a builtin's answer may
        # replace, including with "" (a string-array lookup can miss).
        if val not in ("", None) or vm.globals.get(n) is not True:
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


def _b_input(vm, stack, item):
    """An input dialog: INPA asks the user for a value the key then sends.

    KLIMA_5B's flap-position keys all run STEUERN_MOTOR_KLAPPENPOSITION but
    each opens its own dialog first ("Fresh air flap", "Position (0-100 %)"),
    so the keys are not interchangeable and none can be sent without asking.
    The dialog's own strings -- its title and its range/help -- are the string
    constants pushed for this call, and they are what the app must show. The
    call also writes the answer through an out-ref; a non-empty placeholder
    goes there so a later `if answer ...` does not take the empty-slot arm.
    """
    prompts = [x for x in stack if isinstance(x, str) and str(x).strip()
               and not isinstance(x, _Bound)]
    if item is not None and prompts:
        have = item.setdefault("prompt", [])
        have += [p for p in prompts if p not in have]
    # the answer flows back through the dialog's out-ref(s); a "0" keeps any
    # argument the key assembles from it non-empty, like an integer read
    for ref in [x for x in stack if isinstance(x, tuple)
                and len(x) == 3 and x[0] == "ref"]:
        _store_out(vm, [ref], "0")


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


def _toggle_job(body):
    """The job a togglelist state machine sends with its selection, or None.

    togglelist (builtin_16) writes the picked row into an out variable, and
    INPAapiJob sends that variable as its WHOLE argument. Recovering the
    contract (which job, and that the selection is the entire arg) lets the
    picker offer INPA's list and send the row the user picks. The two calls
    can live in different item bodies, so out_var is found in a first pass.
    """
    out_var = None
    for i, t in enumerate(body):
        if t["op"] == "call" and t.get("name") == "builtin_16":
            for b in reversed(body[max(0, i - 4):i]):
                if b["op"] == "procref":
                    out_var = b["n"]
                    break
    for i, t in enumerate(body):
        if out_var is None or t["op"] != "call":
            continue
        if t.get("name") not in ("INPAapiJob", "INPAapiJobData"):
            continue
        win = body[max(0, i - 6):i]
        job = next((b["v"] for b in win
                    if b["op"] == "const" and b.get("t") == "s" and b["v"]),
                   None)
        if not job:
            continue
        after = [b for b in win
                 if b["op"] == "const" and b.get("t") == "s" and b["v"] == job]
        if not after:
            continue
        rest = win[win.index(after[0]) + 1:]
        if any(b["op"] == "binop" for b in rest):
            continue
        if not any(b["op"] == "var" and b["n"] == out_var for b in rest):
            continue
        return {"job": job, "argVar": out_var}
    return None


def _machine_job(vm, name, seen=None):
    """The fixed job a non-picker state machine will fire, or None.

    A write/reset sequence yields (confirm, "press pedal") and fires a
    CONSTANT job on continue -- SPU_PARAMETER_SCHREIBEN, OTL_DATEN_RESET.
    The VM stops at the first yield so it never reaches the call, but the job
    is a literal in the machine's body (unlike a togglelist's runtime arg),
    so scanning for the first INPAapiJob's job argument recovers it. Follows
    0x42 cross-state transitions, bounded by `seen`.
    """
    if seen is None:
        seen = set()
    if name in seen or name not in vm.procs:
        return None
    seen.add(name)
    toks = vm.procs[name]
    for i, t in enumerate(toks):
        if t["op"] == "call" and t.get("name") in ("INPAapiJob",
                                                    "INP1apiJob",
                                                    "INPAapiJobData"):
            # job is ARGUMENT POSITION 1 (sgbd is 0) -- taking the first
            # string grabbed the sgbd name "ACC" or a ";" separator. Use the
            # disassembler's stack simulator, same rule as _b_job's stack[1].
            job = D.arg_str(D.arg_positions(D.frame_of(toks, i)),
                            D.JOB_ARG_JOB)
            if job:
                return job
        elif t["op"] == "procref" and t.get("kind") == 66:
            sub = vm.byid.get(("state", t["n"]))
            if sub:
                j = _machine_job(vm, sub, seen)
                if j:
                    return j
    return None


def _b_select(vm, stack, item):
    if item is not None and not item.get("action"):
        item["action"] = "select"


def _b_deselect(vm, stack, item):
    if item is not None and not item.get("action"):
        item["action"] = "deselect"


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
    # Record which machine this key enters so the form deriver can read the
    # write's argument order and each Change key's field statically -- the
    # run parks at the machine's first yield and never reaches those.
    if item is not None:
        item["stateEnter"] = name
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
    # A TOGGLELIST MACHINE resolves to its picker screen; a job machine does
    # not. The distinguisher is the machine itself -- _toggle_job succeeds
    # only for the togglelist idiom (a job whose whole argument is the
    # togglelist variable). Only then is the parked screen a real picker the
    # user drives; otherwise the machine did job work and any screen it
    # touched (often an empty s_dummy placeholder) is not what to show. This
    # is what the reference does by running: the screen showing at the yield
    # is the picker's, and job machines just park on a scratch screen.
    if item is not None:
        tj = _toggle_job(vm.procs.get(name) or [])
        if tj:
            # a togglelist picker: the parked screen is the picker, the job
            # fires on a pick
            if vm.out.screen and not item.get("screen"):
                item["stateScreen"] = vm.out.screen
            if not item.get("job"):
                item["job"] = tj["job"]
                item["stateJob"] = True
        elif not item.get("job"):
            # a write/reset sequence: it fires a FIXED job past its yield,
            # which the run did not reach. The job is a literal in the
            # machine, so scan for it. No stateScreen -- the screen it
            # touched (often an empty s_dummy) is not a user page.
            mj = _machine_job(vm, name)
            if mj:
                item["job"] = mj
                item["stateJob"] = True


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
    "INPAapiResultInt": _b_result_int,
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
    "select": _b_select, "deselect": _b_deselect,
    "INPAapiInit": _b_noop, "INPAapiEnd": _b_noop,
    "INPAapiFsLesen": _b_noop, "INP1apiErrorText": _b_errortext,
    "INP1apiErrorCode": _b_errorcode, "INP1apiResultSets": _b_resultsets,
    "getinputstate": _b_getinputstate, "inputhex": _b_noop,
    # input dialogs a menu key opens to ask for the value it sends -- KLIMA's
    # flap positions prompt "Position (0-100 %)" then send it. The hex/digital
    # "Change field" dialogs (inputhex/inputdigital/input2hex) are left to the
    # state-form deriver; these are the value-prompt forms.
    "builtin_3f": _b_input, "input2text": _b_input,
    "input2hexnum": _b_input, "inputint": _b_input,
    "fileopen": _b_fileopen, "fileclose": _b_fileclose,
    "filewrite": _b_filewrite, "fileread": _b_fileread,
    "hexdump": _b_noop, "printfile": _b_noop,
    "setstatemachine": _b_noop, "StrArrayCreate": _b_noop,
    "StrArrayDestroy": _b_noop, "StrArrayRead": _b_noop,
    "StrArrayCreate": _b_strarraycreate,
    "StrArrayWrite": _b_strarraywrite,
    "StrArrayRead": _b_strarrayread,
    "realtostring": _b_inttostring,
    "INP1apiResultInt": _b_result_int,
    "INPAapiResultBinary": _b_result_binary,
    "GetBinaryDataString": _b_getbinarydatastring,
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
