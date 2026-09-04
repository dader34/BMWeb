#!/usr/bin/env python3
"""Decode ISTA validity rules (chassis / engine / body / build dates).

Shared by the wiring applicability index and the reference-document extractor so
both read applicability the same way. A document's applicability lives in two
places, combined:

  1. Its OWN rule: XEP_RULES.ID = XEP_INFOOBJECTS.ID (1:1). The BLOB encodes
     characteristic ids (4-byte LE, matching XEP_CHARACTERISTICS), and build
     dates (4-byte LE YYYYMM) preceded by op 0x03 (valid FROM) / 0x05 (valid TO).
  2. INHERITED from its diagnosis-tree ancestors: many docs' own rule is
     chassis-only, and the engine constraint sits on an ancestor node the doc
     hangs under. Walk up XEP_REFDIAGNOSISTREE and take engine characteristics
     from the nearest ancestor that has any.
"""
import struct

CHASSIS_ROOT = 53088651   # E-Bezeichnung (Development code)
ENGINE_ROOT = 53363595    # Motor (Engine)
BODY_ROOT = 53046411      # Karosserie (Body): LIM/COU/TOU/CAB/COM/ROA/SAV...


class RuleDecoder:
    def __init__(self, con):
        cur = con.cursor()
        self.chars = {}
        self.kind_of = {}
        for cid, name, parent in cur.execute(
                "SELECT ID, NAME, PARENTID FROM XEP_CHARACTERISTICS"):
            self.chars[cid] = name
            if parent == CHASSIS_ROOT:
                self.kind_of[cid] = 'c'
            elif parent == ENGINE_ROOT:
                self.kind_of[cid] = 'e'
            elif parent == BODY_ROOT:
                self.kind_of[cid] = 'b'
        self.rules = {r[0]: r[1] for r in cur.execute("SELECT ID, RULE FROM XEP_RULES")}
        # diagnosis-tree parent map + controlid->object-id + doc->controlids, for
        # inherited-engine walks
        self.parent_of = {}
        for pid, cid in cur.execute(
                "SELECT ID, DIAGNOSISOBJECTCONTROLID FROM XEP_REFDIAGNOSISTREE"):
            self.parent_of[cid] = pid
        self.objs_by_controlid = {}
        for oid, ctrl in cur.execute(
                "SELECT ID, CONTROLID FROM XEP_DIAGNOSISOBJECTS "
                "WHERE CONTROLID IS NOT NULL"):
            self.objs_by_controlid.setdefault(ctrl, []).append(oid)
        self.doc_controlids = {}
        for cid, io_id in cur.execute(
                "SELECT ID, INFOOBJECTID FROM XEP_REFINFOOBJECTS "
                "WHERE LINK_TYPE_ID='DiagobjDocumentLink'"):
            self.doc_controlids.setdefault(io_id, []).append(cid)

    def rule_chars(self, obj_id):
        """(chassis-set, engine-set, body-set, dateFrom, dateTo) from a rule."""
        blob = self.rules.get(obj_id)
        c, e, bod = set(), set(), set()
        dfrom = dto = None
        if not blob:
            return c, e, bod, dfrom, dto
        n = len(blob)
        for i in range(n - 3):
            v = struct.unpack_from('<I', blob, i)[0]
            k = self.kind_of.get(v)
            if k is None:
                v2 = v & 0x7FFFFFFF
                if v2 != v:
                    k = self.kind_of.get(v2)
                    v = v2
            if k == 'c':
                c.add(self.chars[v])
            elif k == 'e':
                e.add(self.chars[v])
            elif k == 'b':
                bod.add(self.chars[v])
            elif 199000 <= v <= 202512 and i >= 1:
                op = blob[i - 1]
                if op == 0x03:
                    dfrom = v if dfrom is None else min(dfrom, v)
                elif op == 0x05:
                    dto = v if dto is None else max(dto, v)
        return c, e, bod, dfrom, dto

    def inherited_engines(self, io_id):
        """Engine set from the nearest diagnosis-tree ancestor that has one."""
        starts = self.doc_controlids.get(io_id)
        if not starts:
            return set()
        for start in starts:
            ctrl, seen = start, 0
            while ctrl is not None and seen < 40:
                for oid in self.objs_by_controlid.get(ctrl, ()):
                    _, e, _, _, _ = self.rule_chars(oid)
                    if e:
                        return e
                ctrl = self.parent_of.get(ctrl)
                seen += 1
        return set()

    def doc_applicability(self, io_id):
        """{e:[engines], b:[bodies], f:dateFrom, t:dateTo} for a document, with
        engines inherited from ancestors when the doc's own rule names none.
        Chassis is omitted -- the bundle is already chassis-scoped."""
        _, e, bod, dfrom, dto = self.rule_chars(io_id)
        if not e:
            e = self.inherited_engines(io_id)
        out = {}
        if e:
            out["e"] = sorted(e)
        if bod:
            out["b"] = sorted(bod)
        if dfrom:
            out["f"] = dfrom
        if dto:
            out["t"] = dto
        return out
