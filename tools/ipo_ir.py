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
      "language": "en" | "de",
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
app/renderer/translate.js -- and writes the result back as `i18n`, consuming
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_screens as L1                                        # noqa: E402
import ipo_disasm as D                                          # noqa: E402

IR_VERSION = 1
OUT_DIR = os.path.join(os.path.dirname(L1.OUT), "inpa-ir")

_KEYISH = re.compile(r"^[A-Z][A-Z0-9_]{3,}$")

# A RESULT name, which is laxer than a job name: BMW ships mixed-case results
# ("Dimmerstellung" on BMBT46TN, "EINSCHALTZAEHLER_FKT2a") and two-letter ones
# ("ECU", "TYP"). Used only where a Result* call names what it reads -- job
# names keep the strict form, or a bare argument like "FM" would pass for one.
_RESULTISH = re.compile(r"^[A-Z][A-Za-z0-9_]+$")
# A human caption rather than a result name: it ends in a colon, or contains a
# space or a lowercase letter where a key would not ("Steuergerät:", "SGBD
# RevisionsNr.:"). Trailing padding is INPA's own column alignment.
_CAPTIONISH = re.compile(r"^(?=.*[ :a-zäöüß])[^\x00-\x1f]{2,40}\s*$")

_WRITE_JOB = re.compile(r"SCHREIBEN|STEUERN|RESET|LOESCHEN|CLEAR|WRITE", re.I)

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

# Items that drive INPA itself rather than the ECU: loading another script,
# opening the KVP editor, switching the displayed screen and nothing more.
# Detected by what the item DOES -- a script path, a tool command line, or a
# bare setscreen back to the root -- because a list of labels would need an
# entry per ECU per language, which is the trap this whole IR exists to avoid.
_APP_TOOL = re.compile(r"\.ipo$|^kvp_edit|^\\\\?inpa\\\\|\\\\sgdat\\\\", re.I)

# crude but effective: words that only occur in German-built pools
_DE_MARKERS = re.compile(r"\b(lesen|Fehler|Drehzahl|Speicher|Spannung|"
                         r"Zurueck|Zurück|Ansteuern|Kennung|Werte?)\b")

# ---------------------------------------------------------------------------
# Actuator (STEUERN_) captions, absorbed from the former steuern_layout.py.
#
# INPA compiles each actuator test as a pair of blocks: the start job
# (STEUERN_X) and its stop job (STEUERN_X_ENDE). Only the stop block carries a
# human caption -- the "...Ansteuerung beendet!" acknowledgement INPA prints
# when the test ends. The start block holds nothing but the job name and its
# JOB_STATUS/OKAY check, so a nearest-string scan from the START job walks into
# the NEXT actuator's caption and mislabels almost every entry.
#
# This is a string-pool adjacency scan over the raw bytes, not a decompiler
# pass: the pairing lives in string ORDER, which the decoded token stream does
# not preserve across blocks. It produced data/steuern-labels.json for a year;
# the fold into the IR keeps its output byte-identical (verified at fold time).

# printable runs, latin-1: the .IPO keeps German captions in CP1252/latin-1
_ST_RUN = re.compile(rb"[\x20-\x7e\xa0-\xff]{3,}")
# a bare code token, result name, or number is never a caption
_ST_NOISE = re.compile(r"^(JOB_STATUS|OKAY|ERROR|[A-Z0-9_]+|[\d.,;x\s+-]+)$")
_ST_STOP = re.compile(r"^(STEUERN_[A-Z0-9_]+?)_(ENDE|AUS|STOP)$")

# INPA screen chrome and job-failure text: these sit in the same string pool
# and would otherwise be captured as an actuator's name
_ST_CHROME = re.compile(
    r"fehler\s+bei|job-?status|^\s*(drucken|print|info|status|auswahl|selection"
    r"|aktive\s+fehlermeldung|ende|exit|zur(ü|ue)ck|back|weiter)\s*$"
    r"|^\s*(activate|ansteuern|steuern|aktivieren|ein|aus|on|off|start|stop)\s*$",
    re.I)

