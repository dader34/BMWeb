/**
 * @file BMWeb Scanner: the reference scanner's own fault-memory and Clear
 * DTC procedures, telegram for telegram.
 *
 * Read off a USB capture of BMW Scanner 1.4.0.7 doing car ident, a scan and
 * Clear DTC on an E46 (the adapter echoes every telegram it puts on the
 * K line; decoded tables in ~/Desktop/BMW Stuff/PASoft-ghidra/
 * live-dump-2026-11-09/capture-words.txt and capture-frames.txt), and off
 * its clear routine (0x6C19DC) for the waits and the order. The telegrams
 * here are exactly the ones the reference's adapter sent; this file only
 * says WHAT to send and how to read the answers -- the link that carries
 * them (K+DCAN raw exchange, or the reference's own cable) is passed in.
 */

/* exported SCANNER_KWP_ADDRESS, scannerKwpAddress, scannerReadCounts, scannerClearProc, scannerProcLink */

/**
 * The address a module answers KWP2000 on, where it is not its DS2 one
 * (the reference's record +0x588). The E46 DSC answers on 0x29, not 0x56.
 */
const SCANNER_KWP_ADDRESS = {
  EGS: 0x18,
  ABS: 0x29,
  GR2: 0x02,
  SHD: 0x44,
  EKP: 0x17,
};

/**
 * @param {ScannerModule} m
 * @returns {number} The KWP2000 target address.
 */
const scannerKwpAddress = (m) =>
  SCANNER_KWP_ADDRESS[m.name] != null ? SCANNER_KWP_ADDRESS[m.name] : m.address;

/** Modules whose fault count the reference reads with a bare DS2 04. */
const SCANNER_COUNT_BARE = ['SHD', 'AIC'];

/** Modules whose shadow memory the reference reads (DS2 14 00). */
const SCANNER_SHADOW = ['SRS', 'ZKE', 'TEL', 'SZM'];

/** The reference's busy back-off: DS2 A1 / KWP 7F xx 21|23, then one resend. */
const SCANNER_BUSY_MS = 1200;

/**
 * A link the procedures send through.
 * @typedef {object} ScannerLink
 * @property {(addr: number, payload: number[]) => Promise<number[]>} ds2 -
 *   One DS2 telegram; resolves to the module's whole answer frame.
 * @property {(addr: number, payload: number[]) => Promise<number[]>} kwp -
 *   One KWP2000* telegram (B8 addr F1 len ...); resolves to the answer frame.
 * @property {(ms: number) => Promise<void>} sleep
 */

/**
 * Send a DS2 telegram with the reference's busy rule: an A1 answer is asked
 * again once after 1.2 s (its SRS clear answered A1, then A0 1.28 s later).
 * @param {ScannerLink} link
 * @param {number} addr
 * @param {number[]} payload
 * @returns {Promise<number[]|null>} The answer, null on silence.
 */
async function ds2Busy(link, addr, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await link.ds2(addr, payload);
    } catch (e) {
      return null;
    }
    if (r && r[2] === 0xa1 && attempt === 0) {
      await link.sleep(SCANNER_BUSY_MS);
      continue;
    }
    return r;
  }
  return null;
}

/**
 * Send a KWP2000 telegram with the reference's busy rule (7F xx 21 / 23:
 * once more after 1.2 s; 7F xx 78 is waited out by the link itself).
 * @param {ScannerLink} link
 * @param {number} addr
 * @param {number[]} payload
 * @returns {Promise<number[]|null>}
 */
async function kwpBusy(link, addr, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await link.kwp(addr, payload);
    } catch (e) {
      return null;
    }
    if (
      r &&
      r[4] === 0x7f &&
      (r[6] === 0x21 || r[6] === 0x23) &&
      attempt === 0
    ) {
      await link.sleep(SCANNER_BUSY_MS);
      continue;
    }
    return r;
  }
  return null;
}

/**
 * The SRS's access before its shadow memory and its clear: 90 FF FF, then
 * 95 with four bytes of its own identification answer (bytes 11-14:
 * "33 04 08 33" on the captured car).
 * @param {ScannerLink} link
 * @param {number} addr
 * @param {number[]|null} identRaw - The SRS's DS2 identification answer.
 * @returns {Promise<void>}
 */
async function srsAccess(link, addr, identRaw) {
  await ds2Busy(link, addr, [0x90, 0xff, 0xff]);
  if (identRaw && identRaw.length > 14)
    await ds2Busy(link, addr, [0x95, ...identRaw.slice(11, 15)]);
}

/**
 * The fault and shadow-memory counts, as the reference reads them: DS2
 * 04 00 (byte 3 of the answer is the count), 14 00 for the shadow memory
 * of the modules that have one; KWP2000 18 02 FF FF (byte 5).
 * @param {ScannerLink} link
 * @param {ScannerModule} m
 * @param {{kwp: boolean, raw: number[]|null}} found - How it identified.
 * @returns {Promise<{errors: number|null, shadow: number|null}>}
 */
