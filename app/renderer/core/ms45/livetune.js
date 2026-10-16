/**
 * @file Live tuning of an MS45 running the live-tune program build.
 *
 * The build mirrors opened calibration ranges into RAM and reads them
 * through the lookup library, so an edit takes effect while the engine
 * runs. Its service rides the define-packet service (2C) under local id 6C.
 * See docs/livetune-design.md (ms45-emu) for the DME side.
 *
 * The client speaks to builds 5 and 6: the client places each mirror (op
 * 07) in one of the DME's RAM pools or on "the shelf", the blank end of the
 * calibration sector (op 06), moving the table edited longest ago out of
 * RAM when it runs out; the single values the program reads straight from
 * the calibration are live too, each a mirror of a byte or two, placed on
 * the RAM the DME already keeps for the ones it reads often
 * (`loadSingles`); build 6 puts one more on the processor's data
 * breakpoint (op 09), so the last single value edited is live wherever it
 * is (`watch`); the key-off saves what is open when asked (op 08) and keeps
 * the safety monitor's sum in step. An earlier build answers the ping with
 * its version and is refused.
 */
/* exported LT_STATUS, LT_VERSION, LT_VERSION_MIN, LT_POOLS, LT_SHELF, LT_SINGLES, LtError, LiveTune */

const LT_LOCAL_ID = 0x6c;
const LT_ACK = [0x7f, 0x2c, 0x12]; // every op, and a build-less DME, answer this
const LT_CAL_BASE = 0xffe40000;
const LT_DESC_MAGIC = 0x6c690000;
const LT_PACKET = 0xf0; // the one local identifier the stock define-by-address accepts
/** The current build, and the earliest this client still drives (without the watch). */
const LT_VERSION = 6;
const LT_VERSION_MIN = 5;
/** Where the build keeps its descriptors: magic, then (base,end,delta) per slot, a zero base ends them. */
const LT_DESC = 0x3f9c48;
const LT_DESC_SLOTS = 36;
const LT_SAVE_ARMED = 0x3f9892; // 0x5A here and the key-off saves
const LT_SAVE_ASKED = 0x5a;
const LT_STATE = 0x3f9e74; // magic, status, count, version, .., last mirror, .., watched base, end, delta
const LT_STATE_SIZE = 0x30;
// the RAM a mirror may live in, and the shelf (calibration offsets).
// 0x3f9b48-0x3f9c40 is free on paper but is where the DME keeps the value
// list a tester defines (2C F0, up to 255 bytes from 0x3f9b43): a mirror
// placed there is overwritten by the next define, so nothing goes there
const LT_POOLS = [
  [0x3f9ea4, 0x3fa0a0],
  [0x3f9e10, 0x3f9e74],
  [0x3f9894, 0x3f98b0],
];
const LT_SHELF = [0x1d000, 0x1ff80];
const LT_SINGLES = 0xfa800; // the single-value table, in the external flash
const LT_SINGLES_MAGIC = 0x53564c31; // "SVL1"
const LT_SHELF_MAX = 32; // bytes one shelf request programs
const LT_SHELF_PROBE = 16; // bytes read to tell used shelf from blank
const LT_STATE_MAGIC = 0x4c54554e;
const LT_READ_MAX = 250; // one read-by-address
const LT_WRITE_MAX = 64; // one write op's payload

const LT_STATUS = {
  OK: 0,
  OP: 1,
  FULL: 2,
  ROOM: 3,
  SLOT: 4,
  RANGE: 5,
  TURNING: 6,
  BIG: 7,
  FLASH: 8,
  USED: 9,
  SHELVED: 10,
};

const LT_STATUS_TEXT = {
  [LT_STATUS.OP]: 'the DME does not know this operation',
  [LT_STATUS.FULL]: 'all of the DME’s table slots are in use',
  [LT_STATUS.ROOM]: 'the DME has no room left for a table this size',
  [LT_STATUS.SLOT]: 'the table is no longer open on the DME',
  [LT_STATUS.RANGE]: 'the range runs outside the table or the calibration',
  [LT_STATUS.TURNING]: 'the engine is turning: a save needs it stopped',
  [LT_STATUS.BIG]:
    'the tune differs from the calibration by more than a save can hold',
  [LT_STATUS.FLASH]: 'the DME could not program its flash',
  [LT_STATUS.USED]: 'that part of the shelf is already written',
  [LT_STATUS.SHELVED]:
    'the table is on the shelf and cannot be written in place',
};

