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
//   2. the write enable: a 31 02 at a RAM address the loader refuses
//      (7F 31 22). The refusal still stops the app tasks and completes the
//      MO3 handshake, which is all the staging needs; nothing is erased
//      (emu-proven on loaders A, B and C, 2026-11-05);
//   3. 3D stages the MTOS descriptor + entry branch at the pool 0x3FA104
//      and the receiver stub at 0x3FBAA0 (3 telegrams; the body itself is
//      NOT staged at 9600 any more);
//   4. 31 FA arm, then 31 FA fire: the gate calls the entry branch, which
//      jumps to the receiver;
//   5. the host reopens at 115200 and uploads the body (triggerUploadFrame:
//      A5 5A len body sum) straight into SRAM 0x3F9800; the receiver jumps
//      there and the body sends its own HELLO (fastFlashWire link.upload).
//      Two-stage entry emu-proven with the real login on loaders A, B and C,
//      2026-11-05 (ms45-emu tools/build/trigger_receiver.py).
//
// The staged image (build it with triggerImage):
//   [MTOS descriptor 0x70 B][entry branch 4 B][dead gap 0x40 B] at the pool
//   0x3FA104, plus the receiver at 0x3FBAA0 -- above the body's whole SRAM
//   span, so nothing the upload writes can reach the code doing the writing.
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
  STUB_AT: 0x3fbaa0, // the receiver: above the uploaded body (SRAM_BASE + 8664 B = 0x3FB9D8), inside the pool
  SRAM_BASE: 0x3f9800, // where the body runs relocated
  POOL_END: 0x3fc003, // table-A pool range, inclusive
  // the write enable: a 31 02 the loader REFUSES (7F 31 22, a RAM address
  // outside its erasable ranges) still stops the app tasks and completes
  // the MO3 handshake (state 02) -- everything the staging needs -- and
  // erases nothing. Emu-proven on loaders A, B and C with the real sel-5
  // login, flash byte-identical after the fire (2026-11-05).
  ENABLE_AT: 0x3f9800,
  ENABLE_LEN: 0x80,
  CHUNK: 249, // 6 telegram bytes + chunk <= the length byte's 255
  BODY_WORDS: 2166, // the body the emu proof staged -- a change must re-run it
  EE_MODULE_AT: 0xffa00, // the ee_write module's place in the blob: the body ends below it
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
  0xdb, 0xa0, 0xf1, 0x95, 0xd8, 0x50, 0x07, 0xcd, 0xc3, 0x4a, 0xef, 0x38, 0xee,
  0x66, 0xb4, 0x21, 0x57, 0xa4, 0x9a, 0x34, 0xee, 0x35, 0x74, 0xeb, 0x4c, 0xcb,
  0x7e, 0xd3, 0x2e, 0xef, 0x50, 0x06, 0x72, 0xd8, 0x14, 0x8f, 0x3e, 0xea, 0xc0,
  0xe8, 0x8c, 0x08, 0xd5, 0x73, 0xdf, 0xe9, 0xae, 0xba, 0x22, 0x05, 0x7c, 0xb8,
  0x5e, 0x33, 0x4e, 0x5f, 0xfc, 0xfb, 0x9a, 0xe4, 0x78, 0x5a, 0xc8, 0xb2,
]);

/**
 * The two-stage receiver: staged at STUB_AT in place of the body, called
 * through the entry branch at fire. It kills EE, puts the SCI at 115200
 * 8E1 (polled), hunts for A5 5A, takes a u16be length and that many bytes
 * into SRAM at 0x3F9800, then a u16be additive sum; on a good sum it jumps
 * to the body, whose own HELLO is the ack -- on a bad length/sum or a
 * ~20 ms gap it goes back to the hunt. The watchdog is petted on every
 * poll. Built by ms45-emu tools/build/trigger_receiver.py (these exact
 * words); emu-proven with the real login on loaders A, B and C, 2026-11-05.
 * @returns {{entry: number, words: number[]}}
 */
function triggerReceiver() {
  return {
    // b STUB_AT, relative from D_ENTRY
    entry: 0x48000000 | ((TRIGGER.STUB_AT - TRIGGER.D_ENTRY) & 0x03fffffc),
    words: [
      0x7cc000a6, 0x54c6045e, 0x7cc00124, 0x4c00012c, 0x3e20002f, 0x6231c00e,
      0x3a40556c, 0x3a60aa39, 0x3f800030, 0x639c500c, 0x3fa00030, 0x63bd500e,
      0x3fc00030, 0x63de5008, 0x3860000b, 0xb07e0000, 0x3c600030, 0x6063500a,
      0x3880060c, 0xb0830000, 0x480000bd, 0x280300a5, 0x4082fff8, 0x480000b1,
      0x2803005a, 0x41820010, 0x280300a5, 0x4182fff0, 0x4bffffe0, 0x48000099,
      0x2803ffff, 0x4182ffd4, 0x5474442e, 0x48000089, 0x2803ffff, 0x4182ffc4,
      0x7e941b78, 0x28140000, 0x4182ffb8, 0x281422a0, 0x4181ffb0, 0x3ea0003f,
      0x62b59800, 0x3ac00000, 0x3af40000, 0x48000059, 0x2803ffff, 0x4182ff94,
      0x98750000, 0x3ab50001, 0x7ed61a14, 0x36f7ffff, 0x4082ffe4, 0x48000039,
      0x2803ffff, 0x4182ff74, 0x5478442e, 0x48000029, 0x2803ffff, 0x4182ff64,
      0x7f181b78, 0x72d6ffff, 0x7c76c050, 0x28030000, 0x4082ff50, 0x4c00012c,
      0x483f9802, 0x3c600001, 0x6063bd50, 0xa09c0000, 0x70840040, 0x40820020,
      0xb2510000, 0xb2710000, 0x3463ffff, 0x4082ffe8, 0x3c600000, 0x6063ffff,
      0x4e800020, 0xa07d0000, 0x706300ff, 0x4e800020,
    ],
  };
}

