/**
 * @file BEST2 virtual machine: EXECUTE ECU job programs in the browser.
 *
 * Lifting a job to a declarative spec tops out near 71% of results (the tail
 * is structural: branch-chosen layouts, multi-telegram streaming, byte-by-byte
 * strings); executing the program handles all of it, which is why EDIABAS is
 * flawless. Input is tools/sgbd_code.py output (ops array, jumps as indices);
 * telegram I/O is a callback, so one VM runs live cable / .sim / fixture.
 * Semantics ported from EdiabasLib (EdOperations.cs, EdiabasNet.cs); the
 * engine's own result sets for 460 E46 jobs are the committed fixture
 * data/sim-captures/vmfix.json that test_bestvm.js replays.
 *
 * THE REGISTER MODEL, which nothing else here makes sense without:
 * B/I/L/A are VIEWS over one 32-byte array, LITTLE-endian within a view, so
 * writing B0 changes what L0 reads. S registers are separate byte buffers
 * (raw bytes that may contain NULs). F are doubles.
 *
 * This piece declares the class -- its state, the session/job run loop and
 * result publishing. The pieces loaded after it extend the prototype, one
 * concern each: registers.js (the register file), operands.js (operand
 * addressing modes), environment.js (arguments, constant pool, tables),
 * executor.js (the opcode `step` switch). index.js publishes the surface.
 */

// Under node the pieces are separate modules and read each other's names
// as globals -- the same shape the browser's shared script scope gives them.
if (typeof require === 'function' && typeof module !== 'undefined') {
  Object.assign(globalThis, require('./codec.js'), require('./write-guard.js'));
}

/**
 * The register file is 32 bytes, overlaid THREE ways (EdiabasNet
 * RegisterList): B0..BF = bytes 0..15 and A0..AF = bytes 16..31; I0..I7
 * pair over the B range and I8..IF over the A range; L0..L3 quad over B
 * and L4..L7 over A. So L1 IS bytes 4..7 IS I2+I3 IS B4..B7.
 */
const REG_BYTES = 32;

/**
 * The job's declared array size (ArrayMaxBufSize): the capacity of every
 * string register. 1024 is EDIABAS's default and every E46 job fits it.
 */
const DEFAULT_ARRAY_SIZE = 1024;

/** Opcodes a single job may execute before the VM gives up on it. */
const DEFAULT_MAX_STEPS = 2_000_000;

/**
 * Values of the trap register, which `jt`/`jnt` test:
 *   TRAP_CLEAN     no error pending
 *   TRAP_UNMAPPED  an error with no mapped bit (EDIABAS_BIP_0001/0007)
 *   TRAP_FLOAT     EDIABAS_BIP_0011, an infinite or NaN float quotient
 *   TRAP_TABLE     EDIABAS_BIP_0010, table not found (SYS_0002 folds here)
 *   TRAP_USER      the floor of the user-trap range set by `sett`/`generr`
 * Mapped EDIABAS errors occupy 2..29; `jt target, 32` aliases the unmapped
 * bit 0.
 */
const TRAP_CLEAN = -1;
const TRAP_UNMAPPED = 0;
const TRAP_FLOAT = 8;
const TRAP_TABLE = 10;
const TRAP_USER = 0x40000000;

/** Returned by `step` for `eoj`: the job is finished. */
const STOP = Symbol('eoj');

/** An error raised by the VM itself (not by the ECU or the transport). */
class VmError extends Error {}

/**
 * A parsed SGBD program, as tools/sgbd_code.py writes it.
 * @typedef {Object} JobCode
 * @property {Object<string, number>} jobs - Job name -> index into `ops` of
 *   its first instruction.
 * @property {Array<[string, Operand[]]>} ops - Instructions: opcode name and
 *   its operands.
 * @property {Array<string|number[]>} strings - The constant pool: a byte
 *   ARRAY for an exact literal (possibly containing NULs), a plain string
 *   for a result or table name.
 */

/**
 * One instruction operand, `[mode, ...payload]` as sgbd_code.py emits it.
 * See operands.js (OpMode) for the modes and their payloads.
 * @typedef {Array<*>} Operand
 */