# acknowledgement wording INPA appends to the component name; stripped so the
# button reads "E-Lüfter", not "E-Lüfteransteuerung beendet!"
_ST_STRIP = [
    (re.compile(r"\s*-?\s*ansteuerung\s+beendet\s*!?\s*$", re.I), ""),
    (re.compile(r"\s*ansteuerung\s*$", re.I), ""),
    (re.compile(r"^\s*status\s+", re.I), ""),
    (re.compile(r"\s+(ein|aus|on|off)\s*$", re.I), ""),
    (re.compile(r"\s*!+\s*$"), ""),
]


def _st_is_caption(s):
    """A human-readable caption, not a code token / result name / number."""
    s = s.strip()
    if not 4 <= len(s) <= 60:
        return False
    if _ST_NOISE.fullmatch(s):
        return False
    if s.startswith(("STEUERN", "STATUS_", "STAT_", "_TEL", "ergebnis")):
        return False
    if _ST_CHROME.search(s):
        return False
    return bool(re.search(r"[a-zäöüß]", s))


def _st_clean(caption):
    """Acknowledgement text -> component name."""
    s = caption.strip()
    for pat, rep in _ST_STRIP:
        s = pat.sub(rep, s)
    return s.strip(" -:\t") or caption.strip()


def _steuern_labels(data):
    """{start_job: caption} mined from the raw .IPO bytes."""
    seq = [m.group(0).decode("latin-1") for m in _ST_RUN.finditer(data)]
    out = {}
    for i, s in enumerate(seq):
        m = _ST_STOP.fullmatch(s)
        if not m:
            continue
        start = m.group(1)
        if start in out:
            continue
        # the caption sits just past the stop job, before the next block's
        # JOB_STATUS/OKAY check
        for nxt in seq[i + 1:i + 6]:
            if not _st_is_caption(nxt):
                continue
            label = _st_clean(nxt)
            # stripping the acknowledgement can leave bare chrome ("Status")
            if len(label) < 2 or _ST_CHROME.search(label):
                continue
            out[start] = label
            break
    return out


def _language(pool):
    votes = 0
    seen = 0
    for t, v in pool:
        if t != "s" or len(v) < 4:
            continue
        seen += 1
        if _DE_MARKERS.search(v):
            votes += 1
        if seen >= 400:
            break
    return "de" if seen and votes / seen > 0.06 else "en"


# INPA prints its own softkey help as screen text: "< F1 >  DWA output".
# On actuator screens this IS the function list -- the MENU's ITEMs carry only
# fragments ("DWA") and flip state flags, so the caption lives here and joins
# back by F-number.
_SOFTKEY = re.compile(r"^<\s*(?:(Shift)\s*>\s*\+\s*<\s*)?F(\d+)\s*>\s+(.{2,44})$")

# INPA's own chrome, which the app provides natively
_SK_CHROME = re.compile(r"^(Print(\s*screen)?|Back|Exit|End|Ende|Zur(ü|ue)ck|"
                        r"Select|Deselect|Auswahl|Abwahl|Druck(en)?|"
                        r"Bildschirmdruck|Change\s+Editor|Gesamt)$", re.I)


# ..._TEXT, or ..._TEXT2 where the index distinguishes bank 1 from bank 2
_TEXT_KEY = re.compile(r"^(.*)_TEXT(\d*)$")
_VALUE_KEY = re.compile(r"^(.*)_(WERT|VALUE)(\d*)$")


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
            sel = t["v"]
        elif t["op"] == "frame":
            args = []
        elif t["op"] in ("const", "var", "procref"):
            args.append(t)
        elif t["op"] == "call":
            if t.get("name") == "INPAapiJob":
                s = [a["v"] for a in args
                     if a["op"] == "const" and a.get("t") == "s"]
                if s and D._KEYISH.match(s[0]):
                    e = {"job": s[0]}
                    if len(s) > 1 and s[1] != "":
                        e["arg"] = s[1]
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
_DISPLAY_CALLS = {"textout", "ftextout", "text", "analogout", "digitalout"}