/**
 * A live-tune failure, with a code a caller can branch on: `silent`,
 * `absent`, `refused`, `full`, `room`, `verify`, `turning`, `big`, `lost`
 * (the DME restarted and no longer holds what was open).
 */
class LtError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'LtError';
    this.code = code;
  }
}

/** The tester's side of the live-tune service over one DME. */
class LiveTune {
  /**
   * @param {(data: number[]) => Promise<number[]|null>} send - Sends one
   *   request's data bytes, resolves with the answer's data bytes, or null
   *   when the DME said nothing.
   */
  constructor(send) {
    this.send = send;
    /** @type {Array<{slot:number,offset:number,length:number,mirror:number,shadow:Uint8Array,used:number}>} */
    this.tables = [];
    this.version = 1; // until a state read says otherwise
    this.clock = 0; // orders the tables by last use
    /** @type {number|null} Where the shelf's blank part starts; null = not looked yet. */
    this.shelfAt = null;
    /** @type {((text:string)=>void)|null} Told what a slow step is doing. */
    this.onProgress = null;
    /**
     * Version 3: the values with RAM of their own (calibration offset ->
     * length and address) and the runs of calibration whose every reader is
     * patched. Null until `loadSingles`.
     * @type {{pool:Map<number,{length:number,address:number}>,runs:number[][]}|null}
     */
    this.singles = null;
    /**
     * Build 6: the open table on the DME's data breakpoint, whose every
     * read sees its mirror -- one at a time. Null when none is.
     * @type {{slot:number,offset:number,length:number}|null}
     */
    this.watching = null;
  }

  /** The RAM pools a mirror may be placed in. */
  pools() {
    return LT_POOLS;
  }

  /** Whether the DME runs a build this client can drive. */
  supported() {
    return this.version >= LT_VERSION_MIN;
  }

  /** Whether the build has the data breakpoint (`watch`). */
  canWatch() {
    return this.version >= LT_VERSION;
  }

  /**
   * Read the external flash by its file offset (the calibration is at
   * 0x40000): the read-by-address form with a segment byte, as the DME's own
   * diagnostic job sends it.
   * @param {number} at - Offset into the external flash.
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   * @throws {LtError} `silent` or `refused`.
   */
  async readFlash(at, length) {
    const out = new Uint8Array(length);
    for (let done = 0; done < length;) {
      const n = Math.min(LT_READ_MAX, length - done);
      const a = at + done;
      const r = await this.send([
        0x23,
        (a >> 16) & 0xff,
        (a >> 8) & 0xff,
        a & 0xff,
        0x02,
        n,
      ]);
      if (!r) throw new LtError('silent', 'the DME did not answer a read');
      if (r[0] !== 0x63 || r.length < n + 1)
        throw new LtError(
          'refused',
          `the DME refused a flash read at 0x${a.toString(16)}`
        );
      out.set(r.slice(1, 1 + n), done);
      done += n;
    }
    return out;
  }

  /**
   * Read the DME's single-value table. Without it single values
   * are sent like before and take effect after a save.
   * @returns {Promise<boolean>} Whether the DME has one.
   */
  async loadSingles() {
    this.singles = null;
    if (!this.supported()) return false;
    const head = await this.readFlash(LT_SINGLES, 16);
    const w16 = (b, i) => (b[i] << 8) | b[i + 1];
    const w32 = (b, i) =>
      ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    if (w32(head, 0) !== LT_SINGLES_MAGIC) return false;
    const n = w16(head, 4);
    const runs = w16(head, 6);
    const base = w32(head, 8);
    const body = await this.readFlash(LT_SINGLES + 16, 4 * (n + runs));
    const pool = new Map();
    for (let i = 0; i < n; i++) {
      const v = w16(body, 4 * i + 2);
      pool.set(w16(body, 4 * i), {
        length: (v >> 12) + 1,
        address: base + (v & 0xfff),
      });
    }
    const out = [];
    for (let i = n; i < n + runs; i++)
      out.push([w16(body, 4 * i), w16(body, 4 * i) + w16(body, 4 * i + 2)]);
    this.singles = { pool, runs: out };
    return true;
  }

