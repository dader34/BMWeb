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
import sqlite3, json, sys, struct

CHASSIS_ROOT = 53088651   # E-Bezeichnung (Development code)
ENGINE_ROOT  = 53363595   # Motor (Engine)
BODY_ROOT    = 53046411   # Karosserie (Body): LIM/COU/TOU/CAB/COM/ROA/SAV...

def main():
    db, out = sys.argv[1], sys.argv[2]
    con = sqlite3.connect(db); cur = con.cursor()

    # characteristics: id -> (name, parentid); classify each to chassis/engine
    chars = {}
    kind_of = {}
    for cid, name, parent in cur.execute("SELECT ID, NAME, PARENTID FROM XEP_CHARACTERISTICS"):
        chars[cid] = name
        if parent == CHASSIS_ROOT: kind_of[cid] = 'c'
        elif parent == ENGINE_ROOT: kind_of[cid] = 'e'
        elif parent == BODY_ROOT: kind_of[cid] = 'b'
    valid_ids = set(chars.keys())

    # rules by id (id is shared by info-objects AND diagnosis-objects)
    rules = {row[0]: row[1] for row in cur.execute("SELECT ID, RULE FROM XEP_RULES")}

    def rule_chars(obj_id):
        """chassis-set, engine-set, (dateFrom, dateTo) from a rule BLOB.

        Characteristics are 4-byte LE ids matching XEP_CHARACTERISTICS. Build
        dates are 4-byte LE YYYYMM values preceded by an op byte: 0x03 = valid
        FROM (>=), 0x05 = valid TO (<=). (Verified against ISTA's own
        date validity labels.)"""
        blob = rules.get(obj_id)
        c, e, bod = set(), set(), set()
        dfrom = dto = None
        if not blob: return c, e, bod, dfrom, dto
        n = len(blob)
        for i in range(n - 3):
            v = struct.unpack_from('<I', blob, i)[0]
            k = kind_of.get(v)
            if k is None:
                v2 = v & 0x7FFFFFFF
                if v2 != v: k = kind_of.get(v2); v = v2
            if k == 'c': c.add(chars[v])
            elif k == 'e': e.add(chars[v])
            elif k == 'b': bod.add(chars[v])
            elif 199000 <= v <= 202512 and i >= 1:
                op = blob[i - 1]
                if op == 0x03: dfrom = v if dfrom is None else min(dfrom, v)
                elif op == 0x05: dto = v if dto is None else max(dto, v)
        return c, e, bod, dfrom, dto

    # --- diagnosis tree, keyed by CONTROLID ----------------------------------
    # child controlid -> parent controlid (walk upward)
    parent_of = {}
    for pid, cid in cur.execute(
            "SELECT ID, DIAGNOSISOBJECTCONTROLID FROM XEP_REFDIAGNOSISTREE"):
        parent_of[cid] = pid
    # controlid -> diagnosis-object ID (a controlid can map to several; keep all)
    objs_by_controlid = {}
    for oid, ctrl in cur.execute(
            "SELECT ID, CONTROLID FROM XEP_DIAGNOSISOBJECTS WHERE CONTROLID IS NOT NULL"):
        objs_by_controlid.setdefault(ctrl, []).append(oid)

    # doc -> diagnosis CONTROLIDs (DiagobjDocumentLink: ID side is the controlid)
    doc_controlids = {}
    for cid, io_id in cur.execute(
            "SELECT ID, INFOOBJECTID FROM XEP_REFINFOOBJECTS "
            "WHERE LINK_TYPE_ID='DiagobjDocumentLink'"):
        doc_controlids.setdefault(io_id, []).append(cid)

    def inherited_engines(io_id):
        """Engine set from the nearest diagnosis-tree ancestor that has one."""
        starts = doc_controlids.get(io_id)
        if not starts: return set()
        best = set()
        for start in starts:
            ctrl = start
            seen = 0
            while ctrl is not None and seen < 40:
                for oid in objs_by_controlid.get(ctrl, ()):
                    _, e, _, _, _ = rule_chars(oid)
                    if e: return e            # nearest ancestor with engines wins
                ctrl = parent_of.get(ctrl); seen += 1
        return best

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
                if part.startswith('SP') and part[2:].isdigit(): sp = part; break
        if not sp: continue
        c, e, bod, dfrom, dto = rule_chars(io_id)
        if e:
            stats['own_engine'] += 1
        else:
            inh = inherited_engines(io_id)
            if inh: e = inh; stats['inherited_engine'] += 1
        rec = {}
        if c: rec['c'] = sorted(c)
        if e: rec['e'] = sorted(e)
        if bod: rec['b'] = sorted(bod)
        if dfrom is not None: rec['f'] = dfrom      # build date FROM (YYYYMM, >=)
        if dto is not None: rec['t'] = dto          # build date TO   (YYYYMM, <=)
        if dfrom is not None or dto is not None: stats['dated'] += 1
        if not rec: stats['none'] += 1
        elif 'e' not in rec: stats['chassis_only'] += 1
        index[sp] = rec

    json.dump({'roots': {'chassis': 'E-Bezeichnung', 'engine': 'Motor'},
               'sp': index}, open(out, 'w'), separators=(',', ':'))
    print("stats:", stats)
    print("wrote", out, "sp entries:", len(index))

if __name__ == '__main__':
    main()