def _is_display_func(toks):
    names = {t.get("name") for t in toks if t["op"] == "call"}
    return bool(names & _DISPLAY_CALLS) and "INPAapiJob" in names \
        and any(n and n.startswith("INPAapiResult") for n in names)


def _screen_ir(toks):
    """Ordered lines/elements for one screen proc."""
    title = None
    jobs = []
    lines = [{"caption": None, "keys": None, "elements": []}]
    bind = {}
    lastconst = {}
    args = []
    pending_result = None

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
        if op == "LINE":
            cap = (t.get("label") or "").strip() or None
            keys = [k.strip() for k in re.split(r"[;,]", t.get("keys") or "")
                    if k.strip()] or None
            lines.append({"caption": cap, "keys": keys, "elements": []})
            args = []
        elif op == "frame":
            args = []
        elif op in ("const", "var", "procref"):
            args.append(t)
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
            elif name == "INPAapiJob":
                jname = next((s for s in strs if D._KEYISH.match(s)), None)
                if jname:
                    # the argument INPA passes. A per-position screen calls
                    # the same job once per wheel/bank/cylinder with the index
                    # as its argument (RDC: ABGLEICHWERT_LESEN "1", then "2"
                    # ...), so the SAME result keys mean a different thing in
                    # each LINE. Without the argument the screen showed 40
                    # rows of the same 8 values.
                    after = strs[strs.index(jname) + 1:] if jname in strs else []
                    arg = next((s for s in after if s.strip()), None)
                    cur()["jobArg"] = arg
                    # ...or a VARIABLE argument, which the menu key set before
                    # opening this screen. MS450's fifteen AIF keys share
                    # s_aif and differ only in the record index they store, so
                    # the screen is parameterised rather than fixed.
                    var_arg = arg is None and any(a["op"] == "var"
                                                  for a in args)
                    if all(j["name"] != jname or j.get("arg") != arg
                           for j in jobs):
                        jobs.append({"name": jname,
                                     "write": bool(_WRITE_JOB.search(jname)),
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
                                        if arg is None and var_arg else {})})
            elif name in ("INPAapiResultText", "INPAapiResultAnalog",
                          "INPAapiResultDigital", "INPAapiResultNumber"):
                # destination slot: kind 0 writes scratch, kind 2 writes the
                # screen's global frame (drawn by a later LINE's analogout)
                ref = next((a for a in args if a["op"] == "procref"
                            and a["kind"] in (0, 2)), None)
                key = next((s for s in strs if _RESULTISH.match(s)), None)
                if ref is not None and key:
                    bind[(2 if ref["kind"] == 2 else 0, ref["n"])] = key
            elif name == "INPAapiResultInto":
                # reads into an IMPLICIT slot -- it names no destination, and
                # copyslot moves the value out afterwards. LWS5's coding page
                # reads COD_DATEN this way for each of its seven blocks.
                pending_result = next(
                    (s for s in strs if _RESULTISH.match(s)), None)
            elif name == "substr":
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
            elif name == "copyslot":
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
            elif name == "analogout":
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
                # is seven of these -- ("Steuergerät:", "ECU", 6, 5) -- and
                # taking only the key lost every caption, while _KEYISH's
                # four-character floor dropped the "ECU" row outright.
                lab = None
                if len(strs) >= 2 and len(ints) >= 2 \
                        and _CAPTIONISH.match(strs[0]) \
                        and _RESULTISH.match(strs[1]):
                    lab, key = strs[0].strip().rstrip(":").strip(), strs[1]
                else:
                    key = next((s for s in strs if D._KEYISH.match(s)), None)
                if key and len(ints) >= 2:
                    el = {"t": "value" if lab or len(strs) < 3 else "lamp",
                          "key": key, "row": ints[0], "col": ints[1]}
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
                cur()["elements"].append(el)
            if name in ("analogout", "digitalout") or op == "calluser":
                lastconst.clear()
            args = []

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
        if t["op"] == "call" and t.get("name") == "INPAapiJob":
            seg = toks[max(0, i - 8):i]
            if any(x["op"] == "var" and x["n"] == acc for x in seg):
                nm = next((x["v"] for x in seg if x["op"] == "const"
                           and x.get("t") == "s" and _KEYISH.match(x["v"])),
                          None)
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
        elif t["op"] == "call" and t.get("name") == "INPAapiJob" \
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


