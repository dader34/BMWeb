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

import ipo_disasm as D
import ipo_vm as V

from . import vmpool
from .hosts import OkHost, FailHost
from .jobclass import is_write
from .menus import _variant_slots

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

# A drawn line that STARTS with a softkey marker ("< F4 >", "<Shift> + < F2 >")
# is the screen's own key-help legend, which INPA paints as the softkey bar --
# never a value's caption. It is harvested separately into `softkeys`, so the
# drawn copy is dropped before the lines reach the renderer; left in, a value
# printed to its right takes it as a label ("<Shift> + < F10>  Exit").
_SK_LEGEND = re.compile(r"^<\s*(?:Shift\s*>\s*\+\s*<\s*)?F\s*\d+\s*>")


def _lines(raw):
    """The VM's lines in the renderer's vocabulary (caption, not label)."""
    out = []
    for ln in raw:
        els = [{_RENAME.get(k, k): v for k, v in e.items() if v is not None}
               for e in (ln.get("elements") or [])
               # drop the softkey-help legend INPA paints as screen text: it is
               # the key bar, not a value caption, and joins back via `softkeys`
               if not (e.get("t") == "text"
                       and _SK_LEGEND.match(str(e.get("s") or "")))
               # an empty text draws nothing (a spacer row, or the remnant of a
               # heading lifted to the title): not a row of its own
               and not (e.get("t") == "text" and not str(e.get("s") or "").strip()
                        and e.get("key") is None)]
        if not els and not ln.get("label"):
            continue
        d = {"elements": els}
        if ln.get("label"):
            d["caption"] = ln["label"]
        # WHICH JOB ARGUMENT FILLED THIS LINE. A coding page reads one job per
        # data block (LWS5's CODIERUNG_LESEN "0".."6") and a per-wheel grid one
        # job per wheel (RDC's ABGLEICHWERT_LESEN "1".."5"), each drawing a line;
        # the arg is the only thing that tells the lines apart, so the renderer
        # reads each in its own pass and no block or wheel overwrites another.
        if ln.get("jobArg") is not None:
            d["jobArg"] = ln["jobArg"]
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


def _is_unit(key):
    return bool(key) and key.upper().endswith(("_EINH", "_EINHEIT"))


def _fold_drawn_units(lines):
    """Fold a unit DRAWN as a column header onto the readings under it.

    A grid draws each column's unit once at the top (RDC's matching-values
    page prints STAT_RADDRUCK_EINH .. STAT_RADSOLL_EINH on its header line,
    over the per-wheel STAT_RADDRUCK .. columns) rather than beside every
    cell. That unit line has value elements but is not a data row: left in
    place it gives the header a column signature the wheel rows do not share,
    so the grid is no longer recognisable as one table. Each such header unit
    is a display annotation of the columns beneath it, so it is attached as
    their `unit` and removed from its own line.

    Only a unit drawn on a DIFFERENT line from the reading it annotates is
    folded here -- the cross-line header case. A unit printed beside its own
    value on the same line is INPA's ordinary layout, already handled inline
    by _b_textout, and left untouched so a per-reading page keeps its shape.
    """
    # base -> the reading elements it annotates (value elements, not units),
    # tagged with the line they sit on so a same-line unit is left alone
    hosts = {}
    for li, ln in enumerate(lines):
        for el in ln.get("elements", []):
            k = el.get("key")
            if k and not _is_unit(k):
                hosts.setdefault(_base(k), []).append((li, el))
    for li, ln in enumerate(lines):
        keep = []
        for el in ln.get("elements", []):
            k = el.get("key")
            cross = [e for (hl, e) in hosts.get(_base(k), []) if hl != li] \
                if _is_unit(k) else []
            if cross:
                for h in cross:
                    h.setdefault("unit", k)
                continue               # the header unit rode onto its columns
            keep.append(el)
        ln["elements"] = keep
    return lines


