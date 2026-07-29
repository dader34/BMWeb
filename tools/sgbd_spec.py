#!/usr/bin/env python3
"""Lift a job's BEST2 bytecode into a declarative spec (the jobs-to-JSON step).

docs/sgbd-to-json.md establishes that ~90% of the jobs the app runs are
declarative-shaped. This extracts that shape: what the job SENDS, how it
VALIDATES the answer, which BYTES become which results, and what SCALE and
UNIT each carries -- as data, so a spec walker can run the job without the
.prg and without a BEST2 interpreter.

SPEC (spec = 1)

    {
      "spec": 1, "sgbd": "ms450ds0", "job": "STATUS_UBATT",
      "archetype": "looped_read",
      "request": { "bytes": ["..."], "argSlots": [] },
      "validate": [ {"kind": "length", ...}, {"kind": "echo", ...} ],
      "statusTable": "JobResult",         // status byte -> JOB_STATUS text
      "results": [
        { "name": "STAT_UBATT_WERT", "type": "real",
          "scale": 3.97116e-4, "offset": 0.0, "unit": "V" }
      ],
      "confidence": "partial"             // never "full" until the harness says so
    }

WHAT THIS DOES NOT DO, deliberately: it does not guess. Every field it cannot
read out of the bytecode is omitted and the spec is marked partial. A spec is
only trustworthy once tools/sgbd_diff.py has run it against the real engine and
found the result sets identical -- that is what promotes it to "verified".

    python3 tools/sgbd_spec.py ms450ds0 STATUS_UBATT       # one job
    python3 tools/sgbd_spec.py ms450ds0 --all              # every job
    python3 tools/sgbd_spec.py ms450ds0 --write            # -> data/job-specs/
"""
import os
import re
import sys
import json
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sgbd_survey as S                                       # noqa: E402
import best2_abstract as BA                                   # noqa: E402

OUT_DIR = os.path.join(HERE, "..", "data", "job-specs")

SPEC_VERSION = 1

# opcodes that put the request on the wire: response-byte offsets only exist
# after one of these has run
SEND_OPS = {"xsend", "xsendf", "xsendr", "xsendex", "xrequf", "xraw"}

# opcodes that read a RANGE of response bytes (addressing modes 12-15).
# move/scut copy the slice; y2bcd/y2hex convert it.
RANGE_READ_OPS = {"move", "scut", "y2bcd", "y2hex", "ergs"}

# result-writing opcodes -> the EDIABAS result type they produce
ERG_TYPE = {"ergb": "byte", "ergw": "word", "ergd": "dword", "ergi": "int",
            "ergl": "long", "ergr": "real", "ergs": "string", "ergy": "binary",
            "ergc": "char"}

# results that are protocol bookkeeping rather than ECU data
# Protocol bookkeeping rather than ECU data.
#
# Only the _TEL_ prefixed tags belong here. The bare _AUFTRAG1 / _ANTWORT1
# (ASCMK20) and _ANTWORT (LSZ, CVM_II) LOOK like the same internal telegrams,
# but the engine declares them as genuine results for those SGBDs -- filtering
# them cost 8 jobs their schema agreement. What a job publishes is the SGBD's
# decision, not a naming convention we get to infer.
INTERNAL = re.compile(r"^(_TEL_|JOB_|SAETZE|VARIANTE$)")


def _num(s):
    """EDIABAS writes float constants as strings, German decimal comma."""
    try:
        return float(s.replace(",", "."))
    except (ValueError, AttributeError):
        return None


