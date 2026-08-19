#!/usr/bin/env python3
"""Lossless .IPO block codec -- the inverse of the layout ipo_disasm.py reads.

ipo_disasm.py decompiles an .IPO into *meaning* (screens, fields, calls); it
throws away the file scaffolding to do it. This module is the other half: a
byte-exact reader/writer for the file's structure, so a tool can take a
compiled .IPO apart, change something, and put it back together with every
other byte where INPACOMP left it.

FILE LAYOUT (v5.x, what INPA's SGDAT ships; the same layout NCSEXPERT's v1.x
files use, only the type-byte vocabulary differs -- see ipo_disasm.py and the
version notes below)

    HEADER      <u8 verHi> <u8 verLo> <ascii magic> 0a
    BLOCK*      one after another until EOF, each:
        <u8 type> <name> 0a <u16 id> <u16 flags> <arg1> 0a <arg2> 0a
        <u8 marker> <u16 size> <payload>
      payload depends on type:
        01 SCREEN 02 MENU 03 STATEMACHINE 05 FUNCTION
        21 SCREENFUNC 22 LINEFUNC 23 CONTROLFUNC 24 MENUITEMFUNC 25 STATEFUNC
                        size * 4 bytes, each a u32LE instruction
                        (opcode | op1<<8 | op2<<16)
        11 GLOBALDATA   size type bytes (one ValueType per global slot)
        12 CONSTANTDATA size typed literals -- the constant pool:
                        <u8 type> then Bool u8 | Byte u8 | Int s16 | Long s32
                        | Real f64 | String <ascii> 0a
                        | ULong/Numeric/Object s32
        04 LOGICTABLE   size * 12 bytes (u32 value, u32 mask, u32 out)

Blocks are self-delimiting: the header names the payload length (via `size` and
the type), so the whole file tiles with no gaps -- exactly how INPA's own parser
walks it. Reading then writing reproduces the input byte-for-byte; that identity
is what the editor and the compiler round-trip stand on.

Read-only against cars: this only ever touches files.
"""
import struct

MAGIC_DEFAULT = b"TEST-Infotext"
SEP = 0x0a

# Block type bytes (INPA v5.x).
BLOCK_SCREEN = 0x01
BLOCK_MENU = 0x02
BLOCK_STATEMACHINE = 0x03
BLOCK_LOGICTABLE = 0x04
BLOCK_FUNCTION = 0x05
BLOCK_GLOBALDATA = 0x11
BLOCK_CONSTANTDATA = 0x12
BLOCK_SCREENFUNC = 0x21
BLOCK_LINEFUNC = 0x22
BLOCK_CONTROLFUNC = 0x23
BLOCK_MENUITEMFUNC = 0x24
BLOCK_STATEFUNC = 0x25

BLOCK_NAMES = {
    BLOCK_SCREEN: "screen", BLOCK_MENU: "menu",
    BLOCK_STATEMACHINE: "statemachine", BLOCK_LOGICTABLE: "logictable",
    BLOCK_FUNCTION: "function", BLOCK_GLOBALDATA: "globaldata",
    BLOCK_CONSTANTDATA: "constantdata", BLOCK_SCREENFUNC: "screenfunc",
    BLOCK_LINEFUNC: "linefunc", BLOCK_CONTROLFUNC: "controlfunc",
    BLOCK_MENUITEMFUNC: "menuitemfunc", BLOCK_STATEFUNC: "statefunc",
}
NAME_TO_BLOCK = {v: k for k, v in BLOCK_NAMES.items()}

# Blocks whose payload is `size` 4-byte instruction words.
CODE_BLOCKS = {
    BLOCK_SCREEN, BLOCK_MENU, BLOCK_STATEMACHINE, BLOCK_FUNCTION,
    BLOCK_SCREENFUNC, BLOCK_LINEFUNC, BLOCK_CONTROLFUNC, BLOCK_MENUITEMFUNC,
    BLOCK_STATEFUNC,
}

# ValueType bytes (v5.x). Int is s16, Long/ULong/Numeric/Object s32, Real f64.
VT_VOID = 0x00
VT_BOOL = 0x01
VT_BYTE = 0x02
VT_INT = 0x03
VT_LONG = 0x04
VT_REAL = 0x05
VT_STRING = 0x06
VT_ULONG = 0x07
VT_NUMERIC = 0x08
VT_OBJECT = 0x09

VT_NAMES = {
    VT_VOID: "void", VT_BOOL: "bool", VT_BYTE: "byte", VT_INT: "int",
    VT_LONG: "long", VT_REAL: "real", VT_STRING: "string", VT_ULONG: "ulong",
    VT_NUMERIC: "numeric", VT_OBJECT: "object",
}
NAME_TO_VT = {v: k for k, v in VT_NAMES.items()}


