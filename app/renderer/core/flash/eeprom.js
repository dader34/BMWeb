// Flashing/Tuning: the DME-side identity vault reader. BENCH ONLY
// (localhost), like the rest of the flash lane.
//
// The per-car identity -- the stored-data blocks the boot's task10
// restores with 3-copy/2-of-3 voting, and with them the DME's copy of
// the ISN -- lives in the 4 KB serial EEPROM on QSPI PCS1, which no
// diagnostic service and no flash read reaches (docs/EWS-ISN.md). The
// v14 body's READ gained offset bit 30 for exactly this: a pure-03
// staged read of the part. v15 adds svc 0x0B: a write served by the
// ee_write module the gate parks in ext at 0xFF000 -- one QSMCM queue
// pass of WREN, WRITE(addr+data), WRDI, so write-enable lives exactly
// one WRITE and the client rules below mirror the module's refusals
// (no window bit, past the end, over the cap, across a 32-byte page).

/** The v14 body's EEPROM address space (docs/EWS-ISN.md). */
const EE_WINDOW = 0x40000000;
/**
 * The part is 4 KB, 16-bit addressed: a 64 KB read of the car's (2026-10-28)
 * was the same 4 KB sixteen times, its address wrapping -- so a write past
 * 0xFFF would land on real data. The v18 body refuses both past it too.
 */
const EE_SIZE = 0x1000;
/** The body stages a page at DSTBUF: reads are capped at 4 KB. */
const EE_PAGE = 0x1000;
/** The v15 write service (ee_write module in ext at 0xFF000). */
const S_EEWRITE = 0x0b;
/** One write = one QSMCM queue (WREN + WRITE + WRDI = len+5 entries, 30 at the cap). */
const EE_WMAX = 25;
/** The EEPROM's 32-byte write page: a write may not straddle it. */
const EE_WPAGE = 32;
/** One queue pass, then the readback read: generous next to both. */
const EE_WRITE_MS = 3000;

/**
 * The whole serial EEPROM, a page a READ. Read-only: the only bytes that
 * ever move are from the part to us.
 * @param {object} client - fastFlashWire.Client on an open link (v14+ body).
 * @param {{progress?: (done: number) => void}} [opts]
 * @returns {Promise<Uint8Array>} 4 KB
 */
async function dumpEeprom(client, opts = {}) {
  const out = new Uint8Array(EE_SIZE);
  for (let at = 0; at < EE_SIZE; at += EE_PAGE) {
    out.set(await client.read((EE_WINDOW | at) >>> 0, EE_PAGE), at);
    if (opts.progress) opts.progress(at + EE_PAGE);
  }
  return out;
}

/**
 * The v15 write service: bytes into the part, then the same bytes read
 * back before the promise resolves -- a write the part did not take is
 * an error, not a hope. The rules the module enforces are enforced here
 * too (one queue's worth, inside the 4 KB, no page straddle) so a
 * refusal is a bug report, not a round trip.
 * @param {object} client - fastFlashWire.Client on an open link (v15+ body).
 * @param {number} at - address inside the part (0..0xFFF)
 * @param {number[]|Uint8Array} bytes - 1..25
 * @returns {Promise<void>} resolves only on a verified readback
 */
async function writeEeprom(client, at, bytes) {
  const n = bytes ? bytes.length : 0;
  if (n < 1 || n > EE_WMAX)
    throw new Error(
      `EEPROM write of ${n} bytes: the one-queue cap is 1..${EE_WMAX}`
    );
  if (at < 0 || at + n > EE_SIZE)
    throw new Error(`EEPROM write at ${at}+${n}: past the part's end`);
  if ((at % EE_WPAGE) + n > EE_WPAGE)
    throw new Error(`EEPROM write at ${at}+${n}: would cross the 32-byte page`);
  const off = (EE_WINDOW | at) >>> 0;
  const payload = [
    (off >>> 24) & 0xff,
    (off >>> 16) & 0xff,
    (off >>> 8) & 0xff,
    off & 0xff,
    (n >> 8) & 0xff,
    n & 0xff,
    ...bytes,
  ];
  await client.call(S_EEWRITE, payload, EE_WRITE_MS);
  const back = await client.read(off, n);
  for (let i = 0; i < n; i++)
    if (back[i] !== bytes[i])
      throw new Error(
        `EEPROM write at ${at}: byte ${i} read back ${(back[i] || 0).toString(16)}, sent ${bytes[i].toString(16)}`
      );
}

/**
 * Every offset where a value occurs (the ISN is 2 bytes; a stored-three-
 * times field shows as three hits, which is how the block format will
 * confirm itself against two cars' dumps).
 * @param {Uint8Array} img
 * @param {number} val - 16-bit
 * @returns {number[]}
 */
