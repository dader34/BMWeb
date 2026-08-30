#!/usr/bin/env python3
"""Dump the DERIVED executable form of an .IPO for the JS interpreter.

This is the .IPO equivalent of sgbd_code.py's job-code.json: not the raw
binary, but the decoded token stream ipo_vm.py already builds, serialized to
JSON. ipovm.js loads this and executes it exactly as ipo_vm.py executes the
in-memory VM -- same semantics, different runtime.

    python3 tools/export/ipo_exec.py lsz            -> lsz.ipoexec.json
    python3 tools/export/ipo_exec.py MS450 out.json -> out.json

WHAT SHIPS. {ecu, procs, byid}:
  procs  {name: [token,...]}  the walked, jump-resolved instruction tape.
         Constants are already inlined (t.v), jumps already resolved to byte
         offsets (t.to), so the stream is self-contained -- it runs without any
         constant pool, which is why we DROP vm.pool here: it was carried "for
         completeness" but the interpreter never reads it, and leaving it out is
         ~15% smaller across the corpus (prototype finding).
  byid   {"type:id": name}    procref resolution (menu/screen/state/func ids).

Read-only: builds a VM (offline host) and serializes its decoded procs. No
car is touched.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "decompile"))
import ipo_vm as V                                              # noqa: E402


def export(ecu, budget=50000, vm=None, coding=False):
    """The runnable dump for one ECU. Pass `vm` to reuse an already-built VM.

    build_ir() constructs a V.VM per ECU too; when the IR pipeline calls us it
    threads that same decoded VM through here so the whole file is not
    disassembled a second time per ECU across the corpus.

    coding=True exports an NCS coding dispatcher (A_<cabd>): same runnable
    shape, but the A_ constant pool is decoded and calls are named against the
    CDH host table, so the CDH runtime can execute it.
    """
    if vm is None:
        vm = V.VM(ecu, budget=budget, coding=coding)
    return {
        "ecu": ecu,
        "procs": vm.procs,
        "byid": {f"{k[0]}:{k[1]}": v for k, v in vm.byid.items()},
        "coding": bool(coding),
    }


def main(argv):
    if not argv:
        print(__doc__)
        return 0
    coding = "--coding" in argv
    argv = [a for a in argv if a != "--coding"]
    ecu = argv[0]
    out = argv[1] if len(argv) > 1 else f"{ecu}.ipoexec.json"
    data = export(ecu, coding=coding)
    with open(out, "w") as f:
        json.dump(data, f)
    raw = os.path.getsize(out)
    print(f"{ecu}: {len(data['procs'])} procs, "
          f"{len(data['byid'])} ids -> {out} ({raw} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
