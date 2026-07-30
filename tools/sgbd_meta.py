#!/usr/bin/env python3
"""Export an SGBD's DESCRIPTION block -- job list, arguments, results, texts.

The app can already draw its screens from our own IR and decode job responses
with our own VM, but it still asked BMW's engine three questions: what jobs
does this ECU have, what arguments do they take, and what results do they
declare. Those come from the engine's _JOBS/_ARGUMENTS/_RESULTS virtual jobs,
which is the last reason an offline ECU browse needs the 443 MB Ecu tree.

They are not computed. Every .prg carries a plain description block, and
EdiabasNet.ReadDescriptions reads it like this:

    offset 0x90 -> Int32 pointer to the block
    block       -> Int32 byte count, then that many XOR-0xF7 bytes
    contents    -> newline-separated "KEY:value" lines, and a line
                   "JOBNAME:X" starts the section belonging to job X.
                   Lines before the first JOBNAME are the ECU's own
                   (ECU, ORIGIN, REVISION, AUTHOR, ECUCOMMENT).

Within a job section the keys repeat per item, so order matters: a RESULT
line opens a result and the RESULTTYPE/RESULTCOMMENT lines after it belong
to that result, until the next RESULT. Same shape for ARGUMENT.

    python3 tools/sgbd_meta.py ms450ds0        # summarise one
    python3 tools/sgbd_meta.py --all           # -> data/job-meta/
"""
import os
import sys
import json
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sgbd_survey as S                                       # noqa: E402
import sgbd_spec as SP                                        # noqa: E402

ROOT = os.path.join(HERE, "..")
OUT_DIR = os.path.join(ROOT, "data", "job-meta")

# Keys that open a new item within a job section. Anything following one
# belongs to it until the next opener of the same kind.
# The block spells arguments ARG/ARGTYPE/ARGCOMMENT, not ARGUMENT* -- reading
# the engine's C# names into the file format cost every argument on the first
# pass (127 of them in MS450 alone, silently zero).
OPEN_RESULT = "RESULT"
OPEN_ARG = "ARG"


def read_descriptions(data):
    """[(key, value)] for the whole description block, in file order."""
    if len(data) < 0x94:
        return []
    (off,) = struct.unpack_from("<i", data, 0x90)
    if off <= 0 or off + 4 > len(data):
        return []
    (n,) = struct.unpack_from("<i", data, off)
    if n <= 0 or off + 4 + n > len(data):
        return []
    body = bytes(b ^ 0xF7 for b in data[off + 4:off + 4 + n])
    out = []
    for raw in body.split(b"\n"):
        if not raw:
            continue
        text = raw.decode("cp1252", "replace")
        k, sep, v = text.partition(":")
        if not sep:
            continue
        out.append((k.strip().upper(), v))
    return out


def parse(data):
    """{ecu: {...}, jobs: {NAME: {comments, arguments, results}}}."""
    lines = read_descriptions(data)
    ecu = {}
    jobs = {}
    cur = None                       # current job dict
    item = None                      # current result/argument dict
    kind = None                      # 'results' | 'arguments'
    for key, val in lines:
        if key == "JOBNAME":
            name = val.strip()
            cur = jobs.setdefault(name.upper(), {
                "name": name, "comments": [], "arguments": [], "results": []})
            item, kind = None, None
            continue
        if cur is None:
            # the ECU header, before any JOBNAME
            ecu.setdefault(key, val)
            continue
        if key == "JOBCOMMENT":
            cur["comments"].append(val)
        elif key == OPEN_RESULT:
            item = {"name": val.strip()}
            kind = "results"
            cur["results"].append(item)
        elif key == OPEN_ARG:
            item = {"name": val.strip()}
            kind = "arguments"
            cur["arguments"].append(item)
        elif item is not None and key.startswith(("RESULT", "ARG")):
            # RESULTTYPE / RESULTCOMMENT / ARGTYPE / ARGCOMMENT. A COMMENT
            # repeats -- one line per sentence, and the SGBD convention
            # "table NAME VALUECOL TEXTCOL" arrives as its own line naming the
            # table an argument's legal values come from. The engine exposes
            # those as ARGCOMMENT0/1/2..., and the renderer matches on that
            # numbering to find the table reference, so the repeats are kept
            # as a LIST rather than joined into one string.
            field = key.replace(OPEN_RESULT, "", 1).replace(OPEN_ARG, "", 1)
            field = (field or "comment").lower()
            if field == "comment":
                item.setdefault("comments", []).append(val)
                # first line doubles as the plain summary
                item.setdefault("comment", val)
            else:
                item[field] = val
        elif kind is None:
            cur["comments"].append(f"{key}:{val}")
    return {"ecu": ecu, "jobs": jobs}


def export(sgbd, write=True):
    data, _ = SP.load(sgbd)
    meta = parse(data)
    meta["format"] = 1
    meta["sgbd"] = sgbd
    if not meta["jobs"]:
        return None
    nres = sum(len(j["results"]) for j in meta["jobs"].values())
    nargs = sum(len(j["arguments"]) for j in meta["jobs"].values())
    if write:
        os.makedirs(OUT_DIR, exist_ok=True)
        p = os.path.join(OUT_DIR, f"{sgbd}.json")
        with open(p, "w") as f:
            json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
        return (sgbd, len(meta["jobs"]), nres, nargs, os.path.getsize(p))
    return (sgbd, len(meta["jobs"]), nres, nargs, 0)


def main():
    args = [a.lower() for a in sys.argv[1:] if not a.startswith("--")]
    # --all-chassis: every SGBD any shipped ECU names, so an offline browse of
    # a non-E46 car has its job list and result schema too. The description
    # block is read straight from the .prg, so this needs no running app.
    if "--all-chassis" in sys.argv:
        targets = args or S.all_shipped_sgbds()
    else:
        targets = args or S.e46_sgbds()
    tot_j = tot_r = tot_b = 0
    for sgbd in targets:
        try:
            r = export(sgbd)
        except SystemExit:
            continue
        if not r:
            continue
        name, nj, nr, na, size = r
        tot_j += nj
        tot_r += nr
        tot_b += size
        print(f"  {name:12} {nj:4} jobs {nr:5} results {na:4} args "
              f"{size // 1024:5} KB")
    print(f"meta: {tot_j} jobs, {tot_r} results, {tot_b // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
