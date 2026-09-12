# ABL step-graph JSON format (frozen)

One file per ISTA test module (`ABL_*.dll`), written by `tools/ista/abl_extract.py` and stored as
`data/ista/abl/<MODULE>.json.gz`. The shape below is frozen: the engine in the app is built against it.
Fields may be ADDED in later versions, never renamed or removed. Every example here is taken from
`ABL_DIT_B1362_D6LDF` (charging pressure sensor, DDE 6.0).

## 1. Top level

| key | type | meaning |
|---|---|---|
| `module` | string | DLL base name, e.g. `ABL_DIT_B1362_D6LDF` |
| `class` | string | the compiled class name (same as `module`) |
| `identifier` | string | database identifier: the module name with the first two `_` turned into `-`, e.g. `ABL-DIT-B1362_D6LDF`; key into `XEP_INFOOBJECTS.IDENTIFIER` |
| `infoobject` | object or null | `{id, control_id, title, program_type, version, devices}`; `devices` is a list of `[deviceName, noDeviceBehaviour]` pairs from the infoobject's adapter declaration, e.g. `[["DMM1", "SubstitutionValueInput"]]`; null when the database has no row for the identifier |
| `texts` | object | every text id the graph references: `{"<id>": {"name": "<TEXTITEM NAME>", "en": "<plain English>"}}`; a missing id has `"missing": true` and `en: null` |
| `texts_missing` | list of string | the ids that could not be resolved |
| `variables` | object | module variables (public fields) `{name: C# type}`, e.g. `"Plad_v": "double"`, `"Fehlerorte_v": "string[]"` |
| `entry` | string | always `"Start"` |
| `step_order` | list of string | steps reachable from `Start` in breadth-first order over `exits` |
| `unreached_steps` | list of string | step methods not reachable from `Start` (see `findings` for the reason) |
| `steps` | object | `{stepName: step}` (section 2); includes `run`, `Prepare`, `Reset`, `Start`, every `<name>_s` step and library steps such as `G9999_FSLESEN30`; the constructor appears under the class name |
| `summary` | object | `node_kinds` (count per node type), `dialog_refs` (count per dialog reference), `jobs` (list of `{step, job, args, results, overrides}` for every ECU job) |
| `diagnostics` | object | `methods` (count), `parse_errors` (list of `{method, error}`) |

Additive fields written by the shipped extractor (absent in the research prototype output):

| key | type | meaning |
|---|---|---|
| `complete` | bool | true when no step has a `pruned` or `unknown` finding and no node of type `error` exists anywhere |
| `findings` | list | one entry per step that is not reachable from `Start`, plus any whole-module failure: `{step, reason, detail}`. Provable-dead reasons: `never-called` (no method calls it: template leftover), `exit-never-produced` (called only under a `case k` of an exit switch whose register never takes k in that method: the flow wires the exit but no return statement uses it), `exit-not-executed` (the value is assigned somewhere but no walked path carries it to the exit switch), `caller-unreached` (called only from a step that is itself unreached), `call-site-unreached` (the call sits in code the walker proved unreachable, e.g. the decoy arm of an opaque switch). Gap reasons, which make the module not `complete`: `pruned` (the call site is in reachable code and the exit value is produced, yet the walker did not connect it), `unknown`, `error` (an error node or a parse error), `crash`. Batch-level reasons, written by `abl_batch.py` for a module it could not even parse: `dll-missing` (not in the installer archive), `decompile-incomplete` (no whole decompilation could be produced) |
| `dead_steps` | list of string | the steps whose finding is a provable-dead reason, i.e. `reason` in `abl_extract.DEAD_REASONS` |

`complete` is deliberately not "every step was reached". Flows ship jump-table arms that no return statement ever
selects, so a module can be fully recovered and still have steps nothing can reach; calling those a failure would
make full recovery unreachable by construction. The validator therefore has to separate "cannot be reached", which
it proves by showing the dispatch register never takes the value, from "was not followed", which is a gap in this
tool. Only the second kind clears `complete`.

