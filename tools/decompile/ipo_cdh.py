#!/usr/bin/env python3
"""The CDH / CABI host-callback table used by the NCS coding dispatchers
(the A_<cabd>.IPO files under NCSEXPER/SGDAT and their INPA twins).

These IPOs are ordinary INPA bytecode -- ipo_disasm.py already decodes every
token of A_KMB46's Cod proc with zero unknown bytes -- but their `call`
opcodes index a DIFFERENT host function table than the screen IPOs. A screen
IPO's `call 0x0d` is a normal builtin; a coding dispatcher's `call 0x0d` is
CDHapiJob. So naming is a per-file-class choice, not a global rename: this
module holds the coding table, and ipo_disasm names against it only when the
caller asks for the coding dialect.

SLOT ID == the `CALL sys N` index. The table (id -> name -> CABI.H signature)
is the CABI host-function interface Softing shipped in NCSEXPER's C runtime;
the slot ordering is the runtime's own keyword block. Every entry a coding
WRITE touches is marked observed in the corpus of A_* dispatchers. Parameter
directions come straight from CABI.H: `in` = value pushed on the operand
stack, `out`/`inout` = a reference pushed (the callback writes back through
it). We record them so the derived-JSON pass (ipo_coding_dispatch.py) knows
which stack slots are inputs and which receive results.

Each row: id -> (name, [(dir, type, argname), ...]).
"""

