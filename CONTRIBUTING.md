# Contributing

## Fault-code translations

Fault-code descriptions are **not** hand-contributed. They are derived directly
from the authoritative BMW SGBD `FORTTEXTE` fault tables (the same data EDIABAS
uses over the cable), extracted per ECU and translated to English.

The translations live under `data/faults/`:

```
data/faults/
  *.json            flat cross-ECU DTC maps  { "<HEXCODE>": "English" }
  <chassis>/*.json  per-ECU files            { "sgbd", "scheme", "faults" }
```

Per-ECU files carry a `scheme`:

- `code` — the ECU reports 4-char DTCs; keyed by hex code.
- `text` — the ECU reports 2-char location codes with descriptive German text;
  keyed on that German text, so it stays correct across ECU variants (the live
  read loads the module's `D_00xx` diagnostic-address group, which lets EDIABAS
  identify the exact variant).

After editing any translation file, regenerate the bundled lookup:

```
node scripts/build-faultdb.mjs    # writes app/renderer/faultdb.js (also validates)
```

`app/renderer/faultdb.js` is generated — never edit it by hand.
