// The resident fast flasher's wire protocol, the app's end. The DME's end is
// ms45-emu's flasher body (docs/fast-flasher.md there); both implement the
// same frozen contract:
//
//   frame     [n][tgt][src][svc][data...][cksum]   n = bytes after itself
//             (tgt..cksum); n == 0 escapes to a u16be length right after it
//             for frames longer than 255 (a CHUNK carries up to ~4.1 KB).
//             cksum = sum(tgt..last data byte) & 0xFF. App -> DME is 12 F1,
//             the DME answers F1 12 (either order is accepted on receive).
//   line      115200 8E1, stop-and-wait: exactly one reply per command. A
//             wired K line echoes every byte the app writes; the link drops
//             it by count before parsing.
//   replies   ACK = svc | 0x40 + payload; NAK = 7F svc reason.
//
//   HELLO        00                                -> 40 + the 16-byte stamp
//   SECTOR_QUERY 01 off:u32 len:u32                -> 41 crc:u32
//   ERASE        02 off:u32  (the one sector holding off)
//   CHUNK        03 off:u32 declen:u16 clen:u16 crc:u32 <clen NRV2B bytes>
//                (crc over the COMPRESSED bytes)
//   VERIFY       04 off:u32 len:u32 crc:u32
//   MARKS        05 which:u8  (0 cal 0x5FF80/0x5FFC0, 1 program) -- the
//                commit point, always last before RESET
//   RESET        06  (the reply goes out, then a watchdog reset)
//   READ         0A off:u32 len:u16 (1..4096)      -> 4A crc:u32 <len bytes>
//                (v13; crc over the bytes; any ext offset, or the MPC
//                window 0x80000000 | offset -- boot block and loader too)
//
// Offsets are ext offsets; the DME refuses anything below 0x40000 or past
// the chip. CRCs are CRC-32/MPEG-2 (poly 04C11DB7, init FFFFFFFF, no
// reflection, no xorout) -- the program checksums' CRC.
//
// Session entry: the DME's gate listens ~600 us after reset for the line
// held low. The app resets the DME (STEUERGERAETE_RESET), holds a break
// across the reboot, releases it, reopens at 115200 8E1 and waits for the
// flasher's unprompted HELLO ack.
/* exported fastFlashWire */

const ffWireBytes =
  typeof bytes !== 'undefined' ? bytes : require('../bytes/index.mjs');

const FF_SVC = {
  HELLO: 0x00,
  SECTOR_QUERY: 0x01,
  ERASE: 0x02,
  CHUNK: 0x03,
  VERIFY: 0x04,
  MARKS: 0x05,
  RESET: 0x06,
  SET_BAUD: 0x07, // v8: u16 SCBR; the body answers at the old rate, then switches
  CHUNK_SET: 0x08, // v8: pagesets over several MPC blocks at once
  AIF: 0x09, // v10 bench body only: the AIF-wipe resume marker (read/arm/done)
  READ: 0x0a, // v13: raw bytes of the chip or the MPC, 4 KB a request
};
/** READ: bytes per request (the body refuses more), and the external chip. */
const FF_READ_MAX = 0x1000;
const FF_EXT_SIZE = 0x100000;

// The AIF marker ladder (S_AIF): READ/ARM/DONE a row of marker slots from
// ext 0x387EC (blank to 0x40000, so it survives a boot-sector erase). An
// erase of the boot sector is refused unless a slot is armed; the AIF
// editor's rewrite and the bootloader install arm one around their erases
// (core/flash/aif.js, core/flash/bl.js).
const FF_AIF = { READ: 0, ARM: 1, DONE: 2 };
const FF_MARK = { FRESH: 0xffff, ARMED: 0xa55a, DONE: 0xa558 };
const FF_SVC_NAME = Object.fromEntries(
  Object.entries(FF_SVC).map(([k, v]) => [v, k])
);
const FF_NAK_REASON = {
  1: 'address not permitted',
  2: 'chunk CRC mismatch',
  3: 'chunk did not decompress',
  4: 'read-back mismatch',
  5: 'verify mismatch',
  6: 'malformed command',
  7: 'CMF driver missing or refused',
};
const FF_TGT = 0x12;
const FF_SRC = 0xf1;
const FF_BAUD = 115200;

/** Per-command answer budgets, ms (an Am29BL802C sector erase can run seconds). */
const FF_TIMEOUT = {
  HELLO: 2000,
  ERASE: 20000,
  CHUNK: 3000,
  MARKS: 2000,
  RESET: 1000,
  SET_BAUD: 2000,
  CHUNK_SET: 3000,
  READ: 3000, // 4 KB is ~0.4 s at 115200 8E1, plus the body's CRC pass
};
/**
 * The faster lines a v8 body is asked for after the probe, in order: the
 * DME's SCI makes 40 MHz / (32 x SCBR) exactly, and an FTDI cable makes
 * these from its 3 MHz clock (exactly, or within 0.2 %). A rate the K-line
 * cannot carry costs one try: the body falls back to 115200 by itself when
 * nothing it can parse arrives within ~2.4 s. What the line carries is the
 * transceivers' edge rate into the harness capacitance: an Si9241-class
 * driver is "typically 200 kBaud" with a short bus (<= 1.3 nF, 510 ohm),
 * 10.4 kBaud at ISO's 10 nF worst case -- so 250 k is a try, 156 k likely.
 */
const FF_FAST_LINES = [
  // sessions start here: 416667 carried the car's line (2026-10-26) but
  // dropped a frame mid-MPC push (2026-10-27); a garbled line steps down
  // from here one rate at a time
  [312500, 4],
  [250000, 5],
  [208333, 6],
  [156250, 8],
];
/**
 * The rates a running flasher may be holding when a cut session is picked up
 * again: the session rates, and the faster ones earlier builds started on.
 */
const FF_RESUME_RATES = [625000, 416667, ...FF_FAST_LINES.map(([r]) => r)];
/** Garbled replies in a session before the line is stepped down a rate. */
const FF_LINE_ERRORS_STEP = 2;
/** How long the body's own fallback to 115200 is waited for after a dead rate. */
const FF_FALLBACK_PATIENCE_MS = 15000;
/** A pageset is one 64-byte page per MPC block. */
const FF_PAGE = 64;
/** SECTOR_QUERY / VERIFY: a base plus this per 64 KB read back. */
const FF_READ_BASE_MS = 2000;
// the body's CRC is bitwise and runs from SRAM on a chip with no
// instruction cache, a flash read and a watchdog service every byte: the
// car's speed is not measured yet, so the budget is generous (an early
// answer costs nothing)
const FF_READ_PER_64K_MS = 4000;
/**
 * Every budget is stretched this much on the emulator (the gateway reports
 * device 'ms45-emu'): it runs the flasher's loops many times slower than the
 * MPC555 -- a whole cal session took ~257 s of wall clock there.
 */