/**
 * The staged image: the 0x70-B MTOS descriptor, the entry branch and the
 * dead gap it jumps over (the CRC covers just those) -- and the receiver as
 * a second piece at STUB_AT. The body is NOT staged: it goes up at 115200
 * after the fire (triggerUploadFrame), straight into SRAM.
 * @param {Uint8Array} body - The fast-flash body, checked against the space
 *   below the receiver it will be written into.
 * @returns {{img: Uint8Array, stub: Uint8Array, crc: number, end: number}}
 * @throws {Error} When the body would overrun the receiver.
 */
function triggerImage(body) {
  if (body.length % 4)
    throw new Error('the body is not a whole number of words');
  if (TRIGGER.SRAM_BASE + body.length > TRIGGER.STUB_AT)
    throw new Error(
      `the body (${body.length} B from 0x${TRIGGER.SRAM_BASE.toString(16)}) would overwrite the receiver at 0x${TRIGGER.STUB_AT.toString(16)}`
    );
  const recv = triggerReceiver();
  const codeLen = 4 + 0x40;
  const end = TRIGGER.D_ENTRY + codeLen - 1;
  const code = new Uint8Array(codeLen); // entry branch + the zero gap
  trigBytes.putBe32(code, 0, recv.entry);
  const crc = trigBytes.crc32Mpeg2(code, TRIGGER.MTOS_SEED) >>> 0;
  const img = new Uint8Array(0x70 + codeLen);
  trigBytes.putBe32(img, 0x00, 0x10); // version
  // The 64-byte RSA signature at desc[0x04..0x44] -- slot-6 public key
  // (N6, E6=7), signing MD5 of the C string at desc[0x54] (empty here,
  // so MD5(b"")), in the loader's limbs-LE wire form. Without it the arm
  // pass refuses with 7F 31 10 ~40 ms into fn_869C's RSA verify.
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
  const stub = new Uint8Array(recv.words.length * 4);
  recv.words.forEach((w, i) => trigBytes.putBe32(stub, 4 * i, w));
  return { img, stub, crc, end };
}

/**
 * What the host sends the receiver after the fire, at 115200:
 * A5 5A, u16be length, the body, u16be additive sum of the body.
 * @param {Uint8Array} body
 * @returns {Uint8Array}
 */
function triggerUploadFrame(body) {
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xffff;
  const f = new Uint8Array(4 + body.length + 2);
  f[0] = 0xa5;
  f[1] = 0x5a;
  f[2] = (body.length >> 8) & 0xff;
  f[3] = body.length & 0xff;
  f.set(body, 4);
  f[4 + body.length] = sum >> 8;
  f[5 + body.length] = sum & 0xff;
  return f;
}

/**
 * The body out of a bootstrap blob (core/generated/fast-flasher-blob.js).
 * The blob splices the boot layout [stamp, gate, boot stub, body, ee_write
 * module] as runs over non-blank bytes; the trigger wants the body alone.
 * Its extent: the last run that starts below the ee_write module (at
 * ext EE_MODULE_AT) -- and that extent MUST equal BODY_WORDS, the body the emu
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
    if (at >= TRIGGER.EE_MODULE_AT) continue;
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

  stage('Stopping the DME program (the write enable, nothing erased)');
  r = await sender([
    0x31,
    0x02,
    ...triggerRegion(TRIGGER.ENABLE_AT, TRIGGER.ENABLE_LEN),
  ]);
  // the refusal IS the success: 7F 31 22. An accepted erase (71 02) would
  // mean this loader decodes the address differently -- stop right there.
  if (!r || r[0] !== 0x7f || r[1] !== 0x31 || r[2] !== 0x22)
    throw new Error(
      `the write enable was not answered as expected (${r ? Array.from(r, (x) => x.toString(16).padStart(2, '0')).join(' ') : 'no answer'})`
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
    // {noRetransmit:true} skips the sender's default retry policy. The fire
    // never gets a clean 9600 reply (body is already up at 115200 by the
    // time any reply would land -- ~6 s of retries for nothing). The arm
    // 31 FA ABOVE keeps retransmit on so its 71 FA sig-verify reply is
    // still waited for.
    // {timeout: 400}: a real refusal (7f 31 xx) comes back within ~100 ms;
    // waiting the default ~2 s for a reply the takeover pre-empts was the
    // gap between the fire and the first HELLO ask.
    r = await sender([0x31, 0xfa], { noRetransmit: true, timeout: 400 });
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
  triggerReceiver,
  triggerImage,
  triggerUploadFrame,
  triggerBodyFromBlob,
  triggerRegion,
  triggerStageTelegrams,
  triggerFire,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { triggerWire };
}
