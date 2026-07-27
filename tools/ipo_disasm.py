#!/usr/bin/env python3
"""Universal .IPO decompiler -- the real format, not string-adjacency regexes.

Cracked against MUST_EXX.SRC / MUST_EXX.IPO, the template source and its
compiled artifact that BMW ships side by side in SGDAT. With both in hand the
format falls out by correlation:

FILE LAYOUT
    header, then procedure declarations each followed by their code, then a
    CONSTANT POOL running to EOF.

DECLARATION        <type u8> <name> 0a <u32 id>
    type 01=SCREEN 02=MENU 05=function (03/04 seen for STATE machinery).
    The id is the number `02 <kind> <u16 id>` pushes refer to. The earlier
    miners matched "0c 81 <u16> <type> <name>" as one declaration unit; the
    0c 81 is really the PREVIOUS proc's last builtin call.

CONSTANT POOL      typed literal stream, one entry per source literal, in
    emission order, @...@ text already translated:
        06 <str> 0a | 03 <u16 int> | 05 <f64> | 01 <u8 bool> | 02 <u8 byte>
                    | 04 <u32 long>
    Verified: MUST code refs 0x0c3d..0x0c46 == pool entries
    ['Read analog status',1,0,1,0 , '',3,0,0,0] == the two ftextout calls
    the source makes at the top of SCREEN s_status_analog().

CODE               self-delimiting tokens, mostly 4 bytes:
    01 00 <u16>       push VARIABLE slot n
    01 01 <u16>       push CONSTANT pool[n]        <- the missing linkage
    02 <k> <u16>      push proc reference (k: 40=screen 41=menu, 3e/3f seen)
    06 00 <u16>       store into variable slot n
    09 <u16> 00       binary operator (60 add, 62 mul observed)
    0a 00 <u16>       block header: body length in dwords (ITEM/INIT bodies)
    0c 80 <u16>       call user proc #n
    0c 81 <u16>       call builtin #n
    0f 00 00 00       OPEN CALL FRAME -- args pushed after this belong to the
                      next call, so no arity table is needed
    21/22/24 <u16> <u16> <label> 0a
                      LINE(21/22) and ITEM(24) headers, label inline
    everything else   treated as 4-byte unknown, counted against coverage

BUILTINS (empirically named from MUST correlation; unknowns stay numeric)
    00 setmenutitle   01 setmenu   04 setscreen   0c exit
    10 select  11 deselect  13 start  17 printscreen
    48 text    4a ftextout

Read-only: decodes .IPOs, never talks to a car.

    python3 tools/ipo_disasm.py GSDS2                # decompile, summary
    python3 tools/ipo_disasm.py GSDS2 s_ana2_834     # one proc, full listing
    python3 tools/ipo_disasm.py --corpus             # coverage stats
"""
import os
import re
import sys
import json
import glob
import struct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_screens as L1                                        # noqa: E402

OUT = L1.OUT

# ---------------------------------------------------------------- pool ------

_PRINTABLE = set(range(0x09, 0x100)) - {0x0a}


def _tok_pool(data, start, end):
    """Tokenize data[start:end] as a pure literal stream, or None."""
    entries, i = [], start
    while i < end:
        t = data[i]
        if t == 0x06:
            j = data.find(b"\n", i + 1)
            if j < 0 or j - i > 220:
                return None
            s = data[i + 1:j]
            if any(c not in _PRINTABLE for c in s):
                return None
            entries.append(("s", s.decode("latin-1")))
            i = j + 1
        elif t == 0x03:
            if i + 3 > end:
                return None
            entries.append(("i", int.from_bytes(data[i + 1:i + 3], "little")))
            i += 3
        elif t == 0x05:
            if i + 9 > end:
                return None
            entries.append(("d", struct.unpack_from("<d", data, i + 1)[0]))
            i += 9
        elif t == 0x01:
            if i + 2 > end:
                return None
            entries.append(("b", data[i + 1]))
            i += 2
        elif t == 0x02:
            if i + 2 > end:
                return None
            entries.append(("y", data[i + 1]))
            i += 2
        elif t == 0x04:
            if i + 5 > end:
                return None
            entries.append(("l", int.from_bytes(data[i + 1:i + 5], "little")))
            i += 5
        else:
            return None
    return entries