const FF_EMULATOR_SCALE = 20;
/** How long the break is held across the DME's reboot, ms. */
const FF_BREAK_MS = 1500;
/** How many times HELLO is asked after the break, and the pause between, ms. */
const FF_HELLO_ASKS = 2; // a missed entry is retried whole anyway (reset + break)
/**
 * After each reply, this long per reply byte before the next command. The
 * body sends a whole reply and only then reads back its echo, one byte per
 * byte sent; on the real SCI all but ~2 echoes overrun, and it waits its
 * ~20 ms inter-byte timeout for each missing one -- a request sent inside
 * that drain is eaten as echo (the car answered a HELLO sent after a pause
 * and nothing sent right after a reply). The emulator never overruns.
 */
const FF_ECHO_DRAIN_MS = 150; // the real chip's timeout runs longer than its 20 ms nominal
/** The first body that reads each echo as it sends: no pause needed. */
const FF_ECHO_AS_SENT_VERSION = 6;
const FF_HELLO_GAP_MS = 250;

/** The cal sector, and what of it a calibration write fills. */
const FF_CAL_SECTOR = 0x40000;
const FF_CAL_SECTOR_SIZE = 0x20000;
const FF_CAL_LENGTH = 0x1d000;
/** The loader's two cal valid marks (measured on the emulator), sector-relative. */
const FF_CAL_MARKS = [
  [0x1ff80, 0x48249042],
  [0x1ffc0, 0x90482442],
];

/** The external program's three sectors, [start, size] (the loader's erase units). */
const FF_PROGRAM_SECTORS = [
  [0x60000, 0x20000],
  [0x80000, 0x40000],
  [0xc0000, 0x40000],
];
/** What a program flash writes of the external chip; blank above, bar the marks. */
const FF_PROGRAM_START = 0x60000;
const FF_PROGRAM_END = 0xfff40;
/** The loader's two program valid marks (measured on the emulator), absolute. */
const FF_PROGRAM_MARKS = [
  [0xfff80, 0x42902448],
  [0xfffc0, 0x42244890],
];

