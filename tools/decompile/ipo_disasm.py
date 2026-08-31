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

CODE               self-delimiting tokens, ALL 4 bytes except the inline
    headers. Cracked line-by-line against BMW_STD.H's own function bodies
    (instr, trimstr, space, ExtraScript ... BMW ships source AND compiled
    artifact side by side), so each of these is correlation-proven:

    01 00 <u16>       push GLOBAL slot n
    01 01 <u16>       push CONSTANT pool[n]        <- the missing linkage
    01 02 <u16>       push param/local slot n (params first, then locals)
    03 02 <u16>       push THROUGH a reference param (deref read: reading an
                      out/inout param's value -- trimstr's `Temp=Text`).
                      Earlier read as a 3-byte int immediate, which desynced
                      every proc that touches an inout param.
    06 <sc> <u16>     store into slot n
    07 02 <u16>       store THROUGH a reference param (instr's `pos=i`)
    08 <5x> 00 00     local DECLARATION, one per uninitialised local, in
                      source order: 50=bool 51=int 53=long 55=string proven
                      (instr: string,int,int,int,bool = 55,51,51,51,50);
                      52=byte 54=real inferred from the two remaining INPA
                      types. An initialised local declares as a bare const
                      push instead (space: s100/s10/s1 then 08 51 for i).
    02 <k> <u16>      push proc reference (k: 40=screen 41=menu, 3e/3f seen)
    09 <u16> 00       binary operator, see BINOPS
    0a 00 <u16>       FIRST token: block header, u16 = dword index where the
                      proc's prologue/INIT ends. Anywhere else: unconditional
                      JUMP to dword index u16 (while-loop back edges, else
                      skips). Targets are relative to the enclosing block:
                      the proc body after this header, or the bytes after the
                      nearest ITEM/LINE header (verified: MUST s_main's
                      if(ds2_flag) inside LINE 2, MS450 m_speicher ITEM 5).
    0b 00 <u16>       JUMP-IF-FALSE to dword index u16, same coordinates.
                      Every if and while compiles to cond / 05-stmt / 0b.
    05 00 01 00       statement separator
    0c 80 <u16>       call user proc #n
    0c 81 <u16>       call builtin #n
    0d 00 00 00       end-of-proc marker (sits right before the next decl)
    0d 01 <u16>       call DLL import #n (import32 table; per-file numbering,
                      BMW_STD.H's GetPrivateProfileString lands on 8)
    0e 00 00 00       return / end of the enclosing block
    0f 00 00 00       OPEN CALL FRAME -- args pushed after this belong to the
                      next call, so no arity table is needed
    21/22/24 <u16> <u16> <label> 0a
                      LINE(21/22) and ITEM(24) headers, label inline; the
                      trailing u16 is the block's END as a dword index, the
                      same coordinate system the jumps use
    everything else   treated as 4-byte unknown, counted against coverage

BINOPS (proven against BMW_STD.H/.SRC statements; MUST compiles them all)
    60 +   61 -   62 *   64 <   65 >   66 <=   67 >=   68 ==   69 !=
    6a &&  6b ||  6d unary minus  6e !
    inferred only (slot layout + the INPA manual's operator inventory +
    usage shape like `(x & 2) == 2`, no compiled source proof):
    63 /   6c ^^   6f &   70 |   71 ^

BUILTINS: named by aligning every call site in MUST_EXX.SRC + BMW_STD.SRC +
    BMW_STD.H + the seven includes against the compiled stream, proc by proc
    (45 of 47 procs align call-for-call; every previously known number was
    confirmed). Unknowns stay numeric.

Read-only: decodes .IPOs, never talks to a car.

    python3 tools/ipo_disasm.py GSDS2                # decompile, summary
    python3 tools/ipo_disasm.py GSDS2 s_ana2_834     # one proc, full listing
    python3 tools/ipo_disasm.py --corpus             # coverage stats
"""
import os
import re
import sys
import json
import struct

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
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
            # no length cap: CAS's pool holds a 377-byte string (entry 146 of
            # its declared 15,135), and the declaration's entry count already
            # validates the walk end-to-end
            j = data.find(b"\n", i + 1)
            if j < 0:
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


# The pool is the body of a DECLARATION named "Constant Data", with the same
# header grammar as every proc:  <type> <name> \x0a <u32 id> \x0a [version]
# \x0a \x00 <u16 count>.  Its u16 field is the ENTRY COUNT: on 878 corpus
# files the walk from the header's end reaches EOF in exactly that many
# entries, with zero mismatches.
_POOL_DECL = re.compile(rb".Constant Data\x0a(....)\x0a[ -~]{0,32}\x0a\x00(..)",
                        re.DOTALL)


def find_pool(data):
    """(pool_start, entries) -- the body of the "Constant Data" declaration.

    The v1.x flavour of the format (the NCSEXPER data files) declares the
    section but encodes its entries differently; there the declaration walk
    fails after an entry or two and the suffix heuristic below still applies.
    """
    m = None
    for m in _POOL_DECL.finditer(data):
        pass                                  # the LAST declaration wins
    if m is not None:
        start = m.end()
        declared = int.from_bytes(m.group(2), "little")
        entries = _tok_pool(data, start, len(data))
        if entries is not None and (len(entries) & 0xffff) == declared:
            return start, entries
    return _find_pool_suffix(data)


def _find_pool_suffix(data):
    """Fallback: the longest EOF-suffix that tokenizes as literals AND whose
    indexing agrees with the code's refs.

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
# A DECLARATION, matched by its full shape rather than by how long the name
# is:
#
#     <type> <name> \n <u32 id> \n [version] \n \x00 <u16 dwords> ...
#
# The trailing block header is what makes it a declaration -- anchoring on it
# cuts 71,421 name-shaped hits to 11,529, exactly the set the old pattern
# found. That made the {2,60} length floor removable, and it had to go: it
# hid 15 real procs whose names are one or two characters (PD on the AFS
# family, pm on the PM65 group, c on three MEV/ME9 DMEs), whose bodies then
# decoded as garbage inside whichever proc preceded them.
#
# A LEADING SPACE IS NOT ALLOWED, though EHC_2 contains exactly one
# declaration that would need it: " LT_handst", type 4 (statemachine), id 0,
# 15 dwords, every field present. Admitting it is a net loss -- its own body
# is a dispatch table of <offset> ffffffff pairs INSIDE the declared extent,
# which nothing decodes, so recognising the declaration trades 12 unknown
# bytes for 56. The 12 stay, documented below, until the table format is
# understood; the file round-trips byte-identically either way.
#
# The optional version string is the same field body_start() reads: normally
# empty, filled in ("111") only by Energiediagnose_L6_v111. Requiring the two
# newlines to be adjacent lost all 7 of that file's declarations, which is
# how the field turned up here too.
_DECL = re.compile(
    rb"([\x01-\x05])([A-Za-z_][A-Za-z0-9_]{0,60})\x0a(....)\x0a[ -~]{0,32}\x0a\x00",
    re.DOTALL)
_TYPES = {1: "screen", 2: "menu", 3: "state", 4: "statemachine", 5: "func"}


# THE LAST TWELVE BYTES IN THE CORPUS. EHC_2's `handst` declares a 4-dword
# body whose first three tokens are unrecognised:
#
#     00 04 00        block: 4 dwords
#     11 51 06 00     ?
#     11 51 04 00     ?
#     10 44 00 00     ?
#     0e 00 00 00     ret
#
# Their shape matches the `<op> <byte> <u16>` family (01 push, 06 store), and
# the u16s are plausible slot indices, which reads like a parameter table --
# but that is a guess and it is recorded here as one. Nothing supports
# resolving it: no other proc in 1,788 files opens with 0x10/0x11, EHC_2
# ships no .SRC, and `handst` is only ever referenced by procref, never
# called with arguments that would reveal a signature.
#
# It costs nothing to leave undecoded. The file round-trips byte-identically
# (unknown tokens are preserved verbatim), the VM runs it, and `handst` is an
# empty stub that emits no items and no jobs whichever way the bytes are
# read. Inventing an opcode to reach a round number would be worse than the
# 12 bytes.


def body_start(data, off, name):
    """Where a declaration's CODE begins.

        <type> <name> \n <u32 id> <version> \n <block header...>

    The version string between the id and the block is normally EMPTY, so
    every call site used to hard-code "+ 1" for its terminating newline.
    Energiediagnose_L6_v111 fills it in ("111", matching its own name), and
    the five bytes that field costs put every one of its seven procs three
    bytes into its own body -- 8,770 bytes decoded as garbage, the single
    largest remaining gap in the corpus. Reading the field's real length
    costs nothing on the empty case and is what the format actually says.
    """
    # <type> <name> \n <u32 id> \n [version] \n <block header ...>
    #
    # The version string is normally EMPTY -- the two newlines sit side by
    # side -- which is why every call site hard-coded "+ 1" and walk() ate
    # the second newline harmlessly. Energiediagnose_L6_v111 fills it in
    # ("111", matching its own name), and those extra bytes put each of its
    # seven procs three bytes into its own body: 8,837 bytes of garbage, the
    # largest single gap left in the corpus.
    #
    #   chrinit    ... 6\x00\x00\x00 \n     \n 00 12 00 ...   body = i + 1
    #   AEP_LESEN  ... 6\x00\x00\x00 \n 111 \n 00 8e 02 ...   body = i + 4
    #
    # Skip the field's CONTENT only, leaving the trailing newline in place so
    # the empty case keeps the exact offset it has always had.
    i = off + 1 + len(name) + 1 + 4
    if data[i:i + 1] == b"\n":
        j = data.find(b"\n", i + 1, i + 64)
        if j > i + 1:                      # a non-empty version string
            return j
    return i + 1


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
    # UI/navigation (MUST-proven unless said otherwise)
    0x00: "setmenutitle", 0x01: "setmenu",
    0x02: "setitem",         # setitem(nr, caption, enabled)
    0x03: "settitle",
    0x04: "setscreen", 0x0c: "exit",
    # state-machine control. 0x05 takes one STATE decl (kind 0x42), 0x06 one
    # STATEMACHINE decl (kind 0x43); named by argument shape, corpus-wide (66
    # and 319 sites) and against Inpa.h's setstate/setstatemachine. These are
    # how a "Change: ..." key's scripted sequence steps between its own states.
    0x05: "setstate", 0x06: "setstatemachine",
    0x0f: "scriptchange",    # loads another .IPO entirely (empirical)
    0x10: "select", 0x11: "deselect", 0x13: "start", 0x17: "printscreen",
    0x18: "printfile",
    # conversions and string helpers
    0x1c: "getdate", 0x1d: "gettime",
    0x1e: "realtostring", 0x1f: "stringtoreal", 0x20: "inttostring",
    0x24: "strlen",
    # midstr(dst, src, start, len) -- INPA's substring, its real name from
    # Inpa.h. 9434 sites in 553 files, the most-used call in the corpus.
    0x25: "midstr",
    # (src, dst) -- formats a number into a display string. 520 sites in 66
    # files. EMPIRICAL: no MUST call site; shape-derived, name is ours.
    0x27: "formatnum",
    0x28: "bytetoint", 0x29: "inttolong",
    # input dialogs. getinputstate reports how the LAST dialog closed
    # (== input_ok means the user pressed OK, and the answer slots are live).
    0x3e: "getinputstate",
    # single- and double-field hex entry, and the yes/no box. Named by
    # argument shape (7, 7 and many sites in LWS5's ident-write procs) against
    # Inpa.h's inputhex/input2hex/inputdigital: 0x41 is (out hexstr, title,
    # caption, min, max); 0x45 is (out a, out b, title, caption, cap1, cap2,
    # min1, max1, min2, max2); 0x42 is (out bool, title, caption, falseStr,
    # trueStr). These are the dialogs the "Change: ..." keys open.
    0x41: "inputhex",        # (ref hexstr, title, caption, minhex, maxhex)
    0x42: "inputdigital",    # (ref bool, title, caption, falseStr, trueStr)
    0x43: "input2text",      # (ref a, ref b, title, help, cap1, cap2)
    0x44: "input2hexnum",    # (ref hexstr, ref int, title, help, ...)
    0x45: "input2hex",       # (ref a, ref b, title, cap, c1, c2, mn1, mx1, mn2, mx2)
    0x46: "inputint",        # (ref n, title, range, min, max)
    # display statements
    0x48: "text",            # text(row, col, str)
    0x49: "textout",         # textout(str, row, col)   (empirical)
    0x4a: "ftextout",        # ftextout(str, row, col, flagA, flagB)
    # 0x4b is digitalout(val, row, col, onText, offText) -- 879 of its 1,557
    # sites carry exactly that shape.
    #
    # 0x4d is multianalogout, NOT a second digitalout. It was named
    # empirically because its rows render as lamps, with the standing note
    # that 48..4c land on text..analogout in declaration order so 0x4d was
    # probably the next entry. Two independent facts settle it: a second
    # decoder of this format names it multianalogout, and its arguments are
    # never digitalout's -- EHC_2's s_handsteuern passes
    # (1, 0, 100.0, -100.0, 100.0, -100.0, 100.0, "3.0", 1), which is
    # analogout's min/max/warnLo/warnHi/fmt tail, repeated per series.
    0x4b: "digitalout",
    0x4c: "analogout",       # analogout(val, row, col, min, max, wlo, whi, fmt)
    0x4d: "multianalogout",
    0x4e: "hexdump",         # hexdump(adrstr, count, row, col)
    # boxes, views, PC-side files
    0x52: "messagebox",
    0x54: "userboxopen", 0x55: "userboxclose", 0x56: "userboxftextout",
    0x5b: "callwin",
    0x5c: "viewopen", 0x5d: "viewclose",
    0x79: "fileopen", 0x7a: "fileclose",
    0x7b: "filewrite", 0x7c: "fileread",
    # EDIABAS bridge
    0x60: "INPAapiInit", 0x61: "INPAapiEnd",
    0x62: "INPAapiJob",             # (sgbd, job, arg, resultfilter)
    0x63: "INPAapiResultText",      # (ref, key, set, fmt)
    0x64: "INPAapiResultInt",       # (ref, key, set)
    0x65: "INPAapiResultSets",      # (ref)
    0x66: "INPAapiResultDigital",   # (ref, key, set)
    0x67: "INPAapiResultAnalog",    # (ref, key, set)
    # (key, set) with NO destination ref -- reads into an internal buffer
    # that GetBinaryDataString then copies out (s_speicher_ausgabe:
    # INPAapiResultBinary("DATEN",1) before hexdump)
    0x68: "INPAapiResultBinary",
    0x69: "INPAapiCheckJobStatus",  # (status)
    0x6b: "INPAapiFsLesen", 0x6c: "INPAapiFsMode",
    # the second-connection API (group SGBD): same shapes as INPAapi*.
    # 0x6f is 734 sites in 334 files -- RADIO's entertainment-source keys
    # call their jobs this way, so they read as dead without it.
    0x6f: "INP1apiJob",             # (sgbd, job, arg, resultfilter)
    0x71: "INP1apiResultText", 0x72: "INP1apiResultInt",
    0x73: "INP1apiResultSets", 0x75: "INP1apiResultBinary",
    0x76: "INP1apiErrorCode", 0x77: "INP1apiErrorText",
    0x78: "GetBinaryDataString",    # (dst, src) -- always exactly two refs
    # string arrays and structure buffers (BMW_STD.H helpers)
    0x8c: "StrArrayCreate", 0x8d: "StrArrayDestroy", 0x8e: "StrArrayWrite",
    0x8f: "StrArrayRead", 0x91: "StrArrayDelete",
    0x9a: "CreateStructure", 0x9b: "SetStructureMode",
    0x9c: "StructureByte", 0x9d: "StructureInt", 0x9e: "StructureLong",
    0x9f: "StructureString",
}