def _pair_units(lines, reads, predicate_reads=None, fault=False):
    """Fold read-but-undrawn result keys back in, the way INPA displays them.

    A reading's unit (STAT_..._EINH) is read into a slot and shown beside the
    value, never drawn on a line of its own -- so a draw-only pass loses it.
    Every key the script read is real (inpax counts them all); here each unit
    is attached to the value element it belongs to as `unit`, and any other
    read that reached no element is appended as a value so the reading is not
    silently dropped.

    A read consumed only by a comparison (`predicate_reads`) is a control
    value, not a reading INPA shows -- STAT_GETRIEBE_NR gates the transmission
    block -- so it is never surfaced as a row.
    """
    predicate_reads = predicate_reads or set()
    drawn = {}                       # base name -> the value element drawing it
    have = set()                     # every key already on a line
    for ln in lines:
        for el in ln.get("elements", []):
            # a composite draw folded other reads into this one element ("type /
            # variant"); every folded key IS on screen, so count it as drawn and
            # do not re-add it as a phantom row of its own
            for k in el.get("also") or ():
                have.add(k)
            k = el.get("key")
            if not k:
                continue
            have.add(k)
            drawn.setdefault(_base(k), el)

    # A PER-WHEEL GRID DRAWS EVERY COLUMN ALREADY. When the screen is a grid --
    # one line per wheel, each carrying its own jobArg -- an undrawn read is the
    # loop's scratch (RDC reads STAT_RADPOS each pass to build the "Rad n" label,
    # never as a cell). Surfacing it as a value appends a phantom 41st row to a
    # 40-cell grid, so units still fold but a leftover read is not made a row.
    grid = len({ln.get("jobArg") for ln in lines
                if ln.get("jobArg") is not None}) > 1

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
        if grid:
            continue                   # a grid's columns are all drawn already
        if k in predicate_reads:
            continue                   # a value read only to branch on
        if fault:
            continue                   # a fault list is formatted in code, not
            #                            polled -- its fields are filled per entry
        extra.append({"key": k})       # a read that reached no draw of its own
    if extra:
        lines.append({"elements": extra})
    # `also` was internal bookkeeping (which reads a composite draw folded in);
    # it has done its job here, so it does not ship to the renderer.
    for ln in lines:
        for el in ln.get("elements", []):
            el.pop("also", None)
    return lines


def _global_behind(toks, at, local):
    """The global slot a local was last filled from, before toks[at].

    A menu-set global is routed through a conversion into a local, and the job
    then reads the local: `var<global>; procref; call <conv>` leaves the value
    in the frame slot. Walking back to the nearest such pair recovers which
    global the screen is really parameterised by -- the slot a menu key's own
    `store` (see _sel) must match.
    """
    for j in range(at - 1, -1, -1):
        t = toks[j]
        if t["op"] == "ITEM":
            break
        if t["op"] == "var" and t.get("sc", 0) == 0:
            nxt = toks[j + 1] if j + 1 < len(toks) else None
            if nxt and nxt["op"] == "procref":
                return t["n"]
    return None


def _arg_slots(toks):
    """{(job, arg or "") -> global slot} for jobs whose argument is a VARIABLE.

    A parameterised screen (MS450's s_aif) calls one job with a VARIABLE
    argument that a menu key set before opening it. The argument position is
    a `var` (no string literal), so the call's frame -- split into positional
    arguments -- shows position 2 is a variable rather than a constant. The
    slot feeding it is that var when it reads a global directly, or, when the
    job takes a LOCAL a conversion filled, the global behind that conversion.
    This is INPA's structure (the job's own signature), not a name guess.
    """
    out = {}
    for i, t in enumerate(toks):
        if t.get("op") != "call" or t.get("name") not in D.JOB_CALLS:
            continue
        pos = D.arg_positions(D.frame_of(toks, i))
        jname = D.arg_str(pos, D.JOB_ARG_JOB)
        if not jname:
            continue
        arg = D.arg_str(pos, D.JOB_ARG_ARG)
        if arg is not None and not arg.strip():
            arg = None
        if arg is not None or D.JOB_ARG_ARG >= len(pos):
            continue                       # a fixed literal argument, or none
        arg_expr = pos[D.JOB_ARG_ARG]
        if not any(x["op"] == "var" for x in arg_expr):
            continue                       # not a variable argument
        slot = next((x["n"] for x in arg_expr
                     if x["op"] == "var" and x.get("sc", 0) == 0), None)
        if slot is None:
            loc = next((x["n"] for x in arg_expr
                        if x["op"] == "var" and x.get("sc", 0) != 0), None)
            if loc is not None:
                slot = _global_behind(toks, i, loc)
        out.setdefault((jname, ""), slot)
    return out


def _jobs(emissions, toks=None):
    """The jobs a screen ran, deduped, with the permanent-write flag.

    A job whose argument came from a menu key (argFromMenu) is tagged with the
    global slot feeding it (argSlot), so the app can join the record a key
    selected onto the read that consumes it.
    """
    arg_slots = _arg_slots(toks or [])
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
        # the run resolved a variable argument to its offline value (0); the
        # bytecode says it really came from the menu, so the fixed arg is a
        # runtime artefact and is replaced by the argFromMenu/argSlot join
        from_menu = (name, "") in arg_slots
        if j.get("arg") and not from_menu:
            d["arg"] = j["arg"]
        if is_write(name):
            d["write"] = True
        if from_menu:
            d["argFromMenu"] = True
            if arg_slots[(name, "")] is not None:
                d["argSlot"] = arg_slots[(name, "")]
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