class IpoError(Exception):
    pass


class Block:
    """One block header plus its raw payload bytes.

    The payload is kept verbatim so write() is a pure inverse of read(); the
    typed views (instructions / constants / globals) decode it on demand and
    re-encode it when a tool asks to change something.
    """

    __slots__ = ("type", "name", "block_id", "flags", "arg1", "arg2",
                 "marker", "size", "payload")

    def __init__(self, type, name, block_id, flags, arg1, arg2, marker, size,
                 payload):
        self.type = type
        self.name = name            # bytes, latin-1 on the wire
        self.block_id = block_id
        self.flags = flags
        self.arg1 = arg1            # bytes
        self.arg2 = arg2            # bytes
        self.marker = marker
        self.size = size
        self.payload = payload      # bytes

    # -- typed views ---------------------------------------------------------

    def is_code(self):
        return self.type in CODE_BLOCKS

    def instructions(self):
        """[(opcode, op1, op2)] for a code block."""
        if not self.is_code():
            raise IpoError(f"block type 0x{self.type:02x} has no instructions")
        out = []
        for i in range(0, len(self.payload), 4):
            w = int.from_bytes(self.payload[i:i + 4], "little")
            out.append((w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xffff))
        return out

    def set_instructions(self, instrs):
        buf = bytearray()
        for op, a, b in instrs:
            w = (op & 0xff) | ((a & 0xff) << 8) | ((b & 0xffff) << 16)
            buf += w.to_bytes(4, "little")
        self.payload = bytes(buf)
        self.size = len(instrs)

    def globals(self):
        """[type_byte] for a GLOBALDATA block."""
        if self.type != BLOCK_GLOBALDATA:
            raise IpoError("not a globaldata block")
        return list(self.payload)

    def constants(self):
        """[(type_byte, value)] for a CONSTANTDATA block.

        Strings come back as bytes (their on-wire form, LF stripped); numbers
        as int/float; bool as bool. Real keeps its exact 8 wire bytes too so a
        value the tool does not touch re-encodes bit-for-bit.
        """
        if self.type != BLOCK_CONSTANTDATA:
            raise IpoError("not a constantdata block")
        return _decode_constants(self.payload, self.size)

    def set_constants(self, entries):
        self.payload = _encode_constants(entries)
        self.size = len(entries)


# ---------------------------------------------------------------- constants -

def _decode_constants(payload, count):
    out, i, n = [], 0, len(payload)
    for _ in range(count):
        if i >= n:
            raise IpoError("constant pool truncated")
        t = payload[i]
        i += 1
        if t == VT_BOOL:
            out.append((t, payload[i] != 0))
            i += 1
        elif t == VT_BYTE:
            out.append((t, payload[i]))
            i += 1
        elif t == VT_INT:
            out.append((t, struct.unpack_from("<h", payload, i)[0]))
            i += 2
        elif t in (VT_LONG, VT_ULONG, VT_NUMERIC, VT_OBJECT):
            out.append((t, struct.unpack_from("<i", payload, i)[0]))
            i += 4
        elif t == VT_REAL:
            out.append((t, struct.unpack_from("<d", payload, i)[0]))
            i += 8
        elif t == VT_STRING:
            j = payload.find(b"\n", i)
            if j < 0:
                raise IpoError("unterminated pool string")
            out.append((t, payload[i:j]))
            i = j + 1
        else:
            raise IpoError(f"unknown constant type 0x{t:02x}")
    return out


def _encode_constants(entries):
    buf = bytearray()
    for t, v in entries:
        buf.append(t)
        if t == VT_BOOL:
            buf.append(1 if v else 0)
        elif t == VT_BYTE:
            buf.append(int(v) & 0xff)
        elif t == VT_INT:
            buf += struct.pack("<h", int(v))
        elif t in (VT_LONG, VT_ULONG, VT_NUMERIC, VT_OBJECT):
            buf += struct.pack("<i", _as_s32(int(v)))
        elif t == VT_REAL:
            buf += struct.pack("<d", float(v))
        elif t == VT_STRING:
            b = v if isinstance(v, (bytes, bytearray)) else str(v).encode(
                "latin-1")
            buf += bytes(b)
            buf.append(SEP)
        else:
            raise IpoError(f"cannot encode constant type 0x{t:02x}")
    return bytes(buf)


def _as_s32(v):
    v &= 0xffffffff
    return v - 0x100000000 if v >= 0x80000000 else v


# ---------------------------------------------------------------- file ------

