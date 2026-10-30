# Generated files

Nothing in this folder is edited by hand. Most files are written by a tool in
the ms45-emu repo (beside this one): `make export` there rewrites the quick
ones and `make maps` the two slow ones. The module builds come from this
repo's own `npm run build`. Rerun the tool, then commit the result here.

| File | Generator (ms45-emu) | Target |
| --- | --- | --- |
| `fast-flasher-blob.js` | `tools/export/fast_flasher_js.py` | `make export` |
| `bl-blob.js` | `tools/export/bl_js.py` (installs BL) | `make export` |
| `livetune-blob.js` | `tools/export/livetune_js.py` | `make export` |
| `comfort-live.js` | `tools/export/comfort_live.py` | `make export` |
| `ms45-cursor-map.js` | `tools/export/livetune_cursor.py` | `make maps` |
| `ms45-value-map.js` | `tools/export/values_map.py` | `make maps` |
| `bytes.js` | BMWeb's own `scripts/build/bundle-modules.mjs`, from `core/bytes/` | `npm run build` |