/** @param {number} v @returns {number[]} */
function _ffU32(v) {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/** @param {number} v @returns {number[]} */
function _ffU16(v) {
  return [(v >>> 8) & 0xff, v & 0xff];
}

/**
 * One frame on the wire.
 * @param {number} svc
 * @param {ArrayLike<number>} [data]
 * @param {number} [tgt]
 * @param {number} [src]
 * @returns {Uint8Array}
 */
function ffFrame(svc, data, tgt = FF_TGT, src = FF_SRC) {
  const body = [tgt, src, svc, ...(data || [])];
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  const span = body.length + 1;
  const head = span > 0xff ? [0x00, ..._ffU16(span)] : [span];
  return Uint8Array.from([...head, ...body, sum]);
}

/**
 * The first whole frame at the head of a buffer.
 * @param {ArrayLike<number>} buf
 * @returns {{tgt: number, src: number, svc: number, data: Uint8Array,
 *   used: number}|null} null while incomplete.
 * @throws {Error} On a checksum that does not add up.
 */
function ffParse(buf) {
  if (!buf.length) return null;
  let span = buf[0];
  let at = 1;
  if (span === 0) {
    if (buf.length < 3) return null;
    span = (buf[1] << 8) | buf[2];
    at = 3;
  }
  if (span < 4)
    throw new Error(`fast flasher: a ${span}-byte frame is not one`);
  if (buf.length < at + span) return null;
  let sum = 0;
  for (let i = at; i < at + span - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[at + span - 1])
    throw new Error('fast flasher: reply checksum does not add up');
  return {
    tgt: buf[at],
    src: buf[at + 1],
    svc: buf[at + 2],
    data: Uint8Array.from(
      Array.prototype.slice.call(buf, at + 3, at + span - 1)
    ),
    used: at + span,
  };
}

/**
 * One session-log line for a command and its reply: "CHUNK 0x40000 4096B
 * (2459B packed) -> ACK 220 ms", "ERASE 0x40000 -> NAK address not
 * permitted 12 ms", "VERIFY ... -> no reply 3000 ms".
 */
function _ffTraceLine(svc, data, reply, ms) {
  const name = FF_SVC_NAME[svc] || `svc ${svc}`;
  let what = '';
  if (svc === FF_SVC.SECTOR_QUERY || svc === FF_SVC.VERIFY)
    what = ` 0x${ffWireBytes.be32(data, 0).toString(16).toUpperCase()} ${ffWireBytes.be32(data, 4)}B`;
  else if (svc === FF_SVC.ERASE)
    what = ` 0x${ffWireBytes.be32(data, 0).toString(16).toUpperCase()}`;
  else if (svc === FF_SVC.CHUNK)
    what = ` 0x${ffWireBytes.be32(data, 0).toString(16).toUpperCase()} ${(data[4] << 8) | data[5]}B (${(data[6] << 8) | data[7]}B packed)`;
  else if (svc === FF_SVC.MARKS) what = data[0] ? ' program' : ' cal';
  else if (svc === FF_SVC.READ)
    what = ` 0x${ffWireBytes.be32(data, 0).toString(16).toUpperCase()} ${(data[4] << 8) | data[5]}B`;
  let got = 'no reply';
  if (reply && reply.svc === 0x7f)
    got = `NAK ${FF_NAK_REASON[reply.data[1]] || `reason ${reply.data[1]}`}`;
  else if (reply)
    got = `ACK${reply.data.length ? ` ${reply.data.length}B` : ''}`;
  return `FF ${name}${what} -> ${got} ${ms} ms`;
}

/** A refusal from the flasher, with its reason. */
class FastFlashNak extends Error {
  /** @param {number} svc @param {number} reason */
  constructor(svc, reason) {
    super(
      `the flasher refused ${FF_SVC_NAME[svc] || svc}: ${FF_NAK_REASON[reason] || `reason ${reason}`}`
    );
    this.svc = svc;
    this.reason = reason;
  }
}

/**
 * The command side over any link: one frame out, one frame back.
 *
 * A link is {exchange(frame, timeoutMs) -> reply frame bytes} -- the Web
 * Serial one below, or a simulated DME in a test.
 */
class FastFlashClient {
  /** @param {{exchange: (frame: Uint8Array, timeoutMs: number) => Promise<Uint8Array>}} link */
  /**
   * @param {{exchange: Function}} link
   * @param {{trace?: (line: string) => void}} [opts] - trace gets one line per
   *   command: service, address, sizes, the reply and its round-trip time --
   *   what the session log keeps for a diagnosis.
   */
  constructor(link, opts = {}) {
    this.link = link;
    this.trace = opts.trace || null;
    this.codec =
      typeof nrv2b !== 'undefined' ? nrv2b : require('./nrv2b.js').nrv2b;
    /** Garbled replies so far (a marginal line shows here first). */
    this.lineErrors = 0;
    /** The line rate the session is on (ffFasterLine and a step-down move it). */
    this.baud = FF_BAUD;
    /** Set by the session: moves the line down a rate; called once at FF_LINE_ERRORS_STEP. */
    this.stepDown = null;
  }

  /**
   * @param {number} svc
   * @param {number[]} data
   * @param {number} timeoutMs
   * @returns {Promise<Uint8Array>} The ACK's payload.
   */
  async call(svc, data, timeoutMs) {
    const frame = ffFrame(svc, data);
    let reply = null;
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      let err = null;
      try {
        reply = ffParse(await this.link.exchange(frame, timeoutMs));
      } catch (e) {
        err = e;
      }
      // a reply that arrived garbled (a bad checksum, a span that is not
      // one): the DME did the command and answered, the line mangled a
      // byte -- every service but RESET is idempotent, so once more. The
      // first program push at 312500 died of two such bytes in 300 replies.
      // ... and a request mangled on the way IN: the body answers "chunk
      // CRC mismatch" or "malformed" to a frame the line damaged, which is
      // just as idempotent to send again
      const refusedAsDamaged =
        !err &&
        reply &&
        reply.svc === 0x7f &&
        (reply.data[1] === 2 || reply.data[1] === 6) &&
        (svc === FF_SVC.CHUNK || svc === FF_SVC.CHUNK_SET);
      const garbled =
        (err && /checksum|frame is not one/.test(err.message || '')) ||
        refusedAsDamaged;
      const again = garbled && svc !== FF_SVC.RESET && attempt === 1;
      if (this.trace)
        this.trace(
          _ffTraceLine(svc, data, reply, Date.now() - t0) +
            (again ? ' -- garbled, once more' : '')
        );
      if (!err && !again) break;
      if (!again) throw err;
      this.lineErrors++;
      if (this.lineErrors >= FF_LINE_ERRORS_STEP && this.stepDown) {
        const down = this.stepDown;
        this.stepDown = null;
        await down();
      }
    }
    if (!reply)
      throw new Error(`fast flasher: no reply to ${FF_SVC_NAME[svc]}`);
    if (reply.svc === 0x7f)
      throw new FastFlashNak(reply.data[0], reply.data[1]);
    if (reply.svc !== (svc | 0x40))
      throw new Error(
        `fast flasher: ${FF_SVC_NAME[svc]} answered with service ${reply.svc.toString(16)}`
      );
    return reply.data;
  }

  /** @param {number} len @returns {number} */
  _readMs(len) {
    return FF_READ_BASE_MS + Math.ceil(len / 0x10000) * FF_READ_PER_64K_MS;
  }

  /** @returns {Promise<Uint8Array>} The stamp the flasher echoes. */
  async hello() {
    return this.call(FF_SVC.HELLO, [], FF_TIMEOUT.HELLO);
  }

  /** @param {number} off @param {number} len @returns {Promise<number>} */
  async sectorQuery(off, len) {
    const d = await this.call(
      FF_SVC.SECTOR_QUERY,
      [..._ffU32(off), ..._ffU32(len)],
      this._readMs(len)
    );
    return ffWireBytes.be32(d, 0);
  }

  /** @param {number} off */
  async erase(off) {
    await this.call(FF_SVC.ERASE, _ffU32(off), FF_TIMEOUT.ERASE);
  }

  /**
   * One chunk: packed here, unpacked and programmed there.
   * @param {number} off
   * @param {Uint8Array} plain - Up to 4 KB.
   * @returns {Promise<number>} The packed size sent.
   */
  async chunk(off, plain) {
    const packed = this.codec.encode(plain);
    await this.call(
      FF_SVC.CHUNK,
      [
        ..._ffU32(off),
        ..._ffU16(plain.length),
        ..._ffU16(packed.length),
        ..._ffU32(ffWireBytes.crc32Mpeg2(packed)),
        ...packed,
      ],
      FF_TIMEOUT.CHUNK
    );
    return packed.length;
  }

  /** @param {number} off @param {number} len @param {number} crc */
  async verify(off, len, crc) {
    await this.call(
      FF_SVC.VERIFY,
      [..._ffU32(off), ..._ffU32(len), ..._ffU32(crc)],
      this._readMs(len)
    );
  }

  /** @param {0|1} which - 0 the cal marks, 1 the program's. */
  async marks(which) {
    await this.call(FF_SVC.MARKS, [which], FF_TIMEOUT.MARKS);
  }

  async reset() {
    await this.call(FF_SVC.RESET, [], FF_TIMEOUT.RESET);
  }

  /**
   * v8: ask the body to switch its line to 40 MHz / (32 x scbr) once it has
   * answered this (at the old rate). The caller re-opens its own port after.
   * @param {number} scbr
   */
  async setBaud(scbr) {
    await this.call(FF_SVC.SET_BAUD, _ffU16(scbr), FF_TIMEOUT.SET_BAUD);
  }

  /**
   * v8: erase several MPC blocks in ONE job (the CMF pulses every selected
   * block together, so fourteen cost what one does).
   * @param {number} mask - Bit n = block n, 14 bits.
   */
  async eraseBlocks(mask) {
    const first = Math.log2(mask & -mask);
    await this.call(
      FF_SVC.ERASE,
      [
        ..._ffU32((FF_MPC_WINDOW | (first * FF_MPC_BLOCK)) >>> 0),
        ..._ffU16(mask),
      ],
      FF_TIMEOUT.ERASE
    );
  }

  /**
   * v8: `pagesets` pagesets starting at `offset` within the block: each is
   * the 64-byte page of every block in `mask`, ascending -- one pulse
   * sequence programs a whole pageset.
   * @param {number} mask - Bit n = block n.
   * @param {number} offset - Within the block, 64-aligned.
   * @param {number} pagesets
   * @param {Uint8Array} plain - pagesets x blocks x 64 bytes, <= 4 KB.
   * @returns {Promise<number>} The packed size sent.
   */
  async chunkSet(mask, offset, pagesets, plain) {
    const packed = this.codec.encode(plain);
    await this.call(
      FF_SVC.CHUNK_SET,
      [
        ..._ffU16(mask),
        ..._ffU16(offset),
        ..._ffU16(plain.length),
        ..._ffU16(packed.length),
        ..._ffU32(ffWireBytes.crc32Mpeg2(packed)),
        pagesets,
        0,
        0,
        0,
        ...packed,
      ],
      FF_TIMEOUT.CHUNK_SET
    );
    return packed.length;
  }

  /**
   * v10 bench body: read the AIF-wipe resume marker halfword at ext 0x387EC.
   * @returns {Promise<number>} 0xFFFF fresh, 0xA55A armed, 0xA558 done.
   */
  async aifRead() {
    const d = await this.call(FF_SVC.AIF, [FF_AIF.READ], FF_TIMEOUT.MARKS);
    return ((d[0] << 8) | d[1]) & 0xffff;
  }

  /** v10 bench body: arm the marker (0xFFFF -> 0xA55A), required before a boot-sector erase. */
  async aifArm() {
    await this.call(FF_SVC.AIF, [FF_AIF.ARM], FF_TIMEOUT.MARKS);
  }

  /** v10 bench body: mark the wipe done (0xA55A -> 0xA558). */
  async aifDone() {
    await this.call(FF_SVC.AIF, [FF_AIF.DONE], FF_TIMEOUT.MARKS);
  }

  /**
   * v13: raw bytes, checked against the CRC the body sends with them. A
   * mismatch is a byte the line mangled inside the data (the frame sum is
   * one byte over 4 KB): asked once more, like a garbled reply.
   * @param {number} off - Ext offset, or FF_MPC_WINDOW | MPC offset.
   * @param {number} len - 1..4096.
   * @returns {Promise<Uint8Array>}
   */
  async read(off, len) {
    for (let attempt = 1; ; attempt++) {
      const d = await this.call(
        FF_SVC.READ,
        [..._ffU32(off), ..._ffU16(len)],
        FF_TIMEOUT.READ
      );
      const bytes = d.subarray(4);
      if (
        bytes.length === len &&
        ffWireBytes.crc32Mpeg2(bytes) === ffWireBytes.be32(d, 0)
      )
        return bytes;
      if (this.trace)
        this.trace(
          `FF READ 0x${off.toString(16).toUpperCase()} ${len}B -> ${bytes.length}B, CRC mismatch${attempt === 1 ? ' -- once more' : ''}`
        );
      if (attempt > 1)
        throw new Error(
          `fast flasher: READ 0x${off.toString(16)} came back damaged twice`
        );
      // damaged data is a marginal line just as a garbled reply is: it
      // counts toward the same step-down
      this.lineErrors++;
      if (this.lineErrors >= FF_LINE_ERRORS_STEP && this.stepDown) {
        const down = this.stepDown;
        this.stepDown = null;
        await down();
      }
    }
  }
}

