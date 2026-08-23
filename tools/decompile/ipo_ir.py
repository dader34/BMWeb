#!/usr/bin/env python3
"""Emit one ECU's ENTIRE INPA UI as a single JSON file -- the IR.

The end state this serves: the app stops hardcoding screens and interprets
these files instead. One .IPO in, one JSON out, layout 1:1 -- rows, columns,
captions, gauges, lamps, menus, F-key numbers -- with translations left as the
only hand-maintained layer (each .IPO's strings are frozen in whatever
language BMW compiled it with; the `language` tag tells the renderer whether
deGerman applies).

SCHEMA (ir = 1)

    {
      "ir": 1,
      "ecu": "RDC",
      "coverage": 97.7,                     // % of code bytes decoded
      "entry": { "screen": "s_main", "menu": "m_main" },
      "menus": {
        "m_main": { "items": [
          { "nr": 1, "label": "Info", "screen": "s_info" },
          { "nr": 5, "label": "Status",
            "screen": "s_status", "menu": "m_rdc_status" },
          { "nr": 9, "label": "Print", "action": "printscreen" },
          { "nr": 20, "label": "Exit", "action": "exit" } ] }
      },
      "screens": {
        "s_rad_io": {
          "id": 9,
          "title": "WE status read",
          "jobs": [ { "name": "STATUS_RAD_IO", "write": false } ],
          "lines": [
            { "caption": "RDC messages",
              "keys": ["STAT_PANNENMLDG"],        // LINE's own key list
              "elements": [
                { "t": "text",  "row": 2, "col": 20, "s": "defect-messages" },
                { "t": "gauge", "row": 3, "col": 0, "key": "STAT_DRUCK_VL",
                  "min": 0.0, "max": 6.375, "unit": "bar", "fmt": "3.1" },
                { "t": "lamp",  "row": 7, "col": 1, "key": "STAT_MV1_EIN",
                  "on": "ON", "off": "OFF" },
                { "t": "value", "row": 4, "col": 5,
                  "key": "STAT_PANNENMLDG" } ] } ]
        }
      }
    }

ELEMENTS -- one per display statement, in source order:
    text    static caption           (ftextout / text / textout literal)
    value   a result printed as text (a bound variable reaches ftextout)
    gauge   analogout               (min/max resolved; unitKey when the unit
                                     itself is read from an _EINH result)
    lamp    digitalout or a per-ECU helper shaped (KEY, row, col, on, off)

`nr` on menu items is the ITEM number from the bytecode -- INPA's real F-key.

CONTROL-FLOW FIELDS (decoded from the jump/binop layer; all additive)

    element.showIf   {"key": K, "op": "==|!=|<|>|<=|>=|truthy|falsy",
                      "v": ...}
        the element is drawn only when result K satisfies the condition --
        INPA's `if (job_state != "OKAY") ftextout(...)`. Both branches of
        an if are still emitted; the renderer picks instead of drawing both.

    job.argSlot      global slot number feeding the job's VARIABLE argument
        (present only with argFromMenu): the join point for the two item
        fields below.

    item.promptArg   {"slot": n, "template": ["LAR;", {"input": 0}, ";",
                      {"input": 1}]}
        this key asks (see item.prompt), splices the dialog answers into the
        template, stores it in global slot n, and the screen it opens sends
        that slot as the job argument. {"input": k} is the k-th answer of
        the item's dialog(s), in declaration order. A renderer that fills
        the template can SEND the job; without answers it must not.

    item.step        {"slot": n, "delta": +16}
        this key steps a counter/address held in global slot n by delta and
        re-runs whatever reads it (MS450's memory browser: Address+10h).

WRITES are represented, never hidden: a job matching the write shapes carries
"write": true and the interpreter refuses to auto-run it. INPA's screen is
reproduced; the action stays behind the same until-verified-on-a-car gate as
everywhere else in this repo.

KNOWN LIMITS, carried in the data rather than papered over:
    - variant screens (one menu entry, N gearbox screens) stay separate
      screens; the menu item lists every target
    - job argument loops (RDC calls STATUS_RAD_IO once per wheel) are not yet
      structural; the job appears once
    - the fault-memory formatter builds keys at runtime; its screen emits
      whatever is static and no more

TRANSLATION is a second pass, not a render-time concern. This emitter gathers
every caption an ECU displays into `strings`; tools/ipo_i18n.js resolves them
once -- data/inpa-i18n/<ECU>.json first, then the shared vocabulary in
app/renderer/core/translate.js -- and writes the result back as `i18n`, consuming
`strings`. The interpreter looks up that map instead of translating.

That per-ECU layer is the point: BMW's compounds are not shared vocabulary.
"Gesteuerte LuftFuehrung GLF" is MS450's own phrase for its air-guidance
actuator, and a word rule general enough to translate it turns other ECUs'
captions into "Gecontrolse".

    python3 tools/ipo_ir.py RDC                 # one ECU to stdout
    python3 tools/ipo_ir.py --write             # corpus -> data/inpa-ir/
    node   tools/ipo_i18n.js                    # ALWAYS after --write: the
                                                # rewrite drops the i18n map
    python3 tools/ipo_ir.py --check             # invariants (check.sh)
"""
import os
import re
import sys
import json
import glob
import collections

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import ipo_screens as L1                                        # noqa: E402
import ipo_disasm as D                                          # noqa: E402

IR_VERSION = 1

# WHAT PRODUCED THIS DATA. data/inpa-ir is derived from the decompiler, and
# nothing tied the two together: a decoder fix would land while the shipped
# IR stayed as it was, and every check still passed because each of them
# only asks whether the DATA is self-consistent. It happened -- the state
# label and version-field fixes sat uncommitted for a day while the app
# served pre-fix IR, and Energiediagnose was a whole screen short.
#
# The stamp is the hash of the sources the IR is built FROM. --write records
# it; --check compares and fails. It cannot detect a vendor .IPO changing
# underneath us, only a code/data mismatch, which is the failure that has
# actually bitten.
def _decoder_stamp():
    """SHA-256 over the modules whose output the IR is."""
    import hashlib
    h = hashlib.sha256()
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ("ipo_disasm.py", "ipo_ir.py", "ipo_screens.py"):
        try:
            with open(os.path.join(here, name), "rb") as f:
                h.update(f.read())
        except OSError:
            h.update(b"?" + name.encode())
    return h.hexdigest()[:16]


def _stamp_path():
    return os.path.join(OUT_DIR, "_build.json")


def write_stamp():
    with open(_stamp_path(), "w", encoding="utf-8") as f:
        json.dump({"ir": IR_VERSION, "decoder": _decoder_stamp()}, f)


def check_stamp():
    """None when the IR matches the decoder, else a message saying how not."""
    want = _decoder_stamp()
    try:
        with open(_stamp_path(), encoding="utf-8") as f:
            got = json.load(f)
    except (OSError, ValueError):
        return ("data/inpa-ir carries no build stamp -- it predates this "
                "check, or was written by hand. Run "
                "`python3 tools/decompile/ipo_ir.py --write` then "
                "`node tools/decompile/ipo_i18n.js`.")
    if got.get("decoder") != want:
        return (f"data/inpa-ir was built by decoder {got.get('decoder')}, "
                f"but the decompiler is now {want}. The shipped IR does not "
                f"reflect the current code. Run "
                f"`python3 tools/decompile/ipo_ir.py --write` then "
                f"`node tools/decompile/ipo_i18n.js`.")
    return None
OUT_DIR = os.path.join(os.path.dirname(L1.OUT), "inpa-ir")

def _variant_slot(all_toks):
    """Which global holds the VARIANTE the dispatch tests, or None.

    INPA reads it once at startup and every arm of the per-variant dispatch
    compares against it:

        INPAapiJob(sgbd, "INITIALISIERUNG", ...)
        INP1apiResultText(<status ref>, <string ref>, "VARIANTE", 0, "")
        global13 = <string ref>            # inpainit copies it out
        ...
        if (global13 == "KOMBI46") setmenu(...)

    Found by following that chain -- the result read names VARIANTE, its
    destination procref is the slot, and the store that copies that slot into
    a global is the one the menus test. No name shapes involved, so a
    mixed-case variant (KOMBI36c) or a two-letter one (IKE) is read as
    happily as any other.
    """
    for name in ("inpainit", "__inpa_startup__"):
        toks = all_toks.get(name) or []
        dest = None
        for i, t in enumerate(toks):
            if t["op"] == "call" and t.get("name") in (
                    "INP1apiResultText", "INPAapiResultText"):
                seg = D.frame_of(toks, i)
                strs = [x["v"] for x in seg
                        if x["op"] == "const" and x.get("t") == "s"]
                if "VARIANTE" not in strs:
                    continue
                refs = [x for x in seg if x["op"] == "procref"]
                if refs:
                    # (status ref, string ref): the LAST is where the text lands
                    dest = refs[-1]["n"]
            elif dest is not None and t["op"] == "store" \
                    and t.get("sc") == 0:
                prev = toks[max(0, i - 3):i]
                if any(x["op"] == "var" and x.get("sc") == 2
                       and x["n"] == dest for x in prev):
                    return t["n"]
    return None


def _eq_operands(toks, i):
    """The two values an `eq` at index i consumes: (var slot, literal).

    The opcode takes exactly the two pushes before it, so the pairing is
    exact -- scanning a window instead pulled in a neighbouring literal and
    turned 'Read memory' and '3.0' into KOMBI variants.
    """
    if i < 2:
        return None, None
    slot = lit = None
    for x in (toks[i - 2], toks[i - 1]):
        if x["op"] == "var":
            slot = (x.get("sc", 0), x["n"])
        elif x["op"] == "const" and x.get("t") == "s":
            lit = x["v"]
    return slot, lit


def _variant_guard(toks, at, vslot=None):
    """The variant names guarding the branch that contains toks[at].

    INPA writes per-variant dispatch as an if/else-if chain: a run of
    `VARIANTE == "NAME"` comparisons or-ed together, a `jfalse` over the arm,
    then the setmenu/setscreen for that arm.

    A name is taken ONLY from an `eq` whose other operand is the variant
    global (see _variant_slot) -- never from how the string is spelled. The
    old test was a shape match, `^[A-Z][A-Z0-9]+$` minus a stop-list of
    prefixes, and it could not tell a variant from any other capitalised
    literal in the same condition: "OKAY", the argument of the
    INPAapiCheckJobStatus that INPA emits after every job, was 1,409 of the
    3,604 recorded guard values. It also rejected real variants for their
    spelling -- KOMBI36c is mixed case, KOMBI34L ends in a letter.

    Returns [] when the target is not variant-guarded (the common case), or
    when this file never reads VARIANTE at all.
    """
    if vslot is None:
        return []
    names, seen_jfalse = [], False
    lo = max(0, at - 60)
    window = toks[lo:at]
    for j in range(len(window) - 1, -1, -1):
        x = window[j]
        op = x.get("op")
        # A `jump` before we ever saw a jfalse means we are in the ELSE arm of
        # the chain -- the previous arm jumped over us. An else arm carries no
        # condition of its own, so it is not variant-guarded: returning the
        # previous arm's names here would hand KOMBI85's menu to everybody who
        # falls through (m_steuern_36 in KOMBI's Activate).
        if op == "jump" and not seen_jfalse:
            return []
        # the arm's own jfalse: everything before it is the condition
        if op == "jfalse" and not seen_jfalse:
            seen_jfalse = True
            continue
        if not seen_jfalse:
            continue
        # a previous arm's jump/jfalse ends this condition
        if op in ("jump", "jfalse", "ITEM"):
            break
        if op == "call":            # a call inside the condition: not a guard
            break
        if op == "binop" and x.get("name") == "eq":
            slot, lit = _eq_operands(window, j)
            if lit and slot == (0, vslot) and lit not in names:
                names.append(lit)
    return list(reversed(names))

# A RESULT name, which is laxer than a job name: BMW ships mixed-case results
# ("Dimmerstellung" on BMBT46TN, "EINSCHALTZAEHLER_FKT2a") and two-letter ones
# ("ECU", "TYP"). Used only where a Result* call names what it reads -- job
# names keep the strict form, or a bare argument like "FM" would pass for one.
_RESULTISH = re.compile(r"^[A-Z][A-Za-z0-9_]+$")
_WRITE_JOB = re.compile(r"SCHREIBEN|STEUERN|RESET|LOESCHEN|CLEAR|WRITE", re.I)


def _is_write(job):
    """Does this job change the ECU PERMANENTLY? The one answer, every path.

    _PERSISTENT_WRITE is the right question -- it deliberately excludes
    STEUERN_*, which IS the actuator mechanism, and flagging those would
    disable every activation. But it also missed the ERASES: 77 jobs ending
    LOESCHEN/CLEAR that wipe adaptations for good (MS430's eight
    ADAPT_*_LOESCHEN, XENON_L's ADAPTIVWERT_LOESCHEN). Clearing an adaptation
    is as permanent as writing one.
    _WRITE_JOB stays what it is -- the broad "touches the ECU" test the screen
    layer uses -- but it is no longer mixed into this decision. Three call
    sites previously used three different combinations, so 107 jobs got a
    different flag depending only on which decode path found them:
    FS_LOESCHEN shipped flagged on 256 items and unflagged on 494.
    """
    if _PERSISTENT_WRITE.search(job):
        return True
    if job.upper().startswith("STEUERN"):
        return False                      # an actuator drive, not a write
    return bool(_ERASE_JOB.search(job))


# an erase is permanent even though it writes nothing
_ERASE_JOB = re.compile(r"LOESCHEN|CLEAR", re.I)

# A menu item's job that changes the ECU PERMANENTLY, as opposed to driving an
# actuator for as long as the test runs. STEUERN_* is deliberately excluded:
# that IS the actuator mechanism, and flagging it would disable every
# activation. What must not fire on a keypress is a job that writes storage or
# clears memory -- KLIMA_5B's "Comp.act" calls EEPROM_SCHREIBEN.
_PERSISTENT_WRITE = re.compile(
    r"EEPROM|SCHREIBEN|_WRITE|PROGRAMMIER|CODIER\w*_SCHREIB|RESET", re.I)

# menu-item builtin calls that are actions, not navigation
_ACTIONS = {0x0c: "exit", 0x10: "select", 0x11: "deselect", 0x13: "start",
            0x17: "printscreen"}


# crude but effective: words that only occur in German-built pools
# ---------------------------------------------------------------------------



# INPA prints its own softkey help as screen text: "< F1 >  DWA output".
# On actuator screens this IS the function list -- the MENU's ITEMs carry only
# fragments ("DWA") and flip state flags, so the caption lives here and joins
# back by F-number.
_SOFTKEY = re.compile(r"^<\s*(?:(Shift)\s*>\s*\+\s*<\s*)?F(\d+)\s*>\s+(.{2,44})$")

# INPA'S OWN CHROME, printed in the softkey bar. This one stays a word list
# on purpose. It runs in the caption MINER, which sees only screen text --
# there is no item to consult yet, and moving the test to the join does not
# work: at that point "navigates and has no job" describes every ordinary
# submenu key as well as every Back key, so deciding there strips the
# captions off real menus (measured: it broke MS450's actuator groups,
# KOMBI46's submenu and the Ident screens). The strings INPA prints for its
# own chrome are a closed set it ships itself, not a guess about meaning.
_SK_CHROME = re.compile(r"^(Print(\s*screen)?|Back|Exit|End|Ende|Zur(ü|ue)ck|"
                        r"Select|Deselect|Auswahl|Abwahl|Druck(en)?|"
                        r"Bildschirmdruck|Change\s+Editor|Gesamt)$", re.I)


# ..._TEXT, or ..._TEXT2 where the index distinguishes bank 1 from bank 2
_TEXT_KEY = re.compile(r"^(.*)_TEXT(\d*)$")
_VALUE_KEY = re.compile(r"^(.*)_(WERT|VALUE)(\d*)$")


def _global_behind(toks, at, local):
    """The global slot a local was last filled from, before toks[at].

    INPA routes a menu-set global through a conversion into a local and
    passes the local: `var<global> ; procref ; call <conv>` leaves the value
    in the frame slot the job then reads. Walking back to the nearest such
    pair recovers which global the screen is really parameterised by, which
    is the link a menu key's own store has to match.
    """
    # The conversion runs in the screen's INIT, before the LINE that holds
    # the job -- so this walks the whole proc, not just the current line.
    for j in range(at - 1, -1, -1):
        t = toks[j]
        if t["op"] == "ITEM":
            break
        if t["op"] == "var" and t.get("sc", 0) == 0:
            nxt = toks[j + 1] if j + 1 < len(toks) else None
            if nxt and nxt["op"] == "procref":
                return t["n"]
    return None


def _pairs_with_value(key, toks, ti):
    """Is this _TEXT read purely to caption the value that follows it?

    Only then is it a caption. A _TEXT read on its own is a real row -- some
    screens print an ECU status string with no number beside it -- so the
    stem has to match: STAT_ZYL1_TEXT before STAT_ZYL1_WERT,
    STAT_VLS_UP_TEXT2 before STAT_VLS_UP_WERT2.

    The value does not always ADD a suffix. MS450's VANOS adaptation reads
    STAT_CAM_REF_IN_1_TEXT and draws STAT_CAM_REF_IN_1 -- the stem alone --
    so requiring a _WERT left four of that screen's eight gauges captioned by
    a phantom row and only four drawn as bars.
    """
    m = _TEXT_KEY.match(key)
    if not m:
        return False
    stem, idx = m.group(1), m.group(2)
    for t in toks[ti + 1:ti + 24]:
        if t["op"] != "const" or t.get("t") != "s":
            continue
        v = str(t["v"])
        if v == key:
            continue
        # the value read for this same stem, with or without a _WERT suffix
        if v == stem + idx or v == stem:
            return True
        mv = _VALUE_KEY.match(v)
        if mv and mv.group(1) == stem and mv.group(3) == idx:
            return True
        if _TEXT_KEY.match(v):
            return False        # the next readout began; no value for this one
    return False


