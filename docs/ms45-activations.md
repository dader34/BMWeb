# MS45 (ms450ds0) actuator test arguments

Derived from INPA `.ips` sources (msd85l6, med17_2, tvm_01) cross-referenced to
the MS45 SGBD job list, and verified on the car where noted.

## Argument kinds

- **percent**, PWM duty 0–99 sent as a value. Full ≈ 99 (reads back ~98% via
  the paired `STATUS_*` job). MS45 takes a bare value; newer DMEs (MED17) use the
  `;<pct>;<dur>` string form (e.g. `;100;15`).
- **binary**, `1` = on, `0` = off.
- **none**, momentary, no argument (one-shot).

## Stop

The ECU rejects `STEUERN_X_ENDE` in an active session
(`CONDITIONS_NOT_CORRECT`). Commanding the output to **`0`** reliably
de-energizes (verified: fuel pump audibly stops; e-fan stopped with engine
running). Our app stops via `arg=0`, `_ENDE` only as fallback.

## Verified / mapped jobs

| Job | Kind | On value | INPA arg seen | Notes |
|---|---|---|---|---|
| STEUERN_E_LUEFTER | percent | 99 | `;100;15`, `;55;15` | ✅ verified, 99→98% readback |
| STEUERN_TEV | percent | 90 | `;`, `;50;`, `;90;` | purge valve |
| STEUERN_SLP | percent | 99 |, | secondary air pump |
| STEUERN_EKP | value | 3 | `0`, `3`, `99.6` | fuel pump; INPA uses 3 |
| STEUERN_KOREL / EBL / AGK | binary | 1 | `0`, `1` | |
| STEUERN_DMTL_P / _V / _H | binary | 1 | `0`, `1` | tank leak module |
| STEUERN_GLF | binary | 1 | `0`,`1`,`1;2`,`1;20` | |
| STEUERN_MIL | binary | 1 | `0`,`1`,`2` | check-engine lamp |
| STEUERN_EV_1..6 | binary | 1 |, | injector pulse |
| STEUERN_LSVK1H/2H, LSHK1H/2H | binary | 1 |, | O2 sensor heaters |
| STEUERN_STA | binary | 1 |, | starter relay |
| STEUERN_PM_HISTOGRAM_RESET | none |, | (no-arg) | momentary |
| STEUERN_BATTERIETAUSCH_REGISTRIEREN | none |, | (no-arg) | momentary |

Jobs not found in any `.ips` (SYNC_MODE, LL_ABGLEICH, CO_ABGLEICH*, VANOS_IN/EX,
VIMDISA, FGRL, KVA, LL_STELLER) default to **binary on=1**, safer than sending
a percent to a relay. Refine individually if a specific test misbehaves.

## STEUERN_SYNC_MODE — immobilizer sync, NOT an actuator test

Confirmed from the MS45 INPA frontend (`MS450.IPO` strings): the sync menu is
`EWS-Startwertabgleich` (Shift+F6, E46) / `CAS-Startwertabgleich` (Shift+F7,
E6x/E65), with `F1 Startwert zurücksetzen` (reset DME+EWS/CAS to start value)
and `F2 Startwert programmieren`. The command string is *"Anforderung an SG zum
Startwertabgleich"*. The `MODE` int argument selects the operation.

So `STEUERN_SYNC_MODE` drives the **DME↔EWS/CAS rolling-code handshake** (the
`Startwertinitialisierung` the `_RESULTS` comment refers to) — the immobilizer
marriage step done after a virginized/swapped DME. Running the wrong `MODE`
can desync the DME from the immobilizer and leave the car unable to start.

App handling: labeled "EWS/CAS sync (immobilizer)", marked `critical`, and
shown a security-specific confirmation (not the generic actuator-test dialog).
`EWS_STARTWERT` / `DME_STARTWERT_ABGLEICH` are the related standalone jobs.
