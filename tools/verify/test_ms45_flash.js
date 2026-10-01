#!/usr/bin/env node
// The MS45 flashing engine (app/renderer/core/ms45.js): the checksums and
// RSA signatures a tune and a program must carry, the security-access
// message, the EWS delete, BMW's .0PA / .0DA exchange files, and the job
// plumbing (binary arguments, telegram shapes) over a stubbed job runner.
//
// WHAT THIS PROVES
//   1. CRC-32 is the MPEG-2 form the DME's loader uses (known-answer vector).
//   2. The calibration and program checksums and signatures reproduce, byte
//      for byte, what stock BMW files carry (when SP-Daten partials and a stock
//      full pair are on disk), and the security-access message agrees with the
//      ECU-backup engine's independently written one.
//   3. The EWS delete applies exactly its four bytes, only to the verified
//      program version, and the halves are judged separately.
//   4. The exchange-file parser assembles a .0DA / .0PA from its records and
//      refuses a short or malformed file.
//   5. flash_loeschen / flash_schreiben_adresse / flash_schreiben carry the
//      reference tool's exact binary arguments, 0xFD-byte segments, and a
//      failed segment resets the DME.
//
// Run: node tools/verify/test_ms45_flash.js
//      MS45_DIR=/path/to/e46bins/MS45-DME node tools/verify/test_ms45_flash.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.Settings = { get: () => 'no' };
const F = require('../../app/renderer/core/flasher.js');
global._md5 = F._md5;
global._modPow = F._modPow;
// flasher.js keeps these two private; the browser build shares them as globals
global._bytesLEToBigInt = (bytes) => {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
};
global._bigIntToBytesLE = (value, outLen) => {
  const o = new Uint8Array(outLen);
  let v = value;
  for (let i = 0; i < outLen; i++) {
    o[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return o;
};
const M = require('../../app/renderer/core/ms45.js');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

(async () => {
  // ── 1. CRC-32/MPEG-2 ───────────────────────────────────────────────────────
  console.log('\ncrc-32');
  assert.strictEqual(
    M.ms45Crc32(Buffer.from('123456789'), 0xffffffff),
    0x0376e6e7
  );
  assert.strictEqual(M.ms45Crc32(new Uint8Array(0), 0x12345678), 0x12345678);
  ok('CRC-32/MPEG-2 known-answer vector');

  // ── 2. real files ───────────────────────────────────────────────────────────
  console.log('\nreal files');
  const dir =
    process.env.MS45_DIR ||
    path.join(process.env.HOME || '', 'Desktop/e46bins/MS45-DME');
  function walk(d, out) {
    if (!fs.existsSync(d)) return out;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  }
  const files = walk(path.join(dir, 'stock-partials'), []);
  let cals = 0;
  for (const p of files) {
    const b = new Uint8Array(fs.readFileSync(p));
    if (b.length !== 0x1d000 && b.length !== 0x20000) continue;
    const c = b.subarray(0, 0x1d000);
    const cc = M.ms45Checksums.correctParameterChecksums(c);
    assert.ok(
      eq(cc.subarray(0x100, 0x104), c.subarray(0x100, 0x104)),
      `${path.basename(p)}: parameter CRC`
    );
    const sig = M.ms45Checksums.signParameters(cc);
    assert.ok(
      eq(sig.subarray(0x174, 0x1b4), c.subarray(0x174, 0x1b4)),
      `${path.basename(p)}: parameter signature`
    );
    cals++;
  }
  if (cals)
    ok(
      `${cals} stock calibrations: CRC and RSA signature reproduced byte for byte`
    );
  else console.log('  skip  stock calibrations (set MS45_DIR to run this)');
  const stockFlash = path.join(
    dir,
    'stock',
    'NJ87379_0044570_Flash_donor_stock.bin'
  );
  const stockMpc = path.join(
    dir,
    'stock',
    'NJ87379_0044570_MPC_donor_stock.bin'
  );
  if (fs.existsSync(stockFlash) && fs.existsSync(stockMpc)) {
    const f = new Uint8Array(fs.readFileSync(stockFlash));
    const m = new Uint8Array(fs.readFileSync(stockMpc));
    const cf = M.ms45Checksums.correctProgramChecksums(f, m);
    assert.ok(
      eq(cf.subarray(0x60000, 0x60004), f.subarray(0x60000, 0x60004)) &&
        eq(cf.subarray(0x60340, 0x60344), f.subarray(0x60340, 0x60344))
    );
    const sf = M.ms45Checksums.signProgram(cf, m);
    assert.ok(eq(sf.subarray(0x60074, 0x600b4), f.subarray(0x60074, 0x600b4)));
    assert.ok(M.ms45VerifyFlashMpcMatch(f, m));
    assert.strictEqual(M.ewsDelete.readProgramVersion(f), '0044570LO02S');
    assert.ok(M.ewsDelete.isApplicable(f) && !M.ewsDelete.isAlreadyPatched(f));
    assert.ok(M.ms45VerifyProgramMatch(f, '0044570'));
    ok(
      'stock full pair: program CRCs and signature reproduced; pair match; EWS stock'
    );
  } else console.log('  skip  stock full pair (set MS45_DIR to run this)');

  // ── 3. security access agrees with the backup engine ───────────────────────
  console.log('\nsecurity access');
  {
    const userId = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
    const serial = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const seed = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const mine = M.ms45Checksums.securityAccessMessage(userId, serial, seed);
    const theirs = F._rsaSecurityMessage(
      F.FLASH_PROFILES[0].security,
      userId,
      serial,
      seed,
      'MS45.1'
    );
    assert.strictEqual(mine.length, 90);
    assert.deepStrictEqual(mine, theirs);
    assert.strictEqual(mine[89], 3, 'access level 3');
    ok(
      "the 90-byte message equals the ECU-backup engine's, written independently"
    );
  }

  // ── 4. EWS delete ──────────────────────────────────────────────────────────
  console.log('\nEWS delete');
  function stockImage() {
    const f = new Uint8Array(M.MS45_FULL_FLASH_LENGTH).fill(0xff);
    f.set(Buffer.from('0044570LO02S'), 0x6031c);
    f[0x48f2c] = 0x10;
    f[0x48f3e] = 0x10;
    f[0xdb1c7] = 0x01;
    f[0xdb1d3] = 0x3f;
    return f;
  }
  {
    const f = stockImage();
    assert.ok(M.ewsDelete.isApplicable(f) && !M.ewsDelete.isAlreadyPatched(f));
    const d = M.ewsDelete.apply(f);
    assert.ok(M.ewsDelete.isAlreadyPatched(d));
    let changed = 0;
    for (let i = 0; i < f.length; i++) if (f[i] !== d[i]) changed++;
    assert.strictEqual(changed, 4, 'exactly four bytes change');
    assert.ok(M.ewsDelete.programBytesAreDeleted(d[0xdb1c7], d[0xdb1d3]));
    assert.ok(M.ewsDelete.calibrationHasStockImmobilizer(f, M.MS45_CAL_START));
    assert.ok(
      M.ewsDelete.calibrationHasDeletedImmobilizer(d, M.MS45_CAL_START)
    );
    const bare = f.subarray(
      M.MS45_CAL_START,
      M.MS45_CAL_START + M.MS45_CAL_LENGTH
    );
    assert.ok(M.ewsDelete.calibrationHasStockImmobilizer(bare, 0));
    const bareDeleted = M.ewsDelete.applyCalibrationDelete(bare, 0);
    assert.ok(M.ewsDelete.calibrationHasDeletedImmobilizer(bareDeleted, 0));
    ok(
      'applies the four bytes to a copy; both halves and the bare-calibration helpers agree'
    );
    // a half already deleted (a stock program over a deleted tune) still applies
    const half = stockImage();
    half[0x48f2c] = 0;
    half[0x48f3e] = 0;
    assert.ok(M.ewsDelete.isApplicable(half));
    // neither stock nor deleted is refused
    const odd = stockImage();
    odd[0xdb1d3] = 0x11;
    assert.ok(!M.ewsDelete.isApplicable(odd));
    assert.throws(
      () => M.ewsDelete.apply(odd),
      /neither stock nor deleted|may already be modified/
    );
    const other = stockImage();
    other.set(Buffer.from('0044570LO00S'), 0x6031c);
    assert.throws(
      () => M.ewsDelete.apply(other),
      /only verified for program version/
    );
    assert.throws(() => M.ewsDelete.apply(new Uint8Array(0x1d000)), /1 MB/);
    assert.strictEqual(M.ewsDelete.describe().length, 4);
    ok(
      'a half-deleted image applies, an odd one and another program are refused'
    );
  }

  // ── 5. exchange files ──────────────────────────────────────────────────────
  console.log('\nexchange files');
  function hexRecord(address, type, data) {
    const bytes = [
      data.length,
      (address >> 8) & 0xff,
      address & 0xff,
      type,
      ...data,
    ];
    const sum = -bytes.reduce((a, b) => a + b, 0) & 0xff;
    return (
      ':' +
      [...bytes, sum]
        .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
        .join('')
    );
  }
  function emit(lines, image, absBase, from, to) {
    for (let page = from - (from % 0x10000); page < to; page += 0x10000) {
      const abs = absBase + page;
      lines.push(hexRecord(0, 0x02, [0, 0]));
      lines.push(hexRecord(0, 0x04, [(abs >> 24) & 0xff, (abs >> 16) & 0xff]));
      for (
        let o = Math.max(page, from);
        o < Math.min(page + 0x10000, to);
        o += 32
      ) {
        const n = Math.min(32, to - o);
        lines.push(
          hexRecord(o - page, 0x00, Array.from(image.subarray(o, o + n)))
        );
      }
    }
  }
  {
    const cal = new Uint8Array(M.MS45_CAL_LENGTH);
    for (let i = 0; i < cal.length; i++) cal[i] = (i * 7 + 3) & 0xff;
    cal.set(Buffer.from('457O0L'), 8);
    const lines = ['$REFERENZ 0044570LO00S E', ';; header'];
    emit(lines, cal, 0x2040000, 0, cal.length);
    lines.push(':00000001FF');
    const r = M.ms45ExchangeFile.decodeCalibrationText(lines.join('\r\n'));
    assert.deepStrictEqual(r.data, cal);
    assert.strictEqual(r.reference, '0044570LO00S');
    assert.strictEqual(
      M.ms45ExchangeFile.calibrationProjectToken(r.data),
      '457O0L'
    );
    ok(
      'a .0DA assembles to the 0x1D000 calibration with its reference and project token'
    );
    assert.throws(
      () =>
        M.ms45ExchangeFile.decodeCalibrationText(lines.slice(0, -1).join('\n')),
      /no end record/
    );
    assert.throws(
      () =>
        M.ms45ExchangeFile.decodeCalibrationText(
          lines.filter((l, i) => i !== 40).join('\n')
        ),
      /incomplete/
    );
    const tampered = lines.slice();
    tampered[10] = tampered[10].slice(0, -2) + '00';
    assert.throws(
      () => M.ms45ExchangeFile.decodeCalibrationText(tampered.join('\n')),
      /checksum/
    );
    ok(
      'a file without its end record, with a hole, or with a bad record checksum is refused'
    );
  }
  {
    const flash = new Uint8Array(M.MS45_FULL_FLASH_LENGTH).fill(0xff);
    const mpc = new Uint8Array(M.MS45_MPC_LENGTH);
    for (let i = 0; i < mpc.length; i++) mpc[i] = (i * 3 + 1) & 0xff;
    for (let i = 0x60000; i < 0xfff40; i++) flash[i] = (i * 5 + 2) & 0xff;
    flash.set(Buffer.from('457O0L'), 0x60302);
    const lines = ['$REFERENZ 0044570LO02S E'];
    emit(lines, mpc, 0, 0, mpc.length);
    emit(lines, flash, 0x2000000, 0x60000, 0x600b4);
    emit(lines, flash, 0x2000000, 0x60100, 0xfff40);
    lines.push(':00000001FF');
    const r = M.ms45ExchangeFile.decodeProgramText(lines.join('\n'));
    assert.deepStrictEqual(r.mpc, mpc);
    assert.ok(
      eq(r.flash.subarray(0x60100, 0xfff40), flash.subarray(0x60100, 0xfff40))
    );
    assert.ok(
      r.flash.subarray(0, 0x60000).every((b) => b === 0xff),
      'no calibration, no boot area'
    );
    assert.strictEqual(
      M.ms45ExchangeFile.programProjectToken(r.flash),
      '457O0L'
    );
    assert.ok(
      M.ms45ExchangeFile.isMatchingPair(r.flash, Buffer.from('xxxxxxxx457O0L'))
    );
    ok(
      'a .0PA fills the MPC and the external program with the header gap, nothing else'
    );
    assert.ok(
      M.ms45ExchangeFile.isProgramFile('7552700A.0PA') &&
        M.ms45ExchangeFile.isDataFile('P7561517.0da')
    );
  }

  // ── 6. jobs over a stubbed runner ──────────────────────────────────────────
  console.log('\njobs');
  {
    const calls = [];
    global.webRunJob = async (sgbd, job, arg) => {
      calls.push({ sgbd, job, arg });
      if (
        job === 'flash_schreiben' &&
        calls.filter((c) => c.job === 'flash_schreiben').length === 3
      )
        return { sets: [{ JOB_STATUS: 'ERROR_ECU' }] };
      return {
        sets: [
          { JOB_STATUS: 'OKAY', _TEL_AUFTRAG: '01-02', _TEL_ANTWORT: '03' },
        ],
      };
    };
    const traced = [];
    M.ms45SetJobTrace((job, arg, status, tx, rx) =>
      traced.push({ job, arg, status, tx, rx })
    );
    assert.ok(await M.ms45Erase(0x2040000, 0x20000));
    const erase = calls[0];
    assert.strictEqual(erase.sgbd, 'ms450ds0');
    assert.strictEqual(erase.job, 'flash_loeschen');
    const eb = Array.from(erase.arg, (c) => c.charCodeAt(0));
    assert.strictEqual(eb.length, 22);
    assert.deepStrictEqual(
      eb.slice(13, 21),
      [0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x04, 0x02],
      'length then start, little-endian'
    );
    assert.strictEqual(eb[0], 1);
    assert.strictEqual(eb[4], 0xfe);
    ok(
      'flash_loeschen carries the 22-byte binary argument the reference tool sends'
    );
    calls.length = 0;
    const data = new Uint8Array(0xfd * 2 + 10);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const stages = [];
    const okWrite = await M.ms45FlashBlock(
      data,
      0x2040000,
      0x2040000 + data.length - 1,
      { onStage: (s) => stages.push(s) }
    );
    assert.ok(!okWrite, 'the third segment is refused by the stub');
    assert.strictEqual(calls[0].job, 'flash_schreiben_adresse');
    const ab = Array.from(calls[0].arg, (c) => c.charCodeAt(0));
    assert.strictEqual(ab[21], 3);
    const writes = calls.filter((c) => c.job === 'flash_schreiben');
    assert.strictEqual(writes.length, 3);
    const w0 = Array.from(writes[0].arg, (c) => c.charCodeAt(0));
    assert.strictEqual(w0.length, 21 + 0xfd + 1);
    assert.strictEqual(w0[13], 0xfd);
    assert.deepStrictEqual(w0.slice(17, 21), [0x00, 0x00, 0x04, 0x02]);
    assert.strictEqual(w0[w0.length - 1], 3);
    assert.deepStrictEqual(
      w0.slice(21, 21 + 0xfd),
      Array.from(data.subarray(0, 0xfd))
    );
    const w2 = Array.from(writes[2].arg, (c) => c.charCodeAt(0));
    assert.strictEqual(w2[13], 10, 'the last segment is the remainder');
    assert.strictEqual(
      calls[calls.length - 1].job,
      'STEUERGERAETE_RESET',
      'a failed segment resets the DME'
    );
    assert.ok(stages.some((s) => /Flash failed at 0x20401FA/.test(s)));
    assert.ok(
      traced.length >= 5 &&
        traced[0].job === 'flash_loeschen' &&
        traced[0].status === 'OKAY'
    );
    ok(
      'flash_schreiben: 0xFD-byte segments with the 21-byte header and trailing 3; a refusal resets; every job traced'
    );
    M.ms45SetJobTrace(null);
    global.webRunJob = async () => {
      throw new Error('no cable');
    };
    const r = await M.ms45Job('IDENT', '');
    assert.ok(!r.ok && /no cable/.test(r.error));
    ok(
      'a thrown job is a failure, not an exception, like the reference ExecuteJob'
    );
  }

  console.log(`\nms45: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
