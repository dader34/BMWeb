#!/usr/bin/env python3
"""Extract ISTA's control unit trees into data/ista/ecu-tree/.

ISTA draws its "Control unit tree" (Vehicle information) from one
EcuTreeConfiguration XML per series, embedded as manifest resources in
RheingoldDiagnostics.dll. Each lists every module the series can carry with
its diagnostic address, the group SGBDs it is reached through, the bus it
sits on and the grid cell it is drawn in, plus one BusLogisticsEntry per
bus line saying which column the line runs in and how it is painted.

The blobs sit in the DLL in the same order as the manifest resource names
(BMW.Rheingold.Diagnostics.EcuCharacteristics.Xml.<Series>EcuCharacteristics.xml),
which is how each tree gets its series name; nothing inside the XML says it.

    python3 tools/ista/ecu_tree_extract.py            # $BMWFILES/ista/RheingoldDiagnostics.dll
    python3 tools/ista/ecu_tree_extract.py --dll /path/RheingoldDiagnostics.dll
    python3 tools/ista/ecu_tree_extract.py --out data/ista/ecu-tree

Writes <Series>.json per tree and index.json (every tree's size and buses,
and the map from BMWeb's chassis ids to the tree each draws with). The
output is BMW-derived data: data/ista/ is gitignored and hosted like the
rest of the ISTA extracts.
"""
import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
NS = {"t": "http://bmw.com/Rheingold/EcuTreeConfiguration"}
RESOURCE = re.compile(
    rb"BMW\.Rheingold\.Diagnostics\.EcuCharacteristics\.Xml\.([A-Za-z0-9_]+)\.xml")
BLOB = re.compile(rb"<EcuTreeConfiguration\b.*?</EcuTreeConfiguration>", re.S)

# BMWeb chassis id -> the ISTA tree that draws it. ISTA keys trees by the
# platform, so several of our chassis share one: the E8x/E9x family draws
# with E89, F07/F10 with F01, F30 with F20, R56 with R55, RR1 with RR.
# E31 and E34 predate ISTA and have no tree.
CHASSIS_TREE = {
    "E36": "E36", "E38": "E38", "E39": "E39", "E46": "E46", "E52": "E52",
    "E53": "E53", "E60": "E60", "E65": "E65", "E70": "E70", "E83": "E83",
    "E85": "E85", "E87": "E89", "E89": "E89", "E90": "E89", "F01": "F01",
    "F07": "F01", "F10": "F01", "F25": "F25", "F30": "F20", "R50": "R50",
    "R56": "R55", "RR1": "RR",
}

# Buses ISTA never draws: an ECU on them is listed but has no box.
HIDDEN_BUSES = {"UNKNOWN", "VIRTUAL", "NONE", "INTERNAL"}


def trees_in(dll_bytes):
    """[(series, xml bytes)] in manifest order."""
    names = []
    for m in RESOURCE.finditer(dll_bytes):
        n = m.group(1).decode()
        n = n[:-len("EcuCharacteristics")] if n.endswith("EcuCharacteristics") else n
        if n not in names:
            names.append(n)
    blobs = [m.group() for m in BLOB.finditer(dll_bytes)]
    if len(names) != len(blobs):
        raise SystemExit(f"{len(names)} resource names but {len(blobs)} trees: "
                         "the DLL layout changed, refusing to guess")
    return list(zip(names, blobs))


def _ints(el, tag):
    """Every <tag> integer directly under an element."""
    out = []
    for c in el.findall(f"t:{tag}", NS):
        text = (c.text or "").strip()
        if text.lstrip("-").isdigit():
            out.append(int(text))
    return out