# The job-call builtins: one per API connection. Consumers that ask "does
# this run an EDIABAS job" must accept both.
JOB_CALLS = {"INPAapiJob", "INP1apiJob"}


# binary operators (opcode 09). Proven names per the docstring; the five
# inferred ones are marked there.
BINOPS = {
    0x60: "add", 0x61: "sub", 0x62: "mul", 0x63: "div",
    0x64: "lt", 0x65: "gt", 0x66: "le", 0x67: "ge",
    0x68: "eq", 0x69: "ne",
    0x6a: "and", 0x6b: "or", 0x6c: "xor",
    0x6d: "neg", 0x6e: "not",
    0x6f: "band", 0x70: "bor", 0x71: "bxor",
}
_CMP = {"lt": "<", "gt": ">", "le": "<=", "ge": ">=", "eq": "==", "ne": "!="}

# local declarations (opcode 08); 52/54 inferred, see docstring
_DECL_TYPES = {0x50: "bool", 0x51: "int", 0x52: "byte", 0x53: "long",
               0x54: "real", 0x55: "string"}

_INLINE_OPS = {0x21, 0x22, 0x24}      # LINE/ITEM: label inline until \n
_NEG = 0x6d                           # unary minus; see calls_of


def walk(data, lo, hi, pool, names=None):
    """Token stream of one proc body. Yields dicts; counts unknown bytes.

    Every token carries "at", its byte offset. Jump tokens carry "to", the
    target RESOLVED to a byte offset: targets are dword indices relative to
    the enclosing block (the proc body after its header, or the bytes after
    the nearest ITEM/LINE header), which `base` tracks.

    `names` overrides the call-name table for the file's dialect. The screen
    IPOs and the NCS coding dispatchers share the bytecode but index different
    host function tables, so a coding dispatcher passes ipo_cdh.CDH_SLOTS-derived
    names here (via the --cdh flag) while screen IPOs pass None (BUILTINS).
    """
    call_names = names if names is not None else BUILTINS
    toks, unknown = [], 0
    i = lo
    base = lo + 4               # dword 0 of the proc's own block
    while i < hi:
        start = i
        mark = len(toks)
        op = data[i]
        # A STATE LABEL, its own token, sitting where a 4-byte token would:
        #
        #     %NAME \n  <u32 state index>  0a
        #
        # Read from the bytes, side by side, in RE_VM11:
        #     0c 81 06 00  %PS1__PS1_Vorgabe_lesen…\n  1a000000 0a   (call)
        #     0c 81 0c 00  %Setze_IOs\n                 00000000 0a   (call)
        #     05 00 01 00  %PS1__PS1_Mess_laeuft…\n     04000000 0a   (stmt)
        # -- the same token after three different predecessors. This used to
        # be consumed inside builtin 0x06's branch, so the first decoded and
        # the rest desynchronised the stream: Ablaufsteuerung read 68%
        # unknown. It is a token in its own right and is read as one here,
        # which is why the predecessor no longer matters.
        #
        # The marker character alone is NOT enough -- "%I\n" appears inside
        # CAS's format strings. The token is the whole shape: a printable
        # NUL-free run, terminated by \n, then a u32 and a 0a. Anything else
        # falls through to the ordinary paths below.
        #
        # THE '%' IS PART OF THE TOKEN, not a guess. Dropping it and keying
        # on the shape alone (printable run, \n, u32, 0a) looked more
        # principled and was wrong: in MUST_EXX, which contains no state proc
        # and not one setstatemachine call, it matched 66 pool markers of the
        # form '$' \n <u32> \n\n and swallowed the instructions after each,
        # breaking that file's hexdump, showIf, promptArg and argSlot.
        #
        # Two other forms looked like bare labels and are not:
        #   ZKE2     01 01 #\n   is push-const, whose u16 happens to be '#\n'
        #   Energie  05 AEP_File_reset\n  is a func DECLARATION
        # Both were mis-read here before their contexts were checked.
        if data[i:i + 1] == b"%":
            j = data.find(b"\n", i + 1, min(hi, i + 72))
            lbl = data[i:j] if j >= 0 else b""
            if (j >= 0 and lbl
                    and all(0x20 <= c < 0x7f for c in lbl)
                    and j + 5 < hi and data[j + 5] == 0x0a):
                toks.append({"op": "state", "name": lbl.decode("latin-1"),
                             "index": int.from_bytes(data[j + 1:j + 5],
                                                     "little"),
                             "at": i})
                i = j + 6
                continue
        if op in _INLINE_OPS and i + 6 <= hi:
            # op + u16 0x000a + pad00 + u16 nr + caption 0a + second 0a
            #    + pad00 + u16 end-dword
            # LINE's second string is its result-key list ("K1;K2"), usually
            # empty; when empty the tail bytes look like the old "block" token,
            # which is why GSDS2 parsed by accident and MS450 desynced.
            b = int.from_bytes(data[i + 4:i + 6], "little")
            j = data.find(b"\n", i + 6, min(hi, i + 220))
            if j >= 0:
                label = data[i + 6:j].decode("latin-1")
                j2 = data.find(b"\n", j + 1, min(hi, j + 260))
                second = data[j + 1:j2].decode("latin-1") if j2 >= 0 else ""
                # +4, not +3: the end-dword u16 occupies data[j2+2:j2+4], and
                # a slice truncated at hi silently decoded to a 1-byte value
                if j2 >= 0 and j2 + 4 <= hi:
                    dwords = int.from_bytes(data[j2 + 2:j2 + 4], "little")
                    t = {"op": "ITEM" if op == 0x24 else "LINE",
                         "nr": b, "label": label, "dwords": dwords,
                         "at": start}
                    if second:
                        t["keys"] = second
                    toks.append(t)
                    i = j2 + 4
                    base = i    # jumps inside this body count from here
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
        elif b0 == 0x03 and b1 in (0x00, 0x02, 0x03):
            # push THROUGH a reference param (reading an out/inout param's
            # value: trimstr's `Temp=Text`). Previously read as a 3-byte int
            # immediate, which desynced every proc touching an inout param.
            toks.append({"op": "var", "n": u16, "sc": b1, "ref": True})
        elif b0 == 0x06 and b1 in (0x00, 0x01, 0x02, 0x03):
            toks.append({"op": "store", "n": u16, "sc": b1})
        elif b0 == 0x07 and b1 in (0x00, 0x02, 0x03):
            # store THROUGH a reference param (instr's `pos = i`)
            toks.append({"op": "store", "n": u16, "sc": b1, "ref": True})
        elif b0 == 0x08 and b1 in _DECL_TYPES and u16 == 0:
            # one per uninitialised local, in source order, at proc entry
            toks.append({"op": "decl", "type": _DECL_TYPES[b1]})
        elif b0 == 0x02:
            toks.append({"op": "procref", "kind": b1, "n": u16})
        elif b0 == 0x09:
            toks.append({"op": "binop", "n": mid, "name": BINOPS.get(mid)})
        elif b0 == 0x0a and b1 == 0x00:
            if not toks:
                # proc header: where the prologue/INIT block ends
                toks.append({"op": "block", "dwords": u16})
            else:
                # unconditional jump: while back edges, else skips
                toks.append({"op": "jump", "to": base + 4 * u16})
        elif b0 == 0x0b and b1 == 0x00:
            toks.append({"op": "jfalse", "to": base + 4 * u16})
        elif b0 == 0x0e and b1 == 0x00 and u16 == 0:
            toks.append({"op": "ret"})
        elif b0 == 0x0d and b1 == 0x00 and u16 == 0:
            toks.append({"op": "endproc"})
        elif b0 == 0x0d and b1 == 0x01:
            # import32 DLL call; the import table is per-file, so no names
            toks.append({"op": "dllcall", "n": u16})
        elif b0 == 0x05 and b1 == 0x00:
            toks.append({"op": "stmt", "n": u16})
        elif b0 == 0x0c and b1 == 0x80:
            toks.append({"op": "calluser", "n": u16})
        elif b0 == 0x0c and b1 == 0x81:
            toks.append({"op": "call", "n": u16,
                         "name": call_names.get(u16, f"builtin_{u16:02x}")})
        elif b0 == 0x0f:
            toks.append({"op": "frame"})
        else:
            toks.append({"op": "unk", "bytes": data[i:i + 4].hex()})
            unknown += 4
        for t in toks[mark:]:
            t.setdefault("at", start)
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
            # 0x6d is unary minus on the constant just pushed, and it is how
            # every negative gauge bound in the corpus is encoded: MS450's
            # exhaust Vanos pushes `135.0 neg 40.0 neg ...` for -135..-40, and
            # ABSASC5's yaw rate `800.0 neg 800.0` for -800..+800. Dropping it
            # turned both into a zero-width range, so the gauge lost its scale.
            # Other binops stay folded away -- they combine operands we do not
            # evaluate, and keeping the first is the closest single value.
            if t["n"] == _NEG and args and args[-1]["op"] == "const" \
                    and isinstance(args[-1].get("v"), (int, float)) \
                    and not isinstance(args[-1].get("v"), bool):
                args[-1] = dict(args[-1], v=-args[-1]["v"])
        elif t["op"] in ("call", "calluser"):
            out.append({"call": t.get("name", f"user_{t['n']}"),
                        "n": t["n"], "args": list(args),
                        "item": (current_item or {}).get("label")})
            args = []
    return out, items


