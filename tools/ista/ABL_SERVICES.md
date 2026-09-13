# ABL native services: what the app must stand in for

A recovered test module (see `ABL_FORMAT.md`) never talks to the screen, the vehicle or the session directly.
Everything goes through service dialogs and a handful of base-class calls. This file is the contract for each of
them, taken from the decompiled dialog implementations (`BMW.Rheingold.Module.ISTA.*Impl`, ISTA-D 4.15) and the
base class `ISTAModule`. Parameter names are exact; where a value was inferred rather than read it is marked
"(inferred)".

Conventions used below: "in" = the dialog's input container (`params` in the JSON), "out" = the output container
(the keys listed in `reads`), `CollectiveResult` = the module's result register (`Ok` 0, `Verified` 1, `NotOk` 2,
`Unknown` 3, `Repaired` 4, `None` 5).

## 1. Message dialog (`51915403` MessageServiceDlg, `68904586891` Meldung_Neu, module-global `MessageServiceDlg1`)

Inputs

| name | type | meaning |
|---|---|---|
| `txtParam` | text | the message (paragraphs, lists, notes, `{var}` placeholders already substituted by the engine) |
| `WertFeld` | text or null | an extra value line rendered under the message (rarely used) |
| `Quittierung` | bool | true: block until the technician presses Continue |
| `TIMEOUT` | int ms | used only when `Quittierung` is false: > 0 auto-dismiss after that many ms; 0 show and return immediately |
| `Protocol` | bool | journal the message (no behaviour for the app) |
| `Display` | bool | false: do not show at all |

Outputs: `Quit` (bool): true when Continue was pressed while the dialog was up (for the live mode: whether the
technician pressed Continue since the last redraw; the module loops on `!QUIT`).

Behaviour (`MessageServiceDlgImpl.HandleGui`): `WaitForContinueButton(Quittierung ? -1 : TIMEOUT)`; -1 waits
without limit. Method `HideDialog` (on the module-global dialog) removes the live message. A redraw with new
placeholder values is simply another `InitializeDialog` on the same dialog.

App stand-in: one text pane with a Continue button. Wait mode = enable Continue and block. Timed mode = show,
disable Continue, resolve after TIMEOUT ms with `Quit` = false. Live mode = render (or re-render) without blocking,
return `Quit` = true if Continue was pressed since the last call; `hide_message` clears the pane.

## 2. Selection dialog (`13628358027` QuestionSelectServiceDlg_20, `51911691` QuestionSelectServiceDlg, method `InitializeDialog2`)

Inputs: `priorText` (heading), `pastText` (footer), `ButtonCount` (1..6), `ButtonLabel1..6` (short label, usually
"1".."6"), `ButtonText1..6` (option text), `Display`. Optional (library use): `SelektionVorgabe` (int[], pre-selected
buttons), `EndeText`, `AnfangText`, `AnzahlTexte`, `ButtonBeschriftung`, `_priorText`, `_pastText`.

Outputs: `Result` (int) = 1-based index of the pressed button (`QuestionSelectServiceDlgViewModel`: the action index
is `btn.Result - 1`); `SelektionAuswahl` (int[]) = the selection states.

App stand-in: heading, N buttons, footer; return the 1-based index. The module copies it (`SELEKT = out.Result`)
and switches on it.

## 3. Yes/No question (`51878795` QuestionServiceDlg)

Inputs: `txtParam` (text). Outputs: `Result` (int) = 1-based index of the pressed button; the default buttons are
Yes = 1, No = 2 (inferred from `TextInfo[1] = "No"` in `QuestionServiceDlgImpl`).

## 4. ECU job (`51939083` ECUKOMServiceDlg)

Inputs