# in = value arg, out = result ref, inout = both.
CDH_SLOTS = {
    # timer / flow / convert / string (shared with screen IPOs, same slots)
    0x00: ("settimer", [("in", "int", "timernum"), ("in", "int", "timeval")]),
    0x01: ("testtimer", [("in", "int", "timernum"), ("out", "bool", "expired")]),
    0x02: ("exit", []),
    0x03: ("realtostring", [("in", "real", "r"), ("in", "string", "fmt"),
                            ("out", "string", "s")]),
    0x04: ("inttostring", [("in", "int", "i"), ("out", "string", "s")]),
    0x05: ("hexconvert", [("in", "string", "hex"), ("out", "int", "high"),
                          ("out", "int", "mid"), ("out", "int", "low"),
                          ("out", "int", "seg")]),
    0x06: ("strcat", [("out", "string", "dest"), ("in", "string", "a"),
                      ("in", "string", "b")]),
    0x07: ("strlen", [("out", "int", "len"), ("in", "string", "str")]),
    0x08: ("midstr", [("out", "string", "result"), ("in", "string", "src"),
                      ("in", "int", "first"), ("in", "int", "count")]),

    # EDIABAS via the CDH wrapper (the coding job channel)
    0x0b: ("CDHapiInit", []),
    0x0c: ("CDHapiEnd", []),
    0x0d: ("CDHapiJob", [("in", "string", "ecu"), ("in", "string", "job"),
                         ("in", "string", "para"), ("in", "string", "result")]),
    0x0e: ("CDHapiJobData", [("in", "string", "ecu"), ("in", "string", "job"),
                             ("in", "int", "bufHandle"), ("in", "int", "bufSize"),
                             ("in", "string", "result")]),
    0x0f: ("CDHapiResultText", [("out", "string", "text"), ("in", "string", "res"),
                                ("in", "int", "set"), ("in", "string", "fmt")]),
    0x10: ("CDHapiResultInt", [("out", "int", "val"), ("in", "string", "res"),
                               ("in", "int", "set")]),
    0x11: ("CDHapiResultSets", [("out", "int", "sets")]),
    0x12: ("CDHapiResultDigital", [("out", "bool", "val"), ("in", "string", "res"),
                                   ("in", "int", "set")]),
    0x13: ("CDHapiResultAnalog", [("out", "real", "val"), ("in", "string", "res"),
                                  ("in", "int", "set")]),
    0x14: ("CDHapiResultBinary", [("in", "int", "bufHandle"), ("in", "string", "res"),
                                  ("in", "int", "set"), ("out", "int", "retVal")]),
    0x15: ("CDHapiCheckJobStatus", [("in", "string", "ref")]),

    # raw EDIABAS (bypasses CDH); coding rarely uses these
    0x16: ("apiInit", [("out", "bool", "rc")]),
    0x17: ("apiEnd", []),
    0x18: ("apiJob", [("in", "string", "ecu"), ("in", "string", "job"),
                      ("in", "string", "para"), ("in", "string", "result")]),
    0x19: ("apiState", [("out", "int", "state")]),
    0x1a: ("apiResultText", [("out", "bool", "rc"), ("out", "string", "text"),
                             ("in", "string", "res"), ("in", "int", "set"),
                             ("in", "string", "fmt")]),
    0x1b: ("apiResultInt", [("out", "bool", "rc"), ("out", "int", "val"),
                            ("in", "string", "res"), ("in", "int", "set")]),
    0x1c: ("apiResultSets", [("out", "bool", "rc"), ("out", "int", "sets")]),
    0x1d: ("apiResultReal", [("out", "bool", "rc"), ("out", "real", "val"),
                             ("in", "string", "res"), ("in", "int", "set")]),
    0x1e: ("apiErrorCode", [("out", "int", "code")]),
    0x1f: ("apiErrorText", [("out", "string", "text")]),
    0x20: ("GetBinaryDataString", [("out", "string", "s"), ("out", "int", "len")]),

    # CDH init / from-ZCS / from-CVT
    0x2a: ("CDHGetFswPswFromZcs", [("in", "string", "gm"), ("in", "string", "sa"),
                                   ("in", "string", "vn"), ("out", "int", "retVal")]),
    0x2b: ("CDHSetReturnVal", [("in", "int", "wert")]),
    0x2c: ("CDHSetSystemData", [("in", "string", "name"), ("in", "string", "wert"),
                                ("out", "int", "retVal")]),
    0x2d: ("CDHGetSystemData", [("in", "string", "name"), ("out", "string", "wert"),
                                ("out", "int", "retVal")]),
    0x2e: ("CDHSetCabdPar", [("in", "string", "name"), ("in", "string", "wert"),
                             ("out", "int", "retVal")]),
    0x2f: ("CDHGetCabdPar", [("in", "string", "name"), ("out", "string", "wert"),
                             ("out", "int", "retVal")]),
    0x30: ("CDHGetFswPswFromCvt", [("out", "int", "retVal")]),

    # SG selection
    0x31: ("CDHReadSget", [("out", "string", "sgList"), ("out", "int", "retVal")]),
    0x32: ("CDHSetSgName", [("in", "string", "sgName"), ("out", "int", "retVal")]),
    0x33: ("CDHGetSgbdName", [("out", "string", "sgbdName"), ("out", "int", "retVal")]),
    0x34: ("CDHGetBaureiheFromZcs", [("in", "string", "gm"), ("in", "string", "sa"),
                                     ("in", "string", "vn"), ("out", "string", "br"),
                                     ("out", "int", "retVal")]),

    # coding worklist (activate/inactivate FSW/GRP). This port resolves netto
    # host-side, so these become no-ops -- but they must still be named/decoded.
    0x35: ("CDHActivateFsw", [("in", "string", "fsw"), ("out", "int", "retVal")]),
    0x36: ("CDHInactivateFsw", [("in", "string", "fsw"), ("out", "int", "retVal")]),
    0x37: ("CDHActivateGrp", [("in", "string", "grp"), ("out", "int", "retVal")]),
    0x38: ("CDHInactivateGrp", [("in", "string", "grp"), ("out", "int", "retVal")]),
    0x39: ("CDHActivateAllFsw", []),
    0x3a: ("CDHInactivateAllFsw", []),
    0x3b: ("CDHChangePsw", [("in", "string", "fsw"), ("in", "string", "psw"),
                            ("out", "int", "retVal")]),
    0x3c: ("CDHSaveFswPswList", [("out", "int", "retVal")]),
    0x3d: ("CDHRestoreFswPswList", [("out", "int", "retVal")]),

    # CBD (coding-block descriptor) queries
    0x3e: ("CDHSetCbdName", [("in", "string", "cbdName")]),
    0x3f: ("CDHGetInfo", [("in", "string", "name"), ("in", "int", "infoNr"),
                          ("out", "string", "info"), ("out", "int", "nrOfInfo"),
                          ("out", "int", "retVal")]),
    0x40: ("CDHCheckIdent", [("in", "string", "name"), ("in", "string", "id1"),
                             ("in", "string", "id2"), ("out", "int", "retVal")]),
    0x41: ("CDHGetFswDataFromCbd", [("in", "string", "fsw"), ("out", "int", "retVal")]),
    0x42: ("CDHGetFswPswDataFromCbd", [("in", "string", "fsw"), ("in", "string", "psw"),
                                       ("out", "int", "retVal")]),
    0x43: ("CDHGetGrpDataFromCbd", [("in", "string", "grp"), ("out", "int", "retVal")]),
    0x44: ("CDHGetNettoDataFromCbd", [("out", "int", "retVal")]),
    0x45: ("CDHGetNettoMaskFromCbd", [("out", "int", "retVal")]),
    0x46: ("CDHGetFswPswFromNettoData", [("in", "string", "outFile"),
                                         ("out", "int", "retVal")]),

    # the write engine's data pump: netto region <-> BinBuf <-> the wire
    0x47: ("CDHResetApiJobData", []),
    0x48: ("CDHGetApiJobData", [("in", "int", "maxData"), ("in", "int", "bufHandle"),
                                ("out", "int", "bufSize"), ("out", "int", "nrOfData"),
                                ("out", "int", "dataType"), ("out", "int", "retVal")]),
    0x49: ("CDHCheckDataUsed", [("out", "int", "retVal")]),
    0x4a: ("CDHBinBufToNettoData", [("in", "int", "bufHandle"), ("out", "int", "retVal")]),
    0x4b: ("CDHBinBufCreate", [("out", "int", "bufHandle"), ("out", "int", "retVal")]),
    0x4c: ("CDHBinBufDelete", [("in", "int", "bufHandle"), ("out", "int", "retVal")]),
    0x4d: ("CDHBinBufWriteByte", [("in", "int", "bufHandle"), ("in", "int", "byteVal"),
                                  ("in", "int", "pos"), ("out", "int", "retVal")]),
    0x4e: ("CDHBinBufWriteWord", [("in", "int", "bufHandle"), ("in", "int", "wordVal"),
                                  ("in", "int", "pos"), ("out", "int", "retVal")]),
    0x4f: ("CDHBinBufReadByte", [("in", "int", "bufHandle"), ("out", "int", "byteVal"),
                                 ("in", "int", "pos"), ("out", "int", "retVal")]),
    0x50: ("CDHBinBufReadWord", [("in", "int", "bufHandle"), ("out", "int", "wordVal"),
                                 ("in", "int", "pos"), ("out", "int", "retVal")]),
    0x51: ("CDHBinBufToStr", [("in", "int", "bufHandle"), ("out", "string", "s"),
                              ("out", "int", "retVal")]),

    # error scratchpad (the sentinel dance the dispatcher does on entry/exit)
    0x52: ("CDHResetError", []),
    0x53: ("CDHSetError", [("in", "int", "errNr"), ("in", "string", "modul"),
                           ("in", "string", "proc"), ("in", "int", "line"),
                           ("in", "string", "info")]),
    0x54: ("CDHTestError", [("out", "int", "errNr")]),
    0x55: ("CDHGetApiJobByteData", [("in", "int", "maxData"), ("in", "int", "bufHandle"),
                                    ("out", "int", "bufSize"), ("out", "int", "nrOfData"),
                                    ("out", "int", "retVal")]),

    # cabd word params + memory organisation + flash refs
    0x56: ("CDHSetCabdWordPar", [("in", "string", "name"), ("in", "int", "wert"),
                                 ("out", "int", "retVal")]),
    0x57: ("CDHGetCabdWordPar", [("in", "string", "name"), ("out", "int", "wert"),
                                 ("out", "int", "retVal")]),
    0x58: ("CDHGetReferenzProgramm", []),
    0x59: ("CDHGetReferenzDaten", []),
    0x5b: ("CDHSetDataOrg", [("in", "int", "wortBreite"), ("in", "int", "byteFolge"),
                             ("in", "int", "adrMode"), ("out", "int", "retVal")]),
    0x5c: ("CDHIdReady", [("out", "bool", "ready")]),

    # authentication (SecurityAccess). Seed/key tables (SAUTH.DAT) are not in
    # the data dump, so the runtime stubs these as honest no-ops: the ECU
    # declines at the wire rather than us faking an unlock. E46 body/kombi
    # coding does not gate on this.
    0x5d: ("CDHCallAuthenticate", [("in", "string", "sgFamilie"), ("in", "string", "userId"),
                                   ("in", "string", "stgId"), ("in", "string", "type"),
                                   ("in", "int", "sgrndHdl"), ("in", "string", "level"),
                                   ("in", "int", "responseHdl"), ("out", "int", "responseLen"),
                                   ("out", "int", "retVal")]),
    0x62: ("CDHAuthGetRandom", [("out", "string", "rndBin"), ("out", "string", "rndAsc")]),

    # FA (Fahrzeugauftrag) walker + write
    0x5e: ("CDHGetFaVersion", [("out", "string", "version"), ("out", "int", "retVal")]),
    0x5f: ("CDHGetAnzahlFaElemente", [("out", "int", "anzahl")]),
    0x60: ("CDHGetFaElement", [("in", "string", "typ"), ("in", "bool", "first"),
                               ("out", "string", "element")]),
    0x61: ("CDHCheckIdent2", [("in", "string", "name"), ("in", "int", "id1"),
                              ("out", "int", "retVal")]),
}

