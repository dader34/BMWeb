// The no-install trigger's wire client: the v21 fast-flash body started on a
// STOCK loader over plain KWP, no bootstrap, no reset. The DME end is the
// stock loader's own machinery -- the MTOS gate the 31 FA fire calls -- and
// the protocol is EMU-PROVEN END TO END (ms45-emu tools/experiments/
// trigger_flasher.py, ALL PASS 2026-11-03: fire -> gate -> entry branch ->
// the relocate stub copies the body verbatim to SRAM 0x3F9800 -> the body
// answers the resident protocol from there).  Everything here sends exactly
// what that proof sent:
//
//   1. 10 86, NO login (a blank boot marker accepts any session -> a37 = 2);
//   2. 31 02 erase of ONE 32K cal block at ext 0x40000 -- the write enable
//      (the whole cal sector is erased; a flash rewrites it anyway, and the
//      34-write path restores everything but the 0x100-B protected tail --
//      only a driver-level writer, i.e. the body itself, can rewrite that);
//   3. 3D stages the MTOS image into the loader's pool 0x3FA104 in <=249-B
//      chunks (the telegram's length byte caps the payload at 255);
//   4. 31 FA: one telegram runs arm+fire internally -- the arm pass's 71 FA
//      reply goes out, then the fire hands the line to the staged body.
//
// The staged image (build it with triggerImage):
//   [MTOS descriptor 0x70 B][entry branch 4 B][dead gap 0x40 B][body]
//   at pool 0x3FA104 contiguous, plus the relocate stub 68 B at 0x3FBAA0.
// The copy destination [0x3F9800, 0x3FB0DF) CONTAINS the pool, so the stub
// executes FROM the copy: the gate-called entry (desc+0x70 = 0x3FA174) is
// one `b 0x3FBAA0`, and everything that runs during or after the copy (the
// EE kill, the copy loop, the final `ba 0x3F9800`) is staged above both the
// copy's highest write and the staged body itself.  No translated
// instruction is ever re-read from memory the copy overwrites -- the
// emulator's first two stub shapes died on exactly that (a clobbered
// after-loop ba; a loop whose translation got re-read mid-copy), and this
// split is the shape that passed.
//
// Preconditions and limits, all enforced or documented:
//   - ONE-TIME UNLOCK: this needs the boot-region payload delivered once
//     (car-proven family: aif_wipe / bootregion_poc), which restores the
//     boot sector with the two marker bytes at ext 0x1F9C2 / 0x1FB18 left
//     blank.  The CALLER reads them (the app's proven ext-flash read,
//     ms45ReadMemory's speicher_lesen_ascii over ROMX -- the markers sit
//     at CPU 0xFFF1F9C2, past a raw 23 read's 24-bit address) and passes
//     the state in; a DME whose markers read back non-blank refuses the
//     fire (harmlessly -- the gate NRCs) and triggerFire says so instead
//     of trying.
//   - NO ee_write: the body's ee_write op jumps to a module the BOOTSTRAP
//     flashes at ext 0xFF000; a trigger-started body has stock bytes there,
//     so the op must not be called (nothing in the flash path does -- the
//     fast-flash protocol is HELLO/QUERY/ERASE/CHUNK/VERIFY/MARKS/RESET/
//     SET_BAUD/CHUNK_SET/AIF/READ).
//   - the driver-state poke in the emulator proof is an EMU STAND-IN (its
//     CMF model cannot satisfy the erase driver's completion poll); real
//     hardware takes the success path on its own, and nothing here pokes.
//
// The sender contract is ms45LiveTuneSender's (core/ms45/ms45.js): DATA
// bytes in, the answer's DATA bytes back, null for silence -- any KWP send
// path with that shape drives this.
/* exported triggerWire */

const trigBytes =
  typeof bytes !== 'undefined' ? bytes : require('../bytes/index.mjs');