  /**
   * The value with RAM of its own that a range is exactly, or null.
   * @param {number} offset
   * @param {number} length
   * @returns {{length:number,address:number}|null}
   */
  pooled(offset, length) {
    const e = this.singles && this.singles.pool.get(offset);
    return e && e.length === length ? e : null;
  }

  /**
   * Whether an edit of this range of single values takes effect at once:
   * every instruction that reads it goes through the mirrors. A range that
   * only partly matches a value with RAM of its own does not (its readers
   * read that RAM, which a mirror elsewhere does not reach).
   * @param {number} offset
   * @param {number} length
   * @returns {boolean}
   */
  liveSingle(offset, length) {
    const w = this.watching;
    if (w && w.offset === offset && w.length === length) return true;
    if (!this.singles) return false;
    if (this.pooled(offset, length)) return true;
    for (const [lo, e] of this.singles.pool)
      if (lo < offset + length && offset < lo + e.length) return false;
    return this.singles.runs.some(
      ([lo, hi]) => lo <= offset && offset + length <= hi
    );
  }

  /**
   * Read the stored calibration (flash) by its offset: the read-by-address
   * form with a segment byte, as the DME's own diagnostic job sends it.
   * @param {number} offset - Calibration offset.
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   * @throws {LtError} `silent` or `refused`.
   */
  async readCal(offset, length) {
    return this.readFlash(0x40000 + offset, length);
  }

  /**
   * Whether a mirror sits on a single value's own RAM: it stays there.
   * @param {{offset:number,length:number,mirror:number}} table
   * @returns {boolean}
   */
  isFixed(table) {
    const own = this.pooled(table.offset, table.length);
    return !!own && own.address === table.mirror;
  }

  /**
   * Whether a table's mirror is on the shelf (flash) and not in RAM.
   * @param {{mirror:number}} table
   * @returns {boolean}
   */
  shelved(table) {
    return table.mirror >= LT_CAL_BASE;
  }

  /**
   * Read part of an open table as the DME's lookups see it, wherever its
   * mirror lives.
   * @param {{mirror:number}} table
   * @param {number} at - Offset inside the table.
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   */
  async readTable(table, at, length) {
    return this.shelved(table)
      ? this.readCal(table.mirror - LT_CAL_BASE + at, length)
      : this.readMemory(table.mirror + at, length);
  }

  /**
   * Tell the DME which pieces of memory its packet is made of: the stock
   * define-by-address of local identifier F0 (2C F0), which every MS45
   * program has. One request names them all, a later one replaces it, and
   * the DME forgets it at a restart. `readPacket` then fetches every piece
   * in a single exchange -- what several reads by address cost several of.
   * @param {Array<{address:number, size:number}>} pieces - Up to 42.
   * @returns {Promise<boolean>} False when the DME would not take it.
   * @throws {LtError} `silent`.
   */
  async definePacket(pieces) {
    const req = [0x2c, LT_PACKET];
    let position = 1;
    for (const p of pieces) {
      req.push(
        0x03,
        position,
        p.size,
        (p.address >> 16) & 0xff,
        (p.address >> 8) & 0xff,
        p.address & 0xff
      );
      position += p.size;
    }
    const r = await this.send(req);
    if (!r)
      throw new LtError('silent', 'the DME did not answer a packet definition');
    return r[0] === 0x6c;
  }

  /**
   * Forget the packet (2C F0 04), as the DME's own measurement-block jobs
   * do when they are done with it: the identifier is the only one there is,
   * and BMW's diagnostic jobs use it too.
   * @returns {Promise<void>}
   */
  async clearPacket() {
    await this.send([0x2c, LT_PACKET, 0x04]);
  }

  /**
   * Read the packet `definePacket` described.
   * @returns {Promise<Uint8Array|null>} The pieces' bytes in the order they
   *   were named; null when the DME has no packet defined (it restarted).
   * @throws {LtError} `silent`.
   */
  async readPacket() {
    const r = await this.send([0x21, LT_PACKET]);
    if (!r) throw new LtError('silent', 'the DME did not answer a packet read');
    if (r[0] !== 0x61 || r[1] !== LT_PACKET) return null;
    return Uint8Array.from(r.slice(2));
  }