/**
 * An area through READ, 4 KB a request.
 * @param {FastFlashClient} client
 * @param {number} base - An ext offset, or FF_MPC_WINDOW | an MPC offset.
 * @param {number} size
 * @param {(done: number) => void} [progress] - Bytes read so far.
 * @returns {Promise<Uint8Array>}
 */
async function ffReadArea(client, base, size, progress = () => {}) {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += FF_READ_MAX) {
    const n = Math.min(FF_READ_MAX, size - at);
    out.set(await client.read((base + at) >>> 0, n), at);
    progress(at + n);
  }
  return out;
}

/**
 * Fast Read: the external chip's 1 MB and, when asked, the MPC's 448 KB --
 * the same files a KWP full read saves, ~1.5 MB at the line's rate instead
 * of the loader's 9600 baud.
 * @param {FastFlashClient} client
 * @param {{mpc?: boolean, stage?: (s: string) => void,
 *   progress?: (pct: number) => void}} [cb]
 * @returns {Promise<{flash: Uint8Array, mpc: Uint8Array|null}>}
 */
async function ffReadImage(client, cb = {}) {
  const stage = cb.stage || (() => {});
  const progress = cb.progress || (() => {});
  const total = FF_EXT_SIZE + (cb.mpc ? FF_MPC_SIZE : 0);
  stage('Reading the external flash');
  const flash = await ffReadArea(client, 0, FF_EXT_SIZE, (n) =>
    progress(Math.floor((n * 100) / total))
  );
  let mpc = null;
  if (cb.mpc) {
    stage('Reading the MPC');
    mpc = await ffReadArea(client, FF_MPC_WINDOW, FF_MPC_SIZE, (n) =>
      progress(Math.floor(((FF_EXT_SIZE + n) * 100) / total))
    );
  }
  return { flash, mpc };
}

/**
 * Move an open v8 session to the fastest line the cable and the K-line
 * carry (FF_FAST_LINES, in order), or leave it at 115200. A rate that does
 * not answer HELLO is given up: the port goes back to 115200 and the body is
 * asked again once its own ~2.4 s fallback has run.
 * @param {FastFlashClient} client
 * @param {{rebaud?: (baudRate: number) => Promise<Uint8Array>}} link
 * @param {(s: string) => void} [note]
 * @returns {Promise<number>} The rate the session is on.
 */
async function ffFasterLine(client, link, note = () => {}, preferred = 0) {
  if (!link || !link.rebaud) return FF_BAUD;
  // the rate this DME last held goes first; the list follows for the rest
  const lines = FF_FAST_LINES.filter(([r]) => r === preferred).concat(
    FF_FAST_LINES.filter(([r]) => r !== preferred)
  );
  for (const [rate, scbr] of lines) {
    try {
      await client.setBaud(scbr);
    } catch (e) {
      note(
        `The body refused SET_BAUD ${scbr} (${e.message}); staying at ${FF_BAUD}`
      );
      return FF_BAUD;
    }
    try {
      await link.rebaud(rate);
      await client.setBaud(scbr); // heard: the body may keep the rate
      client.baud = rate;
      note(`Line at ${rate} baud (SCBR ${scbr})`);
      return rate;
    } catch (e) {
      note(`No HELLO at ${rate} baud (${e.message}); back to ${FF_BAUD}`);
      await link.rebaud(FF_BAUD, { patience: FF_FALLBACK_PATIENCE_MS });
      await client.setBaud(11); // confirmed at 115200
    }
  }
  note(`Line stays at ${FF_BAUD} baud`);
  return FF_BAUD;
}

/**
 * The cal sector as the chip holds it after a push: the signed calibration,
 * blank, and the two marks MARKS 0 writes.
 * @param {Uint8Array} signedCal - 0x1D000 bytes, checksummed and signed.
 * @returns {Uint8Array} 0x20000 bytes.
 */
function ffCalSectorImage(signedCal) {
  const s = new Uint8Array(FF_CAL_SECTOR_SIZE).fill(0xff);
  s.set(signedCal, 0);
  for (const [at, word] of FF_CAL_MARKS) s.set(_ffU32(word), at);
  return s;
}

/**
 * Push a calibration through an open flasher session: compare, erase,
 * chunks, verify, marks, reset. Nothing past ERASE is skipped on a failure
 * -- a failed push leaves the cal sector without its marks, which the
 * loader treats as no calibration (the DME stays in the loader until a
 * flash completes, through this or the stock path).
 * @param {FastFlashClient} client
 * @param {Uint8Array} signedCal
 * @param {{stage?: (s: string) => void, progress?: (pct: number, what: string) => void,
 *   note?: (s: string) => void}} [cb]
 * @param {{reset?: boolean}} [opts] - reset: false skips the closing RESET
 *   (a program push follows in the same session and resets).
 * @returns {Promise<{ok: true, skipped: boolean, sent: number, chunks: number}>}
 */
/**
 * Rough work units per step, so one progress bar covers a whole push --
 * the compare, the erases and the verifies as well as the chunks (an erase
 * is the longest single wait; a chunk is the unit).
 */
const FF_UNITS = {
  QUERY: 2,
  ERASE: 6,
  CHUNK: 1,
  VERIFY: 2,
  MARKS: 1,
  RESET: 1,
};

/**
 * A progress counter over work units: each finished step adds its units
 * and reports the overall percent with the step's name.
 * @param {(pct: number, what: string) => void} progress
 * @param {number} total - Units expected; may be raised once known.
 */
function _ffTracker(progress, total) {
  let done = 0;
  return {
    setTotal(t) {
      total = t;
    },
    add(units, what) {
      done += units;
      progress(
        Math.min(100, Math.round((done * 100) / Math.max(1, total))),
        what
      );
    },
  };
}

