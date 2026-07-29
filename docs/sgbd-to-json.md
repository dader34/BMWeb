# Jobs to JSON: survey findings

Can the SGBDs become our own data the way the .IPOs did — so the app ships a
JSON description of each ECU instead of BMW's compiled `.prg`, and the runtime
shrinks to protocol drivers plus a spec walker?

This is the survey pass. `tools/sgbd_survey.py` disassembles the compiled BEST2
bytecode of every job and classifies what the code *does*.

## Answer

**90% of the jobs the app actually runs are declarative-shaped.** The 10% that
are not are a short, nameable list — not a diffuse tail.

| | all jobs | IR-referenced |
|---|---|---|
| `fixed_read` — sends, no arguments, straight-line | 471 | 164 |
| `param_read` — job arguments feed the request | 185 | 42 |
| `looped_read` — result loop (the `FS_LESEN` shape) | 1738 | 421 |
| `static` — no bus traffic; computed locally | 138 | 4 |
| `computed` — needs real code | 427 | 70 |
| **declarative** | **2532 (85.6%)** | **631 (90.0%)** |

55 E46 SGBDs, 2959 jobs, of which 701 are referenced by the decompiled INPA UI.
The IR-referenced column is the one that matters: a `.prg` ships dozens of
dev/EOL jobs no product path ever calls.

## What a spec has to express

From hand-decompiling representatives (`--dump <sgbd> <job>`). `STATUS_UBATT`
on MS450 is the whole pattern in one job:

    etag   #$c, "_TEL_AUFTRAG"      request template, tagged
    xsend  S3, S2                   send S2, response into S3
    move   A2, #$3                  response[3] is the length byte
    and    I2, #$ff
    comp   I5, I4                   length check ->
    ergs   "JOB_STATUS", "ERROR_ECU_INCORRECT_LEN"
    tabset "JobResult"              status table lookup
    tabseek "SB", S1
    tabget S1, "STATUS_TEXT"
    move   S1, "3,97116E-4"         the scale factor, as a string constant
    a2flt  F3, S1
    fmul   F2, F3                   value = raw * 3.97116e-4
    ergr   "STAT_UBATT_WERT", F0
    ergs   "STAT_UBATT_EINH", "V"   the unit, a literal

So the spec needs: a **request template** (bytes, with argument substitution),
**response validation** (length/echo/status-byte checks, and the table lookup
that turns a status byte into `JOB_STATUS` text), **field extraction**
(`{offset, mask, width, signed}`), **scaling** (`a*x+b`), **literals** (units),
and **tables** (fault text, enumerations). Plus one control construct — a
`repeat` for `looped_read`, which is how every fault-memory and multi-block
read is built.

Nothing exotic. Every one of those is data.

## The 10% that needs code

Three named shapes, all in the `computed` bucket:

- **BCD/nibble unpacking** — `AIF_LESEN` on every DME (117 data-dependent
  loop-math ops on MS420/430/BMS46), `FGNR_LESEN` on EWS (the VIN mill).
  Register-to-register arithmetic in a loop, digit by digit.
- **Polynomial linearization** — the temperature jobs (`STATUS_MOTORTEMPERATUR`,
  `STATUS_OEL_TEMPERATUR`, `STATUS_AN_LUFTTEMPERATUR` on MS420: ~85 float ops
  each). Beyond `a*x+b`.
- **Command sequences** — `gs30:STEUERN_HOCHSCHALTEN` / `RUNTERSCHALTEN`,
  which drive a shift through several dependent steps.

These are a handful of *kinds*, repeated across ECUs — so they're a handful of
hand-written handlers, not 70 unique problems. (A BCD decoder written once
serves every `AIF_LESEN`.)

## Method note: the two heuristics that were wrong

Recorded because both produced confident, wrong numbers first.

1. **Jump targets are PC-relative and signed** (`EdiabasNet`: `labelAddress =
   pcCounter_after_operands + arg0`). Read as absolute, every backward branch
   looked like a jump into shared code far below the job, no loop was ever
   detected, and the survey reported **100% declarative**.

2. **`and A0, #$c0` is a bit-field, not computation.** Every DS2 job masks the
   response header that way. Counting literal-operand bit/int ops as
   complexity put 36% of jobs in "needs code", with `VIN_SMC_LESEN` flagged as
   a "crypto loop" for masking a header byte. Counting only *data-dependent*
   math (both operands registers) *inside a loop* gives 9-10%, and every job in
   it is nameable — which is the sanity check that the metric measures
   something real.