One input rule the format depends on: the decompilation the graph is recovered from must be whole. Given several
assemblies in one invocation, ilspycmd truncates all but the last at a 4 KB boundary, and a truncated file still
parses and still yields a plausible graph while silently missing every step after the cut. Both tools therefore
check a decompilation with `cs_complete()` before trusting it, and decompile one assembly per invocation.
| `chassis` | list of string | development codes named by the module's validity rule, e.g. `["E46", "E60"]` |
| `dll` | string | the DLL file name the graph was recovered from |
| `tool` | string | extractor version string |

## 2. A step

```json
"Status_Fuehler_05_s": {
  "entry": 1,
  "exits": ["Auswahl_06_s"],
  "can_end": true,
  "instructions": 199,
  "raw_events": 200,
  "nodes": [ ... ]
}
```

| key | meaning |
|---|---|
| `entry` | id of the first node |
| `exits` | sorted names of the steps this step can call (`goto_step` targets) |
| `can_end` | true when some path ends the module (an `end` node without a preceding `goto_step`) |
| `instructions`, `raw_events` | sizes from the walker, informational |
| `nodes` | the step graph |

Node ids are integers unique within one step only. Linking: a node carries either `next` (an id, or a list of ids when
several successors were merged) or `cases` (`{label: id}`). Edges may point backwards: a live-refresh loop (message
with `TIMEOUT` 0 redrawn until Continue) is a cycle in the graph, as is a "Go to Selection" return in a
sub-step. Nodes are listed in walk order; the engine must follow `entry` and the links, not the list order.

## 3. Node types

Every node has `type` and `id`. Dialog nodes (message, hide_message, selection, question, ecu_job,
measurement, dialog) share:

| key | meaning |
|---|---|
| `dialog_ref` | the ISTA dialog control id as a string (`51915403` message, `13628358027` selection, `51878795` question, `51939083` ECU job, `51892235` measurement, ...) or `MessageServiceDlg1` for the module-global message dialog |
| `method` | invoked method: `InitializeDialog`, `InitializeDialog2` (selection), `HideDialog`, or a library method name |
| `element` | the flow element number of the call (int or null) |
| `params` | the input parameter container: `{name: value}`; values are JSON scalars, `null`, a text object, a text concat object, a job descriptor, or `{"expr": "<C# expression>"}` for anything computed |
| `out` | name of the output container variable (informational) |
| `reads` | the output keys the module reads afterwards (`["Quit"]`, `["Result"]`, result paths for jobs) |
| `next` | successor id |

Text object: `{"text": "<id>", "en": "<English>", "name": "<TEXTITEM name>"}` with optional `"params": {"Plad_v":
"Plad_v"}` when the text has placeholders; `en` contains the placeholders as `{Plad_v}`. Text concat object:
`{"text_concat": [textObject | " " | "literal", ...]}` joined in order; an empty `en` in the list is a line break
(`DEPUTY_SYSSTX_NEWLINE`).

### message

```json
{"type": "message", "dialog_ref": "51915403", "method": "InitializeDialog", "element": 214,
 "params": {"txtParam": {"text": "12784794379", "en": "In the next test step, ...", "name": "TXMELD14"},
            "WertFeld": null, "Quittierung": true, "TIMEOUT": 0, "Protocol": true, "Display": true},
 "out": "val2", "reads": ["Quit"], "id": 13, "next": 15}
```

`txtParam` text to show. `WertFeld` optional value line (text object) or null. `Quittierung` true: wait for
Continue. `Quittierung` false and `TIMEOUT` > 0: show, auto-dismiss after TIMEOUT ms. `Quittierung` false and
`TIMEOUT` 0: show and return at once (live display, redrawn by the loop). `Protocol`: journal it. `Display`:
false means silent. Output `Quit` (bool): Continue was pressed.

### hide_message

`{"type": "hide_message", "dialog_ref": "MessageServiceDlg1", "method": "HideDialog", ...}`: remove the live
message.

### selection

```json
{"type": "selection", "dialog_ref": "13628358027", "method": "InitializeDialog2", "element": 149,
 "params": {"priorText": {...}, "pastText": {...}, "ButtonCount": 2,
            "ButtonLabel1": {"en": "1", ...}, "ButtonLabel2": {...}, "ButtonLabel3": null, ... "ButtonLabel6": null,
            "ButtonText1": {"en": "Continue test module", ...}, "ButtonText2": {...}, ... "ButtonText6": null,
            "Display": true},
 "out": "val2", "reads": ["Result"], "id": 26, "next": 30}
```

