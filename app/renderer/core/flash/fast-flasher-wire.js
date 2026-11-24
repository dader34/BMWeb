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
//   READ         0A off:u32 len:u16 (1..16384)     -> 4A crc:u32 <len bytes>
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
  READ: 0x0a, // v13: raw bytes of the chip or the MPC; 16 KB a request since v22
  ERASE_Q: 0x0c, // v23: external sectors erased in the background, up to 8 a job
  SETQ: 0x0d, // v24: a CHUNK_SET answered before its pulses; the ACK carries the previous set's result
  SYNC: 0x0e, // v24: the last pipelined set's result
  SET_TIMING: 0x0f, // v26: the reply gap (passes) and the packet the replies are padded to
  READX: 0x10, // v26: READ that leaves blank 4 KB pieces out of the reply
  CHUNKQ: 0x11, // v26: an external CHUNK answered before it is programmed
};
/** SETQ / SYNC result byte: nothing pending. */
const FF_RESULT_NONE = 0xff;
/**
 * Bytes per READ request: 4 KB from a body up to v21, 16 KB from v22 on
 * (the data streams from the array; the cap was the host's patience, and
 * with the ~46 ms a frame costs on the USB side, four times fewer frames
 * is a third off a full read). The client's `readMax` says which; the
 * session sets it from the body's stamp version (dme-fast.js).
 */
const FF_READ_MAX = 0x1000;
const FF_READ_MAX_WIDE = 0x4000;
const FF_READ_WIDE_VERSION = 22;
/** A damaged wide READ is read again in pieces this big. */
const FF_READ_PIECE = 0x1000;
/**
 * v26: the body that reads with blank pieces left out (READX), pipelines
 * the external chunks (CHUNKQ) and takes the reply timing from the host
 * (SET_TIMING). The client's readBlank / pipelineExt switch the first two
 * on; the screen sets them from the body's version.
 */
const FF_V26 = 26;
/**
 * v28: a plain CHUNK for the external chip sent while a pipelined pageset
 * pulses is programmed right there, between the flash driver's steps. The
 * MPC phase is the CMF's time (~40-50 ms a pageset) and leaves the line
 * idle for half of it or more; the chunks that go under it are off the
 * push's clock. While a background erase still holds the chip such a CHUNK
 * is refused at once with FF_NAK_BUSY, and sent again later.
 */
const FF_INTERLEAVE_VERSION = 28;
const FF_NAK_BUSY = 8;
/**
 * What a chunk under the pulses costs beyond its wire time, ms: the body's
 * decode, program and read-back (~36 ms on the car), its answer and the
 * cable's turnaround -- time the line stands idle.
 */
const FF_UNDER_PULSES_MS = 55;
/**
 * One more chunk goes under a set's pulses while it would overrun them by
 * less than this share of its own wire time: the overrun is what it costs
 * the MPC phase, the wire time what it saves after it.
 */
const FF_UNDER_PULSES_OVER = 0.8;
/**
 * The most a pageset's pulses are taken to last, ms, by the blocks it spans
 * (the car: 39 with 6 blocks, 49 with 13, 55 with 14). A set's pulse time is
 * measured from two SETQ answers with nothing sent between them, and what
 * is measured is believed no further than this: the first car run
 * (2026-11-18) timed a SETQ that had gone out twice, read 2.8 s for a 0.2 s
 * set and put seventeen chunks behind each of eight sets, the MPC waiting
 * them all out.
 * @param {number} blocks @returns {number}
 */
function _ffPagesetMaxMs(blocks) {
  return 35 + 2.5 * blocks;
}
/**
 * Every so many sets one pulses with no chunk under it, so that the next
 * answer times a set's pulses afresh.
 */
const FF_PULSES_EVERY = 32;
/** After a busy refusal, how long until the chip is asked again, ms. */
const FF_BUSY_RETRY_MS = 500;
/**
 * A sector erase on the car, ms, by the sector's size: 2.0 s for 128 KB and
 * 2.7 s for 256 KB in the November logs. Only when the chunks start going
 * under the pulses hangs on it; too early is a busy refusal, not a failure.
 * @param {number} size @returns {number}
 */
function _ffEraseMs(size) {
  return 1300 + (700 * size) / 0x20000;
}
/**
 * v27: a SET_BAUD the host cannot follow comes back by itself -- the body
 * returns to the old rate when no valid frame arrives at the new one within
 * ~2-3 s. The host then only has to wait and ask at the old rate.
 */
const FF_PROBATION_VERSION = 27;
const FF_PROBATION_WAIT_MS = 3500;
/**
 * v26 reply timing: the quiet before every reply, in passes of the body's
 * gap loop (4 instructions: the old fixed 50000 ran ~15 ms on the car, a
 * margin for a transmit-enable line the fast link no longer toggles), and
 * the packet the replies are padded to fill -- the cable's FTDI hands a
 * full 62-byte packet over at once and holds a short one for its latency
 * timer (up to 16 ms). Every exchange paid both: ~30 of its ~46 ms floor.
 */
const FF_REPLY_GAP_PASSES = 2000;
const FF_REPLY_PAD = 62;
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
  8: 'the external chip is still erasing',
};
const FF_TGT = 0x12;
const FF_SRC = 0xf1;
const FF_HELLO_ACK = FF_SVC.HELLO | 0x40;
const FF_BAUD = 115200;

/** Per-command answer budgets, ms (an Am29BL802C sector erase can run seconds). */
const FF_TIMEOUT = {
  HELLO: 2000,
  ERASE: 20000,
  // every packed write (CHUNK, CHUNKQ, CHUNK_SET, SETQ), the floor:
  // _chunkMs() stretches it on a slow line. A SETQ is answered before its
  // pulses, but the set before it may still be pulsing: a set's budget too
  CHUNK: 3000,
  MARKS: 2000,
  RESET: 1000,
  SET_BAUD: 2000,
  ERASE_Q: 20000, // ACKed at once, unless an earlier job is still running
  SYNC: 3000,
  READ: 3000, // the floor; _readReplyMs() stretches it for 16 KB on a slow line
};
/**
 * The faster lines a v8 body is asked for after the probe, in order: the
 * DME's SCI makes 40 MHz / (32 x SCBR) exactly, and an FTDI cable makes
 * these from its 3 MHz clock (exactly, or within 0.2 %). A rate the K-line
 * cannot carry at all strands the session: the body holds whatever SET_BAUD
 * named (its fallback to 115200 went with v14), so only a restart of the
 * DME brings it back -- a rate that carries HELLO but garbles now and then
 * is fine, the client steps down a rate mid-job. What the line carries is the
 * transceivers' edge rate into the harness capacitance: an Si9241-class
 * driver is "typically 200 kBaud" with a short bus (<= 1.3 nF, 510 ohm),
 * 10.4 kBaud at ISO's 10 nF worst case -- so 250 k is a try, 156 k likely.
 */
const FF_FAST_LINES = [
  // sessions start here, every session; a garbled line steps down from
  // here one rate at a time, for that session only. 416667 and 312500 are
  // not in the list: 416667's HELLO failed in all three car sessions of
  // 2026-11-02/03, and 312500 garbled replies in both November reads and
  // cost the 2026-11-08 read a reconnect at 5 % -- each garble is a
  // re-read and two of them a step-down, which costs more than the 20 %
  // of wire time 250000 gives up. 250000 has carried every frame so far.
  // 2026-11-09: back to 250000 first. 416667 and then 312500 were tried the
  // same night and each stranded the body at a rate the cable could not
  // follow (the DME holds its relay; only a battery disconnect cleared the
  // first). 250000 has carried every flash on this car.
  [250000, 5],
  [208333, 6],
  [156250, 8],
];
/**
 * The rates a running flasher may be holding when a cut session is picked up
 * again: the session rates, and the faster ones earlier builds started on.
 */
const FF_RESUME_RATES = [
  625000,
  416667,
  312500,
  ...FF_FAST_LINES.map(([r]) => r),
];
/**
 * Garbled replies before the line is stepped down a rate, at the 115200
 * floor where no rate gain can be weighed (see Client._lineError).
 */
const FF_LINE_ERRORS_STEP = 2;
/**
 * What one garble costs, ms: a damaged 4 KB piece read again, or a lost
 * frame found out by its first-byte deadline and sent again. The line steps
 * down only when the garbles of the last FF_LINE_WINDOW frames cost more
 * than the rate gains over the next lower one -- a 16 KB read gains ~0.15 s
 * a frame at 312500 over 250000 and can carry a garble in three; a 2.3 KB
 * chunk gains ~0.02 s and cannot carry one in twenty.
 */
const FF_GARBLE_COST_MS = 400;
const FF_LINE_WINDOW = 24;
/**
 * A READ's reply starts within the USB floor plus the body's CRC pass over
 * the span (~30 ms for 16 KB): nothing by then means the request was lost
 * on the line, and asking again at once beats waiting out the whole budget
 * (3 s -- the November reads lost 0.23 s frames that way, three seconds
 * each). ERASE, CHUNK and CHUNK_SET answer only after their work and get
 * no such limit.
 */
const FF_READ_FIRST_BYTE_MS = 500;
/**
 * Tries of one request whose reply comes back damaged (a bad sum, a cut-short
 * frame, a READ whose CRC fails) before the job gives up on it. Every
 * service but RESET is idempotent. Two was too few on the car (2026-11-02):
 * READ 0x4000 garbled twice running and stopped a read before the line had
 * stepped down once.
 */
const FF_GARBLE_TRIES = 3;

/**
 * The read error (by its DOMException name) after which the serial bus takes
 * a fresh reader -- only the overrun (web-serial-bus.js SERIAL_LINE_ERRORS
 * says why the others are not) -- and which the client therefore treats as
 * a damaged reply, sent again once the line is quiet. A Windows laptop,
 * 2026-11-23: "Buffer overrun" in the middle of a v28 push stopped the
 * flash.
 */
const FF_SERIAL_LINE_ERRORS = new Set(['BufferOverrunError']);

/**
 * After a serial line error, how long the line must stay silent before the
 * request goes again: the DME may still be taking the frame and answering
 * it (a chunk under the pulses answers when its pages are written), and
 * the K line is one wire.
 */
const FF_SETTLE_QUIET_MS = 400;
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
const FF_HELLO_GAP_MS = 250;
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
/** The line rate a body was last heard on in this page, 0 for none (see ffWebLink's learn). */
let ffLastHeardRate = 0;
/**
 * The quick pass of a resume: one HELLO at each rate a running body may be
 * holding, likeliest first, with this much patience each -- a body answers
 * in ~50 ms, and at the wrong rate the line is garbage or silent within
 * that. The patient pass (every ask, every rate) follows only if nothing
 * answered. A flasher left waiting is found in well under a second instead
 * of after ~4.5 s a rate.
 */