def _lift_title(lines):
    """The screen's title, taken from the first literal it drew at row 1.

    A screen with no setmenutitle/settitle names itself by printing a heading on
    the top row (RDC draws "RDC coding" at row 1, DWA4 "Coding") before the body.
    INPA renders that as the page title, not a data row, so the first row-1
    ftextout of a plain literal becomes the title and leaves the lines. Section
    headers printed at row 1 LOWER in the screen (DWA4's "general data",
    "Equipment") are untouched: only the very first row-1 literal is the title.
    """
    for li, ln in enumerate(lines):
        for i, el in enumerate(ln.get("elements", [])):
            if el.get("row") != 1:
                continue
            if el.get("t") == "text" and str(el.get("s") or "").strip():
                title = str(el["s"]).strip()
                del ln["elements"][i]
                # a heading line that held nothing but the title is gone now
                if not ln["elements"] and not ln.get("caption"):
                    del lines[li]
                return title
            return None          # first row-1 draw is a value, not a heading
    return None


def _screen_variant_bindings(proto, name, variant_slots):
    """[None, (slot, value), ...] -- the default arm plus each variant this
    screen gates itself on.

    A status page runs a whole block only `if VARIANTE == "KOMBI46"`
    (s_status_analog_46) or picks between two jobs on `== "KOMBI46R"` vs the
    else arm (the CAN page). Offline VARIANTE is unbound, so the run takes the
    else path and the gated block -- its jobs and its draws -- never happens.
    Binding each value the screen compares the variant slot against, and
    re-running, lets every arm execute; the results are unioned below the same
    way _explore_menu unions a menu's variant arms. Only slots that are
    variant switches (several candidates across the menus) count, so an
    ordinary `if status == 1` test is not mistaken for one.
    """
    toks = proto.procs.get(name) or []
    idx = {t["at"]: i for i, t in enumerate(toks) if "at" in t}
    seen, out = set(), [None]
    for j in range(len(toks) - 2):
        a, b, c = toks[j], toks[j + 1], toks[j + 2]
        if a["op"] != "var" or c.get("op") != "binop" or c.get("name") != "eq":
            continue
        # a variant switch: the slot compares against a KNOWN variant string.
        if (a["n"] in variant_slots and b["op"] == "const"
                and isinstance(b.get("v"), str) and b["v"]):
            key = (a["n"], b["v"])
            if key not in seen:
                seen.add(key)
                out.append(key)
        # a CODING-PRESENT gate: `if flag == 1` guarding a block that reads the
        # coding image (INPAapiResultBinary). Offline the flag is unset so the
        # whole coding display -- its 18 blocks -- is skipped, collapsing the
        # page. Binding the flag true lets the image draw, the same way a
        # variant arm is bound; the presence of ResultBinary in the guarded span
        # is what tells this gate apart from an ordinary status test.
        elif (b["op"] == "const" and b.get("v") == 1):
            jf = next((toks[k] for k in range(j + 2, min(j + 6, len(toks)))
                       if toks[k].get("op") == "jfalse"), None)
            end = idx.get(jf["to"]) if jf else None
            if end and any(toks[k].get("op") == "call"
                           and toks[k].get("name") == "INPAapiResultBinary"
                           for k in range(j, min(end, len(toks)))):
                key = (a["n"], 1)
                if key not in seen:
                    seen.add(key)
                    out.append(key)
    return out


def _ndrawn(em):
    """How many readings a run actually drew -- the arm that drew the most is
    the screen's own variant view, the one whose lines to keep."""
    return sum(1 for ln in em.lines for e in (ln.get("elements") or [])
               if e.get("t") in ("value", "gauge", "lamp") and e.get("key"))


def _union_jobs(runs, toks=None):
    """The jobs across every variant arm, deduped by (name, arg), order kept.

    The CAN page's SIA read is AIF_SIA_DATEN_LESEN on the KOMBI46 arm and
    STATUS_AIF_SIA_DATEN_LESEN on the KOMBI46R arm; both are real, so the
    union carries seven jobs where one arm alone sees six.
    """
    merged = V.Emissions()
    seen = set()
    for em in runs:
        for j in em.jobs:
            k = (j.get("job"), j.get("arg") or "")
            if k in seen:
                continue
            seen.add(k)
            merged.jobs.append(j)
    return _jobs(merged, toks)


def _union_lines(runs, base):
    """Every reading each variant arm drew, on the base arm's line layout.

    One variant arm draws a subset of a shared screen: GSDS2's analog page
    shows the planetary and turbine speeds only on the GS8xx / GS20 variants,
    KOMBI's CAN page its climate lamps only on the E36 build. Rendering one arm
    alone loses the others' readings; a value drawn in some arm but not the
    base arm is appended, keyed, so a variant-only reading is not dropped. The
    base arm (the one that drew the most) keeps its line structure so the
    positional caption pairing and the per-wheel grid are unchanged.
    """
    lines = _lines(base.lines)
    have = {e.get("key") for ln in lines for e in ln["elements"]
            if e.get("key")}
    extra = []
    for em in runs:
        if em is base:
            continue
        for ln in em.lines:
            for e in ln.get("elements") or []:
                k = e.get("key")
                if not k or k in have or e.get("t") not in (
                        "value", "gauge", "lamp"):
                    continue
                have.add(k)
                extra.append({_RENAME.get(kk, kk): vv
                              for kk, vv in e.items() if vv is not None})
    if extra:
        lines.append({"elements": extra})
    return lines