def find_pool(data):
    """(pool_start, entries). The pool is the longest EOF-suffix that
    tokenizes as literals AND whose indexing agrees with the code's refs.

    A too-early start prepends fake entries and shifts every index, so
    candidates are scored on a semantic anchor: for sampled call sites
    `01 01 r` `01 01 r+1` `01 01 r+2` `0c 81 48` (a text(row,col,str) call),
    pool[r..r+2] must type-match (int,int,str).
    """
    n = len(data)
    # ok[i]: data[i:] tokenizes cleanly to EOF. Computed descending, O(n).
    ok = bytearray(n + 1)
    ok[n] = 1
    for i in range(n - 1, -1, -1):
        t = data[i]
        if t == 0x06:
            j = data.find(b"\n", i + 1, i + 221)
            if j >= 0 and all(c in _PRINTABLE for c in data[i + 1:j]):
                ok[i] = ok[j + 1]
        elif t == 0x03 and i + 3 <= n:
            ok[i] = ok[i + 3]
        elif t == 0x05 and i + 9 <= n:
            ok[i] = ok[i + 9]
        elif t in (0x01, 0x02) and i + 2 <= n:
            ok[i] = ok[i + 2]
        elif t == 0x04 and i + 5 <= n:
            ok[i] = ok[i + 5]
    good = None
    run = 0
    for i in range(n - 1, -1, -1):
        if ok[i]:
            good = i
            run = 0
        else:
            run += 1
            if good is not None and run > 6000:
                break
    if good is None:
        return None, []
    # candidate boundaries: entry-aligned starts within [good, n)
    # walk forward from `good`, emitting the offset of every entry
    offs = []
    i = good
    while i < n:
        offs.append(i)
        t = data[i]
        if t == 0x06:
            i = data.find(b"\n", i + 1) + 1
        elif t == 0x03:
            i += 3
        elif t == 0x05:
            i += 9
        elif t in (0x01, 0x02):
            i += 2
        elif t == 0x04:
            i += 5
        else:
            break
    # refs in code region [0, good): sample text-call anchors
    code = data[:good]
    anchors = []
    for m in re.finditer(rb"\x01\x01(..)\x01\x01(..)\x01\x01(..)\x0c\x81\x48\x00",
                         code, re.DOTALL):
        r0 = int.from_bytes(m.group(1), "little")
        r1 = int.from_bytes(m.group(2), "little")
        r2 = int.from_bytes(m.group(3), "little")
        if r1 == r0 + 1 and r2 == r0 + 2:
            anchors.append(r0)
    # tokenize ONCE from `good`; a candidate start at entry k is entries[k:],
    # so scoring is index arithmetic instead of re-tokenizing per candidate
    entries = _tok_pool(data, good, n)
    if entries is None:
        return None, []
    best = None
    for k in range(len(entries)):
        score = 0
        for r in anchors[:40]:
            j = k + r
            if j + 2 < len(entries) \
                    and entries[j][0] == "i" and entries[j + 1][0] == "i" \
                    and entries[j + 2][0] == "s":
                score += 1
        if best is None or score > best[0]:
            best = (score, k)
        if best[0] == min(len(anchors), 40) and best[0] > 0:
            break                       # perfect score, take earliest
    k = best[1]
    return offs[k] if k < len(offs) else good, entries[k:]


# ---------------------------------------------------------------- decls -----

# Name length is bounded only by INPA's own limit, not by a guess. A 30-char
# cap silently hid every longer proc: AFS_60 declares
# s_afs_fahrgestellnummern_vergleich (34) and s_afs_motorlagewinkeloffset_lesen
# (33), which the ECU's own .ini lists and the decoder did not. Cross-checking
# the corpus against those .ini screen inventories is what surfaced it.
_DECL = re.compile(rb"([\x01-\x05])([A-Za-z_][A-Za-z0-9_]{2,60})\x0a(....)",
                   re.DOTALL)
_TYPES = {1: "screen", 2: "menu", 3: "state", 4: "statemachine", 5: "func"}


