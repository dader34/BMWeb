// Flashing/Tuning: the programming-log (AIF/UIF) wire client, the protocol
// the AIF editor page drives. BENCH ONLY (localhost), like the fast flasher
// it rides on.
//
// Everything here was proven on the emulator against the BL14 loader image
// (ms45-emu tools/aif_editor_test.py, 2026-10-27, ALL OK) over the same
// services the page can already reach -- READ anywhere, SECTOR_QUERY,
// CHUNK, VERIFY and the v11+ marker ladder the AIF wipe uses:
//
//   writeDirect  a bit-clear-only edit of one or more slots, no erase:
//                per edit ARM -> CHUNK -> VERIFY -> DONE. The body's own
//                read-back refuses a chunk that would set bits (NAK 4), so
//                a mis-classified edit fails safe.
//   rewrite      the whole 96 KB boot sector, because the log shares its
//                erase block with the loader: the sector below the log is
//                either checked against a trusted file (one QUERY CRC) or
//                read off the DME, the new log spliced in, then
//                ARM -> ERASE -> blank-check -> CHUNK x24 -> VERIFY -> DONE.
//                The loader comes back byte-identical; between the ERASE and
//                the restore the DME holds no loader, which the page's
//                confirm says plainly.
//
// Both paths spend one marker-ladder slot per ARM/DONE (64 exist) and
// re-read the ladder after every step: an ARMED marker from an interrupted
// attempt is resumed, a DONE one means the ladder is spent and nothing is
// erased, and any other value is a foreign tail -- nothing was written.

/** Where the log and its sector sit (fastFlashWire carries the same numbers). */
const AIF_LOG_START = 0x1fb34;
const AIF_LOG_END = 0x20000;
const AIF_LOG_LEN = AIF_LOG_END - AIF_LOG_START; // 0x4CC
const AIF_SECTOR = 0x8000; // the boot sector the log ends in
const AIF_SECTOR_LEN = AIF_LOG_END - AIF_SECTOR; // 0x18000 = 24 x 4 KB
const AIF_CHUNK = 0x1000;

// the wire's constants and CRC: a later classic script sees the page's
// fastFlashWire; the verify harness loads this file as a module
const aifWire =
  typeof fastFlashWire !== 'undefined'
    ? fastFlashWire
    : require('./fast-flasher-wire.js').fastFlashWire;

/**
 * The marker ladder as the DME reports it: fresh, the ARM of an attempt
 * that never committed, or spent-through (the body answers DONE when every
 * slot is used). @param {number} mk @returns {string}
 */
function aifLadderName(mk) {
  const M = aifWire.MARK;
  return mk === M.FRESH
    ? 'fresh'
    : mk === M.ARMED
      ? 'armed (an interrupted attempt)'
      : mk === M.DONE
        ? 'spent through'
        : `0x${mk.toString(16)} (a foreign tail)`;
}

/**
 * Reach an ARMED marker: arm a fresh one, accept one already armed (the
 * erase of that attempt never completed), refuse anything else.
 * @param {FastFlashClient} client
 * @param {(msg: string) => void} log
 * @returns {Promise<void>}
 */
async function aifLadderArm(client, log) {
  const M = aifWire.MARK;
  let mk = await client.aifRead();
  log(`marker ${aifLadderName(mk)}`);
  if (mk === M.DONE)
    throw new Error(
      'every AIF marker slot on this DME is spent; nothing was written'
    );
  if (mk === M.FRESH) {
    await client.aifArm();
    mk = await client.aifRead();
    if (mk !== M.ARMED) throw new Error('the AIF marker did not arm');
  } else if (mk !== M.ARMED) {
    throw new Error(
      `the AIF marker reads ${aifLadderName(mk)}: not this build's ladder; nothing was written`
    );
  }
}

/**
 * Close an armed marker and check the ladder moved on.
 * @param {FastFlashClient} client
 * @returns {Promise<void>}
 */
async function aifLadderDone(client) {
  await client.aifDone();
  if ((await client.aifRead()) === aifWire.MARK.ARMED)
    throw new Error('the AIF marker is still armed after the commit');
}

/**
 * The no-erase write: program each edit's bytes straight over the slot it
 * belongs to. Only works while every edit only CLEARS bits -- the DME's
 * read-back-compare refuses anything that would set them (NAK 4), which
 * surfaces as "would not take".
 * @param {FastFlashClient} client
 * @param {{at: number, bytes: Uint8Array}[]} edits
 * @param {{stage: (s: string) => void, progress: (pct: number) => void, note: (msg: string) => void}} cb
 * @returns {Promise<void>}
 */