def _dispatch(toks):
    """{selector value: {job, arg}} for a func that switches on its argument.

    INPA reuses ONE func for every key of an actuator screen and tells the
    keys apart by the number the caller passes: MS450's E-box fan menu calls
    `ebl_ansteuer` with 0 for "on", 1 for "off", 255 for "return to DME", and
    the screen itself calls it with 254 to poll status. The func is then a
    chain of `if arg == N: INPAapiJob(...)`, so the comparison constant names
    which key runs which job -- including its argument, which is the only
    thing separating "on" (STEUERN_EBL "0") from "off" (STEUERN_EBL "1").

    Two shapes, both present in MS450's VANOS:

      guarded    `if arg == 255: INPAapiJob(STEUERN_VANOS_IN_ENDE)`
                 the job and its own literal argument are in the branch
      fall-through  `INPAapiJob(STEUERN_VANOS_IN, <var>)`
                 no guard, and the argument is the number the caller passed
                 -- this is how the three duty keys (16 / 50 / 91 %) share
                 one job. Recorded under "*" and applied to any selector the
                 guards did not claim.

    Without this all of a screen's keys resolved to the same func and the app
    drew a status page instead of firing anything.
    """
    out, sel, args = {}, None, []
    for t in toks:
        if t["op"] == "var" and t.get("sc") == 2 and t["n"] == 0:
            sel = "armed"
        elif t["op"] == "const" and t.get("t") == "i" and sel == "armed":
            # candidate selector; only the comparison operator confirms it
            sel = ("pending", t["v"])
        elif t["op"] == "binop" and isinstance(sel, tuple):
            # the guard's operator is now decoded rather than assumed: only
            # `arg == N` names a key's branch. An ordering guard like
            # `arg >= 2` is a range check, not a selector, and crediting it
            # to one key sent that key another key's job.
            sel = sel[1] if t.get("name") == "eq" else None
        elif t["op"] == "frame":
            args = []
        elif t["op"] in ("const", "var", "procref"):
            args.append(t)
        elif t["op"] == "call":
            if t.get("name") in D.JOB_CALLS:
                _p = D.arg_positions(args)
                jb = D.arg_str(_p, D.JOB_ARG_JOB)
                if jb:
                    e = {"job": jb}
                    ag = D.arg_str(_p, D.JOB_ARG_ARG)
                    if ag:
                        e["arg"] = ag
                    if isinstance(sel, int):
                        out.setdefault(str(sel), e)
                    elif any(a["op"] == "var" for a in args):
                        # argument comes from the caller's number
                        e.pop("arg", None)
                        e["argFromKey"] = True
                        out.setdefault("*", e)
                sel = None
            args = []
    return out


def _softkeys(lines):
    """{item_nr: (caption, shifted)} from a screen's printed softkey help.

    A softkey bar has TWO rows. INPA prints the plain keys as "< F3 >" and
    their shifted partners as "<Shift> + < F3 >", and the shifted half is a
    real function -- on SM46 F3 is "inclination +" and Shift+F3 is
    "inclination -", the same seat motor in the other direction.

    The shifted key is ITEM n+10 in the bytecode: verified across the corpus,
    542 of 554 pairings, the remainder being chrome (Exit, Gesamt) whose +10
    slot does not exist. So the key a caption belongs to is n for a plain row
    and n+10 for a shifted one, which is what this returns.
    """
    out = {}
    for ln in lines:
        for e in ln.get("elements", []):
            if e.get("t") != "text":
                continue
            s = str(e.get("s", "")).strip()
            if not _SOFTKEY.match(s):
                continue
            # INPA may print two keys on ONE line ("< F3 > -1°KW  < F4 > +1°KW").
            # Split on every marker so each key takes only its own text --
            # taking the whole tail captioned F3 with F4's wording as well.
            parts = re.split(r"<\s*((?:Shift\s*>\s*\+\s*<\s*)?)F\s*(\d+)\s*>", s)
            for i in range(1, len(parts) - 2, 3):
                shifted = bool(parts[i])
                cap = parts[i + 2].strip()
                if len(cap) < 2 or _SK_CHROME.match(cap):
                    continue
                nr = int(parts[i + 1]) + (10 if shifted else 0)
                out.setdefault(nr, (cap, shifted))
    return out


# A FUNC that is really a screen: it runs a job and draws what comes back.
# Both halves are required. A helper that only formats (ausgabe_formatiert), or
# only calls a job without displaying it (inpainit), is not a screen -- mining
# those would fill the IR with procs no key opens.
_DISPLAY_CALLS = {"textout", "ftextout", "text", "analogout",
                  "digitalout", "multianalogout"}


def _is_display_func(toks):
    names = {t.get("name") for t in toks if t["op"] == "call"}
    return bool(names & _DISPLAY_CALLS) and (names & D.JOB_CALLS) \
        and any(n and n.startswith("INPAapiResult") for n in names)


_CMP_SYM = {"lt": "<", "gt": ">", "le": "<=", "ge": ">=",
            "eq": "==", "ne": "!="}
_CMP_INVERT = {"==": "!=", "!=": "==", "<": ">=", ">=": "<",
               ">": "<=", "<=": ">", "truthy": "falsy", "falsy": "truthy"}


def _screen_ir(toks):
    """Ordered lines/elements for one screen proc."""
    title = None
    jobs = []
    lines = [{"caption": None, "keys": None, "elements": []}]
    bind = {}
    lastconst = {}
    args = []
    pending_result = None
    # CONDITIONAL DISPLAY. Every `if` compiles to cond / stmt / jfalse, and
    # the jfalse target (a byte offset, resolved by the walker) closes the
    # guarded range. Elements emitted inside a range whose condition tests a
    # RESULT-BOUND slot carry showIf; both branches are still emitted -- the
    # renderer chooses instead of drawing both unconditionally. A guard on an
    # unbound slot (a variant flag, a loop counter) attaches nothing.
    guards = []             # innermost last: {"until", "slot", "op", "v"}
    pend_cmp = None         # last comparison binop and its two operands

    def cur():
        return lines[-1]

    def num_args_after_coords(seq):
        seen_ints, out = 0, []
        for a in seq:
            if a["op"] == "const" and a["t"] == "i":
                seen_ints += 1
                continue
            if seen_ints < 2:
                continue
            if a["op"] == "const" and a["t"] == "d":
                out.append(a["v"])
            elif a["op"] == "var" and a["n"] in lastconst:
                out.append(lastconst[a["n"]])
        return out

    for ti, t in enumerate(toks):
        op = t["op"]
        at = t.get("at", 0)
        while guards and at >= guards[-1]["until"]:
            guards.pop()
        if op == "LINE":
            cap = (t.get("label") or "").strip() or None
            keys = [k.strip() for k in re.split(r"[;,]", t.get("keys") or "")
                    if k.strip()] or None
            lines.append({"caption": cap, "keys": keys, "elements": []})
            args = []
            pend_cmp = None
        elif op == "frame":
            args = []
        elif op in ("const", "var", "procref"):
            args.append(t)
        elif op == "jfalse":
            # open a guard to the jump target. The condition is whatever was
            # just compared: `var <cmp> const`, a bare var (truthy), or a
            # negated var. Anything else guards the range opaquely.
            g = {"until": t["to"]}
            ops_ = pend_cmp[1] if pend_cmp else args[-1:]
            vtok = next((a for a in ops_ if a["op"] == "var"), None)
            ctok = next((a for a in ops_ if a["op"] == "const"), None)
            if pend_cmp and pend_cmp[0] == "falsy" and vtok is not None:
                g.update(slot=(vtok.get("sc", 0), vtok["n"]),
                         op="falsy", v=None)
            elif pend_cmp and vtok is not None and ctok is not None:
                g.update(slot=(vtok.get("sc", 0), vtok["n"]),
                         op=_CMP_SYM[pend_cmp[0]], v=ctok["v"])
            elif not pend_cmp and vtok is not None:
                g.update(slot=(vtok.get("sc", 0), vtok["n"]),
                         op="truthy", v=None)
            guards.append(g)
            pend_cmp = None
        elif op == "jump":
            # an unconditional jump as the LAST token of a guarded range is
            # the if-branch skipping its else: the else runs under the
            # INVERSE condition, up to the jump target. Backward jumps are
            # while back-edges and invert nothing.
            if guards and at + 4 == guards[-1]["until"] \
                    and t["to"] > at and guards[-1].get("op"):
                inv = _CMP_INVERT.get(guards[-1]["op"])
                g = dict(guards[-1], until=t["to"])
                if inv:
                    g["op"] = inv
                else:
                    g.pop("op", None)
                guards[-1] = g
        elif op == "binop" and t.get("name") in _CMP_SYM:
            pend_cmp = (t["name"],
                        args[-2:] if len(args) >= 2 else list(args))
        elif op == "binop" and t.get("name") == "not":
            pend_cmp = ("falsy", args[-1:])
        elif op == "binop" and t["n"] == D._NEG:
            # unary minus on the constant just pushed -- how every negative
            # gauge bound is encoded. MS450's exhaust Vanos writes
            # `135.0 neg 40.0 neg` for -135..-40; dropping the operator left
            # min=135 max=40, an inverted range that drew no scale at all.
            if args and args[-1]["op"] == "const" \
                    and isinstance(args[-1].get("v"), (int, float)) \
                    and not isinstance(args[-1].get("v"), bool):
                args[-1] = dict(args[-1], v=-args[-1]["v"])
        elif op == "store":
            if args and args[-1]["op"] == "const" \
                    and t["n"] not in lastconst:
                lastconst[t["n"]] = args[-1]["v"]
            # A PEAK HOLD CARRIES THE RESULT WITH IT. INPA's rough-running
            # page reads each cylinder into one scratch slot and keeps the
            # high-water mark per cylinder:
            #
            #   ResultAnalog("STAT_..._ZYL1_WERT") -> var 0 sc 2
            #   if (var0 > var1) var1 = var0
            #   ...then analogout draws var1, var2, var3, var4
            #
            # The key was bound to the scratch slot only, so the four slots
            # the gauges actually draw held no result and the whole screen
            # lifted as captions with nothing under them -- which then read
            # as "not a readout" and offered to ACTIVATE the ECU instead.
            # Copying the binding across the assignment is what pairs each
            # caption with its cylinder; the slot number is the cylinder
            # number, so this cannot mismatch them the way pairing by
            # emission order would (the captions run 1,3,2,4).
            if args and args[-1]["op"] == "var":
                s_from = (args[-1].get("sc", 0), args[-1]["n"])
                s_to = (t.get("sc", 0), t["n"])
                if s_from in bind and s_to not in bind:
                    bind[s_to] = bind[s_from]
            pend_cmp = None     # `x = (a == b)` consumed the comparison
        elif op in ("call", "calluser"):
            name = t.get("name", "")
            strs = [a["v"] for a in args if a["op"] == "const" and a["t"] == "s"]
            ints = [a["v"] for a in args if a["op"] == "const" and a["t"] == "i"]
            # A slot is (scope, index). INPA reads a result into a slot with
            # ResultAnalog/Digital, then draws that slot with analogout/
            # digitalout -- often several LINEs later. Scope 2 is the screen's
            # global frame, filled once in the job-dispatch LINE at the top;
            # scope 0 is scratch, bound and drawn back-to-back. Keying on the
            # index alone made global 0 and scratch 0 the same slot.
            # analogout takes the value var plus a scale var, in either
            # order, so pick whichever slot a Result* call actually bound
            # rather than the first one pushed.
            vslots = [(a.get("sc", 0), a["n"]) for a in args if a["op"] == "var"]
            slot = next((s for s in vslots if s in bind),
                        vslots[0] if vslots else None)
            el = None
            if name in ("ftextout", "text", "textout"):
                s = strs[0] if strs else ""
                row = ints[0] if ints else None
                col = ints[1] if len(ints) > 1 else None
                if name == "text" and len(ints) >= 2:
                    row, col = ints[0], ints[1]
                if slot is not None and bind.get(slot):
                    el = {"t": "value", "key": bind[slot]}
                    if bind[slot].endswith("_EINH"):
                        el = None       # unit companion, rendered with gauge
                    elif _TEXT_KEY.match(bind[slot]) \
                            and _pairs_with_value(bind[slot], toks, ti):
                        # ...and _TEXT is the CAPTION companion: INPA reads the
                        # ECU's own description into a slot, prints it above the
                        # bar, then draws the number. One readout, not two --
                        # emitting the text as its own row gave MS450's rough-
                        # running page eight phantom lamps reading
                        # "DESCRIPTIONSTEXT" beside the six real gauges.
                        el = {"t": "caption", "key": bind[slot]}
                elif s.strip():
                    if title is None and row == 1 and name == "ftextout":
                        title = s.strip()
                    else:
                        el = {"t": "text", "s": s}
                if el is not None:
                    if row is not None:
                        el["row"] = row
                    if col is not None:
                        el["col"] = col
            elif name in D.JOB_CALLS:
                # INPAapiJob(sgbd, job, argument, results): both are read from
                # the positions the signature defines, so a short job name is
                # no different from a long one.
                _pos = D.arg_positions(args)
                jname = D.arg_str(_pos, D.JOB_ARG_JOB)
                if jname:
                    # the argument INPA passes. A per-position screen calls
                    # the same job once per wheel/bank/cylinder with the index
                    # as its argument (RDC: ABGLEICHWERT_LESEN "1", then "2"
                    # ...), so the SAME result keys mean a different thing in
                    # each LINE. Without the argument the screen showed 40
                    # rows of the same 8 values.
                    arg = D.arg_str(_pos, D.JOB_ARG_ARG) or None
                    if arg is not None and not arg.strip():
                        arg = None
                    cur()["jobArg"] = arg
                    # ...or a VARIABLE argument, which the menu key set before
                    # opening this screen. MS450's fifteen AIF keys share
                    # s_aif and differ only in the record index they store, so
                    # the screen is parameterised rather than fixed.
                    var_arg = arg is None and any(a["op"] == "var"
                                                  for a in args)
                    # WHICH slot feeds the variable argument: the first var
                    # pushed after the job name. That is the join point for a
                    # menu key that assembled the argument (promptArg) or
                    # stored a selector before opening this screen.
                    aslot = None
                    if var_arg and D.JOB_ARG_ARG < len(_pos):
                        # the slot IS the argument position, not "the next var
                        # after the job name"
                        arg_expr = _pos[D.JOB_ARG_ARG]
                        aslot = next((x["n"] for x in arg_expr
                                      if x["op"] == "var"
                                      and x.get("sc", 0) == 0), None)
                        if aslot is None:
                            # ...or the job takes a LOCAL that a conversion
                            # filled from the global. MS450's fifteen AIF
                            # keys each store their record index in global
                            # 55, and s_aif reads it as
                            #     var55(global) -> <conv> -> local0
                            # then passes local0. Reading only the job's own
                            # operand finds local 0, which no menu key can
                            # match, so all fifteen pointed at the same page.
                            loc = next((x["n"] for x in arg_expr
                                        if x["op"] == "var"
                                        and x.get("sc", 0) != 0), None)
                            if loc is not None:
                                aslot = _global_behind(toks, ti, loc)
                    if all(j["name"] != jname or j.get("arg") != arg
                           for j in jobs):
                        jobs.append({"name": jname,
                                     "write": _is_write(jname),
                                     # which LINE this job feeds. A screen can
                                     # read several jobs to fill ONE page --
                                     # MS450's mixture adaptation reads seven,
                                     # one per pair of rows -- and without the
                                     # association the app cannot tell that
                                     # from a screen that pages per job, so it
                                     # drew seven copies of every row.
                                     "line": max(0, len(lines) - 1),
                                     **({"arg": arg} if arg else {}),
                                     **({"argFromMenu": True}
                                        if arg is None and var_arg else {}),
                                     **({"argSlot": aslot}
                                        if aslot is not None else {})})
            elif name in ("INPAapiResultText", "INPAapiResultAnalog",
                          "INPAapiResultDigital", "INPAapiResultInt"):
                # destination slot: kind 0 writes scratch, kind 2 writes the
                # screen's global frame (drawn by a later LINE's analogout)
                ref = next((a for a in args if a["op"] == "procref"
                            and a["kind"] in (0, 2)), None)
                key = next((s for s in strs if _RESULTISH.match(s)), None)
                if ref is not None and key:
                    bind[(2 if ref["kind"] == 2 else 0, ref["n"])] = key
            elif name == "INPAapiResultBinary":
                # reads into an IMPLICIT slot -- it names no destination, and
                # GetBinaryDataString moves the value out afterwards. LWS5's
                # coding page reads COD_DATEN this way for its seven blocks.
                pending_result = next(
                    (s for s in strs if _RESULTISH.match(s)), None)
            elif name == "hexdump":
                # hexdump(adrstr, count, row, col) draws the binary result
                # the preceding ResultBinary read -- the whole display of a
                # memory browser screen. Without it s_speicher_ausgabe
                # decoded to a caption and no data at all.
                if pending_result and len(ints) >= 2:
                    el = {"t": "hexdump", "key": pending_result,
                          "row": ints[-2], "col": ints[-1]}
            elif name == "midstr":
                # A substring assembles a DISPLAY string out of a result that
                # was read into a slot: CVM_II's coding page reads DATENBLOCK
                # and prints it eight characters at a time. The row still
                # shows that result, so the binding follows the slice --
                # without it the whole page decoded and emitted nothing.
                refs = [a for a in args if a["op"] == "procref"
                        and a["kind"] in (0, 2)]
                srcs = [(a.get("sc", 0), a["n"]) for a in args
                        if a["op"] == "var"]
                key = next((bind[s2] for s2 in srcs if s2 in bind), None)
                if refs and key:
                    dst = (2 if refs[0]["kind"] == 2 else 0, refs[0]["n"])
                    bind[dst] = key
            elif name == "formatnum":
                # (src, dst): a number formatted for display. The row still
                # shows that result -- MS450 reads STAT_AUSGANG, formats it,
                # and prints the formatted copy, so without carrying the
                # binding the actuator readout has a caption and no value.
                src = next((s2 for s2 in vslots if s2 in bind), None)
                dst = next((a for a in args if a["op"] == "procref"
                            and a["kind"] in (0, 2)), None)
                if src and dst:
                    bind[(2 if dst["kind"] == 2 else 0, dst["n"])] = bind[src]
            elif name == "GetBinaryDataString":
                # (dst, src): carry the binding, or the result the preceding
                # ResultInto left pending, into the destination slot
                refs = [a for a in args if a["op"] == "procref"
                        and a["kind"] in (0, 2)]
                if len(refs) >= 2:
                    dst = (2 if refs[0]["kind"] == 2 else 0, refs[0]["n"])
                    src = (2 if refs[1]["kind"] == 2 else 0, refs[1]["n"])
                    val = bind.get(src) or pending_result
                    if val:
                        bind[dst] = val
                        pending_result = None
            elif name in ("analogout", "multianalogout"):
                key = bind.get(slot)
                el = {"t": "gauge", "key": key}
                if len(ints) >= 2:
                    el["row"], el["col"] = ints[0], ints[1]
                rng = num_args_after_coords(args)
                if len(rng) >= 2:
                    el["min"], el["max"] = rng[0], rng[1]
                # analogout carries FOUR bounds: the scale the bar spans, then
                # the band INPA draws green. MS450's rough running is
                # (0, 8, 0, 5) -- green to 5, red on to 8 -- so the threshold
                # the gauge exists to show lives in the second pair. When the
                # two pairs match (0, 2, 0, 2) the whole bar is green, which is
                # why the lambda bars beside it carry no red at all.
                if len(rng) >= 4 and (rng[2], rng[3]) != (rng[0], rng[1]):
                    el["okMin"], el["okMax"] = rng[2], rng[3]
                if strs and strs[-1]:
                    el["fmt"] = strs[-1]
                if not key:
                    el = None
            elif name == "digitalout":
                key = bind.get(slot)
                el = {"t": "lamp", "key": key}
                if len(ints) >= 2:
                    el["row"], el["col"] = ints[0], ints[1]
                if len(strs) >= 2:
                    el["on"], el["off"] = strs[-2].strip(), strs[-1].strip()
                if not key:
                    el = None
            elif op == "calluser":
                # A helper that FORMATS a result: INPA reads the value into a
                # slot, hands it to a user proc together with a destination
                # slot (LWS5 prints its test stamp as hex that way), then
                # prints the destination. The formatting is INPA's own, but
                # the row still shows that result -- carry the binding across
                # so the caption does not end up with no value.
                src = next((s for s in vslots if s in bind), None)
                dst = next((a for a in args if a["op"] == "procref"
                            and a["kind"] in (0, 2)), None)
                if src and dst:
                    bind[(2 if dst["kind"] == 2 else 0, dst["n"])] = bind[src]
                # A LABELLED field: INPA hands the helper the caption and the
                # result name together, then the position. MS450's SGBD-Info
                # is seven of these -- ("Steuergerät:", "ECU", 6, 5). Which
                # argument is which is read from POSITION: a helper called
                # with two leading strings captions the second, one with a
                # single string names the key with it. No length floor, so
                # the three-letter "ECU" row survives.
                # ...decided by POSITION: argument 0 is the key when the
                # helper takes one string, and the caption when it takes two
                # (then argument 1 is the key). Test the positions themselves
                # -- `len(strs) >= 2` counts strings anywhere in the frame,
                # including a trailing on/off pair, and mistook a one-string
                # gauge call for a labelled one.
                lab = None
                _p = D.arg_positions(args)
                a0, a1 = D.arg_str(_p, 0), D.arg_str(_p, 1)
                if a0 is not None and a1 is not None and len(ints) >= 2:
                    lab = a0.strip().rstrip(":").strip() or None
                    key = a1
                else:
                    key = a0
                if key and len(ints) >= 2:
                    el = {"t": "value" if lab or len(strs) < 3 else "lamp",
                          "key": key, "row": ints[0], "col": ints[1]}
                    # A HELPER CAN BE THE GAUGE ITSELF. Some SGBDs do not call
                    # analogout from the screen at all -- they wrap it in a
                    # per-ECU proc and hand the bounds to that. MS45's
                    # measurement blocks are sixteen calls to
                    # ergebnisAnalogAusgabe(key, row, col, min, max, okMin,
                    # okMax, fmt), which is a full gauge declaration: SAE
                    # J1979 passes 50..150 with a green band of 30..100. The
                    # walker took the key and the position and threw the four
                    # doubles away, so every row lifted as a bare value and
                    # the screen drew as a flat label/number list where INPA
                    # draws bars.
                    #
                    # Only when the numbers are actually there: a formatting
                    # helper with no bounds keeps its old meaning.
                    if el["t"] == "value":
                        rng = num_args_after_coords(args)
                        # ...and the bounds have to be an instrument scale.
                        # These helpers are also handed raw counter and
                        # bitfield widths -- 0..536870911 (2^29) on MSD87's
                        # NOx page, 0..42949672.95 (2^32/100) on S63 -- which
                        # are field capacities, not something a bar can show.
                        # A real INPA scale is a plain readable number.
                        if len(rng) >= 2 and abs(rng[1]) > 1e6:
                            rng = []
                        if len(rng) >= 2 and rng[0] != rng[1]:
                            el["t"] = "gauge"
                            el["min"], el["max"] = rng[0], rng[1]
                            if len(rng) >= 4 and (rng[2], rng[3]) != (rng[0], rng[1]):
                                el["okMin"], el["okMax"] = rng[2], rng[3]
                    if lab:
                        el["s"] = lab
                    else:
                        on_off = [s for s in strs if s != key]
                        if len(on_off) >= 2:
                            el["on"] = on_off[0].strip()
                            el["off"] = on_off[1].strip()
                elif src and len(ints) >= 2 and not dst:
                    # a helper that PRINTS a bound slot rather than formatting
                    # it into another: LWS5's coding page renders each data
                    # block this way, so the row's value is the bound result
                    el = {"t": "value", "key": bind[src],
                          "row": ints[0], "col": ints[1]}
            if el is not None:
                # innermost guard whose condition tests a result-bound slot
                for g in reversed(guards):
                    key = bind.get(g.get("slot")) if g.get("op") else None
                    if key:
                        el["showIf"] = {"key": key, "op": g["op"],
                                        **({"v": g["v"]}
                                           if g.get("v") is not None else {})}
                        break
                cur()["elements"].append(el)
            if name in ("analogout", "digitalout",
                        "multianalogout") or op == "calluser":
                lastconst.clear()
            args = []
            pend_cmp = None

    # Dropping the empty lines renumbers the rest, and each job carries the
    # index of the line it was read on -- so remap those too or a job points
    # at a line that no longer exists and its rows are never drawn. MS450's
    # VANOS adaptation read STATUS_MESSWERTE_VANOS on line 4 of 5; after the
    # filter the screen had three lines and four of its eight gauges vanished.
    keep = [i for i, ln in enumerate(lines) if ln["elements"] or ln["caption"]]
    renum = {old: new for new, old in enumerate(keep)}
    lines = [lines[i] for i in keep]
    for j in jobs:
        if "line" in j:
            # a job read on a line that carried nothing falls to the next
            # surviving line, which is where INPA draws what it answers
            j["line"] = renum.get(j["line"], next(
                (renum[o] for o in keep if o >= j["line"]), 0))
    out = {"title": title, "jobs": jobs, "lines": lines}
    disp = _dispatch(toks)
    if disp:
        out["dispatch"] = disp
    sk = _softkeys(lines)
    if sk:
        # {item_nr: [caption, shifted]} -- shifted keys are ITEM n+10 and are
        # pressed as Shift+Fn, which the app has to say or the key is unusable
        out["softkeys"] = {str(k): list(v) for k, v in sorted(sk.items())}
    return out


