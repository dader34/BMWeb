// Flashing/Tuning: the EWS/ISN matcher's EWS-side client. BENCH ONLY
// (localhost), like the rest of the flash lane.
//
// The EWS3 answers at DS2 address 0x44 on the K-line; the telegrams come
// from our own mined INPA rip (ews job-code JSON) and the M5.2.1 EWS3.3
// thread on MHH: the ISN is TWO bytes, big-endian, reply bytes [3..4],
// stored with 3-way redundancy on the module. Everything here rides the
// webshim DS2 wire the coding screens already use -- transfer(0x44, job)
// -- so the matcher page needs no transport of its own.
//
// Scope is deliberately the legitimate repair flow: read the ISN from the
// module, compare it with the DME's (the EEPROM dump, see EWS-ISN.md),
// and write a new ISN ONLY through the factory job -- a module that
// wants a password first answers ERROR_NO_PASSWORD and the attempt ends
// there. No password material is carried here.

/** The EWS3's K-line address. */
const EWS_ADDR = 0x44;

/** Job bytes the mined SGBD actually sends (docs/EWS-ISN.md has the table). */
const JOB = {
  IDENT: 0x00,
  READ_ISN: 0x60,
  WRITE_ISN: 0x61,
  SYNC: 0x67, // WECHSELCODE_SYNC_DME: one telegram, from the ews3.prg bytecode
  STATUS: 0x53,
};

/** DS2 positive status (the coding lane reads the same byte). */
const POS = 0xa0;

/**
 * The ISN as one 16-bit number from a reply frame, or null when the frame
 * cannot hold it. Bytes [3..4], big-endian, per the mined ISN_LESEN spec.
 * @param {ArrayLike<number>} frame
 * @returns {number|null}
 */
function isnFromReply(frame) {
  if (!frame || frame.length < 5) return null;
  return ((frame[3] & 0xff) << 8) | (frame[4] & 0xff);
}

/**
 * The ISN the way INPA shows it: four hex digits.
 * @param {number} isn @returns {string}
 */
function isnText(isn) {
  return isn.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * One job exchange: send, check the reply's status byte is positive.
 * @param {object} sess - A webshim ds2 session (transfer).
 * @param {number[]} payload
 * @param {string} what - For error messages.
 * @returns {Promise<number[]>} The full reply frame.
 */
async function ewsJob(sess, payload, what) {
  const r = await sess.transfer(EWS_ADDR, payload);
  const status = r.length > 2 ? r[2] & 0xff : -1;
  if (status !== POS) {
    // 0xA1/0xFF family: the module refused -- a locked write shows up
    // here as ERROR_NO_PASSWORD rather than a silent nothing
    throw new Error(
      `EWS ${what}: negative status 0x${status.toString(16)} (${r
        .slice(0, 8)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')})`
    );
  }
  return r;
}

/**
 * IDENT -- the module's own identity block, for the page's header.
 * @returns {Promise<number[]>}
 */
async function ident(sess) {
  return ewsJob(sess, [JOB.IDENT], 'IDENT');
}

/**
 * Read the ISN (2 bytes). Two independent reads by default: a value that
 * lives three times with 2-of-3 voting should not flip between reads,
 * and a flaky line shows up as a mismatch instead of a wrong answer.
 * @param {{reads?: number}} [opts]
 * @returns {Promise<{isn: number, reads: number[]}>}
 */
async function readIsn(sess, opts = {}) {
  const reads = opts.reads ?? 2;
  const got = [];
  for (let i = 0; i < reads; i++) {
    const r = await ewsJob(sess, [JOB.READ_ISN], 'read ISN');
    const v = isnFromReply(r);
    if (v === null) throw new Error('EWS read ISN: the reply is too short');
    got.push(v);
  }
  if (got.some((v) => v !== got[0]))
    throw new Error(
      `EWS read ISN: two reads disagree (${got
        .map((v) => isnText(v))
        .join(' vs ')}) -- nothing was written`
    );
  return { isn: got[0], reads: got };
}

/**
 * Write the ISN through the factory job (ISN_SCHREIBEN). Read-back
 * verified; a module that demands a password first refuses with its own
 * negative status and nothing is written.
 * @param {number} isn
 * @returns {Promise<{isn: number, verified: boolean}>}
 */
async function writeIsn(sess, isn) {
  if (!Number.isInteger(isn) || isn < 0 || isn > 0xffff)
    throw new Error(`the ISN is two bytes (got ${isn})`);
  const hi = (isn >> 8) & 0xff;
  const lo = isn & 0xff;
  await ewsJob(sess, [JOB.WRITE_ISN, hi, lo], 'write ISN');
  const back = await readIsn(sess);
  return { isn: back.isn, verified: back.isn === isn };
}

/**
 * Trigger the rolling-code sync (WECHSELCODE_SYNC_DME). Decoded from the
 * ews3.prg bytecode (2026-10-28): the job is ONE telegram, `44 04 67`, and
 * a status read -- not the 63/62/67 sequence this once sent. The 0x67 just
 * tells the EWS to re-align its rolling code with the DME over their own
 * wire; the code exchange itself never touches the K-line, so there is
 * nothing to carry between steps.
 * @returns {Promise<string[]>} the step sent, for the log.
 */
async function syncDme(sess) {
  await ewsJob(sess, [JOB.SYNC], 'WECHSELCODE_SYNC_DME (67)');
  return ['67'];
}

/**
 * The match state the page shows: both sources read, compared, and said
 * plainly. `dmeIsn` is whatever the caller read from the DME's EEPROM
 * dump (EWS-ISN.md); null when the dump has not located it yet.
 * @param {number|null} dmeIsn
 * @param {number|null} ewsIsn
 * @returns {{state: string, text: string}}
 */
function matchState(dmeIsn, ewsIsn) {
  if (dmeIsn === null || ewsIsn === null)
    return { state: 'unknown', text: 'one side is not read yet' };
  if (dmeIsn === ewsIsn)
    return {
      state: 'match',
      text: `EWS and DME agree: ${isnText(ewsIsn)} (INPA would say they passen zusammen)`,
    };
  return {
    state: 'mismatch',
    text: `EWS ${isnText(ewsIsn)} vs DME ${isnText(
      dmeIsn
    )} -- they do not pass together; the alignment flow applies`,
  };
}

const ewsTalk = {
  ADDR: EWS_ADDR,
  JOB,
  POS,
  ident,
  readIsn,
  writeIsn,
  syncDme,
  matchState,
  isnText,
  isnFromReply,
};

if (typeof window !== 'undefined') {
  window.ewsTalk = ewsTalk;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ewsTalk };
}