/** The pool and RAM layout of the proof, ext/loose addresses. */
const TRIGGER = {
  DESC: 0x3fa104, // the loader's table-A descriptor pool
  D_ENTRY: 0x3fa174, // desc+0x70, the address the stock gate computes+calls
  STUB_AT: 0x3fbaa0, // above the copy's writes AND the staged body end
  SRAM_BASE: 0x3f9800, // where the body runs relocated
  POOL_END: 0x3fc003, // table-A pool range, inclusive
  BODY_SRC: 0x3fa1b8, // the body inside our staged image (D_ENTRY+0x44)
  CAL: 0x40000, // one 32K cal block erased as the write enable
  ERASE_LEN: 0x8000,
  ERASE_AT: 0x02000000 + 0x40000, // the KWP address window of the chip
  CHUNK: 249, // 6 telegram bytes + chunk <= the length byte's 255
  BODY_WORDS: 1592, // the body the emu proof staged -- a change must re-run it
  MARKER1: 0x1f9c2, // the boot-sector markers the one-time unlock blanks
  MARKER2: 0x1fb18,
  MTOS_SEED: 0x4d544f53, // 'MTOS', big-endian: the gate CRC's seed
  BODY_IN_BLOB: 0xfd500, // where the body starts in the bootstrap blob
};

/** The staged image must not grow past the stub, or the copy overwrites it. */
const TRIGGER_POOL_WARN = 0x3fb0e0;

// The RSA signature the 31 FA arm pass verifies at desc[0x04..0x44].
// Constant: it signs MD5("") (the empty C string at desc[0x54]) with
// slot-6's public (N6, E6=7). Precomputed with the proven factory
// convention (tools/experiments/slot6_key.py); the emu proof
// noinstall_31fa_sim.py uses the matching value.
//   N6 = rev_limbs(session1 flash[K6_OFF:K6_OFF+64])  (public, in-image)
//   t  = MD5(b"")  = d41d8cd98f00b204 e9800998ecf8427e
//   x  = pow(int.from_bytes(t,'little'), D6, N6)
//   sig = le_bytes_of_x_with_each_u32_byte_reversed
const MTOS_DESC_SIG = new Uint8Array([
  0xdb, 0xa0, 0xf1, 0x95, 0xd8, 0x50, 0x07, 0xcd,
  0xc3, 0x4a, 0xef, 0x38, 0xee, 0x66, 0xb4, 0x21,
  0x57, 0xa4, 0x9a, 0x34, 0xee, 0x35, 0x74, 0xeb,
  0x4c, 0xcb, 0x7e, 0xd3, 0x2e, 0xef, 0x50, 0x06,
  0x72, 0xd8, 0x14, 0x8f, 0x3e, 0xea, 0xc0, 0xe8,
  0x8c, 0x08, 0xd5, 0x73, 0xdf, 0xe9, 0xae, 0xba,
  0x22, 0x05, 0x7c, 0xb8, 0x5e, 0x33, 0x4e, 0x5f,
  0xfc, 0xfb, 0x9a, 0xe4, 0x78, 0x5a, 0xc8, 0xb2,
]);

/**
 * The relocate stub's 17 words and the entry branch word, hand-packed --
 * PPC, big-endian, the exact words of the emu proof (build_stub there;
 * capstone PPC cannot print mfmsr, the encodings are cross-checked against
 * its mtmsr).  Only r5's count (and nothing else) varies with the body.
 * @param {number} nwords - The body's length in words.
 * @returns {{entry: number, words: number[]}}
 */
function triggerStub(nwords) {
  return {
    // `b 0x3FBAA0` -- relative, LI field: the one word at the gate-called
    // entry; the copy clobbers it ~605 iterations in, long spent by then
    entry: (0x48000000 | (TRIGGER.STUB_AT - TRIGGER.D_ENTRY)) >>> 0,
    words: [
      0x7cc000a6, // mfmsr  r6          -- kill EE before the copy: the
      0x54c6045e, // rlwinm r6,r6,0,17,15   loader's interrupt handlers use
      0x7cc00124, // mtmsr  r6              the r13 block the copy eats
      0x4c00012c, // isync
      0x3c60003f, // lis    r3,0x3FA1  .. the body, staged at 0x3FA1B8
      0x6063a1b8, // ori    r3,r3,0xA1B8
      0x3c80003f, // lis    r4,0x3F98  .. SRAM 0x3F9800, where it runs
      0x60849800, // ori    r4,r4,0x9800
      0x3ca00000, // lis    r5,0      .. the word count
      0x60a50000 | (nwords & 0xffff), // ori r5,r5,<nwords>
      0x80c30000, // cp:    lwz r6,0(r3)
      0x90c40000, //        stw r6,0(r4)
      0x38630004, //        addi r3,r3,4
      0x38840004, //        addi r4,r4,4
      0x34a5ffff, //        addic. r5,r5,-1
      0x4082ffec, //        bne cp  (back 5 words -- fixed loop geometry)
      0x483f9802, //        ba    0x3F9800  -- the body owns the line
    ],
  };
}