`priorText` heading above the buttons, `pastText` text below, `ButtonCount` number of live buttons,
`ButtonLabelN` the short label (usually "1".."6"), `ButtonTextN` the option text. Output `Result` (int): the
1-based index of the pressed button. The following `assign` copies it (`SELEKT = out.Result`) and a `switch` on
`SELEKT` (or a chain of `branch` nodes) picks the path.

### question

Same shape with `dialog_ref` `51878795`, `params.txtParam`; output `Result` (int, 1-based button index; the
default buttons are Yes = 1 and No = 2).

### ecu_job

```json
{"type": "ecu_job", "dialog_ref": "51939083", "method": "InitializeDialog", "element": 236,
 "job": "STATUS_MESSWERTBLOCK_LESEN",
 "args": {"ECUGroupOrVariant": "", "MODE": "1;IPUMG;IPLAD"},
 "results": ["STAT_LADEDRUCK_WERT", "STAT_UMGEBUNGSDRUCK_WERT"],
 "group_path": ["Group", "D_MOTOR", "VirtualVariantJob", "Status"],
 "overrides": {"/Run/Group/D_MOTOR/VirtualVariantJob/STATUS_MESSWERTBLOCK_LESEN/Argument/ECUGroupOrVariant": {"expr": "Sgbd_v"}},
 "adapter": "BMW-EDIABAS-Adapter",
 "reads": ["/Result/Rows/$Count", "/Result/Rows/Row[0]/STAT_UMGEBUNGSDRUCK_WERT", "/Result/Rows/Row[0]/STAT_LADEDRUCK_WERT"],
 "params": {"DSCConfig": null, "Display": false, "FehlerMeldung": true, "IO_FrageText": null,
            "/WurzelIn/FehlerMeldung": {"expr": "EcuErrorMessage"},
            "/WurzelIn/DSCConfig": { "adapter": "...", "config": "EDIABAS_SpExtract", "path": [...], "executables": [{"job": ..., "args": ..., "results": ...}], "overrides": {...} },
            "/WurzelIn/StateLists/Result[0]/Path": "/Result/Rows/Row[0]/STAT_UMGEBUNGSDRUCK_WERT",
            "/WurzelIn/StateLists/Result[0]/ReplaceResultWithState": false,
            "/WurzelIn/StateLists/Result[0]/Unit": "hPa", ...},
 "out": "val9", "id": 96, "next": 106}
```

`job`, `args`, `results` come from the first executable of the job configuration; `group_path[1]` is the EDIABAS
group file (`D_MOTOR`) and `VirtualVariantJob` means "resolve the group to its variant SGBD, then run the job on
it". `overrides` replace an argument at run time; the value is a literal string or `{"expr": "<variable>"}` (a module
variable holding an SGBD name, typically `Sgbd_v` filled by the fault-list sub-module). `args.ECUGroupOrVariant` is
therefore usually empty in the literal and supplied by the override. `reads` are the result paths the module reads:
`/Result/Status/<NAME>` = EDIABAS result set 0 (the system set), `/Result/Rows/Row[i]/<NAME>` = data set i+1,
`/Result/Rows/$Count` = number of data sets. `params` keeps the raw dialog inputs (`/WurzelIn/...`).

### measurement

```json
{"type": "measurement", "dialog_ref": "51892235", "method": "InitializeDialog", "element": 381,
 "device": "DMM1", "no_device": "SubstitutionValueInput",
 "measure": {"function": "Voltage", "range": "Auto", "coupling": "DC", "filter": "Off", "mode": "Normal"},
 "unit": "V",
 "params": {"AdaptionsText": {"text_concat": [...]}, "Display": true,
            "ToleranzFeldFrageText": {"text": "12784842251", "en": "Setpoint: 1.1-1.5 V\n\nWas the setpoint reached?\n\nNote: ...", ...},
            "DSCConfig1": {...IMIB parametrisation...}, "DSCConfig2": null, "Unit1": "V", "Unit2": "", "BothChannels": false},
 "reads": ["ERROR", "TimeStamp", "Value1", "Value2", "MinValue", "MaxValue"], "id": 27, "next": 52}
```