  /**
   * Read RAM or internal flash with the stock read-by-address (23).
   * @param {number} address
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   * @throws {LtError} `silent` or `refused`.
   */
  async readMemory(address, length) {
    const out = new Uint8Array(length);
    for (let done = 0; done < length;) {
      const n = Math.min(LT_READ_MAX, length - done);
      const at = address + done;
      const r = await this.send([
        0x23,
        (at >> 16) & 0xff,
        (at >> 8) & 0xff,
        at & 0xff,
        n,
      ]);
      if (!r) throw new LtError('silent', 'the DME did not answer a read');
      if (r[0] !== 0x63 || r.length < n + 1)
        throw new LtError(
          'refused',
          `the DME refused a read at 0x${at.toString(16)}`
        );
      out.set(r.slice(1, 1 + n), done);
      done += n;
    }
    return out;
  }

  /**
   * Read the state block back. A null means the magic is not there -- but
   * note the block is ZERO until the first 6C op initialises it, so a
   * live-tune DME that has seen no op reads null here too. Use `ping` to
   * probe for the build; `readState` is for reading the block once an op has
   * run.
   * @returns {Promise<{status:number,count:number,version:number,mirror:number}|null>}
   */
  async readState() {
    const b = await this.readMemory(LT_STATE, LT_STATE_SIZE);
    const w = (i) =>
      ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    if (w(0) !== LT_STATE_MAGIC) return null;
    // the first build kept a RAM address in the version word
    const v = w(12);
    this.version = v >= 2 && v < 0x100 ? v : 1;
    return {
      status: w(4),
      count: w(8),
      version: this.version,
      mirror: w(28),
      // build 6: the range on the data breakpoint, [base, end), or null
      watch: this.canWatch() && w(40) ? [w(36), w(40)] : null,
    };
  }

  /**
   * Probe for the build and bring the state block up: op 04 initialises the
   * block on a live-tune DME (and does nothing else), so reading it back
   * then carries the magic. A build-less DME acks 04 with 7F 2C 12 but
   * leaves the block zero, so this returns null -- the real "is this the
   * build" test.
   * @returns {Promise<{status:number,count:number,version:number,mirror:number}|null>}
   * @throws {LtError} `silent` or `refused` (no answer / a wrong answer).
   */
  async ping() {
    const r = await this.send([0x2c, LT_LOCAL_ID, 0x04]);
    if (!r) throw new LtError('silent', 'the DME did not answer');
    if (
      r.length !== 3 ||
      r[0] !== LT_ACK[0] ||
      r[1] !== LT_ACK[1] ||
      r[2] !== LT_ACK[2]
    )
      throw new LtError(
        'refused',
        `the ping was not acknowledged (${r.map((x) => x.toString(16)).join(' ')})`
      );
    return this.readState();
  }

  /**
   * Send one 6C op and read the state back. Every op is answered with the
   * stock 7F 2C 12; a different answer, or silence, is a failure. An absent
   * build is told apart by the state block's missing magic.
   * @param {number[]} args - The op byte and its arguments.
   * @returns {Promise<{status:number,count:number,version:number,mirror:number}>}
   * @throws {LtError} `silent`, `absent`, or `refused`.
   */
  async op(args) {
    const r = await this.send([0x2c, LT_LOCAL_ID, ...args]);
    if (!r) throw new LtError('silent', 'the DME did not answer');
    if (
      r.length !== 3 ||
      r[0] !== LT_ACK[0] ||
      r[1] !== LT_ACK[1] ||
      r[2] !== LT_ACK[2]
    )
      throw new LtError(
        'refused',
        `the op was not acknowledged (${r.map((x) => x.toString(16)).join(' ')})`
      );
    const st = await this.readState();
    if (!st)
      throw new LtError(
        'absent',
        'this DME is not running the live-tune build'
      );
    return st;
  }

  /**
   * The tables the DME holds open, read from its descriptor table: the
   * source of truth for slots and mirrors. A page reload forgets what this
   * client opened while the DME keeps it, so nothing here is assumed.
   * @returns {Promise<Array<{slot:number,offset:number,length:number,mirror:number}>>}
   */
  async descriptors() {
    const desc = LT_DESC;
    const slots = LT_DESC_SLOTS;
    const b = await this.readMemory(desc, 4 + slots * 12);
    const w = (i) =>
      ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const out = [];
    if (w(0) !== LT_DESC_MAGIC) return out;
    for (let s = 0; s < slots; s++) {
      const base = w(4 + s * 12);
      if (base === 0) break;
      out.push({
        slot: s,
        offset: (base - LT_CAL_BASE) >>> 0,
        length: (w(8 + s * 12) - base) >>> 0,
        mirror: (base + w(12 + s * 12)) >>> 0,
      });
    }
    return out;
  }

