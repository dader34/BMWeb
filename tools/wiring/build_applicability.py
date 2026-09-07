#!/usr/bin/env python3
"""Build the WDS wiring VIN-applicability index from ISTA's DiagDocDb.

Each wiring schematic (XEP_INFOOBJECTS INFOTYPE='SSP', IDENTIFIER '...-SP0000NNNNNN')
is valid for a set of chassis (E-Bezeichnung) and engines (Motor). That
applicability comes from two places, combined:

  1. The doc's OWN validity rule: XEP_RULES.ID = XEP_INFOOBJECTS.ID (1:1). The
     rule BLOB encodes characteristic ids.
  2. INHERITED from its diagnosis-tree ancestors. Many docs' own rule is
     chassis-only; the engine constraint sits on an ancestor node ("Engine
     control" carries M62/S54/S62, say) that the doc hangs under. We walk up:
        doc -> XEP_REFINFOOBJECTS(DiagobjDocumentLink) -> diagnosis CONTROLIDs
            -> XEP_REFDIAGNOSISTREE upward (ID=parent controlid,
               DIAGNOSISOBJECTCONTROLID=child controlid)
            -> at each ancestor, XEP_RULES[diagobj.ID] -> characteristics
     and take engine chars from the NEAREST ancestor that has any.

Output data/wiring-applicability.json.gz:
    { "sp": { "SP0000014320": { "c": ["E46"], "e": ["S54"] }, ... } }

Usage: build_applicability.py <DiagDocDb.decrypted.sqlite> <out.json>
"""
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # tools/
from ista_rules import RuleDecoder                              # noqa: E402
from _cli import parse_args                                     # noqa: E402


def main():
    """CLI entry: decode every SSP wiring document's applicability into
    `<out.json>` (compact JSON) and print the coverage statistics.

    Returns:
        0, for the process exit code.
    """
    ns = parse_args(__doc__, positional=("args", 2, "DiagDocDb.decrypted.sqlite OUT.json"))
    db, out = ns.args
    con = sqlite3.connect(db)
    cur = con.cursor()
    # rule decoding (characteristics, diagnosis-tree walk) is shared with the
    # reference-document extractor so both read ISTA's rules the same way
    rules = RuleDecoder(con)

    # --- SSP wiring docs -----------------------------------------------------
    cur.execute("SELECT ID, IDENTIFIER FROM XEP_INFOOBJECTS WHERE INFOTYPE='SSP'")
    ssp = cur.fetchall()

    index = {}
    stats = dict(total=0, own_engine=0, inherited_engine=0, chassis_only=0,
                 dated=0, none=0)
    for io_id, ident in ssp:
        stats['total'] += 1
        sp = None
        if ident:
            for part in ident.split('-'):
                if part.startswith('SP') and part[2:].isdigit():
                    sp = part
                    break
        if not sp:
            continue
        c, e, bod, dfrom, dto = rules.rule_chars(io_id)
        if e:
            stats['own_engine'] += 1
        else:
            inh = rules.inherited_engines(io_id)
            if inh:
                e = inh
                stats['inherited_engine'] += 1
        rec = {}
        if c:
            rec['c'] = sorted(c)
        if e:
            rec['e'] = sorted(e)
        if bod:
            rec['b'] = sorted(bod)
        if dfrom is not None:
            rec['f'] = dfrom      # build date FROM (YYYYMM, >=)
        if dto is not None:
            rec['t'] = dto          # build date TO   (YYYYMM, <=)
        if dfrom is not None or dto is not None:
            stats['dated'] += 1
        if not rec:
            stats['none'] += 1
        elif 'e' not in rec:
            stats['chassis_only'] += 1
        index[sp] = rec

    json.dump({'roots': {'chassis': 'E-Bezeichnung', 'engine': 'Motor'},
               'sp': index}, open(out, 'w'), separators=(',', ':'))
    print("stats:", stats)
    print("wrote", out, "sp entries:", len(index))
    return 0


if __name__ == '__main__':
    sys.exit(main())