const FF_HELLO_QUICK_MS = 150; // an idle body answers in ~10 ms (v26: 7 ms on the car); a busy one is the patient pass's

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

/** An address as the session log writes it. @param {number} v @returns {string} */
function _ffHex(v) {
  return `0x${v.toString(16).toUpperCase()}`;
}

/** The result byte a pipelined ACK or a SYNC carries. @param {Uint8Array} d */
function _ffResult(d) {
  return d.length ? d[0] : FF_RESULT_NONE;
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
  data = data || [];
  const span = data.length + 4; // tgt, src, svc and the sum
  const head = span > 0xff ? [0x00, ..._ffU16(span)] : [span];
  const frame = new Uint8Array(head.length + span);
  frame.set([...head, tgt, src, svc]);
  frame.set(data, head.length + 3);
  let sum = 0;
  for (let i = head.length; i < frame.length - 1; i++) sum += frame[i];
  frame[frame.length - 1] = sum; // the array keeps the low byte
  return frame;
}

/**
 * A whole HELLO reply in the last bytes of a stream (after an upload's
 * echo, however much of the echo the cable kept): the ACK head, then the
 * frame parsing with its checksum. The body's bytes never contain that
 * head followed by a valid 21-byte frame by accident.
 * @param {number[]} buf
 * @returns {{svc: number, data: Uint8Array}|null}
 */