def _composite(toks):
    """An actuator menu that builds ONE ';'-joined argument for ONE job.

    INPA's actuator keys are not separate commands. Each ITEM flips variable
    slots, the menu concatenates every slot into a single argument string, and
    one job sends the lot:

        ITEM "DWA"   -> slot 67 = 0|1, slot 68 = 0|1
        arg = s65 ';' s66 ';' s67 ... ';' s78
        INPAapiJob(sgbd, "STEUERN_DIGITAL", arg, "")

    So pressing one key re-commands EVERY actuator on the ECU. The SGBD names
    the fields (RDC: 7 REQ/VAL pairs -- TST_REQ/TST_VAL, DWA_REQ/DWA_VAL ...),
    and their order is the order slots are appended here -- which is NOT the
    F-key order (RDC appends CAL sixth while it sits on F3), so the two must
    be joined by position, never assumed parallel.

    Returns {job, order:[slot], items:{slot: [slots this ITEM sets]}} or None.
    37 ECUs corpus-wide build an argument this way.
    """
    # the slot the argument string accumulates into: stored repeatedly, each
    # time from itself plus ';' plus another slot
    joins = collections.Counter()
    for i, t in enumerate(toks):
        if t["op"] != "store":
            continue
        seg = toks[max(0, i - 10):i]
        if not any(x["op"] == "const" and x.get("v") == ";" for x in seg):
            continue
        if any(x["op"] == "var" and x["n"] == t["n"] for x in seg):
            joins[t["n"]] += 1
    if not joins:
        return None
    acc, n = joins.most_common(1)[0]
    if n < 2:
        return None

    # the job it feeds, and the append order
    job = None
    for i, t in enumerate(toks):
        if t["op"] == "call" and t.get("name") in D.JOB_CALLS:
            # the call's own frame, not a fixed 8-token lookbehind: the window
            # could start mid-way through the previous call's operands
            seg = D.frame_of(toks, i)
            if any(x["op"] == "var" and x["n"] == acc for x in seg):
                nm = D.arg_str(D.arg_positions(seg), D.JOB_ARG_JOB)
                if nm:
                    job = nm
                    break
    if not job:
        return None

    order = []
    for i, t in enumerate(toks):
        if t["op"] == "store" and t["n"] == acc:
            seg = toks[max(0, i - 10):i]
            vs = [x["n"] for x in seg if x["op"] == "var" and x["n"] != acc]
            for v in vs:
                if v not in order:
                    order.append(v)
                    break

    # which slots each ITEM writes
    items, cur = {}, None
    for t in toks:
        if t["op"] == "ITEM":
            cur = t.get("nr")
            items.setdefault(cur, [])
        elif t["op"] == "store" and cur is not None and t["n"] in order:
            if t["n"] not in items[cur]:
                items[cur].append(t["n"])
    items = {k: v for k, v in items.items() if v}
    if not items:
        return None

    # Items that call the job but own no field: the COMMIT. RDC's F8 "write
    # data into ECU" sends the same assembled word as everything else -- arm
    # F1..F7, press F8 -- so it is fully decoded and must not be reported as
    # unknown just because it sets no flag of its own.
    send = []
    cur = None
    for i, t in enumerate(toks):
        if t["op"] == "ITEM":
            cur = t.get("nr")
        elif t["op"] == "call" and t.get("name") in D.JOB_CALLS \
                and cur is not None and cur not in items:
            seg = toks[max(0, i - 8):i]
            if any(x["op"] == "var" and x.get("n") == acc for x in seg):
                if cur not in send:
                    send.append(cur)

    # Every constant an ITEM writes into a field, and the value the program
    # initialises it to. INPA's own startup zeroes all of RDC's fourteen
    # slots, so the string it sends on the first keypress is the all-zero
    # word with exactly one pair flipped -- the neutral baseline is in the
    # bytecode, not a guess. Recorded per field so a consumer can see it
    # rather than assume it.
    return {"job": job, "order": order, "items": items, "send": send}


def _helper_job(toks):
    """How a FUNC runs a job: {'job': src, 'arg': src}, src=('param',n)|('const',v).

    Read from the callee's own body rather than guessed at the call site. A
    helper either hardcodes the job (GSDS2's `ansteuerung` always sends
    STEUERN_STELLGLIED and takes the actuator as a parameter) or is handed one
    (MS42's actuator keys pass their own). Both are resolved the same way:
    find INPAapiJob, split ITS frame into positional arguments, and read
    positions 1 and 2 -- the job and its argument, per the call's signature.

    A position that is a parameter is reported as ('param', n) so the caller
    can substitute the string it actually passed. Following one level of
    global store back to the param it was built from covers the common
    `global = param + ";SUFFIX"` shape.

    Corpus: 6,470 helpers hardcode the job, 359 take it as a parameter, so
    both arms are load-bearing.
    """
    for i, t in enumerate(toks):
        if t["op"] == "call" and t.get("name") in D.FSMODE_CALLS:
            # the fault-memory reader: job LAST, defaulting to FS_LESEN
            pos = D.arg_positions(D.frame_of(toks, i))
            if D.FSMODE_ARG_JOB >= len(pos):
                continue
            for x in pos[D.FSMODE_ARG_JOB]:
                if x["op"] == "var" and x.get("sc") == 2:
                    return {"job": ("param", x["n"]),
                            "default": D.FSMODE_DEFAULT_JOB}
                if x["op"] == "var" and x.get("sc") == 0:
                    # the wrappers copy each parameter into a global first
                    # (`global239 = param0; global240 = param1; ...`), so the
                    # source is the push IMMEDIATELY before that global's
                    # last store -- not the first param seen anywhere.
                    # The wrapper may also apply INPA's default BEFORE the
                    # call (`if (job == "") job = "FS_LESEN"`), so the last
                    # store to that global is a constant while the parameter
                    # copy is earlier. Keep both: the parameter is what the
                    # caller supplies, the constant is what it falls back to.
                    p = dflt = None
                    for j in range(i):
                        st = toks[j]
                        if st["op"] != "store" or st.get("sc") != 0 \
                                or st["n"] != x["n"]:
                            continue
                        prev = toks[j - 1] if j else None
                        if prev and prev["op"] == "var" \
                                and prev.get("sc") == 2:
                            p = prev["n"]
                        elif prev and prev["op"] == "const" \
                                and prev.get("t") == "s" and prev["v"]:
                            dflt = prev["v"]
                    if p is not None:
                        return {"job": ("param", p),
                                "default": dflt or D.FSMODE_DEFAULT_JOB}
                    if dflt:
                        return {"job": ("const", dflt)}
                if x["op"] == "const" and x.get("t") == "s":
                    return {"job": ("const", x["v"] or D.FSMODE_DEFAULT_JOB)}
            continue
        if not (t["op"] == "call" and t.get("name") in D.JOB_CALLS):
            continue
        pos = D.arg_positions(D.frame_of(toks, i))
        # globals assigned before this call, and the param each came from
        gsrc = {}
        for j, st in enumerate(toks[:i]):
            if st["op"] != "store":
                continue
            seg = D.frame_of(toks, j)
            p = next((x["n"] for x in seg
                      if x["op"] == "var" and x.get("sc") == 2), None)
            if p is not None:
                gsrc[(st.get("sc"), st["n"])] = ("param", p)
            else:
                lit = next((x["v"] for x in seg
                            if x["op"] == "const" and x.get("t") == "s"), None)
                if lit is not None:
                    gsrc[(st.get("sc"), st["n"])] = ("const", lit)
        out = {}
        for slot, label in ((D.JOB_ARG_JOB, "job"), (D.JOB_ARG_ARG, "arg")):
            if slot >= len(pos):
                continue
            for x in pos[slot]:
                if x["op"] == "var" and x.get("sc") == 2:
                    out[label] = ("param", x["n"])
                    break
                if x["op"] == "var" and x.get("sc") == 0:
                    r = gsrc.get((0, x["n"]))
                    if r:
                        out[label] = r
                        break
                if x["op"] == "const" and x.get("t") == "s":
                    out.setdefault(label, ("const", x["v"]))
        if out.get("job"):
            return out
    return None


def _toggle_job(body):
    """The job a state proc sends with a togglelist SELECTION, or None.

    INPA's standard actuator idiom, and the reason 274 screens across 76 ECUs
    looked like dead pages. The machine shows a list of actuator rows, the
    user picks one, and the picked row's key IS the job argument:

        togglelist(0, 0, out var20)              # builtin 0x16, see Inpa.h:39
        INPAapiJob(var13, "STEUERN_DIGITAL", var20, "")

    BMW declares it `out: string ApiToggleString`, so the ORT value is
    produced by the widget at runtime -- it is NOT in the bytecode, which is
    why no amount of argument decoding recovers it. What IS decodable is the
    contract: WHICH job the selection feeds, and that the selection is the
    whole argument. The screen's own lines carry the candidate keys (VRFT,
    ERFT ...), and the SGBD's BITS table names each one, so the app can offer
    the same list INPA does and send the row the user picks.

    Returns {"job": <name>, "argVar": <slot>} only when the job's ARGUMENT is
    exactly the variable togglelist wrote. A job that appends to it
    (var20 + ";ein") or ignores it is a different shape and is left alone --
    sending a bare ORT where INPA sends "ORT;ein" would command the wrong
    thing.
    """
    out_var = None
    for i, t in enumerate(body):
        if t["op"] == "call" and t.get("name") == "builtin_16":
            # the out parameter is the last operand pushed before the call
            for b in reversed(body[max(0, i - 4):i]):
                if b["op"] == "procref":
                    out_var = b["n"]
                    break
            continue
        if out_var is None or t["op"] != "call":
            continue
        if t.get("name") not in ("INPAapiJob", "INPAapiJobData"):
            continue
        # operands of the job call, in order: ecu, job, arg, resultfilter
        win = body[max(0, i - 6):i]
        job = next((b["v"] for b in win
                    if b["op"] == "const" and b.get("t") == "s" and b["v"]), None)
        if not job:
            continue
        # the ARGUMENT must be the togglelist variable itself, untouched
        after = [b for b in win
                 if b["op"] == "const" and b.get("t") == "s" and b["v"] == job]
        if not after:
            continue
        idx = win.index(after[0])
        rest = win[idx + 1:]
        if any(b["op"] == "binop" for b in rest):
            continue                      # var + ";ein": not a bare selection
        if not any(b["op"] == "var" and b["n"] == out_var for b in rest):
            continue
        return {"job": job, "argVar": out_var}
    return None