class IpoFile:
    """Header fields plus the ordered block list. write() inverts read()."""

    __slots__ = ("ver_hi", "ver_lo", "magic", "blocks")

    def __init__(self, ver_hi, ver_lo, magic, blocks):
        self.ver_hi = ver_hi
        self.ver_lo = ver_lo
        self.magic = magic          # bytes
        self.blocks = blocks

    def find(self, type):
        return [b for b in self.blocks if b.type == type]

    def constants_block(self):
        b = self.find(BLOCK_CONSTANTDATA)
        return b[0] if b else None

    def globals_block(self):
        b = self.find(BLOCK_GLOBALDATA)
        return b[0] if b else None

    def write(self):
        out = bytearray()
        out.append(self.ver_hi & 0xff)
        out.append(self.ver_lo & 0xff)
        out += self.magic
        out.append(SEP)
        for b in self.blocks:
            out.append(b.type & 0xff)
            out += b.name
            out.append(SEP)
            out += struct.pack("<HH", b.block_id & 0xffff, b.flags & 0xffff)
            out += b.arg1
            out.append(SEP)
            out += b.arg2
            out.append(SEP)
            out.append(b.marker & 0xff)
            out += struct.pack("<H", b.size & 0xffff)
            out += b.payload
        return bytes(out)


class _Reader:
    def __init__(self, data):
        self.d = data
        self.i = 0
        self.n = len(data)

    def u8(self):
        v = self.d[self.i]
        self.i += 1
        return v

    def u16(self):
        v = struct.unpack_from("<H", self.d, self.i)[0]
        self.i += 2
        return v

    def strz(self):
        j = self.d.find(b"\n", self.i)
        if j < 0:
            raise IpoError(f"unterminated string at {self.i}")
        s = self.d[self.i:j]
        self.i = j + 1
        return s


def _payload_len(reader, type, size):
    """How many bytes the payload of a block of this type/size occupies."""
    if type in CODE_BLOCKS:
        return size * 4
    if type == BLOCK_GLOBALDATA:
        return size
    if type == BLOCK_LOGICTABLE:
        return size * 12
    if type == BLOCK_CONSTANTDATA:
        # variable-length: walk `size` typed entries
        i = reader.i
        d = reader.d
        for _ in range(size):
            t = d[i]
            i += 1
            if t == VT_BOOL or t == VT_BYTE:
                i += 1
            elif t == VT_INT:
                i += 2
            elif t in (VT_LONG, VT_ULONG, VT_NUMERIC, VT_OBJECT):
                i += 4
            elif t == VT_REAL:
                i += 8
            elif t == VT_STRING:
                j = d.find(b"\n", i)
                if j < 0:
                    raise IpoError("unterminated pool string")
                i = j + 1
            else:
                raise IpoError(f"unknown constant type 0x{t:02x}")
        return i - reader.i
    # unknown block: the reference skips `size` bytes
    return size


def read(data):
    """Parse .IPO bytes into an IpoFile. write() reproduces `data` exactly."""
    r = _Reader(data)
    ver_hi = r.u8()
    ver_lo = r.u8()
    magic = r.strz()
    blocks = []
    while r.i < r.n:
        type = r.u8()
        name = r.strz()
        block_id = r.u16()
        flags = r.u16()
        arg1 = r.strz()
        arg2 = r.strz()
        marker = r.u8()
        size = r.u16()
        plen = _payload_len(r, type, size)
        payload = r.d[r.i:r.i + plen]
        if len(payload) != plen:
            raise IpoError(f"block payload truncated at {r.i}")
        r.i += plen
        blocks.append(Block(type, name, block_id, flags, arg1, arg2, marker,
                            size, payload))
    return IpoFile(ver_hi, ver_lo, magic, blocks)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)
    data = open(sys.argv[1], "rb").read()
    f = read(data)
    ok = f.write() == data
    print(f"{sys.argv[1]}: v{f.ver_hi}.{f.ver_lo} magic={f.magic!r} "
          f"{len(f.blocks)} blocks  round-trip={'OK' if ok else 'MISMATCH'}")
    for b in f.blocks:
        extra = ""
        if b.type == BLOCK_CONSTANTDATA:
            extra = f"  ({b.size} constants)"
        elif b.type == BLOCK_GLOBALDATA:
            extra = f"  ({b.size} globals)"
        elif b.is_code():
            extra = f"  ({b.size} instr)"
        print(f"  {BLOCK_NAMES.get(b.type, hex(b.type)):13} "
              f"id={b.block_id:<4} name={b.name.decode('latin-1')!r}{extra}")
    sys.exit(0 if ok else 1)
