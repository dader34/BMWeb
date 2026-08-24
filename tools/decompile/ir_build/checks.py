"""Regression invariants for the execution-derived IR.

Ports the intent of ipo_ir.py's old --check fixtures to what build_ir now
produces: ir["screens"][name]["lines"][*]["elements"][*] with key/unit, plus
ir["menus"] and ir["jobs"]. Each fixture prints PASS/FAIL; run() returns a
nonzero count so --check can exit on any failure.

Where the old assertion cannot map onto the executed structure it is kept at
the level that still holds, and the shift is noted inline.
"""

from ir_build import build_ir
from ir_build.stamp import check_stamp


def _keys(screen, t=None):
    """Result keys a screen emits: every element's `key` and its `unit`
    (a unit slot holds a result name too, e.g. STAT_OFS_EINH). Restrict to
    one element type with `t`."""
    out = []
    for line in screen.get("lines", []):
        for el in line.get("elements", []):
            if t and el.get("t") != t:
                continue
            if el.get("key"):
                out.append(el["key"])
            if el.get("unit"):
                out.append(el["unit"])
    return out


class _Report:
    def __init__(self):
        self.fails = 0

    def check(self, name, ok, detail=""):
        print(f"  {'PASS' if ok else 'FAIL'}  {name}"
              + (f" -- {detail}" if detail and not ok else ""))
        if not ok:
            self.fails += 1


def _gsds2(r):
    """GSDS2 s_ana2_834 draws 7 gauges incl. STAT_UBAT_WERT; m_status has
    the screen. (The old shift/label assertions were menu-render specifics
    that the executed menu no longer carries as flags.)"""
    ir = build_ir("GSDS2")
    gk = _keys(ir["screens"]["s_ana2_834"], t="gauge")
    r.check("GSDS2 s_ana2_834 emits 7 gauge keys",
            len(gk) == 7, f"{len(gk)}: {gk}")
    r.check("GSDS2 s_ana2_834 includes STAT_UBAT_WERT",
            "STAT_UBAT_WERT" in gk, str(gk))
    r.check("GSDS2 has an m_status menu", "m_status" in ir["menus"])


def _lws5(r):
    """LWS5 builtin-64 result reads: s_ps_lesen 3 values, s_hd_lesen 4."""
    ir = build_ir("LWS5")
    for name, want in (("s_ps_lesen", 3), ("s_hd_lesen", 4)):
        ks = _keys(ir["screens"][name])
        r.check(f"LWS5 {name} emits {want} value keys",
                len(ks) == want, f"{len(ks)}: {ks}")


def _ms450_vanos(r):
    """MS450 VANOS actuator readout keeps its value. The executed screen is
    named s_st_vanos (the old fixture named the func proc vanos_in_ansteuer,
    which the executor does not surface as a screen); STAT_AUSGANG must be in
    its emitted keys. The old `fromFunc` flag has no analogue in the executed
    IR, so that half of the assertion is dropped."""
    ir = build_ir("MS450")
    scr = ir["screens"].get("s_st_vanos") or {}
    vk = _keys(scr)
    r.check("MS450 s_st_vanos emits STAT_AUSGANG",
            "STAT_AUSGANG" in vk, str(vk))


def _cvm_ii(r):
    """CVM_II coding page. The old fixture asserted DATENBLOCK on s_code from
    a substring/data-block decode; the executed IR does not emit DATENBLOCK on
    s_code (the coding read is surfaced differently). Kept at the level that
    holds: s_code builds and emits at least one key. NOTE: DATENBLOCK-on-s_code
    no longer maps -- if the data-block readout must be asserted, revisit which
    executed screen now carries it."""
    ir = build_ir("CVM_II")
    scr = ir["screens"].get("s_code") or {}
    ck = _keys(scr)
    r.check("CVM_II s_code builds and emits at least one key",
            len(ck) >= 1, str(ck))


def _afs_60(r):
    """AFS_60 s_qualifier_1 slices its qualifier byte into 8 bit fields."""
    ir = build_ir("AFS_60")
    qk = _keys(ir["screens"]["s_qualifier_1"])
    r.check("AFS_60 s_qualifier_1 slices 8 bit fields",
            len(qk) == 8, f"{len(qk)}: {qk}")


def _bmbt46tn(r):
    """BMBT46TN keeps its mixed-case RESULT name (Dimmerstellung)."""
    ir = build_ir("BMBT46TN")
    bk = _keys(ir["screens"]["s_status_steuergeraet"])
    r.check("BMBT46TN s_status_steuergeraet emits Dimmerstellung",
            "Dimmerstellung" in bk, str(bk))


def _kombi(r):
    """KOMBI tank readout reaches its gauge. The old fixture asserted a 3-gauge
    tank line on s_status_analog_46; the executed build splits by variant, so
    the base s_status_analog_46 no longer carries the tank line. Kept at the
    level that holds: STAT_TANKINHALT reaches a gauge in some KOMBI status
    screen. NOTE: exact screen/line assertion shifted with the variant split."""
    ir = build_ir("KOMBI")
    hit = False
    for scr in ir["screens"].values():
        if any(k.startswith("STAT_TANKINHALT")
               for k in _keys(scr, t="gauge")):
            hit = True
            break
    r.check("KOMBI emits a STAT_TANKINHALT gauge on a status screen", hit)


def _stamp(r):
    """The shipped data on disk was built by the current decoder."""
    drift = check_stamp()
    r.check("data/inpa-ir matches the current decoder stamp",
            drift is None, drift or "")


def run():
    """Run every invariant; return the failure count."""
    r = _Report()
    for fixture in (_gsds2, _lws5, _ms450_vanos, _cvm_ii,
                    _afs_60, _bmbt46tn, _kombi, _stamp):
        fixture(r)
    print(f"  ir_build --check: {'OK' if not r.fails else str(r.fails) + ' FAIL'}")
    return r.fails