def find_decls(data, pool_start):
    """Procedure declarations in the code region: (offset, type, name, id)."""
    out = []
    for m in _DECL.finditer(data, 0, pool_start):
        pid = int.from_bytes(m.group(3), "little")
        if pid > 2000:
            continue
        out.append((m.start(), _TYPES[m.group(1)[0]],
                    m.group(2).decode("latin-1"), pid))
    return out


# ---------------------------------------------------------------- walker ----

BUILTINS = {
    0x00: "setmenutitle", 0x01: "setmenu",
    0x02: "setitem",         # setitem(nr, caption, enabled)
    0x04: "setscreen", 0x0c: "exit",
    0x0f: "scriptchange",    # loads another .IPO entirely
    0x10: "select", 0x11: "deselect", 0x13: "start", 0x17: "printscreen",
    # display statements (named from MUST_EXX + GSDS2 correlation)
    0x48: "text",            # text(row, col, str)
    0x49: "textout",         # textout(str, row, col)
    0x4a: "ftextout",        # ftextout(str, row, col, flagA, flagB)
    # digitalout(val, row, col, onText, offText). Two opcodes carry it and
    # the argument SHAPES tell them apart: 0x4b is (var,int,int,str,str) --
    # 990 sites, the common form -- while 0x4d takes all-variable arguments
    # (the caption strings held in variables). Only 0x4d was mapped, so
    # KLIMA_5B's I/O status decoded twelve captions and zero values.
    0x4b: "digitalout",
    0x4c: "analogout",       # analogout(val, row, col, min, max, wlo, whi, fmt)
    0x4d: "digitalout",
    # EDIABAS bridge
    0x62: "INPAapiJob",             # (sgbd, job, arg, resultfilter)
    0x63: "INPAapiResultText",      # (ref, key, set, fmt)
    # (ref, key, set) like its neighbours -- a plain numeric read, the value
    # then formatted by a helper (hex bytes, temperatures, counters). 5026
    # sites in 411 files; unmapped, it left captioned rows with no value.
    0x64: "INPAapiResultNumber",
    0x66: "INPAapiResultDigital",   # (ref, key, set)
    0x67: "INPAapiResultAnalog",    # (ref, key, set)
    0x69: "INPAapiCheckJobStatus",  # (status)
    # (key, set) with NO destination ref -- reads into an implicit slot that
    # 0x78 then copies out. 975 sites in 399 files, never once preceded by a
    # procref, which is what distinguishes it from 63/64/66/67.
    0x68: "INPAapiResultInto",
    0x78: "copyslot",               # (dst, src) -- always exactly two refs
}

_INLINE_OPS = {0x21, 0x22, 0x24}      # LINE/ITEM: label inline until \n