# ------------------------------------------------------------ call args ----


def frame_of(toks, ci):
    """The tokens of the call at index ci: everything back to its frame.

    A frame opens every argument list, so it -- not a fixed lookbehind window
    -- is the boundary. Scanning a fixed number of tokens ran into the
    previous call's operands.
    """
    lo = ci
    while lo > 0 and toks[lo - 1]["op"] != "frame":
        lo -= 1
    return toks[lo:ci]


def arg_positions(seg):
    """Split a call frame into POSITIONAL arguments.

    Each argument is one value left on the stack: a const/var/procref push is
    one value, a binop consumes two and yields one. Simulating the stack gives
    argument k exactly, which is what the call's signature is written against
    -- so a job can be read from the position INPAapiJob defines for it
    rather than guessed at from how the string is spelled.
    """
    st = []
    for t in seg:
        op = t["op"]
        if op in ("const", "var", "procref"):
            st.append([t])
        elif op == "binop":
            b = st.pop() if st else []
            a = st.pop() if st else []
            st.append(a + b + [t])
    return st


def arg_str(pos, k):
    """The literal string at positional argument k, or None if not a literal.

    None means "not a constant here" (a variable, or no such argument) --
    never "unrecognised shape". Callers that need the variable resolve it
    through the enclosing proc, they do not fall back to sniffing.
    """
    if k >= len(pos):
        return None
    for x in pos[k]:
        if x["op"] == "const" and x.get("t") == "s":
            return x["v"]
    return None