async function aifWriteDirect(client, edits, cb) {
  if (!edits.length) throw new Error('writeDirect with no edits');
  for (const e of edits) {
    if (e.at < AIF_LOG_START || e.at + e.bytes.length > AIF_LOG_END)
      throw new Error(`edit at 0x${e.at.toString(16)} is outside the log`);
    if (e.bytes.length % 2 || e.bytes.length > 4096)
      throw new Error(
        `edit at 0x${e.at.toString(16)}: ${e.bytes.length} bytes (even, at most 4096)`
      );
  }
  cb.stage(
    `Writing ${edits.length} slot${edits.length === 1 ? '' : 's'} directly (no erase)`
  );
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const pct = Math.floor((i * 100) / edits.length);
    cb.progress(pct);
    await aifLadderArm(client, cb.note);
    try {
      await client.chunk(e.at, e.bytes);
      await client.verify(e.at, e.bytes.length, aifWire.crc32(e.bytes) >>> 0);
    } catch (err) {
      if (err && err.reason === 4)
        throw new Error(
          `the DME refused the chunk at 0x${e.at.toString(16)} (the bytes would not take): ` +
            'the edit sets bits over what the slot holds, so it needs the rewrite path. ' +
            'Bits may have been cleared part-way -- read the log again.',
          { cause: err }
        );
      throw err;
    }
    await aifLadderDone(client);
    cb.note(
      `slot at 0x${e.at.toString(16)} written and verified (${i + 1}/${edits.length})`
    );
  }
  cb.progress(100);
}

/**
 * The boot-sector rewrite: the log cannot be erased alone, so the whole
 * sector goes -- the loader with it -- and comes back byte-identical with
 * the new log spliced in at its end.
 *
 * The sector below the log is taken from `opts.sector` (a whole
 * [0x8000, 0x20000) image, e.g. the loaded flash file) when its
 * below-the-log span matches the chip by CRC, else read off the DME; the
 * read happens BEFORE the marker is armed, so nothing is committed until
 * every byte the restore needs is in hand.
 * @param {FastFlashClient} client
 * @param {Uint8Array} aif - The new log, exactly 0x4CC bytes.
 * @param {{stage: (s: string) => void, progress: (pct: number) => void, note: (msg: string) => void}} cb
 * @param {{sector?: Uint8Array}} [opts]
 * @returns {Promise<void>}
 */
async function aifRewrite(client, aif, cb, opts = {}) {
  if (aif.length !== AIF_LOG_LEN)
    throw new Error(`the log must be ${AIF_LOG_LEN} bytes (got ${aif.length})`);
  const crc = aifWire.crc32;
  const blank = crc(new Uint8Array(AIF_SECTOR_LEN).fill(0xff)) >>> 0;

  // ---- everything the restore needs, before anything is committed -------
  let below;
  const have = opts.sector || null;
  if (have && have.length === AIF_SECTOR_LEN) {
    const want = crc(have.subarray(0, AIF_LOG_START - AIF_SECTOR)) >>> 0;
    const dme =
      (await client.sectorQuery(AIF_SECTOR, AIF_LOG_START - AIF_SECTOR)) >>> 0;
    if (dme === want) {
      below = have.subarray(0, AIF_LOG_START - AIF_SECTOR);
      cb.note('the boot content below the log matches the chip (one CRC)');
    } else cb.note('the sector in hand does not match the chip; reading it');
  } else if (have)
    throw new Error(`opts.sector must be ${AIF_SECTOR_LEN} bytes`);
  if (!below) {
    cb.stage('Reading the boot sector off the DME');
    below = await aifWire.readArea(
      client,
      AIF_SECTOR,
      AIF_LOG_START - AIF_SECTOR,
      (n) => cb.progress(Math.floor((n * 30) / (AIF_LOG_START - AIF_SECTOR)))
    );
  }
  const sector = new Uint8Array(AIF_SECTOR_LEN);
  sector.set(below, 0);
  sector.set(aif, AIF_LOG_START - AIF_SECTOR);

  // ---- the ladder, then the committed window -----------------------------
  await aifLadderArm(client, cb.note);
  cb.stage('Erasing the boot sector (the loader with it)');
  cb.note('erasing: committed until the restore lands');
  await client.erase(AIF_SECTOR);
  const got = (await client.sectorQuery(AIF_SECTOR, AIF_SECTOR_LEN)) >>> 0;
  if (got !== blank)
    throw new Error(
      'the boot sector did not read blank after ERASE (hardware-protected?)'
    );
  cb.note('the sector is blank; restoring it with the edited log');

  cb.stage('Rewriting the boot sector');
  const chunks = AIF_SECTOR_LEN / AIF_CHUNK;
  for (let i = 0; i < chunks; i++) {
    await client.chunk(
      AIF_SECTOR + i * AIF_CHUNK,
      sector.subarray(i * AIF_CHUNK, (i + 1) * AIF_CHUNK)
    );
    cb.progress(30 + Math.floor(((i + 1) * 55) / chunks));
  }
  await client.verify(AIF_SECTOR, AIF_SECTOR_LEN, crc(sector) >>> 0);
  await aifLadderDone(client);
  cb.note('the sector is rewritten and verified; the marker is DONE');
  cb.progress(100);
}

/** The AIF editor's wire client, consumed by screens/flashing/aif-editor.js. */
const aifLog = {
  LOG_START: AIF_LOG_START,
  LOG_END: AIF_LOG_END,
  LOG_LEN: AIF_LOG_LEN,
  SECTOR: AIF_SECTOR,
  SECTOR_LEN: AIF_SECTOR_LEN,
  writeDirect: aifWriteDirect,
  rewrite: aifRewrite,
};

if (typeof window !== 'undefined') {
  window.aifLog = aifLog;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { aifLog };
}