/**
 * The ECU exchange: request bytes out, answer bytes back. Callers that
 * replay captured answers ignore the second argument.
 * @callback TelegramSink
 * @param {number[]} request - The telegram to transmit.
 * @param {?import('./codec.js').CommParams} comm - Wire parameters for this
 *   exchange (framing, checksum, pacing), or null before any `xsetpar`.
 * @returns {Uint8Array|number[]|undefined} The answer frame off the wire.
 */

/**
 * A table row: column name -> cell text.
 * @typedef {Object<string, string>} TableRow
 */

/**
 * One completed result set: UPPERCASED result name -> value (number, text,
 * or a byte array for `ergy`).
 * @typedef {Object<string, number|string|number[]>} ResultSet
 */

/**
 * The condition flags the arithmetic opcodes set and the jumps test.
 * @typedef {Object} VmFlags
 * @property {boolean} zero
 * @property {boolean} sign
 * @property {boolean} carry
 * @property {boolean} overflow
 * @property {boolean} tested
 */

/**
 * The table cursor set by `tabset` and moved by `tabseek`/`tabline`.
 * @typedef {Object} TableCursor
 * @property {string} name - The table name as the job asked for it.
 * @property {TableRow[]} rows - The data rows.
 * @property {?TableRow} row - The current row, null before any seek.
 */

/**
 * A string register: a FIXED-CAPACITY buffer plus a logical length, exactly
 * like EdiabasNet's StringData.
 * @typedef {Object} StringRegister
 * @property {Uint8Array} buf - The whole buffer, `arraySize` bytes.
 * @property {number} len - The logical length.
 */

/**
 * Construction options.
 * @typedef {Object} VmOptions
 * @property {TelegramSink} [send] - The ECU exchange. Required to transmit.
 * @property {Object<string, TableRow[]>} [tables] - The SGBD's own tables.
 * @property {Object<string, Object<string, TableRow[]>>} [extTables] -
 *   Tables in OTHER best files, reached by `tabsetex "Name", "file"` --
 *   group SGBDs pull ZuordnungsTabelle from t_grtb this way (128 of the
 *   249 groups in data/groups). Keyed by the bare file name.
 * @property {string} [args] - Job arguments, ';' separated.
 * @property {number} [maxSteps] - Step budget per job.
 * @property {number} [arraySize] - String register capacity.
 * @property {Map<string, Uint8Array>} [shared] - Process-wide shared data
 *   (shmset/shmget), persists across jobs.
 * @property {boolean} [inited] - INITIALISIERUNG already ran this session.
 * @property {boolean} [allowWrites] - Permit a write job to transmit.
 * @property {?import('./codec.js').CommParams} [comm] - Wire parameters
 *   carried over from the session's INITIALISIERUNG.
 * @property {?Date} [now] - A fixed clock for `date`/`time`/`ticks`.
 */

/**
 * The BEST2 job interpreter. One instance runs one SGBD; `run` executes a
 * job and returns its result sets.
 */
