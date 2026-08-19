#!/usr/bin/env python3
"""IPS/disassembly -> .IPO compiler, the inverse of ipo_disasm.py.

ipo_disasm.py reads an .IPO and prints what it *does*. This reads a textual
disassembly and writes the .IPO *back*, byte-for-byte. The text is a faithful,
lossless rendering of the file's structure -- header, every block header, every
4-byte instruction, the global-slot type table and the constant pool -- in the
INPA v5.x vocabulary (opcode / ValueType / scope names from ipo_disasm.py's
own tables). Because it is lossless, the pair

    .IPO  --(disassemble)-->  .ipsasm text  --(assemble)-->  .IPO

reproduces the original bytes exactly, which is what makes it a real compiler
and not a pretty-printer: hand-edit the text -- rename a proc, add an
instruction, change a literal -- assemble it, and INPA loads the result.

    python3 tools/decompile/ipo_compile.py --disasm foo.IPO           # -> stdout
    python3 tools/decompile/ipo_compile.py --disasm foo.IPO -o foo.ipsasm
    python3 tools/decompile/ipo_compile.py foo.ipsasm -o foo.IPO      # compile
    python3 tools/decompile/ipo_compile.py --roundtrip foo.IPO        # prove ==

Text format (ipsasm 1):
    .version <hi> <lo>
    .magic "<escaped bytes>"
    .block <type> id=<n> flags=<n> marker=<n> name="..." arg1="..." arg2="..."
        <one payload line per instruction / constant / global / table row>
    .end
Blank lines and lines starting with '#' or ';' are ignored. Instruction lines
are `<MNEMONIC> 0x<op1> <op2>`; the mnemonic maps 1:1 to the opcode byte, so the
three fields reconstruct the 4-byte word exactly. Everything that is not a plain
opcode (unknown bytes, raw literals) has an explicit escape hatch so no input is
un-representable.

Read-only against cars: files only.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_codec as C                                          # noqa: E402

# opcode byte <-> mnemonic (INPA v5.x)
OPCODES = {
    0x01: "LOAD", 0x02: "PUSHREF", 0x03: "LOADINOUTREF", 0x04: "NOP",
    0x05: "MOVE", 0x06: "PUSHR", 0x07: "PUSHREFSTORE", 0x08: "ALLOC",
    0x09: "ALU", 0x0a: "JMP", 0x0b: "JMPZ", 0x0c: "CALL", 0x0d: "CALLE",
    0x0e: "RET", 0x0f: "FRAME", 0x10: "LOGTABLE", 0x11: "PUSHIMM",
}
NAME_TO_OP = {v: k for k, v in OPCODES.items()}


# ---------------------------------------------------------------- escaping --

def esc(b):
    """bytes -> a double-quoted, byte-exact token."""
    out = ['"']
    for c in b:
        if c == 0x5c:
            out.append("\\\\")
        elif c == 0x22:
            out.append('\\"')
        elif c == 0x0a:
            out.append("\\n")
        elif 0x20 <= c < 0x7f:
            out.append(chr(c))
        else:
            out.append(f"\\x{c:02x}")
    out.append('"')
    return "".join(out)


def unesc(tok):
    """A double-quoted token -> exact bytes."""
    if len(tok) < 2 or tok[0] != '"' or tok[-1] != '"':
        raise C.IpoError(f"expected quoted token, got {tok!r}")
    s = tok[1:-1]
    out = bytearray()
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\":
            n = s[i + 1]
            if n == "\\":
                out.append(0x5c); i += 2
            elif n == '"':
                out.append(0x22); i += 2
            elif n == "n":
                out.append(0x0a); i += 2
            elif n == "x":
                out.append(int(s[i + 2:i + 4], 16)); i += 4
            else:
                raise C.IpoError(f"bad escape \\{n}")
        else:
            out.append(ord(c)); i += 1
    return bytes(out)


def _kv(line, key):
    """Pull key="..." out of a .block line, returning exact bytes."""
    marker = key + '="'
    i = line.find(marker)
    if i < 0:
        return b""
    i += len(key) + 1
    # find the matching closing quote, honouring backslash escapes
    j = i + 1
    while j < len(line):
        if line[j] == "\\":
            j += 2
            continue
        if line[j] == '"':
            break
        j += 1
    return unesc(line[i:j + 1])


def _kvint(line, key, default=0):
    import re
    m = re.search(rf"\b{key}=(-?\d+)", line)
    return int(m.group(1)) if m else default


# ---------------------------------------------------------------- disasm ----

def disassemble(data):
    """`.IPO` bytes -> ipsasm text (lossless)."""
    f = C.read(data)
    L = []
    L.append("# ipsasm 1  --  lossless textual .IPO (ipo_compile.py)")
    L.append(f".version {f.ver_hi} {f.ver_lo}")
    L.append(f".magic {esc(f.magic)}")
    L.append("")
    for b in f.blocks:
        tname = C.BLOCK_NAMES.get(b.type, f"0x{b.type:02x}")
        L.append(f".block {tname} id={b.block_id} flags={b.flags} "
                 f"marker={b.marker} name={esc(b.name)} "
                 f"arg1={esc(b.arg1)} arg2={esc(b.arg2)}")
        if b.is_code():
            for op, a, c in b.instructions():
                mn = OPCODES.get(op, f"OP_0x{op:02x}")
                cm = _instr_comment(op, a, c)
                L.append(f"    {mn} 0x{a:02x} {c}" + (f"    ; {cm}" if cm else ""))
        elif b.type == C.BLOCK_GLOBALDATA:
            for t in b.globals():
                L.append(f"    {C.VT_NAMES.get(t, f'0x{t:02x}')}")
        elif b.type == C.BLOCK_CONSTANTDATA:
            for t, v in b.constants():
                L.append("    " + _const_line(t, v))
        elif b.type == C.BLOCK_LOGICTABLE:
            p = b.payload
            for i in range(0, len(p), 12):
                v, m, o = (int.from_bytes(p[i:i + 4], "little"),
                           int.from_bytes(p[i + 4:i + 8], "little"),
                           int.from_bytes(p[i + 8:i + 12], "little"))
                L.append(f"    entry 0x{v:08x} 0x{m:08x} 0x{o:08x}")
        else:
            L.append(f"    raw {b.payload.hex()}")
        L.append(".end")
        L.append("")
    return "\n".join(L) + "\n"


def _instr_comment(op, a, c):
    mn = OPCODES.get(op)
    if mn in ("LOAD", "PUSHREF", "LOADINOUTREF", "PUSHR", "PUSHREFSTORE"):
        sc = {0x00: "global", 0x01: "const", 0x02: "local", 0x40: "screen",
              0x41: "menu", 0x42: "statemachine"}.get(a, f"0x{a:02x}")
        return f"{sc} #{c}"
    if mn in ("ALLOC", "PUSHIMM"):
        tm = {0x50: "bool", 0x51: "int", 0x52: "byte", 0x53: "long",
              0x54: "real", 0x55: "string", 0x56: "object",
              0x57: "ulong"}.get(a, f"0x{a:02x}")
        return f"{tm}" + (f" {c}" if mn == "PUSHIMM" else "")
    if mn == "ALU":
        return {0x60: "add", 0x61: "sub", 0x62: "mul", 0x63: "div",
                0x64: "lt", 0x65: "gt", 0x66: "le", 0x67: "ge", 0x68: "eq",
                0x69: "ne", 0x6a: "and", 0x6b: "or", 0x6c: "xor", 0x6d: "neg",
                0x6e: "not", 0x6f: "band", 0x70: "bor",
                0x71: "bxor"}.get(a, "")
    if mn == "CALL":
        return {0x80: f"user #{c}", 0x81: f"system #{c}"}.get(a, "")
    return ""


def _const_line(t, v):
    name = C.VT_NAMES.get(t, f"0x{t:02x}")
    if t == C.VT_STRING:
        return f"string {esc(v)}"
    if t == C.VT_BOOL:
        return f"bool {1 if v else 0}"
    if t == C.VT_REAL:
        # repr() round-trips IEEE754 exactly in CPython; keep a hex fallback
        # so a value that somehow does not re-pack identically is still exact.
        import struct
        if struct.pack("<d", float(repr(v))) == struct.pack("<d", v):
            return f"real {v!r}"
        return f"real# {struct.pack('<d', v).hex()}"
    return f"{name} {v}"


# ---------------------------------------------------------------- assemble --

def assemble(text):
    """ipsasm text -> `.IPO` bytes."""
    ver_hi = ver_lo = 0
    magic = C.MAGIC_DEFAULT
    blocks = []
    cur = None          # (header dict, payload accumulator list)

    def flush():
        nonlocal cur
        if cur is None:
            return
        hdr, lines = cur
        payload, size = _assemble_payload(hdr["type"], lines)
        blocks.append(C.Block(hdr["type"], hdr["name"], hdr["id"],
                              hdr["flags"], hdr["arg1"], hdr["arg2"],
                              hdr["marker"], size, payload))
        cur = None

    for raw in text.splitlines():
        line = raw.rstrip("\n")
        s = line.strip()
        if not s or s[0] in "#;":
            continue
        if s.startswith(".version"):
            _, hi, lo = s.split()
            ver_hi, ver_lo = int(hi), int(lo)
        elif s.startswith(".magic"):
            magic = unesc(s[len(".magic"):].strip())
        elif s.startswith(".block"):
            flush()
            tname = s.split()[1]
            btype = C.NAME_TO_BLOCK.get(tname)
            if btype is None:
                btype = int(tname, 16) if tname.startswith("0x") \
                    else int(tname)
            hdr = {"type": btype, "id": _kvint(s, "id"),
                   "flags": _kvint(s, "flags"), "marker": _kvint(s, "marker"),
                   "name": _kv(s, "name"), "arg1": _kv(s, "arg1"),
                   "arg2": _kv(s, "arg2")}
            cur = (hdr, [])
        elif s == ".end":
            flush()
        else:
            if cur is None:
                raise C.IpoError(f"payload line outside a .block: {s!r}")
            cur[1].append(line)
    flush()
    return C.IpoFile(ver_hi, ver_lo, magic, blocks).write()


def _strip_comment(s):
    # a ';' inside a quoted string is data; only an unquoted ';' starts a note
    q = False
    for i, ch in enumerate(s):
        if ch == '"':
            q = not q
        elif ch == ";" and not q:
            return s[:i].rstrip()
    return s.rstrip()


def _assemble_payload(btype, lines):
    body = [_strip_comment(x.strip()) for x in lines]
    body = [x for x in body if x]
    if btype in C.CODE_BLOCKS:
        instrs = []
        for x in body:
            parts = x.split()
            mn = parts[0]
            op = NAME_TO_OP.get(mn)
            if op is None:
                if mn.startswith("OP_0x"):
                    op = int(mn[5:], 16)
                else:
                    raise C.IpoError(f"unknown mnemonic {mn!r}")
            a = int(parts[1], 16) if parts[1].startswith("0x") else int(parts[1])
            c = int(parts[2], 0)
            instrs.append((op, a, c))
        buf = bytearray()
        for op, a, c in instrs:
            w = (op & 0xff) | ((a & 0xff) << 8) | ((c & 0xffff) << 16)
            buf += w.to_bytes(4, "little")
        return bytes(buf), len(instrs)
    if btype == C.BLOCK_GLOBALDATA:
        buf = bytearray()
        for x in body:
            t = C.NAME_TO_VT.get(x.split()[0])
            if t is None:
                t = int(x.split()[0], 0)
            buf.append(t)
        return bytes(buf), len(buf)
    if btype == C.BLOCK_CONSTANTDATA:
        entries = []
        for x in body:
            entries.append(_parse_const(x))
        return C._encode_constants(entries), len(entries)
    if btype == C.BLOCK_LOGICTABLE:
        buf = bytearray()
        n = 0
        for x in body:
            _, v, m, o = x.split()
            buf += int(v, 0).to_bytes(4, "little")
            buf += int(m, 0).to_bytes(4, "little")
            buf += int(o, 0).to_bytes(4, "little")
            n += 1
        return bytes(buf), n
    # raw fallback
    for x in body:
        if x.startswith("raw "):
            hexs = x[4:].strip()
            data = bytes.fromhex(hexs)
            return data, len(data)
    return b"", 0


def _parse_const(x):
    import struct
    parts = x.split(None, 1)
    kind = parts[0]
    rest = parts[1] if len(parts) > 1 else ""
    if kind == "string":
        return (C.VT_STRING, unesc(rest.strip()))
    if kind == "bool":
        return (C.VT_BOOL, int(rest.strip()) != 0)
    if kind == "real":
        return (C.VT_REAL, float(rest.strip()))
    if kind == "real#":
        return (C.VT_REAL, struct.unpack("<d", bytes.fromhex(rest.strip()))[0])
    t = C.NAME_TO_VT.get(kind)
    if t is None:
        t = int(kind, 0)
    return (t, int(rest.strip(), 0))


# ---------------------------------------------------------------- main ------

def main():
    args = sys.argv[1:]
    if not args or "-h" in args or "--help" in args:
        print(__doc__)
        return 0
    out = None
    if "-o" in args:
        k = args.index("-o")
        out = args[k + 1]
        del args[k:k + 2]
    if args and args[0] == "--roundtrip":
        data = open(args[1], "rb").read()
        text = disassemble(data)
        back = assemble(text)
        ok = back == data
        print(f"{args[1]}: disasm->assemble byte-identical="
              f"{'OK' if ok else 'MISMATCH'} ({len(data)} bytes)")
        return 0 if ok else 1
    if args and args[0] == "--disasm":
        data = open(args[1], "rb").read()
        text = disassemble(data)
        if out:
            open(out, "w").write(text)
            print(f"wrote {out} ({len(text)} bytes)")
        else:
            sys.stdout.write(text)
        return 0
    # default: compile a .ipsasm file to .IPO
    text = open(args[0]).read()
    data = assemble(text)
    if out:
        open(out, "wb").write(data)
        print(f"wrote {out} ({len(data)} bytes)")
    else:
        sys.stdout.buffer.write(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