`AdaptionsText` is the instruction (function, probe placement, condition); `ToleranzFeldFrageText` the setpoint
question. Without a multimeter (`no_device` = `SubstitutionValueInput`) the dialog is a manual number entry plus a
Yes/No answer; answering No sets `CollectiveResult` to `NotOk`, and the next node is normally a `branch` on
`CollectiveResult != 0`.

### submodule

```json
{"type": "submodule", "ref": "9116066187", "name": null,
 "module": {"identifier": "ABL-GEN-GISTA_FSLISTE1", "title": "Read fault memory list"},
 "params": {}, "inout_params": {"SG_gruppe_v": {"expr": "array"}, "Status_Fehlerspeicher_v": {"expr": "num2"}, ...},
 "out": "val2", "inout": "val3", "reads": ["Status_Fehlerspeicher_v"], "id": 76, "next": 78}
```

`ref` is the callee's `XEP_INFOOBJECTS.CONTROLID`, resolved into `module`; `name` is set instead of `ref` when the
callee is named by assembly name. `params` is the input container, `inout_params` the in/out container: the keys
are the callee's variable names, the values what the caller passes (`{"expr": ...}` when computed). `reads` lists
the in/out keys the caller copies back. The engine runs the callee graph (or a native stand-in) with a dictionary
of those variables and copies them back.

### assign

```json
{"type": "assign", "lhs": "Patm_v", "rhs": "job_result(\"/Result/Rows/Row[0]/STAT_UMGEBUNGSDRUCK_WERT\", double)", "id": 130, "next": 136}
{"type": "assign", "lhs": "Steuergeraet_v", "rhs": "__Text(\"12784757771\").TextContent.PlainText", "rhs_en": "DDE control unit", ...}
{"type": "assign", "lhs": "Quit", "rhs": "out.Quit", ...}
{"type": "assign", "lhs": "Pdiff_v", "rhs": "__convertToDouble((Patm_v - Plad_v))", ...}
{"type": "assign", "lhs": "Fehlerorte_v[0]", "rhs": "\"3F00\"", ...}
```

