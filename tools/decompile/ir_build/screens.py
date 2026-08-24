"""Screens, derived by executing each one -- what it drew, and its dialogs.

The static miner infers a screen's contents from its token stream; the VM runs
it and records what it drew. Every screen is run TWICE: against a healthy host
for the lines/jobs/dialogs it shows on success, and against a failing host for
the error arm -- the boxes INPA pops when a job fails, which inference never
captured because it never took the branch. A screen is derived from the state
inpainit leaves behind (LSZ's lamp words live in a string array inpainit
builds), cloned per screen so one cannot leak into the next.
"""

import re

import ipo_vm as V

from . import vmpool
from .hosts import OkHost, FailHost
from .jobclass import is_write

# the VM's gauge-band names -> the renderer's (okMin/okMax = the green band)
_RENAME = {"warnLo": "okMin", "warnHi": "okMax"}

# INPA prints its own softkey help as screen text: "< F4 >  Error memory".
# Many menu keys carry an EMPTY item label and are captioned only here; the
# key a caption belongs to joins back by its F-number.
_SOFTKEY = re.compile(r"^<\s*(?:(Shift)\s*>\s*\+\s*<\s*)?F(\d+)\s*>\s+(.{2,44})$")

# INPA's own chrome, printed in the softkey bar -- a closed set it ships, not a
# guess about meaning. These are never a menu key's real caption.
_SK_CHROME = re.compile(r"^(Print(\s*screen)?|Back|Exit|End|Ende|Zur(ü|ue)ck|"
                        r"Select|Deselect|Auswahl|Abwahl|Druck(en)?|"
                        r"Bildschirmdruck|Change\s+Editor|Gesamt)$", re.I)


def _lines(raw):
    """The VM's lines in the renderer's vocabulary (caption, not label)."""
    out = []
    for ln in raw:
        els = [{_RENAME.get(k, k): v for k, v in e.items() if v is not None}
               for e in (ln.get("elements") or [])]
        if not els and not ln.get("label"):
            continue
        d = {"elements": els}
        if ln.get("label"):
            d["caption"] = ln["label"]
        out.append(d)
    return out


def _base(key):
    """A result key without its role suffix, so a value and its unit match.

    STAT_TMOT_WERT and STAT_TMOT_EINH share the base STAT_TMOT; ID_SW_NR_WERT
    and ID_SW_NR_EINH share ID_SW_NR. Only the display suffixes are stripped --
    two different readings never collide because their stems differ.
    """
    u = key.upper()
    for suf in ("_WERT", "_EINH", "_TEXT", "_EINHEIT"):
        if u.endswith(suf):
            return key[: -len(suf)]
    return key


def _pair_units(lines, reads):
    """Fold read-but-undrawn result keys back in, the way INPA displays them.

    A reading's unit (STAT_..._EINH) is read into a slot and shown beside the
    value, never drawn on a line of its own -- so a draw-only pass loses it.
    Every key the script read is real (inpax counts them all); here each unit
    is attached to the value element it belongs to as `unit`, and any other
    read that reached no element is appended as a value so the reading is not
    silently dropped.
    """
    drawn = {}                       # base name -> the value element drawing it
    have = set()                     # every key already on a line
    for ln in lines:
        for el in ln.get("elements", []):
            k = el.get("key")
            if not k:
                continue
            have.add(k)
            drawn.setdefault(_base(k), el)

    extra = []
    for k in reads:
        if k in have:
            continue
        have.add(k)
        if k.upper().endswith(("_EINH", "_EINHEIT")):
            host = drawn.get(_base(k))
            if host is not None:
                host["unit"] = k       # the value now names its own unit
                continue
        extra.append({"key": k})       # a read that reached no draw of its own
    if extra:
        lines.append({"elements": extra})
    return lines


def _jobs(emissions):
    """The jobs a screen ran, deduped, with the permanent-write flag."""
    seen, out = set(), []
    for j in emissions.jobs:
        name = j.get("job")
        if not name:
            continue
        key = (name, j.get("arg") or "")
        if key in seen:
            continue
        seen.add(key)
        d = {"name": name}
        if j.get("arg"):
            d["arg"] = j["arg"]
        if is_write(name):
            d["write"] = True
        out.append(d)
    return out


def _dialogs(emissions):
    """Message boxes with a title, deduped-preserving-order."""
    return [m for m in emissions.messages if m.get("title")]