def walk(data, lo, hi, pool):
    """Token stream of one proc body. Yields dicts; counts unknown bytes."""
    toks, unknown = [], 0
    i = lo
    while i < hi:
        op = data[i]
        if op in _INLINE_OPS and i + 6 <= hi:
            # op + u16 0x000a + pad00 + u16 nr + caption 0a + second 0a
            #    + pad00 + u16 body-dwords
            # LINE's second string is its result-key list ("K1;K2"), usually
            # empty; when empty the tail bytes look like the old "block" token,
            # which is why GSDS2 parsed by accident and MS450 desynced.
            b = int.from_bytes(data[i + 4:i + 6], "little")
            j = data.find(b"\n", i + 6, min(hi, i + 220))
            if j >= 0:
                label = data[i + 6:j].decode("latin-1")
                j2 = data.find(b"\n", j + 1, min(hi, j + 260))
                second = data[j + 1:j2].decode("latin-1") if j2 >= 0 else ""
                if j2 >= 0 and j2 + 3 <= hi:
                    dwords = int.from_bytes(data[j2 + 2:j2 + 4], "little")
                    t = {"op": "ITEM" if op == 0x24 else "LINE",
                         "nr": b, "label": label, "dwords": dwords}
                    if second:
                        t["keys"] = second
                    toks.append(t)
                    i = j2 + 4
                    continue
        if i + 4 > hi:
            unknown += hi - i
            break
        b0, b1 = data[i], data[i + 1]
        u16 = int.from_bytes(data[i + 2:i + 4], "little")
        mid = int.from_bytes(data[i + 1:i + 3], "little")
        if b0 == 0x01 and b1 == 0x01:
            v = pool[u16] if u16 < len(pool) else ("?", u16)
            toks.append({"op": "const", "n": u16, "t": v[0], "v": v[1]})
        elif b0 == 0x01 and b1 in (0x00, 0x02, 0x03):
            # variable push: scope 0 global, 2/3 seen for locals/params
            toks.append({"op": "var", "n": u16, "sc": b1})
        elif b0 == 0x06 and b1 in (0x00, 0x01, 0x02, 0x03):
            toks.append({"op": "store", "n": u16, "sc": b1})
        elif b0 == 0x02:
            toks.append({"op": "procref", "kind": b1, "n": u16})
        elif b0 == 0x03:
            # int immediate, 3 bytes like its pool form
            toks.append({"op": "int", "v": mid})
            i += 3
            continue
        elif b0 == 0x09:
            toks.append({"op": "binop", "n": mid})
        elif b0 == 0x0a and b1 == 0x00:
            toks.append({"op": "block", "dwords": u16})
        elif b0 == 0x0b and b1 == 0x00:
            toks.append({"op": "jump", "n": u16})
        elif b0 == 0x0d:
            toks.append({"op": "op0d", "sub": b1, "n": u16})
        elif b0 == 0x05 and b1 == 0x00:
            toks.append({"op": "stmt", "n": u16})
        elif b0 == 0x0c and b1 == 0x80:
            toks.append({"op": "calluser", "n": u16})
        elif b0 == 0x0c and b1 == 0x81:
            toks.append({"op": "call", "n": u16,
                         "name": BUILTINS.get(u16, f"builtin_{u16:02x}")})
            # Builtin 06 names a STATE inline rather than through the pool:
            # "%Z_TOGGLE\n" follows the call, then a 5-byte tail, then the
            # next token. Not consuming it desynchronised everything after,
            # which is why LWS5's state machines read 87% unknown -- the whole
            # of its missing coverage. 121 files use this form.
            if u16 == 0x06:
                j = data.find(b"\n", i + 4, min(hi, i + 4 + 64))
                s = data[i + 4:j] if j >= 0 else b""
                if j >= 0 and s and all(0x20 <= c < 0x7f for c in s):
                    toks.append({"op": "state", "name": s.decode("latin-1")})
                    i = j + 6
                    continue
        elif b0 == 0x0f:
            toks.append({"op": "frame"})
        else:
            toks.append({"op": "unk", "bytes": data[i:i + 4].hex()})
            unknown += 4
        i += 4
    return toks, unknown, hi - lo


# ---------------------------------------------------------------- calls -----

def calls_of(toks):
    """Group tokens into calls: frame opens an arg list, call closes it."""
    out, args, items = [], [], []
    current_item = None
    for t in toks:
        if t["op"] in ("ITEM", "LINE"):
            current_item = t
            items.append(t)
            args = []
        elif t["op"] == "frame":
            args = []
        elif t["op"] in ("const", "var", "procref"):
            args.append(t)
        elif t["op"] == "binop":
            # fold arithmetic: keep the first var/const operand
            pass
        elif t["op"] in ("call", "calluser"):
            out.append({"call": t.get("name", f"user_{t['n']}"),
                        "n": t["n"], "args": list(args),
                        "item": (current_item or {}).get("label")})
            args = []
    return out, items


# ---------------------------------------------------------------- fields ----

_KEYISH = re.compile(r"^[A-Z][A-Z0-9_]{3,}$")