def _menu_ir(toks, id2name, name=None):
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
    for ti, t in enumerate(toks):
        if t["op"] == "ITEM":
            # keep an item even when its body neither navigates nor calls a
            # named action: INPA's actuator items only flip state flags and
            # let the SCREEN send the job, so the item is real and its
            # caption comes from the screen's softkey help by F-number
            if entry is None and cur_label:
                items.append({"nr": cur_nr, "label": cur_label})
            entry = None
            cur_nr, cur_label = t.get("nr"), (t.get("label") or "").strip()
            last_const = None
        elif t["op"] == "const" and t.get("t") in ("i", "b"):
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
            if slot not in entry:
                entry[slot] = tgt
            elif entry[slot] != tgt:
                alts = entry.setdefault(slot + "Alts", [])
                if tgt not in alts:
                    alts.append(tgt)
        elif t["op"] == "call" and t.get("name") == "INPAapiJob" \
                and cur_label is not None:
            # an item that calls its OWN job (RDC F18 Sleep -> SLEEP_MODE):
            # an ordinary one-key-one-job action, nothing to do with any
            # composite word
            # only THIS call's arguments: a frame opens the list, so anything
            # before it belongs to an earlier call. Scanning a fixed window ran
            # past the frame and picked up the "OKAY" of the CheckJobStatus
            # that follows, making every RADIO actuator call a job named OKAY.
            lo = ti
            while lo > 0 and toks[lo - 1]["op"] != "frame":
                lo -= 1
            seg = toks[lo:ti]
            nm = next((x["v"] for x in seg if x["op"] == "const"
                       and x.get("t") == "s" and _KEYISH.match(x["v"])), None)
            if nm:
                if entry is None:
                    entry = {"nr": cur_nr, "label": cur_label}
                    items.append(entry)
                entry.setdefault("job", nm)
                # ...and the ARGUMENT it sends, which is often the only thing
                # separating two keys: CDC's "Trpmode ON" and "OFF" both call
                # ENERGIESPARMODE and differ solely in "0;1;0" vs "0;0;0".
                # Without it the two keys would send the same command.
                after = [x["v"] for x in seg
                         if x["op"] == "const" and x.get("t") == "s"]
                if nm in after:
                    rest = after[after.index(nm) + 1:]
                    arg = next((s for s in rest if s.strip()), None)
                    if arg:
                        entry.setdefault("jobArg", arg)
                # a menu item's job needs the same write flag a screen's
                # does. KLIMA_5B's "Comp.act" calls EEPROM_SCHREIBEN, which
                # would have fired on a keypress like any read.
                if _PERSISTENT_WRITE.search(nm):
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
        elif t["op"] == "call" and t["n"] in (0x5c, 0x79) \
                and cur_label is not None:
            # A PC file operation: 5c shows a named file, 79 opens one (LWS5's
            # "Read Pr." displays na_fs_pr.tmp; "Delete Pr." reopens it "w" to
            # truncate it). INPA writes these logs on the diagnostic PC.
            # Recorded from what the item DOES, since the captions vary -- but
            # only meaningful once the whole item is known, because a real
            # fault key ALSO writes the log after reading the ECU, and a file
            # PICKER (which prompts, then shows what you chose) is the first
            # half of a real function: LWS5's "Write Coding Data" picks a .COD
            # file and its next key sends it to the sensor.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry["_file"] = True
        elif t["op"] == "call" and t["n"] in (0x3f, 0x46) \
                and cur_label is not None:
            # an input dialog: INPA asks the user for a value and builds the
            # job argument from it. KLIMA_5B's nine flap positions all call
            # STEUERN_MOTOR_KLAPPENPOSITION but each prompts for its own
            # ("Fresh air flap", "Position (0-100 %)"), so they are not
            # interchangeable and none can be sent without the input.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            prompts = [x["v"] for x in toks[max(0, ti - 6):ti]
                       if x["op"] == "const" and x.get("t") == "s"
                       and str(x["v"]).strip()]
            if prompts:
                entry["prompt"] = prompts[-2:]
        elif t["op"] == "call" and t["n"] == 0x0f and cur_label is not None:
            # scriptchange: loads a different .IPO entirely. Its argument is a
            # script or SGBD name ("_DWS", "GS30", "\inpa\sgdat\airbag.ipo"),
            # so the CALL is the reliable signal -- matching the string shape
            # missed the bare-name form.
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry["appTool"] = True
        elif t["op"] == "const" and t.get("t") == "s" \
                and cur_label is not None and _APP_TOOL.search(str(t["v"])):
            # this item drives INPA, not the car: it names a script to load or
            # a tool to launch (RDC F11 "Change" runs kvp_edit, F15 "Extra"
            # loads \inpa\sgdat\_rdc.ipo)
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
        if not it.pop("_file", None) or it.get("prompt"):
            continue
        # "stays put" covers both shapes INPA uses to return from a PC
        # action: re-installing THIS menu, or jumping back to the root. MS450's
        # ident menu writes the ident data to a file and returns to m_main.
        stays = (it.get("menu") == name
                 and (it.get("screen") is None or screen is None
                      or it.get("screen") == screen)) \
            or (it.get("menu") == "m_main" and name != "m_main")
        if not it.get("job") and not it.get("action") \
                and (stays or not any(it.get(k)
                                      for k in ("screen", "menu"))):
            it["fileAction"] = True
    # INPA lays its softkeys out by number, so the menu reads in F-key order
    # rather than in the order the bytecode happens to declare them
    items.sort(key=lambda x: (x.get("nr") is None, x.get("nr") or 0))
    out = {"items": items}
    if screen:
        out["screen"] = screen
    return out