def _softkeys(toks):
    """{nr: [caption, shifted]} from a screen proc's softkey-help strings.

    The executed render draws only the taken branch, so a "< F4 > Error memory"
    on a variant-gated arm is never seen at runtime -- yet the string constant
    is in the proc whichever way the branch went. Scanning every string the
    proc holds harvests all of them across all branches. The shifted partner of
    a plain key is ITEM n+10 (INPA prints it "<Shift> + < F4 >"), so a shifted
    caption joins to nr+10, a plain one to nr. First wins on a repeat.
    """
    out = {}
    for t in toks:
        if t.get("op") != "const" or t.get("t") != "s":
            continue
        s = str(t.get("v", "")).strip()
        if not _SOFTKEY.match(s):
            continue
        # one line may print two keys ("< F3 > -1  < F4 > +1"); split on each
        # marker so a key takes only its own tail, not its neighbour's wording.
        parts = re.split(r"<\s*((?:Shift\s*>\s*\+\s*<\s*)?)F\s*(\d+)\s*>", s)
        for i in range(1, len(parts) - 2, 3):
            shifted = bool(parts[i])
            cap = parts[i + 2].strip()
            if len(cap) < 2 or _SK_CHROME.match(cap):
                continue
            nr = int(parts[i + 1]) + (10 if shifted else 0)
            out.setdefault(str(nr), [cap, shifted])
    return out


def _one_screen(proto, name, base_ok, base_fail, budget):
    """Derive a single screen, or None if it draws and says nothing."""
    try:
        ok = vmpool.fresh(proto, OkHost(), base_ok, budget).run(name)
        fail = vmpool.fresh(proto, FailHost(), base_fail, budget).run(name)
    except Exception:                                          # noqa: BLE001
        return None

    lines = _pair_units(_lines(ok.lines), ok.reads)
    ok_msgs = _dialogs(ok)
    seen = {(m.get("title"), m.get("body")) for m in ok_msgs}
    err_msgs = [m for m in _dialogs(fail)
                if (m.get("title"), m.get("body")) not in seen]
    # most error arms PRINT rather than pop a box; ship the fail-arm lines when
    # they differ so a live failure draws what INPA would have drawn
    err_lines = _lines(fail.lines)
    if err_lines == lines:
        err_lines = None

    if not lines and not ok_msgs and not err_msgs:
        return None                       # executed nothing worth shipping

    scr = {"lines": lines, "jobs": _jobs(ok)}
    if ok.title:
        scr["title"] = ok.title
    if ok_msgs:
        scr["messages"] = ok_msgs
    if err_msgs:
        scr["errorMessages"] = err_msgs
    if err_lines:
        scr["errorLines"] = err_lines
    return scr


def state_entry_screens(proto, budget=20000):
    """{state proc -> the picker screen it opens}.

    A menu key that enters a state machine (ZKE5's "Remote control lock
    system") has no screen of its own; the machine's INIT setscreen's the
    picker and yields at the togglelist. Running the machine finds that screen
    directly. Non-picker machines (event loops) park on none and are skipped;
    menus.py links only those whose screen carries a pickJob.
    """
    out = {}
    for (_off, typ, name, _pid) in proto.decls:
        if typ != "state":
            continue
        try:
            em = vmpool.fresh(proto, OkHost(), budget=budget).run(name)
        except Exception:                                     # noqa: BLE001
            continue
        if em.screen:
            out[name] = em.screen
    return out


def _picker_jobs(proto, budget):
    """{screen -> togglelist job} for screens a picker machine parks on.

    A togglelist machine (builtin_16 + a job whose whole arg is the selection)
    opens a picker screen and yields; that screen must carry the job so the app
    can offer the actuator list. Both the screen and the job come from running
    the machine -- V._toggle_job reads the contract, the run finds the screen.
    """
    out = {}
    for (_off, typ, name, _pid) in proto.decls:
        if typ != "state":
            continue
        tj = V._toggle_job(proto.procs.get(name) or [])
        if not tj:
            continue
        try:
            em = vmpool.fresh(proto, OkHost(), budget=budget).run(name)
        except Exception:                                     # noqa: BLE001
            continue
        if em.screen:
            out[em.screen] = tj["job"]
    return out


def build(proto, budget=20000):
    """{screen name -> screen} for one ECU."""
    base_ok = vmpool.init_state(proto, OkHost(), budget)
    base_fail = vmpool.init_state(proto, FailHost(), budget)
    pickers = _picker_jobs(proto, budget)
    out = {}
    for (_off, typ, name, _pid) in proto.decls:
        if typ != "screen":
            continue
        scr = _one_screen(proto, name, base_ok, base_fail, budget)
        if scr is None and name in pickers:
            scr = {"lines": [], "jobs": []}   # a picker draws via its rows
        if scr is None:
            continue
        # a picker screen with no readable jobs of its own carries the
        # togglelist job so the app offers the actuator list
        if name in pickers and not scr.get("jobs"):
            scr["pickJob"] = pickers[name]
        # the softkey legend, harvested statically so branch-gated captions
        # survive; menus.py joins it back onto empty item labels
        sk = _softkeys(proto.procs.get(name) or [])
        if sk:
            scr["softkeys"] = sk
        out[name] = scr
    return out
