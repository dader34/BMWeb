# Contributing

## Adding fault-code translations

BMacW reads BMW fault codes over the K+DCAN cable and shows an English
description for each one. Those descriptions live in plain JSON files that
anyone can edit, so adding a translation is a small, easy pull request.

### Where the translations live

```
data/faults/
  dme.json     engine / DME codes      (27xx, 28xx, 29xx, 2Axx, 2Bxx, 2Exx, 2Fxx)
  dsc.json     DSC / ABS / chassis     (5Dxx, 5Exx)
  body.json    body modules            (ZKE5/GM5, windows, locks, mirrors)
  trans.json   transmission            (EGS, SMG)
```

Each file is a flat map of **hex code** to **English description**:

```json
{
  "27DA": "Alternator BSD fault",
  "2761": "Secondary air system, bank 2"
}
```

### How to find a code to add

When BMacW shows a fault it doesn't have an English name for, it falls back to
the raw text from the car (often German). To contribute the translation:

1. Run a fault scan in BMacW (E46 → Functional Jobs → F4 Fault Memory), or read
   a single module.
2. Note the **code** (the short hex like `5E40`, `0B3F`) and the German text
   shown next to it.
3. Open the matching file in `data/faults/` and add a line:

   ```json
   "5E40": "Lateral acceleration signal not plausible, offset"
   ```

### Rules

- **Key**: uppercase hex, 3–5 characters, no dashes. `27DA`, not `27-DA` or `27da`.
- **Description**: short, plain English. Keep it under ~80 characters.
- The code goes in the file for its range (see the table above). If you're not
  sure which file, `dme.json` for engine faults and `body.json` for anything on
  the comfort/body side is a safe default.
- One code per line, no duplicate keys.

### Before you open the PR

Run the checks from the `app/` folder:

```
cd app
npm run check:faults     # validates format, flags duplicates / leftover German
npm run build:faultdb    # regenerates app/renderer/faultdb.js
```

Commit both your edited `data/faults/*.json` and the regenerated
`app/renderer/faultdb.js`. Then open a pull request describing which car and
module the codes came from. That's it — thank you.

### Notes

- `app/renderer/faultdb.js` is generated. Never edit it by hand; edit the JSON
  and run `npm run build:faultdb`.
- Descriptions are best-effort, community-sourced translations, not official BMW
  text. Accuracy improvements are welcome too, not just new codes.