  /**
   * Whether the DME still holds what this client thinks is open. It does not
   * after a restart: its RAM, and the open tables with it, start empty.
   * @returns {Promise<boolean>}
   */
  async inSync() {
    if (!this.tables.length) return true;
    const st = await this.readState();
    return !!st && st.count >= this.tables.length;
  }

  /**
   * Forget everything and take over what the DME holds now.
   * @returns {Promise<number>} How many tables are tracked.
   */
  async resync() {
    this.tables = [];
    this.shelfAt = null;
    await this.op([0x04]);
    return this.adopt();
  }

  /**
   * Take over every table the DME already holds open, so a client that has
   * just connected (a reloaded page) shows the true count, reads their live
   * values and can close them. Copies of a range after the first are
   * skipped: the DME's lookups only ever use the first.
   * @returns {Promise<number>} How many tables are now tracked.
   */
  async adopt() {
    for (const d of await this.descriptors()) {
      if (
        this.tables.some((t) => t.offset === d.offset && t.length === d.length)
      )
        continue;
      const shadow = await this.readTable(d, 0, d.length);
      const t = {
        slot: d.slot,
        offset: d.offset,
        length: d.length,
        mirror: d.mirror,
        shadow,
        used: ++this.clock,
      };
      t.fixed = this.isFixed(t);
      this.tables.push(t);
    }
    // and which of them the DME has on its data breakpoint
    const st = await this.readState();
    const w = st && st.watch;
    const on =
      w &&
      this.tables.find(
        (t) =>
          (LT_CAL_BASE + t.offset) >>> 0 === w[0] && t.length === w[1] - w[0]
      );
    this.watching = on
      ? { slot: on.slot, offset: on.offset, length: on.length }
      : null;
    return this.tables.length;
  }

  /**
   * Where a mirror of `length` bytes fits in RAM beside the ones already
   * there: first fit over the pools, or -1.
   * @param {number} length
   * @returns {number}
   */
  freeRam(length) {
    const taken = this.tables
      .filter((t) => !this.shelved(t) && !t.fixed)
      .map((t) => [t.mirror, t.length]);
    for (const [lo, hi] of this.pools()) {
      let at = lo;
      for (const [m, n] of taken
        .filter((t) => t[0] >= lo && t[0] < hi)
        .sort((x, y) => x[0] - y[0])) {
        if (m - at >= length) break;
        at = Math.max(at, m + n);
      }
      if (
        at + length <= hi &&
        taken.every(([m, n]) => at + length <= m || m + n <= at)
      )
        return at;
    }
    return -1;
  }

  /**
   * Op 07: slot `slot` serves the range from `mirror` -- a RAM address in
   * a pool (the DME seeds it from where the range reads now) or a
   * calibration offset on the shelf.
   * @param {number} slot
   * @param {number} offset
   * @param {number} length
   * @param {number} mirror
   * @returns {Promise<void>}
   * @throws {LtError} `full`, `room` or `refused`.
   */
  async place(slot, offset, length, mirror) {
    const b3 = (v) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    const st = await this.op([
      0x07,
      slot,
      ...b3(offset),
      (length >> 8) & 0xff,
      length & 0xff,
      ...b3(mirror),
    ]);
    if (st.status === LT_STATUS.OK) {
      // the breakpoint keeps the mirror it was armed with: a watched table
      // that moved (parked, or back from the shelf) is armed again
      if (this.watching && this.watching.slot === slot)
        await this.op([0x09, slot]);
      return;
    }
    const code =
      { [LT_STATUS.FULL]: 'full', [LT_STATUS.ROOM]: 'room' }[st.status] ||
      'refused';
    throw new LtError(
      code,
      LT_STATUS_TEXT[st.status] ||
        `the DME refused to place the table (status ${st.status})`
    );
  }