def parse_tree(series, blob):
    """One tree as the app reads it.

    EVERYTHING THE TOOL'S TREE READS IS CARRIED. The first cut of this kept
    what a box-and-line drawing needed; the tool's own drawing
    (EcuTreeNewViewModel) also reads each bus line's relative offsets and
    its address rule, the lines that join two buses, the housings that frame
    several units as one, the name each bus goes by on this series, and the
    lists that decide which units a car is expected to carry. The earlier
    keys are unchanged, so nothing that read the old shape has to move.
    """
    root = ET.fromstring(blob)
    text = lambda el, k, d="": (el.findtext(f"t:{k}", default=d, namespaces=NS) or d).strip()
    num = lambda v, d=0.0: float(v) if v not in ("", None) else d
    ecus = []
    for e in root.findall(".//t:EcuLogisticsEntry", NS):
        groups = (e.findtext("t:GroupSgbd", default="", namespaces=NS) or "")
        sub = e.findtext("t:SubDiagAddress", default=None, namespaces=NS)
        sub_bus = [b.text.strip() for b in e.findall("t:SubBusList/t:BusEntry", NS) if b.text]
        short = text(e, "ShortName")
        ecus.append({
            "name": e.get("Name") or "",
            "addr": int(e.get("DiagAddress") or -1),
            "groups": [g.strip().lower() for g in groups.split("|") if g.strip()],
            "bus": e.findtext("t:Bus", default="", namespaces=NS) or "",
            "col": int(e.findtext("t:Column", default="0", namespaces=NS) or 0),
            "row": int(e.findtext("t:Row", default="0", namespaces=NS) or 0),
            **({"sub": int(sub)} if sub and sub.strip().lstrip("-").isdigit() else {}),
            **({"subBus": sub_bus} if sub_bus else {}),
            **({"short": short} if short else {}),
        })
    buses = []
    for b in root.findall(".//t:BusLogisticsEntry", NS):
        f = lambda k, d="": text(b, k, d)
        req = _ints(b, "RequiredEcuAddresses")
        buses.append({
            "bus": b.get("Bus") or "",
            "col": int(f("Column", "0") or 0),
            "minRow": int(f("MinRow", "0") or 0),
            "maxRowLimit": int(f("MaxRowLimit", "-1") or -1),
            "paintToRoot": f("PaintToRoot") == "true",
            "connectOnlyRight": f("ConnectOnlyToRightEcu") == "true",
            "vertical": f("DrawVerticalLines") != "false",
            "horizontal": f("DrawHorizontalLines") != "false",
            "x": num(f("XRelativeOffset", "0")),
            "y": num(f("YRelativeOffset", "0")),
            **({"bike": True} if f("BikeBus") == "true" else {}),
            **({"req": req} if req else {}),
        })
    links = []
    for c in root.findall(".//t:BusInterConnectionEntry", NS):
        req = _ints(c, "RequiredEcuAddresses")
        links.append({
            "bus": c.get("Bus") or "",
            "x1": num(text(c, "XStart", "0")), "y1": num(text(c, "YStart", "0")),
            "x2": num(text(c, "XEnd", "0")), "y2": num(text(c, "YEnd", "0")),
            **({"req": req} if req else {}),
        })
    housings = []
    for h in root.findall(".//t:CombinedEcuHousingEntry", NS):
        req = _ints(h, "RequiredEcuAddresses")
        housings.append({
            "col": int(text(h, "Column", "0") or 0),
            "row": int(text(h, "Row", "0") or 0),
            "count": int(text(h, "EcuCount", "1") or 1),
            **({"req": req} if req else {}),
        })
    variants = []
    for v in root.findall(".//t:SGBDBusLogisticsEntry", NS):
        sub_bus = [b.text.strip() for b in v.findall("t:SubBusList/t:BusEntry", NS) if b.text]
        variants.append({
            "variant": text(v, "Variant").lower(),
            "bus": text(v, "Bus"),
            **({"subBus": sub_bus} if sub_bus else {}),
        })
    names = {n.get("Bus"): (n.text or "").strip()
             for n in root.findall(".//t:BusNameEntry", NS) if n.get("Bus")}
    out = {
        "series": series,
        "mainSgbd": root.get("MainSeriesSgbd") or "",
        "ecus": ecus,
        "buses": buses,
    }
    if links:
        out["links"] = links
    if housings:
        out["housings"] = housings
    if variants:
        out["variants"] = variants
    if names:
        out["busNames"] = names
    # which units a car is expected to carry before any of them has answered
    for key, tag in (("minimal", "MinimalConfigurationEntry"),
                     ("excluded", "ExcludedConfigurationEntry"),
                     ("optional", "OptionalConfigurationEntry"),
                     ("unsure", "UnsureConfigurationEntry")):
        vals = []
        for c in root.iter("{%s}%s" % (NS["t"], tag)):
            t = (c.text or "").strip()
            if t.lstrip("-").isdigit():
                vals.append(int(t))
        if vals:
            out[key] = vals
    # sets a car carries ONE of: once one member has identified, the tool
    # drops the others that have not (ShapeECUConfiguration)
    xor = []
    for c in root.iter("{%s}XorConfigurationEntry" % NS["t"]):
        one_of = [int(i.text) for i in c if (i.text or "").strip().lstrip("-").isdigit()]
        if len(one_of) >= 2:
            xor.append(one_of)
    if xor:
        out["xor"] = xor
    compat = text(root, "CompatibilityInfo")
    if compat:
        out["compat"] = [ln.strip() for ln in compat.splitlines() if len(ln.strip()) >= 10]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dll", default=os.path.join(
        os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES")),
        "ista", "RheingoldDiagnostics.dll"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "ista", "ecu-tree"))
    ns = ap.parse_args()
    if not os.path.exists(ns.dll):
        raise SystemExit(f"no DLL at {ns.dll} (extract RheingoldDiagnostics.dll from the ISTA installer)")
    data = open(ns.dll, "rb").read()
    os.makedirs(ns.out, exist_ok=True)
    index = {"version": 1, "trees": {}, "chassis": {}}
    for series, blob in trees_in(data):
        tree = parse_tree(series, blob)
        drawn = [e for e in tree["ecus"] if e["bus"] not in HIDDEN_BUSES]
        index["trees"][series] = {
            "ecus": len(drawn),
            "buses": sorted({e["bus"] for e in drawn}),
            "mainSgbd": tree["mainSgbd"],
        }
        with open(os.path.join(ns.out, f"{series}.json"), "w", encoding="utf-8") as f:
            json.dump(tree, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  {series:32} {len(drawn):3} modules  {' '.join(index['trees'][series]['buses'])}")
    missing = [c for c, t in CHASSIS_TREE.items() if t not in index["trees"]]
    if missing:
        raise SystemExit(f"chassis map names trees the DLL lacks: {missing}")
    index["chassis"] = dict(CHASSIS_TREE)
    with open(os.path.join(ns.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(index['trees'])} trees -> {ns.out}; {len(CHASSIS_TREE)} chassis mapped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
