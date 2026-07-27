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

    python3 tools/ipo_ir.py RDC                 # one ECU to stdout
    python3 tools/ipo_ir.py --write             # corpus -> data/inpa-ir/
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

_WRITE_JOB = re.compile(r"SCHREIBEN|STEUERN|RESET|LOESCHEN|CLEAR|WRITE", re.I)

# menu-item builtin calls that are actions, not navigation
_ACTIONS = {0x0c: "exit", 0x10: "select", 0x11: "deselect", 0x13: "start",
            0x17: "printscreen"}

# crude but effective: words that only occur in German-built pools
_DE_MARKERS = re.compile(r"\b(lesen|Fehler|Drehzahl|Speicher|Spannung|"
                         r"Zurueck|Zurück|Ansteuern|Kennung|Werte?)\b")


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


def _softkeys(lines):
    """{fkey: caption} from a screen's own printed softkey help."""
    out = {}
    for ln in lines:
        for e in ln.get("elements", []):
            if e.get("t") != "text":
                continue
            m = _SOFTKEY.match(str(e.get("s", "")).strip())
            if not m or m.group(1):         # shifted row is INPA chrome
                continue
            cap = m.group(3).strip()
            if _SK_CHROME.match(cap):
                continue
            out.setdefault(int(m.group(2)), cap)
    return out


def _screen_ir(toks):
    """Ordered lines/elements for one screen proc."""
    title = None
    jobs = []
    lines = [{"caption": None, "keys": None, "elements": []}]
    bind = {}
    lastconst = {}
    args = []

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

    for t in toks:
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
        elif op == "store":
            if args and args[-1]["op"] == "const" \
                    and t["n"] not in lastconst:
                lastconst[t["n"]] = args[-1]["v"]
        elif op in ("call", "calluser"):
            name = t.get("name", "")
            strs = [a["v"] for a in args if a["op"] == "const" and a["t"] == "s"]
            ints = [a["v"] for a in args if a["op"] == "const" and a["t"] == "i"]
            slot = next((a["n"] for a in args if a["op"] == "var"), None)
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
                if jname and all(j["name"] != jname for j in jobs):
                    jobs.append({"name": jname,
                                 "write": bool(_WRITE_JOB.search(jname))})
            elif name in ("INPAapiResultText", "INPAapiResultAnalog",
                          "INPAapiResultDigital"):
                ref = next((a for a in args if a["op"] == "procref"
                            and a["kind"] == 0), None)
                key = next((s for s in strs if D._KEYISH.match(s)), None)
                if ref is not None and key:
                    bind[ref["n"]] = key
            elif name == "analogout":
                key = bind.get(slot)
                el = {"t": "gauge", "key": key}
                if len(ints) >= 2:
                    el["row"], el["col"] = ints[0], ints[1]
                rng = num_args_after_coords(args)
                if len(rng) >= 2:
                    el["min"], el["max"] = rng[0], rng[1]
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
                key = next((s for s in strs if D._KEYISH.match(s)), None)
                if key and len(ints) >= 2:
                    el = {"t": "lamp" if len(strs) >= 3 else "value",
                          "key": key, "row": ints[0], "col": ints[1]}
                    on_off = [s for s in strs if s != key]
                    if len(on_off) >= 2:
                        el["on"] = on_off[0].strip()
                        el["off"] = on_off[1].strip()
            if el is not None:
                cur()["elements"].append(el)
            if name in ("analogout", "digitalout") or op == "calluser":
                lastconst.clear()
            args = []

    lines = [ln for ln in lines if ln["elements"] or ln["caption"]]
    out = {"title": title, "jobs": jobs, "lines": lines}
    sk = _softkeys(lines)
    if sk:
        out["softkeys"] = {str(k): v for k, v in sorted(sk.items())}
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


def _menu_ir(toks, id2name):
    items, cur_nr, cur_label = [], None, None
    entry = None
    # the screen this menu is displayed with: the setscreen in its INIT
    # block, i.e. before the first ITEM. That screen prints the softkey
    # captions for this menu's own F-keys.
    screen = None
    ref = None
    for t in toks:
        if t["op"] == "ITEM":
            break
        if t["op"] == "procref" and t.get("kind") == 0x40:
            ref = id2name.get(("screen", t["n"]))
        elif t["op"] == "call" and t["n"] == 0x04 and ref and screen is None:
            screen = ref
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
        elif t["op"] == "procref" and t.get("kind") in (0x40, 0x41) \
                and cur_label is not None:
            tgt = id2name.get(("screen" if t["kind"] == 0x40 else "menu",
                               t["n"]))
            if not tgt:
                continue
            if entry is None:
                entry = {"nr": cur_nr, "label": cur_label}
                items.append(entry)
            entry["screen" if t["kind"] == 0x40 else "menu"] = tgt
        elif t["op"] == "call" and t.get("name") == "INPAapiJob" \
                and cur_label is not None:
            # an item that calls its OWN job (RDC F18 Sleep -> SLEEP_MODE):
            # an ordinary one-key-one-job action, nothing to do with any
            # composite word
            seg = toks[max(0, ti - 8):ti]
            nm = next((x["v"] for x in seg if x["op"] == "const"
                       and x.get("t") == "s" and _KEYISH.match(x["v"])), None)
            if nm:
                if entry is None:
                    entry = {"nr": cur_nr, "label": cur_label}
                    items.append(entry)
                entry.setdefault("job", nm)
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
        if typ == "screen":
            scr = _screen_ir(toks)
            scr["id"] = pid
            ir["screens"][name] = scr
        elif typ == "menu":
            m = _menu_ir(toks, id2name)
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
    for mname, menu in ir["menus"].items():
        target = menu.get("screen")
        if not target or target not in ir["screens"]:
            continue
        sk = ir["screens"][target].get("softkeys") or {}
        for it in menu["items"]:
            cap = sk.get(str(it.get("nr")))
            if cap and len(cap) > len(it.get("label") or ""):
                it["label"] = cap
    ir["coverage"] = round(100 * (1 - cov_unk / cov_len), 1) if cov_len else 0
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
              if i.get("label") == "Analog2"]
        if not st or "screen" not in st[0]:
            fails.append("GSDS2 m_status Analog2 lost its screen target")
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
        for p in sorted(glob.glob(os.path.join(L1.SGDAT, "*.IPO"))):
            ecu = os.path.basename(p)[:-4]
            try:
                ir = build(ecu)
            except Exception:               # noqa: BLE001
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
        return 0

    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
