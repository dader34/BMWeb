#!/usr/bin/env python3
"""Environment / freeze-frame text, translated the way this project translates
everything else: a MAINTAINED German->English dictionary, not word-munging.

    tools/decompile/env_i18n.py            -> tools/decompile/env_i18n_de.json
                                              (the SOURCE a maintainer edits)
                                           -> app/renderer/data/envmap.js
                                              (only the translated entries ship)

WHAT THESE STRINGS ARE. When a fault is read in detail, the DME hands back a
snapshot of what the engine was doing when the code set -- RPM, battery
voltage, temperatures, the gear, the engine state. Each field carries a LABEL
and, for enum fields, a VALUE, and BMW ships both in German:

    FUMWELTTEXTE.UWTEXT          the label  ("Batteriespannung", "Motordrehzahl")
    STATE_*.UWTEXT               enum value ("2 IS - Motor im Leerlauf")
    FUNKTIONSTATUS.UWTEXT        enum value ("0 Funktion nicht aktiv")

There is NO English in the data -- BMW ships it German. WE author the English,
exactly as the coding/DATEN/fault dictionaries in this repo do. This tool
collects every distinct label and enum value with an occurrence count, writes a
frequency-sorted SOURCE file (german -> english|null) for a human to fill in,
and emits the runtime dictionary from the entries that have been filled.

IDEMPOTENT. Re-running keeps every english already written in env_i18n_de.json
and only appends german keys newly seen in the corpus, as null. It never
overwrites a human's translation and never drops a key.

    tools/decompile/env_i18n.py            regenerate both files
    tools/decompile/env_i18n.py --stats    print coverage (% of occurrences
                                           the translated entries cover)

Read-only against the car: reads gzipped table dumps on disk, nothing else.
"""

import glob
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(ROOT, 'data', 'ecu-src')
DE_JSON = os.path.join(HERE, 'env_i18n_de.json')
OUT = os.path.join(ROOT, 'app', 'renderer', 'data', 'envmap.js')


def _enum_table(name):
    """A freeze-frame enum-value table? FUNKTIONSTATUS or a STATE_* table.

    Kept deliberately narrow. Hundreds of other {WERT,UWTEXT} result tables
    exist (mileage read-outs, message catalogues), but those are job-result
    values, not the environment enums that print on a fault snapshot. Widening
    the net pulls ~5000 unrelated strings into a dictionary meant for the ~100
    that actually appear next to a code."""
    u = name.upper()
    return u == 'FUNKTIONSTATUS' or u == 'STATE' or u.startswith('STATE_')


def collect():
    """{'label': Counter, 'value': Counter} over the whole corpus."""
    labels = {}
    values = {}
    files = sorted(glob.glob(os.path.join(SRC, '*.tables.json.gz')))
    for f in files:
        try:
            with gzip.open(f, 'rt', encoding='utf-8') as fh:
                d = json.load(fh)
        except Exception:
            continue
        for table, rows in d.items():
            if not isinstance(rows, list):
                continue
            tu = table.upper()
            if tu == 'FUMWELTTEXTE':
                bucket, key = labels, 'UWTEXT'
            elif _enum_table(table):
                bucket, key = values, 'UWTEXT'
            else:
                continue
            for r in rows:
                if not isinstance(r, dict):
                    continue
                tx = (r.get(key) or r.get('TEXT') or '').strip()
                if tx:
                    bucket[tx] = bucket.get(tx, 0) + 1
    return labels, values, len(files)


def load_de():
    """Existing human-edited source (german -> english|null), or {}."""
    if not os.path.exists(DE_JSON):
        return {}
    with open(DE_JSON, encoding='utf-8') as fh:
        try:
            return json.load(fh)
        except Exception:
            return {}