def extract(data, addr, sgbd, job):
    ops = list(S.walk(data, addr))
    arch, feats = S.classify(data, addr)
    spec = {"spec": SPEC_VERSION, "sgbd": sgbd, "job": job,
            "archetype": arch, "confidence": "partial"}
    gaps = []

    # ---- request ---------------------------------------------------------
    # The telegram is assembled into a string register byte by byte
    # (`move S2[#$n], #$val`) before the `etag "_TEL_AUFTRAG"` that publishes
    # it. Constant stores give the fixed template; stores from a register are
    # argument slots the caller fills.
    # `spaste S2[#$n], S1` splices a sub-telegram (an argument block) at n --
    # the same slot mechanism as a register store, so both mark argSlots.
    req, arg_slots = {}, []
    for start, name, args in ops:
        if name == "etag" and any(a.get("s") == "_TEL_AUFTRAG" for a in args):
            break
        if len(args) != 2:
            continue
        dst, src = args
        if dst.get("m") != 9:            # not reg[#imm]
            continue
        idx = dst.get("i")
        if name == "spaste":
            arg_slots.append(idx)
        elif name == "move":
            if "v" in src:
                req[idx] = src["v"]
            elif "r" in src:
                arg_slots.append(idx)
    if req:
        top = max(req) + 1
        spec["request"] = {
            "bytes": [req.get(i) for i in range(top)],
            "argSlots": sorted(set(arg_slots)),
        }
        if any(b is None for b in spec["request"]["bytes"]):
            gaps.append("request has unresolved byte positions")
    else:
        gaps.append("request template not recovered")

    # ---- validation + status table --------------------------------------
    checks = []
    for _, name, args in ops:
        if name != "ergs":
            continue
        lit = [a["s"] for a in args if "s" in a]
        if len(lit) >= 2 and lit[0] == "JOB_STATUS" and lit[1].startswith("ERROR_"):
            checks.append(lit[1])
    if checks:
        spec["validate"] = sorted(set(checks))
    tabs = [a["s"] for _, n, args in ops if n in ("tabset", "tabsetex")
            for a in args if "s" in a]
    if tabs:
        spec["statusTable"] = tabs[0]
        if len(set(tabs)) > 1:
            spec["tables"] = sorted(set(tabs))

    # ---- results ---------------------------------------------------------
    # Walk in order: a float constant loaded via a2flt is the pending scale,
    # an fmul/fadd consumes it, and the next erg* names the result. Units are
    # a literal `ergs "<NAME>_EINH", "V"` near their value.
    # A unit is written either inline (`ergs "X_EINH", "V"`) or -- more often --
    # staged through a register first (`move S1, "V"` then `ergs "X_EINH", S1`),
    # so track the last string literal moved into each register.
    results, pending_scale, pending_off = [], None, None
    units, reg_str = {}, {}
    # response-byte offsets staged for the result currently being built
    pending_index = staged_index = None
    pending_bytes, pending_shift = [], False
    pending_range = False
    pending_conv = None
    reg_num = {}                 # register -> last integer constant moved in
    # registers holding the response telegram. The bytecode routinely aliases
    # it (`xsend S3, ...` then `move S1, S3`) and reads through the copy, so
    # tracking only the register xsend named missed ZKE5's key numbers
    # entirely. S0 stays excluded: it is the scratch/stack register.
    resp_reg = set()
    payload_regs = set()   # response regs that are already payload-relative
    seen_send = False
    for _, name, args in ops:
        strs = [a["s"] for a in args if "s" in a]
        # constants staged in registers, so a substring read whose index and
        # length are register-held can still be resolved
        if name == "move" and len(args) == 2 and "r" in args[0] and seen_send:
            dst_r, src_r = args[0]["r"], args[1].get("r")
            if args[1].get("m") in (1, 2, 3, 4):
                if src_r in resp_reg and dst_r != "S0":
                    resp_reg.add(dst_r)      # plain alias
                elif dst_r in resp_reg and src_r not in resp_reg:
                    resp_reg.discard(dst_r)  # overwritten with something else
            elif args[1].get("m") in (12, 13, 14, 15) and src_r in resp_reg \
                    and dst_r != "S0":
                # `move S4, S3[A2]#I2` slices the PAYLOAD out of the raw
                # telegram: S4 now holds the response body, and every result
                # read afterwards indexes S4, not S3. Missing this alias is
                # why MS450 -- whose two jobs decode correctly -- still showed
                # only 28% of its results with offsets.
                resp_reg.add(dst_r)
                payload_regs.add(dst_r)
        if name == "move" and len(args) == 2 and "r" in args[0]:
            if "v" in args[1]:
                reg_num[args[0]["r"]] = args[1]["v"]
            elif "r" in args[1] and args[1]["r"] in reg_num:
                reg_num[args[0]["r"]] = reg_num[args[1]["r"]]
            else:
                reg_num.pop(args[0]["r"], None)
        if name in SEND_OPS:
            # Response offsets only exist AFTER the telegram goes out. The
            # request-building phase uses the same stage-and-index shape
            # (MS450 stages #$3e9 there), so collecting before the send mixes
            # request scratch into the result's byte list.
            seen_send = True
            pending_bytes, pending_shift = [], False
            pending_index = staged_index = None
            # `xsend <recv>, <send>` names the register the ANSWER lands in.
            # Reads must be attributed to that register only: S0 is scratch
            # (the bytecode stages intermediate words there), and counting
            # `move I0, S0[#$0]` as a response read appended a phantom byte 0
            # to MS450's RPM results, turning 1000 rpm into 256024.5.
            if args and "r" in args[0]:
                resp_reg = {args[0]["r"]}
        # Track literal strings staged in registers -- but a register loaded
        # from ANOTHER register (`move S1, S4`) now holds computed data, so
        # its literal binding must be dropped. Without this the tracker goes
        # stale and attributes a much earlier literal to an unrelated result:
        # BMBT46's CASSETTENDECK_BETRIEBSSTUNDENZAEHLER, an hour counter,
        # picked up "undefinierter Tastenstatus" from a preceding branch.
        if name in ("move", "clear") and len(args) >= 1 and "r" in args[0]:
            dst = args[0]["r"]
            if name == "move" and strs and len(args) == 2 and "s" in args[1]:
                reg_str[dst] = args[1]["s"]
            else:
                reg_str.pop(dst, None)
        if name == "move" and strs:
            v = _num(strs[-1])
            if v is not None:
                pending_scale = v          # candidate; confirmed by fmul below
        elif name == "fmul" and pending_scale is not None:
            pending_off = pending_off or 0.0
        elif name == "fadd" and pending_scale is not None:
            pending_off = pending_scale
        elif name in RANGE_READ_OPS and len(args) == 2 \
                and args[1].get("m") in (12, 13, 14, 15) and seen_send:
            # Substring read: `move S5, S1[L0]#L1` (or [#$idx]#$len) pulls a
            # RANGE out of the response -- how every string result is built
            # (MS450's SERIENNUMMER is offset 2, length 9). The index and
            # length are either immediates in the operand or registers whose
            # constants were staged just above, so both forms resolve here.
            src = args[1]
            idx = src.get("i", reg_num.get(src.get("ir")))
            ln = src.get("len", reg_num.get(src.get("lenr")))
            if idx is not None and ln is not None and ln > 0:
                pending_bytes = list(range(idx, idx + ln))
                pending_shift = False
                pending_range = True
                # y2bcd/y2hex do not copy the bytes, they CONVERT them: RLS's
                # ID_HW_NR is one BCD byte at offset 7, so a walker that just
                # sliced the range would report 0x37 where EDIABAS reports 37.
                pending_conv = {"y2bcd": "bcd", "y2hex": "hex"}.get(name)
        elif name == "move" and len(args) == 2 and "v" in args[1] \
                and args[0].get("r", "").startswith("L"):
            # `move L0, #$a` MAY stage a response-byte index. Only the value
            # still pending when an `atsp` pops it into an index register
            # counts -- the same instruction shape is used for shift counts
            # (`move L0, #$8` before an asl) and other scratch constants, so a
            # bare collect picks up numbers that are not offsets at all.
            pending_index = args[1]["v"]
        elif name == "atsp":
            # pops the staged constant into the index register: from here the
            # next reg[reg] read is against THIS offset
            staged_index = pending_index
            pending_index = None
        elif name == "move" and len(args) == 2 and args[1].get("m") == 9 \
                and seen_send and args[1].get("r") in resp_reg:
            # Direct immediate-indexed read: `move I0, S0[#$6]` takes byte 6
            # straight out of the response with no staging at all -- ZKE5's
            # key-memory numbers and many IDENT fields are built this way.
            # Simplest of the three read shapes and the last one missing.
            pending_bytes.append(args[1]["i"])
        elif name == "move" and len(args) == 2 and args[1].get("m") == 10 \
                and staged_index is not None and seen_send:
            # reg[reg] read against the staged index -> a response byte at a
            # known offset. Collect them in order; the next erg* claims them.
            pending_bytes.append(staged_index)
            staged_index = None
        elif name == "asl":
            pending_shift = True
        elif name == "etag" and strs:
            # `etag #$c, "NAME"` gates a conditional result block: EDIABAS
            # asks "did the caller request NAME?" and the body that follows
            # computes it only if so. RDC's STATUS_IO produces STAT_FOLGAUS
            # exclusively through this path -- no erg* names it -- so a spec
            # built from erg* alone silently drops it.
            #
            # It also DELIMITS one result's bytecode from the next, which is
            # what keeps STAT_MOTORDREHZAHL_SOLL_WERT's offsets (12,13) from
            # inheriting the preceding result's (10,11).
            pending_bytes, pending_shift = [], False
            pending_index = staged_index = None
            nm = strs[0]
            if not INTERNAL.match(nm) and nm not in {r["name"]
                                                     for r in results}:
                results.append({"name": nm, "conditional": True})
        elif name in ERG_TYPE:
            if not strs:
                continue
            nm = strs[0]
            if INTERNAL.match(nm):
                continue
            # an erg* store is authoritative over the etag placeholder
            for i, r in enumerate(results):
                if r["name"] == nm and r.get("conditional") and "type" not in r:
                    results.pop(i)
                    break
            if name == "ergs" and nm.endswith("_EINH"):
                val = strs[1] if len(strs) >= 2 else (
                    reg_str.get(args[1]["r"]) if len(args) > 1
                    and "r" in args[1] else None)
                if val:
                    units[nm[:-5]] = val   # STAT_X_EINH "V" -> unit of STAT_X
                # ...and the unit is ALSO a result in its own right: the engine
                # emits STAT_UBATT_EINH alongside STAT_UBATT_WERT, so a spec
                # that folded it into a `unit` field would produce a result set
                # the engine's consumers do not see. Emit both -- the spec's job
                # is to reproduce the engine's output, not to improve on it.
                # Written from several branches (one per variant's unit), so
                # collapse onto the existing entry the same way values do.
                prior = next((x for x in results if x["name"] == nm), None)
                if prior is not None:
                    if val and val != prior.get("const"):
                        prior.setdefault("altConst", [])
                        if val not in prior["altConst"]:
                            prior["altConst"].append(val)
                else:
                    results.append({"name": nm, "type": "string",
                                    **({"const": val} if val else {})})
                continue
            prev = next((x for x in results if x["name"] == nm), None)
            if prev is not None and name != "ergs":
                # Same non-string result stored from several branches: one
                # result, computed differently per variant or per response
                # shape (ASCMK20 writes each wheel speed from two branches,
                # EWS COD_LESEN writes COD_DME_SS from three). Record the
                # alternative scales so nothing is lost, but emit ONE result --
                # the engine returns one, and a duplicated name would make the
                # spec's result set structurally wrong even though the schema
                # check, which compares sets, cannot see it.
                if name == "ergr" and pending_scale is not None \
                        and pending_scale != prev.get("scale"):
                    prev.setdefault("altScales", [])
                    if pending_scale not in prev["altScales"]:
                        prev["altScales"].append(pending_scale)
                prev["branches"] = prev.get("branches", 1) + 1
                pending_scale = pending_off = None
                continue
            if prev is not None and name == "ergs":
                # The SAME string result written from several mutually
                # exclusive branches is an ENUMERATION, not several results:
                # BMBT46's CASSETTEN_STATUS_TEXT has one store per deck state
                # ("Wiedergabe", "Eject, Standby, ..."), guarded by a comp on
                # the status byte, and exactly one executes. Collect the
                # alternatives instead of emitting the name repeatedly.
                lit = strs[1] if len(strs) >= 2 else (
                    reg_str.get(args[1]["r"]) if len(args) > 1
                    and "r" in args[1] else None)
                if lit:
                    prev.setdefault("values", [])
                    if lit not in prev["values"]:
                        prev["values"].append(lit)
                pending_scale = pending_off = None
                continue
            r = {"name": nm, "type": ERG_TYPE[name]}
            # the register the value came from, so a table lookup writing that
            # register can be attributed to this result below
            if len(args) > 1 and "r" in args[1]:
                r["_srcReg"] = args[1]["r"]
            if pending_bytes:
                # The response bytes this result was built from, in the order
                # the bytecode read them, indexed from the start of the
                # PAYLOAD -- the bytecode strips the transport header into its
                # own register before indexing, so offset 2 of MS450's
                # STATUS_UBATT is the third payload byte, not the third byte
                # of the frame. Verified against the engine: bytes [2,3] of
                # `84 F1 12 61 A3 76 0A 0B` are 76 0A, which scales to the
                # 12.000051288 V the engine reports.
                r["bytes"] = list(pending_bytes)
                r["base"] = "payload"
                r["width"] = len(pending_bytes)
                if pending_range:
                    # a substring: the bytes ARE the value (ASCII), not digits
                    # of one big-endian number
                    r["kind"] = "range"
                    if pending_conv:
                        r["convert"] = pending_conv
                elif len(pending_bytes) > 1 and pending_shift:
                    r["endian"] = "big"
            if name == "ergr" and pending_scale is not None:
                r["scale"] = pending_scale
                if pending_off:
                    r["offset"] = pending_off
            if name == "ergs":
                lit = strs[1] if len(strs) >= 2 else (
                    reg_str.get(args[1]["r"]) if len(args) > 1
                    and "r" in args[1] else None)
                if lit:
                    r["values"] = [lit]
            results.append(r)
            pending_scale = pending_off = None
            pending_index = staged_index = None
    pending_bytes, pending_shift = [], False
    # attach units to their value results (STAT_UBATT_WERT <- STAT_UBATT_EINH)
    for r in results:
        stem = r["name"][:-5] if r["name"].endswith("_WERT") else r["name"]
        for k, u in units.items():
            if k == stem or k == r["name"]:
                r["unit"] = u
                break
    if results:
        spec["results"] = results
    else:
        gaps.append("no ECU results recovered")

    # ---- table-driven results -------------------------------------------
    # A whole class of results is not extracted from the response at all: it
    # is LOOKED UP. MS450's measurement blocks read a measurement number from
    # the ECU, seek it in the SGBD's own FUmweltTexte table, and take the
    # label, unit, scale and offset from that row -- `tabset "FUmweltTexte"`,
    # `tabseek "UWNR", <n>`, then `tabget S7,"UWTEXT"` / `S6,"MUL_WORD"` /
    # `S6,"ADD"` / `S6,"UW_EINH"`. So the scale is per-measurement DATA, not a
    # constant in the bytecode, which is why no float literal was ever found
    # for these and every one of them looked unresolvable.
    #
    # The table travels with the SGBD and the engine already serves it
    # (/api/ecu/<sgbd>/table/<name>), so recording the lookup -- table, key
    # column, value column -- is enough for a walker to reproduce it.
    # Walk once in order, keeping the CURRENT binding of each register to the
    # lookup that last filled it, and snapshot that binding when a result is
    # stored. A single pass that keeps only the final binding attributes every
    # result to whichever table happened to be set last -- which made MS450's
    # measurement labels claim to come from JobResult/STATUS_TEXT (the
    # protocol status table) instead of FUmweltTexte/UWTEXT.
    cur_table = seek_col = None
    tab_reads = {}          # register -> (table, keyCol, valueCol)
    result_lookup = {}      # result name -> that tuple, as of its store
    for _, name, args in ops:
        strs = [a["s"] for a in args if "s" in a]
        if name in ("tabset", "tabsetex") and strs:
            cur_table, seek_col = strs[0], None
        elif name in ("tabseek", "tabseeku") and strs:
            seek_col = strs[0]
        elif name == "tabget" and cur_table:
            dst = args[0].get("r") if args else None
            col = strs[-1] if strs else None
            if dst and col:
                tab_reads[dst] = (cur_table, seek_col, col)
        elif name == "move" and len(args) == 2 and "r" in args[0] \
                and "r" in args[1]:
            # a table value copied on to another register keeps its origin
            if args[1]["r"] in tab_reads:
                tab_reads[args[0]["r"]] = tab_reads[args[1]["r"]]
            else:
                tab_reads.pop(args[0]["r"], None)
        elif name in ERG_TYPE and strs:
            src = args[1].get("r") if len(args) > 1 else None
            if src in tab_reads:
                result_lookup.setdefault(strs[0], tab_reads[src])
    for r in results:
        if r.get("const") is not None or r.get("bytes"):
            continue
        hit = result_lookup.get(r["name"])
        if hit:
            t, k, c = hit
            r["lookup"] = {"table": t, "valueColumn": c}
            if k:
                r["lookup"]["keyColumn"] = k

    # ---- table-masked bit flags -----------------------------------------
    # The other table shape: a digital-status job reads one response byte and
    # tests a BIT in it, with both the mask and the expected value coming from
    # a table row (`tabget S1,"MASK"` / `tabget S1,"VALUE"`, then `and` + `xor`
    # against the byte). BMS46's STATUS_DIGITAL builds STAT_KL15_EIN,
    # STAT_START_EIN and their neighbours exactly this way -- 248 results
    # across the E46 set, the single largest unresolved group.
    #
    # The bit position is per-result DATA in the table, so like the
    # measurement scales it is recorded as a lookup rather than a constant.
    # the table that is actually SET when MASK/VALUE are fetched -- not the
    # job's first tabset, which is the protocol status table (JobResult)
    bit_table = None
    _cur = None
    _seen = set()
    for _, n, args in ops:
        strs = [a["s"] for a in args if "s" in a]
        if n in ("tabset", "tabsetex") and strs:
            _cur = strs[0]
        elif n == "tabget" and strs:
            col = strs[-1].upper()
            if col in ("MASK", "VALUE"):
                _seen.add(col)
                if bit_table is None:
                    bit_table = _cur
    if _seen >= {"MASK", "VALUE"}:
        for r in results:
            if r.get("const") is not None or r.get("bytes") or r.get("lookup"):
                continue
            if r.get("type") in ("int", "byte", "word"):
                r["bitTest"] = {"table": bit_table,
                                "maskColumn": "MASK", "valueColumn": "VALUE"}

    # ---- dataflow fallback ----------------------------------------------
    # Results whose bytes the direct lifter could not see because the value
    # travels through scratch slots and the operand stack. The abstract
    # interpreter follows that chain; it independently reproduces the direct
    # lifter's answers on the value-verified jobs (MS450 STATUS_UBATT [2,3],
    # STATUS_MOTORDREHZAHL [10,11] and [12,13]), which is what makes it
    # trustworthy for the ones only it can reach.
    missing = [r for r in results
               if r.get("const") is None and not r.get("bytes")]
    if missing:
        try:
            flow = BA.resolve_result_bytes(data, addr)
        except Exception:                                   # noqa: BLE001
            flow = {}
        for r in missing:
            b = flow.get(r["name"])
            if b:
                r["bytes"] = b
                r["base"] = "payload"
                r["width"] = len(b)
                r["via"] = "dataflow"

    # A per-iteration read loop: one body executed once per record, the
    # sixteen STAT_MESSWERTn results being sixteen passes over it. The stride
    # is read from the response (the ECU declares the record width), so the
    # spec names the slot rather than inventing a constant.
    loop = None
    try:
        loop = BA.detect_loop(data, addr)
    except Exception:                                       # noqa: BLE001
        loop = None
    if loop:
        spec["repeat"] = loop

    if arch == "computed":
        gaps.append("archetype needs hand-written handler")
    if arch == "looped_read" and "repeat" not in spec:
        gaps.append("loop bounds not lifted")
    if feats["par"]:
        spec["takesArguments"] = feats["par"]

    # A result the bytecode STORES but no etag ever gates, when the job gates
    # others, is dead: EDIABAS only hands back results the caller asked for by
    # the gated name. EKP_DS2's STATUS_MESSWERTE gates STAT_TEMP_UEBER_*_WERT
    # and then stores to STAT_UEBER_TEMP_*_WERT -- BMW transposed the words, so
    # those two values never reach anyone. Flagged rather than corrected: the
    # spec's job is to reproduce the engine, bug for bug.
    gated = {r["name"] for r in results if r.get("conditional")}
    if gated:
        for r in results:
            if r["name"] not in gated and "type" in r \
                    and not r["name"].endswith("_EINH"):
                near = [g for g in gated
                        if sorted(g.split("_")) == sorted(r["name"].split("_"))]
                if near:
                    r["deadStore"] = near[0]
                    gaps.append(f"{r['name']} is stored but gated as {near[0]}"
                                " (SGBD bug: never returned)")

    for r in results:
        r.pop("_srcReg", None)

    if gaps:
        spec["gaps"] = gaps
    return spec


