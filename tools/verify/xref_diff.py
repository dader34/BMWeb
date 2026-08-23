#!/usr/bin/env python3
"""Cross-check our decode and execution against a second implementation.

WHY THIS EXISTS. ir_vm_diff.py scores the VM against data/inpa-ir, but that
IR is the output of the inference layer the VM is meant to replace: 14.6% of
its keys are within-screen repeats it produced by walking loop bodies it never
executed, and it misses screens outright (ACSM3's s_status_analog records no
gauges where the bytecode has five analogout calls). Agreeing with it is not
evidence of being right, and disagreeing with it is not evidence of being
wrong.

An independent implementation of the same format is a real reference. Where
two decoders written from the same bytecode agree, the reading is almost
certainly correct; where they differ, exactly one is wrong and the bytes
settle which. This runs an external disassembler over the same .IPO files and
compares, per screen:

    the draw calls each side sees, in order, and the result keys each names

The external tool is configured, not vendored -- set XREF_CMD to a command
taking the .IPO path and emitting its disassembly on stdout. Nothing from it
is copied into this repository; it is run as a black box and only its output
is read.

    XREF_CMD='node /path/to/cli decompile {ipo} --no-color --no-raw' \
        python3 tools/verify/xref_diff.py ACSM3
    ... --corpus
"""

import os
import re
import subprocess
import sys
from collections import Counter

R = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path[:0] = [os.path.join(R, "tools", "decompile")]
import ipo_disasm as D                                          # noqa: E402

XREF_CMD = os.environ.get("XREF_CMD")

# the builtins that put something on the screen, and nothing else
DRAWS = ("ftextout", "textout", "text", "userboxftextout",
         "analogout", "digitalout")
READS = ("INPAapiResultText", "INPAapiResultInt", "INPAapiResultAnalog",
         "INPAapiResultDigital", "INP1apiResultText", "INP1apiResultInt")

_SCREEN = re.compile(r"^; Screen:\s*(\S+)")
# any other declaration header ENDS the screen. Reading to the next
# "; Screen:" swallowed the menus that follow the last one, which made their
# side of ACSM3's s_status_digital look like 31 draws instead of 19.
_OTHER = re.compile(r"^; (Menu|Function|State machine|State):|^; =+ ")
_CALL = re.compile(r"^\s*[0-9a-f]{4}:\s+CALL\s+sys\s+(\S+)")
# FRAME opens a new argument list, and any CALL closes one. Resetting only on
# `CALL sys` let a preceding `CALL user`'s arguments leak forward, so a screen
# whose row reads `ergebnisAnalogAusgabe(..., "STAT_X_WERT")` before
# `INPAapiResultText(..., "STAT_X_EINH")` reported the WERT as the read's key.
_FRAME = re.compile(r"^\s*[0-9a-f]{4}:\s+(FRAME|CALL)\b")
_STR = re.compile(r'^\s*[0-9a-f]{4}:\s+LOAD\s+const\[\d+\]\s*;\s*string\s+"(.*)"')


def xref_screens(ipo_path):
    """{screen: {"draws": [...], "keys": [...]}} from the external tool."""
    if not XREF_CMD:
        raise SystemExit("set XREF_CMD to the external disassembler command")
    cmd = XREF_CMD.replace("{ipo}", ipo_path)
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                             timeout=120).stdout
    except subprocess.TimeoutExpired:
        return {}
    screens, cur, pending = {}, None, []
    for ln in out.splitlines():
        m = _SCREEN.match(ln)
        if m:
            cur = {"draws": [], "keys": []}
            screens[m.group(1)] = cur
            pending = []
            continue
        if _OTHER.match(ln):
            cur = None
            continue
        if cur is None:
            continue
        m = _STR.match(ln)
        if m:
            pending.append(m.group(1))
            continue
        if _FRAME.match(ln) and not _CALL.match(ln):
            pending = []
            continue
        m = _CALL.match(ln)
        if m:
            fn = m.group(1)
            if fn in DRAWS:
                cur["draws"].append(fn)
            elif fn in READS and pending:
                # the result key is the first string argument of the call
                cur["keys"].append(pending[0])
            pending = []
    return screens