def _one_screen(proto, name, base_ok, base_fail, budget, variant_slots=None):
    """Derive a single screen, or None if it draws and says nothing."""
    bindings = _screen_variant_bindings(proto, name, variant_slots or {})
    # a presence gate (flag == 1 guarding the coding image) must hold TOGETHER
    # with the variant, not instead of it -- the coding block checks both -- so
    # each presence gate is applied alongside every arm, never on its own.
    gates = [bd for bd in bindings if bd is not None and bd[1] == 1]
    arms = [bd for bd in bindings if bd not in gates]
    try:
        runs = []
        for bd in arms:
            vm = vmpool.fresh(proto, OkHost(), base_ok, budget)
            if bd is not None:
                vm.globals[bd[0]] = bd[1]
            for g in gates:
                vm.globals[g[0]] = g[1]
            runs.append(vm.run(name))
        fail = vmpool.fresh(proto, FailHost(), base_fail, budget).run(name)
    except Exception:                                          # noqa: BLE001
        return None

    # the arm that drew the most is the screen's own variant view -- its lines
    # set the layout; the other arms only add readings gated to their variant
    ok = max(runs, key=_ndrawn)
    # A FAULT-FORMATTER SCREEN HAS NOTHING TO POLL. A screen whose job is the
    # fault read (FS_/IS_/HS_LESEN) reads the fault-entry fields (F_ORT, F_HFK,
    # ... -- INPA's fixed fault-record schema) into slots and formats the list
    # in code; the fields are filled per entry at runtime, not drawn as a static
    # readout, so they must not become value rows (MS450's s_fs_kurz shows
    # nothing offline, like INPA).
    fault = any((j.get("job") or "").upper().startswith(("FS_", "IS_", "HS_"))
                and (j.get("job") or "").upper().endswith("LESEN")
                for j in ok.jobs)
    lines = _pair_units(_fold_drawn_units(_union_lines(runs, ok)),
                        ok.reads, ok.predicate_reads, fault)
    # A KEY WITHOUT A READ IS A SCRIPT VARIABLE, NOT AN ECU RESULT. s_info runs
    # no job and no INPAapiResult -- it prints "ECU: <name>" filling the value
    # from a global inpainit set, not from the car -- so its drawn slots carry a
    # name (ECU, REVISION) that is not a result key. With nothing read and
    # nothing polled, those elements are captions the app fills, not value rows;
    # dropping the key keeps s_info from reading as a data card.
    if not ok.reads and not ok.jobs:
        for ln in lines:
            ln["elements"] = [el for el in ln.get("elements", [])
                              if el.get("t") != "value"]   # keep only captions
    # a screen with no setmenutitle names itself by a row-1 heading; lift it so
    # it titles the page instead of reading as a data row (RDC "RDC coding")
    title = ok.title or _lift_title(lines)
    ok_msgs = _dialogs(ok)
    seen = {(m.get("title"), m.get("body")) for m in ok_msgs}
    err_msgs = [m for m in _dialogs(fail)
                if (m.get("title"), m.get("body")) not in seen]
    # most error arms PRINT rather than pop a box; ship the fail-arm lines when
    # they differ so a live failure draws what INPA would have drawn
    err_lines = _lines(fail.lines)
    if err_lines == lines:
        err_lines = None

    # A screen that drew only its softkey legend (a menu/navigation page:
    # KLIMA's s_status, s_steuern) has no data lines once the legend is stripped,
    # but it is a real screen the app routes to -- keep it (with a title if it
    # named one), as it drew a bar, rather than dropping it as empty.
    drew_legend = any(e.get("t") == "text"
                      and _SK_LEGEND.match(str(e.get("s") or ""))
                      for ln in ok.lines for e in (ln.get("elements") or []))
    if not lines and not ok_msgs and not err_msgs and not drew_legend:
        return None                       # executed nothing worth shipping

    scr = {"lines": lines, "jobs": _union_jobs(runs, proto.procs.get(name))}
    if title:
        scr["title"] = title
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
    variant_slots = _variant_slots(proto)
    out = {}
    for (_off, typ, name, _pid) in proto.decls:
        if typ != "screen":
            continue
        scr = _one_screen(proto, name, base_ok, base_fail, budget,
                          variant_slots)
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
