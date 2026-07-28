#!/usr/bin/env python3
"""Emit the MS45.1 Service screen.

UNLIKE the other mined screens, this one has no INPA original. INPA's MS45 root
menu has twelve keys -- Info, Ident, AIF, Fehler, Status, Steuern, Speicher,
Adaption, System, EWS, CAS, Ende -- and none of them is "Service". Searching
MS450.IPO for a service/CBS/inspection proc or menu returns nothing, and eight
of these jobs are never referenced by INPA's frontend at all: they are SGBD
capabilities INPA simply does not expose.

So this screen is OURS, assembled from the SGBD's own job and result schemas
rather than replicated from bytecode. It is laid out like the INPA screens it
sits beside, but nothing here claims to be what INPA shows -- there is no INPA
screen to show.

Two kinds of entry:

  read     runs a job and lists its results (CBS data, inspection stamp,
           diagnostic protocol, ECU temperature)
  command  fires a job that returns only JOB_STATUS (ECU reset, sleep mode,
           CRU off, DME start-value alignment) -- every one confirms first

    python3 tools/ms45_service.py            # print
    python3 tools/ms45_service.py --write    # merge into MS450.json
"""
import os
import sys
import json
import urllib.request

API = os.environ.get("BMACW_API", "http://127.0.0.1:8777")
SGBD = "ms450ds0"
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")

# read jobs: the fields worth showing, in a sensible reading order, with
# English labels for the German result descriptions
READS = [
    {
        "job": "CBS_DATEN_LESEN",
        "title": "Condition Based Service",
        "caption": "remaining distance and service availability",
        "fields": [
            ("RMMI_BOS_WERT", "Remaining distance", "RMMI_BOS_EINH"),
            ("COU_RSTG_BOS_MESS_WERT", "Service counter", None),
            ("AVAI_BOS_WERT", "Availability", "AVAI_BOS_EINH"),
            ("AVAI_BOS_WERT_OEL", "Engine oil", None),
            ("AVAI_BOS_WERT_FILT", "Micro filter", None),
            ("AVAI_BOS_WERT_BR_V", "Front brake pads", None),
            ("AVAI_BOS_WERT_BR_H", "Rear brake pads", None),
            ("AVAI_BOS_WERT_BRFL", "Brake fluid", None),
            ("AVAI_BOS_WERT_ZKRZ", "Spark plugs", None),
            ("AVAI_BOS_WERT_SIC", "Vehicle inspection", None),
            ("AVAI_BOS_WERT_KFL", "Coolant", None),
            ("ZIEL_MM_WERT", "Inspection due (month)", None),
            ("ZIEL_YY_WERT", "Inspection due (year)", None),
            ("ID_FN_BOS_MESS_TEXT", "CBS identifier", None),
        ],
    },
    {
        "job": "INNENTEMP_LESEN",
        "title": "ECU temperature",
        "caption": "the DME's own internal temperature",
        "fields": [("SG_INNENTEMP", "Internal temperature", "SG_INNENTEMP_EINH")],
    },
    {
        "job": "PRUEFSTEMPEL_LESEN",
        "title": "Inspection stamp",
        "caption": "the three stamp bytes as stored",
        "fields": [("BYTE1", "Byte 1", None), ("BYTE2", "Byte 2", None),
                   ("BYTE3", "Byte 3", None)],
    },
    {
        "job": "DIAGNOSEPROTOKOLL_LESEN",
        "title": "Diagnostic protocol",
        "caption": "which protocol the ECU is speaking",
        "fields": [("DIAG_PROT_IST", "Active protocol", None),
                   ("DIAG_PROT_ANZAHL", "Protocols supported", None),
                   ("DIAG_PROT_NR1", "Available protocols", None)],
    },
]

# command jobs: return JOB_STATUS only. `warn` is what the user is agreeing to.
COMMANDS = [
    {
        "job": "STEUERGERAETE_RESET",
        "title": "Reset ECU",
        "caption": "restarts the DME",
        "warn": "The DME reboots. The engine will cut out if it is running, and "
                "the diagnostic session drops until the ECU comes back.",
    },
    {
        "job": "SLEEP_MODE",
        "title": "Sleep mode",
        "caption": "sends the ECU to sleep",
        "warn": "The DME stops responding to diagnostics until it is woken by "
                "the next terminal change.",
    },
    {
        "job": "RESET_CRU_OFF",
        "title": "Reset CRU off",
        "caption": "clears the CRU-off state",
        "warn": "Resets the ECU's CRU-off condition.",
    },
    {
        "job": "DME_STARTWERT_ABGLEICH",
        "title": "DME start value alignment",
        "caption": "EWS/CAS rolling-code sync",
        "warn": "Re-runs the immobilizer start-value alignment between the DME "
                "and EWS/CAS. If it does not complete, the engine may not start.",
    },
]


def api(path):
    with urllib.request.urlopen(f"{API}{path}", timeout=60) as r:
        return json.load(r)


def available():
    """The jobs this SGBD actually has, so we never offer one it lacks."""
    try:
        return {j.split()[0] if " " in j else j for j in api(f"/api/ecu/{SGBD}/jobs")}
    except Exception:                       # noqa: BLE001 - offline: keep all
        return None


def build():
    have = available()
    keep = (lambda j: have is None or j in have)
    reads = [r for r in READS if keep(r["job"])]
    cmds = [c for c in COMMANDS if keep(c["job"])]
    return {"title": "Service", "subtitle": "service data and ECU commands",
            "reads": reads, "commands": cmds}


def main():
    svc = build()
    if "--write" not in sys.argv:
        print(f"{svc['title']} — {len(svc['reads'])} reads, "
              f"{len(svc['commands'])} commands\n")
        for r in svc["reads"]:
            print(f"   read     {r['job']:26} {r['title']} ({len(r['fields'])} fields)")
        for c in svc["commands"]:
            print(f"   command  {c['job']:26} {c['title']}")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    lay["service"] = svc
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"service: {len(svc['reads'])} reads + {len(svc['commands'])} commands "
          f"-> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