# ---------------------------------------------------------------------------
# The maintainer's translations. Anything not here (and not already in
# env_i18n_de.json) lands as null and falls back to the German string. Author
# correct automotive English; leave the genuinely uncertain out.
#
# Keyed on the EXACT German string, including any leading state code the enum
# carries ("2 IS - Motor im Leerlauf"), because the renderer keys on the full
# value string it receives.
SEED = {
    # --- labels: the common freeze-frame fields ---------------------------
    'unbekannte Umweltbedingung': 'Unknown environment condition',
    'Unbekannte Umweltbedingung': 'Unknown environment condition',
    'Motordrehzahl': 'Engine RPM',
    'Batteriespannung': 'Battery voltage',
    'Batteriespannng': 'Battery voltage',              # BMW's own typo
    'Batteriespannung von IBS gemessen': 'Battery voltage (measured by IBS)',
    'Fahrzeuggeschwindigkeit': 'Vehicle speed',
    'Fahrgeschwindigkeit': 'Vehicle speed',
    'Geschwindigkeit': 'Speed',
    'Ansauglufttemperatur': 'Intake air temperature',
    'Motortemperatur': 'Engine temperature',
    'Motortemperatur beim Start': 'Engine temperature at start',
    'Aussentemperatur': 'Outside temperature',
    'Außentemperatur': 'Outside temperature',
    'Umgebungstemperatur': 'Ambient temperature',
    'Umgebungsdruck': 'Ambient pressure',
    'Drosselklappenwinkel': 'Throttle angle',
    'Kühlmitteltemperatur': 'Coolant temperature',
    'Kuehlmitteltemperatur': 'Coolant temperature',
    'Kraftstofftemperatur': 'Fuel temperature',
    'Batterietemperatur': 'Battery temperature',
    'Öltemperatur': 'Oil temperature',
    '(Motor) - Öltemperatur': 'Engine oil temperature',
    'Lastsignal': 'Load signal',
    'Last': 'Engine load',
    'Berechneter Lastwert': 'Calculated load value',
    'Einspritzmenge': 'Injection quantity',
    'Abstellzeit': 'Soak time',
    'Versorgungsspannung': 'Supply voltage',
    'Ladedruck': 'Boost pressure',
    'Saugrohrdruck': 'Manifold pressure',
    'Zündwinkel': 'Ignition angle',
    'Lambdawert': 'Lambda value',
    'Kilometerstand': 'Mileage',
    'km-Stand': 'Mileage',
    'Diagnoseadresse': 'Diagnostic address',
    'Korrekturwert Abschaltung': 'Shutoff correction value',
    'Spannung Pedalwertgeber 1': 'Pedal position sensor 1 voltage',
    'Spannung Pedalwertgeber 2': 'Pedal position sensor 2 voltage',
    'Tastverhältnis zür Endstufenansteuerung':
        'Duty cycle for output stage drive',
    'Momentenred. EGS': 'Torque reduction (EGS)',
    'Status Motorsteuerung': 'Engine management status',
    'Motor Status': 'Engine status',
    'Status Einspritzsystem Bank 1': 'Injection system status, bank 1',
    'Status Einspritzsystem Bank 2': 'Injection system status, bank 2',
    'Lichtmaschine Sollspannung': 'Alternator target voltage',
    'Spannung Kl.87': 'Terminal 87 voltage',
    'Spannung Kl.30': 'Terminal 30 voltage (battery)',
    # the specific strings on the user's E46 (MS45 / EGS / MRS) report
    'Zeit seit Startende': 'Time since engine start',
    'Zeit nach Startende': 'Time since engine start',
    'Zeitzähler ab Startende': 'Time counter since engine start',
    'Zeitzähler ab Startende (16bit)':
        'Time counter since engine start (16-bit)',
    'Zeitzähler ab Startende (tnse_u)':
        'Time counter since engine start',
    'Abbtriebsdrehzahl': 'Output shaft RPM',
    'Abbtriebsdrehzahl    [1/min]': 'Output shaft RPM [1/min]',
    'Beginnfehleruhr': 'Fault-onset time',
    'Endefehleruhr': 'Fault-end time',
    'Systemzeit Fehlerbeginn': 'Fault-onset time',
    'Systemzeit Fehlerende': 'Fault-end time',
    # the freeze-frame secondary-air diagnostics on the same report
    'Differenz zwischen Maximum und Minimum SAF':
        'Max-min difference, secondary air mass',
    'Mittlere Diagnosewert minimale Luftmasse':
        'Mean diagnostic value, minimum air mass',
    'Sekundärluftmasse': 'Secondary air mass',
    'minimale Luftmasse': 'Minimum air mass',
    'Superklopfen': 'Super knock',
    # placeholder / no-content labels BMW ships (translate so they don't read
    # as German, but keep the "empty" sense)
    'unbenutzt': 'unused',
    'nicht benutzt': 'not used',
    'nicht realisiert': 'not implemented',
    'ohne Bedeutung': 'no meaning',
    'EEProm ECU': 'ECU EEPROM',
    # unit that occasionally rides inside a label/value
    'Sek.': 'sec',

    # --- enum values (STATE_* / FUNKTIONSTATUS), keyed on the full string ---
    # engine state (STATE_ENG)
    '0 ES - Motor steht': '0 ES - engine stopped',
    '1 ST - Motor startet': '1 ST - engine cranking',
    '2 IS - Motor im Leerlauf': '2 IS - engine idling',
    '3 PL - Motor in Teillast': '3 PL - engine part load',
    '4 PU - Motor im Schubbetrieb': '4 PU - engine overrun',
    '5 PUC - Motor im Schubbetrieb mit Einspritzabschaltung':
        '5 PUC - engine overrun with fuel cut-off',
    # gears (STATE_GEAR)
    '0 Neutral oder Park/Neutral': '0 neutral or park/neutral',
    '1. Gang': '1st gear',
    '2. Gang': '2nd gear',
    '3. Gang': '3rd gear',
    '4. Gang': '4th gear',
    '5. Gang': '5th gear',
    '6. Gang': '6th gear',
    'R  Rückwärtsgang': 'R reverse',
    'R Rückwärtsgang': 'R reverse',
    'FF unbekanntes Getriebe': 'FF unknown gear',
    # function status (FUNKTIONSTATUS)
    '0 Funktion nicht aktiv': '0 function not active',
    '1 Systemtest kann nicht gestartet werden':
        '1 system test cannot be started',
    '5 Systemtest ist nicht gestartet': '5 system test not started',
    '6 Systemtest ist beendet': '6 system test finished',
    '7 Externe Ansteuerung gestartet': '7 external activation started',
    '8 Externe Ansteuerung beendet': '8 external activation finished',
    # throttle limp-home (STATE_ETC_LIH)
    '0 Drosselklappe kein Notlauf': '0 throttle, no limp-home',
    '1 Drosselklappe Notlauf 1': '1 throttle limp-home 1',
    '2 Drosselklappe Notlauf 2 invertiert':
        '2 throttle limp-home 2 inverted',
    '4 Drosselklappe Notlauf 2': '4 throttle limp-home 2',
    '8 Drosselklappe Notlauf 3': '8 throttle limp-home 3',
    'FF Status unbekannt': 'FF status unknown',
    'FFStatus unbekannt': 'status unknown',
    # tank ventilation (STATE_CP)
    '0 Tankentlüftung nicht aktiv': '0 tank ventilation not active',
    '1 Tankentlüftung keine': '1 tank ventilation none',
    '2 Tankentlüftung Minimum': '2 tank ventilation minimum',
    '3 Tankentlüftung öffnen': '3 tank ventilation opening',
    '4 Tankentlüftung schnell öffnen':
        '4 tank ventilation fast open',
    '5 Tankentlüftung Maximum': '5 tank ventilation maximum',
    # cruise control (STATE_CRU)
    '0 FGR passiv': '0 cruise control passive',
    '1 FGR aktiv': '1 cruise control active',
    # torque-request intervention (STATE_TQ_CAN_PLAUS)
    '00 kein externer Eingriff': '00 no external intervention',
    '01 Traktionskontrolle': '01 traction control',
    '02 Sequentielles Manuelles Getriebe': '02 sequential manual gearbox',
    '04 Getriebesteuerung': '04 transmission control',
    '08 Abstandsregelung': '08 distance control',
    '10 Anti Roll Stabilisierung': '10 anti-roll stabilization',
    '20 Servolenkung Typ 2': '20 power steering type 2',
    'FF unbekannter Eingriff': 'FF unknown intervention',
    # generic value words that arrive alone
    'unbekannt': 'unknown',

    # --- more common labels, by frequency ---------------------------------
    'Getriebeoeltemperatur': 'Transmission oil temperature',
    'Getriebeöltemperatur': 'Transmission oil temperature',
    'Umweltbedingung unbekannt': 'Unknown environment condition',
    'Ausgangssignal Öldruckschalter': 'Oil pressure switch output signal',
    'Drosselklappe Sollwert': 'Throttle setpoint',
    'Leerlaufreglermoment': 'Idle governor torque',
    'aktuelles rückgerechnetes inneres Motormoment':
        'Current back-calculated internal engine torque',
    'Abstand zur Startfähigkeitsgrenze':
        'Margin to cranking-capability limit',
    'Fahrpedalwert': 'Accelerator pedal value',
    'normierter Fahrpedalwinkel': 'Normalized accelerator pedal angle',
    'Botschaftenfehler': 'Message fault',
    'Raildruck - Sollwert': 'Rail pressure setpoint',
    'Batteriestrom von IBS gemessen': 'Battery current (measured by IBS)',
    'Luftmasse': 'Air mass',
    'Luftmasse pro Zylinder': 'Air mass per cylinder',
    'Sondenspannung vor KAT': 'O2 sensor voltage before catalyst',
    'Spannung Ansauglufttemperatur': 'Intake air temperature voltage',
    'Spannung Motortemperatur': 'Engine temperature voltage',
    'Spannung Luftmasse': 'Air mass voltage',
    'Spannung DME Umgebungsdruck': 'DME ambient pressure voltage',
    'Spannung Klopfwerte Zylinder 1': 'Knock voltage, cylinder 1',
    'Spannung Klopfwerte Zylinder 2': 'Knock voltage, cylinder 2',
    'Spannung Klopfwerte Zylinder 3': 'Knock voltage, cylinder 3',
    'Spannung Klopfwerte Zylinder 4': 'Knock voltage, cylinder 4',
    'Spannung Klopfwerte Zylinder 5': 'Knock voltage, cylinder 5',
    'Spannung Klopfwerte Zylinder 6': 'Knock voltage, cylinder 6',
    'Spannung Sportschalter': 'Sport switch voltage',
    'Tankfuellstand': 'Fuel tank level',
    'Tankfüllstand': 'Fuel tank level',
    'Fuellstand Kraftstofftank (fstt)': 'Fuel tank level',
    'Füllstand Motoröl': 'Engine oil level',
    'Ladelufttemperatur nach Ladeluftkühler':
        'Charge air temperature after intercooler',
    'Nockenwelle Auslass Sollwert': 'Exhaust camshaft setpoint',
    'Kühlmitteltemperatur Kühlerausgang':
        'Coolant temperature, radiator outlet',
    'Ist-Gang (gangi)': 'Actual gear',
    'Relativzeit': 'Relative time',
    'Zustand der Glühanzeige': 'Glow indicator state',
    'Ölstand Mittelwert Langzeit': 'Oil level, long-term average',
    'Bremsunterdruck': 'Brake vacuum',
    'Abgasdruck vor Partikelfilter':
        'Exhaust pressure before particulate filter',
    'Gefilterter Strömungswiderstand des Partikelfilters':
        'Filtered flow resistance of the particulate filter',
    'Motordrehzahl in der Funktionsüberwachung':
        'Engine RPM (function monitoring)',
    'Chiptemperatur Generator 1': 'Alternator 1 chip temperature',
    'Auslastungsgrad Generator 1': 'Alternator 1 load factor',
    'Erregerstrom Generator 1': 'Alternator 1 field current',
    'Herstellercode Generator 1': 'Alternator 1 manufacturer code',
    'Kennung Generatortyp Generator 1': 'Alternator 1 type ID',
    'Reglerversion Generator 1': 'Alternator 1 regulator version',
    'Battery Voltage': 'Battery voltage',
    'Kraftstofftemperatur': 'Fuel temperature',
    'Spannung Strommessung DMTL':
        'DMTL current-measurement voltage',
    'CAN - Stand': 'CAN status',
    'CAN Stand DME': 'CAN status (DME)',
    # engine-internal signals with the BMW mnemonic in parentheses
    'Motordrehzahl (nmot)': 'Engine RPM',
    'Motortemperatur (tmot)': 'Engine temperature',
    'Motortemperatur linear. (tmotlin)': 'Engine temperature (linearized)',
    'Motorstarttemperatur (tmst)': 'Engine start temperature',
    'Motorstarttemperatur gefreezt (tmst)':
        'Engine start temperature (frozen)',
    'Ansauglufttemperatur (tans)': 'Intake air temperature',
    'Fahrzeuggeschwindigkeit (vfzg_u)': 'Vehicle speed',
    'relative Luftfuellung (rl)': 'Relative air charge',
    'Berechnete Last (rml)': 'Calculated load',
    'Luftmassenfluss (ml)': 'Air mass flow',
    'Lambda-Sollwert (lamsons)': 'Lambda setpoint',
    'Lambda-Sollwert Bank2 (lamsons2)': 'Lambda setpoint, bank 2',
    'Regelfaktor Bank1 (fr_u)': 'Control factor, bank 1',
    'Regelfaktor Bank2 (fr2_u)': 'Control factor, bank 2',
    'Adaptionsfaktor Bank1 (fra_u)': 'Adaptation factor, bank 1',
    'Adaptionsfaktor Bank2 (fra_u2)': 'Adaptation factor, bank 2',
    'Zeit nach Start (tnse_u)': 'Time since engine start',
}


