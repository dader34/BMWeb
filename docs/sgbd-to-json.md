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

## Where this leaves the plan

The conversion is viable and the shape of the work is known. The next step is
not more classification — it is to write the spec format against ~10 jobs and
build the differential harness: run each job through real EdiabasLib and
through the spec walker, diff the result sets, and only ship a job as JSON once
they agree. Same method that got the .IPO decompiler to zero mismatches.

Sequencing note: the `.prg` files stay in the app until their jobs are
converted, so this retires the 443 MB `vendor/EDIABAS/Ecu` tree gradually, per
ECU. The `.IPO` tree (162 MB) has no such dependency and can go as soon as
`InpaConfig`'s navigation lookup is pre-baked to JSON.

    python3 tools/sgbd_survey.py                       # the table above
    python3 tools/sgbd_survey.py --dump ms450ds0 IDENT # disassemble one job
    python3 tools/sgbd_survey.py --all                 # whole vendor corpus