  /**
   * Where the shelf's blank part starts. The shelf fills from the bottom and
   * only a save empties it, so what an earlier session left is found by
   * halving: a few short reads, one when it is empty. A blank-looking stretch
   * inside written data is caught later -- the DME refuses to program over
   * anything not blank, and `park` then moves on.
   * @returns {Promise<number>}
   */
  async shelfStart() {
    if (this.shelfAt !== null) return this.shelfAt;
    const blank = async (at) =>
      (
        await this.readCal(at, Math.min(LT_SHELF_PROBE, LT_SHELF[1] - at))
      ).every((v) => v === 0xff);
    let lo = LT_SHELF[0];
    let hi = LT_SHELF[1];
    if (!(await blank(lo))) {
      lo += LT_SHELF_PROBE;
      while (hi - lo > LT_SHELF_PROBE) {
        const mid = lo + (((hi - lo) / 2) & ~(LT_SHELF_PROBE - 1));
        if (await blank(mid)) hi = mid;
        else lo = mid + LT_SHELF_PROBE;
      }
      if (lo < hi && !(await blank(lo))) lo = hi;
    }
    for (const t of this.tables)
      if (this.shelved(t)) lo = Math.max(lo, t.mirror - LT_CAL_BASE + t.length);
    this.shelfAt = lo + (lo & 1);
    return this.shelfAt;
  }

  /**
   * Move a table's mirror from RAM to the shelf, which frees its RAM. The
   * DME reads it from there exactly as before; to edit it again it is placed
   * back in RAM (`open` does that).
   * @param {{slot:number,offset:number,length:number,mirror:number,shadow:Uint8Array}} table
   * @returns {Promise<void>}
   * @throws {LtError} `room` when the shelf is full, `refused`.
   */
  async park(table) {
    if (this.shelved(table)) return;
    if (this.onProgress) this.onProgress('making room on the ECU…');
    const data = Array.from(await this.readMemory(table.mirror, table.length));
    if (data.length & 1) data.push(0xff);
    const b3 = (v) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    let at = await this.shelfStart();
    for (let done = 0; done < data.length;) {
      if (at + data.length > LT_SHELF[1])
        throw new LtError(
          'room',
          'the ECU’s shelf is full until the next save (ignition off)'
        );
      const chunk = data.slice(done, done + LT_SHELF_MAX);
      const st = await this.op([
        0x06,
        ...b3(at + done),
        chunk.length,
        ...chunk,
      ]);
      if (st.status === LT_STATUS.USED) {
        // not blank after all: start again past it
        at += done + chunk.length;
        done = 0;
        continue;
      }
      if (st.status !== LT_STATUS.OK)
        throw new LtError(
          'refused',
          LT_STATUS_TEXT[st.status] ||
            `the DME refused a shelf write (status ${st.status})`
        );
      done += chunk.length;
    }
    this.shelfAt = at + data.length;
    await this.place(table.slot, table.offset, table.length, at);
    table.mirror = (LT_CAL_BASE + at) >>> 0;
  }

  /**
   * RAM for a mirror of `length` bytes, parking the tables edited longest
   * ago until it fits.
   * @param {number} length
   * @param {object} [keep] - A table not to park.
   * @returns {Promise<number>} The address.
   * @throws {LtError} `room`.
   */
  async room(length, keep) {
    if (!this.pools().some(([lo, hi]) => length <= hi - lo))
      throw new LtError(
        'room',
        'the table is bigger than the DME can hold in RAM'
      );
    for (;;) {
      const at = this.freeRam(length);
      if (at >= 0) return at;
      const oldest = this.tables
        .filter((t) => t !== keep && !this.shelved(t) && !t.fixed)
        .sort((x, y) => x.used - y.used)[0];
      if (!oldest) throw new LtError('room', LT_STATUS_TEXT[LT_STATUS.ROOM]);
      await this.park(oldest);
    }
  }

