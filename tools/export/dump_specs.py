#!/usr/bin/env python3
"""Dump lifted specs + the Python decoder's output, for the JS walker test.

app/renderer/screens/specwalk.js has to decode exactly like decode_with_spec() in
sgbd_value_diff.py -- that Python function is the one the value harness
verified against the real EDIABAS engine, so if the JS drifts from it, what
ships stops being what was tested.

This emits, for every job of every E46 SGBD: the spec, a synthetic response
frame, and what Python decodes from it. tools/test_specwalk.js replays the
same frames through the JS and diffs.

    python3 tools/dump_specs.py > data/sim-captures/specdump.json
    node tools/test_specwalk.js
"""
import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # tools/, for sibling modules
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import sgbd_spec as SP                                        # noqa: E402
import sgbd_survey as S                                       # noqa: E402
import sgbd_value_diff as V                                   # noqa: E402
import sgbd_bulk_verify as B                                  # noqa: E402


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    targets = [a.lower() for a in args] if args else S.e46_sgbds()
    out = []
    for sgbd in targets:
        try:
            data, jobs = SP.load(sgbd)
        except SystemExit:
            continue
        ir = S.ir_jobs_for(sgbd)
        for name, addr in jobs:
            if name.startswith("_") or name.upper() not in ir:
                continue
            try:
                spec = SP.extract(data, addr, sgbd, name)
            except Exception:                               # noqa: BLE001
                continue
            if not spec.get("results"):
                continue
            # Two frames per job, one per framing, so both offset bases get
            # exercised regardless of what this ECU actually speaks.
            for frame in (V.fast_telegram(0xF1, 0x12, [0x61, 0xF0] + B.PATTERN[:40]),
                          V.ds2_telegram(0x12, [0xA0] + B.PATTERN[:24])):
                try:
                    expected = V.decode_with_spec(spec, frame)
                except Exception:                           # noqa: BLE001
                    continue
                out.append({"sgbd": sgbd, "job": name, "spec": spec,
                            "frame": list(frame),
                            "expected": expected})
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