def build(ecu):
    data, ps, pool, decls = D.load(ecu)
    if ps is None or len(decls) < 3:
        return None
    id2name = {}
    for off, typ, name, pid in decls:
        id2name[(typ, pid)] = name
    ir = {"ir": IR_VERSION, "ecu": ecu, "language": _language(pool),
          "menus": {}, "screens": {}}
    cov_unk = cov_len = 0
    # every proc's tokens, kept so a composite menu can look up what the
    # program initialises its argument fields to
    all_toks = {}
    for k, (off, typ, name, pid) in enumerate(decls):
        lo = off + 1 + len(name) + 1 + 4 + 1
        hi = decls[k + 1][0] if k + 1 < len(decls) else ps
        toks, unk, ln = D.walk(data, lo, hi, pool)
        all_toks[name] = toks
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
            m = _menu_ir(toks, id2name, name)
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
    used = set()
    for menu in ir["menus"].values():
        for it in menu["items"]:
            fid = it.pop("_callf", None)
            sel = it.pop("_callsel", None)
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
                if _WRITE_JOB.search(hit["job"]):
                    it["writeJob"] = True
            it["screen"] = nm
            used.add(nm)
    for nm, scr in list(ir["screens"].items()):
        if scr.get("fromFunc") and nm not in used:
            del ir["screens"][nm]

    # A key that launches a STATE machine which only writes a file is still a
    # PC action: LWS5's single Coding key runs sm_Codier_Datei, whose whole
    # body is "prompt for a path, open it 'w', write the coding data" -- INPA
    # offers no coding readout for this ECU at all. Resolved here because the
    # evidence is in the state proc, not in the menu item.
    for menu in ir["menus"].values():
        for it in menu["items"]:
            st = it.pop("_state", None)
            if not st or st not in all_toks:
                continue
            body = all_toks[st]
            calls = {t["n"] for t in body if t["op"] == "call"}
            if (calls & {0x5c, 0x79}) and 0x62 not in calls:
                it["fileAction"] = True     # writes a file, never asks the ECU
                continue
            # ...but a state machine that CALLS A JOB is a real ECU function,
            # and the job is the only evidence of what the key does: LWS5's
            # "Write Data into ECU" runs CODIERUNG_SCHREIBEN_DATEI, and its
            # Ident equivalent runs IDENT_SCHREIBEN. Surfaced so the key is not
            # mistaken for a dead one -- and flagged write, because every one
            # of these is a permanent EEPROM change behind INPA's own
            # "Only for the developer" title.
            for i, t in enumerate(body):
                if t["op"] != "call" or t["n"] != 0x62:
                    continue
                nm = next((x["v"] for x in body[max(0, i - 8):i]
                           if x["op"] == "const" and x.get("t") == "s"
                           and _KEYISH.match(x["v"])), None)
                if nm:
                    it.setdefault("job", nm)
                    it["stateJob"] = True
                    if _PERSISTENT_WRITE.search(nm):
                        it["writeJob"] = True
                    break
    # Which screen a menu is drawn in: the key that installs the menu sets the
    # screen in the same breath (KOMBI F6 Activate -> m_steuern_46 + s_steuern),
    # so the pairing is the item's own, not a guess from the name. Without it
    # the join below never ran for KOMBI and its actuator keys kept INPA's
    # fragments ("SII oil", "hi.beam") instead of the screen's own help text.
    drawn_in = {}
    for m in ir["menus"].values():
        for it in m["items"]:
            for mt in [it.get("menu")] + (it.get("menuAlts") or []):
                if mt and it.get("screen"):
                    drawn_in.setdefault(mt, []).append(it["screen"])
    for mname, menu in ir["menus"].items():
        target = menu.get("screen")
        if not target:
            # prefer a screen whose softkeys actually cover this menu's keys
            nrs = {str(i.get("nr")) for i in menu["items"]}
            best, score = None, 0
            for cand in drawn_in.get(mname, []):
                sk = (ir["screens"].get(cand) or {}).get("softkeys") or {}
                n = len(nrs & set(sk))
                if n > score:
                    best, score = cand, n
            target = best
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
    # Actuator captions, mined from the same file's string pool (see
    # _steuern_labels above). {STEUERN_X: "component name"} -- the names INPA
    # itself prints; the app's Activations view joins them to /activations by
    # job. Emitted only when the mine found something, so a diff against the
    # retired data/steuern-labels.json stays one-to-one.
    st = _steuern_labels(data)
    if st:
        ir["steuernLabels"] = st
    # Every caption this ECU displays, gathered once. The renderer used to
    # translate at draw time -- 24 call sites, the same string re-resolved on
    # every repaint -- which also meant a per-ECU correction had nowhere to
    # live. tools/ipo_i18n.js fills this in from the shared vocabulary plus
    # data/inpa-i18n/<ECU>.json, and the interpreter then just looks up.
    strings = set()
    for lab in (ir.get("steuernLabels") or {}).values():
        strings.add(lab)
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
            if t["op"] == "call" and t.get("name") == "INPAapiJob":
                nm = next((x["v"] for x in toks[max(0, i - 6):i]
                           if x["op"] == "const" and x.get("t") == "s"
                           and _KEYISH.match(str(x["v"]))), None)
                if nm and vjob is None:
                    vjob = nm
            if t["op"] == "call" and t["n"] == 0x71 and vkey is None:
                vkey = next((x["v"] for x in toks[max(0, i - 6):i]
                             if x["op"] == "const" and x.get("t") == "s"
                             and _KEYISH.match(str(x["v"]))), None)
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
        for p in sorted(glob.glob(os.path.join(L1.SGDAT, "*.IPO"))):
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
                continue
            with open(os.path.join(OUT_DIR, ecu + ".json"), "w",
                      encoding="utf-8") as f:
                json.dump(ir, f, ensure_ascii=False)
            n += 1
            scr += len(ir["screens"])
            el += sum(len(ln["elements"]) for s in ir["screens"].values()
                      for ln in s["lines"])
        print(f"wrote {n} IR files -> {os.path.relpath(OUT_DIR)} "
              f"({scr} screens, {el} elements)")
        if failed:
            print(f"  FAILED  {len(failed)} ECUs did not build:")
            for f in failed[:8]:
                print(f"    {f}")
        return 0

    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
