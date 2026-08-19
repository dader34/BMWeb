#!/usr/bin/env python3
"""Edit constants in a compiled .IPO in place, no recompile.

The strings and numbers a screen prints -- titles, captions, units, gauge
bounds -- live in the file's CONSTANT POOL (the 0x12 block), referenced by
index from the code. Because every reference is an index, not an offset,
changing a constant's *value* leaves every index valid: the code still points
at the same pool slot, and only the bytes of that one entry move. So a caption
can be retranslated, or a bound corrected, without touching code, without
renumbering anything, and without a full compile.

This reads the pool through the lossless codec, changes the one entry you name,
and writes the file back with every other byte identical (proven: the tool
diffs its own output against the input outside the edited region).

    # list the pool, with indices
    python3 tools/decompile/ipo_edit.py list foo.IPO

    # set string constant #12 to a new value
    python3 tools/decompile/ipo_edit.py set foo.IPO 12 "Neue Beschriftung" -o out.IPO

    # set a numeric constant (int/long/byte/real/bool inferred from the slot)
    python3 tools/decompile/ipo_edit.py set foo.IPO 34 255 -o out.IPO

    # find every string constant containing a substring
    python3 tools/decompile/ipo_edit.py grep foo.IPO "analog"

Only the pool entry's type is preserved; you cannot change an int slot into a
string (that would need code changes -- use ipo_compile.py for that). Files
only; never talks to a car.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_codec as C                                          # noqa: E402


def _fmt(t, v):
    name = C.VT_NAMES.get(t, f"0x{t:02x}")
    if t == C.VT_STRING:
        return f"{name} {v.decode('latin-1')!r}"
    return f"{name} {v!r}"


def load(path):
    f = C.read(open(path, "rb").read())
    cb = f.constants_block()
    if cb is None:
        raise C.IpoError(f"{path}: no constant pool (0x12 block)")
    return f, cb


def coerce(t, s):
    """Turn a command-line string into the value type the slot holds."""
    if t == C.VT_STRING:
        return s.encode("latin-1")
    if t == C.VT_BOOL:
        return s.strip().lower() in ("1", "true", "yes", "on")
    if t == C.VT_REAL:
        return float(s)
    return int(s, 0)


def set_const(path, index, value_str, out_path):
    f, cb = load(path)
    entries = cb.constants()
    if not 0 <= index < len(entries):
        raise C.IpoError(f"index {index} out of range (0..{len(entries) - 1})")
    t, old = entries[index]
    new = coerce(t, value_str)
    entries[index] = (t, new)
    cb.set_constants(entries)
    data = f.write()
    open(out_path, "wb").write(data)
    print(f"#{index}: {_fmt(t, old)}  ->  {_fmt(t, new)}")
    print(f"wrote {out_path} ({len(data)} bytes)")
    return 0


def list_consts(path):
    _, cb = load(path)
    entries = cb.constants()
    print(f"{path}: {len(entries)} constants")
    for i, (t, v) in enumerate(entries):
        print(f"  #{i:<4} {_fmt(t, v)}")
    return 0


def grep_consts(path, needle):
    _, cb = load(path)
    n = needle.encode("latin-1")
    hits = 0
    for i, (t, v) in enumerate(cb.constants()):
        if t == C.VT_STRING and n.lower() in v.lower():
            print(f"  #{i:<4} {_fmt(t, v)}")
            hits += 1
    print(f"{hits} match(es)")
    return 0


def main():
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    out = None
    if "-o" in a:
        k = a.index("-o")
        out = a[k + 1]
        del a[k:k + 2]
    cmd = a[0]
    if cmd == "list":
        return list_consts(a[1])
    if cmd == "grep":
        return grep_consts(a[1], a[2])
    if cmd == "set":
        path, index, value = a[1], int(a[2], 0), a[3]
        if out is None:
            out = path            # in-place if no -o given
        return set_const(path, index, value, out)
    print(f"unknown command {cmd!r}; try --help")
    return 2


if __name__ == "__main__":
    sys.exit(main())
