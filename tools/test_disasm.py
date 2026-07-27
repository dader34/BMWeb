#!/usr/bin/env python3
"""Guard: the .IPO decompiler stays correct against ground truth.

Every assertion here was a live failure mode during development:
  - MS450 recall: the hand-verified layout's result keys must all be found
    (s_fehlerbehandlung excluded -- it builds keys at runtime by strcat)
  - GSDS2 s_ana2_834: exactly the seven analog keys, none invented
  - GSDS2 s_code: EXISTS. The old declaration parser missed it and F3 Coding
    was wrongly reported dead for 38 ECUs; zero dead keys may remain unless a
    file genuinely lacks the declaration
  - pool indexing: the MUST_EXX anchor (refs 0x0c3d.. == the two ftextout
    calls of s_status_analog) -- a shifted pool start breaks every string in
    the file, silently
  - corpus floor: decompiled ECUs and keyed fields must not regress
"""
import os
import sys
import json
import glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_disasm as D                                          # noqa: E402
import ipo_screens as L1                                        # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def main():
    failures = []

    # -- MUST_EXX pool anchor ------------------------------------------------
    data = open(os.path.join(L1.SGDAT, "MUST_EXX.IPO"), "rb").read()
    ps, pool = D.find_pool(data)
    a = pool[0x0c3d] if len(pool) > 0x0c47 else None
    if a != ("s", "Read analog status"):
        failures.append(f"MUST_EXX pool anchor broken: pool[0x0c3d]={a}")
    print(f"  pool       MUST_EXX anchored at {ps}, "
          f"pool[0x0c3d]={a and a[1]!r}")

    # -- MS450 ground truth --------------------------------------------------
    hand = json.load(open(os.path.join(ROOT, "data/inpa-layouts/MS450.json")))
    r = D.decompile("MS450")
    hit = miss = 0
    missed = []
    for h in hand["screens"]:
        proc = h.get("proc")
        if not proc or proc == "s_fehlerbehandlung":
            continue
        d = r["screens"].get(proc)
        if d is None:
            continue
        dk = {f["key"] for f in d["fields"] if f.get("key")}
        for k in h.get("result_keys") or []:
            if not k:
                continue
            if k in dk:
                hit += 1
            else:
                miss += 1
                missed.append(f"{proc}:{k}")
    if miss:
        failures.append(f"MS450 hand-layout keys missed: {missed[:6]}")
    print(f"  ms450      {hit}/{hit + miss} hand-verified result keys recalled"
          f" (must be all)")

    # -- GSDS2 knowns --------------------------------------------------------
    g = D.decompile("GSDS2")
    ana = {f["key"] for f in g["screens"]["s_ana2_834"]["fields"]}
    want = {"STAT_RADDREHZAHL_VL_WERT", "STAT_RADDREHZAHL_VR_WERT",
            "STAT_RADDREHZAHL_HL_WERT", "STAT_RADDREHZAHL_HR_WERT",
            "STAT_EDS1_WERT", "STAT_EDS5_WERT", "STAT_UBAT_WERT"}
    if ana != want:
        failures.append(f"GSDS2 s_ana2_834 keys drifted: {sorted(ana)}")
    if "s_code" not in g["screens"]:
        failures.append("GSDS2 s_code vanished -- decl parser regressed")
    ck = {f["key"] for f in g["screens"].get("s_code", {}).get("fields", [])}
    print(f"  gsds2      s_ana2_834 {len(ana)}/7 exact, "
          f"s_code {'present' if 's_code' in g['screens'] else 'MISSING'} "
          f"({len(ck)} fields)")

    # -- corpus floor --------------------------------------------------------
    dec_path = os.path.join(ROOT, "data/inpa-screens/_decompiled.json")
    dec = json.load(open(dec_path)) if os.path.exists(dec_path) else {}
    fields = sum(len(s["fields"]) for r2 in dec.values()
                 for s in r2["screens"].values())
    # long proc names: a 30-char cap once hid every longer declaration.
    # AFS_60 declares two that INPA's own .ini lists, and the fix recovered
    # 59 screens corpus-wide.
    a = D.decompile("AFS_60")
    for want in ("s_afs_fahrgestellnummern_vergleich",
                 "s_afs_motorlagewinkeloffset_lesen"):
        if want not in a["screens"]:
            failures.append(f"long proc name lost: {want}")
    print(f"  longnames  AFS_60 {len(a['screens'])} screens, "
          f"34-char declarations decoded")

    if len(dec) < 500:
        failures.append(f"decompiled corpus shrank: {len(dec)} ECUs (< 500)")
    if fields < 15000:
        failures.append(f"decompiled fields shrank: {fields} (< 15000)")
    print(f"  corpus     {len(dec)} ECUs, {fields} keyed fields "
          f"(floors 500 / 15000)")

    # -- statusMenu pages carry fields ---------------------------------------
    gen = glob.glob(os.path.join(ROOT, "data/inpa-layouts/generated/*.json"))
    with_fields = 0
    for p in gen:
        try:
            lay = json.load(open(p))
        except Exception:                   # noqa: BLE001
            continue
        sm = lay.get("statusMenu")
        if sm and any(it.get("fields") for it in sm.get("items", [])):
            with_fields += 1
    if with_fields < 100:
        failures.append(f"statusMenu pages with fields: {with_fields} (< 100)")
    print(f"  pages      {with_fields} layouts have per-page fields")

    if failures:
        print("\nFAIL")
        for f in failures:
            print("   -", f)
        return 1
    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
