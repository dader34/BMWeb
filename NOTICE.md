# Third-party notices

## MS45-Flasher (GPLv3)

The DME firmware read path in `app/renderer/core/flasher.js` and the image
validation math in `tools/verify/test_ms45_bin.js` are ported from
[terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher),
licensed under GPLv3. The original source is vendored at `vendor/ms45-flasher/`.

Because this project incorporates GPLv3 code, BMWeb is distributed under GPLv3.
See `LICENSE`.

## EdiabasLib

The in-browser virtual machine and transport were written against
[uholeschak/ediabaslib](https://github.com/uholeschak/ediabaslib) (Apache 2.0)
as the reference for EDIABAS behaviour. No EdiabasLib code ships in the app;
a local copy at `vendor/ediabaslib-src/` (not in the repo) is only consulted
when reading the reference.

## BMW EDIABAS / INPA data

`vendor/EDIABAS/` and `vendor/EC-APPS/` are BMW proprietary diagnostic data (SGBD
.prg files, INPA .ipo configs). They are NOT redistributed and are excluded from
this repository. Supply your own copy (BMW Standard Tools) to run the app.
