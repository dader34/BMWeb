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

## What the remaining 37.5% needs

The 1372 results without offsets are NOT another read shape. Tracing
`ms450ds0:STATUS_MESSWERTBLOCK_0` -- 48 of them in one job -- the values are
emitted as `ergr "STAT_MESSWERT0_WERT", F0`, where `F0` was computed further
up from a scratch slot (`S0[#$a]`) that was itself filled through the operand
stack. The 16 measurement blocks are fully unrolled (16 distinct emit sites at
a uniform 297-byte stride), so nothing is hidden behind a runtime loop -- the
byte source is simply several dataflow steps removed from the store.

Reaching them means a small abstract interpreter over the operand stack:
model push/pop/atsp plus integer arithmetic on known constants, and resolve
`S0` slots to the response bytes that fed them. A prototype resolved 18 of 26
slot writes in that job, but attributed request-phase constants to them, so it
needs the same send-boundary discipline the direct lifter already has. That is
the next piece of work rather than a variation on this one.

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