# INPAapiJob(sgbd, job, argument, result_filter): the job is argument 1 and
# what it sends is argument 2, by the call's own signature.
JOB_ARG_JOB = 1
JOB_ARG_ARG = 2

# INPAapiFsMode(sgbd, mode, ?, ?, job) -- the fault-memory reader, a distinct
# builtin from INPAapiJob with the job LAST. 490 files reach their fault
# memory only through it, so it needs its own position rather than a scan.
# An empty job there means FS_LESEN: INPA's own default, spelled out in the
# wrappers that call it (`if (job == "") job = "FS_LESEN"`).
FSMODE_CALLS = {"INPAapiFsMode"}
FSMODE_ARG_JOB = 4
FSMODE_DEFAULT_JOB = "FS_LESEN"


# ---------------------------------------------------------------- fields ----


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
        """The (scope, slot) a drawing call reads from.

        A result read names its destination with a procref whose KIND is the
        scope (0 scratch, 2 the screen's global frame); the draw that prints
        it pushes a var in the matching scope (sc=2 for the global frame).
        Keying the bind map on the pair keeps the two scopes' slot numbers
        from colliding -- they are numbered independently.
        """
        for a in seq:
            if a["op"] == "var":
                return (2 if a.get("sc") == 2 else 0, a["n"])
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
            # only text() reaches here: textout is consumed by the branch
            # above, so listing it in this elif was dead. Its unit-extraction
            # intent stays unimplemented rather than newly enabled -- turning
            # it on would change the legacy screen_fields output unverified.
            elif name == "text":
                # text(row,col,str)
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
            elif name in JOB_CALLS:
                # both arms of the old keyish-vs-not split appended strs[0]
                if strs:
                    jobs.append(strs[0])
            elif name in ("INPAapiResultText", "INPAapiResultAnalog",
                          "INPAapiResultDigital"):
                # THE KIND BYTE IS THE DESTINATION SCOPE, NOT A REF TYPE:
                # 0 writes a scratch slot, 2 writes the screen's own global
                # frame (drawn by a later LINE's analogout). Accepting only
                # kind 0 threw away the majority of bindings -- 78,245 of
                # 145,864 refs are kind 2 -- so screens that read into the
                # global frame decoded to no fields at all (ACC2's whole
                # Identification page). ipo_ir.py already reads both; this
                # brings the disassembler in line with it.
                ref = next((a for a in args if a["op"] == "procref"
                            and a["kind"] in (0, 2)), None)
                # INPAapiResult*(ref, KEY, index, default): the key is
                # argument 1 by signature. Picking the first "key-shaped"
                # string instead skipped short result names outright.
                key = arg_str(arg_positions(args), 1)
                if ref is not None and key:
                    # keyed by (scope, slot): the two scopes number their
                    # slots independently, so a bare number collides
                    bind[(2 if ref["kind"] == 2 else 0, ref["n"])] = key
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
                # per-ECU helper shaped (KEY, row, col, [on, off]): the key
                # is argument 0, so read that position rather than scanning
                # for a string that looks like a key.
                key = arg_str(arg_positions(args), 0)
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
    # NO POOL IS NOT NO FILE. The A_* activation scripts (and the CH/CI/CM
    # test families) carry their strings INLINE rather than in a trailing
    # pool, so find_pool finds nothing -- but the proc table is intact and
    # readable. Bailing here threw away 200 files that decode fine: A_IHK46
    # alone declares thirteen procs, TestCDHFehler through Cod.
    #
    # walk() already bounds-checks every pool[] read, so an empty pool costs
    # the constants and nothing else. A file with no procs EITHER is the
    # only real nothing.
    if not decls:
        return None
    id2name = {}
    for off, typ, name, pid in decls:
        id2name[(typ, pid)] = name
    screens, menus = {}, {}
    cov_unk = cov_len = 0
    for k, (off, typ, name, pid) in enumerate(decls):
        lo = body_start(data, off, name)
        # the last proc runs to the pool, or to end-of-code when a file
        # has no pool at all (the inline-string dialects)
        hi = decls[k + 1][0] if k + 1 < len(decls) else (
            ps if ps is not None else code_end(data, None))
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