/**
 * The staged image: the 0x70-B MTOS descriptor, the entry branch, the dead
 * gap it jumps over (CRC filler), the body -- and the stub as a second
 * piece at STUB_AT.  The descriptor's CRC covers entry..body (the stub is
 * ours, not the gate's).
 * @param {Uint8Array} body - The fast-flash body, a whole number of words.
 * @returns {{img: Uint8Array, stub: Uint8Array, crc: number, end: number,
 *   nwords: number}}
 * @throws {Error} When the body's size breaks the pool geometry.
 */
function triggerImage(body) {
  if (body.length % 4)
    throw new Error('the body is not a whole number of words');
  const nwords = body.length / 4;
  const codeLen = 4 + 0x40 + body.length;
  const end = TRIGGER.D_ENTRY + codeLen - 1;
  if (end > TRIGGER.POOL_END)
    throw new Error(
      `the staged image (${codeLen} B from 0x${TRIGGER.D_ENTRY.toString(16)})` +
        ` runs past the pool's end 0x${TRIGGER.POOL_END.toString(16)}`
    );
  if (end >= TRIGGER.STUB_AT)
    throw new Error(
      'the body grew into the relocate stub at 0x' +
        TRIGGER.STUB_AT.toString(16) +
        ' -- restage the stub higher (the emu proof must be re-run first)'
    );
  const code = new Uint8Array(codeLen);
  const stub = triggerStub(nwords);
  trigBytes.putBe32(code, 0, stub.entry); // the entry branch word
  code.fill(0, 4, 4 + 0x40); // the dead gap
  code.set(body, 4 + 0x40);
  const crc = trigBytes.crc32Mpeg2(code, TRIGGER.MTOS_SEED) >>> 0;
  const img = new Uint8Array(0x70 + codeLen);
  trigBytes.putBe32(img, 0x00, 0x10); // version
  // The 64-byte RSA signature at desc[0x04..0x44] -- slot-6 public key
  // (N6, E6=7), signing MD5 of the C string at desc[0x54] (empty here,
  // so MD5(b"")). Emitted in the loader's limbs-LE wire form: int in
  // little-endian (64 B), each 4-byte group byte-reversed. Fixed because
  // the key, exponent and hashed input are all constants. The emu proof
  // (tools/experiments/noinstall_31fa_sim.py) uses the matching sign.
  // Without this the fire's arm pass refuses with 7F 31 10 (general
  // reject) ~40 ms into fn_869C's RSA verify.
  img.set(MTOS_DESC_SIG, 0x04);
  trigBytes.putBe32(img, 0x48, 1); // the first-0xFA gate
  trigBytes.putBe32(img, 0x58, crc);
  trigBytes.putBe32(img, 0x5e, TRIGGER.D_ENTRY); // range start (unaligned by design)
  trigBytes.putBe32(img, 0x62, end); // range end
  img.set(
    Array.from('004457MTOS', (c) => c.charCodeAt(0)),
    0x66
  );
  img.set(code, 0x70);
  const stubBytes = new Uint8Array(stub.words.length * 4);
  stub.words.forEach((w, i) => trigBytes.putBe32(stubBytes, 4 * i, w));
  return { img, stub: stubBytes, crc, end, nwords };
}

/**
 * The body out of a bootstrap blob (core/generated/fast-flasher-blob.js).
 * The blob splices the boot layout [stamp, gate, boot stub, body, ee_write
 * module] as runs over non-blank bytes; the trigger wants the body alone.
 * Its extent: the last run that starts below the ee_write module (fixed at
 * ext 0xFF000) -- and that extent MUST equal BODY_WORDS, the body the emu
 * proof staged: a body that grew (or ends in blank runs the splice skips)
 * changes the pool geometry and the stub's count, so it refuses loudly
 * instead of staging a truncated copy.  Holes inside the span are blank
 * (verified against the proof's body: every one is 0xFF).
 * @param {{runs: [number, string][]}} blob - A fastFlasherBlob.
 * @returns {Uint8Array}
 * @throws {Error} When the blob's body does not match BODY_WORDS.
 */
