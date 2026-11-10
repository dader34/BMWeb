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

/* exported SCANNER_KWP_ADDRESS, SCANNER_COMM, scannerKwpAddress, scannerReadCounts, scannerClearProc, scannerProcLink, scannerPasoftWord, scannerPasoftLink */

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
 * The line parameters, in one place. Identification asks sixty units, most
 * of them not fitted, so it waits less for an answer than the procedures do.
 */
const SCANNER_COMM = {
  ds2Ident: {
    concept: 6,
    baud: 9600,
    timeout: 400,
    regen: 30,
    timeoutNr78: null,
    repeats: 0,
    answerLen: [-1, 0],
  },
  kwpIdent: {
    concept: 0x10d,
    baud: 9600,
    timeout: 600,
    regen: 25,
    timeoutNr78: 5000,
    repeats: 0,
  },
  ds2: {
    concept: 6,
    baud: 9600,
    timeout: 600,
    regen: 30,
    timeoutNr78: null,
    repeats: 0,
    answerLen: [-1, 0],
  },
  kwp: {
    concept: 0x10d,
    baud: 9600,
    timeout: 800,
    regen: 25,
    timeoutNr78: 5000,
    repeats: 0,
  },
};

/**
 * The link over BMWeb's own cable: raw DS2 and KWP2000* telegrams through
 * the bus exchange, under one bus lock per call (the caller holds none).
 * @param {(out: number[], comm: CommParams) => Promise<number[]>} exchange -
 *   webBusRawExchange (inside withBusLock) or a test double.
 * @param {(fn: () => Promise<any>) => Promise<any>} lock - withBusLock.
 * @returns {ScannerLink}
 */
function scannerProcLink(exchange, lock) {
  return {
    ds2: (addr, payload) =>
      lock(() =>
        exchange([addr, payload.length + 3, ...payload], {
          ...SCANNER_COMM.ds2,
        })
      ),
    kwp: (addr, payload) =>
      lock(() =>
        exchange([0xb8, addr, 0xf1, payload.length, ...payload], {
          ...SCANNER_COMM.kwp,
        })
      ),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * The reference adapter's command word for a telegram. Its cable takes no
 * telegrams, only words; each row here is a word whose telegram the adapter
 * echoed in the USB captures (capture-words.txt), so the same procedure
 * drives either cable.
 * @param {'ds2'|'kwp'} kind
 * @param {number[]} pl - The telegram's payload (after address and length).
 * @returns {{word: number, payload: number[], mode: number}|null} Null for a
 *   telegram no captured word produces.
 */
function scannerPasoftWord(kind, pl) {
  const n = pl.length;
  const is = (...b) => n === b.length && b.every((x, i) => x === pl[i]);
  const w = (word, payload = []) => ({
    word,
    payload,
    mode: kind === 'kwp' ? 3 : 2,
  });
  if (kind === 'kwp') {
    if (is(0x1a, 0x80)) return w(0x06f3);
    if (is(0x18, 0x02, 0xff, 0xff)) return w(0xc358);
    if (n === 3 && pl[0] === 0x17) return w(0x4ee3, pl.slice(1));
    if (is(0x14, 0xff, 0xff)) return w(0x41ac);
    if (is(0x14, 0x00, 0x00)) return w(0xc370);
    return null;
  }
  if (is(0x00)) return w(0x46f1);
  if (is(0x02, 0x02)) return w(0xc6e1);
  if (is(0x02, 0x01)) return w(0x8de3);
  if (is(0x02, 0x00)) return w(0xa370);
  if (is(0x04)) return w(0xe350);
  if (n === 2 && pl[0] === 0x04) return w(0xc731, [pl[1]]);
  if (n === 2 && pl[0] === 0x14) return w(0x9e56, [pl[1]]);
  if (n === 2 && pl[0] === 0x15) return w(0x79de, [pl[1]]);
  if (is(0x0e)) return w(0x71a0);
  if (is(0x05)) return w(0x1bcf);
  if (is(0x05, 0x00, 0x00)) return w(0xc6a3);
  if (n === 2 && pl[0] === 0x05) return w(0xe390, [pl[1]]);
  if (is(0x9e)) return w(0xe245);
  if (is(0x9f)) return w(0x4ed1);
  if (is(0x90, 0xff, 0xff)) return w(0x44db);
  if (n === 5 && pl[0] === 0x95) return w(0xc751, pl.slice(1));
  if (n === 6 && pl[0] === 0x06 && pl[1] === 0x03 && pl[2] === 0x00)
    return w(0xc563, pl.slice(3));
  if (n === 5 && pl[0] === 0x06 && pl[1] === 0x10)
    return w(0x514c, pl.slice(2));
  if (n === 4 && pl[0] === 0x07) return w(0xa394, pl.slice(1));
  return null;
}

/**
 * The same link over the reference's own cable: every telegram becomes its
 * adapter word. A telegram without one is refused by name -- it is not a
 * silent unit. The procedures do the busy asking themselves, so the cable is
 * told not to (one rule for both cables).
 * @param {{run: (fn: (port: any) => Promise<any>) => Promise<any>}} cable -
 *   pasoftCable.
 * @returns {ScannerLink & {word: (w: number, addr: number, payload: number[]) => Promise<number[]|null>}}
 */
function scannerPasoftLink(cable) {
  const hex = (p) => p.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const answer = (r) =>
    r && r.reply && ['ok', 'busy', 'negative'].includes(r.status)
      ? Array.from(r.reply)
      : null;
  const send = (kind) => async (addr, pl) => {
    const w = scannerPasoftWord(kind, pl);
    if (!w) {
      const e = new Error(
        `not supported on the BMW Scanner cable: ${kind.toUpperCase()} ${hex(pl)}`
      );
      e.unsupported = true;
      throw e;
    }
    return answer(
      await cable.run((port) =>
        port.transfer(w.word, addr, w.payload, w.mode, { retries: 0 })
      )
    );
  };
  return {
    ds2: send('ds2'),
    kwp: send('kwp'),
    // an adapter word the captures did not show the telegram of
    word: async (w, addr, pl) =>
      answer(
        await cable.run((port) => port.transfer(w, addr, pl, 2, { retries: 0 }))
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
    scannerPasoftWord,
    scannerPasoftLink,
    SCANNER_COMM,
  };
}
