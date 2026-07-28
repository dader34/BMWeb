# MS45.1 — the hand-wired layer (reference only)

Before the .IPO decompiler existed, MS450's screens were wired by hand: each
one read off INPA, transcribed, and checked against a real car. That work is
kept here. **Nothing in this directory drives the app.** Every ECU, MS450
included, is now drawn by the interpreter from `data/inpa-ir/<ECU>.json`.

## What is here

| file | what it is |
|---|---|
| `MS450.layout.json` | the hand-wired layout, as the app consumed it |
| `MS450.enriched.json` | the same, plus SGBD-derived fields (`ipo_enrich`) |
| `tools/ms45_*.py` | the eleven generators that produced it |

Each `ms45_*.py` wrote one section of `MS450.json` — identity, AIF, coding,
adaption, service, system checks, action menus, the menu tree, grid screens
and the screens the miner missed.

## Why it is kept

It is the decompiler's **ground truth**. Two guards read it and fail if a
change to the decompiler loses anything a human verified against INPA:

- `tools/test_disasm.py` — every result key in `MS450.layout.json` must still
  be recalled from `MS450.IPO` (currently 19/19).
- `tools/test_ipo_recognize.py` — recall and no-invented-fields against
  `MS450.enriched.json`, including which fields are SGBD-only and so
  legitimately absent from the .IPO.

That is the whole reason this survives: it is the only artifact in the repo
where a person confirmed, screen by screen, what INPA actually shows.

## Why it stopped driving the UI

MS450 was the one ECU with a hand-built layout, and the layout outranked the
interpreter wherever both existed. So the single ECU whose INPA screens were
best understood was the only one **not** exercising the generic path — its
interpreter bugs stayed hidden behind the curated file. Removing the
exemption surfaced them (dispatch, gauge bounds, bar captions) and they were
fixed generically, which fixed the other 450-odd ECUs at the same time.

## If you need to regenerate

The scripts import from `tools/` and write to `data/inpa-layouts/MS450.json`.
They are unmodified, so they still run from the repo root — but the app no
longer reads that file, so the output is for comparison only.