function triggerBodyFromBlob(blob) {
  const have = new Map(); // byte offset -> byte, only what the runs cover
  let end = 0; // end of the last run below the ee_write module
  for (const [at, hex] of blob.runs) {
    if (at >= 0xff000) continue;
    end = Math.max(end, at + hex.length / 2);
    for (let i = 0; i < hex.length; i += 2)
      have.set(at + i / 2, parseInt(hex.slice(i, i + 2), 16));
  }
  const at = TRIGGER.BODY_IN_BLOB;
  const want = TRIGGER.BODY_WORDS * 4;
  if (end - at !== want)
    throw new Error(
      `the blob's body is ${end - at} B, the proof staged ${want} B -- ` +
        're-run ms45-emu trigger_flasher and update BODY_WORDS'
    );
  const body = new Uint8Array(want);
  for (let i = 0; i < want; i++)
    body[i] = have.has(at + i) ? have.get(at + i) : 0xff;
  return body;
}

/**
 * The SGBD's erase-region encoding, as the DME's 31 02 takes it: address
 * bytes 2,1,0, then byte 3, then a 3-byte length.
 * @param {number} start - Start, KWP window address.
 * @param {number} length - Length.
 * @returns {number[]}
 */
function triggerRegion(start, length) {
  return [
    (start >> 16) & 0xff,
    (start >> 8) & 0xff,
    start & 0xff,
    (start >> 24) & 0xff,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ];
}

/**
 * The 3D staging telegrams for the image pieces, in order: each chunk
 * <= CHUNK bytes at its own pool address (the loader validates every one
 * against its table-A pool rule).
 * @param {...[Uint8Array, number]} pieces - (bytes, pool address) pairs.
 * @returns {number[][]}
 */
function triggerStageTelegrams(...pieces) {
  const tgs = [];
  for (const [data, at] of pieces) {
    for (let off = 0; off < data.length; off += TRIGGER.CHUNK) {
      const chunk = data.slice(off, off + TRIGGER.CHUNK);
      const a = at + off;
      tgs.push([
        0x3d,
        (a >> 16) & 0xff,
        (a >> 8) & 0xff,
        a & 0xff,
        0x00,
        chunk.length,
        ...chunk,
      ]);
    }
  }
  return tgs;
}

/** @returns {string} The NRC text for a 7F answer, or ''. */
function _triggerNrc(r) {
  if (!r || r[0] !== 0x7f || r.length < 3) return '';
  // KWP negative responses are 3 bytes: 7F <service> <NRC>. An earlier
  // revision of this helper indexed r[3], which crashed on the stock
  // 3-byte shape ("Cannot read properties of undefined (reading
  // 'toString')") and hid the real refusal reason. r[2] IS the NRC.
  const nrc = r[2];
  const known = {
    0x10: 'general reject',
    0x11: 'service not supported',
    0x12: 'sub-function not supported',
    0x22: 'conditions not correct',
    0x23: 'routine not complete / busy',
    0x31: 'out of range',
    0x33: 'security refused',
    0x72: 'programming error',
    0x78: 'response pending',
  }[nrc];
  return (
    ` the DME refused it (7F ${r[1].toString(16).padStart(2, '0')} ` +
    `${nrc.toString(16).padStart(2, '0')}` +
    `${known ? `: ${known}` : ''})`
  );
}

/**
 * Stage the fast-flash body into a stock loader and fire it: the whole
 * no-install trigger, the exact telegram sequence of the emu proof.  On
 * success the body owns the line from SRAM 0x3F9800 -- the caller's next
 * step is the resident protocol's HELLO, not another KWP request.
 * @param {(data: number[]) => Promise<number[]|Uint8Array|null>} sender -
 *   ms45LiveTuneSender-shaped send path.
 * @param {Uint8Array} body - The fast-flash body (triggerBodyFromBlob).
 * @param {{stage?: (s: string) => void, note?: (s: string) => void,
 *   progress?: (n: number, total: number) => void,
 *   markers?: {unlocked: boolean, note?: string}}} [cb] - Progress
 *   callbacks.  markers: what the caller's ROMX read of the boot markers
 *   found -- {unlocked: false} refuses before anything is sent; leave it
 *   out to skip the check (a misfire is safe: the gate just NRCs).
 * @returns {Promise<{replied: number[]|Uint8Array|null}>}
 * @throws {Error} When a step is refused or the answer is not what the
 *   proof says comes back.
 */
