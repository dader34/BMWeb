# Third-party notices

## MS45-Flasher (GPLv3)

The DME firmware read path in `app/renderer/core/flasher.js` and the image
validation math in `tools/verify/test_ms45_bin.js` are ported from
[terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher),
licensed under GPLv3. The original source is vendored at `vendor/ms45-flasher/`.

Because this project incorporates GPLv3 code, BMWeb is distributed under GPLv3.
See `LICENSE`.

## fzstd (MIT)

`app/renderer/vendor/fzstd.js` is [101arrowz/fzstd](https://github.com/101arrowz/fzstd)
0.1.1 by Arjun Barrett, a Zstandard decompressor in JavaScript, licensed under
MIT. The app unpacks its data packs with it. The file is the package's own
source inside a small wrapper, and carries its licence text and where it came
from at its top.

## EdiabasLib

The in-browser virtual machine and transport were written against
[uholeschak/ediabaslib](https://github.com/uholeschak/ediabaslib) (Apache 2.0)
as the reference for EDIABAS behaviour. No EdiabasLib code ships in the app;
a local copy at `vendor/ediabaslib-src/` (not in the repo) is only consulted
when reading the reference.

## BMW EDIABAS / INPA data

`vendor/EDIABAS/` and `vendor/EC-APPS/` are BMW proprietary diagnostic data (SGBD
.prg files, INPA .ipo configs). Neither they nor anything generated from them
(`data/`, `app/renderer/data/`) is part of this repository, which holds the
tools and the app only. `scripts/setup/fetch_repo_data.py` fetches the
generated data a build reads, and with it the patched GS20 transmission program
image (`app/renderer/data/gs20_7552700_readpatch_program.bin`), which is BMW's
program and is not in this repository either.