class Best2Vm {
  /**
   * @param {JobCode} code - Parsed sgbd JSON from tools/sgbd_code.py.
   * @param {VmOptions} [opts] - Construction options.
   */
  constructor(code, opts = {}) {
    this.code = code;
    this.send =
      opts.send ||
      (() => {
        throw new VmError('no telegram sink');
      });
    this.tables = opts.tables || {};
    this.extTables = opts.extTables || {};
    this.argText = opts.args || '';
    this.maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS;
    this.arraySize = opts.arraySize || DEFAULT_ARRAY_SIZE;
    // process-wide shared data (shmset/shmget), persists across jobs
    this.shared = opts.shared || new Map();
    // A SESSION runs INITIALISIERUNG once when the SGBD is loaded, not once
    // per job. Callers that keep a session (webshim) pass inited:true on
    // every job after the first, so the implicit init below is skipped --
    // which is both what the engine does and one less telegram per job.
    this._inited = !!opts.inited;
    // Permission to transmit for a job that CHANGES the ECU. Off by
    // default: a caller has to say so, and saying so is the point where a
    // UI can put a confirmation in front of the user.
    // WRITES ARE PERMITTED BY DEFAULT (owner's decision, 2026-08-19).
    //
    // This used to default to false, so actuator tests -- STEUERN_E_LUEFTER
    // and friends -- never reached the wire: the fan screen's "Activate at
    // 15%" appeared to do nothing while the readback sat at the DME's own 92.
    // The classifier cannot tell a temporary actuator drive from a permanent
    // EEPROM write (both are "write jobs"), so unblocking one unblocks both.
    //
    // What that means in practice: CODIERDATEN_SCHREIBEN, FS_LOESCHEN and the
    // FLASH_* family now transmit. Those are unrecoverable on a real module.
    // Pass {allowWrites: false} to restore the old refuse-everything behaviour.
    this.allowWrites = opts.allowWrites !== false;
    // Wire parameters from xsetpar. Seeded from the SESSION: xsetpar lives
    // in INITIALISIERUNG, which runs once per session -- a fresh VM for a
    // later job never executes it, so the caller carries comm forward the
    // same way it carries `shared`. Without this seed every ordinary job
    // transmitted with comm=null, i.e. BMW-FAST 115200 8N1, and every
    // K-line module got line noise.
    this.comm = opts.comm || null;
    /**
     * Significant digits flt2a keeps (setflt / _floatPrecision). Held on
     * the machine, not reset per job, as the engine holds it: a job that
     * never sets one formats with whatever the last one set, default 4.
     * @type {number}
     */
    this.floatPrecision = FLOAT_PRECISION;
    // A fixed clock for date/time, when the caller needs determinism.
    // webshim re-runs a job's bytecode once per telegram fetched, and the
    // answer memo is keyed on request bytes -- a timestamp that ticks
    // between passes changes the bytes, misses the memo, and re-transmits
    // a telegram that already went out.
    this.now = opts.now || null;
  }

  /**
   * Job-start state. Per the reference: a job start clears the stack,
   * flags, string registers, results and traps. It does NOT clear
   * byte/float registers, and shared data is process-wide -- so neither
   * is reset here.
   * @returns {void}
   */
  reset() {
    this.regBuf = this.regBuf || new Uint8Array(REG_BYTES);
    /** @type {Map<string, StringRegister>} */
    this.sregs = new Map();
    /** @type {Map<string, number>} */
    this.fregs = new Map();
    /** @type {number[]} BYTE stack (push writes N bytes) */
    this.stack = [];
    /** @type {VmFlags} */
    this.flags = {
      zero: false,
      sign: false,
      carry: false,
      overflow: false,
      tested: false,
    };
    /** @type {ResultSet[]} completed result sets */
    this.results = [];
    /** @type {Map<string, number|string|number[]>} the set being built */
    this.cur = new Map();
    /** @type {?Set<string>} etag filter, null = everything */
    this.wanted = null;
    /** @type {?TableCursor} */
    this.table = null;
    // The trap register: -1 = clean, 0 = an error with no mapped bit,
    // 2..29 = a mapped EDIABAS error (BIP_0010 -> 10 is the table error),
    // >= 0x40000000 = a user trap from `sett`. jt/jnt test THIS, not a
    // generic "tested" flag -- a tabset that SUCCEEDS must leave it clean,
    // and mine left a stale flag so `jt err,#10` fired after a good tabset
    // and 31 jobs reported ERROR_TABLE.
    this.trapBit = TRAP_CLEAN;
    this.trapMask = 0; // set_trap_mask (settmr/gettmr), see OpSettmr
    this.answer = new Uint8Array(0);
    this.tokenSep = ''; // setspc separators for stoken
    this.tokenIdx = 0; // 1-based token number, 0 = unset
    // this.comm is deliberately NOT cleared: xsetpar runs in
    // INITIALISIERUNG, and a job start that wiped it sent every subsequent
    // telegram with default (BMW-FAST) framing. Comm lives as long as the
    // VM / session, like shared data.
    this.steps = 0;
  }

  // ---- the loop -------------------------------------------------------