function scan16(img, val) {
  const hits = [];
  const hi = (val >> 8) & 0xff;
  const lo = val & 0xff;
  for (let i = 0; i + 1 < img.length; i++)
    if (img[i] === hi && img[i + 1] === lo) hits.push(i);
  return hits;
}

/**
 * The complement of a value, the way the stored-data blocks vote: a
 * field kept three times with two decoded through inversion shows as a
 * run of value/inverted/value (protections.md's block-3 description).
 * @param {number} val @returns {number}
 */
const inv16 = (val) => (val ^ 0xffff) & 0xffff;

/**
 * The complement of a byte string, a 16-bit word at a time -- the coding
 * the middle copy of a 3-copy field carries (inv16, per word).
 * @param {number[]|Uint8Array} bytes - even length
 * @returns {Uint8Array}
 */
function invBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = ~bytes[i] & 0xff;
    out[i + 1] = ~bytes[i + 1] & 0xff;
  }
  return out;
}

/**
 * Every offset where a byte string occurs (the multi-byte general case
 * of scan16 -- what the ISN search uses).
 * @param {Uint8Array} img @param {number[]|Uint8Array} pat
 * @returns {number[]}
 */
function findRuns(img, pat) {
  const hits = [];
  const last = img.length - pat.length;
  let i = 0;
  while (i <= last) {
    let j = 0;
    while (j < pat.length && img[i + j] === pat[j]) j++;
    if (j === pat.length) hits.push(i);
    i++;
  }
  return hits;
}

/**
 * The writes that retarget the DME's ISN copies in a dump: every
 * straight occurrence of the old ISN becomes the new one, every inverted
 * copy the inverted new one, votes preserved. The ISN's real offsets are
 * bench RE still pending (the donor dump cross-checked against the EWS
 * read); this works from whatever the dump holds, so it survives the
 * offsets moving. Empty ops = the dump has no such ISN, which the caller
 * should show as "not found" rather than write blind.
 * @param {Uint8Array} img - the dump (unchanged; the writes go to the part)
 * @param {number[]|Uint8Array} oldIsn @param {number[]|Uint8Array} newIsn
 * @returns {{at: number, bytes: Uint8Array, vote: 'straight'|'inverted'}[]}
 */
function isnWrites(img, oldIsn, newIsn) {
  const ops = [];
  for (const at of findRuns(img, oldIsn))
    ops.push({ at, bytes: Uint8Array.from(newIsn), vote: 'straight' });
  const oldInv = invBytes(oldIsn);
  for (const at of findRuns(img, oldInv))
    ops.push({ at, bytes: invBytes(newIsn), vote: 'inverted' });
  ops.sort((a, b) => a.at - b.at);
  return ops;
}

/**
 * Run write ops one at a time, each verified by its own readback before
 * the next begins (writeEeprom's contract). Returns the count applied --
 * the caller re-dumps to show the part, not this list.
 * @param {object} client
 * @param {{at: number, bytes: number[]|Uint8Array}[]} ops
 * @param {{progress?: (done: number, total: number) => void}} [opts]
 * @returns {Promise<number>}
 */
async function applyWrites(client, ops, opts = {}) {
  let done = 0;
  for (const op of ops) {
    await writeEeprom(client, op.at, op.bytes);
    done++;
    if (opts.progress) opts.progress(done, ops.length);
  }
  return done;
}

/**
 * A first-cut block map for the format RE: spans of non-blank bytes with
 * their head bytes, so two cars' dumps can be compared block by block.
 * @param {Uint8Array} img
 * @param {number} [gap=32] - blank bytes that end a block
 * @returns {{at: number, end: number, head: number[]}[]}
 */
function blockMap(img, gap = 32) {
  const blank = (i) => img[i] === 0xff;
  const blocks = [];
  let run = 0;
  let start = -1;
  for (let i = 0; i < img.length; i++) {
    if (!blank(i)) {
      if (start < 0) start = i;
      run = 0;
    } else if (start >= 0 && ++run >= gap) {
      blocks.push({
        at: start,
        end: i - run + 1,
        head: [...img.slice(start, start + 8)],
      });
      start = -1;
      run = 0;
    }
  }
  if (start >= 0)
    blocks.push({
      at: start,
      end: img.length,
      head: [...img.slice(start, start + 8)],
    });
  return blocks;
}

const eepromDump = {
  WINDOW: EE_WINDOW,
  SIZE: EE_SIZE,
  PAGE: EE_PAGE,
  WRITE_SVC: S_EEWRITE,
  WRITE_MAX: EE_WMAX,
  dump: dumpEeprom,
  write: writeEeprom,
  applyWrites,
  scan16,
  inv16,
  invBytes,
  findRuns,
  isnWrites,
  blockMap,
};

if (typeof window !== 'undefined') {
  window.eepromDump = eepromDump;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { eepromDump };
}