def code_end(data, ps):
    """Where PROC CODE actually ends: at the trailing metadata region, not at
    the pool. 1785 of 1788 corpus files close their last proc and then carry
    `11 "Global Data" \\n` (the global-slot type table, one pool-style type
    code per slot) followed by `12 "Constant Data" \\n` (include names and the
    import32 DLL signature table) before the constant pool proper. Counting
    that region as the last proc's body buried the TD-* telegram files under
    150 KB of "unknown code" each that was never code at all."""
    end = ps if ps else len(data)
    m = data.find(b"\x11Global Data\x0a", 0, end)
    return m if m >= 0 else end


def load(ecu):
    path = L1.ipo_path(ecu)
    data = open(path, "rb").read()
    ps, pool = find_pool(data)
    ce = code_end(data, ps)
    decls = find_decls(data, ce)
    return data, ps, pool, decls


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--corpus" in sys.argv:
        files = L1.ipo_paths()
        ok = bad = 0
        tot_unk = tot_len = 0
        for p in files:
            data = open(p, "rb").read()
            ps, pool = find_pool(data)
            # Same rule decompile() uses: a missing POOL is not a missing
            # file. The inline-string dialects (A_*, and the CH/CI/CM test
            # families) have an intact proc table and decode fine; only a
            # file with no procs is nothing. Keeping a second copy of this
            # test here is how --corpus went on reporting 205 failures
            # after decompile() had stopped failing on them.
            end = ps if ps is not None else code_end(data, None)
            decls = find_decls(data, end)
            if len(decls) < 3:
                bad += 1
                continue
            ok += 1
            for k, (off, typ, name, pid) in enumerate(decls):
                # +1 skips the newline that terminates the declaration --
                # without it every walk started one byte early, misread the
                # first token and desynced, so --corpus understated coverage
                # for the whole corpus (44.7% where the real figure is what
                # decompile() sees)
                lo = body_start(data, off, name)
                hi = decls[k + 1][0] if k + 1 < len(decls) else end
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
    # The NCS coding dispatchers (A_<cabd>) index the CDH host table, not the
    # screen builtins; --cdh names calls against it (ipo_cdh.CDH_SLOTS).
    cdh_names = None
    if "--cdh" in sys.argv:
        import ipo_cdh
        cdh_names = {op: row[0] for op, row in ipo_cdh.CDH_SLOTS.items()}

    ecu = args[0]
    data, ps, pool, decls = load(ecu)
    print(f"{ecu}: pool at {ps} ({len(pool)} entries), {len(decls)} procs")
    if len(args) > 1:
        want = args[1]
        for k, (off, typ, name, pid) in enumerate(decls):
            if name != want:
                continue
            lo = body_start(data, off, name)
            # same fallback decompile() uses: the inline-string dialects
            # (A_*, CH/CI/CM) have no pool, so ps is None and a bare `else
            # ps` fed walk() a None bound (TypeError on every such file)
            hi = decls[k + 1][0] if k + 1 < len(decls) else (
                ps if ps is not None else code_end(data, None))
            toks, unk, ln = walk(data, lo, hi, pool, cdh_names)
            print(f"\n{typ} {name} (id {pid}) {off}..{hi} "
                  f"unknown {unk}/{ln} bytes")
            for t in toks:
                print("  ", t)
            break
        return 0
    for k, (off, typ, name, pid) in enumerate(decls):
        lo = body_start(data, off, name)
        hi = decls[k + 1][0] if k + 1 < len(decls) else (
            ps if ps is not None else code_end(data, None))
        toks, unk, ln = walk(data, lo, hi, pool)
        cs, items = calls_of(toks)
        print(f"  {typ:6} {name:26} id {pid:3}  {len(cs):3} calls  "
              f"{len(items):2} items/lines  unk {unk}/{ln}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
