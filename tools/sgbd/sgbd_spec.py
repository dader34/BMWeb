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

HERE = os.path.dirname(os.path.abspath(__file__))
import _engine                            # noqa: E402,F401  sys.path setup
import sgbd_survey as S                                       # noqa: E402
import best2_abstract as BA                                   # noqa: E402

OUT_DIR = os.path.join(HERE, "..", "..", "data", "job-specs")

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

# Results that are protocol bookkeeping rather than ECU data. Defined once
# in sgbd_survey (see the comment there) and shared with sgbd_diff, so the
# producer and the checker can never disagree about what counts as internal.
INTERNAL = S.INTERNAL


def _num(s):
    """EDIABAS writes float constants as strings, German decimal comma."""
    try:
        return float(s.replace(",", "."))
    except (ValueError, AttributeError):
        return None


def extract(data, addr, sgbd, job):
    # Decode the bytecode ONCE and hand the list to every pass that used to
    # walk for itself (classify, resolve_transforms, resolve_result_bytes,
    # detect_loop): the decode dominated extraction time, and each job was
    # being re-decoded ~6x for identical results. The list is never mutated
    # by any consumer, so sharing it is safe.
    ops = list(S.walk(data, addr))
    arch, feats = S.classify(data, addr, ops)
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
    # Transformations applied before a store (bit mask, integer offset).
    # Computed by the interpreter, which models the stack -- the constant
    # reaches the operand register through push/pop, so neither an immediate
    # match nor a register tracker can see it.
    try:
        _xform = BA.resolve_transforms(data, addr, ops)
    except Exception:                                       # noqa: BLE001
        _xform = {}

    results, pending_scale, pending_off = [], None, None
    units, reg_str = {}, {}
    # response-byte offsets staged for the result currently being built
    pending_index = staged_index = None
    pending_bytes, pending_shift = [], False
    pending_range = False
    pending_conv = None
    pending_int = pending_fdiv = None
    last_float_const = None
    freg_const = {}   # float register -> the constant a2flt put there
    fapplied = {}     # float register -> [scale, offset] applied to it
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
        # An INTEGER divisor staged for fdiv, watched SEPARATELY from the main
        # dispatch below. Scales are not always float literals: BM_WIDE's
        # battery voltage is `move L0, #$a` / fix2flt / fdiv -- a divide by ten
        # the lifter never saw, so it reported the raw byte 53 where the engine
        # reports 5.3. This must not sit in the same elif chain as the
        # staged-index reader, which matches the identical instruction shape:
        # doing so stole every `move L0, #$n` and dropped byte coverage from
        # 69% to 29%.

        if name == "move" and len(args) == 2 and "v" in args[1] \
                and args[0].get("r", "").startswith("L"):
            pending_int = args[1]["v"]
        elif name in ("fix2flt", "a2flt") and pending_int is not None:
            pending_fdiv = pending_int
            pending_int = None
        elif name == "fdiv" and pending_fdiv \
                and freg_const.get((args[0] or {}).get("r")) is None:
            # dividing a KNOWN CONSTANT is arithmetic, not a scale: ASCMK20's
            # zero-default branch computes 0/1 into the same register the
            # real branch scales by 100, and recording its "scale" of 1.0
            # crowded the real 0.01 into altScales. Wire data has no
            # freg_const entry, so the target being known means fold, skip.
            pending_scale = 1.0 / pending_fdiv
            pending_off = 0.0
            pending_fdiv = None
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
        if name == "move" and len(args) == 2 and "r" in args[0] \
                and args[0].get("m") in (1, 2, 3, 4):
            dst_reg = args[0]["r"]
            # a write stales every VIEW sharing the storage: `move B0, ...`
            # invalidates what reg_num knew about L0
            for rr in (BA._overlaps(dst_reg) if dst_reg[0] in "BIL"
                       else {dst_reg}):
                if rr != dst_reg:
                    reg_num.pop(rr, None)
            if "v" in args[1]:
                reg_num[dst_reg] = args[1]["v"]
            elif "r" in args[1] and args[1]["r"] in reg_num:
                reg_num[dst_reg] = reg_num[args[1]["r"]]
            else:
                reg_num.pop(dst_reg, None)
        elif name in ("pop", "atsp", "clear", "adds", "addc", "subb",
                      "subc", "mult", "div", "mod", "asl", "lsl", "lsr",
                      "asr", "and", "or", "xor", "not", "slen", "a2fix",
                      "flt2fix") and args and "r" in args[0] \
                and args[0].get("m") in (1, 2, 3, 4):
            # these WRITE their first operand; the constant is gone. Without
            # this, `atsp L2, #$8` left a stale constant on L2 and a
            # fix2flt of response data was mistaken for a constant load.
            dst_reg = args[0]["r"]
            for rr in (BA._overlaps(dst_reg) if dst_reg[0] in "BIL"
                       else {dst_reg}):
                reg_num.pop(rr, None)
        if name in SEND_OPS:
            # Response offsets only exist AFTER the telegram goes out. The
            # request-building phase uses the same stage-and-index shape
            # (MS450 stages #$3e9 there), so collecting before the send mixes
            # request scratch into the result's byte list.
            seen_send = True
            pending_bytes, pending_shift = [], False
            pending_range = False
            pending_conv = None
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
        # Bind a float constant to the REGISTER holding it, not to a single
        # "most recent constant" slot. BMS46 loads 0.1 into F3 with
        # `move S1,"0.1"` / `a2flt F3,S1` and multiplies ~78 instructions
        # later; a lone pending value is long overwritten by then, so the
        # scale was dropped and F_BSZ_ALT decoded 6431 where the engine says
        # 643.1. The constant is either staged through a string register or
        # INLINE in the operand (`a2flt F0,"-48"` -- how the coolant
        # temperature's offset arrives); both bind here.
        if name == "move" and strs:
            v = _num(strs[-1])
            if v is not None:
                pending_scale = v          # candidate; confirmed by fmul below
                last_float_const = v
        elif name == "a2flt" and len(args) == 2 and "r" in args[0]:
            inline = _num(args[1]["s"]) if "s" in args[1] else None
            if inline is not None:
                freg_const[args[0]["r"]] = inline
            elif last_float_const is not None:
                freg_const[args[0]["r"]] = last_float_const
        elif name == "fmul" and len(args) == 2 \
                and freg_const.get(args[0].get("r")) is None:
            src, dst = args[1].get("r"), args[0].get("r")
            if src in freg_const:
                pending_scale = freg_const[src]
                pending_off = pending_off or 0.0
            elif pending_scale is not None:
                pending_off = pending_off or 0.0
            # ...and bind what was applied to the register itself, because a
            # job stores the same computed value more than once (BMS46 emits
            # STAT_ and STATUS_MOTORTEMPERATUR_WERT from one F0) and the
            # pending slot is consumed by the first store.
            if pending_scale is not None and dst:
                fapplied[dst] = [pending_scale, fapplied.get(dst, [None, None])[1]]
        elif name == "fadd" and len(args) == 2:
            src, dst = args[1].get("r"), args[0].get("r")
            if src in freg_const:
                pending_off = freg_const[src]
            elif pending_scale is not None:
                pending_off = pending_scale
            if pending_off is not None and dst in fapplied:
                fapplied[dst][1] = pending_off
        elif name == "fdiv" and len(args) == 2 \
                and args[1].get("r") in freg_const \
                and freg_const[args[1]["r"]] \
                and freg_const.get(args[0].get("r")) is None:
            # a division IS a scale, stated as its reciprocal: STAT_AUSGANG
            # is the PWM byte / 2.56, which the engine reports as raw*0.390625
            # truncated by the ergi. The divisor reaches here the same way
            # every float constant does (a2flt from a register or inline).
            src, dst = args[1]["r"], args[0].get("r")
            pending_scale = 1.0 / freg_const[src]
            pending_off = pending_off or 0.0
            if dst:
                fapplied[dst] = [pending_scale,
                                 fapplied.get(dst, [None, None])[1]]
        elif name == "move" and len(args) == 2 \
                and (args[0].get("r") or "").startswith("F"):
            # a float-register copy carries both the constant and the applied
            # scale; any other write to it invalidates them
            dst, src = args[0]["r"], args[1].get("r")
            if src in freg_const:
                freg_const[dst] = freg_const[src]
            else:
                freg_const.pop(dst, None)
            if src in fapplied:
                fapplied[dst] = list(fapplied[src])
            else:
                fapplied.pop(dst, None)
        elif name in ("fix2flt", "flt2fix", "a2fix") and args \
                and (args[0].get("r") or "").startswith("F"):
            # fix2flt of a register holding a KNOWN integer is a constant
            # load into float space -- ASCMK20's `move L0,#$64` /
            # `fix2flt F1,L0` is how the divisor 100 arrives. A conversion
            # of anything else (response data, stack values) invalidates.
            csrc = args[1].get("r") if len(args) > 1 else None
            if name == "fix2flt" and csrc in reg_num:
                freg_const[args[0]["r"]] = float(reg_num[csrc])
            else:
                freg_const.pop(args[0]["r"], None)
            fapplied.pop(args[0]["r"], None)
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
            pending_range = False
            pending_conv = None
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
                if name == "ergr" and pending_scale is not None:
                    if prev.get("scale") is None:
                        # the earlier branch computed a constant (ASCMK20's
                        # zero default) and rightly claimed no scale; the
                        # branch that scales wire data owns the slot
                        prev["scale"] = pending_scale
                        if pending_off:
                            prev["offset"] = pending_off
                    elif pending_scale != prev.get("scale"):
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
            # mask/addend do NOT require pending_bytes: the offsets for
            # these results are often recovered later by the interpreter,
            # while the transformation is visible right here in the
            # instruction stream. Gating on pending_bytes dropped both.
            r_mask = _xform.get(nm, {}).get("mask")
            r_add = _xform.get(nm, {}).get("addend")
            r_shift = _xform.get(nm, {}).get("shift")
            r_mult = _xform.get(nm, {}).get("mult")
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
            # A scale is not exclusive to float results: STAT_AUSGANG divides
            # the PWM byte by 2.56 and stores through flt2fix + ergi, so the
            # engine reports trunc(raw * 0.390625). For ergr the fapplied
            # register binding also serves stores after the pending slot was
            # consumed (one F0 emitted under two names); integral stores get
            # the scale only when the float chain just computed one.
            # (pending_off doubles as the "a float chain actually ran" flag:
            # fmul/fdiv always set it, a bare numeric string constant --
            # `move S1,"5"` staged for an ergs -- never does, so a stray
            # constant cannot attach itself to an integral store.)
            if name == "ergr" or (name in ("ergi", "ergw", "ergb", "ergl",
                                           "ergd")
                                  and pending_scale is not None
                                  and pending_off is not None):
                sc, off = pending_scale, pending_off
                if sc is None and name == "ergr" and len(args) > 1 \
                        and args[1].get("r") in fapplied:
                    sc, off = fapplied[args[1]["r"]]
                if sc is not None:
                    r["scale"] = sc
                    if off:
                        r["offset"] = off
            if name == "ergs":
                lit = strs[1] if len(strs) >= 2 else (
                    reg_str.get(args[1]["r"]) if len(args) > 1
                    and "r" in args[1] else None)
                if lit:
                    r["values"] = [lit]
            if r_shift:
                r["shift"] = r_shift
            if r_mask is not None:
                r["mask"] = r_mask
            if r_add:
                r["addend"] = r_add
            if r_mult:
                # an integer multiply applied BEFORE the addend, distinct
                # from the float scale which may follow it: BMBT's voltage
                # is (raw*1085 + 7000) * 0.0001, so folding the multiplier
                # into the scale would misplace the addend
                r["mult"] = r_mult
            results.append(r)
            pending_scale = pending_off = None
            pending_index = staged_index = None
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
        if r.get("const") is not None:
            continue
        hit = result_lookup.get(r["name"])
        if not hit:
            continue
        # A `tabget` into the register the result is stored from is decisive:
        # the value IS the table cell, whatever bytes the walker happened to
        # collect on the way there. AIC's ID_LIEF_TEXT is
        # tabseek "LIEF_NR" / tabget "LIEF_TEXT" -- the supplier name -- and
        # keeping the byte offsets alongside it decoded one raw byte ("»")
        # where the engine reports "unbekannter Hersteller".
        t, k, c = hit
        r["lookup"] = {"table": t, "valueColumn": c}
        if k:
            r["lookup"]["keyColumn"] = k
        r.pop("bytes", None)
        r.pop("width", None)
        r.pop("kind", None)
        r.pop("convert", None)
        r.pop("ascii", None)

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

    # ---- constant string results -----------------------------------------
    # Some results are simply a literal the job stores when a flag is set:
    # MS450's ECU_CONFIG emits STAT_AT_TEXT = "Automatik Getriebe" beside the
    # STAT_AT flag it just decoded. Non-empty literals only -- `move S1, ""`
    # is an initialisation, and treating that as the value would have marked
    # AIF_LESEN's VIN fields resolved when they are BCD-unpacked further down.
    reg_lit = {}
    for _, name, args in ops:
        if name == "move" and len(args) == 2 and "r" in args[0]:
            if "s" in args[1]:
                reg_lit[args[0]["r"]] = args[1]["s"]
            else:
                reg_lit.pop(args[0]["r"], None)
        elif name in ERG_TYPE and args and "s" in args[0]:
            src = args[1].get("r") if len(args) > 1 else None
            lit = reg_lit.get(src)
            if lit:
                for r in results:
                    if r["name"] == args[0]["s"] and r.get("const") is None \
                            and not r.get("bytes") and not r.get("lookup") \
                            and not r.get("bitTest") and "values" not in r:
                        r["const"] = lit

    # ---- cross-check against the interpreter -----------------------------
    # The direct lifter accumulates offsets as it walks and clears them at
    # each `etag` / result store. Where a job reads bytes BETWEEN those
    # boundaries -- validation reads, a length check, a preceding branch --
    # the leftovers ride along into the next result: SMG2's one-byte
    # FLASH_LOESCHEN_STATUS came out as [4,5,6,7,8].
    #
    # The abstract interpreter has no such state; it answers from the value
    # actually stored. Where both resolve a result they agree 514 times and
    # differ 91, and every difference is this accumulation -- so the
    # interpreter wins, and the direct answer is kept only when it matches or
    # the interpreter has nothing.
    try:
        _flow, _consts = BA.resolve_result_bytes(data, addr, want_consts=True,
                                                 ops=ops)
    except Exception:                                       # noqa: BLE001
        _flow, _consts = {}, {}
    for r in results:
        if not r.get("bytes"):
            continue
        alt = _flow.get(r["name"])
        if alt and list(alt) != list(r["bytes"]):
            # A genuine substring keeps its contiguous range; the interpreter
            # reports only the byte that reached the store, which for a real
            # range read is its first. Anything else -- a "range" that is not
            # contiguous from the interpreter's byte, or a scalar -- is the
            # accumulation bug, and the interpreter's answer replaces it.
            contiguous = (r.get("kind") == "range"
                          and len(alt) == 1 and r["bytes"][0] == alt[0])
            if contiguous:
                continue
            r["bytes"] = list(alt)
            r["width"] = len(alt)
            r["via"] = "dataflow"
            r.pop("kind", None)
            r.pop("convert", None)

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
        flow = _flow
        for r in missing:
            b = flow.get(r["name"])
            if b:
                r["bytes"] = b
                r["base"] = "payload"
                r["width"] = len(b)
                r["via"] = "dataflow"

    # ---- enumeration selectors -------------------------------------------
    # A string result stored once per branch of a comparison ladder is an
    # ENUMERATION -- BMBT's deck status reads byte 3, dispatches through
    #     comp L0,#$1 / jz Lcase1
    #     comp L0,#$0 / jz Lcase0
    #     jump Ldefault
    # and each case block stores its own literal. The values were already
    # collected; what makes them DECODABLE is which compared constant selects
    # which text, plus the default for codes the ladder does not name
    # (the engine reports "Code nicht definiert" for 0x11).
    # The compared constant is read through the ABSTRACT MACHINE, because
    # only the oldest ladders compare against an immediate -- BMBT46TN
    # stages each constant through push/pop (`move L0,#$0 / push / pop L1 /
    # comp L0,L1`), which no syntactic match can see. `jz` selects the jump
    # target as the case block; `jnz` is the inverted shape, where the case
    # block is the FALL-THROUGH.
    case_key, default_blocks = {}, set()
    prev_cmp, in_ladder = None, False
    _lm = BA.Machine()
    next_addr = {ops[i][0]: ops[i + 1][0] for i in range(len(ops) - 1)}
    for st, name, a in ops:
        if name == "comp" and len(a) == 2:
            vals = [_lm.get(a[0]), _lm.get(a[1])]
            const = next((v for v in reversed(vals)
                          if isinstance(v, int)), None)
            prev_cmp, in_ladder = const, True
        elif name == "jz" and prev_cmp is not None and a and "v" in a[0]:
            case_key[a[0]["v"]] = prev_cmp
            prev_cmp = None
        elif name == "jnz" and prev_cmp is not None and st in next_addr:
            case_key[next_addr[st]] = prev_cmp
            prev_cmp = None
        elif name == "jump" and in_ladder and a and "v" in a[0]:
            default_blocks.add(a[0]["v"])
            in_ladder = False
        elif name not in ("nop",):
            prev_cmp = None
            if name not in ("jz", "jnz"):
                in_ladder = False
        _lm.step(name, a)
    if case_key:
        enum_map, enum_default = {}, {}
        cur, lit_reg = None, {}
        for st, name, a in ops:
            if st in case_key:
                cur = ("case", case_key[st])
            elif st in default_blocks:
                cur = ("default",)
            if name == "move" and len(a) == 2 and "r" in a[0] and "s" in a[1]:
                lit_reg[a[0]["r"]] = a[1]["s"]
            elif name == "ergs" and a and "s" in a[0] and cur is not None:
                nm = a[0]["s"]
                lit = a[1].get("s") if len(a) > 1 and "s" in a[1] \
                    else lit_reg.get(a[1].get("r")) if len(a) > 1 else None
                if lit is not None:
                    if cur[0] == "case":
                        enum_map.setdefault(nm, {})[str(cur[1])] = lit
                    else:
                        enum_default[nm] = lit
                cur = None
        for r in results:
            m = enum_map.get(r["name"])
            if m and r.get("bytes") and len(m) + (1 if r["name"] in
                                                 enum_default else 0) >= 2:
                r["enumMap"] = m
                if r["name"] in enum_default:
                    r["enumDefault"] = enum_default[r["name"]]

    # ---- honesty pass ----------------------------------------------------
    # A REPEATED offset inside one value is the direct lifter's accumulation
    # artifact: a byte read for something else (a length check, a status
    # byte) rode along into the next result, and no encoding reads the same
    # response byte twice into one number. When the interpreter has no
    # answer to replace the list with, the spec must say UNRESOLVED rather
    # than carry offsets that decode to a plausible-looking wrong value --
    # every consumer used to re-detect this garbage independently, which is
    # exactly backwards: the producer is the one place that knows.
    # (Non-monotonic but unique lists stay: bytes are recorded in READ
    # order, and a little-endian field legitimately reads high offset first.)
    for r in results:
        b = r.get("bytes")
        if b and len(set(b)) != len(b) and r["name"] not in _flow:
            del r["bytes"]
            r.pop("width", None)
            r.pop("endian", None)
            gaps.append(f"{r['name']}: accumulated offsets dropped "
                        f"(reads could not be attributed)")

    # A per-iteration read loop: one body executed once per record, the
    # sixteen STAT_MESSWERTn results being sixteen passes over it. The stride
    # is read from the response (the ECU declares the record width), so the
    # spec names the slot rather than inventing a constant.
    loop = None
    try:
        loop = BA.detect_loop(data, addr, ops)
    except Exception:                                       # noqa: BLE001
        loop = None
    if loop:
        spec["repeat"] = loop
        # Per-iteration OFFSETS. The lifted repeat says which scratch slots
        # carry the cursor and stride, but a decoder needs the actual byte
        # positions, and the interpreter's single linear pass reports every
        # iteration at iteration ZERO's offsets -- which is why
        # STATUS_MESSWERTBLOCK_0 returned one value sixteen times where the
        # engine returns sixteen.
        #
        # The records are contiguous and equal-width, so iteration i sits at
        # base + i*stride. Both fall out of the results themselves: indexed
        # names (STAT_MESSWERT<n>_WERT) give i, and the width is the span the
        # iteration-zero result already occupies. Verified against the engine
        # on MS450: stride 2, so MESSWERT3 reads payload [6,7] = 15171,
        # exactly what the engine reports.
        idx_re = re.compile(r"^(.*?)([0-9A-F])(_WERT|_TEXT|_EINH|_STRING)$")
        indexed = []
        for r in results:
            m = idx_re.match(r["name"])
            if m and r.get("bytes"):
                indexed.append((int(m.group(2), 16), m.group(1), m.group(3), r))
        if len({stem for _, stem, _, _ in indexed}) == 1 and len(indexed) > 1:
            zero = [r for i, _, _, r in indexed if i == 0]
            if zero and zero[0].get("bytes"):
                width = len(zero[0]["bytes"])
                # The interpreter's iteration-zero offset IS the base -- no
                # adjustment. Solved against the engine rather than reasoned
                # about: MS450 reports MESSWERT3 = 15171, which is the word at
                # PAYLOAD offset 8, and 2 + 3*2 = 8. An earlier attempt wound
                # the base back one stride (on the theory that the cursor
                # advances before the first store, which it does) and put
                # every value one iteration out.
                base = min(zero[0]["bytes"])
                for i, _, suffix, r in indexed:
                    if suffix != "_WERT":
                        continue      # text/unit come from the table, not bytes
                    r["bytes"] = [base + i * width + k for k in range(width)]
                    r["iteration"] = i
                spec["repeat"]["stride"] = width
                spec["repeat"]["base"] = base
                # The per-record SCALE is in the same table the sibling
                # _TEXT/_EINH results already point at, one row per
                # measurement (FUmweltTexte: MUL_WORD and ADD keyed by UWNR).
                # It is not in the bytecode -- MS450's sixteen measurements
                # scale by 1/256, 1/8, 1, 0.000396729 and so on -- so the
                # _WERT result has to carry the lookup too or a decoder gets
                # every offset right and every value wrong.
                sib = next((x.get("lookup") for x in results
                            if x.get("lookup")
                            and x["name"].endswith(("_TEXT", "_EINH"))), None)
                if sib:
                    for _, _, suffix, r in indexed:
                        if suffix == "_WERT":
                            r["lookup"] = {"table": sib["table"],
                                           "keyColumn": sib.get("keyColumn"),
                                           "scaleColumn": "MUL_WORD",
                                           "offsetColumn": "ADD"}

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

    # NOT adopted: the interpreter's numeric constants.
    #
    # They look like free coverage -- `move L0, #$0` / `ergi "ID_OBD2", I0`
    # really does mean this ECU has no OBD2, and on BMS46's IDENT 8 of them
    # check out against the engine exactly. But the value harness rejected
    # the change: MS450's AIF_ANZ_DATEN came out 0 where the engine says 31,
    # because that field is computed from the AIF block's structure and the
    # interpreter had simply failed to track it, leaving the initialiser
    # behind. A "constant" is indistinguishable from an untracked value that
    # happens to still hold its initialiser, so adopting them trades honest
    # gaps for silent wrong answers. `_consts` stays available for callers
    # that want to inspect it; the spec does not claim it.
    # `a2fix` parses an ASCII string into a number: the response bytes are
    # DIGIT CHARACTERS, not a binary value, so a range lifted for them decodes
    # to nonsense (BMS46's ID_HW_NR read "05" as 0x0405 = 1029 where the
    # engine reports 0). Flagged rather than silently kept -- the offsets are
    # right, the interpretation is not.
    # `a2fix L0, S4` writes L0, but the erg* reads I0 -- a NARROWER VIEW of the
    # same storage (see best2_abstract._overlaps), so matching the register
    # name alone never fires. Expand to every view that shares those bytes.
    a2fix_dst = set()
    for _, n, args in ops:
        # `a2flt F0,"-48"` converts a CONSTANT, not response bytes -- it is
        # how a scale or offset is loaded. Only converting a value read from
        # the wire makes a result ASCII-parsed; without this test the coolant
        # temperature was flagged ascii and decoded as digit characters
        # (0x1F, 0x27 hold none, so 0) instead of scaled to -24.6356425.
        if n in ("a2fix", "a2flt") and args and "r" in args[0] \
                and not (len(args) > 1 and "s" in args[1]):
            a2fix_dst |= BA._overlaps(args[0]["r"])
    if a2fix_dst:
        for _, n, args in ops:
            if n in ERG_TYPE and args and "s" in args[0] and len(args) > 1 \
                    and args[1].get("r") in a2fix_dst:
                for r in results:
                    if r["name"] == args[0]["s"] and r.get("bytes"):
                        r["ascii"] = True

    for r in results:
        r.pop("_srcReg", None)

    if gaps:
        spec["gaps"] = gaps
    return spec


def job_addr(data, jobs, want):
    return next((a for n, a in jobs if n.upper() == want.upper()), None)


def load(sgbd):
    # .grp GROUP files are the same container as .prg -- same XOR 0xF7
    # stream, same job table at *0x88, same 0x44-byte entries. They are how
    # EDIABAS resolves "which variant is this ECU?": the group runs an
    # identification job and picks a concrete variant SGBD from the answer.
    # Loading only .prg meant variant detection had no code to run at all.
    # Resolution (case-insensitive, .prg before .grp, one cached directory
    # scan) is shared with the survey: see sgbd_survey.sgbd_path.
    path = S.sgbd_path(sgbd)
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