# name -> id, for the derive pass and tests.
CDH_ID = {v[0]: k for k, v in CDH_SLOTS.items()}


def cdh_name(op):
    """Callback name for a coding-dispatcher call opcode, or builtin_XX."""
    row = CDH_SLOTS.get(op)
    return row[0] if row else f"builtin_{op:02x}"


def cdh_sig(op):
    """Parameter list [(dir, type, name), ...] for an opcode, or None."""
    row = CDH_SLOTS.get(op)
    return row[1] if row else None


# The subset a coding WRITE actually drives, for the runtime to implement and
# for a coverage assertion in the derive pass. Everything else a dispatcher
# calls is either a read helper, a no-op worklist op, or shared with screens.
WRITE_CALLBACKS = frozenset([
    "CDHapiInit", "CDHapiEnd", "CDHapiJob", "CDHapiJobData",
    "CDHapiResultText", "CDHapiResultInt", "CDHapiResultSets",
    "CDHapiResultBinary",
    "CDHSetReturnVal", "CDHSetSystemData", "CDHGetSystemData",
    "CDHSetCabdPar", "CDHGetCabdPar", "CDHSetCabdWordPar", "CDHGetCabdWordPar",
    "CDHGetSgbdName", "CDHCheckIdent",
    "CDHGetNettoDataFromCbd",
    "CDHResetApiJobData", "CDHGetApiJobData", "CDHGetApiJobByteData",
    "CDHCheckDataUsed", "CDHBinBufToNettoData",
    "CDHBinBufCreate", "CDHBinBufDelete",
    "CDHBinBufWriteByte", "CDHBinBufWriteWord",
    "CDHBinBufReadByte", "CDHBinBufReadWord", "CDHBinBufToStr",
    "CDHResetError", "CDHSetError", "CDHTestError",
    "CDHSetDataOrg",
    "CDHCallAuthenticate", "CDHAuthGetRandom",
])


if __name__ == "__main__":
    print(f"{len(CDH_SLOTS)} CDH callback slots; "
          f"{len(WRITE_CALLBACKS)} in the write set")
    for op in sorted(CDH_SLOTS):
        n, sig = CDH_SLOTS[op]
        args = ", ".join(f"{d} {t} {a}" for d, t, a in sig)
        star = " *" if n in WRITE_CALLBACKS else ""
        print(f"  0x{op:02x} {n:26} ({args}){star}")