def screen_fields(toks, id2name=None):
    """One screen's content, semantically: title, jobs, lines, fields.

    Field emission follows the compiled call shapes:
      INPAapiResult*(ref slot, KEY, ...)   binds slot -> KEY
      analogout(<expr with slot>, row, col, min, max, ...)  -> analog field
      digitalout(<slot>, row, col, on, off)                 -> digital field
      calluser(KEY, row, col, [on, off])   per-ECU helper wrappers, matched
                                           by shape: key string + two ints
    Captions come from the nearest preceding text()/textout() in the same
    LINE block; units from a '[...]' caption or an _EINH-bound textout.
    """
    title = None
    jobs = []
    lines, cur_line = [], None
    fields = []
    bind = {}                 # var slot -> result key
    lastconst = {}            # var slot -> last stored literal
    last_caption = None       # (row, col, str)
    last_unit = None
    args = []
    pend_item = None

    def val(a):
        return a.get("v") if a["op"] in ("const",) else a

    def resolve_num(a):
        if a["op"] == "const" and a["t"] in ("i", "d"):
            return a["v"]
        if a["op"] == "var":
            lc = lastconst.get(a["n"])
            if lc is not None and isinstance(lc, (int, float)):
                return lc
        return None

    def expr_slot(seq):
        for a in seq:
            if a["op"] == "var":
                return a["n"]
        return None

    for t in toks:
        op = t["op"]
        if op == "LINE":
            cur_line = t["label"].strip() or None
            if cur_line:
                lines.append(cur_line)
            last_caption = last_unit = None
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
            if name == "ftextout" and strs:
                # first row-1 ftextout is the screen title; later ones are
                # row captions ("VIN :") for fields printed beside them
                if title is None and 1 in ints:
                    title = strs[0] or None
                elif strs[0].strip().rstrip(":").strip():
                    last_caption = strs[0].strip().rstrip(":").strip()
            if name in ("ftextout", "textout"):
                # a result var displayed as text IS a field (RDC prints its
                # per-wheel results this way rather than via analogout)
                slot = expr_slot(args)
                key = bind.get(slot)
                if key and not key.endswith("_EINH"):
                    f = {"kind": "text", "key": key,
                         "label": last_caption, "line": cur_line}
                    ir = [a["v"] for a in args
                          if a["op"] == "const" and a["t"] == "i"]
                    if len(ir) >= 2:
                        f["row"], f["col"] = ir[0], ir[1]
                    if not any(x.get("key") == key and x.get("kind") == "text"
                               for x in fields):
                        fields.append(f)
            elif name in ("text", "textout"):
                # text(row,col,str) / textout(str,row,col)
                s = strs[0] if strs else ""
                if s.startswith("[") or (args and args[0]["op"] == "const"
                                         and args[0]["t"] == "s"
                                         and s.startswith("[")):
                    last_unit = s.strip("[]").strip()
                elif "[" in s and s.endswith("]"):
                    last_unit = s[s.index("[") + 1:-1].strip()
                elif s.strip():
                    last_caption = s.strip()
                # unit read live: textout('['+VAR+']',row,col) with VAR
                # bound to an _EINH key
                slot = expr_slot(args)
                if slot is not None and bind.get(slot, "").endswith("_EINH"):
                    last_unit = {"fromKey": bind[slot]}
            elif name == "INPAapiJob":
                if len(strs) >= 2 and _KEYISH.match(strs[0] if not args or
                                                    args[0]["op"] != "var"
                                                    else strs[0]):
                    jobs.append(strs[0])
                elif strs:
                    jobs.append(strs[0])
            elif name in ("INPAapiResultText", "INPAapiResultAnalog",
                          "INPAapiResultDigital"):
                ref = next((a for a in args if a["op"] == "procref"
                            and a["kind"] == 0), None)
                key = next((s for s in strs if _KEYISH.match(s)), None)
                if ref is not None and key:
                    bind[ref["n"]] = key
            elif name == "analogout":
                slot = expr_slot(args)
                key = bind.get(slot)
                # args positionally: value, row, col, min, max, wlo, whi, fmt
                f = {"kind": "analog", "key": key,
                     "label": last_caption, "line": cur_line}
                ir = [a for a in args if a["op"] == "const" and a["t"] == "i"]
                if len(ir) >= 2:
                    f["row"], f["col"] = ir[0]["v"], ir[1]["v"]
                # numeric args AFTER the row/col pair, in arg order; a var
                # resolves to the first constant stored into it (a range like
                # rpm?2000:255 keeps the first branch's value)
                seen_ints = 0
                rng = []
                for a in args:
                    if a["op"] == "const" and a["t"] == "i":
                        seen_ints += 1
                        continue
                    if seen_ints < 2:
                        continue
                    v = resolve_num(a)
                    if v is not None:
                        rng.append(v)
                if len(rng) >= 2:
                    f["min"], f["max"] = rng[0], rng[1]
                if strs:
                    f["fmt"] = strs[-1]
                if isinstance(last_unit, dict):
                    f["unitKey"] = last_unit["fromKey"]
                elif last_unit:
                    f["unit"] = last_unit
                if key:
                    fields.append(f)
            elif name == "digitalout":
                slot = expr_slot(args)
                key = bind.get(slot)
                ir = [a["v"] for a in args if a["op"] == "const" and a["t"] == "i"]
                f = {"kind": "digital", "key": key,
                     "label": last_caption, "line": cur_line}
                if len(ir) >= 2:
                    f["row"], f["col"] = ir[0], ir[1]
                if len(strs) >= 2:
                    f["on"], f["off"] = strs[-2].strip(), strs[-1].strip()
                if key:
                    fields.append(f)
            elif op == "calluser":
                # per-ECU helper: any call shaped (KEY, row, col, [on, off])
                key = next((s for s in strs if _KEYISH.match(s)), None)
                if key and len(ints) >= 2:
                    f = {"kind": "digital" if len(strs) >= 3 else "analog",
                         "key": key, "label": last_caption, "line": cur_line,
                         "row": ints[0], "col": ints[1], "helper": t["n"]}
                    on_off = [s for s in strs if s != key]
                    if len(on_off) >= 2:
                        f["on"], f["off"] = on_off[0].strip(), on_off[1].strip()
                    if isinstance(last_unit, dict):
                        f["unitKey"] = last_unit["fromKey"]
                    elif last_unit:
                        f["unit"] = last_unit
                    fields.append(f)
            if name in ("analogout", "digitalout") or op == "calluser":
                lastconst.clear()
            args = []
    # LINE headers carry the authoritative pairing: the second inline string
    # is the line's result-key list, positionally aligned with the comma-split
    # caption ("Korrektur TI Bank1, Korrektur TI Bank2" <->
    # "STAT_INT_WERT;STAT_INT_2_WERT"). Build fields from that, then fold in
    # whatever the call stream discovered (row/col/min/max/unit) by key.
    bykey = {f["key"]: f for f in fields if f.get("key")}
    line_fields = []
    for t in toks:
        if t.get("op") != "LINE" or not t.get("keys"):
            continue
        caps = [c.strip() for c in (t.get("label") or "").split(",")]
        keys = [k.strip() for k in re.split(r"[;,]", t["keys"]) if k.strip()]
        for idx, k in enumerate(keys):
            f = dict(bykey.get(k) or {"kind": "analog", "key": k})
            if not f.get("label"):
                f["label"] = caps[idx] if idx < len(caps) and caps[idx]                     else (caps[0] if caps and caps[0] else None)
            f["line"] = (t.get("label") or "").strip() or None
            line_fields.append(f)
    if line_fields:
        seen = {f["key"] for f in line_fields}
        line_fields += [f for f in fields
                        if f.get("key") and f["key"] not in seen]
        fields = line_fields
    # loop-generated screens reuse one caption site for several reads; a label
    # shared by multiple text fields is positional junk ("Position RR"), and
    # no label beats a wrong one
    from collections import Counter
    lab_n = Counter(f.get("label") for f in fields
                    if f.get("kind") == "text" and f.get("label"))
    for f in fields:
        if f.get("kind") == "text" and lab_n.get(f.get("label"), 0) > 1:
            f["label"] = None
    return {"title": title, "jobs": jobs, "lines": lines, "fields": fields}