function _ffHelloInTail(buf) {
  const from = Math.max(0, buf.length - 48);
  for (let i = from; i + 4 <= buf.length; i++) {
    if (
      buf[i] !== 16 + 4 || // span: tgt src svc + 16-byte stamp + sum
      buf[i + 1] !== FF_TGT ||
      buf[i + 2] !== FF_SRC ||
      buf[i + 3] !== FF_HELLO_ACK
    )
      continue;
    try {
      const f = ffParse(buf.slice(i));
      if (f) return f;
    } catch {
      // a checksum that does not add up: not the frame
    }
  }
  return null;
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
 * permitted 12 ms", "VERIFY ... -> no reply 3000 ms". A pageset names its
 * offset within the blocks.
 */
function _ffTraceLine(svc, data, reply, ms) {
  const name = FF_SVC_NAME[svc] || `svc ${svc}`;
  const S = FF_SVC;
  const at = () => ` ${_ffHex(ffWireBytes.be32(data, 0))}`;
  const u16 = (i) => (data[i] << 8) | data[i + 1];
  let what = '';
  if (svc === S.SECTOR_QUERY || svc === S.VERIFY)
    what = `${at()} ${ffWireBytes.be32(data, 4)}B`;
  else if (svc === S.ERASE) what = at();
  else if (svc === S.CHUNK || svc === S.CHUNKQ)
    what = `${at()} ${u16(4)}B (${u16(6)}B packed)`;
  else if (svc === S.CHUNK_SET || svc === S.SETQ)
    what = ` ${_ffHex(u16(2))} ${u16(4)}B (${u16(6)}B packed)`;
  else if (svc === S.MARKS) what = data[0] ? ' program' : ' cal';
  else if (svc === S.READ || svc === S.READX) what = `${at()} ${u16(4)}B`;
  let got = 'no reply';
  if (reply && reply.svc === 0x7f)
    got = `NAK ${FF_NAK_REASON[reply.data[1]] || `reason ${reply.data[1]}`}`;
  else if (reply)
    got = `ACK${reply.data.length ? ` ${reply.data.length}B` : ''}`;
  return `FF ${name}${what} -> ${got} ${ms} ms`;
}

// ---- a sector rewrite that is still open ---------------------------------------
// A boot-sector rewrite (the AIF editor's, the bootloader's, the ISN's:
// core/flash/aif.js, bl.js) erases a sector that holds the DME's loader and
// writes it back from an image built off the DME itself. Between the erase
// and the verify that image exists only on this side. A frame lost in that
// window is not the end -- the body runs on in RAM and answers -- but the
// image must be what any later attempt writes: one that reads the sector
// off the DME again takes the erased bytes for the loader and writes THOSE
// back, verified. So the image is kept from the moment its erase goes out
// until its verify passes (here in memory, and in the browser's storage so
// a reloaded page still has it), and RESET -- which ends the body, the only
// thing still able to write that sector -- is not sent while it is open.
const FF_REWRITE_KEY = 'bmweb-boot-rewrite-open';
/** undefined until first asked (then storage is read once); null when none is open. */
let _ffRewrite;

/**
 * The sector rewrite that is open, if one is.
 * @returns {{base: number, data: Uint8Array, what: string}|null}
 */
function ffRewriteOpen() {
  if (_ffRewrite !== undefined) return _ffRewrite;
  _ffRewrite = null;
  try {
    const kept = JSON.parse(localStorage.getItem(FF_REWRITE_KEY) || 'null');
    if (kept && Number.isInteger(kept.base) && typeof kept.data === 'string') {
      const raw = atob(kept.data);
      const data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
      if (data.length)
        _ffRewrite = { base: kept.base, data, what: String(kept.what || '') };
    }
  } catch (e) {
    // no storage, or not a record: nothing is open as far as this page knows
  }
  return _ffRewrite;
}

/**
 * A sector's rewrite begins: called right before its ERASE goes out.
 * @param {number} base - The sector's ext offset.
 * @param {Uint8Array} data - The whole sector as it will be written.
 * @param {string} what - The sector in words, for the messages.
 */
function ffRewriteBegin(base, data, what) {
  _ffRewrite = { base, data: Uint8Array.from(data), what };
  try {
    let raw = '';
    for (let i = 0; i < data.length; i += 0x8000)
      raw += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    localStorage.setItem(
      FF_REWRITE_KEY,
      JSON.stringify({ base, what, data: btoa(raw) })
    );
  } catch (e) {
    // storage blocked or full: kept for as long as the page lives
  }
}

/** The open rewrite is closed: its sector verified, or found not to be this DME's. */
function ffRewriteEnd() {
  _ffRewrite = null;
  try {
    localStorage.removeItem(FF_REWRITE_KEY);
  } catch (e) {
    // nothing was stored
  }
}

/**
 * Where the DME stands on the open rewrite: 'none' (nothing is open, or the
 * record is not about what this DME holds and is dropped), 'whole' (the
 * sector already holds the image: only an answer was lost) or 'open'
 * (part-written). The record is about this DME when its marker is still
 * ARMED and every byte of the sector is one a cut write of the image can
 * have left: erased, or already the image's (programming only clears
 * bits). A sector with bits clear that the image wants set was never that
 * attempt's -- an erase that was refused, another DME.
 * @param {FastFlashClient} client
 * @returns {Promise<'none'|'whole'|'open'>}
 */
async function ffRewriteState(client) {
  const p = ffRewriteOpen();
  if (!p) return 'none';
  let mark;
  try {
    mark = await client.aifRead();
  } catch (e) {
    // not answered as a body with the ladder does: not the session that
    // rewrite ran on. The record stays for one that is.
    return 'none';
  }
  if (mark !== FF_MARK.ARMED) {
    ffRewriteEnd();
    return 'none';
  }
  const have = (await client.sectorQuery(p.base, p.data.length)) >>> 0;
  if (have === ffWireBytes.crc32Mpeg2(p.data) >>> 0) return 'whole';
  const chip = await ffReadArea(client, p.base, p.data.length);
  for (let i = 0; i < chip.length; i++)
    if ((chip[i] & p.data[i]) !== p.data[i]) {
      ffRewriteEnd();
      return 'none';
    }
  return 'open';
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
  /**
   * @param {{exchange: (frame: Uint8Array, timeoutMs: number) =>
   *   Promise<Uint8Array>}} link
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
    /**
     * Why external chunks no longer go under the pagesets' pulses (v28), or
     * '' while they may. Set for the rest of the session, a resumed push
     * included, by a serial line error.
     */
    this.interleaveOff = '';
    /** The last FF_LINE_WINDOW frames: {bad, wireMs}, for the step-down decision. */
    this._recent = [];
    /** Bytes per READ: FF_READ_MAX, or FF_READ_MAX_WIDE on a v22+ body (the session sets it). */
    this.readMax = FF_READ_MAX;
    /** The line rate the session is on (ffFasterLine and a step-down move it). */
    this.baud = FF_BAUD;
    /**
     * Set by the session: moves the line down a rate. Called at every
     * FF_LINE_ERRORS_STEP line errors (the count starts over after each),
     * so a line that keeps garbling keeps going down, to 115200 at the end.
     */
    this.stepDown = null;
  }

  /**
   * One damaged reply: counted, and every FF_LINE_ERRORS_STEP of them the
   * line steps down a rate. The step-down's own SET_BAUDs go through call()
   * with stepDown unset, so a garble there cannot step down again inside it.
   */
  async _lineError() {
    this.lineErrors++;
    this._note(true, 0);
    if (!this.stepDown) return;
    // the rate below this one, and the share of wire time it would cost
    const lower = (FF_FAST_LINES.find(([r]) => r < this.baud) || [FF_BAUD])[0];
    const gain = this.baud > FF_BAUD ? 1 - lower / this.baud : 0;
    const bad = this._recent.filter((f) => f.bad).length;
    const kept = this._recent.reduce((n, f) => n + f.wireMs, 0) * gain;
    // never on a single garble: a step clears the window, and one bad
    // frame right after it would step again on an empty ledger
    const step =
      bad >= FF_LINE_ERRORS_STEP && (!gain || bad * FF_GARBLE_COST_MS > kept);
    if (!step) return;
    const down = this.stepDown;
    this.stepDown = null;
    this.lineErrors = 0;
    this._recent = [];
    try {
      await down();
    } finally {
      this.stepDown = down;
    }
  }

  /**
   * One frame for the step-down window.
   * @param {boolean} bad - garbled or lost
   * @param {number} wireMs - the frame's wire time, request and reply
   */
  _note(bad, wireMs) {
    this._recent.push({ bad, wireMs });
    if (this._recent.length > FF_LINE_WINDOW) this._recent.shift();
  }

  /**
   * @param {number} svc
   * @param {number[]} data
   * @param {number} timeoutMs
   * @param {{firstByteMs?: number}} [opts] - firstByteMs: the reply must
   *   start within this long after the echo, or the request counts as lost
   * @returns {Promise<Uint8Array>} The ACK's payload.
   */
  async call(svc, data, timeoutMs, opts = {}) {
    const frame = ffFrame(svc, data);
    let reply = null;
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      let err = null;
      try {
        reply = ffParse(await this.link.exchange(frame, timeoutMs, opts));
        if (reply) this._note(false, this._wireMs(frame.length + reply.used));
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
      // v25: the body's receive queue refuses a frame with a parity or
      // framing error, so ANY telegram the line damaged comes back
      // "malformed" (6) once the line is quiet -- sent again like the rest.
      // A SETQ answered so was never decoded or pulsed, and the result of
      // the set before it is still pending: the resend is the same frame.
      const refusedAsDamaged =
        !err &&
        reply &&
        reply.svc === 0x7f &&
        (reply.data[1] === 6 ||
          (reply.data[1] === 2 &&
            (svc === FF_SVC.CHUNK ||
              svc === FF_SVC.CHUNK_SET ||
              svc === FF_SVC.SETQ)));
      // ... and a reply cut short: it started arriving and stopped (the car,
      // 2026-11-02: READ 0xDF000 and 0x21000 at 250000, the body back
      // answering HELLO at once -- the bytes went missing on the way)
      // ... and a fault the serial port itself reported (a buffer overrun
      // on Windows): the bytes in flight are gone, the DME is not
      const lineFault = !!err && FF_SERIAL_LINE_ERRORS.has(err.name);
      if (lineFault)
        this.interleaveOff = `the cable reported ${err.name} (${err.message})`;
      const garbled =
        (err &&
          /checksum|frame is not one|after the echo, \d+ byte/.test(
            err.message || ''
          )) ||
        refusedAsDamaged ||
        lineFault;
      const again =
        garbled && svc !== FF_SVC.RESET && attempt < FF_GARBLE_TRIES;
      if (this.trace)
        this.trace(
          _ffTraceLine(svc, data, reply, Date.now() - t0) +
            (again ? ' -- garbled, once more' : '')
        );
      if (!err && !again) break;
      if (!again) throw err;
      // the frame may still be arriving at the DME, and its answer on its
      // way: let the line go quiet, or the resend collides with it
      if (lineFault && this.link.settle) await this.link.settle(timeoutMs);
      await this._lineError();
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

  /**
   * The wire time of `bytes` at the session's rate, 8E1 (11 bits a byte).
   * @param {number} bytes
   * @returns {number} ms
   */
  _wireMs(bytes) {
    return (bytes * 11 * 1000) / (this.baud || FF_BAUD);
  }

  /**
   * A packed write's budget: the old 3 s, stretched to twice the
   * frame's wire time plus a second when the line is slow enough to need
   * it (a 4.6 KB chunk at 115200 is 0.44 s of wire each way). NEVER
   * SHORTER THAN 3 S: a 1.2 s floor was tried on 2026-11-08 and the first
   * car run lost a CHUNK_SET to it -- the ACK arrived after the budget and
   * was read as the answer to the recovery HELLO ("answered with service
   * 48"). The car's answers are ~0.2-0.4 s but a 2 s outlier shows up once
   * in a few hundred frames (1955 ms at 416667, 2106 ms at 115200).
   * @param {number} packed - the compressed payload's size
   * @returns {number} ms
   */
  _chunkMs(packed) {
    return Math.max(
      FF_TIMEOUT.CHUNK,
      Math.round(1000 + 2 * this._wireMs(packed + 24))
    );
  }

  /**
   * One packed write -- CHUNK, CHUNKQ, CHUNK_SET or SETQ: `head`, the plain
   * and packed sizes, the CRC of the packed bytes (the body checks it
   * before it unpacks), `tail`, the packed bytes.
   * @param {number} svc
   * @param {number[]} head
   * @param {Uint8Array} plain - Up to 4 KB.
   * @param {number[]} [tail]
   * @param {{packed?: Uint8Array, minMs?: number}} [opts] - packed: `plain`
   *   packed already; minMs: an answer budget no shorter than this.
   * @returns {Promise<{sent: number, prev: number}>} The packed size sent,
   *   and the result byte of the ACK (a pipelined service's: the write
   *   before this one).
   */
  async _write(svc, head, plain, tail = [], opts = {}) {
    const packed = opts.packed || this.codec.encode(plain);
    const d = await this.call(
      svc,
      [
        ...head,
        ..._ffU16(plain.length),
        ..._ffU16(packed.length),
        ..._ffU32(ffWireBytes.crc32Mpeg2(packed)),
        ...tail,
        ...packed,
      ],
      Math.max(this._chunkMs(packed.length), opts.minMs || 0)
    );
    return { sent: packed.length, prev: _ffResult(d) };
  }

  /** A READ or READX request for `len` bytes at `off`: the ACK's payload. */
  _readCall(svc, off, len) {
    return this.call(
      svc,
      [..._ffU32(off), ..._ffU16(len)],
      this._readReplyMs(len),
      { firstByteMs: FF_READ_FIRST_BYTE_MS }
    );
  }

  /**
   * A READ's budget: the old 3 s, or the reply's wire time doubled plus a
   * second when that is longer (16 KB at 115200 is 1.6 s of wire).
   * @param {number} len - bytes asked for
   * @returns {number} ms
   */
  _readReplyMs(len) {
    return Math.max(
      FF_TIMEOUT.READ,
      Math.round(1000 + 2 * this._wireMs(len + 32))
    );
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
   * @param {{packed?: Uint8Array, minMs?: number}} [opts] - See _write.
   * @returns {Promise<number>} The packed size sent.
   */
  async chunk(off, plain, opts) {
    return (await this._write(FF_SVC.CHUNK, _ffU32(off), plain, [], opts)).sent;
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
    // not while a sector that holds the loader is part-written: the body
    // this would end is the only thing that can still finish it
    if (ffRewriteOpen() && (await ffRewriteState(this)) === 'open')
      // rewriteOpen: so a caller that forgives an unanswered RESET (a read
      // that is already saved) does not forgive this
      throw Object.assign(
        new Error(
          `The rewrite of ${ffRewriteOpen().what || 'a boot sector'} was interrupted and the DME holds only part of it: restarting the DME now would leave it without its loader. Keep the ignition on and run the same write again; it finishes from the image it kept.`
        ),
        { rewriteOpen: true }
      );
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
   * v24: a pageset answered before its pulses. The body decodes the set,
   * answers at once with the PREVIOUS pipelined set's result, then pulses
   * this one while the next frame comes in between its driver's steps --
   * so the wire and the USB turnaround of every set hide under the
   * previous set's pulse time. The result of the last set comes from
   * sync(). A set that failed is gone from the body's buffer by the time
   * the host hears of it: the caller sends it again as a plain chunkSet.
   * @param {number} mask @param {number} offset @param {number} pagesets
   * @param {Uint8Array} plain
   * @returns {Promise<{sent: number, prev: number}>} bytes sent, and the
   *   previous set's result: 0 ok, 4 a page would not take, 7 driver
   *   missing, FF_RESULT_NONE when none was pending.
   */
  async chunkSetQ(mask, offset, pagesets, plain) {
    return this._write(
      FF_SVC.SETQ,
      [..._ffU16(mask), ..._ffU16(offset)],
      plain,
      [pagesets, 0, 0, 0]
    );
  }

  /**
   * v24: the result of the last pipelined set (see chunkSetQ), cleared.
   * @returns {Promise<number>}
   */
  async sync() {
    return _ffResult(await this.call(FF_SVC.SYNC, [], FF_TIMEOUT.SYNC));
  }

  /**
   * v26: the reply timing (FF_REPLY_GAP_PASSES, FF_REPLY_PAD). The ACK
   * comes under the old settings; the link is told the padding after it,
   * so it waits out the filler before its next request.
   * @param {number} gapPasses - 1..; the body counts 0 as 1.
   * @param {number} pad - The packet size, 0 for none.
   */
  async setTiming(gapPasses, pad) {
    // a body still padding from an earlier session: its filler after the
    // HELLO must be off the line before this goes out
    await new Promise((r) => setTimeout(r, 6));
    await this.call(
      FF_SVC.SET_TIMING,
      [..._ffU32(gapPasses), pad & 0xff],
      FF_TIMEOUT.SET_BAUD
    );
    if (this.link.setPad) this.link.setPad(pad & 0xff);
  }

  /**
   * v26: an external chunk answered before it is programmed: the ACK
   * carries the PREVIOUS pipelined op's result (as SETQ's does), the next
   * frame goes out while this one programs, and sync() answers the last.
   * @param {number} off - An external offset.
   * @param {Uint8Array} plain - Up to 4 KB.
   * @returns {Promise<{sent: number, prev: number}>}
   */
  async chunkQ(off, plain) {
    return this._write(FF_SVC.CHUNKQ, _ffU32(off), plain);
  }

  /**
   * v26: READ with the blank 4 KB pieces left out of the reply: [crc4]
   * [mask][the other pieces], mask bit n = piece n all 0xFF. Whole pieces
   * only (offset and length multiples of 4 KB, flash or MPC). A reply that
   * does not check out is read again the plain way, which has its own
   * tries and its 4 KB fallback.
   * @param {number} off @param {number} len
   * @returns {Promise<Uint8Array>}
   */
  async readX(off, len) {
    const d = await this._readCall(FF_SVC.READX, off, len);
    const P = FF_READ_PIECE;
    const mask = d.length > 4 ? d[4] : 0xff;
    const data = d.subarray(5);
    // the pieces that came, in order
    const sent = [];
    for (let i = 0; i < len / P; i++) if (!((mask >> i) & 1)) sent.push(i);
    if (
      d.length >= 5 &&
      data.length === sent.length * P &&
      ffWireBytes.crc32Mpeg2(data) === ffWireBytes.be32(d, 0)
    ) {
      const out = new Uint8Array(len).fill(0xff);
      sent.forEach((i, k) => out.set(data.subarray(k * P, (k + 1) * P), i * P));
      return out;
    }
    if (this.trace)
      this.trace(
        `FF READX ${_ffHex(off)} ${len}B -> did not check out; read plainly`
      );
    await this._lineError();
    return this.read(off, len);
  }

  /**
   * v23: external sectors erased in the background. The body issues the
   * chip's queued sector-erase for all of them and answers at once; the
   * chip erases them on its own (~2 s a sector on the car) while the body
   * goes on with the MPC phase, and the body's next external access waits
   * for the chip. The marks sector must have been erased alone, before:
   * that is what keeps an interruption loader-recoverable.
   * @param {number[]} offsets - 1..8 ext sector offsets (0x40000-0xFFFFF)
   */
  async eraseQueue(offsets) {
    await this.call(
      FF_SVC.ERASE_Q,
      offsets.flatMap((o) => _ffU32(o)),
      FF_TIMEOUT.ERASE_Q
    );
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
    const head = [..._ffU16(mask), ..._ffU16(offset)];
    const tail = [pagesets, 0, 0, 0];
    return (await this._write(FF_SVC.CHUNK_SET, head, plain, tail)).sent;
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
   * @param {number} len - 1..readMax.
   * @returns {Promise<Uint8Array>}
   */
  async read(off, len) {
    for (let attempt = 1; ; attempt++) {
      const d = await this._readCall(FF_SVC.READ, off, len);
      const bytes = d.subarray(4);
      if (
        bytes.length === len &&
        ffWireBytes.crc32Mpeg2(bytes) === ffWireBytes.be32(d, 0)
      )
        return bytes;
      // a damaged wide read: the rest of it was fine, and one bad byte in
      // 16 KB should not cost 16 KB again -- read the span in 4 KB pieces,
      // each with its own tries (this one damage still counts for the line)
      if (len > FF_READ_PIECE) {
        if (this.trace)
          this.trace(
            `FF READ ${_ffHex(off)} ${len}B -> CRC mismatch; in ${FF_READ_PIECE / 1024} KB pieces`
          );
        await this._lineError();
        const out = new Uint8Array(len);
        for (let at = 0; at < len; at += FF_READ_PIECE) {
          const n = Math.min(FF_READ_PIECE, len - at);
          out.set(await this.read((off + at) >>> 0, n), at);
        }
        return out;
      }
      if (this.trace)
        this.trace(
          `FF READ ${_ffHex(off)} ${len}B -> ${bytes.length}B, CRC mismatch${attempt < FF_GARBLE_TRIES ? ' -- once more' : ''}`
        );
      if (attempt >= FF_GARBLE_TRIES)
        throw new Error(
          `fast flasher: READ 0x${off.toString(16)} came back damaged ${attempt} times`
        );
      // damaged data is a marginal line just as a garbled reply is: it
      // counts toward the same step-down
      await this._lineError();
    }
  }
}

/**
 * An area through READ, client.readMax bytes a request.
 * @param {FastFlashClient} client
 * @param {number} base - An ext offset, or FF_MPC_WINDOW | an MPC offset.
 * @param {number} size
 * @param {(done: number) => void} [progress] - Bytes read so far.
 * @param {{out?: Uint8Array, at?: number}} [keep] - Carried across attempts:
 *   the bytes so far and where they end, so a read the connection dropped
 *   out of picks up at the block that failed instead of at the start (every
 *   block is already checked by its own CRC).
 * @returns {Promise<Uint8Array>}
 */
async function ffReadArea(
  client,
  base,
  size,
  progress = () => {},
  keep = null
) {
  if (keep && !(keep.out && keep.out.length === size)) {
    keep.out = new Uint8Array(size);
    keep.at = 0;
  }
  const out = keep ? keep.out : new Uint8Array(size);
  const max = client.readMax || FF_READ_MAX;
  for (let at = keep ? keep.at : 0; at < size; at += max) {
    const n = Math.min(max, size - at);
    const off = (base + at) >>> 0;
    // v26: blank 4 KB pieces stay off the wire (~220 KB of a full read)
    const whole =
      !!client.readBlank &&
      !!client.readX &&
      !(off & 0x40000000) &&
      off % FF_READ_PIECE === 0 &&
      n % FF_READ_PIECE === 0;
    out.set(await (whole ? client.readX(off, n) : client.read(off, n)), at);
    if (keep) keep.at = at + n;
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
 *   progress?: (pct: number) => void,
 *   resume?: {ext?: object, mpc?: object}}} [cb] - `resume`: the same
 *   object on every attempt of one read (ffReadArea's `keep`, per area).
 * @returns {Promise<{flash: Uint8Array, mpc: Uint8Array|null}>}
 */
async function ffReadImage(client, cb = {}) {
  const stage = cb.stage || (() => {});
  const progress = cb.progress || (() => {});
  const total = FF_EXT_SIZE + (cb.mpc ? FF_MPC_SIZE : 0);
  const resume = cb.resume || {};
  // one area, after `before` bytes of the whole: skipped when an earlier
  // attempt finished it, carried on where one stopped
  const area = async (name, key, base, size, before) => {
    const keep = (resume[key] = resume[key] || {});
    if (keep.at === size && keep.out) return keep.out;
    stage(
      `Reading ${name}${keep.at ? `, carrying on at 0x${keep.at.toString(16)}` : ''}`
    );
    return ffReadArea(
      client,
      base,
      size,
      (n) => progress(Math.floor(((before + n) * 100) / total)),
      keep
    );
  };
  const flash = await area('the external flash', 'ext', 0, FF_EXT_SIZE, 0);
  const mpc = cb.mpc
    ? await area('the MPC', 'mpc', FF_MPC_WINDOW, FF_MPC_SIZE, FF_EXT_SIZE)
    : null;
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
      // the body holds the rate SET_BAUD named (no fallback since v14), but
      // the tester's direction can carry where the DME's does not: at 416667
      // on the car (2026-11-02) our frames got through and the replies came
      // back garbled. So tell it to go back while the cable is still on the
      // dead rate, the answer ignored -- an unheard request costs nothing,
      // the body only ever answers
      // v27: the body comes back by itself; wait it out, then ask at 115200
      if (client.bodyVersion >= FF_PROBATION_VERSION) {
        note(`Waiting for the flasher to return to ${FF_BAUD} baud by itself`);
        await new Promise((r) => setTimeout(r, FF_PROBATION_WAIT_MS));
        await link.rebaud(FF_BAUD, { patience: 4000 });
        await client.setBaud(11);
        continue;
      }
      // one copy was not enough on the car (2026-11-09: stranded at 416667,
      // then at 312500): three copies spaced past the body's discard-until-
      // quiet, then a check at 115200, up to six rounds
      const goBack = ffFrame(FF_SVC.SET_BAUD, _ffU16(11));
      let back = false;
      for (let round = 0; round < 6 && !back; round++) {
        if (link.sendBlind) await link.sendBlind(rate, goBack, 3, 220);
        else if (link.exchange)
          try {
            await link.exchange(goBack, FF_TIMEOUT.SET_BAUD);
          } catch {
            // garbled or silent, as expected on a rate that does not carry
          }
        try {
          await link.rebaud(FF_BAUD, { patience: 800 });
          back = true;
        } catch {
          note(
            `The body is not back at ${FF_BAUD} yet (round ${round + 1} of 6)`
          );
        }
      }
      if (!back)
        throw new Error(
          `fast flasher: the flasher took ${rate} baud and could not be brought back to ${FF_BAUD}. ` +
            'Disconnect the battery for a minute to clear it.',
          { cause: e }
        );
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
 * @param {{reset?: boolean, compared?: boolean}} [opts] - reset: false skips
 *   the closing RESET (a program push follows in the same session and
 *   resets). compared: the caller asked the chip already, and it differs.
 * @returns {Promise<{ok: true, skipped: boolean, sent: number, chunks: number}>}
 */
async function ffPushCal(client, signedCal, cb = {}, opts = {}) {
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
  const onChip = opts.compared
    ? -1
    : await client.sectorQuery(FF_CAL_SECTOR, FF_CAL_SECTOR_SIZE);
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
  const q = _ffExtQueue(client);
  for (let i = 0; i < slots; i++) {
    const at = i * 0x1000;
    const plain = signedCal.subarray(at, Math.min(FF_CAL_LENGTH, at + 0x1000));
    // the erase left it blank already
    if (!plain.every((b) => b === 0xff)) {
      sent += await q.chunk(FF_CAL_SECTOR + at, plain);
      chunks++;
    }
    track.add(U.CHUNK, `Writing chunk ${i + 1} of ${slots}`);
  }
  await q.sync();
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

/**
 * Whether the chip holds exactly `bytes` at `at`, by one QUERY.
 * @param {FastFlashClient} client @param {number} at @param {Uint8Array} bytes
 * @returns {Promise<boolean>}
 */
async function _ffHolds(client, at, bytes) {
  return (
    (await client.sectorQuery(at >>> 0, bytes.length)) >>> 0 ===
    ffWireBytes.crc32Mpeg2(bytes) >>> 0
  );
}

/** @param {number} n @returns {Uint8Array} n erased bytes. */
function _ffBlank(n) {
  return new Uint8Array(n).fill(0xff);
}

/**
 * Resume from what the DME holds (the flash is the pointer: no state is
 * kept anywhere else, so a connection that dropped anywhere -- the body
 * still running in RAM -- picks up where the chip says it stopped).
 *
 * The first chunk whose prefix CRC differs from the target's, by gallop
 * then binary search over QUERYs of growing prefixes (~2 lg n probes).
 * @param {FastFlashClient} client
 * @param {number} base
 * @param {Uint8Array} data - The target span.
 * @param {number} chunk - The step (4 KB, or a pageset span in the MPC).
 * @returns {Promise<number>} The chunk index, or ceil(len / chunk) when the
 *   whole span matches.
 */
async function _ffFirstDiffering(client, base, data, chunk) {
  const n = Math.ceil(data.length / chunk);
  const same = (k) => _ffHolds(client, base, data.subarray(0, k * chunk));
  let done = 0;
  let miss = n + 1;
  for (let step = 1; done < n; step *= 2) {
    const k = Math.min(done + step, n);
    if (await same(k)) done = k;
    else {
      miss = k;
      break;
    }
  }
  if (done >= n) return n;
  while (miss - done > 1) {
    const mid = (done + miss) >> 1;
    if (await same(mid)) done = mid;
    else miss = mid;
  }
  return done;
}

/** Whether `have` can become `want` by programming alone (bits only clear). */
function _ffReachable(have, want) {
  return want.every((w, i) => !(w & ~have[i] & 0xff));
}

/**
 * Whether the writing of `data` at `base` can carry on at `at` with no
 * erase: the `len` bytes there are blank or torn toward the target, and
 * everything after them is blank.
 * @returns {Promise<boolean>}
 */
async function _ffCarriesOn(client, base, data, at, len) {
  const end = Math.min(at + len, data.length);
  const have = await client.read((base + at) >>> 0, end - at);
  if (!_ffReachable(have, data.subarray(at, end))) return false;
  return (
    end >= data.length ||
    _ffHolds(client, base + end, _ffBlank(data.length - end))
  );
}

/**
 * How to bring one unit to its target from what the chip holds:
 *   complete  the write span matches (only VERIFY / MARKS are owed)
 *   resume    [0, from) matches, chunk `from` is blank or torn toward the
 *             target, everything after it blank: write from `from`, no erase
 *   erase     anything else (old or foreign content): erase, write from 0
 * On a fresh flash this is one QUERY of the last chunk (old content: erase).
 * @param {FastFlashClient} client
 * @param {number} base
 * @param {Uint8Array} data - The unit's write span.
 * @returns {Promise<{mode: 'complete'|'resume'|'erase', from: number}>}
 */
async function _ffPlanUnit(client, base, data) {
  const C = 0x1000;
  const crc = (b) => ffWireBytes.crc32Mpeg2(b) >>> 0;
  const n = Math.ceil(data.length / C);
  const erase = { mode: 'erase', from: 0 };
  const complete = { mode: 'complete', from: n };
  const tailAt = (n - 1) * C;
  const tail = data.subarray(tailAt);
  const tailHave = (await client.sectorQuery(base + tailAt, tail.length)) >>> 0;
  if (tailHave !== crc(_ffBlank(tail.length)))
    // a written tail: the whole span complete, or old content
    return tailHave === crc(tail) && (await _ffHolds(client, base, data))
      ? complete
      : erase;
  const k = await _ffFirstDiffering(client, base, data, C);
  if (k >= n) return complete;
  return (await _ffCarriesOn(client, base, data, k * C, C))
    ? { mode: 'resume', from: k }
    : erase;
}

/**
 * The same for the MPC pagesets: every block advances a set at a time, in
 * step, so the search runs on one block and the result is then confirmed
 * on all of them -- the sets before it match, the set at it is blank or
 * torn toward the target, the rest blank. `view(b)` is block b's target as
 * the sets write it (block 0's first page blank: it is written last).
 * @returns {Promise<{mode: 'complete'|'resume'|'erase', from: number}>}
 */
async function _ffPlanSets(client, blocks, view, span) {
  const steps = Math.ceil(FF_MPC_BLOCK / span);
  const base = (b) => (FF_MPC_WINDOW | (b * FF_MPC_BLOCK)) >>> 0;
  const erase = { mode: 'erase', from: 0 };
  const ref = blocks[blocks.length - 1];
  const k = await _ffFirstDiffering(client, base(ref), view(ref), span);
  const at = k * span;
  for (const b of blocks) {
    const v = view(b);
    if (k >= steps) {
      if (!(await _ffHolds(client, base(b), v))) return erase;
    } else if (
      (at && !(await _ffHolds(client, base(b), v.subarray(0, at)))) ||
      !(await _ffCarriesOn(client, base(b), v, at, span))
    )
      return erase;
  }
  return { mode: k >= steps ? 'complete' : 'resume', from: k };
}

/**
 * v26: external chunks through CHUNKQ when the client allows it
 * (client.pipelineExt): each answered before it is programmed, its result
 * told with the next ACK, the last by sync(). A chunk that did not take
 * ends the push as a refused CHUNK always has (the resume compares and
 * writes again); a plain CHUNK otherwise.
 * @param {FastFlashClient} client
 * @param {boolean} [allow] - false: plain CHUNKs whatever the client can do
 *   (the MPC's sequential blocks).
 * @returns {{chunk: (off: number, plain: Uint8Array) => Promise<number>,
 *   sync: () => Promise<void>}}
 */
function _ffExtQueue(client, allow = true) {
  const on = !!(allow && client.pipelineExt && client.chunkQ);
  let pending = false;
  const told = (result) => {
    if (result === 4 || result === 7) throw new FastFlashNak(FF_SVC.CHUNK, 4);
  };
  return {
    async chunk(off, plain) {
      if (!on) return client.chunk(off, plain);
      const r = await client.chunkQ(off, plain);
      pending = true;
      told(r.prev);
      return r.sent;
    },
    async sync() {
      if (!on || !pending) return;
      pending = false;
      told(await client.sync());
    },
  };
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
      name: `program sector ${_ffHex(start)}`,
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
 * A push's write time at the car's measured rates, s: per chunk a fixed part
 * and a part that scales with the line (fitted to 115200 and 416667
 * sessions, 2026-10-26: an external chunk 0.35 s -> 0.14 s, a pageset chunk
 * 0.35 -> 0.23 s plus the CMF's pulses); a sequential MPC block is the CMF's
 * time, not the wire's.
 * @param {number} baud
 * @param {Array<{addr: number, bytes: Uint8Array}>} sequential - The units
 *   written one after another.
 * @param {number} pagesets - Pagesets to a set; 0 when no block goes so.
 * @returns {number}
 */
function _ffWriteSeconds(baud, sequential, pagesets) {
  const slow = FF_BAUD / baud;
  const extChunk = 0.06 + 0.29 * slow;
  const setChunk = 0.187 + 0.163 * slow;
  const unit = (u) =>
    u.addr >= FF_MPC_WINDOW
      ? 1 + 8 * 1.9
      : 2.5 + extChunk * Math.ceil(u.bytes.length / 0x1000);
  return (
    sequential.reduce((n, u) => n + unit(u), 0) +
    (pagesets
      ? 1 + (FF_MPC_BLOCK / FF_PAGE / pagesets) * (setChunk + 0.025 * pagesets)
      : 0)
  );
}

/**
 * The pagesets of `blocks`, `pagesets` to a set, each the 64-byte page of
 * every block. Block 0's first page (the reset word at 0x8) goes as 0xFF --
 * an erased page the pulses leave as it is -- and alone, last.
 *
 * v24, pipelined: each set is answered before its pulses, the answer
 * carrying the previous set's result, so the next set's wire time hides
 * under this set's pulses. A set that failed is sent again as a plain
 * CHUNK_SET (stop-and-wait, its own answer), then the pipeline goes on.
 * @param {FastFlashClient} client
 * @param {Uint8Array} mpc - The MPC image.
 * @param {number[]} blocks - Ascending.
 * @param {number} pagesets
 *
 * v28, interleaved (io.feed, pipelined sets only): while a set pulses, the
 * external chunks the feed hands over go out as plain CHUNKs and the body
 * programs them under the pulses -- as many a set as its pulse time has
 * room for. That time is measured: two SETQ answers with nothing sent in
 * between are one set's pulses apart.
 * @param {{from: number, pipeline: boolean, which: string, stage: Function,
 *   note: Function, track: {add: Function}, now?: () => number,
 *   cold?: boolean, onStaged?: () => Promise<void>,
 *   feed?: {next: () => ({addr: number, plain: Uint8Array}|null),
 *     done: (job: object, sent: number) => void, busy: () => void}|null}} io
 *   from: the first set to send (a resumed push; the DME holds the ones
 *   before). feed: next() the chunk to send now or null, done() it took,
 *   busy() the chip refused as still erasing. cold, onStaged: no MPC job has
 *   staged the body's driver yet -- the first set goes on its own, then
 *   onStaged runs.
 * @returns {Promise<{sent: number, chunks: number}>}
 */
async function _ffWriteSets(client, mpc, blocks, pagesets, io) {
  const mask = blocks.reduce((m, b) => m | (1 << b), 0);
  const span = pagesets * FF_PAGE;
  const steps = Math.ceil(FF_MPC_BLOCK / span);
  const units = (bytes) => (FF_UNITS.CHUNK * bytes * blocks.length) / 0x1000;
  let sent = 0;
  let chunks = 0;
  io.stage(`Writing ${io.which}`);
  if (io.from)
    io.track.add(
      units(Math.min(io.from * span, FF_MPC_BLOCK)),
      'Already on the DME'
    );
  const now = io.now || Date.now;
  let answeredAt = 0; // the last SETQ's answer ...
  let alone = false; // ... with nothing sent since ...
  let pulsing = 0; // ... and the pagesets it set pulsing
  let pagesetMs = 0; // a pageset's pulse time as last measured
  let measured = 0; // sets since then
  let noted = false; // the note that interleaving stopped, once
  const plainly = async (set) => {
    alone = false;
    sent += await client.chunkSet(mask, set.off, set.ps, set.plain);
    chunks++;
  };
  // after a SETQ's answer at `t`, its `ps` pagesets now pulsing: the chunks
  // those pulses have room for. setWire: the next set's frame, which must
  // be in before they end. clean: the SETQ was answered at its first try.
  const under = async (t, setWire, ps, clean) => {
    // two answers with nothing sent between them are one set's pulses
    // apart -- unless the second SETQ went out twice (_ffPagesetMaxMs)
    if (alone && clean && pulsing) {
      pagesetMs = Math.min(
        (t - answeredAt) / pulsing,
        _ffPagesetMaxMs(blocks.length)
      );
      measured = 0;
    }
    answeredAt = t;
    alone = true;
    pulsing = ps;
    if (!io.feed || !pagesetMs || ++measured >= FF_PULSES_EVERY) return;
    if (client.interleaveOff) {
      if (!noted) {
        noted = true;
        io.note(
          `No more chunks under the pulses: ${client.interleaveOff}. The rest goes one request at a time.`
        );
      }
      return;
    }
    for (;;) {
      const job = io.feed.next();
      if (!job) return;
      const packed = client.codec.encode(job.plain);
      const wire = client._wireMs(packed.length + 24);
      const over =
        now() - t + wire + FF_UNDER_PULSES_MS + setWire - pagesetMs * ps;
      if (over > wire * FF_UNDER_PULSES_OVER) return;
      alone = false;
      try {
        // (the erase's budget: a chunk that just misses the pulses is
        // written after them, behind whatever the chip is still doing)
        await client.chunk(job.addr, job.plain, {
          packed,
          minMs: FF_TIMEOUT.ERASE,
        });
      } catch (e) {
        if (!(e instanceof FastFlashNak) || e.reason !== FF_NAK_BUSY) {
          // a push that stops here is resumed (a HELLO, the push again):
          // that run goes without chunks under the pulses
          if (!client.interleaveOff)
            client.interleaveOff = `a chunk under the pulses failed (${e.message})`;
          throw e;
        }
        io.feed.busy();
        return;
      }
      io.feed.done(job, packed.length);
    }
  };
  // The body stages the CMF driver at its first MPC job of a session, out
  // of the boot block -- behind whatever the external chip is erasing, and
  // deaf to the line meanwhile. After an MPC erase that is done. Without one
  // (io.cold: a resumed push) the first set goes stop-and-wait, and only
  // then io.onStaged queues the background erases: pipelined, the next SETQ
  // was lost under a 2 s wait for the chip and answered "malformed" 2.7 s
  // later (the car, 2026-11-18).
  let staged = !io.cold;
  let inFlight = null; // the set the body is pulsing, for a resend
  // the result an ACK or the SYNC carries is the set's before: `next` is
  // the one now pulsing
  const told = async (svc, result, next) => {
    if (result === 7) throw new FastFlashNak(svc, 7);
    const failed = result !== 0 && result !== FF_RESULT_NONE && inFlight;
    inFlight = next;
    if (!failed) return false;
    io.note(
      `pageset at 0x${failed.off.toString(16)} did not take: sent again on its own`
    );
    await plainly(failed);
    return true;
  };
  for (let i = io.from; i < steps; i++) {
    const off = i * span;
    // the last set is shorter when the pagesets do not divide the block
    const ps = Math.min(pagesets, (FF_MPC_BLOCK - off) / FF_PAGE);
    const plain = new Uint8Array(ps * FF_PAGE * blocks.length).fill(0xff);
    let at = 0;
    for (let p = 0; p < ps; p++)
      for (const b of blocks) {
        const from = b * FF_MPC_BLOCK + off + p * FF_PAGE;
        if (from) plain.set(mpc.subarray(from, from + FF_PAGE), at);
        at += FF_PAGE;
      }
    const set = { off, ps, plain };
    // a blank set is what the erase left: nothing to pulse
    const blank = plain.every((x) => x === 0xff);
    if (!blank && io.pipeline && staged) {
      const errors = client.lineErrors;
      const r = await client.chunkSetQ(mask, off, ps, plain);
      const answered = now();
      sent += r.sent;
      chunks++;
      // (a set sent again on its own is answered after its pulses: nothing
      // is pulsing then for a chunk to go under)
      if (!(await told(FF_SVC.SETQ, r.prev, set)))
        await under(
          answered,
          client._wireMs ? client._wireMs(r.sent + 28) : 0,
          ps,
          client.lineErrors === errors
        );
    } else if (!blank) {
      await plainly(set);
      if (!staged) {
        staged = true;
        if (io.onStaged) await io.onStaged();
      }
    }
    io.track.add(
      units(ps * FF_PAGE),
      `Writing ${io.which}, pageset ${i + 1} of ${steps}`
    );
  }
  if (inFlight) await told(FF_SVC.SYNC, await client.sync(), null);
  const held = blocks.includes(0) ? mpc.subarray(0, FF_PAGE) : null;
  if (held && !held.every((x) => x === 0xff)) {
    io.stage('Writing MPC block 0, first page (the reset word), last');
    sent += await client.chunkSet(1, 0, 1, held);
    chunks++;
  }
  return { sent, chunks };
}

/**
 * Push the program through an open flasher session: per unit (the external
 * program's sectors, and the MPC's blocks when `opts.mpc` is given), compare
 * its CRC and skip it when it already matches, else erase and rewrite it
 * compressed (every chunk and pageset page read back by the body as it is
 * written, a mismatch a NAK); then mark the program valid. Without `opts.mpc` the MPC is left alone, so the caller must have
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
 * @param {{mpc?: Uint8Array, pagesets?: boolean, block0InSets?: boolean,
 *   interleave?: boolean, clock?: () => number}} [opts]
 *   mpc: also write the MPC (a v2 flasher). pagesets: the differing blocks
 *   bar 0 as pagesets (v8). block0InSets: block 0 joins them -- erased in
 *   the same job, written in the same pagesets -- with only its first page,
 *   the one holding the reset word at 0x8, held back and written alone after
 *   every other page; for a DME the bootloader can always reach (a cut
 *   anywhere is repaired through the ring), ~12 s off a full MPC push.
 *   interleave: external chunks under the pipelined sets' pulses (a v28
 *   body). clock: the time in ms, for a test (Date.now).
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
  // no VERIFY per unit (2026-11-03): the body reads every chunk and every
  // pageset page back against the decoded data -- which it checked against
  // our CRC first -- and NAKs a mismatch, so a unit that took all its writes
  // IS the target; the whole-unit CRC after it read the same bytes again,
  // ~150-430 ms a unit, ~20 units a full push
  const work = (list) =>
    units.length * U.QUERY +
    list.reduce((n, u) => n + U.ERASE + slotsOf(u.bytes.length) * U.CHUNK, 0) +
    U.MARKS +
    U.RESET;
  // until the compare says which units differ, assume all of them do
  const track = _ffTracker(cb.progress || (() => {}), work(units));

  // which units differ: a read-back CRC per unit, the true diff
  const todo = [];
  // opts.cal: the signed calibration, written in this push (Fast Flash
  // Program with a tune): compared first like a unit, and where the
  // external sectors erase in the background its sector joins them --
  // erased under the MPC's pulses and written after them, ~2 s off the
  // clock -- else written first, as ffPushCal does
  let calUnit = null;
  if (opts.cal) {
    if (opts.cal.length !== FF_CAL_LENGTH)
      throw new Error('fast flasher: the calibration is not 0x1D000 bytes');
    const target = ffCalSectorImage(opts.cal);
    stage('Comparing the calibration');
    const have = await client.sectorQuery(FF_CAL_SECTOR, FF_CAL_SECTOR_SIZE);
    if (have !== ffWireBytes.crc32Mpeg2(target))
      calUnit = {
        name: 'the calibration',
        addr: FF_CAL_SECTOR,
        bytes: target,
        write: opts.cal,
        cal: true,
      };
    else note('The DME already holds exactly this calibration');
  }
  for (const [i, u] of units.entries()) {
    stage(`Comparing ${u.name} (${i + 1} of ${units.length})`);
    const have = await client.sectorQuery(u.addr, u.bytes.length);
    if (have !== ffWireBytes.crc32Mpeg2(u.bytes)) todo.push(u);
    track.add(U.QUERY, `Compared ${u.name}`);
  }
  if (!todo.length && calUnit) {
    // the program is the DME's already: the tune alone, as Flash Tune
    await ffPushCal(client, opts.cal, cb, { reset: false, compared: true });
    calUnit = null;
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
  // The program's valid marks share the top sector with the end of the
  // program and the flasher's own copy. They go FIRST -- that sector is
  // erased before anything else is touched -- and come back LAST: an
  // interruption anywhere in between, even a power loss, leaves the loader
  // finding no marks, parking and answering "program missing", the state a
  // standard Flash Program recovers. Written early, they would let the
  // loader start a half-written program instead.
  const marksUnit = units.find((u) => u.holdsMarks);
  if (marksUnit && !todo.includes(marksUnit)) todo.push(marksUnit);
  track.setTotal(work(todo));
  const order = todo.filter((u) => u !== marksUnit);
  let sent = 0;
  let chunks = 0;
  // v8: the MPC blocks that differ, bar block 0, go as pagesets -- erased in
  // one job and programmed a page in every block per pulse sequence (the
  // CMF's own parallelism; on the car a sequential block was ~16 s, a
  // pageset of thirteen pages costs what one page did). Block 0 keeps its
  // own erase and write, last: the word that boots the DME stays until then
  // -- or, with opts.block0InSets, joins the sets with only its first page
  // held back (the pagesets per CHUNK_SET stay 4 at 13 or 14 blocks, so
  // block 0 rides along for nothing).
  const blockOf = (u) => (u.addr - FF_MPC_WINDOW) / FF_MPC_BLOCK;
  const block0InSets = !!(opts.pagesets && opts.mpc && opts.block0InSets);
  const parallel =
    opts.pagesets && opts.mpc
      ? order.filter(
          (u) => u.addr >= FF_MPC_WINDOW && (block0InSets || blockOf(u) !== 0)
        )
      : [];
  const sequential = order.filter((u) => !parallel.includes(u));
  const pagesets = parallel.length
    ? Math.max(1, Math.min(64, Math.floor(4096 / (FF_PAGE * parallel.length))))
    : 0;
  const baud = client.baud || FF_BAUD;
  note(
    `Estimated write time ~${Math.round(_ffWriteSeconds(baud, sequential, pagesets))} s at ${baud} baud (the car's measured rates${parallel.length ? `; ${parallel.length} MPC blocks as pagesets` : ''})`
  );
  // what the chip holds decides, per unit, whether it is erased and where
  // its writing starts (_ffPlanUnit): a push run again after a dropped
  // connection carries on from there instead of starting the unit over
  const plans = new Map();
  const planOf = async (u) => {
    if (plans.has(u)) return plans.get(u);
    const p = await _ffPlanUnit(client, u.addr, u.write);
    plans.set(u, p);
    if (p.mode !== 'erase')
      note(
        p.mode === 'complete'
          ? `${u.name}: already written (the DME holds it); nothing to send`
          : `${u.name}: resumes at chunk ${p.from + 1} of ${slotsOf(u.write.length)} (the DME holds the rest of it); no erase`
      );
    return p;
  };
  const eraseIfPlanned = async (u, what) => {
    if ((await planOf(u)).mode !== 'erase') {
      track.add(U.ERASE, `${what}: no erase needed`);
      return false;
    }
    stage(`Erasing ${what}`);
    await client.erase(u.addr);
    track.add(U.ERASE, `Erased ${what}`);
    return true;
  };
  const writeUnit = async (u, which) => {
    stage(`Writing ${which}`);
    const slots = slotsOf(u.write.length);
    const plan = await planOf(u);
    const held = plan.mode === 'erase' ? 0 : plan.from;
    if (held) track.add(U.CHUNK * Math.min(held, slots), `Already on the DME`);
    // v28: less what went under the MPC's pulses
    const from = Math.max(held, fed.get(u) || 0);
    // v26: the external chunks pipelined; the MPC's go as before
    const q = _ffExtQueue(client, u.addr < FF_MPC_WINDOW);
    for (let i = from; i < slots; i++) {
      const plain = u.write.subarray(i * 0x1000, (i + 1) * 0x1000);
      // the erase left it blank; an all-FF chunk needs no write
      if (!plain.every((b) => b === 0xff)) {
        sent += await q.chunk((u.addr + i * 0x1000) >>> 0, plain);
        chunks++;
      }
      track.add(U.CHUNK, `Writing ${which}, chunk ${i + 1} of ${slots}`);
    }
    await q.sync();
  };
  const total = todo.length;
  /** v28: per external unit, the chunks written so far under the MPC's pulses. */
  const fed = new Map();
  const now = opts.clock || Date.now;
  // v23: with a background erase, the external sectors are queued on the
  // chip before the MPC phase and written after it -- the chip erases
  // them (~2 s each) under the CMF's pulses instead of on the clock. The
  // marks sector is erased alone before that, so an interruption still
  // leaves the loader in charge. The MPC erase goes first: its driver
  // staging reads the boot block, which the body refuses to do while the
  // chip erases.
  const background =
    !!opts.backgroundErase && parallel.length > 0 && !!client.eraseQueue;
  // the calibration: in the background with the external sectors when the
  // MPC phase runs (written after it), else now, before the marks go
  const calBehind = !!calUnit && background;
  const closeCal = async () => {
    stage('Verifying the calibration');
    await client.verify(
      FF_CAL_SECTOR,
      FF_CAL_LENGTH,
      ffWireBytes.crc32Mpeg2(opts.cal)
    );
    stage('Marking the calibration valid');
    await client.marks(0);
  };
  if (calUnit && !calBehind) {
    await eraseIfPlanned(calUnit, 'the calibration sector');
    await writeUnit(calUnit, calUnit.name);
    await closeCal();
    calUnit = null;
  }
  if (marksUnit) {
    // erased first unless the DME shows it erased already (a resumed push):
    // either way the program's marks are gone before anything else is
    await eraseIfPlanned(
      marksUnit,
      `${marksUnit.name} first: the program's valid marks go until the end`
    );
  }
  let n = 0;
  const deferred = background
    ? sequential.filter((u) => u.addr < FF_MPC_WINDOW)
    : [];
  if (calBehind) deferred.unshift(calUnit);
  for (const u of sequential) {
    if (parallel.length && u.addr >= FF_MPC_WINDOW && blockOf(u) === 0) break;
    if (deferred.includes(u)) continue;
    n++;
    const which = `${u.name} (${n} of ${total})`;
    await eraseIfPlanned(u, which);
    await writeUnit(u, which);
  }
  if (parallel.length) {
    const blocks = parallel.map(blockOf).sort((a, b) => a - b);
    const which = `MPC blocks ${blocks.join(', ')} (${n + 1}-${n + blocks.length} of ${total}, as pagesets)`;
    const span = pagesets * FF_PAGE;
    const steps = Math.ceil(FF_MPC_BLOCK / span);
    // the blocks as the sets write them: block 0's first page blank (it
    // goes alone, last)
    const view = (b) => {
      const v = opts.mpc.subarray(b * FF_MPC_BLOCK, (b + 1) * FF_MPC_BLOCK);
      if (b !== 0) return v;
      const c = Uint8Array.from(v);
      c.fill(0xff, 0, FF_PAGE);
      return c;
    };
    const setPlan = await _ffPlanSets(client, blocks, view, span);
    if (setPlan.mode === 'erase') {
      stage(`Erasing ${which}`);
      await client.eraseBlocks(blocks.reduce((m, b) => m | (1 << b), 0));
    } else
      note(
        setPlan.mode === 'complete'
          ? `${which}: every pageset already on the DME; no erase`
          : `${which}: resumes at pageset ${setPlan.from + 1} of ${steps} (the DME holds the ones before); no erase`
      );
    track.add(U.ERASE * blocks.length, `Erased ${which}`);
    // the external units still to erase go to the chip's queue (a resumed
    // push leaves alone what the chip already has)
    const toQueue = [];
    for (const u of deferred)
      if ((await planOf(u)).mode === 'erase') toQueue.push(u);
    // v28: the external units' chunks go under the sets' pulses, in the
    // order they are written after them (the marks' sector last), from
    // when the chip is through the erases queued here -- asked too early
    // it says busy and is asked again. What is left goes after the sets.
    const pipeline = !!opts.pipeline && !!client.chunkSetQ;
    let idleAt = 0;
    let queued = false;
    const queueErases = async (say) => {
      queued = true;
      if (!toQueue.length) return;
      say(`Erasing ${toQueue.map((u) => u.name).join(', ')} in the background`);
      for (let i = 0; i < toQueue.length; i += 8)
        await client.eraseQueue(toQueue.slice(i, i + 8).map((u) => u.addr));
      // the chip's time, not the wire's: the bar moves when the writes land
      idleAt =
        now() + toQueue.reduce((ms, u) => ms + _ffEraseMs(u.bytes.length), 0);
    };
    // no MPC erase in this push: the body's driver may not be staged yet,
    // and the queue waits for the first set (_ffWriteSets' note)
    const cold = setPlan.mode !== 'erase';
    if (!cold) await queueErases(stage);
    let under = 0;
    const feed = pipeline &&
      opts.interleave && {
        next() {
          if (now() < idleAt) return null;
          for (const u of [...deferred, ...(marksUnit ? [marksUnit] : [])]) {
            const plan = plans.get(u);
            if (!plan || plan.mode === 'complete') continue;
            const slots = slotsOf(u.write.length);
            let i = fed.has(u)
              ? fed.get(u)
              : plan.mode === 'erase'
                ? 0
                : plan.from;
            for (; i < slots; i++) {
              const plain = u.write.subarray(i * 0x1000, (i + 1) * 0x1000);
              if (!plain.every((b) => b === 0xff))
                return { u, i, addr: (u.addr + i * 0x1000) >>> 0, plain };
              fed.set(u, i + 1); // blank after the erase: nothing to send
              track.add(
                U.CHUNK,
                `Writing ${u.name}, chunk ${i + 1} of ${slots}`
              );
            }
            fed.set(u, slots);
          }
          return null;
        },
        done(job, size) {
          fed.set(job.u, job.i + 1);
          sent += size;
          chunks++;
          under++;
          track.add(
            U.CHUNK,
            `Writing ${job.u.name}, chunk ${job.i + 1} of ${slotsOf(job.u.write.length)} (under the MPC's pulses)`
          );
        },
        busy() {
          idleAt = now() + FF_BUSY_RETRY_MS;
        },
      };
    const wrote = await _ffWriteSets(client, opts.mpc, blocks, pagesets, {
      from: setPlan.from,
      pipeline,
      which,
      stage,
      note,
      track,
      now,
      feed: feed || null,
      cold,
      onStaged: () => queueErases(note),
    });
    if (!queued) await queueErases(stage); // every set was there already
    sent += wrote.sent;
    chunks += wrote.chunks;
    if (under)
      note(`${under} external chunks were written under the MPC's pulses`);
    n += blocks.length;
    for (const u of sequential) {
      if (!(u.addr >= FF_MPC_WINDOW && blockOf(u) === 0)) continue;
      n++;
      const last = `${u.name} (${n} of ${total})`;
      await eraseIfPlanned(u, last);
      await writeUnit(u, last);
    }
  }
  // v23: the external units whose erase ran in the background, written
  // now that the MPC phase is over (the first chunk waits for the chip)
  for (const u of deferred) {
    if (u.cal) {
      // the calibration as Flash Tune closes it: verified, marked valid
      await writeUnit(u, u.name);
      await closeCal();
      continue;
    }
    n++;
    const which = `${u.name} (${n} of ${total})`;
    track.add(U.ERASE, `Erased ${which} (in the background)`);
    await writeUnit(u, which);
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
  // v26: the packet the body pads its replies to (SET_TIMING), and when the
  // filler after the last reply is off the line: the next request waits for
  // it (the K line is one wire). Filler the cable hands over late is
  // dropped as noise before the next echo (readFrame).
  let pad = 0;
  let padKnown = false;
  let quietAt = 0;
  // the pause after each reply, per byte: until a HELLO says the body is v6+,
  // assume the old drain (a v5 on the car needs it to be answered at all)
  let drainMs = bus.port.device === 'ms45-emu' ? 0 : FF_ECHO_DRAIN_MS;
  const learn = (hello) => {
    if (hello && hello.data && hello.data[6] >= FF_ECHO_AS_SENT_VERSION)
      drainMs = 0;
    // a v26 body may still be padding its replies for an earlier session
    // (SET_TIMING lives in its RAM; a one-click body's stamp is blank,
    // 0xFF): until this session sets the timing, wait out the filler a
    // padded reply would carry. Talking on top of it collided on the one
    // wire -- the car, 2026-11-08: a HELLO answered, the next QUERY lost
    // its echo, after a relay session had set the padding.
    if (!padKnown && hello && hello.data && hello.data[6] >= FF_V26)
      pad = FF_REPLY_PAD;
    // the rate the body was heard on: a later resume (the shared session
    // right after a one-click entry, a push picked up after a drop) asks
    // there first instead of walking the ladder
    if (hello && bus.config && bus.config.baudRate)
      ffLastHeardRate = bus.config.baudRate;
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
  /** The port to `rate`, 8E1, with nothing heard yet. */
  const reopen = async (baudRate) => {
    await bus.reopen({ baudRate, dataBits: 8, stopBits: 1, parity: 'even' });
    rx = [];
    heard = [];
  };
  const isHello = (f) => !!f && f.svc === FF_HELLO_ACK;

  /**
   * Read until one whole frame (after the echo) is in. With firstByteMs,
   * a reply that has not started that long after the echo is a lost
   * request: reported at once, not at the budget's end.
   */
  async function readFrame(timeoutMs, echo, firstByteMs = 0) {
    const deadline = Date.now() + timeoutMs * scale;
    let replyBy = !echo && firstByteMs ? Date.now() + firstByteMs * scale : 0;
    for (;;) {
      if (echo) {
        // the echo is exactly what was written; anything before it is
        // stale noise from the line
        const at = _ffFind(rx, echo);
        if (at >= 0) {
          rx = rx.slice(at + echo.length);
          echo = null;
          if (firstByteMs) replyBy = Date.now() + firstByteMs * scale;
        }
      }
      if (!echo && replyBy && !rx.length && Date.now() >= replyBy)
        throw new Error(
          'fast flasher: the DME did not answer (nothing after the echo)'
        );
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
                  ? `after the echo, ${rx.length} byte(s)${_ffFrameTotal(rx) ? ` of ${_ffFrameTotal(rx)}` : ''}: ${rx
                      .slice(0, 32)
                      .map((b) => b.toString(16).padStart(2, '0'))
                      .join(' ')}`
                  : 'nothing after the echo'
              })`
        );
      const { value, done } = await bus.readSome(
        !echo && replyBy && !rx.length ? Math.min(deadline, replyBy) : deadline
      );
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
  async function askHello(
    self,
    asks = FF_HELLO_ASKS,
    timeoutMs = FF_TIMEOUT.HELLO
  ) {
    let last = null;
    for (let i = 1; i <= asks; i++) {
      step(`Asking the flasher for its HELLO${i > 1 ? ` (try ${i})` : ''}`);
      try {
        const hello = ffParse(
          await self.exchange(ffFrame(FF_SVC.HELLO, []), timeoutMs)
        );
        if (isHello(hello)) return hello;
        // a frame that is not a HELLO: the late answer to the command a
        // cut session was waiting for (the car, 2026-11-08: a CHUNK_SET's
        // ACK read as "answered with service 48"). The body is alive and
        // has said its piece; ask once more after the line goes quiet
        last = new Error(
          `fast flasher: an answer that was not a HELLO (service ${hello ? hello.svc.toString(16) : '?'})`
        );
        if (i === asks) asks++;
      } catch (e) {
        last = e;
      }
      rx = [];
      // a pause before asking again at this rate; none after the last ask
      // (the caller moves to another rate, or gives up)
      if (i < asks) await sleep(FF_HELLO_GAP_MS);
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
      await reopen(FF_BAUD);
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
      if (!isHello(hello))
        throw new Error(`fast flasher: no HELLO from the DME (${heardText()})`);
      return hello.data;
    },
    /**
     * Pick up a flasher that is already running (a session cut short): no
     * reset and no break -- the port goes to 115200 and the flasher is asked
     * for its HELLO.
     * @returns {Promise<Uint8Array>} The stamp it echoed.
     */
    async resume(opts = {}) {
      // the body may be holding a confirmed faster line from the session
      // that was cut short. A quick pass first: one ask at each rate,
      // likeliest first (the session rates in the order sessions try
      // them, then 115200, then the rates older builds held), with
      // FF_HELLO_QUICK_MS of patience each; then the patient pass.
      //
      // opts.quick skips the patient pass. A running flasher answers the
      // quick ask -- it is sitting there waiting -- so the patient pass
      // only ever waits out silence. On identify, where there is usually
      // NO flasher (a one-click body lives in RAM and a key cycle clears
      // it), the patient pass over ~7 rates x 2 asks x 2 s = ~28 s is the
      // whole cost of ruling out a flasher that was never there (the car,
      // 2026-11-08: a 25 s identify, HELLOs on the cable, no cog). The
      // resume-a-push path keeps both passes: there the flasher is known
      // to be present and worth waiting for.
      let last = null;
      const likely = [
        ...new Set([
          ...(ffLastHeardRate ? [ffLastHeardRate] : []),
          ...FF_FAST_LINES.map(([r]) => r),
          FF_BAUD,
          ...FF_RESUME_RATES,
        ]),
      ];
      const passes = opts.quick
        ? [[1, FF_HELLO_QUICK_MS]]
        : [
            [1, FF_HELLO_QUICK_MS],
            [FF_HELLO_ASKS, FF_TIMEOUT.HELLO],
          ];
      for (const [asks, timeoutMs] of passes) {
        for (const rate of likely) {
          await reopen(rate);
          try {
            const hello = await askHello(this, asks, timeoutMs);
            learn(hello);
            step(`The flasher answered at ${rate} baud`);
            return hello.data;
          } catch (e) {
            last = e;
          }
        }
      }
      throw last || new Error('fast flasher: no HELLO at any rate');
    },
    /**
     * The one-click's second stage: the trigger left the receiver stub
     * waiting at 115200 for `frame` (A5 5A len body sum, triggerUploadFrame).
     * The body it jumps to sends a HELLO unprompted, right after our echo.
     * A receiver that saw a bad sum is back hunting for A5 5A, so the whole
     * frame is sent once more before giving up.
     *
     * `opts.within` bounds the whole of it in wall-clock time, emulator or
     * not. Every wait below is stretched FF_EMULATOR_SCALE times on the
     * emulator, which made a DME whose body never started take five minutes
     * to give up; with the bound, each wait is cut to what is left of it and
     * nothing more is sent once it has run out -- the upload stops by
     * itself, rather than going on writing to the line behind the caller's
     * back.
     * @param {Uint8Array} frame
     * @param {{within?: number}} [opts] - within: ms the upload may take.
     * @returns {Promise<Uint8Array>} The stamp the body's HELLO carries.
     * @throws {Error} With `timedOut` set when `within` ran out.
     */
    async upload(frame, opts = {}) {
      const stopAt = opts.within ? Date.now() + opts.within : Infinity;
      const left = () => stopAt - Date.now();
      const outOfTime = () =>
        Object.assign(
          new Error(
            `fast flasher: no HELLO within ${Math.round(opts.within / 1000)} s of the upload`
          ),
          { timedOut: true }
        );
      // a wait, in the unscaled ms readFrame and askHello take, cut to the
      // time that is left (they multiply by `scale` themselves)
      const capped = (ms) => Math.max(1, Math.min(ms, left() / scale));
      const answered = (hello) => {
        learn(hello);
        step(`The flasher answered at ${FF_BAUD} baud`);
        return hello.data;
      };
      await reopen(FF_BAUD);
      let last = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (left() <= 0) throw outOfTime();
        rx = [];
        heard = [];
        step(`Uploading the fast flasher${attempt > 1 ? ' (try 2)' : ''}`);
        await bus.writer.write(frame);
        // the echo comes back first (a wired K line hears itself); what
        // follows it is the body's unprompted HELLO
        const txMs = Math.ceil((frame.length * 11 * 1000) / FF_BAUD);
        const deadline = Math.min(Date.now() + (txMs + 1500) * scale, stopAt);
        // the body's HELLO is taken the moment it is in the stream, echo
        // complete or not: the cable has dropped echo bytes on the car, and
        // waiting for the whole echo and then for a HELLO that was already
        // in the buffer cost the one-click ~4 s after "100 %" (2026-11-08)
        let got = 0;
        let hello = null;
        while (!hello && Date.now() < deadline) {
          const { value, done } = await bus.readSome(deadline);
          if (done) throw new Error('fast flasher: the port closed');
          if (value && value.length) {
            got += value.length;
            rx.push(...value);
          }
          hello = _ffHelloInTail(rx);
          if (!hello && got >= frame.length && rx.length > frame.length + 64)
            break; // the echo is all here and more: nothing that is a HELLO
        }
        if (hello) {
          rx = [];
          return answered(hello);
        }
        rx = got >= frame.length ? rx.slice(frame.length) : [];
        if (left() <= 0) throw outOfTime();
        try {
          hello = ffParse(await readFrame(capped(FF_TIMEOUT.HELLO), null));
          if (isHello(hello)) return answered(hello);
        } catch {
          // the asked-for HELLO below reports the failure instead
        }
        // no unprompted HELLO seen (an adapter without echo, a lost byte):
        // ask for one before sending the frame again
        rx = [];
        if (left() <= 0) throw outOfTime();
        try {
          return answered(
            await askHello(this, FF_HELLO_ASKS, capped(FF_TIMEOUT.HELLO))
          );
        } catch (e) {
          last = e;
        }
      }
      if (left() <= 0) throw outOfTime();
      throw last || new Error('fast flasher: no HELLO after the upload');
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
      await reopen(baudRate);
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
    async exchange(frame, timeoutMs, opts = {}) {
      // DTR stays low. The bus raises it around every K-line write (the
      // reference's transmit enable), but on the car a break with DTR low
      // reached the line, and with the DTR toggle the flasher answered
      // HELLO (5 bytes, DTR held 1 ms) and never a QUERY (13 bytes, 2 ms):
      // the drop's USB transfer lands as the reply starts. Without DTR a
      // cable that needed it would give no echo -- an error that says so.
      const wait = quietAt - Date.now();
      if (wait > 0) await sleep(wait);
      await bus.writer.write(frame);
      const reply = await readFrame(
        timeoutMs,
        Array.from(frame),
        opts.firstByteMs || 0
      );
      if (drainMs) await sleep(reply.length * drainMs);
      if (pad) {
        const filler = (pad - (reply.length % pad)) % pad;
        const rate = (bus.config && bus.config.baudRate) || FF_BAUD;
        if (filler)
          quietAt = Date.now() + Math.ceil((filler * 11 * 1000) / rate) + 1;
      }
      return reply;
    },
    /**
     * Send a frame `copies` times at `rate`, `gapMs` apart, without reading
     * an answer (a rate the cable cannot hear back). The port is left at
     * `rate`.
     */
    async sendBlind(rate, frame, copies = 3, gapMs = 200) {
      await reopen(rate);
      for (let i = 0; i < copies; i++) {
        rx = [];
        await bus.writer.write(frame);
        await sleep(gapMs);
      }
      rx = [];
    },
    /**
     * After a serial line error (FastFlashClient.call): read and drop until
     * the line has been silent FF_SETTLE_QUIET_MS, at most `maxMs`, so the
     * next request does not go out on top of the answer to the last one.
     * The bus has already taken a fresh reader; another fault while waiting
     * means the line is still busy.
     */
    async settle(maxMs) {
      const quiet = FF_SETTLE_QUIET_MS * scale;
      const until = Date.now() + Math.max(quiet, maxMs * scale);
      let since = Date.now();
      while (Date.now() < until && Date.now() - since < quiet) {
        let r;
        try {
          r = await bus.readSome(Math.min(until, since + quiet));
        } catch (e) {
          since = Date.now();
          await sleep(5);
          continue;
        }
        if (r.done) break;
        if (r.value && r.value.length) {
          since = Date.now();
          if (heard.length < 256) heard.push(...r.value);
        }
      }
      rx = [];
      quietAt = 0;
    },
    /** v26: the packet size the body now pads its replies to (0: none). */
    setPad(size) {
      pad = size | 0;
      padKnown = true;
    },
    /** Back to the job runner's world: the next job reopens at its own rate. */
    async leave() {
      rx = [];
      if (bus._resetWireState) bus._resetWireState();
      bus.config = null;
    },
  };
}

/**
 * How long a frame whose first bytes are `rx` is, length byte(s) included
 * (the u16 escape when the first byte is 0; the span counts the checksum),
 * or 0 before that is known.
 * @param {number[]} rx @returns {number}
 */
function _ffFrameTotal(rx) {
  if (!rx.length) return 0;
  if (rx[0]) return 1 + rx[0];
  return rx.length >= 3 ? 3 + ((rx[1] << 8) | rx[2]) : 0;
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
  READ_MAX_WIDE: FF_READ_MAX_WIDE,
  READ_WIDE_VERSION: FF_READ_WIDE_VERSION,
  V26: FF_V26,
  INTERLEAVE_VERSION: FF_INTERLEAVE_VERSION,
  PROBATION_VERSION: FF_PROBATION_VERSION,
  REPLY_GAP_PASSES: FF_REPLY_GAP_PASSES,
  REPLY_PAD: FF_REPLY_PAD,
  RESULT_NONE: FF_RESULT_NONE,
  fasterLine: ffFasterLine,
  FAST_LINES: FF_FAST_LINES,
  webLink: ffWebLink,
  rewriteOpen: ffRewriteOpen,
  rewriteBegin: ffRewriteBegin,
  rewriteEnd: ffRewriteEnd,
  rewriteState: ffRewriteState,
};

if (typeof window !== 'undefined') {
  window.fastFlashWire = fastFlashWire;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fastFlashWire };
}