def build():
    labels, values, n_files = collect()
    corpus = dict(labels)
    for k, v in values.items():
        corpus[k] = corpus.get(k, 0) + v

    existing = load_de()

    # start from the seed, then keep every human translation already on disk
    de = {}
    for k, v in SEED.items():
        de[k] = v
    for k, v in existing.items():
        if v is not None:                 # never lose a human's work
            de[k] = v
        elif k not in de:
            de[k] = None

    # add any newly-seen german key as null (untranslated), so the maintainer
    # can find it. keys no longer in the corpus are kept (harmless, and a
    # maintainer may have translated a rare one on purpose).
    for k in corpus:
        if k not in de:
            de[k] = None

    # frequency order, most common first; ties broken alphabetically so the
    # file is stable across runs. keys absent from the corpus sort last.
    def rank(k):
        return (-corpus.get(k, 0), k)

    ordered = sorted(de.keys(), key=rank)
    de_sorted = {k: de[k] for k in ordered}

    with open(DE_JSON, 'w', encoding='utf-8') as fh:
        json.dump(de_sorted, fh, ensure_ascii=False, indent=2)
        fh.write('\n')

    # the runtime dictionary: translated entries only
    shipped = {k: v for k, v in de_sorted.items() if v is not None}
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write("// GENERATED by tools/decompile/env_i18n.py -- freeze-frame "
                 '(Umwelt) field\n// labels and enum values, German -> English, '
                 "from the maintained source\n// tools/decompile/env_i18n_de.json. "
                 'Loaded by a <script> tag; envLabel()\n// in translate.js is a '
                 'pure lookup over it.\nwindow.BMW_ENV_TEXT=')
        json.dump(shipped, fh, ensure_ascii=False,
                  separators=(',', ':'), sort_keys=True)
        fh.write(';\n')

    return corpus, de_sorted, shipped, n_files


