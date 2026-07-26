#!/usr/bin/env python3
"""Recover the ARGUMENT each INPA softkey sends, from .IPO bytecode.

extract_menus() gives the menu tree, but an item that drives an actuator or
steps a value carries no setscreen target -- its behaviour is compiled. The
value it sends is still there, in a table the compiler emits right beside the
menu's labels:

    03 <fkey> 00  06 <label>\\n  03 <value> 00
    03 01 00      06 "E 15%"\\n  03 10 00      -> F1 "E 15%" sends 16
    03 02 00      06 "E 50%"\\n  03 32 00      -> F2 "E 50%" sends 50
    03 04 00      06 "E DME"\\n  03 ff 00      -> F4 releases control (255)

That triple also matches unrelated code, so a match only counts inside a RUN of
three or more with consecutive F-key numbers -- a real menu numbers its keys
1,2,3... A lone triple is noise.

Verified against known-good values: the e-fan reads 16/50/91 where the
hand-checked ACTIVATION_SPEC has percent 0-99, EKP reads 1/0 where INPA's
m_ekp shows EIN/AUS, and 255 consistently means "release back to the DME".

    python3 tools/ipo_actions.py MS450.IPO          # print the tables
    python3 tools/ipo_actions.py MS450.IPO --json   # machine-readable
"""
import os
import re
import sys
import json

SGDAT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "vendor", "EC-APPS", "INPA", "SGDAT")

# 03 <k> 00  06 <label> 0a  03 <v> 00
_TRIPLE = re.compile(rb"\x03(.)\x00\x06([\x20-\x7e\xa0-\xff]{1,28})\x0a\x03(.)\x00",
                     re.DOTALL)
# a released/idle output hands control back to the DME
RELEASE = 0xFF
MIN_RUN = 3          # a real menu numbers at least three keys in order

# The value table stores a step's MAGNITUDE only: "+10" and "-10" both read 10,
# "+" and "--" both read 1. The sign is an opcode emitted after the label — the
# minus keys negate the pushed value, the plus keys do not. Without this a CO or
# idle adjustment would step the wrong way.
_NEGATE = b"\x09\x6d"
# far enough to clear the handler reference, which varies in length, but not so
# far that the NEXT key's opcodes leak in — an ITEM is ~24 bytes apart
_NEG_SCAN = 22


def key_is_negative(data, item_end):
    """True when this softkey subtracts rather than adds.

    The negate opcode sits after the key's handler reference, whose length
    varies, so this scans a short window rather than checking a fixed offset.
    The window stops short of the next ITEM so a neighbouring minus key cannot
    be mistaken for this one's sign.
    """
    window = data[item_end:item_end + _NEG_SCAN]
    nxt = window.find(b"\x24\x0a\x00\x00")     # the next ITEM opcode
    if nxt >= 0:
        window = window[:nxt]
    return _NEGATE in window


def action_tables(data):
    """[{offset, items:[{fkey, label, value}]}] for every softkey value table."""
    rows = []
    for m in _TRIPLE.finditer(data):
        rows.append({
            "start": m.start(), "end": m.end(),
            "fkey": m.group(1)[0],
            "label": m.group(2).decode("latin-1").strip(),
            "value": m.group(3)[0],
        })

    tables, run = [], []
    for r in rows:
        # same table: adjacent bytes and the next F-key in sequence
        if run and r["start"] - run[-1]["end"] <= 2 and r["fkey"] == run[-1]["fkey"] + 1:
            run.append(r)
            continue
        if len(run) >= MIN_RUN:
            tables.append(run)
        run = [r]
    if len(run) >= MIN_RUN:
        tables.append(run)

    # A key's sign lives on its ITEM opcode, not in the value table, so look it
    # up by label. A label like "-10" appears once per menu, and the sign is a
    # property of the caption itself ("-" always subtracts), so matching on the
    # label is safe even when two menus share one.
    import ipo_layout as _L
    negative = {}
    for m in _L._RE_ITEM.finditer(data):
        lab = _L.fix_de(m.group(2).decode("latin-1")).strip()
        if lab and key_is_negative(data, m.end()):
            negative[lab] = True

    out = []
    for t in tables:
        items = []
        for r in t:
            it = {"fkey": r["fkey"], "label": r["label"], "value": r["value"],
                  "release": r["value"] == RELEASE}
            if negative.get(r["label"]):
                it["negative"] = True
                it["value"] = -r["value"]     # the step really subtracts
            items.append(it)
        out.append({"offset": t[0]["start"], "items": items})
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    name = args[0] if args else "MS450.IPO"
    path = name if os.path.exists(name) else os.path.join(SGDAT, name)
    with open(path, "rb") as f:
        data = f.read()

    tables = action_tables(data)
    if "--json" in sys.argv:
        json.dump(tables, sys.stdout, ensure_ascii=False, indent=1)
        return 0

    print(f"{len(tables)} softkey value tables in {os.path.basename(path)}\n")
    for t in tables:
        keys = ", ".join(
            f"F{i['fkey']}:{i['label']!r}="
            + ("release" if i["release"] else str(i["value"]))
            for i in t["items"])
        print(f"  @0x{t['offset']:06x}  {keys}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