async function triggerFire(sender, body, cb = {}) {
  const stage = cb.stage || (() => {});
  const note = cb.note || (() => {});
  if (cb.markers) {
    stage('Checking the one-time unlock');
    if (!cb.markers.unlocked) {
      throw new Error(
        'this DME still carries its stock boot markers -- the one-time ' +
          'unlock has not been delivered, and the fire would be refused. ' +
          'Nothing was sent.'
      );
    }
    note(
      cb.markers.note || 'the boot markers read blank: the unlock is in place'
    );
  }

  stage('Opening the programming session (no login)');
  let r = await sender([0x10, 0x86]);
  if (!r || r[0] !== 0x50)
    throw new Error(
      `10 86 did not open the session${_triggerNrc(r) || ' (no answer)'}`
    );

  stage('Erasing one calibration block (the write enable)');
  r = await sender([
    0x31,
    0x02,
    ...triggerRegion(TRIGGER.ERASE_AT, TRIGGER.ERASE_LEN),
  ]);
  if (!r || r[0] !== 0x71 || r[2] !== 0x01)
    throw new Error(
      `the erase was not accepted${_triggerNrc(r) || ' (no answer)'}`
    );

  const image = triggerImage(body);
  const tgs = triggerStageTelegrams(
    [image.img, TRIGGER.DESC],
    [image.stub, TRIGGER.STUB_AT]
  );
  stage(`Staging the fast flasher (${tgs.length} chunks)`);
  let done = 0;
  for (const tg of tgs) {
    r = await sender(tg);
    if (!r || r[0] !== 0x7d)
      throw new Error(
        `staging chunk ${done + 1}/${tgs.length} was not accepted` +
          `${_triggerNrc(r) || ' (no answer)'}`
      );
    done++;
    if (cb.progress) cb.progress(done, tgs.length);
  }

  // Arm then fire: two 31 FA telegrams. On a DME whose boot markers are
  // intact (the one-time unlock not yet delivered), the loader's 31 FA
  // handler has two branches keyed on the handshake flag at 0x3F99C9:
  //  * handshake==0 (first call): goes through fn_83D8, verifies the
  //    slot-6 RSA signature in desc[0x04..0x44] over MD5 of the string
  //    at desc[0x54] (empty here), sets the handshake flag on success,
  //    answers 71 FA -- but does NOT execute the staged body.
  //  * handshake==1 (second call): goes through fn_395C, executes
  //    desc[0x70] in place (our entry branch -> relocate stub -> body).
  // The emu proof noinstall_31fa_sim.py runs exactly this two-shot
  // sequence (lines 197-204); an earlier single-shot comment here was
  // true only on the markers-unlocked path (trigger_flasher.py), which
  // skips the handshake gate entirely.
  stage('Arming the fast flasher');
  r = await sender([0x31, 0xfa]);
  if (!r || r[0] !== 0x71)
    throw new Error(`the arm was refused${_triggerNrc(r) || ' (no answer)'}`);

  stage('Firing');
  // On the second 31 FA the loader hands PC to the staged body IMMEDIATELY
  // (real-hardware behaviour, car-traced 2026-11-05): no 71 FA reply comes
  // back at 9600 like the sim implied -- the handoff pre-empts the reply.
  // The body's sram_entry then sets SCI to 115200 and sends an unprompted
  // HELLO -- which looks like 1 byte of garbage at 9600 to this port and
  // throws IFH-0019 in ms45LiveTuneSender.
  //
  // Right behaviour: send the fire telegram, DO NOT wait for a KWP reply,
  // and let the caller's link.resume() reopen at 115200 and read the real
  // HELLO. Any IFH-0019/garbled/timeout here is the EXPECTED symptom of
  // the takeover, not a failure; a true refusal would have come back as a
  // valid 7f 31 xx frame at 9600, which this client can parse. If the
  // caller's downstream HELLO doesn't come back at any supported rate,
  // THAT is the real failure signal and it throws there.
  r = null;
  try {
    r = await sender([0x31, 0xfa]);
  } catch (e) {
    // IFH-0019 (incomplete answer) / timeout / garbled: treat as takeover
    note(
      `fire sent; the client's 9600 read saw ${e && e.message ? e.message : 'garbage'} (the body is answering at 115200 now)`
    );
  }
  if (r && r[0] === 0x7f)
    throw new Error(`the fire was refused${_triggerNrc(r)}`);
  note(
    r
      ? 'armed and fired (71 FA answered; the body has the line)'
      : 'fired (the body has the line)'
  );
  return { replied: r };
}

const triggerWire = {
  TRIGGER,
  TRIGGER_POOL_WARN,
  triggerStub,
  triggerImage,
  triggerBodyFromBlob,
  triggerRegion,
  triggerStageTelegrams,
  triggerFire,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { triggerWire };
}