async function ffPushCal(client, signedCal, cb = {}, opts = {}) {
  // reset: false leaves the flasher running for a program push after it
  const reset = opts.reset !== false;
  const stage = cb.stage || (() => {});
  const note = cb.note || (() => {});
  if (!signedCal || signedCal.length !== FF_CAL_LENGTH)
    throw new Error('fast flasher: the calibration is not 0x1D000 bytes');
  const target = ffCalSectorImage(signedCal);
  const slots = Math.ceil(FF_CAL_LENGTH / 0x1000);
  const U = FF_UNITS;
  const track = _ffTracker(
    cb.progress || (() => {}),
    U.QUERY + U.ERASE + slots * U.CHUNK + U.VERIFY + U.MARKS + U.RESET
  );
  stage('Comparing the calibration on the DME');
  const onChip = await client.sectorQuery(FF_CAL_SECTOR, FF_CAL_SECTOR_SIZE);
  if (onChip === ffWireBytes.crc32Mpeg2(target)) {
    note('The DME already holds exactly this calibration; nothing written');
    track.setTotal(U.QUERY + U.RESET);
    track.add(U.QUERY, 'Compared');
    if (reset) {
      stage('Restarting the DME');
      await client.reset();
    }
    track.add(U.RESET, 'Done');
    return { ok: true, skipped: true, sent: 0, chunks: 0 };
  }
  track.add(U.QUERY, 'Compared');
  stage('Erasing the calibration sector');
  await client.erase(FF_CAL_SECTOR);
  track.add(U.ERASE, 'Erased');
  stage('Writing the calibration');
  let sent = 0;
  let chunks = 0;
  for (let i = 0; i < slots; i++) {
    const at = i * 0x1000;
    const plain = signedCal.subarray(at, Math.min(FF_CAL_LENGTH, at + 0x1000));
    // the erase left it blank already
    if (!plain.every((b) => b === 0xff)) {
      sent += await client.chunk(FF_CAL_SECTOR + at, plain);
      chunks++;
    }
    track.add(U.CHUNK, `Writing chunk ${i + 1} of ${slots}`);
  }
  stage('Verifying');
  await client.verify(
    FF_CAL_SECTOR,
    FF_CAL_LENGTH,
    ffWireBytes.crc32Mpeg2(signedCal)
  );
  track.add(U.VERIFY, 'Verified');
  stage('Marking the calibration valid');
  await client.marks(0);
  track.add(U.MARKS, 'Marked valid');
  if (reset) {
    stage('Restarting the DME');
    await client.reset();
  }
  track.add(U.RESET, 'Done');
  note(
    `Fast flash: ${chunks} chunks, ${sent} bytes on the wire for ${FF_CAL_LENGTH} (${Math.round((sent * 100) / FF_CAL_LENGTH)}%)`
  );
  return { ok: true, skipped: false, sent, chunks };
}

/**
 * The external program area [0x60000,0x100000) as the chip holds it after a
 * full program flash: the signed program to 0xFFF40, blank to the two
 * program marks, blank after. The CRC a SECTOR_QUERY reads back is taken
 * against this, so untouched sectors compare equal and are skipped.
 * @param {Uint8Array} signedFull - The signed 1 MB external image.
 * @returns {Uint8Array} The 0xA0000 bytes from 0x60000 to 0x100000.
 */
function ffProgramAreaImage(signedFull) {
  const area = new Uint8Array(0x100000 - FF_PROGRAM_START).fill(0xff);
  area.set(signedFull.subarray(FF_PROGRAM_START, FF_PROGRAM_END), 0);
  for (const [at, word] of FF_PROGRAM_MARKS)
    area.set(_ffU32(word), at - FF_PROGRAM_START);
  return area;
}

/**
 * The internal (MPC) flash as write units for a v2 flasher: 14 blocks of
 * 32 KB. PROVISIONAL until projects-4c freezes the MPC window -- the wire
 * address of MPC offset o is FF_MPC_WINDOW | o.
 */
const FF_MPC_WINDOW = 0x80000000;
const FF_MPC_BLOCK = 0x8000;
const FF_MPC_SIZE = 0x70000;

/**
 * The write units of a program push, in send order. The external program's
 * three sectors, then -- when the flasher can write the MPC -- its blocks
 * from the top down with block 0 (the reset word at 0x8) last, so an
 * interruption leaves the block that boots the DME untouched for as long as
 * possible.
 * @param {Uint8Array} signedFull - The signed 1 MB external image.
 * @param {Uint8Array|null} mpc - The MPC image (signed against), or null.
 * @returns {Array<{name: string, addr: number, bytes: Uint8Array}>}
 */
function ffProgramUnits(signedFull, mpc) {
  const area = ffProgramAreaImage(signedFull);
  // what is written: the same, with the valid marks left blank -- only MARKS
  // burns them, as the very last step
  const written = Uint8Array.from(area);
  for (const [at] of FF_PROGRAM_MARKS)
    written.fill(0xff, at - FF_PROGRAM_START, at - FF_PROGRAM_START + 4);
  const units = FF_PROGRAM_SECTORS.map(([start, size]) => {
    const from = start - FF_PROGRAM_START;
    return {
      name: `program sector 0x${start.toString(16).toUpperCase()}`,
      addr: start,
      bytes: area.subarray(from, from + size),
      write: written.subarray(from, from + size),
      holdsMarks: FF_PROGRAM_MARKS.some(
        ([at]) => at >= start && at < start + size
      ),
    };
  });
  if (mpc) {
    if (mpc.length !== FF_MPC_SIZE)
      throw new Error('fast flasher: the MPC image is not 448 KB');
    for (let at = FF_MPC_SIZE - FF_MPC_BLOCK; at >= 0; at -= FF_MPC_BLOCK)
      units.push({
        name: `MPC block ${at / FF_MPC_BLOCK}`,
        addr: (FF_MPC_WINDOW | at) >>> 0,
        bytes: mpc.subarray(at, at + FF_MPC_BLOCK),
        write: mpc.subarray(at, at + FF_MPC_BLOCK),
        holdsMarks: false,
      });
  }
  return units;
}

/**
 * Push the program through an open flasher session: per unit (the external
 * program's sectors, and the MPC's blocks when `opts.mpc` is given), compare
 * its CRC and skip it when it already matches, else erase and rewrite it
 * compressed, verifying each as soon as it is written; then mark the program
 * valid. Without `opts.mpc` the MPC is left alone, so the caller must have
 * checked the DME's MPC is the one `signedFull` was signed against (the
 * signature covers MPC segments).
 *
 * The marks are the commit point: a push that fails before MARKS leaves the
 * program without its valid marks, which the loader treats as no program --
 * the DME stays in the loader (recoverable by a full flash) rather than
 * booting a half-written program.
 * @param {FastFlashClient} client
 * @param {Uint8Array} signedFull - The signed 1 MB external image.
 * @param {{stage?: Function, progress?: Function, note?: Function}} [cb]
 * @param {{mpc?: Uint8Array}} [opts] - mpc: also write the MPC (a v2 flasher).
 * @returns {Promise<{ok: true, skipped: boolean, sent: number,
 *   chunks: number, sectorsWritten: number, mpcBlocksWritten: number}>}
 */