`lhs` is a module variable, optionally indexed (`name[i]`). `rhs` grammar (C# syntax after cast removal):
string literals in double quotes, numbers, `true`/`false`, `null`, module variables, array indexing `a[i]`,
arithmetic `+ - * /` with parentheses, comparisons, `out.<key>` (the named output of the most recent dialog or
sub-module in this step), `job_result("<path>", <int|double|string|short|bool>)` (a result of the most recent
`ecu_job`), `__convertToInt32(x)`, `__convertToDouble(x)`, `__convertToString(x)`, `__getChar(s, i)`,
`__Text("<id>").TextContent.PlainText` (with the English in `rhs_en`), `new T[n] {...}` (buffer set-up, may be
ignored). A temporary from the compiler that is assigned more than once keeps its name (`num3`, `array`,
`iSTAResultAsType2`); treat it as a local variable of the step.

### branch

`{"type": "branch", "cond": "!QUIT", "cases": {"true": 122, "false": 24}, "id": 20}`

`cond` uses the same grammar as `rhs`; `<x> != null` on a `job_result` means "the job returned that result".
Special forms: `CollectiveResult != 0`, `SELEKT == 1`, `Status_Fehlerspeicher_v > 0`, string compares
`SgbdM_v == "d63mm670"`, `VehicleContext.IsSet(__FaultCode("<id>"))` (a fault code is stored). A case may be
missing when the walker proved the branch constant.

### switch

`{"type": "switch", "expr": "CollectiveResult", "cases": {"Unknown": 92, "Verified": 89, "Repaired": 77, "NotOk": 66, "Ok": 63, "default": 52}, "id": 43}`
`{"type": "switch", "expr": "SELEKT", "cases": {"5": 81, "4": 74, "1": 71, "6": 64, "2": 58, "3": 52, "default": 46}}`
`{"type": "switch", "expr": "f_SELEKT_ORT_NR_HEX", "cases": {"\"30D8F\"": 134, "\"30D8A\"": 134, ..., "default": 120}}`

Case labels are decimal strings, `CollectiveResultSet` enum names for the result register, or double-quoted
strings when the module switches on a string (fault-location hex). `default` is always present. A label with a
trailing `'` marks a duplicate label whose target differed (never seen in practice, kept for safety).

### goto_step

`{"type": "goto_step", "step": "Auswahl_06_s", "id": 58, "next": 59}`: run the named step; the following `end`
node only says that this step's method returns.

### result

`{"type": "result", "value": "Ok", "id": 2, "next": 13}`: sets the module's `CollectiveResult` register.
Enum `CollectiveResultSet`: `Ok` = 0, `Verified` = 1, `NotOk` = 2, `Unknown` = 3, `Repaired` = 4, `None` = 5.
Every step starts with `startstep` then `result Ok`. Dialogs may change the register (measurement No, ECU job
failure); the compiled epilogue maps it to exits (`Ok` = 0 = end unless a `goto_step` follows, `NotOk` = 1,
`Unknown` = 2, `Repaired` = 3) which the graph already resolved into `cases`/`goto_step`.

### document

`{"type": "document", "action": "Add", "arg": "__IndirectDocument(\"Ladedruckregelung_DDE\", \"Schaltplan\", \"Funktionsschaltplan|Bauteilschaltplan\"), 0", "id": 3, "next": 4}`

`action` is `Add`, `Remove` or `actionN` (raw enum value, 2 = clear all). `arg` is the locator expression followed by
the slot number: `__IndirectDocument(sysName, infoType[, formats])` (a document found by system name and type,
`Schaltplan` = wiring diagram, `Funktionsbeschreibung` = function description), `__Document("<id>")`,
`__FaultCode("<id>").GetDocument()`.

### sleep, suspicion, end, startstep, finishstep, misc, error, dialog

| type | fields | meaning |
|---|---|---|
| `sleep` | `ms` | pause (expression, usually a literal) |
| `suspicion` | `what` (`SetSuspiciousItem`, `SetOkItem`, `SetNotOkItem`), `arg` (`__DiagnosticObject("<name or id>")`) | verdict on a diagnosis object for the test plan |
| `end` | `how` optional | the step method returns |
| `startstep` / `finishstep` | | protocol brackets; no behaviour |
| `misc` | `text` | a statement the lifter did not classify (`Array.Resize(...)`, list building, `OutParameter.Parameter.Add(...)` in library modules); safe to ignore for execution |
| `error` | `text` | the walker gave up here; a module with an error node is not `complete` |
| `dialog` | dialog fields | a dialog reference the lifter has no type for (see `dialog_ref` and `method`; `params` are still filled) |

## 4. Worked example: B1362, step Status_Fuehler_05_s (abridged)

```json
"Status_Fuehler_05_s": {
  "entry": 1, "exits": ["Auswahl_06_s"], "can_end": true,
  "nodes": [
    {"type": "startstep", "id": 1, "next": 2},
    {"type": "result", "value": "Ok", "id": 2, "next": 13},
    {"type": "message", "dialog_ref": "51915403", "method": "InitializeDialog", "element": 214,
     "params": {"txtParam": {"text": "12784794379", "en": "In the next test step, the boost pressure is measured with the engine stationary and compared with the ambient pressure.", "name": "TXMELD14"},
                "WertFeld": null, "Quittierung": true, "TIMEOUT": 0, "Protocol": true, "Display": true},
     "out": "val2", "reads": ["Quit"], "id": 13, "next": 15},
    {"type": "assign", "lhs": "Quit", "rhs": "out.Quit", "id": 15, "next": 17},
    {"type": "assign", "lhs": "_DoLoopHandling", "rhs": "true", "id": 17, "next": 20},
    {"type": "branch", "cond": "!QUIT", "id": 20, "cases": {"true": 96, "false": 24}},
    {"type": "ecu_job", "job": "STATUS_MESSWERTBLOCK_LESEN", "args": {"ECUGroupOrVariant": "", "MODE": "1;IPUMG;IPLAD"},
     "results": ["STAT_LADEDRUCK_WERT", "STAT_UMGEBUNGSDRUCK_WERT"], "group_path": ["Group", "D_MOTOR", "VirtualVariantJob", "Status"],
     "overrides": {"/Run/Group/D_MOTOR/VirtualVariantJob/STATUS_MESSWERTBLOCK_LESEN/Argument/ECUGroupOrVariant": {"expr": "Sgbd_v"}},
     "reads": ["/Result/Rows/$Count", "/Result/Rows/Row[0]/STAT_UMGEBUNGSDRUCK_WERT", "/Result/Rows/Row[0]/STAT_LADEDRUCK_WERT"],
     "id": 96, "next": 102, "...": "..."},
    {"type": "branch", "cond": "iSTAResultAsType != null", "id": 102, "cases": {"true": 208, "false": 108}},
    {"type": "branch", "cond": "(iSTAResultAsType) > 0", "id": 208, "cases": {"true": 231, "false": 212}},
    {"type": "assign", "lhs": "Patm_v", "rhs": "job_result(\"/Result/Rows/Row[0]/STAT_UMGEBUNGSDRUCK_WERT\", double)", "id": 267, "next": 270},
    {"type": "assign", "lhs": "Plad_v", "rhs": "job_result(\"/Result/Rows/Row[0]/STAT_LADEDRUCK_WERT\", double)", "id": 253, "next": 255},
    {"type": "assign", "lhs": "Pdiff_v", "rhs": "__convertToDouble((Patm_v - Plad_v))", "id": 255, "next": 265},
    {"type": "message", "dialog_ref": "MessageServiceDlg1", "method": "InitializeDialog", "element": null,
     "params": {"txtParam": {"text": "12784797195", "en": "Compare setpoints and actual values\n\nSetpoint:\nBoost pressure = ambient pressure ±25 mbar\n\nActual values:\nBoost pressure: {Plad_v} mbar\nAmbient pressure: {Patm_v} mbar\nDifference: {Pdiff_v} mbar", "name": "TXMELD15",
                             "params": {"Plad_v": "Plad_v", "Patm_v": "Patm_v", "Pdiff_v": "Pdiff_v"}},
                "WertFeld": null, "Quittierung": false, "TIMEOUT": 0, "Protocol": true, "Display": true},
     "out": "val12", "reads": ["Quit"], "id": 265, "next": 226},
    {"type": "assign", "lhs": "QUIT", "rhs": "out.Quit", "id": 226, "next": 20},
    {"type": "assign", "lhs": "_DoLoopHandling", "rhs": "false", "id": 24, "next": 25},
    {"type": "assign", "lhs": "QUIT", "rhs": "false", "id": 25, "next": 26},
    {"type": "hide_message", "dialog_ref": "MessageServiceDlg1", "method": "HideDialog", "id": 26, "next": 37},
    {"type": "message", "params": {"txtParam": {"en": "Possible causes of fault if the target value is not reached:\n\n- Lines/plug connections faulty\n- Boost pressure sensor defective\n- Ambient pressure sensor defective.\n\nGo to Selection", "...": "..."}, "Quittierung": true, "TIMEOUT": 0}, "id": 37, "next": 40, "...": "..."},
    {"type": "assign", "lhs": "Quit", "rhs": "out.Quit", "id": 40, "next": 43},
    {"type": "switch", "expr": "CollectiveResult", "id": 43, "cases": {"Unknown": 92, "Verified": 89, "Repaired": 77, "NotOk": 66, "Ok": 63, "default": 52}},
    {"type": "finishstep", "id": 52, "next": 55},
    {"type": "goto_step", "step": "Auswahl_06_s", "id": 58, "next": 59},
    {"type": "end", "id": 59}
  ]
}
```

Reading: show the intro (wait), then loop: run the job, read the two pressures, compute the difference, redraw the
live message; when Continue is pressed (`QUIT` true) hide it, show the causes (wait), and if the result register
is still `Ok`/`Verified`/`default` go to the selection step, otherwise end.

Known cosmetic residue (frozen with the format): a live loop body can appear twice in a step (the walker keeps
one copy with the result register known and one with it unknown; they converge); compiler temporaries assigned
more than once keep their names; the result switch after a dialog lists all six enum cases even when several of
them just end the step.
