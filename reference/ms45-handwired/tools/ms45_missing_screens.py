#!/usr/bin/env python3
"""Generate the MS45.1 screens the .IPO references but our layout never shipped.

The enriched MS450 layout covers 27 of the status screens INPA's frontend
drives. Diffing the .IPO's job references against it leaves 11 more that the
SGBD really implements: the system-check screens behind INPA's F9 "System"
menu, the OBD-II readiness monitors, camshaft/mixture adaptation, and the
generic measurement-block reader.

Each screen is emitted in two layouts:

  inpa    faithful to the .IPO -- single column, ECU result order, and the
          _TEXT decode rows INPA prints beside each value. INPA shows the
          raw decode ("0=aktiv"), so it is kept.
  modern  gauges: numeric _WERT rows only, two columns, the _TEXT companion
          folded away (updateGaugeSpec renders a non-numeric value as text
          anyway) and the _EINH unit resolved onto the row.

Reads the schema from a running sidecar (default 127.0.0.1:8777) so the row
set is the ECU's own truth, not a transcription.

    python3 tools/ms45_missing_screens.py            # print the screens
    python3 tools/ms45_missing_screens.py --write    # merge into MS450.json
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

# job -> the English screen title, matching the naming of the 27 already shipped
TITLES = {
    "STATUS_OBD": "OBD-II readiness monitors",
    "STATUS_FUNKTIONS": "Function states (load, idle, overrun)",
    "STATUS_ADAPTION_GEMISCH": "Mixture adaptation (additive & multiplicative)",
    "STATUS_NOCKENWELLE_ADAPTION": "Camshaft adaptation (VANOS reference & flanks)",
    "STATUS_SYSTEMCHECK_L_SONDE": "System check: O2 sensors",
    "STATUS_SYSTEMCHECK_DMTL": "System check: DMTL leak diagnosis",
    "STATUS_SYSTEMCHECK_TEV": "System check: purge valve (TEV)",
    "STATUS_SYSTEMCHECK_SEK_LUFT": "System check: secondary air",
    "STATUS_SYSTEMCHECK_LLERH": "System check: idle-speed increase",
    "STATUS_SYSTEMCHECK_EVAUSBL": "System check: injector cut-out",
    "MESSWERTBLOCK_LESEN": "Measurement block (generic reader)",
}

# German glues its nouns into single words -- "TankentlueftungsSystemUeberwachung"
# is one token, so a \b-anchored rule can never reach the parts. These fragments
# are matched WITHOUT word boundaries and run before the word list, which turns
# the compounds into spaced English that the word rules can then finish.
FRAGMENTS = [
    # longest first: "Komponentenueberwachung" must resolve before the bare
    # "Ueberwachung" fragment splits it into "Komponenten" + "monitoring"
    ("Komponentenueberwachung", "component monitoring"),
    ("KomponentenUeberwachung", "component monitoring"),
    ("SystemUeberwachung", " system monitoring"),
    ("Systemueberwachung", " system monitoring"),
    ("Tankentlueftungs", "evap "), ("Sekundaerluft", "secondary air "),
    ("Lambdasonden", "O2 sensor "), ("LambdaSonden", "O2 sensor "),
    ("Lambdasonde", "O2 sensor "), ("Heizungs", "heater "),
    ("AbgasRueckfuehrungs", "EGR "), ("Abgasrueckfuehrungs", "EGR "),
    ("Klimaanlagen", "A/C "), ("KlimaSystem", "A/C system"), ("Klima", "A/C "),
    ("Ueberwachung", "monitoring"), ("ueberwachung", "monitoring"),
    ("System", " system"), ("Diagnose", "diagnosis"),
    ("Messwerte", "measured values"), ("Messwert", "measured value"),
    ("Drehzahlbegrenzer", "rev limiter"), ("Hochdrehsicherung", "over-rev protection"),
    ("Notbetrieb", "limp-home mode"), ("Bremsen", "brakes"), ("Bremse", "brake"),
    ("Momenten", "torque "), ("Funktionseingriff", "function intervention"),
    ("Botschaft", "message"), ("Geschwindigkeit", "speed"), ("Geschw.", "speed"),
    ("Differenz", "difference"), ("festgestellt", "detected"),
    ("ausgeschaltet", "switched off"), ("Notaus", "emergency off"),
    ("meldet sich", "reports"), ("plausibel", "plausible"), ("maximale", "max"),
    ("Externe", "external"), ("Ebene", "level"), ("Run up lock", "run-up lock"),
    ("zu hoch", "too high"), ("zu gering", "too low"), ("zu lang", "too long"),
    ("beendet", "finished"), ("ohne", "without"), ("Steller", "actuator"),
    ("verhindert", "inhibited"), ("gestartet", "started"), ("gueltig", "valid"),
]

# EDIABAS result descriptions are German; these cover the words that appear in
# the 11 screens' descriptions. Anything unmatched keeps the German, which is
# still better than the bare result key.
WORDS = [
    (r"\bStatusbit\b", "Status bit"), (r"\bwerden ueberwacht\b", "monitored"),
    (r"\bFehlzuendungen\b", "Misfire"), (r"\bKraftstoffsystem\b", "Fuel system"),
    (r"\bDiagnose vorhanden\b", "diagnosis present"), (r"\bDiagnose\b", "diagnosis"),
    (r"\bUmfassende\b", "Comprehensive"), (r"\bKomponenten[Uu]eberwachung\b", "component monitoring"),
    (r"\bKatalysator\b", "Catalyst"), (r"\bKatheizung\b", "Cat heating"),
    (r"\b[Uu]eberwachung\b", "monitoring"), (r"\bTankentlueftungs[Ss]ystem\b", "Evap system"),
    (r"\bSekundaerluft\b", "Secondary air"), (r"\bKlimaanlage\b", "A/C"),
    (r"\bAdaption Gemisch additiv\b", "Mixture adaptation, additive"),
    (r"\bAdaption Gemisch multiplikativ\b", "Mixture adaptation, multiplicative"),
    (r"\bAdaptierte Werte\b", "Adapted value"), (r"\bFlankenAdaption\b", "Flank adaptation"),
    (r"\bNW Auslass\b", "camshaft exhaust"), (r"\bNW Einlass\b", "camshaft intake"),
    (r"\bFlanke\b", "flank"), (r"\bBeschreibungstext\b", "Description"),
    (r"\bEinheit der Werte\b", "Unit"), (r"\bEinheit\b", "Unit"),
    (r"\bZahlenwert\b", "Value"), (r"\bText\b", "Text"), (r"\bAblauf\b", "sequence"),
    (r"\bvor Kat\b", "pre-cat"), (r"\bhinter Kat\b", "post-cat"),
    (r"\bTeillast\b", "Part load"), (r"\bVoll?last\b", "Full load"), (r"\bSchub\b", "Overrun"),
    (r"\bLeerlauf\b", "Idle"), (r"\bAnzahl\b", "Count"),
    # STATUS_FUNKTIONS operating-state words
    (r"\bBeschleunigungsanreicherung\b", "Acceleration enrichment"),
    (r"\bLambdaregelung\b", "Lambda control"), (r"\bRegelkreis\b", "Control loop"),
    (r"\bgeschlossen\b", "closed"), (r"\boffen\b", "open"),
    (r"\bhinter Kat\b", "post-cat"), (r"\bvor Kat\b", "pre-cat"),
    (r"\berkannt\b", "detected"), (r"\bwenn\b", "when"), (r"\bund\b", "and"),
    (r"\boder\b", "or"), (r"\bnicht\b", "not"),
    (r"\bSchubabschaltung\b", "Overrun fuel cut-off"),
    (r"\bGang eingelegt\b", "Gear engaged"), (r"\beingelegt\b", "engaged"),
    (r"\bDrehzahl\b", "Engine speed"), (r"\bKlopfregelung\b", "Knock control"),
    (r"\bStarter\b", "Starter"), (r"\bKlimakompressor\b", "A/C compressor"),
    (r"\bNotlauf\b", "limp-home"), (r"\bKupplungsschalter\b", "clutch switch"),
    (r"\bBremslichtschalter\b", "brake-light switch"), (r"\bFehler\b", "Fault"),
    (r"\bAbgleich neu lernen\b", "adaptation relearn"), (r"\bAbgleich\b", "adaptation"),
    (r"\bneu lernen\b", "relearn"), (r"\bLernen\b", "learning"),
    (r"\bGeschwindigkeit\b", "speed"), (r"\bSollwert\b", "setpoint"),
    (r"\bIstwert\b", "actual value"), (r"\bSperre\b", "lock"),
    (r"\bÜbernahme zu lange\b", "takeover too long"), (r"\bÜbernehmen\b", "takeover"),
    (r"\bÜbernahme\b", "takeover"), (r"\bÜberwachung\b", "monitoring"),
    (r"\bBeschleunigungs\b", "Acceleration"), (r"\bMaximalgeschwindigkeit\b", "max speed"),
    (r"\bgültig\b", "valid"), (r"\bverhindert\b", "inhibited"), (r"\bgestartet\b", "started"),
    (r"\bim\b", "in"), (r"\baktiv\b", "active"), (r"\bFehler\b", "Fault"),
    (r"\bkein\b", "no"), (r"\bMFL\b", "MFL"), (r"\bEGAS\b", "EGAS"),
    (r"\bvorhanden\b", "present"), (r"\bKurbelwelle\b", "crankshaft"),
    (r"\bWert\b", "value"), (r"\bBank\b", "bank"), (r"\bein\b", "on"), (r"\baus\b", "off"),
]

# "... Werte -40 bis -136" -> the range is captured into min/max, so the dangling
# "Werte"/"values" lead-in is dropped rather than left on the end of the label
_TRAILING = re.compile(r"\s*\b(Werte|values|Wert)\s*$", re.I)
# the SGBD embeds its internal variable name in some descriptions ("Leerlauf
# LV_LL 0=Nein / 1=Ja"). It sits mid-string, before the value legend, so this
# is deliberately unanchored. INPA never shows it, so neither do we.
_VARNAME = re.compile(r"\s*(?:LV|SV|MV)_[A-Z0-9_]+")

_UNIT_IN_DESC = re.compile(r"\b(%|V|A|ms|°C|°KW|1/min|mbar|bar|Nm|km/h|mg/hub|ohm)\b")
# a screen-wide unit carrier, e.g. "STAT_EINH : Einheit der Werte ° Kurbelwelle"
_SCREEN_UNIT = re.compile(r"Einheit(?:\s+der\s+Werte)?\s+(\S.*)$", re.I)
_RANGE = re.compile(r"(-?\d+)\s*bis\s*(-?\d+)")


def api(path):
    with urllib.request.urlopen(f"{API}{path}", timeout=60) as r:
        return json.load(r)


def english(desc):
    """German result description -> English-ish label."""
    s = desc.strip()
    s = _RANGE.sub("", s)                       # the range goes to min/max
    s = _VARNAME.sub("", s)                     # drop the trailing LV_* var name
    # drop the value legend: "0=Bereit / 1=Start", "0=aktiv 1=Start verhindert
    # 5=nicht gestartet 6= beendet". Everything from the first "<n>=" on is the
    # legend, and the space in "6= beendet" means a per-token rule misses it.
    s = re.sub(r"\s*\b\d+\s*=.*$", "", s)
    # split the compounds first so the word rules below can reach their parts
    for frag, rep in FRAGMENTS:
        s = s.replace(frag, rep)
    for pat, rep in WORDS:
        s = re.sub(pat, rep, s)
    s = _TRAILING.sub("", s)
    s = re.sub(r"\s{2,}", " ", s).strip(" /,-")
    return s or desc.strip()


def rows_for(job):
    """[(key, english label, unit, min, max)] plus {key: raw German description}."""
    out = []
    descs = {}
    for line in api(f"/api/ecu/{SGBD}/results/{job}"):
        if line.startswith(("JOB_STATUS", "_TEL")):
            continue
        key, _, desc = line.partition(" : ")
        key = key.strip()
        if not key:
            continue
        descs[key] = desc
        # MESSWERTBLOCK_LESEN repeats one description for every slot; the index
        # only exists in the key, so lift it out or the page reads as 65
        # identical "measured value" rows
        idx = re.search(r"MESSWERT(\d+)_", key)
        if idx:
            desc = f"{desc} {int(idx.group(1)) + 1}"
        unit = None
        m = _UNIT_IN_DESC.search(desc)
        if m:
            unit = m.group(1)
        lo = hi = None
        r = _RANGE.search(desc)
        if r:
            lo, hi = int(r.group(1)), int(r.group(2))
            if lo > hi:
                lo, hi = hi, lo
        out.append((key, english(desc), unit, lo, hi))
    return out, descs


def build(job):
    """The inpa + modern layout pair for one job."""
    raw, descs = rows_for(job)
    title = TITLES.get(job, job)

    # a bare STAT_EINH names the unit for every value on the screen (the camshaft
    # screen's "° Kurbelwelle"); a prefixed one (STAT_PWM_EINH) only for its group
    screen_unit = None
    for k, _lab, _u, _lo, _hi in raw:
        if k in ("STAT_EINH", "STAT_EINHEIT"):
            m = _SCREEN_UNIT.search(descs.get(k, ""))
            if m:
                screen_unit = m.group(1).strip()
    prefixes = [re.sub(r"_EINH\d*$", "", k) for k, *_ in raw
                if re.search(r"_EINH\d*$", k) and k not in ("STAT_EINH", "STAT_EINHEIT")]

    def resolve_unit(k, u):
        """The unit a value row carries, from its own _EINH group or the screen's."""
        if u is not None or re.search(r"_(TEXT|EINH)\d*$", k):
            return u
        base = re.sub(r"_WERT\d*$", "", k)
        if any(p and base.startswith(p) for p in prefixes):
            return screen_unit or "%"
        return screen_unit

    if screen_unit:                       # "° Kurbelwelle" -> "°CA" (crank angle)
        screen_unit = re.sub(r"°\s*Kurbelwelle", "°CA", screen_unit, flags=re.I).strip()

    # INPA: everything the ECU returns, in order -- what INPA prints. A _TEXT row
    # only ever says "Beschreibungstext"; it is the decode of the value above it,
    # so name it after that value instead of repeating "Description" down the page.
    inpa_rows = []
    prev = None
    for k, lab, u, lo, hi in raw:
        if re.search(r"_TEXT\d*$", k) and prev and re.match(r"^(Description|Text)$", lab):
            lab = f"{prev} (text)"
        elif not re.search(r"_(TEXT|EINH)\d*$", k):
            prev = lab
        # INPA prints the unit beside the value too, so resolve it here as well
        inpa_rows.append({"key": k, "label": lab, "unit": resolve_unit(k, u),
                          "min": lo, "max": hi})

    # modern: numeric values only -- drop the _TEXT decodes and the _EINH
    # carriers, resolving each unit onto its own value row
    modern_rows = []
    for k, lab, u, lo, hi in raw:
        # _TEXT / _EINH, optionally bank-suffixed (STAT_ADD_TEXT1, STAT_PWM_EINH)
        if re.search(r"_(TEXT|EINH)\d*$", k):
            continue
        modern_rows.append({"key": k, "label": lab, "unit": resolve_unit(k, u),
                            "min": lo, "max": hi})
    if not modern_rows:                      # all-text screen: show it as INPA does
        modern_rows = list(inpa_rows)

    return (
        # INPA lays its readouts out in two columns (10 values per page, 2x5),
        # which is also what the pager assumes -- a single column pages far too
        # early and wastes half the window
        {"group": title, "job": job, "args": None, "render": "digital",
         "columns": 2, "mode": "inpa", "rows": inpa_rows},
        {"group": title, "job": job, "args": None, "render": "analog",
         "columns": 2, "mode": "modern", "rows": modern_rows},
    )


def main():
    write = "--write" in sys.argv
    screens = []
    for job in TITLES:
        try:
            screens.extend(build(job))
        except Exception as e:                # noqa: BLE001 - report and continue
            print(f"  !! {job}: {type(e).__name__}: {e}", file=sys.stderr)

    if not write:
        for s in screens:
            print(f"{s['mode']:7} {s['job']:32} {len(s['rows']):3} rows  "
                  f"cols={s['columns']}  {s['group']}")
        print(f"\n{len(screens)} screens "
              f"({len(screens)//2} jobs x inpa/modern). --write to merge.")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    have = {(s.get("job"), s.get("mode")) for s in lay["screens"]}
    added = [s for s in screens if (s["job"], s["mode"]) not in have]
    lay["screens"].extend(added)
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"added {len(added)} screens -> {os.path.relpath(LAYOUT)} "
          f"(now {len(lay['screens'])})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