def job_addr(data, jobs, want):
    return next((a for n, a in jobs if n.upper() == want.upper()), None)


def load(sgbd):
    path = next((p for p in glob.glob(os.path.join(S.ECU_DIR, "*.prg"))
                 + glob.glob(os.path.join(S.ECU_DIR, "*.PRG"))
                 if os.path.basename(p)[:-4].lower() == sgbd.lower()), None)
    if not path:
        raise SystemExit(f"no such SGBD: {sgbd}")
    return S.read_jobs(path)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 0
    sgbd = args[0].lower()
    data, jobs = load(sgbd)

    if "--all" in sys.argv or "--write" in sys.argv:
        specs = []
        for n, a in jobs:
            if n.startswith("_"):
                continue
            specs.append(extract(data, a, sgbd, n))
        clean = [s for s in specs if "gaps" not in s]
        print(f"{len(specs)} jobs, {len(clean)} extracted with no gaps")
        by_gap = {}
        for s in specs:
            for g in s.get("gaps", []):
                by_gap[g] = by_gap.get(g, 0) + 1
        for g, c in sorted(by_gap.items(), key=lambda kv: -kv[1]):
            print(f"  {c:4}  {g}")
        if "--write" in sys.argv:
            os.makedirs(OUT_DIR, exist_ok=True)
            out = os.path.join(OUT_DIR, sgbd + ".json")
            with open(out, "w", encoding="utf-8") as f:
                json.dump({"sgbd": sgbd, "spec": SPEC_VERSION, "jobs": specs},
                          f, ensure_ascii=False, indent=1)
            print(f"-> {os.path.relpath(out)}")
        return 0

    want = args[1]
    addr = job_addr(data, jobs, want)
    if addr is None:
        raise SystemExit(f"{sgbd} has no job {want}")
    print(json.dumps(extract(data, addr, sgbd, want.upper()),
                     ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
