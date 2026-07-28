#!/usr/bin/env python3
"""Emit the MS45.1 Coding screen: the ECU's vehicle-option configuration.

ECU_CONFIG reports which options this DME is coded for -- automatic gearbox,
A/C, SMG, multifunction wheel, secondary-air pump and so on. Each option is a
pair:

    STAT_<X>        1 = vorhanden (fitted), 0 = nicht vorhanden
    STAT_<X>_TEXT   the option's name

INPA draws these as lamps (filled = fitted), which is the layout the renderer
reproduces, so a glance says what the ECU thinks the car has. Reading is safe;
ECU_CONFIG_RESET, which clears a subsystem's configuration, is a WRITE and is
flagged as such.

Labels come from the SGBD's own _TEXT results, so they are the ECU's wording
rather than a hand-written list, and they translate through the same token
table as everything else.

    python3 tools/ms45_coding.py            # print
    python3 tools/ms45_coding.py --write    # merge into MS450.json
"""
import os
import re
import sys
import json
import urllib.request

API = os.environ.get("BMACW_API", "http://127.0.0.1:8777")
SGBD = "ms450ds0"
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")

# the subsystem selectors on INPA's ECU-config reset menu (m_ecu_config_reset)
RESET_TARGETS = [
    ("Transmission", "AT"), ("Air conditioning", "AC"), ("SL system", "SLP"),
    ("Steering wheel", "MSW"), ("E-BOX / ECRAS", "ECRAS"), ("ACC/ASR", "ASR"),
]

# German option names -> English, applied to the ECU's own _TEXT wording
WORDS = [
    (r"\bAutomatik Getriebe\b", "Automatic transmission"),
    (r"\bKlima\s*Anlage\b", "Air conditioning"),
    (r"\bSMG Sequentielles Manuelles Getriebe\b", "SMG sequential gearbox"),
    (r"\bRoll Stabilisierung\b", "Roll stabilisation"),
    (r"\bASR Anti Schlupf Regelung\b", "ASR traction control"),
    (r"\bBordNetz 2000\b", "BN2000 electrical system"),
    (r"\bMultifunktions Lenkrad über CAN\b", "Multifunction wheel via CAN"),
    (r"\bMultiFunktionsLenkrad\b", "Multifunction steering wheel"),
    (r"\bEntfernungs-Überwachung\b", "Distance monitoring"),
    (r"\bE-Box Lüfter\b", "E-box fan"),
    (r"\bSMG/EGS Steuergerät\b", "SMG/EGS control unit"),
    (r"\bKombi über CAN\b", "Instrument cluster via CAN"),
    (r"\belektrische Lenkung\b", "Electric steering"),
    (r"\bSoundklappe\b", "Sound flap"), (r"\bSport-Taster\b", "Sport button"),
    (r"\bKomfort-Start\b", "Comfort start"), (r"\bTXU Allrad\b", "TXU all-wheel drive"),
    (r"\bE65/E60 Fahrzeug\b", "E65/E60 vehicle"),
    (r"\bSekundär\s*Luft\s*Pumpe\b", "Secondary-air pump"),
    (r"\bAbgas-Klappe\b", "Exhaust flap"), (r"\bKühler Jalousie\b", "Radiator shutter"),
    (r"\bKlimaRelais\b", "A/C relay"), (r"\bSecundaryAir Ventil\b", "Secondary-air valve"),
    (r"\bStarter Relais\b", "Starter relay"), (r"\bASR3 Bauteil\b", "ASR3 component"),
    (r"\bvorhanden\b", ""),          # every label ends with it; the lamp says it
]


def api(path):
    with urllib.request.urlopen(f"{API}{path}", timeout=60) as r:
        return json.load(r)


def english(s):
    for pat, rep in WORDS:
        s = re.sub(pat, rep, s)
    return re.sub(r"\s{2,}", " ", s).strip(" -:") or s.strip()


def build():
    rows = api(f"/api/ecu/{SGBD}/results/ECU_CONFIG")
    # pair each flag with the _TEXT that names it
    names, flags = {}, []
    for line in rows:
        key, _, desc = line.partition(" : ")
        key = key.strip()
        if key.endswith("_TEXT"):
            names[key[:-len("_TEXT")]] = desc.strip()
        elif key.startswith(("STAT_", "SLP_")) and "Variante" in desc:
            flags.append(key)
    options = [{"key": k, "label": english(names.get(k, k)), "raw": names.get(k, "")}
               for k in flags if k in names]
    return {
        "job": "ECU_CONFIG",
        "title": "ECU configuration",
        "subtitle": "Options this ECU is coded for · filled = fitted",
        "options": options,
        "reset": {
            "job": "ECU_CONFIG_RESET",
            "title": "Reset ECU configuration",
            "write": True,
            "targets": [{"label": t, "code": c} for t, c in RESET_TARGETS],
        },
    }


def main():
    coding = build()
    if "--write" not in sys.argv:
        print(f"{coding['title']} — {len(coding['options'])} options\n")
        for o in coding["options"]:
            print(f"   {o['key']:20} {o['label']}")
        print(f"\nreset targets: {[t['label'] for t in coding['reset']['targets']]}")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    lay["coding"] = coding
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"coding: {len(coding['options'])} options -> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