  /**
   * Open a calibration range for live editing, or return the entry already
   * tracking it. A range the DME already holds open (from before a reload)
   * is ADOPTED, never opened again: a second descriptor for the same range
   * gets a second mirror the lookups never read (seen on a bench: writes
   * went to slot 0 while the read-back watched slot 1's mirror). The slot and
   * the mirror always come from the first matching descriptor. On a version
   * 2 build the table comes back with its mirror in RAM, ready to write:
   * one that was on the shelf is placed in RAM again, and others are parked
   * to make the room.
   * @param {number} offset - Calibration offset.
   * @param {number} length - Bytes.
   * @returns {Promise<{slot:number,offset:number,length:number,mirror:number,shadow:Uint8Array}>}
   * @throws {LtError} `absent`, `full`, `room` or `refused`.
   */
  async open(offset, length) {
    const match = (t) => t.offset === offset && t.length === length;
    let entry = this.tables.find(match);
    if (!entry) {
      if (!(await this.readState())) await this.op([0x04]); // brings the block up, or says absent
      const open = await this.descriptors();
      let d = open.find(match);
      if (!d && !this.supported())
        throw new LtError(
          'refused',
          `this DME runs live tune build ${this.version}; flash the current one (${LT_VERSION}) to edit it live`
        );
      if (!d) {
        if (open.length >= LT_DESC_SLOTS)
          throw new LtError('full', LT_STATUS_TEXT[LT_STATUS.FULL]);
        // a value with RAM of its own on the DME is edited there
        const own = this.pooled(offset, length);
        const mirror = own ? own.address : await this.room(length);
        await this.place(open.length, offset, length, mirror);
        d = { slot: open.length, mirror };
      }
      entry = {
        slot: d.slot,
        offset,
        length,
        mirror: d.mirror,
        shadow: new Uint8Array(0),
        used: 0,
      };
      entry.fixed = this.isFixed(entry);
      entry.shadow = await this.readTable(entry, 0, length);
      this.tables.push(entry);
    }
    entry.used = ++this.clock;
    if (this.shelved(entry)) {
      const mirror = await this.room(length, entry);
      await this.place(entry.slot, offset, length, mirror); // seeded from the shelf
      entry.mirror = mirror;
    }
    return entry;
  }

  /**
   * Write `bytes` at `at` inside an open table's mirror. The DME splits a
   * write at LT_WRITE_MAX; a caller may want smaller runs still, so this
   * writes exactly what it is given and leaves run-finding to the caller.
   * @param {{slot:number,length:number,shadow:Uint8Array}} table
   * @param {number} at - Offset inside the table.
   * @param {Uint8Array|number[]} bytes
   * @returns {Promise<void>}
   * @throws {LtError} `refused`.
   */
  async writeRun(table, at, bytes) {
    const data = Array.from(bytes);
    table.used = ++this.clock;
    for (let done = 0; done < data.length;) {
      const chunk = data.slice(done, done + LT_WRITE_MAX);
      const off = at + done;
      const st = await this.op([
        0x02,
        table.slot,
        (off >> 8) & 0xff,
        off & 0xff,
        chunk.length,
        ...chunk,
      ]);
      // fewer tables open than this client holds: the DME restarted (a key
      // cycle, a save) and what was open went with its RAM
      if (st.status === LT_STATUS.SLOT || st.count < this.tables.length)
        throw new LtError(
          'lost',
          'the ECU restarted: what was open on it is gone'
        );
      if (st.status !== LT_STATUS.OK)
        throw new LtError(
          'refused',
          LT_STATUS_TEXT[st.status] ||
            `the DME refused the write (status ${st.status})`
        );
      for (let i = 0; i < chunk.length; i++) table.shadow[off + i] = chunk[i];
      done += chunk.length;
    }
  }

  /**
   * Make the open table hold `want`, sending only the bytes that differ.
   * Differing runs within `cell` bytes of each other are sent together
   * (fewer telegrams), and every run is widened to a `cell` boundary so a
   * multi-byte cell is never left half-written on the wire.
   * @param {{slot:number,length:number,shadow:Uint8Array}} table
   * @param {Uint8Array} want - The whole table, `table.length` bytes.
   * @param {number} [cell] - Bytes per cell (1 or 2). Writes align to it.
   * @returns {Promise<number>} Bytes actually sent.
   */
  async sync(table, want, cell = 1) {
    const cur = table.shadow;
    const n = table.length;
    const runs = [];
    let start = -1;
    const gap = Math.max(cell, 8);
    for (let i = 0; i <= n; i++) {
      const diff = i < n && cur[i] !== want[i];
      if (diff && start < 0) start = i;
      else if (!diff && start >= 0) {
        if (runs.length && start - runs[runs.length - 1].end <= gap)
          runs[runs.length - 1].end = i;
        else runs.push({ start, end: i });
        start = -1;
      }
    }
    let sent = 0;
    for (const run of runs) {
      let lo = cell > 1 ? run.start - (run.start % cell) : run.start;
      let hi =
        cell > 1 ? run.end + ((cell - (run.end % cell)) % cell) : run.end;
      lo = Math.max(0, lo);
      hi = Math.min(n, hi);
      await this.writeRun(table, lo, want.slice(lo, hi));
      sent += hi - lo;
    }
    return sent;
  }

