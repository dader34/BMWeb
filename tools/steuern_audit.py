#!/usr/bin/env python3
"""Audit STEUERN_ actuator labels against the INPA IPO frontends.

For every STEUERN_<X> job referenced in an .IPO, find the nearest descriptive
German string the frontend attaches to it (the ftextout/ergebnisText label near
its STAT_AUSGANG). Then translate the current token-table label and flag where
the two disagree — those are the guessed/wrong entries.
"""
import re, glob, sys, subprocess, os
from collections import defaultdict

REPO = "/Users/dannerbaumgartner/Development/code/projects/inpa-mac-bridge"
SGDAT = os.path.join(REPO, "vendor/EC-APPS/INPA/SGDAT")

# a string that looks like a human label (has letters, spaces or German, not a
# code token, not a job name)
def is_label(s):
    if len(s) < 4 or len(s) > 60: return False
    if re.match(r'^[A-Z0-9_]+$', s): return False          # code token
    if s.startswith(('STEUERN','STATUS','STAT_','JOB','_TEL','ergebnis')): return False
    if not re.search(r'[A-Za-zÄÖÜäöü]', s): return False
    if not re.search(r'[a-zäöü ]', s): return False        # needs lowercase/space
    return True

# nearest label to a STEUERN_ job within a small window of printable strings
def ipo_labels(path):
    data = open(path,'rb').read().decode('iso-8859-1', errors='replace')
    strs = re.findall(r'[\x20-\x7e\xa0-\xff]{3,}', data)
    out = {}
    for i, s in enumerate(strs):
        m = re.fullmatch(r'STEUERN_([A-Z0-9_]+?)(?:_ENDE)?', s)
        if not m: continue
        job = 'STEUERN_' + m.group(1)
        # scan a window after the job for a STAT_AUSGANG-adjacent label
        for j in range(i+1, min(len(strs), i+8)):
            if is_label(strs[j]):
                out.setdefault(job, strs[j].strip())
                break
    return out

def main():
    all_labels = defaultdict(set)
    for ipo in glob.glob(os.path.join(SGDAT, "*.IPO")) + glob.glob(os.path.join(SGDAT, "*.ipo")):
        for job, lab in ipo_labels(ipo).items():
            all_labels[job].add(lab)
    # load current token table
    tsv = {}
    for f in glob.glob(os.path.join(REPO, "tools/translations/*_tokens.tsv")):
        for line in open(f, encoding='utf-8'):
            if '\t' in line:
                k,v = line.rstrip('\n').split('\t',1); tsv[k.upper()] = v

    print(f"{len(all_labels)} STEUERN jobs found labeled in IPOs\n")
    # for each job, show the IPO label(s) + how our token table would render it
    rows = []
    for job in sorted(all_labels):
        stub = job[len('STEUERN_'):]
        # our token-based render: first token
        toks = stub.split('_')
        our = ' '.join(tsv.get(t.upper(), t.title()) for t in toks)
        ipo = ' / '.join(sorted(all_labels[job]))
        rows.append((job, our, ipo))
    for job, our, ipo in rows:
        print(f"{job}")
        print(f"    ours: {our}")
        print(f"    IPO : {ipo}")
    # focused: single-token STEUERN_X where we have a token entry (KFK/SLP class)
    print("\n=== SINGLE-TOKEN actuators with a token-table entry (audit these) ===")
    for job in sorted(all_labels):
        stub = job[len('STEUERN_'):]
        if '_' in stub: continue
        if stub.upper() in tsv:
            print(f"  {stub:<10} table='{tsv[stub.upper()]}'   IPO='{' / '.join(sorted(all_labels[job]))}'")

if __name__ == '__main__':
    main()