def stats(corpus, de_sorted, shipped):
    total = sum(corpus.values())
    covered = sum(corpus.get(k, 0) for k in shipped)
    n_keys = len(corpus)
    n_trans = sum(1 for k in corpus if de_sorted.get(k) is not None)
    pct_occ = (100.0 * covered / total) if total else 0.0
    pct_keys = (100.0 * n_trans / n_keys) if n_keys else 0.0
    print('env_i18n coverage')
    print('  distinct strings : {}'.format(n_keys))
    print('  translated       : {} ({:.1f}% of distinct strings)'
          .format(n_trans, pct_keys))
    print('  occurrences      : {}'.format(total))
    print('  covered          : {} ({:.1f}% of occurrences)'
          .format(covered, pct_occ))
    # the highest-frequency strings still untranslated -- the maintainer's
    # next-best targets
    todo = [(corpus[k], k) for k in corpus if de_sorted.get(k) is None]
    todo.sort(reverse=True)
    if todo:
        print('  top untranslated (frequency, string):')
        for cnt, k in todo[:15]:
            print('    {:5d}  {}'.format(cnt, k))


def main():
    corpus, de_sorted, shipped, n_files = build()
    if '--stats' in sys.argv:
        stats(corpus, de_sorted, shipped)
    else:
        print('scanned {} SGBD table dumps'.format(n_files))
        print('  {} distinct env strings, {} translated'
              .format(len(corpus),
                      sum(1 for k in corpus if de_sorted.get(k) is not None)))
        print('-> {} ({} entries)'.format(
            os.path.relpath(DE_JSON, ROOT), len(de_sorted)))
        print('-> {} ({} shipped, {} bytes)'.format(
            os.path.relpath(OUT, ROOT), len(shipped),
            os.path.getsize(OUT)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
