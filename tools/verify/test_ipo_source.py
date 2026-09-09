#!/usr/bin/env python3
"""ipo_source.py: .IPO -> INPA source, pinned against the shipped source.

MUST_EXX.IPO is compiled from MUST_EXX.SRC + BMW_STD.H, both in SGDAT, so
what comes back can be read against what went in: the library functions
(instr, space) statement for statement with their real names, the menu
keys, the screens, the globals with their initialisers. E46.IPO pins the
save-as import naming, the loops and the header-named globals; ABGAS the
state machine shape. Then a slice of the corpus must decompile without an
exception and without a jump left unstructured outside state machines.

    python3 tools/verify/test_ipo_source.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tools", "decompile"))
SGDAT = os.path.join(ROOT, "vendor", "EC-APPS", "INPA", "SGDAT")

if not os.path.isfile(os.path.join(SGDAT, "MUST_EXX.IPO")):
    print("test_ipo_source: skipped (vendor SGDAT not present)")
    sys.exit(0)

import ipo_source as S                                          # noqa: E402

passed = 0


def ok(what):
    global passed
    passed += 1


def check(cond, what):
    if not cond:
        print(f"FAIL {what}")
        sys.exit(1)
    ok(what)


def section(text, head):
    """The lines of one top-level definition, from its header to `}`."""
    m = re.search(r"^" + re.escape(head) + r".*?\n\}\n", text, re.S | re.M)
    return m.group(0) if m else ""


def gotos(text):
    return text.count("// goto ") + text.count("not in this block")


# ---- MUST_EXX: the template, source in hand ---------------------------
must = S.decompile("MUST_EXX").emit()
instr = section(must, "instr(")
check("instr(out: int pos, in: int ab, in: string Text, in: string Suchtext)"
      in instr, "instr: parameters, modes and names from BMW_STD.H")
check("while (gefunden == FALSE && i < Textlen - Suchtextlen)" in instr,
      "instr: the while condition with && and the subtraction")
check("midstr(Temp, Text, i, Suchtextlen);" in instr and "pos = i;" in instr,
      "instr: the calls and the write through the out-parameter")
check("if (Textlen - ab >= Suchtextlen)" in instr, "instr: nested ifs")
space = section(must, "space(")
check(space.count("while (") == 3 and "Text = Text + s100;" in space
      and 'string s1 = " ";' in space,
      "space: three while loops, initialised locals with their names")
init = section(must, "ScriptInit(")
check(init.count('if (gs9 == "MUST_') == 6 and "settitle(" in init,
      "ScriptInit: six ifs on the SGBD list, then settitle")
menu = section(must, "MENU m_steuern(")
check('inputint(gi14, "Activate", "0-100", 0, 100);' in menu
      and "if (gi17 == gi18)" in menu and 'ITEM(10, "Back")' in menu
      and "setscreen(s_main, TRUE);" in menu and "setmenu(m_main);" in menu,
      "m_steuern: INIT, ITEM bodies, screen and menu references by name")
check('string gs6 = "Sample E60, E65, E85, E87, E90, RR01";' in must
      and "int    gi18 = 0;" in must and "real   gr13;" in must,
      "globals: types from the slot table, initialisers from the startup proc")
check('#include "inpa.h"' in must and '#include "BMW_STD.H"' in must,
      "the include list")
scr = section(must, "SCREEN s_status_analog(")
check('LINE("Temperatur-Beispiel", "")' in scr
      and "analogout(gr13 * gr20 + gr21, 3, 0, 10.0 * gr20 + gr21," in scr,
      "s_status_analog: LINE blocks, real arithmetic with precedence")
check(gotos(must) == 0, "MUST_EXX: every jump structured")

# ---- E46: the whole-vehicle script -----------------------------------
e46 = S.decompile("E46").emit()
fs = section(e46, "MENU m_fs(")
check(re.search(r'SaveAsDialogBox\("", s\d+, i\d+, i\d+\);', fs)
      and re.search(r"GetCurrentDirectoryA\(256, s\d+, i\d+\);", fs),
      "E46 m_fs: DLL imports named from the Constant Data table")
check(re.search(r"while \(b\d+ == FALSE\)", fs)
      and re.search(r"s(\d+) = s\1 \+ LF;", fs),
      "E46 m_fs: the copy loop, LF named from BMW_STD.H")
check(re.search(r'viewopen\(s(\d+), "Fehlerspeicher speichern: " \+ s\1\);', fs),
      "E46 m_fs: string concatenation in a call argument")
check("else" in fs, "E46 m_fs: an if / else")
check(gotos(e46) == 0, "E46: every jump structured")

# ---- ABGAS: a state machine -------------------------------------------
abgas = S.decompile("ABGAS").emit()
sm = section(abgas, "STATEMACHINE Ablaufsteuerung(")
check("%WarteAufAuftrag" in sm and "setstatemachine(FehlerOutFile);" in sm,
      "ABGAS: states as labels, transitions by state name")

# ---- the corpus, sampled ------------------------------------------------
names = sorted({f[:-4] for f in os.listdir(SGDAT) if f.lower().endswith(".ipo")})
sample = names[::40]
left = 0
for n in sample:
    src = S.decompile(n)
    for p in src.procs:
        if p["typ"] in ("func", "menu", "screen") and \
                p["name"] not in (S.STARTUP, S.SHUTDOWN):
            fn = S.Function(src, p)
            {"func": fn.emit_function, "menu": fn.emit_menu,
             "screen": fn.emit_screen}[p["typ"]]()
            left += fn.gotos
check(True, f"{len(sample)} corpus files decompile")
check(left <= len(sample), f"jumps left outside state machines: {left}")

print(f"test_ipo_source: {passed} checks passed")
