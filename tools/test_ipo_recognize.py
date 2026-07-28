#!/usr/bin/env python3
"""Regression test: the generic pipeline must keep reproducing MS45.

MS45's screens were decoded by hand, screen by screen, and checked against
INPA's own menus. That makes them the one piece of GROUND TRUTH in the corpus,
so they are the guard rail for every future change to layer 1 or layer 2: widen
a pattern, run this, and see immediately whether the win cost anything.

It asserts three things:

  recall        the recognisers still find the fields we know are in the .IPO
  no invention  they never claim a field the hand-built layout does not have
                (a false positive is worse than a miss — it looks authoritative)
  known gaps    the fields that are NOT in the bytecode stay listed as such,
                so nobody "fixes" a pattern to chase something unreachable

    python3 tools/test_ipo_recognize.py
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_screens as L1                                        # noqa: E402
import ipo_recognize as R                                       # noqa: E402
import ipo_enrich as E                                          # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
HAND = os.path.join(HERE, "..", "reference", "ms45-handwired",
                    "MS450.enriched.json")
IPO = os.path.join(L1.SGDAT, "MS450.IPO")

# Fields the hand-built layout carries that are NOT in MS450.IPO at all — they
# come from the SGBD's job schemas. Verified by searching the raw bytes:
# ID_EWS_SS and ID_SG_ADR never appear; PRUEFCODE/HARDWARE_REFERENZ/
# DATEN_REFERENZ appear only as job names, never as a captioned screen field.
# Layer 2 alone cannot reach these; layer 3 must.
SGBD_ONLY = {"ID_EWS_SS", "ID_SG_ADR", "PRUEFCODE",
             "HARDWARE_REFERENZ", "DATEN_REFERENZ"}

# what layer 2 must reach from bytecode alone
MIN_RECALL = {"identity": 13, "aif": 12}
# what layer 2 + layer 3 together must reach: everything, no exceptions
FULL_RECALL = {"identity": 18, "aif": 12}
SGBD_CACHE = os.path.join(L1.OUT, "_sgbd.json")


def main():
    with open(HAND, encoding="utf-8") as f:
        hand = json.load(f)
    auto = R.recognise(L1.extract(IPO))
    found = {s["screen"]: s for s in auto["screens"]}

    failures = []
    for name, key in (("identity", "identity"), ("aif", "aif")):
        want = {f["key"] for f in hand[key]["fields"]}
        scr = found.get(name)
        if scr is None:
            failures.append(f"{name}: recogniser found nothing")
            continue
        got = {f["key"] for f in scr["fields"]}

        hit = want & got
        if len(hit) < MIN_RECALL[name]:
            failures.append(f"{name}: recall dropped to {len(hit)}, "
                            f"expected >= {MIN_RECALL[name]}")

        # never claim a field the hand-verified layout does not have
        invented = got - want
        if invented:
            failures.append(f"{name}: invented {sorted(invented)}")

        # the unreachable ones must stay unreachable, not silently "found"
        missed = want - got
        if not missed <= SGBD_ONLY:
            failures.append(f"{name}: missing beyond the known SGBD-only set: "
                            f"{sorted(missed - SGBD_ONLY)}")

        print(f"  {name:9} {len(hit)}/{len(want)} recalled, "
              f"{len(invented)} invented, {len(missed)} missing "
              f"({'all known SGBD-only' if missed <= SGBD_ONLY else 'UNEXPECTED'})")

    # reads only: decoded write tables must never be promoted to screens
    if any(s["screen"] in ("adaption", "activations") for s in auto["screens"]):
        failures.append("a write table was emitted as a runnable screen")
    print(f"  writes    {len(auto['writes_unverified'])} table(s) held for "
          f"review, 0 emitted as screens")

    # ---- layer 3: the SGBD join must close the gap completely --------------
    if not os.path.exists(SGBD_CACHE):
        print("\n  layer 3   SKIPPED (no SGBD cache; run tools/sgbd_harvest.py --write)")
    else:
        with open(SGBD_CACHE, encoding="utf-8") as f:
            cache = json.load(f)
        names = {n.lower(): n for n in cache}
        rec = L1.extract(IPO)
        sgbd = E.pair(rec["ecu"], names)
        if sgbd is None:
            failures.append("layer 3: MS450 did not pair with any SGBD")
        else:
            rich = E.enrich(rec, cache[sgbd]["harvested"])
            print()
            for name, key in (("identity", "identity"), ("aif", "aif")):
                scr = next((s for s in rich["screens"]
                            if s["screen"] == name), None)
                if scr is None:
                    failures.append(f"layer 3: {name} vanished after enrich")
                    continue
                want = {f["key"] for f in hand[key]["fields"]}
                got = {f["key"] for f in scr["fields"]}
                miss = want - got
                if len(want & got) < FULL_RECALL[name]:
                    failures.append(
                        f"layer 3 {name}: {len(want & got)}/{len(want)} recalled, "
                        f"expected {FULL_RECALL[name]} — missing {sorted(miss)}")
                # INPA's own fields must keep INPA's label, never the SGBD's
                # German result description
                faithful = [f for f in scr["fields"] if not f.get("extra")]
                by_key = {f["key"]: f for f in hand[key]["fields"]}
                relabelled = [f["key"] for f in faithful
                              if f["key"] in by_key
                              and f["source"] != "sgbd"
                              and f["label"] != by_key[f["key"]]["label"]
                              and f["label"] == f.get("desc")]
                if relabelled:
                    failures.append(f"layer 3 {name}: SGBD text overwrote "
                                    f"INPA's caption on {relabelled}")
                print(f"  layer 3   {name:9} {len(want & got)}/{len(want)} recalled, "
                      f"{len(faithful)} INPA-faithful + "
                      f"{len(scr['fields']) - len(faithful)} extras")

            # the SGBD file's own metadata is not ECU data
            leaked = sorted({f["key"] for s in rich["screens"]
                             for f in s["fields"] if f["key"] in E.FILE_META})
            if leaked:
                failures.append(f"layer 3: SGBD file metadata on a card: {leaked}")
            print(f"  layer 3   file metadata excluded: "
                  f"{rich['stats'].get('dropped file metadata', 0)} field(s)")

    if failures:
        print("\nFAIL")
        for f in failures:
            print(f"   - {f}")
        return 1
    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