def decompile(ecu):
    """Every screen and menu of one ECU, fully decoded."""
    data, ps, pool, decls = load(ecu)
    if ps is None:
        return None
    id2name = {}
    for off, typ, name, pid in decls:
        id2name[(typ, pid)] = name
    screens, menus = {}, {}
    cov_unk = cov_len = 0
    for k, (off, typ, name, pid) in enumerate(decls):
        lo = off + 1 + len(name) + 1 + 4 + 1
        hi = decls[k + 1][0] if k + 1 < len(decls) else ps
        toks, unk, ln = walk(data, lo, hi, pool)
        cov_unk += unk
        cov_len += ln
        if typ == "screen":
            scr = screen_fields(toks)
            scr["id"] = pid
            scr["coverage"] = round(100 * (1 - unk / ln), 1) if ln else 100.0
            screens[name] = scr
        elif typ == "menu":
            cs, items = calls_of(toks)
            ent = []
            for c in cs:
                if c["call"] not in ("setscreen", "setmenu"):
                    continue
                ref = next((a for a in c["args"] if a["op"] == "procref"), None)
                if ref is None:
                    continue
                tgt = id2name.get(("screen" if ref["kind"] == 0x40 else "menu",
                                   ref["n"]))
                if c["item"] is None or not tgt:
                    continue
                if c["call"] == "setscreen":
                    ent.append({"label": c["item"].strip(), "target": tgt})
                else:
                    # the ITEM also switches the softkey MENU; that target is
                    # how a "Status" root item names its status menu even when
                    # the menu is not called m_status (RDC: m_rdc_status)
                    for e in reversed(ent):
                        if e["label"] == c["item"].strip():
                            e["menu"] = tgt
                            break
                    else:
                        ent.append({"label": c["item"].strip(), "menu": tgt})
            menus[name] = ent
    return {"ecu": ecu, "screens": screens, "menus": menus,
            "coverage": round(100 * (1 - cov_unk / cov_len), 1)
            if cov_len else 0.0}