def _state_dispatch(body, id2name):
    """{selector token: screen name} for a state proc that switches on one var.

    INPA's third proc kind is a state machine, and its commonest shape is a
    plain dispatch chain -- ZKE5's sm_steuern is 12 arms of exactly this:

        var28 == "EIN_zv"  -> setscreen(procref 33)   # s_steuern_eingang_zv
        var28 == "EIN_fh"  -> setscreen(procref 32)   # s_steuern_eingang_fh

    The menu key stores the token and hands off; the machine turns it into a
    page. Reading the chain is what lets a key that names no job of its own
    open the screen it actually meant, instead of reporting "not decoded".

    Deliberately narrow: only `var == <string const>` compared with `eq`,
    followed by a screen procref before the next comparison. Anything else in
    the arm (a job call, arithmetic, a second variable) is left alone -- this
    resolves navigation, and a machine that DOES something is still handled by
    the job-call and _seq_jobs paths below.
    """
    out = {}
    last = None             # the string constant most recently pushed
    pending = None          # the token whose arm we are inside
    for t in body:
        if t["op"] == "const" and t.get("t") == "s":
            last = t["v"]
        elif t["op"] == "binop" and t.get("name") == "eq":
            # the string most recently pushed is the one being compared
            pending, last = last, None
        elif t["op"] == "procref" and t.get("kind") == 0x40 and pending:
            nm = id2name.get(("screen", t["n"]))
            if nm:
                out.setdefault(pending, nm)
            pending = None
    return out


def _seq_jobs(name, all_toks, id2name, seen=None):
    """Every job a STATE proc reaches, following its transitions.

    INPA's special tests are state machines, not screens. S_ABSASC (ABS/ASC
    bleeding) declares twelve state procs and the entry one calls no job at
    all -- it prints "to start programm press brake pedal" and transitions:

        ABS_ASC_G_ENTLUEFTUNG -> IDENT_LESEN -> EINGANGSTEST -> AUFFORDERN
                              -> STATUS_LESEN -> ANSTEUERN

    and the LEAF states are where the work happens (STATUS_IO_LESEN,
    STEUERN_DIGITAL). Reading a state proc's own tokens therefore found
    nothing, which is why four special tests decompiled to empty menus while
    naming their jobs plainly in the file.

    So follow the transitions. Depth is bounded by `seen` because these
    machines loop back on themselves by design (a bleeding step repeats until
    the pedal is pressed).
    """
    if seen is None:
        seen = set()
    if name in seen or name not in all_toks:
        return []
    seen.add(name)
    toks = all_toks[name]
    out = []
    for i, t in enumerate(toks):
        if t["op"] == "call" and t.get("name") in D.JOB_CALLS:
            # The job is argument 1 of the call. Reading the position also
            # removes the need to special-case D_nnnn message ids: those sit
            # in a dialog call's frame, never in INPAapiJob's job position.
            nm = D.arg_str(D.arg_positions(D.frame_of(toks, i)),
                           D.JOB_ARG_JOB)
            if nm and nm not in out:
                out.append(nm)
        # 0x43 IS AN INTERNAL STATE INDEX, NOT A PROC ID, and reading it as one
        # is what merged every machine in a file into a single reachable set.
        # A state proc declares its own steps and jumps between them by
        # ordinal: LWS5's sm_id_schreiben_lief compiles to
        #
        #     02 43 00 00   -> %Z_TOGGLE   (its own state 0)
        #     02 43 01 00   -> %Z_WEITER   (its own state 1)
        #     02 43 02 00   -> %Z_END      (its own state 2)
        #
        # Resolving 0/1/2 against the FILE's state table pointed them at
        # sm_steuern_digital, sm_Codier_Datei and sm_ps_schreiben, so every
        # "Change: ..." key reported the same two jobs even though the bodies
        # plainly differ -- one names Supplier, another Week and Year.
        #
        # A machine's steps are inside its own body, which this already walks,
        # so there is nothing further to follow. The only real cross-proc
        # transition is 0x42, which carries a genuine proc id.
        elif t["op"] == "procref" and t.get("kind") == 0x42:
            tgt = id2name.get(("state", t["n"]))
            if tgt:
                for j in _seq_jobs(tgt, all_toks, id2name, seen):
                    if j not in out:
                        out.append(j)
    return out


# the hex/int entry dialogs a "Change:" state proc opens. Each takes a run
# of caption/limit strings and commits its answer(s) into a global slot with
# a `var tmp -> store slot` right after the call. inputhex is one field,
# input2hex is two; input2hexnum/inputint round out the family.
_INPUT_DIALOGS = {
    0x41: ("inputhex", 1),      # (out, title, caption, min, max)
    0x45: ("input2hex", 2),     # (out, out, title, caption, c1, c2, mn1, mx1, mn2, mx2)
    0x44: ("input2hexnum", 2),
    0x46: ("inputint", 1),
    0x42: ("inputdigital", 1),  # (out bool, title, caption, falseStr, trueStr)
}


def _state_proc(body):
    """What a "Change: ..." / "Write ... into ECU" state proc actually does.

    These procs carry no job (the Change keys) or one write job (the final
    key), and INPA drops both without this. Every one is the same shape --
    load a global into a dialog var, open an input dialog, commit the answer
    back to the global -- so the proc is really a little form. Returns:

        {"fields": [{"slot", "title", "caption", "min", "max", "dialog"}],
         "writeSlot": N,                          # global the job arg reads
         "argOrder": [slot, slot, ...],           # the ;-joined send order
         "sep": ";"}

    "Set default values" copy pairs are NOT emitted here: they live in the
    menu ITEM's own body, and _inline_copy() reads them there.

    Only the parts present for a given proc appear. `fields` binds each
    dialog to the slot it writes by the commit `store` that follows the
    input call -- the reliable anchor, since the caption strings sit in the
    call frame just before it.
    """
    out = {"fields": []}
    # captions seen since the last frame, and the input call awaiting commit
    frame_strs = []
    pending = None                       # (dialog_name, n_outs, [captions])
    committed = 0                        # commit stores seen for `pending`

    # the argument add-chain: alternating `var slot` and separator const.
    arg_vars = []                        # slots in the order they concatenate
    arg_sep = None
    building_arg = False

    for i, t in enumerate(body):
        op = t["op"]
        if op == "frame":
            frame_strs = []
            continue
        if op == "const":
            if t.get("t") == "s":
                frame_strs.append(t["v"])
                # a separator in an add-chain of vars (";", " ")
                if building_arg and t["v"] in (";", " ", ",", "/"):
                    arg_sep = arg_sep or t["v"]
            continue
        if op == "call":
            nm = t.get("name")
            d = _INPUT_DIALOGS.get(t["n"])
            if d:
                pending = (d[0], d[1], list(frame_strs))
                committed = 0
                frame_strs = []
            elif nm in ("setstatemachine", "getinputstate"):
                pass
            else:
                pending = None           # any other call ends a form step
            building_arg = False
            arg_vars = []
            continue
        if op == "binop":
            if t.get("name") == "add":
                building_arg = True
            else:
                building_arg = False
                arg_vars = []
            continue
        if op == "var":
            # a var feeding an add-chain is part of the argument assembly
            if building_arg or not arg_vars:
                arg_vars.append(t["n"])
            continue
        if op == "store":
            slot = t["n"]
            # commit of a dialog answer: the store right after an input call
            if pending and committed < pending[1]:
                caps = pending[2]
                # inputhex: [title, caption, min, max]
                # input2hex: [title, caption, cap1, cap2, mn1, mx1, mn2, mx2]
                if pending[0] in ("input2hex", "input2hexnum"):
                    cap = caps[2 + committed] if len(caps) > 3 + committed else ""
                    mn = caps[4 + committed * 2] if len(caps) > 5 + committed * 2 else ""
                    mx = caps[5 + committed * 2] if len(caps) > 5 + committed * 2 else ""
                    title = caps[0] if caps else ""
                else:
                    title = caps[0] if caps else ""
                    cap = caps[1] if len(caps) > 1 else ""
                    mn = caps[2] if len(caps) > 2 else ""
                    mx = caps[3] if len(caps) > 3 else ""
                out["fields"].append({
                    "slot": slot, "title": title, "caption": cap,
                    "min": mn, "max": mx, "dialog": pending[0]})
                committed += 1
                if committed >= pending[1]:
                    pending = None
                continue
            # the assembled argument stored into the slot the job reads
            if building_arg and len(arg_vars) >= 2:
                if "writeSlot" not in out or arg_sep == ";":
                    out["writeSlot"] = slot
                    out["argOrder"] = list(arg_vars)
                    out["sep"] = arg_sep or ";"
                building_arg = False
                arg_vars = []
                continue
            arg_vars = []
            continue

    # nothing worth carrying if it neither prompts nor assembles. The
    # load-into-dialog-var copy (`var slot -> store tmp`) is NOT recorded as
    # a copy: it is plumbing, and only the plain read-slot -> edit-slot run
    # in the menu's own "Set default" body is a real one (_inline_copy).
    if not out["fields"] and "argOrder" not in out:
        return None
    if not out["fields"]:
        del out["fields"]
    return out


def _inline_copy(item_body):
    """A menu ITEM whose whole body is `var a -> store b` pairs, no dialog
    and no call: INPA's "Set default values" reloads the edit buffer from
    the read-back slots. Returns [[src, dst], ...] or None."""
    pairs, src = [], None
    for t in item_body:
        op = t["op"]
        if op == "var" and t.get("sc", 0) == 0:
            src = t["n"]
        elif op == "store" and src is not None and t.get("sc", 0) == 0:
            pairs.append([src, t["n"]])
            src = None
        elif op in ("call", "calluser", "binop", "const", "procref"):
            return None                  # anything else: not a plain copy
    return pairs if len(pairs) >= 2 else None


def _field_values(all_toks, order):
    """{slot: {"init": v, "values": [...]}} across the whole file."""
    out = {s: {"init": None, "values": set()} for s in order}
    for toks in all_toks:
        for i, t in enumerate(toks):
            if t["op"] != "store" or t["n"] not in out:
                continue
            prev = toks[i - 1] if i else None
            if prev and prev["op"] == "const" and prev.get("t") in ("i", "b"):
                out[t["n"]]["values"].add(prev["v"])
    return out


_INPUT_CALLS = {0x3f, 0x43, 0x44, 0x46}   # input dialogs (see D.BUILTINS)
_CONVERT_CALLS = {0x1e, 0x20}             # realtostring, inttostring


def _menu_flow(toks):
    """Per-ITEM data flow, for keys that COMPUTE something before acting.

    Two shapes fall out of one symbolic walk of each ITEM body:

    PROMPT-ASSEMBLED ARGUMENTS -- MUST_EXX m_speicher F1: input2hexnum asks
    for address and count, then the item builds
        seg_adr_anz = "LAR;" + adresse;  inttostring(anzahl, t);
        seg_adr_anz = seg_adr_anz + ";" + t
    into the global slot the shared screen passes to SPEICHER_LESEN. The
    walk keeps, per slot, the stored string as PARTS: literal strings and
    {"input": k} = the k-th answer of this item's dialog. Only a global
    slot whose parts use an answer is kept -- that is the only kind another
    proc (the screen's job) can consume.

    SELF-STEPPED COUNTERS -- MS450 m_speicher F5 "+ 10h" runs
    `addr = addr + 16`: an UNGUARDED `slot = slot +/- N`. Guards expire at
    their jump target ("- 10h" checks for borrow FIRST, then steps after
    the guard closes), so guardedness is positional, not item-wide sticky;
    the carry/borrow corrections inside the guards stay out. The delta is
    per SLOT: a browser that splits the address over byte vars steps the
    middle byte by 1 for "+100h", and the IR says exactly that.

    Returns {item_nr: {"tmpl": {global_slot: parts}, "step": {...}}}.
    """
    out = {}
    st = None
    for t in toks:
        op = t["op"]
        if op == "ITEM":
            st = {"inputs": [], "tmpl": {}, "step": None, "expr": [],
                  "refs": [], "arith": None, "bad": False, "guards": []}
            out[t.get("nr")] = st
            continue
        if st is None:
            continue
        expr, tmpl = st["expr"], st["tmpl"]
        at = t.get("at", 0)
        while st["guards"] and at >= st["guards"][-1]:
            st["guards"].pop()
        if op in ("frame", "stmt"):
            st["expr"], st["arith"], st["bad"] = [], None, False
            if op == "frame":
                st["refs"] = []
        elif op in ("jfalse", "jump"):
            if t["to"] > at:            # backward = a while edge, no guard
                st["guards"].append(t["to"])
            st["expr"], st["arith"], st["bad"] = [], None, False
        elif op == "procref":
            if t.get("kind") in (0, 2):
                st["refs"].append((t["kind"], t["n"]))
        elif op == "const":
            expr.append(t["v"] if t.get("t") == "s" else ("num", t.get("v")))
        elif op == "var":
            s = (t.get("sc", 0), t["n"])
            if s in st["inputs"]:
                expr.append({"input": st["inputs"].index(s)})
            elif s in tmpl:
                expr.extend(tmpl[s])
            else:
                expr.append(("var",) + s)
        elif op == "binop":
            nm = t.get("name")
            if nm == "sub":
                st["arith"] = "sub"
            elif nm == "add":
                if any(isinstance(p, tuple) and p[0] == "num" for p in expr):
                    st["arith"] = st["arith"] or "add"
            else:
                st["bad"] = True
        elif op == "store":
            s = (t.get("sc", 0), t["n"])
            if st["bad"]:
                pass
            elif st["step"] is None and not st["guards"] \
                    and len(expr) == 2 and expr[0] == ("var",) + s \
                    and isinstance(expr[1], tuple) and expr[1][0] == "num" \
                    and isinstance(expr[1][1], (int, float)) \
                    and not isinstance(expr[1][1], bool) \
                    and st["arith"] in ("add", "sub"):
                st["step"] = {"slot": t["n"], "sc": t.get("sc", 0),
                              "delta": expr[1][1] if st["arith"] == "add"
                              else -expr[1][1]}
            elif expr and all(isinstance(p, (str, dict)) for p in expr):
                tmpl[s] = list(expr)
            else:
                tmpl.pop(s, None)      # stored something we cannot carry
            st["expr"], st["arith"] = [], None
        elif op == "call":
            n = t["n"]
            if n in _INPUT_CALLS:
                st["inputs"].extend(r for r in st["refs"]
                                    if r not in st["inputs"])
            elif n in _CONVERT_CALLS and st["refs"]:
                # inttostring(src, dst): dst now displays src. Carrying it
                # is what lets the count answer reach the template.
                src = next((p for p in expr if isinstance(p, dict)
                            or (isinstance(p, tuple) and p[0] == "var")),
                           None)
                dst = st["refs"][-1]
                if isinstance(src, dict):
                    tmpl[dst] = [src]
                elif isinstance(src, tuple) and src[0] == "var" \
                        and src[1:] in tmpl:
                    tmpl[dst] = tmpl[src[1:]]
                else:
                    tmpl.pop(dst, None)
            else:
                # any other call may write through its ref args
                for r in st["refs"]:
                    tmpl.pop(r, None)
            st["expr"], st["refs"] = [], []
            st["arith"], st["bad"] = None, False
        elif op == "calluser":
            for r in st["refs"]:
                tmpl.pop(r, None)
            st["expr"], st["refs"] = [], []
            st["arith"], st["bad"] = None, False
    res = {}
    for nr, s in out.items():
        entry = {}
        for (sc, n), parts in s["tmpl"].items():
            if sc == 0 and any(isinstance(p, dict) for p in parts):
                entry.setdefault("tmpl", {})[n] = parts
        if s["step"] and s["step"]["sc"] == 0:
            entry["step"] = {"slot": s["step"]["slot"],
                             "delta": s["step"]["delta"]}
        if entry:
            res[nr] = entry
    return res