def ours(ecu, kind="screen"):
    """The same census, taken from our own decode.

    SCREENS ONLY, by declaration type -- not by name. Comparing every
    declaration counted our functions and menus as screens the other decoder
    had missed, which reported 8,273 phantom disagreements.
    """
    data, ps, pool, decls = D.load(ecu)
    out = {}
    for k, (off, typ, name, pid) in enumerate(decls):
        if typ != kind:
            continue
        lo = D.body_start(data, off, name)
        hi = decls[k + 1][0] if k + 1 < len(decls) else ps
        try:
            toks, _, _ = D.walk(data, lo, hi, pool)
        except Exception:                                       # noqa: BLE001
            continue
        draws, keys, pending = [], [], []
        for t in toks:
            if t["op"] == "const" and isinstance(t.get("v"), str):
                pending.append(t["v"])
                continue
            if t["op"] == "call":
                fn = t.get("name")
                if fn in DRAWS:
                    draws.append(fn)
                elif fn in READS and pending:
                    keys.append(pending[0])
                pending = []
            elif t["op"] == "frame":
                pending = []
        out[name] = {"draws": draws, "keys": keys}
    return out


def _same_keys(ref, got):
    """Key lists agree, allowing for the reference's display truncation.

    The external listing clips a long constant when it prints it, so
    STAT_VVT_VERSTELLBEREICH_LERNROUTINE_WERT arrives as ..._WER. Comparing
    on the prefix both sides actually printed keeps that from reading as a
    decode disagreement.
    """
    if len(ref) != len(got):
        return False
    return all(a[:min(len(a), len(b))] == b[:min(len(a), len(b))]
               for a, b in zip(ref, got))


def compare(ecu, verbose=False):
    path = D.L1.ipo_path(ecu)
    theirs = xref_screens(path)
    mine = ours(ecu)
    t = Counter()
    for name, ref in theirs.items():
        got = mine.get(name)
        t["screens"] += 1
        if got is None:
            t["we-miss-screen"] += 1
            if verbose:
                print(f"  {name}: we decoded no such screen")
            continue
        if ref["draws"] == got["draws"]:
            t["draws-exact"] += 1
        else:
            t["draws-differ"] += 1
            if verbose:
                print(f"  {name}: draws ref={len(ref['draws'])} "
                      f"ours={len(got['draws'])}")
        if _same_keys(ref["keys"], got["keys"]):
            t["keys-exact"] += 1
        else:
            t["keys-differ"] += 1
            if verbose:
                miss = [k for k in ref["keys"] if k not in got["keys"]]
                extra = [k for k in got["keys"] if k not in ref["keys"]]
                print(f"  {name}: keys ref={len(ref['keys'])} "
                      f"ours={len(got['keys'])} miss={miss[:4]} "
                      f"extra={extra[:4]}")
    for name in mine:
        if name not in theirs:
            t["we-have-extra"] += 1
    return t


def main(argv):
    if "--corpus" in argv:
        import glob
        import time
        # the tree holds both .IPO and .ipo -- a case-sensitive glob saw
        # only 763 of the 1,788 scripts
        sgdat = os.path.join(R, "vendor", "EC-APPS", "INPA", "SGDAT")
        names = sorted({os.path.basename(p)[:-4]
                        for p in glob.glob(os.path.join(sgdat, "*.IPO"))
                        + glob.glob(os.path.join(sgdat, "*.ipo"))})
        tot = Counter()
        t0 = time.time()
        for i, ecu in enumerate(names, 1):
            try:
                tot.update(compare(ecu))
            except Exception:                                   # noqa: BLE001
                tot["ecu-failed"] += 1
            if i % 50 == 0:
                el = time.time() - t0
                print(f"  [{i:4}/{len(names)}] {el:5.0f}s, "
                      f"~{el / i * (len(names) - i):4.0f}s left", flush=True)
        sc = tot["screens"] or 1
        print(f"\n{tot['screens']} screens seen by both decoders "
              f"({tot['ecu-failed']} ECUs failed)")
        print(f"\n  draw sequence identical  {tot['draws-exact']:6}  "
              f"({100 * tot['draws-exact'] / sc:5.1f}%)")
        print(f"  draw sequence differs    {tot['draws-differ']:6}")
        print(f"\n  result keys identical    {tot['keys-exact']:6}  "
              f"({100 * tot['keys-exact'] / sc:5.1f}%)")
        print(f"  result keys differ       {tot['keys-differ']:6}")
        print(f"\n  screens only they found  {tot['we-miss-screen']:6}")
        print(f"  screens only we found    {tot['we-have-extra']:6}")
        return 0
    ecu = next((a for a in argv[1:] if not a.startswith("-")), None)
    if not ecu:
        raise SystemExit(__doc__)
    t = compare(ecu, verbose=True)
    print(f"\n{ecu}: {dict(t)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