# ---------------------------------------------------------------- main ------

def load(ecu):
    path = os.path.join(L1.SGDAT, ecu + ".IPO")
    data = open(path, "rb").read()
    ps, pool = find_pool(data)
    decls = find_decls(data, ps if ps else len(data))
    return data, ps, pool, decls


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--corpus" in sys.argv:
        files = sorted(glob.glob(os.path.join(L1.SGDAT, "*.IPO")))
        ok = bad = 0
        tot_unk = tot_len = 0
        for p in files:
            data = open(p, "rb").read()
            ps, pool = find_pool(data)
            if ps is None:
                bad += 1
                continue
            decls = find_decls(data, ps)
            if len(decls) < 3:
                bad += 1
                continue
            ok += 1
            for k, (off, typ, name, pid) in enumerate(decls):
                lo = off + 1 + len(name) + 1 + 4
                hi = decls[k + 1][0] if k + 1 < len(decls) else ps
                _, unk, ln = walk(data, lo, hi, pool)
                tot_unk += unk
                tot_len += ln
        print(f"{ok} files decompiled, {bad} failed")
        if tot_len:
            print(f"code coverage: {100*(1-tot_unk/tot_len):.1f}% "
                  f"({tot_unk} unknown of {tot_len} bytes)")
        return 0

    if not args:
        print(__doc__)
        return 0
    ecu = args[0]
    data, ps, pool, decls = load(ecu)
    print(f"{ecu}: pool at {ps} ({len(pool)} entries), {len(decls)} procs")
    if len(args) > 1:
        want = args[1]
        for k, (off, typ, name, pid) in enumerate(decls):
            if name != want:
                continue
            lo = off + 1 + len(name) + 1 + 4 + 1
            hi = decls[k + 1][0] if k + 1 < len(decls) else ps
            toks, unk, ln = walk(data, lo, hi, pool)
            print(f"\n{typ} {name} (id {pid}) {off}..{hi} "
                  f"unknown {unk}/{ln} bytes")
            for t in toks:
                print("  ", t)
            break
        return 0
    for k, (off, typ, name, pid) in enumerate(decls):
        lo = off + 1 + len(name) + 1 + 4 + 1
        hi = decls[k + 1][0] if k + 1 < len(decls) else ps
        toks, unk, ln = walk(data, lo, hi, pool)
        cs, items = calls_of(toks)
        print(f"  {typ:6} {name:26} id {pid:3}  {len(cs):3} calls  "
              f"{len(items):2} items/lines  unk {unk}/{ln}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