async function ffPushProgram(client, signedFull, cb = {}, opts = {}) {
  const stage = cb.stage || (() => {});
  const note = cb.note || (() => {});
  if (!signedFull || signedFull.length !== 0x100000)
    throw new Error('fast flasher: the external image is not 1 MB');
  const units = ffProgramUnits(signedFull, opts.mpc || null);
  const U = FF_UNITS;
  const slotsOf = (size) => Math.ceil(size / 0x1000);
  const unitWork = (u) =>
    U.ERASE + slotsOf(u.bytes.length) * U.CHUNK + U.VERIFY;
  // until the compare says which units differ, assume all of them do
  const track = _ffTracker(
    cb.progress || (() => {}),
    units.length * U.QUERY +
      units.reduce((n, u) => n + unitWork(u), 0) +
      U.MARKS +
      U.RESET
  );

  // which units differ: a read-back CRC per unit, the true diff
  const todo = [];
  for (const [i, u] of units.entries()) {
    stage(`Comparing ${u.name} (${i + 1} of ${units.length})`);
    const have = await client.sectorQuery(u.addr, u.bytes.length);
    if (have !== ffWireBytes.crc32Mpeg2(u.bytes)) todo.push(u);
    track.add(U.QUERY, `Compared ${u.name}`);
  }
  if (!todo.length) {
    note('The DME already holds exactly this program; nothing written');
    track.setTotal(units.length * U.QUERY + U.RESET);
    stage('Restarting the DME');
    await client.reset();
    track.add(U.RESET, 'Done');
    return {
      ok: true,
      skipped: true,
      sent: 0,
      chunks: 0,
      sectorsWritten: 0,
      mpcBlocksWritten: 0,
    };
  }
  note(
    `${todo.length} of ${units.length} units differ: ${todo.map((u) => u.name).join(', ')}`
  );
  track.setTotal(
    units.length * U.QUERY +
      todo.reduce((n, u) => n + unitWork(u), 0) +
      U.MARKS +
      U.RESET
  );

  // The program's valid marks share the top sector with the end of the
  // program and the flasher's own copy. They go FIRST -- that sector is
  // erased before anything else is touched -- and come back LAST: an
  // interruption anywhere in between, even a power loss, leaves the loader
  // finding no marks, parking and answering "program missing", the state a
  // standard Flash Program recovers. Written early, they would let the
  // loader start a half-written program instead.
  const marksUnit = units.find((u) => u.holdsMarks);
  if (marksUnit && !todo.includes(marksUnit)) {
    todo.push(marksUnit);
    track.setTotal(
      units.length * U.QUERY +
        todo.reduce((n, u) => n + unitWork(u), 0) +
        U.MARKS +
        U.RESET
    );
  }
  const order = todo.filter((u) => u !== marksUnit);
  let sent = 0;
  let chunks = 0;
  // v8: the MPC blocks that differ, bar block 0, go as pagesets -- erased in
  // one job and programmed a page in every block per pulse sequence (the
  // CMF's own parallelism; on the car a sequential block was ~16 s, a
  // pageset of thirteen pages costs what one page did). Block 0 keeps its
  // own erase and write, last: the word that boots the DME stays until then.
  const blockOf = (u) => (u.addr - FF_MPC_WINDOW) / FF_MPC_BLOCK;
  const parallel =
    opts.pagesets && opts.mpc
      ? order.filter((u) => u.addr >= FF_MPC_WINDOW && blockOf(u) !== 0)
      : [];
  const sequential = order.filter((u) => !parallel.includes(u));
  const pagesets = parallel.length
    ? Math.max(1, Math.min(64, Math.floor(4096 / (FF_PAGE * parallel.length))))
    : 0;
  // the car's measured rates, per chunk a fixed part and a part that
  // scales with the line (fitted to 115200 and 416667 sessions, 2026-10-26:
  // an external chunk 0.35 s -> 0.14 s, a pageset chunk 0.35 -> 0.23 s plus
  // the CMF's pulses); a sequential MPC block is the CMF's time, not the wire's
  const baud = client.baud || FF_BAUD;
  const slow = FF_BAUD / baud;
  const extChunk = 0.06 + 0.29 * slow;
  const setChunk = 0.187 + 0.163 * slow;
  const seconds =
    sequential.reduce(
      (n, u) =>
        n +
        (u.addr >= FF_MPC_WINDOW
          ? 1 + 8 * 1.9
          : 2.5 + extChunk * slotsOf(u.bytes.length)),
      0
    ) +
    (parallel.length
      ? 1 + (FF_MPC_BLOCK / FF_PAGE / pagesets) * (setChunk + 0.025 * pagesets)
      : 0);
  note(
    `Estimated write time ~${Math.round(seconds)} s at ${baud} baud (the car's measured rates${parallel.length ? `; ${parallel.length} MPC blocks as pagesets` : ''})`
  );
  const writeUnit = async (u, which) => {
    stage(`Writing ${which}`);
    const slots = slotsOf(u.write.length);
    for (let i = 0; i < slots; i++) {
      const plain = u.write.subarray(i * 0x1000, (i + 1) * 0x1000);
      // the erase left it blank; an all-FF chunk needs no write
      if (!plain.every((b) => b === 0xff)) {
        sent += await client.chunk((u.addr + i * 0x1000) >>> 0, plain);
        chunks++;
      }
      track.add(U.CHUNK, `Writing ${which}, chunk ${i + 1} of ${slots}`);
    }
    // verified as soon as it is written: a failure names its unit
    stage(`Verifying ${which}`);
    await client.verify(
      u.addr,
      u.write.length,
      ffWireBytes.crc32Mpeg2(u.write)
    );
    track.add(U.VERIFY, `Verified ${which}`);
  };
  const total = todo.length;
  if (marksUnit) {
    stage(
      `Erasing ${marksUnit.name} first: the program's valid marks go until the end`
    );
    await client.erase(marksUnit.addr);
    track.add(U.ERASE, `Erased ${marksUnit.name}`);
  }
  let n = 0;
  for (const u of sequential) {
    if (parallel.length && u.addr >= FF_MPC_WINDOW && blockOf(u) === 0) break;
    n++;
    const which = `${u.name} (${n} of ${total})`;
    stage(`Erasing ${which}`);
    await client.erase(u.addr);
    track.add(U.ERASE, `Erased ${which}`);
    await writeUnit(u, which);
  }
  if (parallel.length) {
    const blocks = parallel.map(blockOf).sort((a, b) => a - b);
    const mask = blocks.reduce((m, b) => m | (1 << b), 0);
    const which = `MPC blocks ${blocks.join(', ')} (${n + 1}-${n + blocks.length} of ${total}, as pagesets)`;
    stage(`Erasing ${which}`);
    await client.eraseBlocks(mask);
    track.add(U.ERASE * blocks.length, `Erased ${which}`);
    stage(`Writing ${which}`);
    const span = pagesets * FF_PAGE;
    const steps = Math.ceil(FF_MPC_BLOCK / span);
    for (let i = 0; i < steps; i++) {
      const off = i * span;
      // the last set is shorter when the pagesets do not divide the block
      const ps = Math.min(pagesets, (FF_MPC_BLOCK - off) / FF_PAGE);
      const plain = new Uint8Array(ps * FF_PAGE * blocks.length);
      let at = 0;
      for (let p = 0; p < ps; p++)
        for (const b of blocks) {
          const from = b * FF_MPC_BLOCK + off + p * FF_PAGE;
          plain.set(opts.mpc.subarray(from, from + FF_PAGE), at);
          at += FF_PAGE;
        }
      if (!plain.every((x) => x === 0xff)) {
        sent += await client.chunkSet(mask, off, ps, plain);
        chunks++;
      }
      track.add(
        (U.CHUNK * ps * FF_PAGE * blocks.length) / 0x1000,
        `Writing ${which}, pageset ${i + 1} of ${steps}`
      );
    }
    for (const u of parallel) {
      stage(`Verifying ${u.name}`);
      await client.verify(
        u.addr,
        u.write.length,
        ffWireBytes.crc32Mpeg2(u.write)
      );
      track.add(U.VERIFY, `Verified ${u.name}`);
    }
    n += blocks.length;
    for (const u of sequential) {
      if (!(u.addr >= FF_MPC_WINDOW && blockOf(u) === 0)) continue;
      n++;
      const last = `${u.name} (${n} of ${total})`;
      stage(`Erasing ${last}`);
      await client.erase(u.addr);
      track.add(U.ERASE, `Erased ${last}`);
      await writeUnit(u, last);
    }
  }
  if (marksUnit)
    await writeUnit(
      marksUnit,
      `${marksUnit.name} (${total} of ${total}, last)`
    );
  stage('Marking the program valid');
  await client.marks(1);
  track.add(U.MARKS, 'Marked valid');
  stage('Restarting the DME');
  await client.reset();
  track.add(U.RESET, 'Done');
  const mpcBlocksWritten = todo.filter((u) => u.addr >= FF_MPC_WINDOW).length;
  note(
    `Fast flash (program): ${todo.length - mpcBlocksWritten} external sectors, ${mpcBlocksWritten} MPC blocks, ${chunks} chunks, ${sent} bytes on the wire`
  );
  return {
    ok: true,
    skipped: false,
    sent,
    chunks,
    sectorsWritten: todo.length - mpcBlocksWritten,
    mpcBlocksWritten,
  };
}

