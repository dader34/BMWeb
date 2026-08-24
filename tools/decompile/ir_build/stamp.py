"""Tie shipped IR to the decoder that built it.

data/inpa-ir is derived by executing .IPO through ipo_vm/ipo_disasm and the
ir_build package. Nothing else links the two: a decoder fix can land while the
shipped IR stays as it was, and every data-only check still passes because each
asks only whether the DATA is self-consistent.

The stamp is a SHA-256 over the decoder sources. --write records it; --check
compares and fails on mismatch. It cannot detect a vendor .IPO changing under
us, only a code/data mismatch -- the failure that has actually bitten.
"""

import glob
import hashlib
import json
import os

IR_VERSION = 1

_HERE = os.path.dirname(os.path.abspath(__file__))
_DECOMPILE = os.path.dirname(_HERE)
_R = os.path.dirname(os.path.dirname(_DECOMPILE))
IR_DIR = os.path.join(_R, "data", "inpa-ir")


def _sources():
    """Every decoder source the IR is built from, in a stable order."""
    srcs = [os.path.join(_DECOMPILE, n)
            for n in ("ipo_vm.py", "ipo_disasm.py")]
    srcs += sorted(glob.glob(os.path.join(_HERE, "*.py")))
    return srcs


def decoder_stamp():
    """SHA-256 over the decoder sources, truncated to 16 hex chars."""
    h = hashlib.sha256()
    for path in _sources():
        try:
            with open(path, "rb") as f:
                h.update(f.read())
        except OSError:
            h.update(b"?" + os.path.basename(path).encode())
    return h.hexdigest()[:16]


def _stamp_path():
    return os.path.join(IR_DIR, "_build.json")


def write_stamp():
    """Record the current decoder stamp next to the shipped IR."""
    os.makedirs(IR_DIR, exist_ok=True)
    with open(_stamp_path(), "w", encoding="utf-8") as f:
        json.dump({"ir": IR_VERSION, "decoder": decoder_stamp()}, f)


def check_stamp():
    """None when the IR matches the decoder, else a message saying how not."""
    want = decoder_stamp()
    try:
        with open(_stamp_path(), encoding="utf-8") as f:
            got = json.load(f)
    except (OSError, ValueError):
        return ("data/inpa-ir carries no build stamp -- it predates this "
                "check, or was written by hand. Run "
                "`cd tools/decompile && python3 -m ir_build --write` then "
                "`node tools/decompile/ipo_i18n.js`.")
    if got.get("decoder") != want:
        return (f"data/inpa-ir was built by decoder {got.get('decoder')}, "
                f"but the decompiler is now {want}. The shipped IR does not "
                f"reflect the current code. Run "
                f"`cd tools/decompile && python3 -m ir_build --write` then "
                f"`node tools/decompile/ipo_i18n.js`.")
    return None