## The extractor and the harness

`tools/sgbd_spec.py` lifts a job into the spec format above;
`tools/sgbd_diff.py` checks each lifted spec against the engine's own
`_RESULTS` schema, which the engine answers offline with no cable attached.

**698/701 IR-referenced jobs across the 55 E46 SGBDs lift their result names
exactly, and no spec carries a duplicate or invented result.** The other three
are BMBT46's `STATUS_LESEN_SG` variants, for which BMW shipped no `_RESULTS`
schema at all — there is nothing to compare against, and the lifted spec (14
results, read from the bytecode) is strictly more informative than the
engine's own metadata.

Those three are also where the *shape* problems surfaced, which the schema
check could not see because it compares name SETS:

- **Repeated stores of one name are branches, not results.** A string result
  written once per state (`CASSETTEN_STATUS_TEXT`: "Wiedergabe" / "Eject,
  Standby, …" / "undefinierter Tastenstatus") is an ENUMERATION — one result
  whose `values` list the alternatives. 61 such results across the corpus.
  Numeric results written from several branches (per-variant scaling) collapse
  the same way, keeping `altScales`.
- **Register bindings go stale.** Tracking literals staged through registers
  (`move S1, "V"` → `ergs "X_EINH", S1`) is necessary, but a register later
  loaded from another register holds computed data. Without dropping the
  binding there, BMBT46's cassette-deck HOUR COUNTER inherited the string
  "undefinierter Tastenstatus" from an earlier branch.
- **`_ANTWORT1` is not always internal.** Filtering bare telegram-looking
  names cost 8 jobs their agreement: ASCMK20, LSZ and CVM_II declare
  `_AUFTRAG1` / `_ANTWORT` as genuine results. What a job publishes is the
  SGBD's decision, not a naming convention to infer.

Getting to that number surfaced four things worth keeping:

- **`etag` gates conditional results.** `etag #$c, "NAME"` asks whether the
  caller requested NAME and computes it only if so. RDC's `STATUS_IO`
  produces `STAT_FOLGAUS` *only* through that path, with no `erg*` naming it.
- **Units are results, not attributes.** The engine emits `STAT_UBATT_EINH`
  beside `STAT_UBATT_WERT`. Folding the unit into a `unit` field made a
  tidier spec that produced the wrong result set — so the spec carries both.
- **A command job with no results is a match, not a failure.** 207 of the 701
  (every `STEUERN_X_ENDE`, `FS_LOESCHEN`) declare no results, and a spec that
  lifts none agrees with the engine exactly.
- **One SGBD bug, recorded rather than corrected.** `ekp_ds2:STATUS_MESSWERTE`
  gates `STAT_TEMP_UEBER_*_WERT` but stores to `STAT_UEBER_TEMP_*_WERT` — BMW
  transposed the words, so those two values never reach any caller. The spec
  marks them `deadStore`. The spec reproduces the engine bug for bug; that is
  the whole contract.

## Response-byte offsets

Scale and unit were lifted first; the offsets a walker needs to know WHICH
bytes to scale came second, and they are never immediates in the read
instruction. Three shapes carry them, all now lifted:

    move L0, #$a / atsp L1 / move A0, S1[L1]   staged index  (numeric fields)
    move S5, S1[L0]#L1                         range read    (strings)
    y2bcd S4, S1[L0]#L1                        range + convert (BCD/hex)
    move I0, S0[#$6]                           direct index  (simple fields)

62.5% of value results (2672/4272) now carry offsets, verified end to end:
MS450's battery voltage and both RPM values decode bit-identically to the
engine. Constraints that only surfaced by getting a wrong answer first:

- offsets are **payload-relative**, not frame-relative (12.00 V vs 1.87 V)
- reads count only against the register `xsend` names, plus its aliases --
  including `move S4, S3[A2]#I2`, which slices the payload out of the raw
  telegram. `S0` is scratch: counting `move I0, S0[#$0]` as a response read
  appended a phantom byte and turned 1000 rpm into 256024.5
- `etag` delimits one result's code from the next, or the RPM setpoint
  inherits the preceding result's offsets

## The abstract interpreter

`tools/best2_abstract.py` follows the dataflow the direct lifter cannot see:
the operand stack, registers, `S0` scratch slots, and integer arithmetic over
abstract values (a concrete int, a `Byte(offset)` symbol, a `Sum`, or
UNKNOWN). A response read produces a symbol rather than a number, so byte
provenance survives every intermediate step.

It is trustworthy because it **independently reproduces the direct lifter's
answers** on the value-verified jobs -- `STATUS_UBATT` → bytes [2,3],
`STATUS_MOTORDREHZAHL` → [10,11] and [12,13] -- by a completely different
route. Used as a fallback, it resolves 200 results the direct lifter missed,
taking offset coverage to **67.2%** (2872/4272).

Two facts about the machine had to be modelled correctly, and each was a dead
end until it was:

- **B/I/L registers are views over one shared byte array** (`EdiabasNet
  Register.GetValueData`): `B0` is byte 0, `I0` bytes 0-1, `L0` bytes 0-3.
  Every single-byte response read is `clear L0` then `move B0, S1[L1]`, and
  the following `push L0` expects to see that byte. Treating them as
  independent registers made every such read a dead end. (The register table
  was also mis-named: indices 0-15 are `B0..BF`, only 16+ are `A0..AF`.)
- **Float ops preserve provenance.** `fmul F2, F3` applies a scale; the number
  changes but the bytes it came from do not, and provenance is all the
  interpreter is asked for. Poisoning the symbol with the unknown constant
  lost every scaled result.

## Loops are real, and now described

`STATUS_MESSWERTBLOCK_0` is not unrolled. It ends in a jump table (`comp L0,
#$10 / jz ...` sixteen times) whose targets are the sixteen emit sites, and
the tail jumps *back* into the body: one shared block executed once per
measurement. `S0[4]` is a byte cursor, advanced each pass by `S0[8]`, with
`S0[2]` counting iterations.

`detect_loop` lifts that as `repeat: {cursorSlot, strideSlot, counterSlot}` --
21 jobs across the E46 set carry one. The stride is deliberately NOT a
constant: the ECU declares the record width in its response, so the spec names
the slot that carries it rather than baking in a number that would be wrong
for the next car.

## Tables: results that are looked up, not extracted

A large class of results never comes out of the response at all. MS450's
measurement blocks read a measurement NUMBER from the ECU, seek it in the
SGBD's own `FUmweltTexte` table, and take everything else from that row:

    tabset  "FUmweltTexte"
    tabseek "UWNR", <n>          the measurement number from the response
    tabget  S7, "UWTEXT"         the label
    tabget  S6, "MUL_WORD"       the SCALE
    tabget  S6, "ADD"            the OFFSET
    tabget  S6, "UW_EINH"        the unit

That is why no float literal was ever found for these and every one looked
unresolvable: the scale is per-measurement data, not a constant in the
bytecode. The spec records the lookup (`table`, `keyColumn`, `valueColumn`);
the table travels with the SGBD and the engine already serves it at
`/api/ecu/<sgbd>/table/<name>`.

The second table shape is the bit flag. A digital-status job reads one byte
and tests a bit in it, with the mask AND the expected value coming from a
table row (`tabget S1,"MASK"` / `tabget S1,"VALUE"`, then `and` + `xor`).
BMS46's `STATUS_DIGITAL` builds `STAT_KL15_EIN` and its neighbours that way --
288 results across the E46 set, recorded as `bitTest`.

Both needed the binding tracked at the point the result is STORED. Keeping
only the last `tabset` attributed every measurement label to `JobResult` /
`STATUS_TEXT`, the protocol status table, instead of `FUmweltTexte` / `UWTEXT`
-- a wrong answer that still looked structurally right.

**Resolution now stands at 87.1% (3720/4272): 2872 by byte offset, 560 by
table lookup, 288 by bit test.**

## Two lifters, cross-checked

The direct lifter and the abstract interpreter reach results by completely
different routes, so where both resolve one they are a check on each other.
Run across five SGBDs they **agree 514 times and differ 91** — and every
single difference is the same bug, in the direct lifter: it accumulates
offsets as it walks and clears them at `etag` boundaries, so bytes read
*between* those boundaries (validation reads, length checks, a preceding
branch) ride along into the next result. SMG2's one-byte
`FLASH_LOESCHEN_STATUS` came out as `[4,5,6,7,8]`; the interpreter said `[8]`,
and the disassembly shows a single `move B0, S1[L1]`.

The interpreter now wins those disputes — 287 offsets corrected across the E46
set — with one exception it would otherwise get wrong: a genuine substring
(MS450's 9-byte `SERIENNUMMER`) legitimately spans a contiguous range, and
there the interpreter reports only the first byte. That case is detected and
the range kept.

This is the value of having built two independent lifters rather than one:
neither is trusted because it looks right, and the disagreements are where the
bugs were.

## Can this reach 100%?

**Not by lifting alone, and the ceiling is a property of the ECUs rather than
of the tooling.** Resolution stands at **91.6% (3910/4267)**. The remaining
357 sort into three groups, and only the last is a wall:

1. ~~Tractable with more interpreter work (~150)~~ — **done, and the diagnosis
   was wrong.** SMG2's `ADAPTIONSWERTE_LESEN` was never a loop: it has **no
   backward branch at all**, and simply re-fills the same scratch slot before
   each of its 112 results. What actually blocked it was the sign-extension
   idiom that follows nearly every signed read:

       move B0, S0[#$2]      ; the value
       jpl  L...             ; skip if positive
       move I1, #$ffff       ; ONLY on negative: extend the sign
       move B1, #$ff

   A linear walk executes both sides of that branch, so the value was
   overwritten with 0xFF on the way past — every affected result resolved to
   255. Skipping short forward conditional bodies (≤32 bytes; longer jumps are
   ordinary control flow whose targets hold the result stores) fixed it: SMG2
   went from 44 to 98 results resolved, and `KORR_SW_EVEN_WERT` now reports
   byte 9, matching the disassembly by hand.

   The same investigation showed `detect_loop` was claiming loops for two jobs
   with no backward branch, inventing a cursor and stride for straight-line
   code. It now requires the branch as evidence.

2. **The named handler shapes (~200).** The `computed` archetype from the
   original survey: BCD/nibble unpacking (`AIF_LESEN` on every DME,
   `FGNR_LESEN`'s VIN mill), polynomial linearization (the MS420 temperature
   jobs), and multi-step command sequences. These are not extraction at all --
   they are computation, and a spec format that could express them would be a
   programming language, i.e. the BEST2 interpreter we are trying to retire.
   The answer is a handful of named handlers, written once and reused: one BCD
   decoder serves every `AIF_LESEN`.

3. **Genuinely dynamic (~80).** `param_read` jobs whose response layout
   depends on the argument the caller passes. There is no static offset to
   lift because there is no static answer; the spec would have to express the
   offset as a function of the request. Expressible, but it is a spec-format
   extension rather than a lifting improvement.

So: ~93% is reachable by finishing the interpreter, and the last ~7% is
handlers plus a spec-format extension. **100% "by lifting" is not the right
goal** -- the honest target is that every job either lifts completely or is
explicitly marked as needing a named handler, with nothing silently partial.
The value-level harness is what enforces that distinction, since a spec that
lifts the wrong bytes fails there rather than looking plausible.

## What the remaining 8.4% needs

The 552 still unresolved are concentrated in `computed`-archetype jobs (the
named handler shapes: BCD unpacking, polynomial linearization, command
sequences) and in `param_read` jobs whose response layout depends on the
argument the caller passes -- so the offset genuinely is not static, and the
spec must express it as a function of the request rather than a number.

## Where this leaves the plan

Schema agreement is necessary but not sufficient: it proves the spec knows
*which* results a job produces, not that it decodes the bytes to the same
*values*. That is the next step, and it needs response bytes — either a car or
a `.sim` file (EdiabasLib supports `SimulationPath` with REQUEST/RESPONSE
sections, and the engine already exposes the raw telegrams as `_TEL_AUFTRAG` /
`_TEL_ANTWORT`, so captures can be recorded from a real session and replayed).
Feed identical bytes to the engine and to a spec walker, diff the decoded
values, and only then mark a spec `verified`.

Then the loop bounds for `looped_read` (currently an explicit gap in every such
spec) and handlers for the named `computed` shapes.

Sequencing note: the `.prg` files stay in the app until their jobs are
converted, so this retires the 443 MB `vendor/EDIABAS/Ecu` tree gradually, per
ECU. The `.IPO` tree (162 MB) has no such dependency and can go as soon as
`InpaConfig`'s navigation lookup is pre-baked to JSON.

    python3 tools/sgbd_survey.py                       # the table above
    python3 tools/sgbd_survey.py --dump ms450ds0 IDENT # disassemble one job
    python3 tools/sgbd_survey.py --all                 # whole vendor corpus
