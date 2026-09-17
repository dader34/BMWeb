#!/usr/bin/env python3
"""The importer's parts-line validity: w_btzeilen's window, side, gearbox,
condition and comment, read into the records the viewer's lines.js consumes.

    python3 tools/verify/test_etk_lines.py
"""
import gzip
import json
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from etk_import import build_lines, comment_text, line_conditions  # noqa: E402

PASSED = 0


def ok(what):
    global PASSED
    PASSED += 1
    if os.environ.get("V"):
        print("  ok", what)


def eq(got, want, what):
    assert got == want, f"{what}: got {got!r}, want {want!r}"
    ok(what)


def db():
    con = sqlite3.connect(":memory:")
    con.executescript("""
    CREATE TABLE w_ben_gk (ben_textcode INTEGER, ben_iso TEXT, ben_regiso TEXT, ben_text TEXT);
    CREATE TABLE w_komm (komm_id INTEGER, komm_pos INTEGER, komm_textcode INTEGER, komm_tiefe INTEGER, komm_darstellung TEXT, komm_vz TEXT, komm_code TEXT);
    CREATE TABLE w_btzeilen (btzeilen_btnr TEXT, btzeilen_pos INTEGER, btzeilen_hg TEXT, btzeilen_bildposnr TEXT, btzeilen_sachnr TEXT, btzeilen_kat TEXT, btzeilen_automatik TEXT, btzeilen_lenkg TEXT, btzeilen_eins INTEGER, btzeilen_auslf INTEGER, btzeilen_bedkez TEXT, btzeilen_regelnr TEXT, btzeilen_kommbt INTEGER, btzeilen_kommvor INTEGER, btzeilen_kommnach INTEGER, btzeilen_gruppeid TEXT, btzeilen_blocknr TEXT, btzeilen_bedkez_pg TEXT);
    CREATE TABLE w_fztyp (fztyp_mospid INTEGER, fztyp_baureihe TEXT);
    CREATE TABLE w_btzeilen_verbauung (btzeilenv_mospid INTEGER, btzeilenv_btnr TEXT, btzeilenv_pos INTEGER, btzeilenv_sachnr TEXT);
    """)
    con.executemany("INSERT INTO w_ben_gk VALUES (?,?,?,?)", [
        (500000560, 'en', None, 'For vehicles with'), (500237, 'en', None, 'Headlight cleaning system'),
        (600, 'en', None, 'and'), (601, 'en', None, 'M Sports package'), (602, 'en', None, 'Sport Line'),
        (700, 'en', None, 'See also'), (500237, 'de', None, 'Scheinwerferreinigungsanlage'),
    ])
    con.executemany("INSERT INTO w_komm VALUES (?,?,?,?,?,?,?)", [
        (3302572, 1, 500000560, 0, 'F', ' ', None), (3302572, 2, 500237, 0, 'N', '+', None),
        (9, 1, 500000560, 0, 'F', ' ', None), (9, 2, 601, 0, 'N', '-', None), (9, 3, 600, 0, 'F', ' ', None), (9, 4, 602, 0, 'N', '-', None),
        (10, 1, 700, 0, 'F', ' ', None),
    ])
    rows = [
        # btnr, pos, hg, callout, sachnr, kat, auto, lenkg, eins, auslf, bedkez, regel, kommbt, kommvor, kommnach
        ('51_3267', 19, '51', '03', '8227641', None, None, None, None, 20010900, 'D', None, None, 3302572, None),
        ('51_3267', 23, '51', '03', '7043407', None, None, None, 20010900, None, 'D', None, None, 3302572, None),
        ('51_3267', 15, '51', '03', '7043409', None, None, None, 20010900, None, None, None, None, None, None),
        ('51_3267', 30, '51', '04', '1111111', None, 'A', 'R', None, None, None, None, None, 9, 10),
        ('51_3267', 31, '51', '05', '2222222', None, None, None, None, None, None, None, None, None, None),
        ('51_3267', 32, '51', None, '3333333', None, None, None, 19990300, None, None, None, None, None, None),
        ('11_0001', 1, '11', '01', '4444444', None, None, None, None, None, 'B', None, None, None, None),
    ]
    con.executemany("INSERT INTO w_btzeilen VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)", rows)
    con.execute("INSERT INTO w_fztyp VALUES (47720, 'E46')")
    con.executemany("INSERT INTO w_btzeilen_verbauung VALUES (?,?,?,?)", [
        (47720, '51_3267', 19, '8227641'), (47720, '51_3267', 23, '7043407'), (47720, '51_3267', 15, '7043409'),
        (47720, '51_3267', 30, '1111111'), (47720, '51_3267', 31, '2222222'), (47720, '51_3267', 32, '3333333'),
    ])
    return con


def main():
    con = db()
    names = {c: t for c, t in con.execute("SELECT ben_textcode, ben_text FROM w_ben_gk WHERE ben_iso='en'")}
    cache = {}
    eq(comment_text(con, names, 3302572, cache), 'For vehicles with +Headlight cleaning system', 'a named piece carries its sign')
    eq(comment_text(con, names, 9, cache), 'For vehicles with -M Sports package and -Sport Line', 'without is a minus')
    eq(comment_text(con, names, 10, cache), 'See also', 'a fixed piece is plain')
    eq(comment_text(con, names, 404, cache), '', 'an unknown comment is empty')

    conds = line_conditions(con, ['51_3267', '11_0001'], names)
    eq(conds[('51_3267', 19)], {'t': 200109, 'c': 'D', 'n': 'For vehicles with +Headlight cleaning system'}, 'up to 09/2001, condition D, its note')
    eq(conds[('51_3267', 23)], {'f': 200109, 'c': 'D', 'n': 'For vehicles with +Headlight cleaning system'}, 'from 09/2001')
    eq(conds[('51_3267', 15)], {'f': 200109}, 'a bare window')
    eq(conds[('51_3267', 30)], {'s': 'R', 'a': 'A', 'n': 'For vehicles with -M Sports package and -Sport Line / See also'}, 'side, gearbox, both comments')
    eq(('51_3267', 31) in conds, False, 'a line with nothing has no record')
    eq(conds[('11_0001', 1)], {'c': 'B'}, 'a condition letter alone')

    out = tempfile.mkdtemp()
    r = build_lines(con, 'E46', names, out, quiet=True)
    eq(r[0], 1, 'one diagram')
    eq(r[1], 5, 'five conditioned lines on it (the no-callout one included)')
    with gzip.open(os.path.join(out, 'E46.lines.json.gz')) as f:
        side = json.load(f)
    eq(side['v'], 1, 'version')
    ln = side['ln']['51_3267']
    eq(ln['03|8227641'], [{'t': 200109, 'c': 'D', 'n': 'For vehicles with +Headlight cleaning system'}], 'keyed by callout and part number')
    eq(ln['03|7043407'], [{'f': 200109, 'c': 'D', 'n': 'For vehicles with +Headlight cleaning system'}], 'the facelift line')
    eq(ln['04|1111111'], [{'s': 'R', 'a': 'A', 'n': 'For vehicles with -M Sports package and -Sport Line / See also'}], 'the side and gearbox line')
    eq(ln['32|3333333'], [{'f': 199903}], 'a line without a callout keys by its line number, as the bundle shows it')
    eq('05|2222222' in ln, False, 'nothing to say, nothing shipped')
    eq(build_lines(con, 'E90', names, out, quiet=True), None, 'a chassis with no lines writes nothing')
    print(f"test_etk_lines: {PASSED} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