def _menu_ir(toks, id2name, name=None, vslot=None):
    items, cur_nr, cur_label = [], None, None
    entry = None
    last_const = None
    # the screen this menu is displayed with: the setscreen in its INIT
    # block, i.e. before the first ITEM. That screen prints the softkey
    # captions for this menu's own F-keys.
    screen = None
    ref = None
    # setitem(nr, caption, enabled) in the INIT block: INPA captions its keys
    # at runtime, conditionally, so an ITEM's inline label is often empty and
    # the real wording lives here. SZL's fault menu declares all twelve this
    # way ("Read EM", "Clear IM", "Read HM", ...) while every ITEM label is
    # "". Enabled=false means INPA greys the key until something is read.
    setitems = {}
    args = []
    for t in toks:
        if t["op"] == "ITEM":
            break
        if t["op"] == "frame":
            args = []
        elif t["op"] in ("const", "var", "procref"):
            # a screen reference here is the menu's own setscreen target;
            # it must be recorded before this branch swallows the token
            if t["op"] == "procref" and t.get("kind") == 0x40:
                ref = id2name.get(("screen", t["n"]))
            args.append(t)
        elif t["op"] == "call" and t["n"] == 0x02:
            nums = [a["v"] for a in args
                    if a["op"] == "const" and a.get("t") == "i"]
            caps = [a["v"] for a in args
                    if a["op"] == "const" and a.get("t") == "s"]
            flags = [a["v"] for a in args
                     if a["op"] == "const" and a.get("t") == "b"]
            if nums and caps and caps[0].strip():
                setitems[nums[0]] = {"label": caps[0].strip(),
                                     "enabled": bool(flags[0]) if flags
                                     else True}
            args = []
        elif t["op"] == "call":
            if t["n"] == 0x04 and ref and screen is None:
                screen = ref
            args = []
    # the setscreen awaiting its setmenu partner (see the pairing note below)
    pend_screen = None
    for ti, t in enumerate(toks):
        if t["op"] == "ITEM":
            # a pair never spans two items
            pend_screen = None
            # keep an item even when its body neither navigates nor calls a
            # named action: INPA's actuator items only flip state flags and
            # let the SCREEN send the job, so the item is real and its
            # caption comes from the screen's softkey help by F-number
            if entry is None and cur_label:
                items.append({"nr": cur_nr, "label": cur_label})
            entry = None
            cur_nr, cur_label = t.get("nr"), (t.get("label") or "").strip()
            last_const = None
        elif t["op"] == "const" and t.get("t") in ("i", "b", "s"):
            # STRINGS COUNT TOO. A state machine's selector is a TOKEN, not an
            # index: ZKE5's six Activate keys each store "EIN_fh" / "EIN_zv" /
            # "EIN_kontakt" ... into one variable and hand off to sm_steuern,
            # which compares that token and setscreen's the matching page.
            # Keeping only numeric constants dropped the token, so every one
            # of those keys reached the state proc with nothing to say which
            # page it wanted and fell through to "not decoded".
            last_const = t["v"]
        elif t["op"] == "store" and cur_label is not None \
                and last_const is not None:
            # An INDEX the key selects, which the shared screen then reads.
            # MS450's fifteen AIF keys all open s_aif and differ only in the
            # record number they store (current=0, "AIF 1"=1 ...), so without
            # it every one of them showed the same page. The screen passes
            # that slot to AIF_LESEN as its argument.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry.setdefault("_sel", (t["n"], last_const))
            last_const = None
        elif t["op"] == "procref" and t.get("kind") == 0x42 \
                and cur_label is not None:
            # a STATE machine, INPA's third proc kind after screen and menu:
            # a scripted sequence (write coding, dump to file, ROM test).
            # Recorded so the emitter can see what the sequence does -- LWS5's
            # only Coding key launches sm_Codier_Datei, which writes the
            # coding data to a .COD file on the PC and reads nothing back.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            st = id2name.get(("state", t["n"]))
            if st:
                entry["_state"] = st
        elif t["op"] == "procref" and t.get("kind") in (0x40, 0x41) \
                and cur_label is not None:
            tgt = id2name.get(("screen" if t["kind"] == 0x40 else "menu",
                               t["n"]))
            if not tgt:
                continue
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            # An item can name SEVERAL targets: INPA picks by variant at
            # runtime. DWS's F5 "Status" calls setscreen three times
            # (s_status_io2, s_status_io3, s_ident) and last-wins landed on
            # s_ident -- the same screen as F2 Ident, which is why Read status
            # and Information looked identical. Keep the FIRST, which is the
            # variant-specific screen, and record the rest.
            slot = "screen" if t["kind"] == 0x40 else "menu"
            # WHICH variants this branch serves. The alternatives above are not
            # a list INPA searches -- each one sits inside its own
            #   if (VARIANTE == "A" || VARIANTE == "B") { setmenu(X) }
            # arm, and INPA evaluates that against the VARIANTE it read at
            # startup. KOMBI's "Activate" is exactly this: 36C|39|39C|52|IKE|IKI
            # -> one menu, 46|46R -> another, 85 -> a third. Recording only the
            # targets threw the condition away, so an E46 took the first arm and
            # walked into the E38 activation pages, whose rows call jobs
            # kombi46 does not have. Keep the guard with its target.
            guard = _variant_guard(toks, ti, vslot)
            if guard:
                # several arms can name the SAME target (KOMBI's Coding key
                # sends every variant to one menu); union their conditions so
                # the guard says who really reaches it, not just the last arm
                g = entry.setdefault(slot + "For", {}).setdefault(tgt, [])
                for v in guard:
                    if v not in g:
                        g.append(v)
            # WHICH SCREEN GOES WITH WHICH MENU. A variant switch is one item
            # holding many setscreen+setmenu pairs -- GSDS2's "Valves" key has
            # six, one per gearbox -- and INPA emits each pair together:
            #   setscreen(s_ventile_834); setmenu(m_ventile_834)
            # Pairing them by that adjacency is exact. Keeping only the first
            # screen and a flat list of alternative menus lost the
            # correspondence, so every variant menu was later captioned from
            # variant #1's screen (250 items across 227 files read the wrong
            # component names).
            if slot == "screen":
                pend_screen = tgt
            else:
                if pend_screen:
                    entry.setdefault("menuScreen", {})[tgt] = pend_screen
                pend_screen = None
            if slot not in entry:
                entry[slot] = tgt
            elif entry[slot] != tgt:
                alts = entry.setdefault(slot + "Alts", [])
                if tgt not in alts:
                    alts.append(tgt)
        elif t["op"] == "call" and t.get("name") == "start" \
                and cur_label is not None:
            # launches the script's own state machine; which one is not named
            # here, so it is resolved after every proc is known
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry["_start"] = True
        elif t["op"] == "call" and t.get("name") in D.JOB_CALLS \
                and cur_label is not None:
            # an item that calls its OWN job (RDC F18 Sleep -> SLEEP_MODE):
            # an ordinary one-key-one-job action, nothing to do with any
            # composite word
            # only THIS call's arguments: a frame opens the list, so anything
            # before it belongs to an earlier call. Scanning a fixed window ran
            # past the frame and picked up the "OKAY" of the CheckJobStatus
            # that follows, making every RADIO actuator call a job named OKAY.
            seg = D.frame_of(toks, ti)
            nm = D.arg_str(D.arg_positions(seg), D.JOB_ARG_JOB)
            if nm:
                if entry is None:
                    entry = {"nr": cur_nr, "label": cur_label}
                    items.append(entry)
                entry.setdefault("job", nm)
                # ...and the ARGUMENT it sends, which is often the only thing
                # separating two keys: CDC's "Trpmode ON" and "OFF" both call
                # ENERGIESPARMODE and differ solely in "0;1;0" vs "0;0;0".
                # Without it the two keys would send the same command.
                arg = D.arg_str(D.arg_positions(seg), D.JOB_ARG_ARG)
                if arg and arg.strip():
                    entry.setdefault("jobArg", arg)
                # a menu item's job needs the same write flag a screen's
                # does. KLIMA_5B's "Comp.act" calls EEPROM_SCHREIBEN, which
                # would have fired on a keypress like any read.
                if _is_write(nm):
                    entry["writeJob"] = True
        elif t["op"] == "calluser" and cur_label is not None:
            # A key that runs a display FUNC: INPA builds some screens inside
            # functions (MS450 drives VANOS, TEV and the lambda heaters that
            # way) and reaches them with calluser rather than setscreen. The
            # name is resolved after the whole file is read, since the func may
            # be declared later.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry.setdefault("_callf", t["n"])
            # ...and the NUMBER it passes, when the func switches on it. One
            # func serves every key of an actuator screen and the argument is
            # what tells them apart -- see _dispatch.
            lo = ti
            while lo > 0 and toks[lo - 1]["op"] != "frame":
                lo -= 1
            sel = next((x["v"] for x in toks[lo:ti]
                        if x["op"] == "const" and x.get("t") == "i"), None)
            if sel is not None:
                entry.setdefault("_callsel", sel)
            # ...and the ARGUMENTS this key passes, kept POSITIONALLY. Which
            # of them is the job and which is a caption is not visible here
            # and must not be guessed from spelling: it is decided by the
            # callee's signature, which is resolved once every proc is known
            # (see _helper_job). GSDS2's "L5" key and MS42's "STEUERN_EV_1"
            # key compile to the same shape; only the helper says which
            # position it sends.
            entry.setdefault("_callargs",
                             [D.arg_str(D.arg_positions(toks[lo:ti]), k)
                              for k in range(len(D.arg_positions(toks[lo:ti])))])
        elif t["op"] == "call" and t.get("name") == "userboxftextout" \
                and cur_label is not None:
            # the item DRAWS what it read. Same separator the helper rule
            # uses: a key that logs to disk and also shows the result is a
            # read that happens to log, not an export.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry["_shows"] = True
        elif t["op"] == "call" and t["n"] == 0x7b and cur_label is not None:
            # filewrite: this key EMITS BYTES to disk itself. That separates a
            # writer from a picker -- both prompt, but a picker only chooses a
            # path and hands it to the next key (LWS5's "Choose File with
            # Coding Data" prompts and then setscreen's, never writing).
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry["_fileWrite"] = True
            entry["_file"] = True
        elif t["op"] == "call" and t["n"] == 0x79 and cur_label is not None:
            # fileopen(path, MODE) -- and the mode says which it is. "w"/"a"
            # create or append, so the key is a PC write; "r" only reads a
            # log the key is about to display, which every real fault key
            # also does after questioning the ECU.
            #
            # viewopen (0x5c) used to land here too, and it is the reason
            # 2,308 genuine ECU reads were marked fileAction: viewopen(file,
            # TITLE) DISPLAYS a file in a titled window -- LWS5's "Read error
            # memory" shows na_fs.tmp that way. It writes nothing. The
            # renderer then leaned on a caption regex to un-hide the ones
            # that "look like a fault read", which hid 535 real jobs whose
            # captions did not match (CAS m_fehler F1 runs FS_LESEN under an
            # empty label).
            mode = D.arg_str(D.arg_positions(D.frame_of(toks, ti)), 1)
            if mode and mode.strip().lower()[:1] in ("w", "a"):
                if entry is None:
                    entry = {"nr": cur_nr, "label": cur_label}
                    items.append(entry)
                entry["_file"] = True
        elif t["op"] == "call" and (t.get("name") in D.FSMODE_CALLS
                                    or t.get("name") == "INPAapiFsLesen"):
            # THE FAULT-MEMORY READER IS ECU CONTACT. It names no job and
            # goes through no helper, so an item that calls it directly and
            # then viewopen's the result looked like a bare PC viewer -- 196
            # "Read error memory" keys were flagged that way, and only the
            # renderer's caption regex kept them visible.
            if cur_label is not None:
                if entry is None:
                    entry = {"nr": cur_nr, "label": cur_label}
                    items.append(entry)
                entry["_ecuRead"] = True
        elif t["op"] == "call" and t["n"] == 0x18 and cur_label is not None:
            # printfile: spools a PC file to the printer. Unlike a plain
            # write this is the key's whole PURPOSE -- "Print error memory"
            # reads the ECU only to have something to print -- so it is
            # recorded separately from the logging that every real read does.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry["_print"] = True
            entry["_file"] = True
        elif t["op"] == "call" and t["n"] == 0x5c and cur_label is not None:
            # viewopen(file, title): DISPLAYS a file. On its own -- with no
            # job and no other work in the item -- the key is a pure PC
            # viewer ("Read protocol file"). It is only that when nothing
            # else in the item talks to the ECU, so it is recorded weakly
            # and resolved below once the whole item is known.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry["_viewOnly"] = True
        elif t["op"] == "call" and t["n"] in _INPUT_CALLS \
                and cur_label is not None:
            # an input dialog: INPA asks the user for a value and builds the
            # job argument from it. KLIMA_5B's nine flap positions all call
            # STEUERN_MOTOR_KLAPPENPOSITION but each prompts for its own
            # ("Fresh air flap", "Position (0-100 %)"), so they are not
            # interchangeable and none can be sent without the input.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            # this dialog's own strings: title, help/range, then -- for the
            # two-answer forms (input2text/input2hexnum) -- one caption per
            # answer field ("left"/"right"). Bounded by the call FRAME, not a
            # fixed window: the window used to pick up the "OKAY" of the
            # CheckJobStatus before it and drop the title.
            lo2 = ti
            while lo2 > 0 and toks[lo2 - 1]["op"] != "frame":
                lo2 -= 1
            prompts = [x["v"] for x in toks[lo2:ti]
                       if x["op"] == "const" and x.get("t") == "s"
                       and str(x["v"]).strip()]
            if prompts:
                # an item may also ask twice; keep every dialog's wording
                have = entry.setdefault("prompt", [])
                have += [p for p in prompts if p not in have]
        elif t["op"] == "call" and t["n"] in (0x0f, 0x5b) \
                and cur_label is not None:
            # THIS ITEM DRIVES INPA, NOT THE CAR -- said by the opcode:
            #   0x0f scriptchange  loads a different .IPO ("_DWS", "GS30",
            #                      "\inpa\sgdat\airbag.ipo")
            #   0x5b callwin       launches an external program; RDC's
            #                      "Change" builds "kvp_edit " + args and
            #                      hands it over
            # Matching the STRING instead used to stand in for callwin, and
            # it fired on any pool literal ending .ipo -- 50 fault-menu items
            # across asa_01/cicr/cidf and others hold a bare '.IPO' fragment
            # while they concatenate a LOG FILENAME, and were marked PC-only
            # (and so unflagged for write) on that basis. The two opcodes
            # cover 663 real launches and none of the 50.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry["appTool"] = True
        elif t["op"] == "call" and t["n"] in _ACTIONS \
                and cur_label is not None:
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            # an item's defining action is the LAST one: "Select" runs
            # start() then select(), and it is the select that names it
            if entry.get("action") in (None, "start") \
                    or _ACTIONS[t["n"]] != "start":
                entry["action"] = _ACTIONS[t["n"]]
    if entry is None and cur_label:
        items.append({"nr": cur_nr, "label": cur_label})
    # a key captioned by setitem takes that wording; the ITEM's own inline
    # label wins when it has one, since it is what INPA draws unconditionally
    for it in items:
        si = setitems.get(it.get("nr"))
        if not si:
            continue
        if not it.get("label"):
            it["label"] = si["label"]
        if not si["enabled"]:
            it["startsDisabled"] = True
    # keys declared by setitem that emit no ITEM body of their own still
    # appear in INPA's menu
    have = {it.get("nr") for it in items}
    for nr, si in sorted(setitems.items()):
        # INPA HAS F1..F20 AND NOTHING ELSE (F11-F19 are the shifted row).
        # A number outside that range did not come from a real setitem: in
        # dkg_10 and dkg_90 the 0x02 match lands on some other call whose
        # arguments are string-first, and the "keys" it invents are prose
        # ("must die Werte in den NVRAM...") and an F1000. Two menus corpus
        # wide, but one of them collided a phantom F21 onto real F1.
        if not (0 <= nr <= 20):
            continue
        if nr not in have:
            items.append({"nr": nr, "label": si["label"],
                          **({"startsDisabled": True} if not si["enabled"]
                             else {})})
    # An item that ONLY touches a file is a PC action, not an ECU one: LWS5's
    # "Read protocol file" displays na_fs_pr.tmp and "Delete Protocol file"
    # truncates it. A real fault key writes that same log AFTER reading the
    # ECU, so the flag only means "file action" once nothing else is on the
    # item -- no job, no screen, no menu.
    # A key that PROMPTS is a picker, not a log dump: it asks for a path and
    # shows what you chose, and the menu's next key sends it to the ECU.
    #
    # A key that re-installs THIS menu is staying put, which is how INPA
    # returns from an action -- it is not navigation. MS450's fault menu ends
    # with "save all faults to a file", "insert comment" and a needle-printer
    # export; all three write on the PC, name no job, and set their own menu
    # back, so requiring no screen/menu at all left them looking like ECU
    # functions.
    for it in items:
        printed = it.pop("_print", None)
        wrote = it.pop("_fileWrite", None)
        # popped for EVERY item, not just the ones that reach the decision:
        # an item that exits early below would otherwise carry the marker
        # into the shipped IR
        ecuread = it.pop("_ecuRead", None)
        shows = it.get("_shows")
        viewonly = it.pop("_viewOnly", None)
        if viewonly and not it.get("_file") and not it.get("job") \
                and not it.get("_callf") and not it.get("_state") \
                and not ecuread and not it.get("action"):
            # nothing but a viewer: it shows a file and never asks the ECU
            it["_file"] = True
        if not it.pop("_file", None):
            continue
        # A key that PROMPTS is normally a picker -- but not when it writes
        # the file itself. ACSM3's "Fehlerspeicher speichern" asks for a
        # filename and then filewrite's the memory into it; 842 such keys
        # (all of them German, where no caption rule caught them) were
        # showing as runnable ECU functions.
        if it.get("prompt") and not wrote:
            continue
        # "stays put" covers both shapes INPA uses to return from a PC
        # action: re-installing THIS menu, or jumping back to the root. MS450's
        # ident menu writes the ident data to a file and returns to m_main.
        stays = (it.get("menu") == name
                 and (it.get("screen") is None or screen is None
                      or it.get("screen") == screen)) \
            or (it.get("menu") == "m_main" and name != "m_main")
        # A KEY THAT ALSO NAMES A JOB IS AN ECU FUNCTION. Nearly every real
        # fault read appends its result to INPA's log (fileopen "a"), so the
        # file evidence alone cannot separate LWS5's "Read error memory"
        # from a pure export -- but the job can, and it is exactly the
        # evidence the file rules lack. The keys that ARE exports and still
        # question the ECU (MS450's "save all faults to a file") are caught
        # by the helper rule above, which sees that the helper's whole
        # purpose is filewrite.
        asked = ecuread or it.get("job") or (shows and wrote)
        if (printed or not asked) and not it.get("action") \
                and (stays or not any(it.get(k)
                                      for k in ("screen", "menu"))):
            it["fileAction"] = True
            if printed:
                # so the app can say WHY it is a PC action, instead of
                # re-deriving it from the caption
                it["printAction"] = True
    # what each key COMPUTES: dialog-assembled argument templates and
    # self-stepped counters (resolved against the target screen's job by
    # build(), which knows both sides)
    flow = _menu_flow(toks)
    for it in items:
        f = flow.get(it.get("nr"))
        if not f:
            continue
        if f.get("tmpl"):
            it["_tmpl"] = f["tmpl"]
        if f.get("step"):
            it["step"] = f["step"]
    # INPA lays its softkeys out by number, so the menu reads in F-key order
    # rather than in the order the bytecode happens to declare them
    items.sort(key=lambda x: (x.get("nr") is None, x.get("nr") or 0))
    out = {"items": items}
    if screen:
        out["screen"] = screen
    return out