  /**
   * Ask the DME to fold the open tables into the calibration when the
   * ignition is switched off, or take that back. Nothing is written now.
   * @param {boolean} on
   * @returns {Promise<void>}
   * @throws {LtError} `refused`.
   */
  async askSave(on) {
    const st = await this.op([0x08, on ? LT_SAVE_ASKED : 0]);
    if (st.status !== LT_STATUS.OK)
      throw new LtError(
        'refused',
        LT_STATUS_TEXT[st.status] || 'the DME refused the save request'
      );
  }

  /**
   * Whether a save at key-off has been asked for (read from the DME).
   * @returns {Promise<boolean>}
   */
  async saveAsked() {
    return (await this.readMemory(LT_SAVE_ARMED, 1))[0] === LT_SAVE_ASKED;
  }

  /**
   * Close every open table on the DME; the lookups return to the
   * calibration. Clears the tracked set whether or not the op is accepted,
   * because a failed close leaves nothing a caller can do but forget them.
   * @returns {Promise<void>}
   */
  async closeAll() {
    this.tables = [];
    this.watching = null; // the DME takes the breakpoint off with the tables
    await this.op([0x03]);
  }

  /**
   * Build 6: put an open table -- a single value no pool holds -- on the
   * DME's data breakpoint, so every read of its range sees the mirror. One
   * at a time: the one asked last, the one before is back to "after a save".
   * @param {{slot:number,offset:number,length:number}} table
   * @returns {Promise<void>}
   * @throws {LtError} `refused`.
   */
  async watch(table) {
    const st = await this.op([0x09, table.slot]);
    if (st.status !== LT_STATUS.OK)
      throw new LtError(
        'refused',
        LT_STATUS_TEXT[st.status] ||
          `the DME refused to watch the value (status ${st.status})`
      );
    this.watching = {
      slot: table.slot,
      offset: table.offset,
      length: table.length,
    };
  }

  /** The data breakpoint off; the table stays open (live again after a save). */
  async unwatch() {
    await this.op([0x09, 0xff]);
    this.watching = null;
  }

  /**
   * Fold the open tables into the calibration, engine stopped. The DME that
   * saves goes silent, rewrites its calibration sector and resets; it
   * answers (with nothing open) only when it did NOT save. So a null answer
   * is success. The caller re-opens and reads back to confirm.
   * @returns {Promise<void>}
   * @throws {LtError} `turning`, `big`, `verify` (nothing open), or `refused`.
   */
  async save() {
    // The save op is the one telegram whose SILENCE means success: a DME
    // that saves folds the calibration and resets without answering, so the
    // send either returns null (silence) or -- because the reset drops the
    // link mid-exchange -- throws a wire timeout. BOTH mean "it saved". Only
    // a real 7F 2C 12 answer (the DME chose NOT to save) is a refusal, and
    // the state block then says why.
    let r;
    try {
      r = await this.send([0x2c, LT_LOCAL_ID, 0x05]);
    } catch (e) {
      // a timeout here is the reset dropping the exchange: treat as saved
      this.tables = [];
      this.shelfAt = null;
      return;
    }
    if (!r) {
      this.tables = []; // the DME reset; the mirrors are gone
      this.shelfAt = null; // and the save erased the shelf
      return;
    }
    if (r.length !== 3 || r[0] !== LT_ACK[0])
      throw new LtError('refused', 'the save was not acknowledged');
    // It answered, so it did NOT save -- find out why from the state block.
    // Reading that back can itself race the DME; a failure to read is not a
    // refusal, so report it as a transient, not "nothing was open".
    let st;
    try {
      st = await this.readState();
    } catch (e) {
      throw new LtError('silent', 'the DME stopped answering after the save');
    }
    if (!st)
      throw new LtError(
        'absent',
        'this DME is not running the live-tune build'
      );
    if (st.status === LT_STATUS.TURNING)
      throw new LtError('turning', LT_STATUS_TEXT[LT_STATUS.TURNING]);
    if (st.status === LT_STATUS.BIG)
      throw new LtError('big', LT_STATUS_TEXT[LT_STATUS.BIG]);
    // OK with an answer means nothing differed from the calibration.
    throw new LtError('verify', 'nothing was open to save');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LT_STATUS,
    LT_VERSION,
    LT_VERSION_MIN,
    LT_POOLS,
    LT_SHELF,
    LT_SINGLES,
    LtError,
    LiveTune,
  };
}