  /**
   * Run a job the way a SESSION does: EDIABAS executes the SGBD's
   * INITIALISIERUNG job once before the first real job (ExecuteInitJob),
   * and SGBDs use it to populate shared data that later jobs read -- MS450's
   * AIF block size and free count arrive that way via shmset/shmget. Without
   * it those results read zeros.
   * @param {string} jobName - The job to run.
   * @param {string} [args] - Its ';'-separated arguments; defaults to the
   *   constructor's `args`.
   * @returns {ResultSet[]} The job's result sets, in order.
   * @throws {VmError} A write job without `allowWrites`, a failed or
   *   unproven INITIALISIERUNG, an unknown job, or any execution fault.
   */
  run(jobName, args) {
    // Refuse a write job BEFORE anything is transmitted -- including the
    // implicit INITIALISIERUNG, which is itself only a read but still puts
    // bytes on the wire. "Nothing was sent" is a much easier promise to
    // reason about than "only harmless things were sent".
    if (isWriteJob(jobName) && !this.allowWrites) {
      throw new VmError(
        `refusing to run write job ${jobName}: ` +
          'construct the VM with {allowWrites: true} to permit it'
      );
    }
    const init = this.code.jobs.INITIALISIERUNG;
    if (
      init !== undefined &&
      !this._inited &&
      String(jobName).toUpperCase() !== 'INITIALISIERUNG'
    ) {
      this._inited = true;
      // The init runs with NO arguments, but the real job's argument may
      // already be sitting in argText (constructed with {args}); runOne(init,
      // '') overwrote it and FS_LESEN_DETAIL then saw no F_CODE at all.
      const jobArgs = args !== undefined ? args : this.argText;
      let initSets;
      try {
        initSets = this.runOne(init, '');
      } catch (e) {
        // An init that fails FAILS THE JOB. ExecuteInitJob rethrows any
        // exception and closes the SGBD to force a reload -- it does not
        // shrug and continue. Swallowing here converted every loud init
        // failure (unimplemented opcode, step limit, eerr) into a job that
        // "succeeded" with empty shared data and published zeros as OKAY.
        // The needAnswer sentinel (webshim fetching a telegram answer) also
        // rethrows, and both paths clear _inited so init runs again on the
        // next attempt.
        this._inited = false;
        throw e;
      }
      // ExecuteInitJob also demands the init PROVE itself: result set 1
      // (our set 0; the engine's set 0 is synthetic) must carry DONE=1, or
      // the engine reports EDIABAS_SYS_0010 and unloads the SGBD.
      const done =
        initSets && initSets.length && Number(initSets[0].DONE) === 1;
      if (!done) {
        this._inited = false;
        throw new VmError(
          'INITIALISIERUNG did not report DONE=1 (EDIABAS_SYS_0010)'
        );
      }
      this.argText = jobArgs;
    }
    return this.runOne(undefined, args, jobName);
  }

  /**
   * Execute one job's bytecode from its entry to `eoj`, with no session
   * bookkeeping. `run` is the entry point callers want.
   * @param {number|undefined} entryIdx - Index into `ops` to start at, or
   *   undefined to look `jobName` up in the job table.
   * @param {string|undefined} args - Arguments for this run; undefined
   *   keeps the current `argText`.
   * @param {string} [jobName] - The job name (required when entryIdx is
   *   undefined); also what the write guard classifies.
   * @returns {ResultSet[]} The result sets the job published.
   * @throws {VmError} No such job, the step limit, or any execution fault.
   */
  runOne(entryIdx, args, jobName) {
    const entry =
      entryIdx !== undefined
        ? entryIdx
        : (this.code.jobs[jobName] ?? this.code.jobs[jobName?.toUpperCase()]);
    if (entry === undefined) throw new VmError(`no job ${jobName}`);
    this.jobName = jobName || this.jobName;
    // INITIALISIERUNG runs implicitly before a real job; it is never a
    // write, and must not inherit the target job's classification.
    this.writeJob = entryIdx !== undefined ? false : isWriteJob(jobName);
    this.reset();
    if (args !== undefined) this.argText = args;
    this.argBytes = Best2Codec.strBytes(this.argText);
    this._args = undefined;
    let pc = entry;
    const ops = this.code.ops;
    while (pc >= 0 && pc < ops.length) {
      if (++this.steps > this.maxSteps) {
        throw new VmError(`step limit at op ${pc}`);
      }
      const [name, a] = ops[pc];
      const next = this.step(name, a, pc);
      if (next === STOP) break;
      pc = next === undefined ? pc + 1 : next;
    }
    this.flush();
    return this.results;
  }