async function scannerReadCounts(link, m, found) {
  if (found.kwp) {
    const r = await kwpBusy(
      link,
      scannerKwpAddress(m),
      [0x18, 0x02, 0xff, 0xff]
    );
    return { errors: r && r[4] === 0x58 ? r[5] : null, shadow: null };
  }
  // the count read is 04 00, except on the modules the reference asks with a
  // bare 04 (its E350: the SHD answers 04 00 with B0)
  const r = await ds2Busy(
    link,
    m.address,
    SCANNER_COUNT_BARE.includes(m.name) ? [0x04] : [0x04, 0x00]
  );
  const errors = r && r[2] === 0xa0 && r.length > 4 ? r[3] : null;
  let shadow = null;
  if (SCANNER_SHADOW.includes(m.name)) {
    if (m.name === 'SRS') await srsAccess(link, m.address, found.raw);
    const s = await ds2Busy(link, m.address, [0x14, 0x00]);
    shadow = s && s[2] === 0xa0 && s.length > 4 ? s[3] : null;
  }
  return { errors, shadow };
}

/**
 * Clear one module the way the reference does (0x6C19DC, and what its
 * adapter put on the line):
 *   KWP2000      14 FF FF; refused (7F) -> 14 00 00; then 1 s
 *   DME, EGS     05, then 9E; then 3 s
 *   A/C, DSP     05, then 9F; then 3 s
 *   SRS          (access) 05, A1 busy asked again; then 3 s
 *   LCM          05 01 .. 05 08, 0.3 s after each
 *   ZKE          05 00 00
 *   ABS (DS2)    05; then 0.5 s
 *   every other  05
 * and two seconds more before the module is read again, for every module.
 * @param {ScannerLink} link
 * @param {ScannerModule} m
 * @param {{kwp: boolean, raw: number[]|null}} found
 * @returns {Promise<{sent: string[], ok: boolean}>} What was sent (hex), and
 *   whether the module accepted the clear.
 */
async function scannerClearProc(link, m, found) {
  const sent = [];
  const hex = (p) => p.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const ok = (r) => !!r && r[2] === 0xa0;
  const ds2 = async (p) => {
    sent.push(hex(p));
    return ds2Busy(link, m.address, p);
  };
  let accepted;
  if (found.kwp) {
    const addr = scannerKwpAddress(m);
    sent.push('14 ff ff');
    let r = await kwpBusy(link, addr, [0x14, 0xff, 0xff]);
    if (!r || r[4] === 0x7f) {
      sent.push('14 00 00');
      r = await kwpBusy(link, addr, [0x14, 0x00, 0x00]);
    }
    accepted = !!r && r[4] === 0x54;
    await link.sleep(1000);
  } else if (m.name === 'LCM') {
    accepted = true;
    for (let blk = 1; blk <= 8; blk++) {
      accepted = ok(await ds2([0x05, blk])) && accepted;
      await link.sleep(300);
    }
  } else if (m.name === 'ZKE') {
    accepted = ok(await ds2([0x05, 0x00, 0x00]));
  } else {
    if (m.name === 'SRS') await srsAccess(link, m.address, found.raw);
    accepted = ok(await ds2([0x05]));
    if (['DME', 'DME2', 'EGS'].includes(m.name)) await ds2([0x9e]);
    if (['A/C', 'DSP'].includes(m.name)) await ds2([0x9f]);
    if (['DME', 'DME2', 'EGS', 'A/C', 'DSP', 'SRS'].includes(m.name))
      await link.sleep(3000);
    else if (m.name === 'ABS') await link.sleep(500);
  }
  await link.sleep(2000);
  return { sent, ok: accepted };
}

/**
 * The link over BMWeb's own cable: raw DS2 and KWP2000* telegrams through
 * the bus exchange, under one bus lock per call (the caller holds none).
 * @param {(out: number[], comm: CommParams) => Promise<number[]>} exchange -
 *   webBusRawExchange (inside withBusLock) or a test double.
 * @param {(fn: () => Promise<any>) => Promise<any>} lock - withBusLock.
 * @returns {ScannerLink}
 */
function scannerProcLink(exchange, lock) {
  const ds2Comm = {
    concept: 6,
    baud: 9600,
    timeout: 600,
    regen: 30,
    timeoutNr78: null,
    repeats: 0,
    answerLen: [-1, 0],
  };
  const kwpComm = {
    concept: 0x10d,
    baud: 9600,
    timeout: 800,
    regen: 25,
    timeoutNr78: 5000,
    repeats: 0,
  };
  return {
    ds2: (addr, payload) =>
      lock(() => exchange([addr, payload.length + 3, ...payload], ds2Comm)),
    kwp: (addr, payload) =>
      lock(() =>
        exchange([0xb8, addr, 0xf1, payload.length, ...payload], kwpComm)
      ),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCANNER_KWP_ADDRESS,
    SCANNER_SHADOW,
    scannerKwpAddress,
    scannerReadCounts,
    scannerClearProc,
    scannerProcLink,
  };
}