# ---- INPA's OTHER gauge dialect -------------------------------------------
#
# analogout declares a bar outright, and the walker above turns it into
# {"t": "gauge", min, max}. But INPA also draws bars from a screen that only
# PRINTS -- caption, "[unit]", the key, then four doubles -- which lifts as
# {"t": "value"} with no unit and no range. BMS46's "analog values 1" is the
# whole screen in that dialect: on the car INPA fills it with labelled bars,
# and the app drew a bare label/value list, because irIsCard sends a screen
# whose rows are all plain values to the identity renderer.
#
# tools/ipo_gauges.py already mines that dialect (505 KB, 268 ECUs, 3955
# readouts). This joins it back onto the IR, which is the ONE source the app
# reads for a screen -- the older ecu._layout.gaugeSpecs route died with the
# "IR is the only source" refactor and nothing has written _layout since.
#
# A ZERO-WIDTH RANGE IS A 0..1 SCALE. INPA declares some readouts with all
# four bounds identical -- lambda-integrator as (80,80,80,80), the mixture
# adaptations as (10,10) and (40,40) -- and still draws a normal bar with a
# 0..1 axis. Photographed on a real car: integrator 1.00 and multiplicative
# 1.00 sit FULL while additive 0.26 sits at about a quarter. Only 0..1
# predicts all three; on the 0..80 the bytes appear to say they would be
# slivers of 1-3%. They are normalised factors -- the SGBD calls the first
# "Lambdaregelfaktor" -- which is why one scale fits regardless of the unit
# printed beside them.
#
# These were held back at first for a good reason: the numbers look like
# maximums, and reading (80,80) as "0..80" would have drawn Short Term Fuel
# Trim, centred on zero and going negative, against a floor of 0. The car
# is what settles it, not the bytes.
#
# STILL NOT PROMOTED:
#   * descending (96). ipo_gauges flags min > max, the signature of a range
#     whose floor is really negative: the bytes say 45.0 for a -45 °C floor
#     and nothing distinguishes them. Guessing the sign would draw a bar that
#     is confidently wrong, which is worse than the number alone.
# It keeps its unit if one was mined: a unit is a fact even when the range
# is not usable.
_GAUGES_JSON = os.path.join(L1.OUT, "_gauges.json")
_GAUGES_CACHE = None


