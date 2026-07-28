#!/usr/bin/env python3
"""Build the MS45.1 status-menu hierarchy INPA actually presents.

The app has been flattening every mined screen into one Status list -- 38
entries, of which only the first 9 get a footer F-key. INPA never does that:
it nests them, so no screen is more than a few keys away.

    m_main F5 Status ─► m_status  F1 Digital  ─► m_digital
                                  F2 Analog   ─► m_mwb
                                  F3 DK/LL, F4 VANOS, F5 PM-IBS,
                                  F6 exhaust, F7 rough
           F8 adaption  ─► s_ada_loe
           F9 System    ─► m_system  (the six system-check screens)

This walks the decoded .IPO menus from m_status (plus the System/adaption
branches off m_main), resolves each item to the job its screen drives, and
emits a nested tree the renderer can page through.

Items INPA implements inline (MWB blocks, OBD-status: set an argument and
redraw rather than calling setscreen) resolve to no target in the bytecode,
so they are matched to their job by label.

    python3 tools/ms45_menu_tree.py            # print the tree
    python3 tools/ms45_menu_tree.py --write    # merge into MS450.json
"""
import os
import re
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_layout as L  # noqa: E402

IPO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "vendor", "EC-APPS", "INPA", "SGDAT", "MS450.IPO")
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")

# INPA softkeys that are chrome, not pages
SKIP = re.compile(r"^(back|zur(ü|ue)ck|end|ende|exit|print(ing)?|drucken|"
                  r"select|deselect|clear|ausw)$", re.I)

# menu/screen proc -> the job whose screen it drives. Anything the bytecode
# resolves is used directly; these cover the inline handlers (which call no
# setscreen) and the procs whose screen we ship under a different job name.
PROC_JOB = {
    "s_digital1": "STATUS_DIGITAL_1",
    "s_llst_mdk": "STATUS_ADAPTION_DK_LLSTELLER",
    "s_vanos_inex": "STATUS_MESSWERTE_VANOS",
    "s_laufunruhe": "STATUS_MOTORLAUFUNRUHE",
    "s_ad_gemisch": "STATUS_ADAPTION_GEMISCH",
    "s_main_pm": "STATUS_SYSTEMCHECK_PM_INFO_1",
    "s_ada_loe": "STATUS_NOCKENWELLE_ADAPTION",
    "s_systemtest_ev_ausbl": "STATUS_SYSTEMCHECK_EVAUSBL",
    "s_system_l_sonde": "STATUS_SYSTEMCHECK_L_SONDE",
    "s_systemtest_sls": "STATUS_SYSTEMCHECK_SEK_LUFT",
    "s_systemtest_tev": "STATUS_SYSTEMCHECK_TEV",
    "s_systemtest_dmtl": "STATUS_SYSTEMCHECK_DMTL",
    "s_llabgl": "STATUS_SYSTEMCHECK_LLERH",
    "s_fdyn": "STATUS_MESSWERTBLOCK_7",
}
# inline items, matched by their menu label
LABEL_JOB = {
    ("m_digital", "OBD-status"): "STATUS_OBD",
    ("m_digital", "regulation"): "STATUS_FUNKTIONS",
    ("m_mwb", "MWB 1"): "STATUS_MESSWERTBLOCK_1",
    ("m_mwb", "MWB 3"): "STATUS_MESSWERTBLOCK_3",
    ("m_mwb", "MWB 4"): "STATUS_MESSWERTBLOCK_4",
    ("m_mwb", "MWB 5"): "STATUS_MESSWERTBLOCK_5",
    ("m_mwb", "MWB 6"): "STATUS_MESSWERTBLOCK_6",
    ("m_mwb", "MWB 11"): "MESSWERTBLOCK_LESEN",
    ("m_mwb", "SAE J1979"): "STATUS_MESSWERTBLOCK_0",
    ("m_mwb", "ADC"): "STATUS_MESSWERTBLOCK_2",
}
# a screen target that opens a further menu of its own
SCREEN_MENU = {"s_digital": "m_digital", "s_mwb": "m_mwb",
               "s_system": "m_system", "s_status": "m_status"}


def build_tree(menus, name, jobs, seen=None):
    """One menu -> {label, fkey, job?, items?} entries, recursing into submenus."""
    seen = seen or set()
    if name in seen:
        return []
    seen = seen | {name}
    mu = menus.get(name)
    if not mu:
        return []
    out = []
    for it in mu["items"]:
        label = (it.get("label") or "").strip()
        if not label or SKIP.match(label):
            continue
        target, kind = it.get("target"), it.get("target_kind")
        # a target that is really a gateway to another menu
        sub = SCREEN_MENU.get(target) if kind == "screen" else (
            target if kind == "menu" else None)
        if sub and sub != name:
            kids = build_tree(menus, sub, jobs, seen)
            if kids:
                out.append({"label": label, "fkey": it["fkey"], "items": kids})
                continue
        job = (PROC_JOB.get(target) if target else None) \
            or LABEL_JOB.get((name, label))
        if job and job in jobs:
            out.append({"label": label, "fkey": it["fkey"], "job": job})
    return out


def main():
    menus = {m["name"]: m for m in L.extract_menus(IPO)}
    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    jobs = {s["job"] for s in lay["screens"]}

    tree = build_tree(menus, "m_status", jobs)
    # adaption + System hang off m_main, not m_status, but belong to the same
    # status hierarchy as far as the app is concerned
    for label, mname in (("Adaption", "m_ada_loe"), ("System", "m_system")):
        root = menus.get("m_main")
        item = next((i for i in (root["items"] if root else [])
                     if i["label"].lower().startswith(label.lower()[:5])), None)
        if mname == "m_ada_loe":
            kids = [{"label": "Camshaft adaptation", "fkey": 1,
                     "job": "STATUS_NOCKENWELLE_ADAPTION"}] \
                if "STATUS_NOCKENWELLE_ADAPTION" in jobs else []
        else:
            kids = build_tree(menus, mname, jobs)
        if kids:
            tree.append({"label": label,
                         "fkey": item["fkey"] if item else 9, "items": kids})

    def show(items, d=0):
        for i in items:
            if "items" in i:
                print("   " * d + f"F{i['fkey']:<3} {i['label']}/")
                show(i["items"], d + 1)
            else:
                print("   " * d + f"F{i['fkey']:<3} {i['label']:26} {i['job']}")

    if "--write" not in sys.argv:
        show(tree)
        leaves = json.dumps(tree).count('"job"')
        print(f"\n{leaves} screens reachable through the tree")
        return 0

    lay["statusTree"] = tree
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"statusTree written -> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