| name | meaning |
|---|---|
| `/WurzelIn/DSCConfig` | the job descriptor (lifted into the node's `job`, `args`, `results`, `group_path`, `overrides`) |
| `/WurzelIn/FehlerMeldung` | bool: on a communication error show the error to the technician (the module usually passes its `EcuErrorMessage` variable, default true) |
| `/WurzelIn/IO_FrageText` | text or null: when set, the dialog first shows this question with two buttons and a "no" answer aborts the job |
| `/WurzelIn/StateLists/Result[i]/Path` | result path the dialog may display (`/Result/Rows/Row[0]/STAT_...`) |
| `/WurzelIn/StateLists/Result[i]/Unit` | display unit for that result |
| `/WurzelIn/StateLists/Result[i]/ReplaceResultWithState` | bool: map the raw value through a state list (`__StateList`) before display |
| `/WurzelIn/StateLists/Result[i]/Text` | caption |
| `Display` | false in nearly every module: run silently |

Outputs: `/WurzelOut/DSCResult` (the result object read with `job_result(path, type)`), `FASTAJobs` (journal).

Job descriptor semantics: `group_path` = `["Group", "<GROUP>", "VirtualVariantJob", "<JOB or Status>"]`. `<GROUP>`
is an EDIABAS group file (`D_MOTOR`, `D_0012`, ...); `VirtualVariantJob` means resolve the group to the variant
SGBD first (the app's variant resolution) and run the job on that SGBD. `args` are the job arguments in order
(`ECUGroupOrVariant` is the first argument and is normally supplied by an override: a literal such as `"D_MOTOR"`
or a module variable such as `Sgbd_v`); the remaining arguments (`MODE`, `ARG`, ...) are joined with `;` as the
EDIABAS argument string exactly as written (`"1;IPUMG;IPLAD"` is already one argument string). Result paths:
`/Result/Status/<NAME>` = result set 0 (the system set: `JOB_STATUS`, `VARIANTE`, `SAETZE`, ...);
`/Result/Rows/Row[i]/<NAME>` = data set i+1; `/Result/Rows/$Count` = number of data sets. Types requested by the
module (`int`, `double`, `string`, `short`, `bool`) follow the EDIABAS result type; a missing result reads as
null and the module branches on `!= null`.

Failure rule (`EcuKomServiceDlgImpl`, lines 150-151): when the job fails and `FehlerMeldung` is true, the dialog
shows the error with two buttons; the first button (index 0) sets `CollectiveResult = NotOk`, the second leaves
`Ok`. When `FehlerMeldung` is false the failure is silent and the result object carries no rows (`$Count` 0,
values null).

App stand-in: the existing job runner. Resolve `<GROUP>` to the SGBD (or use the override value when it names an
SGBD), run `<JOB>` with the argument string, expose result set 0 under `Status`, the data sets under `Rows`, and
the count under `$Count`. On failure: if `FehlerMeldung` show "Communication error, retry / cancel" and set
`NotOk` on cancel.

## 5. Measurement without a multimeter (`51892235` MeasuringServiceDlg)

Inputs: `AdaptionsText` (instruction: function, probe placement, condition), `ToleranzFeldFrageText` (setpoint and
the question "Was the setpoint reached?"), `DSCConfig1` / `DSCConfig2` (IMIB parametrisation: `Function`
Voltage/Resistance/Current, `Range`, `Coupling`, `Filter`, `Mode`), `Unit1` / `Unit2`, `BothChannels`, `Display`.

Outputs: `Value1`, `Value2` (double), `MinValue`, `MaxValue` (double), `TimeStamp` (long), `ERROR` (bool).

Behaviour: the module's infoobject declares the device as `<SubDevice Name="DMM1" NoDeviceBehavior=
"SubstitutionValueInput"/>`; with no IMIB the dialog switches to `IsManualInput` (`MeasuringServiceDlgImpl.cs`
line 96): a number entry box in `Unit1` plus, when `ToleranzFeldFrageText` is set, the Yes/No answer. Answering
No (`IsAnswer2`) sets `CollectiveResult = NotOk` (`MeasuringServiceDlgImpl.cs` line 1044); Yes leaves it `Ok`
(line 1103). In manual mode `MinValue`/`MaxValue` are 0 and `Value1` is the typed number (`SetOutParameters`,
lines 216-226); `ERROR` is true only for a device fault.

App stand-in: show `AdaptionsText`, a numeric input with the unit, `ToleranzFeldFrageText` and two buttons
"1 Yes / 2 No"; return `Value1` = the number (0 if empty), `MinValue` = `MaxValue` = 0, `ERROR` = false, and set
the result register to `NotOk` on No. The module then branches on `CollectiveResult != 0`.

## 6. Fault-memory list (`52637835` FS_LISTE_ISTA, command `FsListeIstaCmd`, no GUI)

Called by the library module `ABL-GEN-GISTA_FSLISTE1` ("Read fault memory list", control id 9116066187), which
every engine module of the `B1214`/`B1362` families calls first. FS_LISTE_ISTA itself takes no group: it walks the
session's vehicle context (every identified ECU with its stored DTCs, `ECU.VARIANTE`, `dtc.F_ORT`, `F_ORT_TEXT`,
`F_HFK`, `F_HLZ`, `F_EREIGNIS_DTC`, `F_UEBERLAUF`, `F_UW_KM_Min/Max`, environmental conditions, fault modes,
fault classes) and fills parallel arrays, one entry per stored fault of the whole car. FSLISTE1 then filters them
by the caller's group and fault-location list.

In/out container keys (arrays are parallel, index = fault; the caller passes empty arrays in and reads them back):

| key | type | meaning |
|---|---|---|
| `Anzahl_Fehlerspeicher` | int | number of faults in the arrays |
| `Fehlerkode_hex` | string[] | fault location as upper-case hex (`F_ORT`), e.g. `3F00` |
| `Fehlerkode_dez` | int[] | the same as a number |
| `Fehlerkode_Text` | string[] | localized fault text (`F_ORT_TEXT`) |
| `Fehlerkode_SGBD` | string[] | the ECU variant name (`VARIANTE` upper-case) or, without a variant, the group |
| `Fehlerkode_HFK` | int[] | frequency counter (`F_HFK`) |
| `Fehlerkode_HLZ` | int[] | healing counter (`F_HLZ`) |
| `Fehlerkode_Ereignis` | int[] | event DTC (`F_EREIGNIS_DTC`) |
| `Fehlerkode_Ueberlauf` | int[] | overflow flag (`F_UEBERLAUF`) |
| `Fehlerklasse` | int[] | fault class (255 when unknown) |
| `Fehlerart_Vorhanden_NR` / `_Text` | int[] / string[] | fault mode "present" number and text (`F_VORHANDEN_NR`, `F_VORHANDEN_TEXT`) |
| `Fehlerart_Symptom_NR` / `_Text` | int[] / string[] | symptom fault mode |
| `Fehlerart_Ready_NR` / `_Text` | int[] / string[] | readiness fault mode |
| `Fehlerart_Warnung_NR` / `_Text` | int[] / string[] | warning-lamp fault mode |
| `Fehlerart_Erweitert_NR` / `_Text`, `Fehlerart_Erweitert_Anzahl` | int[] / string[] / int | extended fault modes |
| `Kilometer_Anfang`, `Kilometer_Ende` | int[] | mileage at first and last occurrence (`F_UW_KM_Min`, `F_UW_KM_Max`) |
| `Systemzeit_Anfang`, `Systemzeit_Ende` | int[] | system time at first and last occurrence |
| `Umweltbedingung_Anzahl`, `Umweltbedingung_NR`, `Umweltbedingung_Wert` | int / int[] / string[] | environmental conditions |

FSLISTE1's own contract (the sub-module node B1362 calls, all keys in `inout_params`): inputs `SG_gruppe_v`
(string[], group file per ECU, index 0 used), `Steuergeraet_v` (display name), `Verdacht_Versorgung_v`,
`Ausgabe_Meldung_v` (1 = show the "no fault stored" messages), `Fehlerorte_v` (string[], the fault-location hex
list to keep, e.g. `3F00 3F01 3F02 3F03 41AA 41AB`); outputs `Status_Fehlerspeicher_v` (int, number of matching
faults), `Sgbd_v` (string[], the variant SGBD of the group, index 0), `Status_Ident_v` / `Status_Ident_ges_v`
(ident status text, `OKAY`), `Fkode_hex_v`, `Fkode_dez_v`, `Fkode_Text_v`, `Fkode_SGBD_v`, `Fkode_HFK_v`,
`Fkode_HLZ_v`, `Fkode_Ereignis_v`, `Fklasse_v`, `Fart_Vorhanden_NR_v` / `_Text_v`, `Fart_Symptom_NR_v` / `_Text_v`,
`Fart_Ready_NR_v` / `_Text_v`, `Fart_Warnung_NR_v` / `_Text_v`, `Kmeter_Anfang_v`, `Kmeter_Ende_v`,
`Fkode_Anzahl_ges_v`, `Fkode_Anzahl_SG_v` (the filtered arrays and counts).

App stand-in: do not run FSLISTE1's graph. Implement the sub-module call natively: resolve `SG_gruppe_v[0]` to the
variant SGBD (`Sgbd_v[0]`), run the fault read the app already has for that SGBD (`FS_LESEN`, optionally
`FS_LESEN_DETAIL` for `F_HFK`/`F_HLZ`/mileage), keep the entries whose `F_ORT` hex is in `Fehlerorte_v`, fill the
arrays above and `Status_Fehlerspeicher_v` = their count, `Status_Ident_v` = `OKAY` when the ECU answered.
`ISTA_Kontext_DTC_Daten` / `ISTA_Kontext_DTC_Auswertung` (section 7) are the same data reused by newer templates.

## 7. Session context lookups (`ISTA_Kontext_*`, `SYS_VAR_ISTA`, `TYPMERKMAL_ISTA`; no GUI)

| ref | class | reads | writes |
|---|---|---|---|
| `69913852939` | `ISTA_Kontext_FZG_Daten` | vehicle identification | public fields `Typmerkmal` (string[], type characteristics such as model, engine, gearbox, body) and `Sonderausstattung` (string[], option codes), flag `TYPMERKMAL_ISTA_RUN` (inferred from the public fields) |
| `69973561867` | `ISTA_Kontext_Ausstattung_Daten` | option list | the option codes (field `m_maxAnzahlSonderausstattungen` bounds the array) |
| `70271166731` | `ISTA_Kontext_Ausstattung_Auswertung` | in: `SAs` (string[] option codes to test), `SA_Anzahl` (int) | whether the options are fitted (result per code, inferred) |
| `67207569803` | `ISTA_Kontext_DTC_Daten` | the vehicle's stored DTCs | the FS_LISTE_ISTA arrays of section 6 (same keys) plus `ISTA_F_ORT_NR_HEX`, `ISTA_F_ORT_NR_DEZ`, `ISTA_F_ORT_TEXT`, `ISTA_F_ORT_VORHANDEN_NR`, `ISTA_F_ORT_VORHANDEN_TEXT`, `ISTA_F_HFK`, `ISTA_F_HLZ`, `ISTA_F_EREIGNIS_DTC`, `ISTA_F_SGBD`, `ISTA_F_UW_KM_L`, `ISTA_F_UW_ZEIT_L` |
| `68072409611` | `ISTA_Kontext_DTC_Auswertung` | in: `Kode`, `F_ORT_NR_HEX`, `F_ORT_NR_HEX_MIN`, `F_ORT_NR_HEX_MAX`, `F_ORT_NR_HEX_LISTE` (a code, a range or a list to test) | `DTC_Eingetragen` (bool), `Kode_Eingetragen`, `DTC_Eingetragen_Anzahl`, `DTC_Eingetragen_Liste_HEX`, `DTC_Eingetragen_Liste_DEZ`, `DTC_Eingetragen_String`, `DTC_Eingetragen_Alle` plus the arrays of section 6 |
| `52672267` | `SYS_VAR_ISTA` | system variables (tester language, date) | (fields, rarely used) |
| `52677899` | `TYPMERKMAL_ISTA` | runs `IDENT`-style jobs itself (DSCConfig with up to 6 state-list results) | type characteristics |

Also seen inline in conditions: `VehicleContext.IsSet(__FaultCode("<id>"))` = "fault code with this database id
is stored in the vehicle" (`XEP_FAULTCODES.ID`; resolve to `CODE` + `ECUVARIANTID` to compare with the app's
stored faults).

App stand-in: serve all of these from the identification scan the app already performs (vehicle data, option
list, whole-car fault list). `DTC_Auswertung` is a filter over the stored fault list.

## 8. Ignition and vehicle-state waits

`51872651` VehicleStateServiceDlg: inputs `/WurzelIn/Vehicle/VehicleParts[i]/VehiclePart` (a part locator),
`/WurzelIn/Vehicle/VehicleParts[i]/VehicleState` (the state to reach, e.g. ignition on, terminal 15 on, engine
running, lights on), `/WurzelIn/Vehicle/VehicleParts[i]/VerificationMethod` (automatic = verify by reading the
vehicle, otherwise ask the technician), `Display`. No module-visible output; it returns when the state is met or
confirmed.

`61002193291` Dialog_Zuendungstatus (command `DialogZuendungstatusCmd`): inputs `i_ZuendungEinText`,
`i_ZuendungAusText` (texts to show for "switch ignition on/off"), `i_automatic` (bool: verify via an ECU job
that reads terminal 15 voltage, output `i_KL15spg`), `i_PopUp`, `i_hilfsvariable`. Invoked as
`ZuendungEin` / `ZuendungAus` on library module `ABL_GEN_...`.

App stand-in: show "Switch ignition on/off" with Continue; when the app can read terminal 15 (identification
job) verify automatically, else trust the technician.

## 9. Documents (`DocumentHandler`)

`DocumentHandler(action, locator, slot)` with `action` `Add` (0), `Remove` (1) or clear-all (2), `slot` 0..3 (tab
position in the right pane). Locators: `__IndirectDocument(sysName, infoType[, formats])` finds the document of the
current vehicle by system name (`Ladedruckregelung_DDE`) and type (`Schaltplan` = wiring diagram,
`Funktionsbeschreibung` = function description; `formats` narrows to `Funktionsschaltplan|Bauteilschaltplan`);
`__Document("<id>")` by infoobject id; `__FaultCode("<id>").GetDocument()` the fault-code document.

App stand-in: open the app's wiring diagram / function description for the current vehicle and system in a tab of
the right pane; a `Remove`/clear removes it. Failure to find a document must not stop the module.

## 10. Sub-module calls (`callModuleRef`, `callModule`)

`callModuleRef("<controlId>", in, ref out, ref inout)`: resolve `XEP_INFOOBJECTS.CONTROLID` to the module
(`IDENTIFIER` gives the DLL name with `-` turned into `_`), run it with the three containers: `in` read-only inputs,
`inout` the caller's variables by name (read on entry, written back on return), `out` outputs. The callee's
`CollectiveResult` is copied to the caller's result register on return. `callModule("<assemblyName>", ...)` is the
same by name.

App stand-in: run the callee graph with a variable dictionary seeded from `inout_params`, copy back the keys in
`reads`, propagate the result register; or dispatch by identifier to a native stand-in (section 6 for
`ABL-GEN-GISTA_FSLISTE1` and its siblings `GISTA_FSLISTE*`).

## 11. Small base-class calls

| call | semantics | app stand-in |
|---|---|---|
| `Sleep(ms)` | blocking pause | timer |
| `__SetSuspiciousItem(__DiagnosticObject(x))`, `__SetOkItem`, `__SetNotOkItem` | mark the diagnosis object `x` (name or database id) suspicious / ok / not ok in the test plan | record the verdict for the module's report; no UI needed |
| `HasVehicleVariant(group, variant)` | true when that ECU variant is fitted | identification scan |
| `__Text(id)`, `__StandardText(id)` | already resolved in the JSON (`en`) | none |
| `__convertToInt32/Double/String`, `__getChar` | numeric/string conversion | evaluator |

## 12. Feedback dialog (`51937067403` RueckmeldeDialog) and text entry (`51888523` EnterServiceDlg)

RueckmeldeDialog inputs: `_Anfang` / `__Anfang` (heading), `_Ende` (footer), `_Buttons` (list of texts, one per
option), `_Diagnosekodes` (list of texts, the diagnosis code per option), or the paired form `_1er_Button` /
`_1er_Diagnosekode` .. `_6er_Button` / `_6er_Diagnosekode`, `Display`. Output: `Result` (int, 1-based index of the
chosen option). Behaviour: the chosen option's diagnosis code is journaled as the module's feedback.

EnterServiceDlg inputs: `txtParam` or `AnzeigeText` (prompt), `Datentyp` (expected type, inferred: string/int/double),
`MaxTextLength`, `ServiceCodeName` / `ServiceCodeWert` (library use). Outputs: `Result` (the entered value),
`MaxTextLengthUsed`.

## 13. Result register and exits

Every step begins with `CollectiveResult = Ok`. Sources of change: explicit `result` nodes, the measurement
dialog (No -> `NotOk`), the ECU job dialog on failure (cancel -> `NotOk`), sub-modules (propagated). The compiled
epilogue converts the register to an exit number (`Ok` -> 0, `NotOk` -> 1, `Unknown` -> 2, `Repaired` -> 3) and
the flow's explicit returns set higher numbers; exit 0 ends the module (return to the test plan with the
register as the module verdict), any other exit is a `goto_step`. In the JSON this is already resolved: follow
`switch` on `CollectiveResult` / `branch` on `CollectiveResult != 0` to the `goto_step` or `end`. The module's
final verdict for the test plan is the register value when `Reset` runs.

## 14. Text rendering

The English in `en` is plain text with: paragraphs separated by `\n`, blank paragraphs as empty lines, list
entries as lines starting with `- `, notes as lines starting with `Note: `, placeholders as `{name}` to be
substituted with the current variable value (source formats: `FORMAT="f0"` = no decimals, `f1`/`f2` = 1/2 decimals;
the JSON does not carry the format, so render integers without decimals and doubles with at most 2 unless the
text says otherwise), units already attached (`{Plad_v} mbar`), symbols already inlined (`±`), and diagnosis codes
as `[diagcode <id>: <German title>]` (render the number at the start of the title, e.g. `901`, and keep the id for
the feedback record). Composite instructions (`text_concat`) are joined in order; an empty element is a line break.

## 15. What B1362 needs (minimal subset)

| service | used by step | needed behaviour |
|---|---|---|
| message, wait mode | Status_Fuehler_05, Pruefung_Leitung_07, Pruefung_Sensor_08, Reset | text + Continue |
| message, timed mode (2000 ms) | Fehlerstatus_04, Massnahme_33 | text, auto-dismiss |
| message, live mode + HideDialog | Status_Fuehler_05 | redraw with `{Plad_v} {Patm_v} {Pdiff_v}` until Continue |
| selection (2, 3 and 4 buttons) | Fehlerstatus_04, Auswahl_06, Massnahme_33 | 1-based `Result` |
| ECU job `IDENT` on `D_MOTOR` | Start | `/Result/Status/VARIANTE`, `$Count` |
| ECU job `STATUS_MESSWERTBLOCK_LESEN` `1;IPUMG;IPLAD` on `Sgbd_v` | Status_Fuehler_05 | `Row[0]/STAT_UMGEBUNGSDRUCK_WERT`, `Row[0]/STAT_LADEDRUCK_WERT` (double), `$Count` |
| sub-module `ABL-GEN-GISTA_FSLISTE1` (native) | G9999_FSLESEN30 | `Status_Fehlerspeicher_v`, `Sgbd_v`, `Status_Ident_v` for group `D_MOTOR` filtered to `3F00 3F01 3F02 3F03 41AA 41AB` |
| measurement, manual entry | Pruefung_Sensor_08 | number in V + Yes/No; No -> `NotOk` |
| documents | Start | wiring diagram `Ladedruckregelung_DDE`, function description |
| result register / exits | all | `Ok`/`NotOk` switch after each dialog |
| evaluator | Initialisierung_01, Status_Fuehler_05 | string compare, subtraction, `__convertToDouble`, array element assignment |

Not needed by B1362: yes/no question dialog, text entry, feedback dialog, vehicle-state waits, context lookups,
verdict calls, sleep.