def _mined_gauges(ecu):
    """{result key -> mined gauge} for one ECU, or {} when none was mined."""
    global _GAUGES_CACHE
    if _GAUGES_CACHE is None:
        try:
            with open(_GAUGES_JSON, encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = {}
        # CASE-FOLDED. _gauges.json is keyed as INPA names the ECU (BMS46),
        # and the corpus walk builds from the .IPO stem, which is whatever
        # casing BMW shipped -- 763 files are *.IPO and 1025 *.ipo. Keying on
        # the raw name matched when run as `ipo_ir.py BMS46` and missed every
        # ECU under --write, which is a silent no-op across the whole corpus.
        _GAUGES_CACHE = {k.lower(): v for k, v in raw.items()}
    out = {}
    for g in _GAUGES_CACHE.get((ecu or "").lower(), []):
        key = g.get("key") or ""
        # mined entries are keyed by the JOB (STATUS_MOTORDREHZAHL); the IR's
        # elements carry the RESULT it fills (STAT_MOTORDREHZAHL_WERT)
        if key.startswith("STATUS_"):
            out[f"STAT_{key[len('STATUS_'):]}_WERT"] = g
        out[key] = g
    return out


def _apply_mined_gauges(ir, ecu):
    """Promote printed readouts to gauges where INPA declared a real range."""
    mined = _mined_gauges(ecu)
    if not mined:
        return 0
    n = 0
    for scr in ir.get("screens", {}).values():
        for ln in scr.get("lines", []):
            for el in ln.get("elements", []):
                if el.get("t") != "value":
                    continue
                g = mined.get(el.get("key"))
                if not g:
                    continue
                if not el.get("unit") and g.get("unit"):
                    el["unit"] = g["unit"]
                lo, hi = g.get("min"), g.get("max")
                if (el.get("min") is None and el.get("max") is None
                        and lo is not None and hi is not None
                        and not g.get("descending")):
                    el["t"] = "gauge"
                    el["gaugeSource"] = "mined"
                    if lo == hi:
                        # A DEGENERATE DECLARATION IS A SYMMETRIC -N..+N SCALE.
                        # INPA passes ONE number four times when the scale is
                        # centred on zero, and draws it as -N..+N.
                        #
                        # Photographed on a car, MS42's "patrol adaption" page
                        # declares (80,80,80,80) / (130,130,130,130) /
                        # (50,50,50,50) and INPA labels those axes -80..80,
                        # -130..130 and -50..50. The clincher is the "!" on
                        # that page: INPA marks a reading that falls OUTSIDE
                        # the scale, and it prints "!-131.07" on the -130..130
                        # row. -131.07 is only out of range if the floor is
                        # -130, so the negative half of the axis is real.
                        #
                        # This first shipped as 0..1, from three readings on
                        # BMS46's analog-3 page where the values happened to
                        # sit near 1.0. That fit those three and nothing else;
                        # MS42 is the counter-example. Mixture adaptation,
                        # lambda integrators and trims are all signed
                        # corrections, so a floor of 0 hides exactly the half
                        # of the range that says the ECU is compensating
                        # downwards.
                        el["min"], el["max"] = -abs(lo), abs(lo)
                        el["gaugeSource"] = "mined-symmetric"
                    else:
                        el["min"], el["max"] = lo, hi
                    n += 1
    return n


def build(ecu):
    data, ps, pool, decls = D.load(ecu)
    if ps is None or len(decls) < 3:
        return None
    id2name = {}
    for off, typ, name, pid in decls:
        id2name[(typ, pid)] = name
    # NO `language` FIELD. It was written by a vote over German marker words
    # and read by nothing -- and the vote was wrong on 298 ECUs, calling
    # German files English (MS450's captions really are "Fehlerspeicher
    # lesen"; it scored 3.8% against a 6% threshold). There is no language
    # declaration anywhere in the .IPO, and neither umlaut rate nor function
    # words separate the corpus: BMW ships ASCII fallbacks, and some ECUs
    # keep their German in result tables rather than the pool. Translation
    # runs off the per-ECU maps in data/inpa-i18n instead, which are exact.
    ir = {"ir": IR_VERSION, "ecu": ecu, "menus": {}, "screens": {}}
    cov_unk = cov_len = 0
    # every proc's tokens, kept so a composite menu can look up what the
    # program initialises its argument fields to
    all_toks = {}
    spans = []
    for k, (off, typ, name, pid) in enumerate(decls):
        lo = off + 1 + len(name) + 1 + 4 + 1
        hi = decls[k + 1][0] if k + 1 < len(decls) else ps
        toks, unk, ln = D.walk(data, lo, hi, pool)
        all_toks[name] = toks
        spans.append((typ, name, pid, unk, ln))
    # WHICH GLOBAL HOLDS THE VARIANT, decided before any menu is read:
    # inpainit is often declared after the menus that test it, so this needs
    # every proc walked first.
    vslot = _variant_slot(all_toks)
    for typ, name, pid, unk, ln in spans:
        toks = all_toks[name]
        cov_unk += unk
        cov_len += ln
        if typ == "screen" or (typ == "func" and _is_display_func(toks)):
            # INPA also builds screens inside FUNCTIONS. MS450 drives its VANOS,
            # E-fan, TEV and lambda-heater actuators from procs like
            # vanos_in_ansteuer, which run the job and draw its results with
            # exactly the vocabulary a screen uses -- but declared `func`, so
            # nothing mined them and their readouts were invisible. The
            # hand-built layout captured them; this is the last thing it had
            # that the decompiler did not.
            scr = _screen_ir(toks)
            scr["id"] = pid
            if typ == "func":
                scr["fromFunc"] = True
            ir["screens"][name] = scr
        elif typ == "menu":
            m = _menu_ir(toks, id2name, name, vslot)
            comp = _composite(toks)
            if comp:
                # slot -> its index in the argument string. The SGBD's
                # _ARGUMENTS list is positional, so index i is argument i --
                # names get attached by the app, which can read the SGBD.
                pos = {s: i for i, s in enumerate(comp["order"])}
                m["composite"] = {
                    "job": comp["job"],
                    "fields": len(comp["order"]),
                    # each F-key's argument INDEXES, in argument order.
                    # RDC: F1 -> [0,1] (TST_REQ/TST_VAL), F3 -> [10,11]
                    # (CAL_REQ/CAL_VAL) even though it sits third on screen --
                    # append order is NOT F-key order, so this must be joined
                    # positionally and never assumed parallel.
                    "items": {str(k): sorted(pos[s] for s in v)
                              for k, v in comp["items"].items()},
                    # F-keys that send the assembled word without owning a
                    # field (RDC F8 "write data into ECU"): the commit
                    "send": [str(x) for x in comp.get("send") or []],
                }
                m["_comp_order"] = comp["order"]
            ir["menus"][name] = m
    # The baseline word a composite job is sent with. INPA's own startup
    # initialises every argument field, so the string it sends on the FIRST
    # keypress is that initial word with exactly one pair flipped. RDC's
    # __inpa_startup__ zeroes all fourteen slots, which makes
    # "0;0;0;0;0;0;0;0;0;0;0;0;0;0" the neutral command -- decoded, not
    # assumed. `values` records every constant each field is ever assigned,
    # so a field INPA only ever writes 0 to (RDC's CAL_VAL: F3 requests
    # calibration and leaves the value unused) is visible as such.
    for mname, menu in ir["menus"].items():
        order = menu.pop("_comp_order", None)
        if not order or "composite" not in menu:
            continue
        init = {}
        for pname, toks in all_toks.items():
            if not pname.startswith("__inpa"):
                continue
            for i, t in enumerate(toks):
                if t["op"] == "store" and t["n"] in order:
                    prev = toks[i - 1] if i else None
                    if prev and prev["op"] == "const" \
                            and prev.get("t") in ("i", "b"):
                        init.setdefault(t["n"], prev["v"])
        seen = _field_values(list(all_toks.values()), order)
        if len(init) == len(order):
            menu["composite"]["baseline"] = \
                ";".join(str(init[s]) for s in order)
        menu["composite"]["values"] = [
            sorted(seen[s]["values"]) for s in order]
    # A menu's items take their caption from the screen that menu drives,
    # joined by F-number. INPA's actuator menus carry only fragments
    # ("DWA", "button", "plant") because the screen prints the real list as
    # softkey help ("< F2 >  DWA output"); the ITEM number IS the F-key, so
    # the two sides join exactly. Only fills gaps -- a menu item that already
    # says more than the softkey keeps its own wording.
    # Resolve the display FUNCs menu keys invoke. A func-screen is only worth
    # keeping if some key opens it: INPA has plenty of helpers that draw
    # nothing a user reaches. Anything left unreferenced is dropped, so this
    # cannot fill the IR with procs no menu points at.
    funcid = {}
    for off, typ, name, pid in decls:
        if typ == "func" and name in ir["screens"]:
            funcid[pid] = name
    # EVERY func by id, not just the ones that draw: a helper that only fires
    # a job (GSDS2's `ansteuerung`) is not a screen, so it is absent from
    # funcid, and its callers had nowhere to resolve their job from.
    allfunc = {pid: name for off, typ, name, pid in decls if typ == "func"}
    sigs = {}
    # A helper that SPOOLS ITS RESULT TO DISK makes the key that calls it a
    # PC action, not an ECU function: MS450's OutputError2File reads the
    # fault memory only to write it out, and its key's own body contains no
    # file call at all -- the evidence lives entirely in the callee. Keyed on
    # filewrite, the call that actually emits bytes; fileclose alone also
    # appears in keys that merely log what they displayed.
    fwrite = set()
    for pid, name in allfunc.items():
        body = all_toks.get(name) or []
        sig = _helper_job(body)
        if sig:
            sigs[pid] = sig
        # ...but only when the helper never SHOWS what it wrote. Both kinds
        # read the ECU, so ECU contact cannot separate them: E53's
        # fs_is_lesen reads the fault memory, draws it with userboxftextout
        # AND logs it (a read that happens to log), while MS450's
        # OutputError2File draws nothing -- it exists to spool the bytes to
        # disk. Drawing is the difference.
        names = {t.get("name") for t in body if t["op"] == "call"}
        if "filewrite" in names and "userboxftextout" not in names:
            fwrite.add(pid)
    used = set()
    for menu in ir["menus"].values():
        for it in menu["items"]:
            fid = it.pop("_callf", None)
            sel = it.pop("_callsel", None)
            cargs = it.pop("_callargs", None)
            # THE CALLEE DECIDES WHAT THE KEY SENDS. Substituting the strings
            # this key passed into the helper's signature is what turns
            # `calluser(…, "L5")` into a real job+argument -- previously the
            # job was guessed by string shape, which silently dropped every
            # short name (L5, L6, UIF, VDM).
            sig = sigs.get(fid) if fid is not None else None
            if sig and "job" not in it:
                def _val(src):
                    if src is None:
                        return None
                    kind, v = src
                    if kind == "const":
                        return v
                    return cargs[v] if cargs and v < len(cargs) else None
                jb = _val(sig.get("job")) or sig.get("default")
                if jb:
                    it["job"] = jb
                    it["_viaHelper"] = True
                    # ...unless the CALLER draws the result. E65's F1 hands
                    # the fetch to read_fs_lesen (which logs without drawing)
                    # and then shows it with userboxftextout -- the pair is a
                    # read, and only the caller can see that.
                    if fid in fwrite and not it.get("_shows"):
                        it["fileAction"] = True
                    ja = _val(sig.get("arg"))
                    if ja:
                        it["jobArg"] = ja
                    if _is_write(jb):
                        it["writeJob"] = True

            # a marker for the audit above, not part of the schema: the
            # renderer only needs to know the item HAS a job, not which
            # bytecode shape it arrived in
            it.pop("_viaFunc", None)
            if fid is None or it.get("screen"):
                continue
            nm = funcid.get(fid)
            if not nm:
                continue
            # The func switches on the number this key passes, so the key both
            # RUNS a job and opens the func's screen: INPA fires the actuator
            # and then draws that actuator's own readout underneath. MS450's
            # E-box fan menu is three such keys (on / off / return to DME)
            # plus the screen's own status poll; resolving them to the screen
            # ALONE made every key draw the same status page without firing.
            disp = (ir["screens"].get(nm) or {}).get("dispatch") or {}
            hit = None
            if sel is not None:
                hit = disp.get(str(sel)) or disp.get("*")
            if hit:
                it["job"] = hit["job"]
                if hit.get("argFromKey"):
                    it["arg"] = str(sel)
                elif hit.get("arg") is not None:
                    it["arg"] = hit["arg"]
                if _is_write(hit["job"]):
                    it["writeJob"] = True
            it["screen"] = nm
            used.add(nm)
    # A file key whose job arrived from a helper: writing the fault memory to
    # disk reads it first, so the job is real but the KEY is still a PC
    # action -- MS450's "save all faults to a file" and "insert comment" are
    # exactly this, and listing them beside the five real fault reads made
    # INPA's own chrome look like ECU functions.
    for menu in ir["menus"].values():
        for it in menu["items"]:
            it.pop("_viaHelper", None)
            it.pop("_shows", None)
    # PROMPT-ASSEMBLED JOB ARGUMENTS, resolved now that both sides exist:
    # the menu key holds the template (_menu_flow) and the screen's job
    # names the global slot its variable argument reads (argSlot). When they
    # meet, the item carries everything a renderer needs to actually SEND
    # the job -- the dialog answers spliced into the template -- instead of
    # listing a prompt it refuses to act on.
    for menu in ir["menus"].values():
        for it in menu["items"]:
            tmpl = it.pop("_tmpl", None)
            if not tmpl:
                continue
            scr = ir["screens"].get(it.get("screen"))
            slot = None
            for j in (scr or {}).get("jobs", []):
                if j.get("argSlot") in tmpl:
                    slot = j["argSlot"]
                    break
            if slot is None and it.get("job") and not it.get("jobArg") \
                    and len(tmpl) == 1:
                # the item's own job call took the assembled variable
                slot = next(iter(tmpl))
            if slot is not None:
                it["promptArg"] = {"slot": slot, "template": tmpl[slot]}
    # ...but only prune when the file HAS menus. BMW's helper scripts
    # (RDC_RD, AFS_READ, S_SZL_W and 16 more) declare NO menu and NO screen
    # proc at all: their single display func IS the whole UI, driven by the
    # script body rather than opened by a key. Pruning "unreferenced" func-
    # screens there deleted the only screen those 19 ECUs had, so they built
    # empty and --write silently skipped them, shipping stale IR forever.
    if ir["menus"]:
        for nm, scr in list(ir["screens"].items()):
            if scr.get("fromFunc") and nm not in used:
                del ir["screens"][nm]

    # The machine `start` launches: the first state proc the file declares.
    # ...the FIRST one, by declaration id: INPA runs the machine the file
    # opens with, and the later states are the steps it transitions into.
    _states = sorted((i, n) for (k, i), n in id2name.items() if k == "state")
    state_entry = _states[0][1] if _states else None

    # A key that launches a STATE machine which only writes a file is still a
    # PC action: LWS5's single Coding key runs sm_Codier_Datei, whose whole
    # body is "prompt for a path, open it 'w', write the coding data" -- INPA
    # offers no coding readout for this ECU at all. Resolved here because the
    # evidence is in the state proc, not in the menu item.
    # slot -> the caption/limits the proc that EDITS it declared, gathered
    # across every state proc in the file. The write proc names its argument
    # slots but not what they mean; the Change proc that fills each slot does.
    slot_field = {}
    for body in all_toks.values():
        form = _state_proc(body)
        for f in (form or {}).get("fields", []):
            slot_field.setdefault(f["slot"], f)

    # per-menu, per-item "Set default" copies: those live in the menu ITEM
    # body itself, not a state proc, so they are sliced out here by nr.
    inline_copies = {}                   # menu_name -> {nr: [[src, dst], ...]}
    for menu_name, toks in all_toks.items():
        if not any(t["op"] == "ITEM" for t in toks):
            continue
        cur, start = None, None
        by_nr = {}
        for i, t in enumerate(toks):
            if t["op"] == "ITEM":
                if cur is not None:
                    cp = _inline_copy(toks[start:i])
                    if cp:
                        by_nr[cur] = cp
                cur, start = t.get("nr"), i + 1
        if cur is not None:
            cp = _inline_copy(toks[start:])
            if cp:
                by_nr[cur] = cp
        if by_nr:
            inline_copies[menu_name] = by_nr

    for menu_name, menu in ir["menus"].items():
        copies = inline_copies.get(menu_name, {})
        for it in menu["items"]:
            # "Set default values": the copy lives in the item body, not a
            # state proc, so it is applied whether or not the item has _state.
            cp = copies.get(it.get("nr"))
            if cp and "job" not in it:
                it["stateCopy"] = cp
            st = it.pop("_state", None)
            if not st or st not in all_toks:
                # _sel is dropped only when nothing can USE it. A key with no
                # state proc can still be a record selector: MS450's fifteen
                # AIF keys each store their index in global 55 and setscreen
                # s_aif, whose AIF_LESEN reads that same global. Discarding
                # _sel unconditionally left all fifteen on record 0 -- one
                # page, fifteen times. 6,699 keys across 404 ECUs carry one.
                sel0 = it.get("_sel")
                slot = sel0[0] if isinstance(sel0, (tuple, list)) else None
                scr0 = ir["screens"].get(it.get("screen")) if slot is not None \
                    else None
                if not (scr0 and any(j.get("argSlot") == slot
                                     for j in scr0.get("jobs", []))):
                    it.pop("_sel", None)
                continue
            body = all_toks[st]
            # A KEY THAT ONLY PICKS A PAGE. Before asking what the machine
            # DOES, ask where it GOES: ZKE5's Activate keys store a token
            # ("EIN_zv") and hand off to sm_steuern, which compares it and
            # setscreen's the matching page. Resolving that turns six keys
            # that reported "not decoded" into the actuator screens they
            # always meant -- the screens were decompiled all along
            # (s_steuern_eingang_zv holds ten named locks), nothing linked
            # to them. Navigation only: the arm must do nothing but choose
            # a screen, so this can never fire a job on its own.
            sel = it.pop("_sel", None)
            if sel is not None and "screen" not in it:
                tok = sel[1] if isinstance(sel, tuple) else sel
                if isinstance(tok, str):
                    tgt = _state_dispatch(body, id2name).get(tok)
                    if tgt:
                        it["screen"] = tgt
                        # ...and if that page is a togglelist PICKER, record
                        # the job its selection feeds. The rows are already
                        # in the screen; without the job they are a dead list.
                        tj = _toggle_job(body)
                        scr = ir["screens"].get(tgt)
                        if tj and scr is not None and not scr.get("jobs"):
                            scr["pickJob"] = tj["job"]
                        continue
            calls = {t["n"] for t in body if t["op"] == "call"}
            named = {t.get("name") for t in body if t["op"] == "call"}
            # Same two corrections as the per-item rule above: viewopen
            # (0x5c) DISPLAYS a file rather than writing one, and the
            # fault-memory reader is ECU contact even though it is not a
            # job call. Writing here means filewrite/printfile or a
            # fileopen -- and the state proc only counts as a PC action if
            # it never questions the ECU at all.
            writes = bool(calls & {0x79, 0x7b, 0x18})
            # ...and, as with the helper rule, questioning the ECU does not
            # make it an ECU function when the answer only goes to disk.
            # LWS5's sm_Codier_Datei reads the coding with INPAapiJob and
            # writes it to a .COD file, drawing nothing -- so gating on
            # "never asks the ECU" left it unflagged and m_code's only key
            # looked like a live coding function.
            shows = "userboxftextout" in named
            asks = shows and (bool(calls & {0x62, 0x6f})
                              or bool(named & (D.FSMODE_CALLS
                                               | {"INPAapiFsLesen"}))
                              or bool(named & D.JOB_CALLS))
            if writes and not asks:
                it["fileAction"] = True     # writes a file, never asks the ECU
                continue
            form = _state_proc(body)
            # ...but a state machine that CALLS A JOB is a real ECU function,
            # and the job is the only evidence of what the key does: LWS5's
            # "Write Data into ECU" runs CODIERUNG_SCHREIBEN_DATEI, and its
            # Ident equivalent runs IDENT_SCHREIBEN. Surfaced so the key is not
            # mistaken for a dead one -- and flagged write, because every one
            # of these is a permanent EEPROM change behind INPA's own
            # "Only for the developer" title.
            for i, t in enumerate(body):
                if t["op"] != "call" or t["n"] not in (0x62, 0x6f):
                    continue
                # 0x62/0x6f are the state machine's job calls: the job is
                # argument 1, bounded by the call's frame rather than an
                # 8-token guess at where its operands began.
                _p = D.arg_positions(D.frame_of(body, i))
                nm = D.arg_str(_p, D.JOB_ARG_JOB)
                if nm:
                    it.setdefault("job", nm)
                    # AND THE ARGUMENT, which this loop never read. Every
                    # other job path in this file reads slot 2 (lines 393,
                    # 645, 2217); here only the NAME was taken, so the item
                    # was marked "argument not decoded" without anyone
                    # looking. Read it, but only when the slot is a decidable
                    # CONSTANT -- a `var` or a `binop` there means the value
                    # is assembled at runtime from a previous read or a
                    # dialog, and THAT is the case the refusal exists for.
                    _slot = _p[D.JOB_ARG_ARG] if D.JOB_ARG_ARG < len(_p) else []
                    runtime = any(a["op"] in ("var", "binop") for a in _slot)
                    ag = None if runtime else D.arg_str(_p, D.JOB_ARG_ARG)
                    # `is not None`, NOT truthiness: an EMPTY argument is a
                    # real, decoded answer (the job takes none), and 166 of
                    # these items pass exactly that. Testing falsiness is
                    # what would keep them hidden.
                    if ag is not None:
                        it["jobArg"] = ag
                    else:
                        it["stateJob"] = True
                    if _is_write(nm):
                        it["writeJob"] = True
                    break
            # THE ARGUMENT THE WRITE ASSEMBLES, spelled out. The proc joins
            # the edit-buffer slots with ";" in a fixed order and hands that
            # to the job. Each slot is named by the Change proc that fills it
            # (slot_field), so the write key becomes a real form: every field
            # editable, the exact argument shown, still never sent (the app's
            # write policy holds -- writeJob stays set).
            if form and form.get("argOrder"):
                fields = [dict(slot_field.get(s, {"slot": s}), slot=s)
                          for s in form["argOrder"]]
                it["stateForm"] = {"fields": fields, "sep": form.get("sep", ";")}
            # ...and when the state proc calls no job ITSELF, follow where it
            # goes. INPA's special tests are built this way: S_ABSASC's entry
            # state prints "press brake pedal" and transitions through
            # IDENT_LESEN, EINGANGSTEST, STATUS_LESEN and ANSTEUERN, which are
            # the states that actually talk to the car. Reading one proc's own
            # tokens found nothing, so four special tests decompiled to menus
            # of dead keys while naming their jobs plainly in the file.
            if "job" not in it:
                reached = _seq_jobs(st, all_toks, id2name)
                if reached:
                    it["job"] = reached[0]
                    it["stateJob"] = True
                    # the whole sequence, so the app can say what the test
                    # actually does rather than showing one job of many
                    it["stateJobs"] = reached
                    if any(_is_write(j) for j in reached):
                        it["writeJob"] = True
            # A "Change: ..." key: no job of its own, it only edits the
            # buffer the write key later sends. INPA drops these entirely,
            # which is why they read as "not decoded". Emit the one field
            # (or two) it edits so the key opens its dialog and stages a
            # value -- exactly what INPA does, minus the send.
            if "job" not in it and form and form.get("fields"):
                it["stateEdit"] = {"fields": form["fields"]}

    # EVERY TOGGLELIST PICKER, however its page was reached. The pass above
    # only sees screens a string-dispatch chain named; most pickers are
    # reached by a plain setscreen elsewhere in the same machine. So walk the
    # state procs once more and attach the job to EVERY screen they display,
    # which is what makes 274 picker pages across 76 ECUs live rather than 13.
    for _st, _body in all_toks.items():
        tj = _toggle_job(_body)
        if not tj:
            continue
        for _t in _body:
            if _t["op"] != "procref" or _t.get("kind") != 0x40:
                continue
            _nm = id2name.get(("screen", _t["n"]))
            _scr = ir["screens"].get(_nm) if _nm else None
            if _scr is None or _scr.get("jobs") or _scr.get("pickJob"):
                continue
            # only a PICKER: rows that offer a key and read nothing back
            _ls = _scr.get("lines") or []
            _pick = [l for l in _ls if l.get("keys") and not (l.get("elements") or [])]
            if len(_pick) >= 2 and len(_pick) == len([l for l in _ls if l.get("keys")]):
                _scr["pickJob"] = tj["job"]

    # A KEY THAT CALLS `start` LAUNCHES THE SCRIPT'S OWN MACHINE. INPA's
    # special tests (ABS/ASC bleeding, RDC antenna check) are whole programs
    # rather than an ECU's menu: the key names no state at all, it calls the
    # builtin `start`, and the machine that runs is the one the file declares.
    # So the entry state is the first one declared, and its reachable jobs are
    # what the key does.
    if state_entry:
        reached = _seq_jobs(state_entry, all_toks, id2name)
        if reached:
            for menu in ir["menus"].values():
                for it in menu["items"]:
                    if it.get("job") or not it.get("_start"):
                        continue
                    it["job"] = reached[0]
                    it["stateJob"] = True
                    it["stateJobs"] = reached
                    if any(_is_write(j) for j in reached):
                        it["writeJob"] = True
    for menu in ir["menus"].values():
        for it in menu["items"]:
            it.pop("_start", None)

    # A SCRIPT THAT IS ONLY A STATE MACHINE. RDC's antenna check and telegram
    # recording have no launch key at all -- their menu holds an EXIT and an
    # acknowledgement, because INPA runs the machine as soon as the script
    # opens. There is no item to hang the jobs on, so record them on the
    # script itself.
    if state_entry:
        reached = _seq_jobs(state_entry, all_toks, id2name)
        named = any(it.get("job")
                    for m in ir["menus"].values() for it in m["items"])
        if reached and not named:
            ir["sequence"] = {"entry": state_entry, "jobs": reached}
    # Which screen a menu is drawn in: the key that installs the menu sets the
    # screen in the same breath (KOMBI F6 Activate -> m_steuern_46 + s_steuern),
    # so the pairing is the item's own, not a guess from the name. Without it
    # the join below never ran for KOMBI and its actuator keys kept INPA's
    # fragments ("SII oil", "hi.beam") instead of the screen's own help text.
    # Each menu's own screen, taken from the setscreen/setmenu pair that
    # installed it (menuScreen). That pairing is emitted by the compiler, so
    # there is nothing to choose between and no scoring to get wrong.
    drawn_in = {}
    for m in ir["menus"].values():
        for it in m["items"]:
            paired = it.get("menuScreen") or {}
            for mt in [it.get("menu")] + (it.get("menuAlts") or []):
                if not mt:
                    continue
                own = paired.get(mt)
                if own:
                    drawn_in.setdefault(mt, []).insert(0, own)
                elif it.get("screen"):
                    # a key that sets a menu without its own screen keeps the
                    # item's single target
                    drawn_in.setdefault(mt, []).append(it["screen"])
    for mname, menu in ir["menus"].items():
        target = menu.get("screen")
        if not target:
            # the paired screen when there is one; otherwise the only
            # candidate. No "best guess" among several -- a menu drawn by an
            # unrelated variant's screen takes that variant's captions.
            cands = drawn_in.get(mname) or []
            target = cands[0] if cands else None
        if not target or target not in ir["screens"]:
            continue
        sk = ir["screens"][target].get("softkeys") or {}
        for it in menu["items"]:
            hit = sk.get(str(it.get("nr")))
            if not hit:
                continue
            cap, shifted = hit
            # A SHIFTED key's caption always wins: the ITEM label of a shifted
            # key is the cramped half of a pair (SM46's ITEM 13 says "ankle -"
            # where INPA prints "inclination -", the partner of F3's
            # "inclination +"), and it is the only place the real wording
            # exists. For a plain key the longer of the two still wins --
            # making the softkey win outright there changed 237 captions and
            # exposed an off-by-one join on GSDS2, which is its own bug.
            if shifted or len(cap) > len(it.get("label") or ""):
                # INPA uses BOTH captions: the long one in the screen body,
                # the ITEM's own short one on the F-key bar ("Ansteuerung
                # Einlass mit 15 %" over a button reading "E 15%"). Keep the
                # short form so the bar can say something a 9-key row fits --
                # truncating the long caption gave nine buttons all reading
                # "Activat...".
                short = (it.get("label") or "").strip()
                if short and short != cap and len(short) < len(cap):
                    it["short"] = short
                it["label"] = cap
            # how the key is actually pressed, so the app can say so
            if shifted:
                it["shift"] = True
    # A shifted key whose caption INPA never printed: the pairing is still
    # ITEM n+10, so an item numbered 11..19 sitting beside its partner at n is
    # the shifted half whether or not any help text said so. AFS_70's "AIF 9"
    # is ITEM 11 against "AIF 1" at 1; ABSASC5 has "cut off v 2" at 16 against
    # "cut off v 1" at 6. Without this both land on the same key in the same
    # row -- 141 menus collided that way.
    for menu in ir["menus"].values():
        nrs = {it.get("nr") for it in menu["items"]}
        for it in menu["items"]:
            n = it.get("nr")
            if it.get("shift") or not isinstance(n, int):
                continue
            if 11 <= n <= 19 and (n - 10) in nrs:
                it["shift"] = True
    # Every caption this ECU displays, gathered once. The renderer used to
    # translate at draw time -- 24 call sites, the same string re-resolved on
    # every repaint -- which also meant a per-ECU correction had nowhere to
    # live. tools/ipo_i18n.js fills this in from the shared vocabulary plus
    # data/inpa-i18n/<ECU>.json, and the interpreter then just looks up.
    strings = set()
    for menu in ir["menus"].values():
        for it in menu["items"]:
            if it.get("label"):
                strings.add(it["label"])
    for scr in ir["screens"].values():
        if scr.get("title"):
            strings.add(scr["title"])
        for ln in scr.get("lines", []):
            if ln.get("caption"):
                strings.add(ln["caption"])
            for e in ln.get("elements", []):
                for k in ("s", "unit", "on", "off"):
                    if e.get(k):
                        strings.add(e[k])
    ir["strings"] = sorted(strings)
    ir["coverage"] = round(100 * (1 - cov_unk / cov_len), 1) if cov_len else 0
    # THE SCRIPT'S OWN SHUTDOWN JOB. INPA declares an `inpaexit` proc and
    # runs it when the script ends, however it ends -- it is not a menu key
    # and has no caption. 877 ECUs declare one and 58 send a real job from
    # it, almost always DIAGNOSE_ENDE (CARB sends DIAGNOSTICEND, ekp360
    # steuern_ret_contr_to_ecu). Without this the app never ended the
    # diagnostic session and the ECU sat in it until its own timeout.
    #
    # Read from the proc, NOT from the Back/Exit keys that also carry it:
    # those keys are captioned as plain navigation and sit beside keys whose
    # jobs DRIVE OUTPUTS (STEUERN_CFL behind "Deselect"), so picking them out
    # by caption would risk firing an actuator on the way out.
    exit_toks = all_toks.get("inpaexit") or []
    for i, t in enumerate(exit_toks):
        if t["op"] != "call" or t.get("name") not in (
                D.JOB_CALLS | {"INP1apiJob"}):
            continue
        jb = D.arg_str(D.arg_positions(D.frame_of(exit_toks, i)),
                       D.JOB_ARG_JOB)
        if jb:
            ir["exitJob"] = jb
            break
    # An .IPO can ship several root menus, one per ECU variant. INPA does not
    # guess from the SGBD filename: inpainit runs INITIALISIERUNG, reads its
    # VARIANTE result, and compares that against a chain of names --
    #   VARIANTE == "KOMBI31" -> setmenu(m_main_31_32_34)
    #   VARIANTE == "KOMBI46" -> setmenu(m_main_36_38_39_46_52_85)
    # Taking the first declared root gave an E46 the E31/E32/E34 menu, which
    # has no Status or Memory key at all. Recorded so the app can ask the ECU
    # the same question; `variantJob`/`variantKey` say how.
    variants, vjob, vkey = {}, None, None
    for pname, toks in all_toks.items():
        if not pname.startswith(("inpainit", "__inpa")):
            continue
        for i, t in enumerate(toks):
            if t["op"] == "call" and t.get("name") in D.JOB_CALLS:
                nm = D.arg_str(D.arg_positions(D.frame_of(toks, i)),
                               D.JOB_ARG_JOB)
                if nm and vjob is None:
                    vjob = nm
            if t["op"] == "call" and t["n"] == 0x71 and vkey is None:
                # the result whose value the variant is compared against.
                # The read takes its destination ref(s) first and the KEY in
                # the position straight after them -- this form passes two
                # refs, so a fixed index 1 would land on the second ref.
                _p = D.arg_positions(D.frame_of(toks, i))
                _k = 0
                while _k < len(_p) and _p[_k][-1]["op"] == "procref":
                    _k += 1
                vkey = D.arg_str(_p, _k)
            if t["op"] != "procref" or t.get("kind") != 0x41:
                continue
            mname = id2name.get(("menu", t["n"]))
            if not mname or not mname.startswith("m_main"):
                continue
            # the name compared immediately before the branch. A result key
            # (STAT_*, _EIN) is a different comparison that happens to sit
            # nearby, not a variant name.
            for x in reversed(toks[max(0, i - 14):i]):
                v = str(x.get("v", ""))
                if x["op"] != "const" or x.get("t") != "s":
                    continue
                if not re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", v):
                    continue
                if re.match(r"^(STAT|ID|AIF|F)_", v) or v.endswith("_EIN"):
                    break
                variants.setdefault(mname, [])
                if v not in variants[mname]:
                    variants[mname].append(v)
                break
    if len(variants) > 1:
        ir["rootVariants"] = variants
        if vjob:
            ir["variantJob"] = vjob
        if vkey:
            ir["variantKey"] = vkey

    ir["entry"] = {
        "screen": "s_main" if "s_main" in ir["screens"]
        else next(iter(ir["screens"]), None),
        "menu": "m_main" if "m_main" in ir["menus"]
        else next(iter(ir["menus"]), None),
    }
    # last, so it sees every screen the walk produced
    _apply_mined_gauges(ir, ecu)
    return ir


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]

    if "--check" in sys.argv:
        fails = []
        g = build("GSDS2")
        ana = g["screens"]["s_ana2_834"]
        gk = [e["key"] for ln in ana["lines"] for e in ln["elements"]
              if e["t"] == "gauge"]
        if len(gk) != 7 or "STAT_UBAT_WERT" not in gk:
            fails.append(f"GSDS2 s_ana2_834 gauges drifted: {gk}")
        st = [i for i in g["menus"]["m_status"]["items"]
              if re.match(r"^Analog( values)? ?2$", i.get("label") or "")]
        if not st or "screen" not in st[0]:
            fails.append("GSDS2 m_status Analog2 lost its screen target")
        # ...and it is a SHIFTED key: INPA prints it as <Shift> + < F7 >, i.e.
        # ITEM 17. Labelling it "F17" would name a key that does not exist.
        if not st or not st[0].get("shift"):
            fails.append("GSDS2 Analog values 2 should be a shifted key")

        # builtin 64 is a result read like its 63/66/67 neighbours (5026 sites
        # in 411 files), and INPA may pass the value through a FORMATTING
        # helper before printing it -- LWS5 prints its test stamp as hex that
        # way. Unmapped, or with the binding dropped at the helper, those rows
        # kept their captions and showed no value at all.
        lw = build("LWS5")
        for name, want in (("s_ps_lesen", 3), ("s_hd_lesen", 4)):
            ks = [e["key"] for ln in lw["screens"][name]["lines"]
                  for e in ln["elements"] if e.get("key")]
            if len(ks) != want:
                fails.append(f"LWS5 {name}: {len(ks)} values, want {want}")

        # INPA builds some screens inside FUNCTIONS. MS450 drives its VANOS,
        # E-fan, TEV and lambda heaters from procs like vanos_in_ansteuer,
        # which run the job and draw the result with a screen's own vocabulary
        # but are declared `func` -- so nothing mined them and their actuator
        # readouts were invisible. The hand-built layout had them; this was the
        # last thing it had that the decompiler did not.
        v = build("MS450")
        vs = v["screens"].get("vanos_in_ansteuer") or {}
        vk = [e["key"] for ln in vs.get("lines", []) for e in ln["elements"]
              if e.get("key")]
        if "STAT_AUSGANG" not in vk:
            fails.append(f"MS450 VANOS readout lost its value: {vk}")
        if not vs.get("fromFunc"):
            fails.append("MS450 VANOS screen should be flagged fromFunc")
        # every func-screen kept must be opened by some key: unreferenced
        # helpers are dropped rather than left as procs nothing reaches
        named = {i.get("screen") for m in v["menus"].values()
                 for i in m["items"] if i.get("screen")}
        orphan = [n for n, sc in v["screens"].items()
                  if sc.get("fromFunc") and n not in named]
        if orphan:
            fails.append(f"MS450 func screens nothing opens: {orphan}")

        # A SUBSTRING assembles a display string from a result read into a
        # slot: CVM_II's coding page reads DATENBLOCK and prints it eight
        # characters at a time, AFS_60 slices a qualifier byte into Bit 0..7.
        # builtin 25 is the most-used call in the corpus (9434 sites, 553
        # files) and was unmapped, so those screens decoded to nothing.
        c2 = build("CVM_II")["screens"]["s_code"]
        ck = [e["key"] for ln in c2["lines"] for e in ln["elements"]
              if e.get("key")]
        if "DATENBLOCK" not in ck:
            fails.append(f"CVM_II coding lost its data block: {ck}")
        q = build("AFS_60")["screens"]["s_qualifier_1"]
        qk = [e["key"] for ln in q["lines"] for e in ln["elements"]
              if e.get("key")]
        if len(qk) != 8:
            fails.append(f"AFS_60 qualifier should slice 8 bits, got {len(qk)}")

        # BMW ships mixed-case and two-letter RESULT names -- BMBT46TN reads
        # "Dimmerstellung", others "ECU"/"TYP"/"EINSCHALTZAEHLER_FKT2a" -- and
        # the all-caps job-name pattern rejected them, so those rows kept their
        # caption and unit and showed no value at all. 107 of 7357 result reads
        # corpus-wide. Job names keep the strict pattern: widening it there
        # would let a bare argument like "FM" pass for a job.
        b = build("BMBT46TN")["screens"]["s_status_steuergeraet"]
        bk = [e["key"] for ln in b["lines"] for e in ln["elements"]
              if e.get("key")]
        if "Dimmerstellung" not in bk:
            fails.append(f"BMBT46TN lost its mixed-case result: {bk}")

        # A result read into the screen's GLOBAL frame (procref kind 2) and
        # drawn many LINEs later must still reach its gauge. KOMBI's tank line
        # dispatches three jobs at the top of the screen, then draws the values
        # further down -- binding by index alone (ignoring scope) left the
        # whole line captioned but valueless.
        k = build("KOMBI")["screens"]["s_status_analog_46"]
        tank = next((ln for ln in k["lines"]
                     if (ln["caption"] or "").startswith("tank")), None)
        tk = [e["key"] for e in (tank or {}).get("elements", [])
              if e["t"] == "gauge"]
        if len(tk) != 3 or "STAT_TANKINHALT_WERT" not in tk:
            fails.append(f"KOMBI global-slot gauges lost: {tk}")
        r = build("RDC")
        wj = [j for s in r["screens"].values() for j in s["jobs"] if j["write"]]
        rj = [j for s in r["screens"].values() for j in s["jobs"]]

        # RDC's actuator menu: one job, 14 fields = 7 REQ/VAL pairs. The
        # append order is NOT the F-key order -- "calibrate" sits on F3 but
        # its pair is appended sixth -- so a parallel assumption would send
        # every actuator command to the wrong actuator. Verified against the
        # SGBD's own _ARGUMENTS: F1->TST, F2->DWA, F3->CAL, F4->BM, F5->AER,
        # F6->ERK, F7->ANT.
        comp = (r["menus"].get("m_steuern") or {}).get("composite")
        if not comp:
            fails.append("RDC m_steuern lost its composite argument decode")
        else:
            if comp["job"] != "STEUERN_DIGITAL" or comp["fields"] != 14:
                fails.append(f"RDC composite drifted: {comp['job']} "
                             f"{comp['fields']} fields")
            want = {"1": [0, 1], "2": [2, 3], "3": [10, 11], "4": [4, 5],
                    "5": [6, 7], "6": [8, 9], "7": [12, 13]}
            if comp["items"] != want:
                fails.append(f"RDC composite pairing wrong: {comp['items']}")
            for k, v in comp["items"].items():
                if len(v) != 2 or v[1] != v[0] + 1:
                    fails.append(f"RDC F{k} is not a REQ/VAL pair: {v}")
            # INPA's startup zeroes every field, so its neutral word is
            # all-zero and a keypress is that word with one pair flipped.
            # This is read from __inpa_startup__, not assumed.
            if comp.get("baseline") != ";".join(["0"] * 14):
                fails.append(f"RDC baseline drifted: {comp.get('baseline')!r}")
            vals = comp.get("values") or []
            if not all(set(v) <= {0, 1} for v in vals):
                fails.append(f"RDC composite fields are not binary: {vals}")
            # CAL_VAL (index 11) is only ever 0: F3 requests calibration and
            # leaves the value unused. A change here means the decode shifted.
            if len(vals) != 14 or vals[11] != [0]:
                fails.append(f"RDC CAL_VAL should be [0], got "
                             f"{vals[11] if len(vals) > 11 else None}")
            # F8 "write data into ECU" sends the assembled word without
            # owning a field -- it is the COMMIT, not an undecoded key.
            # It was reported as "not decoded" purely because the decoder
            # only recorded items that WRITE fields.
            if "8" not in (comp.get("send") or []):
                fails.append("RDC F8 (commit) lost from composite.send")
        # F18 Sleep calls its own job: an ordinary one-key-one-job action,
        # also once mislabelled "not decoded"
        sleep = next((i for i in (r["menus"].get("m_steuern") or {})["items"]
                      if i.get("nr") == 18), None)
        if not sleep or sleep.get("job") != "SLEEP_MODE":
            fails.append(f"RDC F18 should call SLEEP_MODE, got {sleep}")

        # THE CONTROL-FLOW LAYER, against BMW's own source. MUST_EXX ships
        # with its .SRC: m_speicher F1 prompts for address+count and builds
        # "LAR;<adresse>;<anzahl>" into the slot s_speicher_ausgabe sends to
        # SPEICHER_LESEN; the screen shows JOB_STATUS only on failure and
        # the hexdump only on OKAY. All three decoded, or the renderer is
        # back to "listed but never sent".
        mu = build("MUST_EXX")
        f1 = next((i for i in mu["menus"]["m_speicher"]["items"]
                   if i.get("nr") == 1), None)
        pa = (f1 or {}).get("promptArg") or {}
        if pa.get("template") != ["LAR;", {"input": 0}, ";", {"input": 1}]:
            fails.append(f"MUST_EXX F1 promptArg drifted: {pa}")
        sj = mu["screens"]["s_speicher_ausgabe"]["jobs"]
        if not sj or sj[0]["name"] != "SPEICHER_LESEN" \
                or sj[0].get("argSlot") != pa.get("slot"):
            fails.append(f"MUST_EXX SPEICHER_LESEN argSlot broke: {sj}")
        els = [e for ln in mu["screens"]["s_speicher_ausgabe"]["lines"]
               for e in ln["elements"]]
        hx = next((e for e in els if e["t"] == "hexdump"), None)
        if not hx or hx.get("key") != "DATEN" \
                or hx.get("showIf") != {"key": "JOB_STATUS", "op": "==",
                                        "v": "OKAY"}:
            fails.append(f"MUST_EXX hexdump/showIf drifted: {hx}")
        if not any(e.get("showIf") == {"key": "JOB_STATUS", "op": "!=",
                                       "v": "OKAY"} for e in els):
            fails.append("MUST_EXX JOB_STATUS failure row lost its showIf")
        # ...and MS450's memory browser steps its address bytes from the
        # menu: +/-10h on the low byte, +/-100h carried on the middle one
        ms = build("MS450")
        steps = {i.get("nr"): i.get("step")
                 for i in ms["menus"]["m_speicher"]["items"]}
        if steps.get(5) != {"slot": 97, "delta": 16} \
                or steps.get(6) != {"slot": 97, "delta": -16} \
                or steps.get(7) != {"slot": 96, "delta": 1} \
                or steps.get(8) != {"slot": 96, "delta": -1}:
            fails.append(f"MS450 address stepping drifted: {steps}")
        print(f"  ir         MUST_EXX F1 sends {sj and sj[0]['name']} = "
              f"'LAR;<input0>;<input1>' (slot {pa.get('slot')}), "
              f"hexdump gated on JOB_STATUS")

        # A root item may name several screens (INPA picks by variant).
        # Last-wins put DWS's F5 "Status" on s_ident -- the same screen as F2
        # Ident -- so Read status and Information rendered identically.
        d = build("DWS")
        droot = d["menus"][d["entry"]["menu"]]["items"]
        f5 = next((i for i in droot if i.get("nr") == 5), None)
        if not f5 or f5.get("screen") != "s_status_io2":
            fails.append(f"DWS F5 Status should open s_status_io2, got "
                         f"{f5 and f5.get('screen')}")
        if not f5 or "s_ident" not in (f5.get("screenAlts") or []):
            fails.append("DWS F5 lost its variant alternatives")
        print(f"  ir         DWS F5 Status -> {f5 and f5.get('screen')} "
              f"(+{len((f5 or {}).get('screenAlts') or [])} variants), "
              f"distinct from F2 Ident")
        print(f"  ir         GSDS2 {len(g['screens'])} screens "
              f"({len(gk)}/7 ana gauges), RDC {len(r['screens'])} screens, "
              f"{len(wj)} write-flagged of {len(rj)} jobs")
        if comp:
            print(f"  ir         RDC composite {comp['job']}: "
                  f"{comp['fields']} fields = {len(comp['items'])} REQ/VAL "
                  f"pairs, argument order != F-key order (checked)")
            print(f"  ir         RDC baseline {comp.get('baseline')!r} "
                  f"(from INPA's own startup init)")
        # ...and whether the SHIPPED data was built by this code at all. The
        # checks above all run against a fresh in-memory build, so they pass
        # happily while data/inpa-ir on disk is a day stale.
        drift = check_stamp()
        if drift:
            fails.append(drift)
        if fails:
            for f in fails:
                print("   -", f)
            return 1
        print("  ir         OK")
        return 0

    if args:
        ir = build(args[0])
        print(json.dumps(ir, ensure_ascii=False, indent=1))
        return 0

    if "--write" in sys.argv:
        os.makedirs(OUT_DIR, exist_ok=True)
        n = scr = el = 0
        failed = []
        lost = []
        # CASE-INSENSITIVE ON PURPOSE. BMW shipped SGDAT with both spellings
        # -- 763 files are *.IPO and 1025 are *.ipo -- and globbing "*.IPO" on
        # a case-sensitive filesystem silently lifted only the first group.
        # That is why 82 ECUs (E89's whole set among them) had no IR and fell
        # back to the token-built menu: not because they were unliftable, but
        # because the corpus walk never saw their file. Dedupe by lowered stem
        # so a directory holding both FOO.IPO and foo.ipo builds once.
        seen = set()
        paths = []
        for p in sorted(glob.glob(os.path.join(L1.SGDAT, "*"))):
            if not p.lower().endswith(".ipo"):
                continue
            stem = os.path.basename(p)[:-4]
            if stem.lower() in seen:
                continue
            seen.add(stem.lower())
            paths.append(p)
        for p in paths:
            ecu = os.path.basename(p)[:-4]
            try:
                ir = build(ecu)
            except Exception as e:          # noqa: BLE001
                # A crash here is a DECODER bug, not a quirk of the file, and
                # swallowing it silently hid an UnboundLocalError that cost 11
                # ECUs their whole UI. Keep going -- one bad file must not stop
                # the corpus -- but say so.
                failed.append(f"{ecu}: {type(e).__name__}: {e}")
                continue
            if not ir or not ir["screens"]:
                # An empty build is silently skipped -- but when an IR for
                # this stem ALREADY EXISTS, skipping ships the stale file and
                # hides a decoder regression: the fromFunc prune emptied 19
                # menu-less scripts this way and nothing said a word. Say so.
                stale = [q for q in (os.path.join(OUT_DIR, ecu + ".json"),
                                     os.path.join(OUT_DIR, ecu + ".json.gz"))
                         if os.path.exists(q)]
                if stale:
                    lost.append(ecu)
                continue
            with open(os.path.join(OUT_DIR, ecu + ".json"), "w",
                      encoding="utf-8") as f:
                json.dump(ir, f, ensure_ascii=False)
            n += 1
            scr += len(ir["screens"])
            el += sum(len(ln["elements"]) for s in ir["screens"].values()
                      for ln in s["lines"])
        write_stamp()
        print(f"wrote {n} IR files -> {os.path.relpath(OUT_DIR)} "
              f"({scr} screens, {el} elements)")
        if failed:
            print(f"  FAILED  {len(failed)} ECUs did not build:")
            for f in failed[:8]:
                print(f"    {f}")
        if lost:
            print(f"  WARNING {len(lost)} ECUs previously had IR but now "
                  f"build ZERO screens (stale file NOT overwritten):")
            for e in lost:
                print(f"    {e}")
        return 0

    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