  /**
   * Close the result set being built, if it holds anything.
   * @returns {void}
   */
  flush() {
    if (this.cur.size) {
      this.results.push(Object.fromEntries(this.cur));
      this.cur = new Map();
    }
  }

  /**
   * Publish a result into the current set. The KEY IS UPPERCASED
   * (SetResultData keys _resultDict on Name.ToUpper), so ZKE5's
   * "STAT_IFFHMax_WERT" is published as STAT_IFFHMAX_WERT -- the values were
   * already right, only the key case differed, and a caller looking up the
   * engine's name found nothing. Last write wins, as the engine's dictionary
   * assignment does. A `wanted` filter drops names outside it, except the
   * JOB_* status results.
   * @param {string} name - The result name.
   * @param {number|string|number[]} value - The value to publish.
   * @returns {void}
   */
  emit(name, value) {
    const key = String(name).toUpperCase();
    if (this.wanted && !this.wanted.has(key) && !key.startsWith('JOB_')) {
      return;
    }
    this.cur.set(key, value);
  }

  // ---- codecs, re-exposed for callers that address them on the class ----

  /**
   * Text -> CP1252 bytes. See Best2Codec.strBytes.
   * @param {*} s - The value to encode.
   * @returns {Uint8Array} The bytes.
   */
  static strBytes(s) {
    return Best2Codec.strBytes(s);
  }

  /**
   * Text -> CP1252 bytes. See Best2Codec.strBytesCp1252.
   * @param {string} str - The text.
   * @returns {Uint8Array} The bytes.
   */
  static strBytesCp1252(str) {
    return Best2Codec.strBytesCp1252(str);
  }

  /**
   * CP1252 bytes -> text. See Best2Codec.bytesStr.
   * @param {Uint8Array|number[]} b - The bytes.
   * @returns {string} The text.
   */
  static bytesStr(b) {
    return Best2Codec.bytesStr(b);
  }

  /**
   * NUL-terminated text. See Best2Codec.cstr.
   * @param {Uint8Array|number[]} b - The bytes.
   * @returns {string} The text before the first NUL.
   */
  static cstr(b) {
    return Best2Codec.cstr(b);
  }

  /**
   * EDIABAS's StringToValue. See Best2Codec.strToValue.
   * @param {*} s - The text.
   * @returns {number} The integer, or 0.
   */
  static strToValue(s) {
    return Best2Codec.strToValue(s);
  }

  /**
   * A float constant. See Best2Codec.parseNum.
   * @param {*} s - The text.
   * @returns {number} The value, or 0.
   */
  static parseNum(s) {
    return Best2Codec.parseNum(s);
  }

  /**
   * The engine's float formatting. See Best2Codec.fltText.
   * @param {number} value - The float.
   * @returns {string} Its text.
   */
  static fltText(value, digits) {
    return Best2Codec.fltText(value, digits);
  }

  /**
   * set_communication_pars decoding. See Best2Codec.decodeCommParams.
   * @param {number[]} words - The CommParameter words.
   * @returns {import('./codec.js').CommParams} The wire parameters.
   */
  static decodeCommParams(words) {
    return Best2Codec.decodeCommParams(words);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Best2Vm,
    VmError,
    STOP,
    REG_BYTES,
    DEFAULT_ARRAY_SIZE,
    DEFAULT_MAX_STEPS,
    TRAP_CLEAN,
    TRAP_UNMAPPED,
    TRAP_FLOAT,
    TRAP_TABLE,
    TRAP_USER,
  };
}
