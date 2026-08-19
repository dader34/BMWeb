# IPO round-trip test vectors

These `*.ipo` files are offline test vectors for `tools/decompile/ipo_codec.py`,
`ipo_compile.py`, and `ipo_edit.py`, exercised by
`tools/verify/test_ipo_roundtrip.py`.

**They are not BMW material.** Each is synthetic INPA v5.x bytecode built from a
neutral, language-level source construct -- an empty program, `if`/`else`, a
`while` loop, arithmetic, in/out/inout parameters, a screen+menu, a state
machine, a logic table, DLL import calls -- chosen only to exercise every IPO
block type and opcode the format defines.

They are committed so the round-trip test runs offline with no build step and no
proprietary tree. They are an *independent* check: our reader/writer was written
from the format spec (`ipo_disasm.py`'s cracked layout), not from these bytes,
yet must reproduce every one to the byte.

To run the same three checks over the real BMW corpus:

    BMACW_IPO_CORPUS=vendor/EC-APPS/INPA/SGDAT \
        python3 tools/verify/test_ipo_roundtrip.py
