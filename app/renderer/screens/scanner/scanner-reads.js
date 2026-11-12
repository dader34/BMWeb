/**
 * @file BMWeb Scanner: the reference scanner's read-only unit functions
 * (BMW Scanner 1.4.0.7), each as its handler does it -- what is asked, in
 * what order, and how the answer is laid out.
 *
 *   Steering wheel angle (LEW)  0x5F734C: identify, then word A651; answer
 *                               bytes 3..6 are the four values, shown as
 *                               plain decimals, asked again until OK
 *   Crash data buffer (SRS)     0x5F0294: word A3A8 with the block number,
 *                               blocks 1..8; each answer's data bytes from
 *                               byte 4 on, in hex, one line a block
 *
 * The reference asks with adapter words: its cable turns each into the
 * telegram. The telegrams of these words have not been seen on the bus, so
 * they go only over the reference's own cable, which knows them
 * (ScannerEepromLink.word); on any other cable the function says so.
 */

/* exported SCANNER_READ_WORD, scannerWordLink, scannerSteeringAngle, scannerCrashData */

/** The adapter words of the read-only functions. */
const SCANNER_READ_WORD = {
  steeringAngle: 0xa651,
  crashData: 0xa3a8,
};

/** The crash data buffer's blocks, as the reference asks them. */
const SCANNER_CRASH_BLOCKS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The error of a function no cable in hand can ask.
 * @param {string} what - The function, as its button names it.
 * @returns {Error & {unsupported: boolean}}
 */
function scannerNeedsReferenceCable(what) {
  return Object.assign(
    new Error(
      `${what} is asked with a command only the BMW Scanner (PA Soft) cable knows; its telegram on the bus has not been captured yet.`
    ),
    { unsupported: true }
  );
}

/**
 * The link's adapter-word sender, or the error that says there is none.
 * @param {ScannerEepromLink} link
 * @param {string} what - The function, as its button names it.
 * @returns {(word: number, addr: number, payload: number[]) => Promise<number[]|null>}
 */
function scannerWordLink(link, what) {
  if (!link.word) throw scannerNeedsReferenceCable(what);
  return link.word;
}

/**
 * The reference's "Connection error with <unit>" (nothing came back).
 * @param {ScannerModule} m
 * @returns {Error}
 */
const scannerConnectionError = (m) =>
  new Error(`Connection error with ${m.name}`);

/**
 * One reading of the steering-angle sensor's four values.
 * @param {ScannerEepromLink} link
 * @param {ScannerModule} m - The LEW.
 * @returns {Promise<{relative: number, absolute: number, constant1: number,
 *   constant2: number}|null>} Null when the unit answered but refused (the
 *   reference then leaves the values as they were).
 */
async function scannerSteeringAngle(link, m) {
  const word = scannerWordLink(link, 'Steering wheel angle');
  let r = null;
  try {
    r = await link.ds2(m.address, [0x00]);
  } catch (e) {
    if (e && e.unsupported) throw e;
  }
  if (!r || !r.length) throw scannerConnectionError(m);
  r = await word(SCANNER_READ_WORD.steeringAngle, m.address, []);
  if (!r || !r.length) throw scannerConnectionError(m);
  if (r[2] !== 0xa0) return null;
  return {
    relative: r[3] & 0xff,
    absolute: r[4] & 0xff,
    constant1: r[5] & 0xff,
    constant2: r[6] & 0xff,
  };
}

/**
 * The airbag unit's crash data buffer, as the reference shows it: a heading,
 * then a line of hex bytes for every block the unit gave.
 * @param {ScannerEepromLink} link
 * @param {ScannerModule} m - The SRS.
 * @returns {Promise<string>}
 */
async function scannerCrashData(link, m) {
  const word = scannerWordLink(link, 'Crash data');
  const hex = (b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0');
  let text = 'Crash data buffer:\r\n';
  for (const block of SCANNER_CRASH_BLOCKS) {
    const r = await word(SCANNER_READ_WORD.crashData, m.address, [block]);
    if (!r || !r.length) throw scannerConnectionError(m);
    // a refusal, or an answer with no data in it, leaves no line
    if (r[2] !== 0xa0 || r[1] < 6) continue;
    // from byte 4 to the last before the checksum
    for (const b of r.slice(4, r[1] - 1)) text += hex(b) + ' ';
    text += '\r\n';
  }
  return text;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCANNER_READ_WORD,
    scannerWordLink,
    scannerSteeringAngle,
    scannerCrashData,
  };
}