/**
 * The link over the browser's own cable (WebSerialBus, a local port or a
 * gateway): it talks below the job runner, on the bus's port and reader,
 * while the caller holds the cable claim. The macOS shell's native bridge
 * has no break line here and is refused.
 * @param {object} bus - webBus.
 * @param {{onStep?: (what: string) => void}} [opts] - onStep names each
 *   part of the entry (the break, the speed change, the wait for HELLO).
 * @returns {{enter: () => Promise<Uint8Array>,
 *   exchange: (frame: Uint8Array, timeoutMs: number) => Promise<Uint8Array>,
 *   leave: () => Promise<void>}}
 */
function ffWebLink(bus, opts = {}) {
  const step = opts.onStep || (() => {});
  if (!bus || !bus.port || !bus.port.setSignals || !bus.readSome)
    throw new Error(
      'Fast flash needs a cable with a break line (Web Serial or a gateway)'
    );
  let rx = [];
  // the pause after each reply, per byte: until a HELLO says the body is v6+,
  // assume the old drain (a v5 on the car needs it to be answered at all)
  let drainMs = bus.port.device === 'ms45-emu' ? 0 : FF_ECHO_DRAIN_MS;
  const learn = (hello) => {
    if (hello && hello.data && hello.data[6] >= FF_ECHO_AS_SENT_VERSION)
      drainMs = 0;
  };
  // every byte the cable heard since the last reopen, for the failure text:
  // on a real cable "no answer" and "garbage" need telling apart
  let heard = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const heardText = () =>
    heard.length
      ? `${heard.length} byte(s) heard: ${heard
          .slice(0, 32)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')}${heard.length > 32 ? ' …' : ''}`
      : 'nothing heard';
  const scale = bus.port.device === 'ms45-emu' ? FF_EMULATOR_SCALE : 1;

  /** Read until one whole frame (after `skip` echo bytes) is in. */
  async function readFrame(timeoutMs, echo) {
    const deadline = Date.now() + timeoutMs * scale;
    for (;;) {
      if (echo) {
        // the echo is exactly what was written; anything before it is
        // stale noise from the line
        const at = _ffFind(rx, echo);
        if (at >= 0) {
          rx = rx.slice(at + echo.length);
          echo = null;
        }
      }
      if (!echo) {
        const f = ffParse(rx);
        if (f) {
          const bytes = rx.slice(0, f.used);
          rx = rx.slice(f.used);
          return Uint8Array.from(bytes);
        }
      }
      if (Date.now() >= deadline)
        throw new Error(
          echo
            ? 'fast flasher: no echo from the cable'
            : `fast flasher: the DME did not answer (${
                rx.length
                  ? `after the echo: ${rx
                      .slice(0, 32)
                      .map((b) => b.toString(16).padStart(2, '0'))
                      .join(' ')}`
                  : 'nothing after the echo'
              })`
        );
      const { value, done } = await bus.readSome(deadline);
      if (done) throw new Error('fast flasher: the port closed');
      if (value && value.length) {
        rx.push(...value);
        if (heard.length < 256) heard.push(...value);
      }
    }
  }

  /**
   * Ask for HELLO up to FF_HELLO_ASKS times. On a real cable the first ask
   * can be lost (the reopen's line glitch, the transmit-enable timing), and
   * an unanswered ask costs nothing: the flasher only ever answers.
   */
  async function askHello(self) {
    let last = null;
    for (let i = 1; i <= FF_HELLO_ASKS; i++) {
      step(`Asking the flasher for its HELLO${i > 1 ? ` (try ${i})` : ''}`);
      try {
        const hello = ffParse(
          await self.exchange(ffFrame(FF_SVC.HELLO, []), FF_TIMEOUT.HELLO)
        );
        if (hello && hello.svc === (FF_SVC.HELLO | 0x40)) return hello;
        last = new Error('fast flasher: an answer that was not a HELLO');
      } catch (e) {
        last = e;
      }
      rx = [];
      await sleep(FF_HELLO_GAP_MS);
    }
    throw new Error(`${last ? last.message : 'no HELLO'} (${heardText()})`);
  }

  /**
   * Hold the K-line low until `until` settles, reading what the cable hears
   * meanwhile. DTR is the cable's K-line transmit enable (the bus's fastInit
   * raises it with its break the same way): a break with DTR low never
   * reaches the line. A line that really went low comes back through the
   * echo as a break error or zero bytes; silence means it never did.
   * @param {Promise<unknown>} until
   * @returns {Promise<{low: boolean, text: string}>}
   */
  async function holdLow(until) {
    // the break FIRST and alone: after a reset the gate listens for well
    // under a millisecond, and a combined call (DTR, then the break -- two
    // USB control transfers) landed late enough that every reset entry
    // missed on the car. The break alone reaches this cable's line; DTR
    // follows for the long key-on hold.
    await bus.port.setSignals({ break: true });
    await bus.port.setSignals({ dataTerminalReady: true });
    let over = false;
    const settled = until.then(
      () => (over = true),
      () => (over = true)
    );
    let bytes = 0;
    let zeros = 0;
    let error = null;
    while (!over && !error) {
      try {
        const { value, done } = await bus.readSome(Date.now() + 50);
        if (done) break;
        if (value && value.length) {
          bytes += value.length;
          zeros += value.filter((b) => b === 0).length;
        }
      } catch (e) {
        // the reader is gone until the reopen; the hold goes on regardless
        error = (e && (e.name || e.message)) || 'read error';
      }
    }
    await settled;
    await until;
    const low = error === 'BreakError' || zeros > 0;
    const text = error
      ? `the cable reported ${error}${bytes ? ` after ${bytes} byte(s)` : ''}`
      : bytes
        ? `${bytes} byte(s) heard, ${zeros} of them zero`
        : 'nothing heard';
    return { low, text };
  }

  return {
    /**
     * Hold the line low across the DME's reboot and take the flasher's
     * HELLO. The caller has just reset the DME, or (holdUntil) the line is
     * held while the ignition is switched off and on.
     * @param {{holdUntil?: Promise<unknown>,
     *   onLine?: (line: {low: boolean, text: string}) => void}} [opts]
     * @returns {Promise<Uint8Array>} The stamp it echoed.
     */
    async enter(opts = {}) {
      step('Holding the K-line low across the reboot');
      const line = await holdLow(opts.holdUntil || sleep(FF_BREAK_MS));
      if (opts.onLine) opts.onLine(line);
      step('Switching the cable to 115200');
      // the port goes to 115200 WHILE the break is still held: the flasher
      // answers HELLO ~5 ms after it sees the line released, at 115200, and
      // bytes heard at any other rate are lost. (A real cable may drop the
      // break when the port closes for the reopen; the flasher then speaks a
      // little early, and the asked-for HELLO below covers that.)
      await bus.reopen({
        baudRate: FF_BAUD,
        dataBits: 8,
        stopBits: 1,
        parity: 'even',
      });
      rx = [];
      heard = [];
      // the reopen already put DTR back at its idle level; say both anyway,
      // so the line is released whatever the platform did on close
      await bus.port.setSignals({ break: false, dataTerminalReady: false });
      step('Waiting for the flasher to answer');
      let hello;
      try {
        const unprompted = await readFrame(FF_TIMEOUT.HELLO, null);
        hello = ffParse(unprompted);
        learn(hello);
        await sleep(unprompted.length * drainMs);
      } catch (e) {
        // missed the unprompted one: ask
        rx = [];
        hello = await askHello(this);
      }
      learn(hello);
      if (!hello || hello.svc !== (FF_SVC.HELLO | 0x40))
        throw new Error(`fast flasher: no HELLO from the DME (${heardText()})`);
      return hello.data;
    },
    /**
     * Pick up a flasher that is already running (a session cut short): no
     * reset and no break -- the port goes to 115200 and the flasher is asked
     * for its HELLO.
     * @returns {Promise<Uint8Array>} The stamp it echoed.
     */
    async resume() {
      // the body may be holding a confirmed faster line from the session
      // that was cut short: 115200 first, then each rate it could be on
      let last = null;
      for (const rate of [FF_BAUD, ...FF_RESUME_RATES]) {
        await bus.reopen({
          baudRate: rate,
          dataBits: 8,
          stopBits: 1,
          parity: 'even',
        });
        rx = [];
        heard = [];
        try {
          const hello = await askHello(this);
          learn(hello);
          step(`The flasher answered at ${rate} baud`);
          return hello.data;
        } catch (e) {
          last = e;
        }
      }
      throw last || new Error('fast flasher: no HELLO at any rate');
    },
    /**
     * v8: the port to another rate mid-session (after SET_BAUD), then the
     * flasher asked for its HELLO there. `settle` waits first and
     * `patience` keeps asking for that long -- for the body's own fallback
     * to 115200 after a rate that carried nothing: ~2.4 s of its rx
     * timeouts in the emulator, longer on silicon (the first car test gave
     * up after 3 s and lost the DME to its dead rate).
     * @param {number} baudRate
     * @param {{settle?: number, patience?: number}} [opts]
     * @returns {Promise<Uint8Array>} The stamp it echoed.
     */
    async rebaud(baudRate, opts = {}) {
      await bus.reopen({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'even',
      });
      rx = [];
      heard = [];
      if (opts.settle) await sleep(opts.settle);
      const deadline = Date.now() + (opts.patience || 0);
      for (;;) {
        try {
          const hello = await askHello(this);
          learn(hello);
          return hello.data;
        } catch (e) {
          if (Date.now() >= deadline) throw e;
          rx = [];
          heard = [];
          await sleep(500);
        }
      }
    },
    async exchange(frame, timeoutMs) {
      // DTR stays low. The bus raises it around every K-line write (the
      // reference's transmit enable), but on the car a break with DTR low
      // reached the line, and with the DTR toggle the flasher answered
      // HELLO (5 bytes, DTR held 1 ms) and never a QUERY (13 bytes, 2 ms):
      // the drop's USB transfer lands as the reply starts. Without DTR a
      // cable that needed it would give no echo -- an error that says so.
      await bus.writer.write(frame);
      const reply = await readFrame(timeoutMs, Array.from(frame));
      if (drainMs) await sleep(reply.length * drainMs);
      return reply;
    },
    /** Back to the job runner's world: the next job reopens at its own rate. */
    async leave() {
      rx = [];
      if (bus._resetWireState) bus._resetWireState();
      bus.config = null;
    },
  };
}

/** @param {number[]} hay @param {number[]} needle @returns {number} */
function _ffFind(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++)
      if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

const fastFlashWire = {
  SVC: FF_SVC,
  AIF: FF_AIF,
  MARK: FF_MARK,
  BAUD: FF_BAUD,
  CAL_SECTOR: FF_CAL_SECTOR,
  CAL_LENGTH: FF_CAL_LENGTH,
  crc32: ffWireBytes.crc32Mpeg2,
  frame: ffFrame,
  parse: ffParse,
  Client: FastFlashClient,
  Nak: FastFlashNak,
  calSectorImage: ffCalSectorImage,
  programAreaImage: ffProgramAreaImage,
  pushCal: ffPushCal,
  programUnits: ffProgramUnits,
  MPC_WINDOW: FF_MPC_WINDOW,
  pushProgram: ffPushProgram,
  readArea: ffReadArea,
  readImage: ffReadImage,
  READ_MAX: FF_READ_MAX,
  fasterLine: ffFasterLine,
  FAST_LINES: FF_FAST_LINES,
  webLink: ffWebLink,
};

if (typeof window !== 'undefined') {
  window.fastFlashWire = fastFlashWire;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fastFlashWire };
}
