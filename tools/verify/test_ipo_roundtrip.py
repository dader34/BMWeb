#!/usr/bin/env python3
"""Guard: the .IPO compiler and constant editor are exact inverses of the file.

ipo_disasm.py proves we can READ a compiled screen; these tools prove we can
WRITE one back. The whole claim is verifiable offline without a car and without
BMW's proprietary SGDAT tree, because the round-trip is its own oracle:

    codec     read(bytes).write() == bytes                    (structure)
    compiler  assemble(disassemble(bytes)) == bytes           (text form)
    editor    change one constant -> only that entry moves     (surgery)

The corpus under fixtures/ipo/ is real INPA v5.x bytecode -- header, block
table, code, global-slot types and a constant pool -- but it is NOT BMW
material: each file is synthetic bytecode built from a neutral language-level
construct (empty, if/else, while, a screen+menu, a state machine, a logic
table, DLL import calls). So it exercises every block type and
every opcode the format defines, and it is an INDEPENDENT check: our reader was
written from the format spec, not from these bytes, yet must reproduce them to
the byte. When BMW's SGDAT is present, point BMACW_IPO_CORPUS at it to run the
same three checks over thousands of shipped .IPOs.

    python3 tools/verify/test_ipo_roundtrip.py
    BMACW_IPO_CORPUS=vendor/EC-APPS/INPA/SGDAT python3 tools/verify/test_ipo_roundtrip.py
"""
import os
import sys
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "verify")]
import ipo_codec as C                                          # noqa: E402
import ipo_compile as A                                        # noqa: E402
import ipo_edit as E                                           # noqa: E402
import ipo_disasm as D                                         # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures", "ipo")


def corpus():
    ext = os.environ.get("BMACW_IPO_CORPUS")
    if ext:
        files = sorted(glob.glob(os.path.join(ext, "*.IPO"))
                       + glob.glob(os.path.join(ext, "*.ipo")))
    else:
        files = sorted(glob.glob(os.path.join(FIXTURES, "*.ipo")))
    return files


def main():
    files = corpus()
    if not files:
        print("no corpus found -- fixtures/ipo/ is empty and "
              "BMACW_IPO_CORPUS is unset")
        return 1

    failures = []

    # -- 1. codec: read().write() is the identity ---------------------------
    codec_ok = 0
    for p in files:
        data = open(p, "rb").read()
        try:
            if C.read(data).write() == data:
                codec_ok += 1
            else:
                failures.append(f"codec not byte-identical: {os.path.basename(p)}")
        except Exception as e:                                  # noqa: BLE001
            failures.append(f"codec raised on {os.path.basename(p)}: {e}")
    print(f"  codec      {codec_ok}/{len(files)} read->write byte-identical")

    # -- 2. compiler: assemble(disassemble(x)) is the identity --------------
    comp_ok = 0
    for p in files:
        data = open(p, "rb").read()
        try:
            if A.assemble(A.disassemble(data)) == data:
                comp_ok += 1
            else:
                failures.append(f"compiler not byte-identical: {os.path.basename(p)}")
        except Exception as e:                                  # noqa: BLE001
            failures.append(f"compiler raised on {os.path.basename(p)}: {e}")
    rate = 100.0 * comp_ok / len(files)
    print(f"  compiler   {comp_ok}/{len(files)} disasm->recompile "
          f"byte-identical ({rate:.1f}%)")

    # -- 3. ipo_disasm.py agrees the recompiled bytes are the same file -----
    # Independent decoder: its proc table over the recompiled output must
    # match the original's, or we changed the file's meaning.
    disasm_ok = disasm_seen = 0
    for p in files:
        data = open(p, "rb").read()
        back = A.assemble(A.disassemble(data))
        da = D.find_decls(data, D.code_end(data, D.find_pool(data)[0]))
        db = D.find_decls(back, D.code_end(back, D.find_pool(back)[0]))
        if len(da) < 3:
            continue                    # too small for the decl heuristic
        disasm_seen += 1
        if [(t, n, i) for _, t, n, i in da] == [(t, n, i) for _, t, n, i in db]:
            disasm_ok += 1
        else:
            failures.append(f"ipo_disasm decls drift: {os.path.basename(p)}")
    print(f"  ipo_disasm {disasm_ok}/{disasm_seen} recompiled files decode "
          f"to the same proc table")

    # -- 4. editor: change a constant, prove the surgery is local -----------
    edit_files = edit_ok = 0
    for p in files:
        data = open(p, "rb").read()
        f = C.read(data)
        cb = f.constants_block()
        if not cb:
            continue
        entries = cb.constants()
        si = next((i for i, (t, _) in enumerate(entries) if t == C.VT_STRING),
                  None)
        if si is None:
            continue
        edit_files += 1
        t, old = entries[si]

        # (a) same-length replace -> file identical except that entry's bytes
        same = bytes([0x58] * len(old))     # "XXXX", same byte length as old
        entries2 = list(entries)
        entries2[si] = (t, same)
        cb.set_constants(entries2)
        out = f.write()
        f2 = C.read(out)
        # every block except the pool is byte-identical
        blocks_ok = all(a.payload == b.payload
                        for a, b in zip(f.blocks, f2.blocks)
                        if a.type != C.BLOCK_CONSTANTDATA)
        # every constant except si is unchanged, si is the new value
        c2 = f2.constants_block().constants()
        others_ok = all(c2[i] == entries[i] for i in range(len(entries))
                        if i != si)
        reread_ok = c2[si] == (t, same)
        # same-length edit keeps total length
        len_ok = len(out) == len(data)

        # (b) restore original value -> back to the original bytes exactly
        cb.set_constants(entries)
        restored = f.write() == data

        if blocks_ok and others_ok and reread_ok and len_ok and restored:
            edit_ok += 1
        else:
            failures.append(
                f"editor surgery not local on {os.path.basename(p)}: "
                f"blocks={blocks_ok} others={others_ok} reread={reread_ok} "
                f"len={len_ok} restore={restored}")
    print(f"  editor     {edit_ok}/{edit_files} string edits are local & "
          f"reversible")

    # -- 5. editor numeric path, end to end via the CLI helper --------------
    num_done = False
    for p in files:
        f = C.read(open(p, "rb").read())
        cb = f.constants_block()
        if not cb:
            continue
        ents = cb.constants()
        ni = next((i for i, (t, _) in enumerate(ents)
                   if t in (C.VT_INT, C.VT_LONG, C.VT_BYTE)), None)
        if ni is None:
            continue
        t, old = ents[ni]
        ents[ni] = (t, E.coerce(t, "42"))
        cb.set_constants(ents)
        rt = C.read(f.write()).constants_block().constants()[ni]
        if rt == (t, 42):
            num_done = True
        else:
            failures.append(f"numeric edit failed on {os.path.basename(p)}: {rt}")
        break
    print(f"  editor     numeric edit {'OK' if num_done else 'not exercised'}")

    print()
    if failures:
        print(f"FAIL ({len(failures)}):")
        for m in failures:
            print("  -", m)
        return 1
    print(f"OK: {len(files)} files, round-trip pass rate "
          f"{100.0 * comp_ok / len(files):.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
