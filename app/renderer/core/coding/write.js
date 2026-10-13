/**
 * @file The coding WRITE runner: execute a module's write sequence on the
 * BEST2 VM over the live bus, behind the confirm gate, and prove it by
 * re-read. Published as the `codingWrite` global, with `writeCoding` and
 * `codingWriteStrategy` also on the root.
 *
 * Two ways to produce the write telegrams:
 *   - the DISPATCHER path (core/coding/dispatch.js) runs BMW's own derived
 *     A_<cabd> program when one is shipped for the module;
 *   - the STRATEGY path (core/coding/write-strategy.js) replays the family's
 *     job sequence by hand when none is.
 * Both end here, in the same prove-by-re-read.
 *
 * SAFETY. The VM itself permits write jobs by default (bestvm.js, owner's
 * decision 2026-08-19: the classifier cannot tell an actuator drive from an
 * EEPROM write, and blocking one blocked both), so the write protection for
 * CODING lives HERE, not in the VM: writeCoding() refuses unless
 * opts.confirmed is set by the UI's review dialog, the read steps in this
 * module explicitly pass allowWrites:false, and every write is proved by
 * re-read (below) before it is reported as a success.
 *
 * PROVE-BY-RE-READ. After the write sequence reports JOB_STATUS OKAY, we
 * re-read the coding block and assert it now equals what we asked to write.
 * A mismatch throws ERROR_VERIFY -- the strongest form of the app's
 * prove-by-re-read hardware-safety contract, applied to the write path.
 *
 * app/renderer/core/*.js style: browser global, no imports. Dual-exported
 * for require() so tools/verify/test_coding_write.js can drive it headless.
 */

/**
 * The bus session carried across one write sequence.
 * @typedef {Object} WriteSession
 * @property {Map<string, unknown>} shared - the VM's shared memory.
 * @property {boolean} inited - has the SGBD's INITIALISIERUNG run?
 * @property {unknown} comm - the VM's comm parameters after the last job.
 */

/**
 * Options for writeCoding.
 * @typedef {Object} WriteOptions
 * @property {boolean} confirmed - REQUIRED true -- the UI's actuate confirmation.
 * @property {(out: number[], comm: unknown) => Promise<number[]>} exchange -
 *   the (bus-locked) wire: request bytes in, answer bytes out.
 * @property {{jobs?: Record<string, unknown>, tables?: Record<string, unknown>}} [code]
 *   - the SGBD program.
 * @property {Record<string, unknown>} [tables] - the SGBD's tables.
 * @property {JobList} [jobs] - the SGBD's job list.
 * @property {WriteSession} [session] - carried across the sequence.
 * @property {Function} [Best2Vm] - VM class (test injection; defaults to the root's).
 * @property {Date} [now] - fixed clock (determinism for the replay memo).
 * @property {DispatcherProgram|null} [dispatch] - the derived dispatcher, when shipped.
 * @property {DataOrg|null} [dataOrg] - the CABD's word width / byte order.
 * @property {CabdLayout} [cabd] - the coding description (functions, groups,
 *   coding indexes); the dispatcher path needs it.
 * @property {string|ArrayLike<number>} [base] - the image the edits were made
 *   on; what differs from it is what gets written.
 * @property {(text: string) => void} [onStage] - told where the run is.
 * @property {string} [vin] - the car's 17-character VIN; becomes the
 *   FAHRGESTELL_NR (with its check character) a script may ask for.
 * @property {Record<string, string>} [systemData] - anything else a script
 *   asks for, or an override of the above.
 * @property {string} [jobname] - the dispatcher jobname (default SG_CODIEREN).
 */

/**
 * The runner context threaded through one sequence.
 * @typedef {Object} WriteContext
 * @property {Function} Best2Vm - the VM class.
 * @property {unknown} code - the SGBD program.
 * @property {Record<string, unknown>} tables - the SGBD's tables.
 * @property {(out: number[], comm: unknown) => Promise<number[]>} exchange - the wire.
 * @property {WriteSession} session - the bus session.
 * @property {Date|null} now - fixed clock, or null for wall time.
 * @property {boolean} [allowWrites] - THE write permission for this call.
 */

/**
 * What writeCoding returns.
 * @typedef {Object} WriteResult
 * @property {boolean} ok - always true (a failure throws).
 * @property {number[]|null} before - the netto before the write (null when
 *   there was no read job, or on the dispatcher path).
 * @property {number[]|null} after - the netto read back after the write.
 * @property {Array<[string, string]>} [sequence] - `[job, JOB_STATUS]` per step.
 * @property {WriteStrategy|'dispatch'} strategy - which path ran.
 * @property {WireLogEntry[]} [log] - the dispatcher's wire log.
 * @property {string} [note] - why nothing was transmitted.
 * @property {number[]} [addrs] - dispatcher path: the byte addresses written,
 *   `before` and `after` holding those bytes.
 * @property {number[]} [edited] - dispatcher path: the addresses that were
 *   being changed (the rest of `addrs` went back as read).
 * @property {number[]} [moved] - dispatcher path: unedited addresses that
 *   read back differently than written.
 */

(function (root) {
  'use strict';

  const Strategy =
    typeof root !== 'undefined' && root.CodingWriteStrategy
      ? root.CodingWriteStrategy
      : require('./write-strategy.js');
  const Backup =
    typeof root !== 'undefined' && root.CodingBackup
      ? root.CodingBackup
      : require('./backup.js');
  const { codingWriteStrategy, readJobFor, writeSteps, toHex } = Strategy;
  const { saveCodingBackup, listCodingBackups } = Backup;

  /** Most bus exchanges one job may need before the replay is called stuck. */
  const MAX_EXCHANGES = 128;
  /** The JOB_STATUS EDIABAS publishes on success. */
  const JOB_OK = 'OKAY';
  /** The dispatcher jobname that means "code the module". */
  const DEFAULT_JOBNAME = 'SG_CODIEREN';

  /**
   * The VM class. In the browser it is window.Best2Vm (core/bestvm/ loaded as
   * script before this one); under require() the test injects it.
   * @param {WriteOptions} [opts] - may carry `Best2Vm`.
   * @returns {Function} the VM class.
   * @throws {Error} when no VM is reachable.
   */
  function getVm(opts) {
    if (opts && opts.Best2Vm) return opts.Best2Vm;
    if (typeof root.Best2Vm !== 'undefined') return root.Best2Vm;
    if (typeof require !== 'undefined')
      return require('../bestvm/index.js').Best2Vm;
    throw new Error('coding-write: Best2Vm not available');
  }

  // ---- netto <-> hex/bytes -------------------------------------------------

  /**
   * Accept netto as a hex string ("A1B2...") or a byte array; normalise both.
   * @param {string|ArrayLike<number>|null|undefined} netto - the netto.
   * @returns {number[]} the bytes.
   */
  function toBytes(netto) {
    if (netto == null) return [];
    if (typeof netto === 'string') {
      const hex = netto.replace(/[^0-9a-fA-F]/g, '');
      const out = [];
      for (let i = 0; i + 1 < hex.length; i += 2) {
        out.push(parseInt(hex.slice(i, i + 2), 16));
      }
      return out;
    }
    return Array.from(netto, (b) => b & 0xff);
  }

  /**
   * Byte-wise equality.
   * @param {ArrayLike<number>} a - left.
   * @param {ArrayLike<number>} b - right.
   * @returns {boolean} equal length and contents?
   */
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // A binary blob is passed to the VM as an args STRING whose char codes ARE
  // the bytes: strBytesCp1252 writes out[i]=charCode for every code <= 0xff
  // (0x80..0x9F included -- the CP1252 remap only fires above 0xff), so
  // String.fromCharCode(...bytes) round-trips any byte 0..255 into argBytes,
  // which `pary` reads whole. `;` is NOT special to pary (only to the
  // ';'-splitting parb/parl/... family), so a raw blob survives intact.
  /**
   * Binary blob -> args string whose char codes ARE the bytes.
   * @param {ArrayLike<number>} bytes - the blob.
   * @returns {string} the argument string.
   */
  function bytesToArgString(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b & 0xff);
    return s;
  }

  // ---- the VM job runner (write-capable) -----------------------------------
  //
  // A pass-based, memoised replay identical in shape to webshim's webRunJob:
  // the VM's send() is synchronous but the wire is async, so we run the
  // bytecode to the first un-answered send, fetch that answer over the bus,
  // memoise it keyed by (occurrence, request bytes), and retry from the top
  // (the VM is deterministic under a fixed clock, so replay is safe).
  //
  // The ONE difference from webRunJob is that allowWrites is threaded from
  // the caller instead of fixed: the read steps of a coding sequence run
  // with the gate CLOSED, so only the confirmed write steps can transmit a
  // write job even if a read job were misclassified.
  /**
   * Run one SGBD job over the bus with the context's write permission.
   * @param {WriteContext} ctx - the runner context.
   * @param {string} sgbd - the module (for messages).
   * @param {string} job - the job name.
   * @param {string | {bin: number[]} | null | undefined} arg - the argument.
   * @returns {Promise<Array<Record<string, string>>>} the result sets.
   * @throws {Error} when the VM throws, or the job does not settle.
   */
  async function runJobOverBus(ctx, sgbd, job, arg) {
    const Vm = ctx.Best2Vm;
    const code = ctx.code;
    const tables = ctx.tables || {};
    const answers = new Map();
    const jobNow = ctx.now || new Date();
    // Binary args ride as a char-code string; plain args pass through.
    const argText =
      arg && typeof arg === 'object' && arg.bin
        ? bytesToArgString(arg.bin)
        : arg == null
          ? ''
          : String(arg);

    for (let attempt = 0; attempt < MAX_EXCHANGES; attempt++) {
      let missing = null;
      let sendSeq = 0;
      const vm = new Vm(code, {
        tables,
        args: argText,
        // THE WRITE PERMISSION for this sequence. True only for the write
        // steps of an explicitly confirmed coding write (writeCoding gates
        // on opts.confirmed); the read steps in this module pass false.
        allowWrites: !!ctx.allowWrites,
        shared: ctx.session.shared,
        inited: ctx.session.inited,
        comm: ctx.session.comm,
        now: jobNow,
        send: (out, comm) => {
          const key = `${sendSeq++}:${Array.from(out)}`;
          if (answers.has(key)) return answers.get(key);
          missing = { key, out: Array.from(out), comm };
          const need = new Error('__need_answer__');
          need.needAnswer = true;
          throw need;
        },
      });
      try {
        const sets = vm.run(job, argText);
        ctx.session.inited = true;
        ctx.session.comm = vm.comm || ctx.session.comm;
        return sets;
      } catch (e) {
        if (!missing || !e.needAnswer) throw e;
        answers.set(missing.key, await ctx.exchange(missing.out, missing.comm));
      }
    }
    throw new Error(`coding job ${job} did not settle after 128 exchanges`);
  }

  /**
   * JOB_STATUS across the returned sets. EDIABAS publishes it as OKAY on
   * success; anything else (ERROR_ECU_*, Codierfehler, empty) is a failure.
   * @param {Array<Record<string, string>>|null|undefined} sets - result sets.
   * @returns {string|null} the last non-empty JOB_STATUS, or null.
   */
  function jobStatusOf(sets) {
    for (let i = (sets || []).length - 1; i >= 0; i--) {
      const st = sets[i] && sets[i].JOB_STATUS;
      if (st != null && st !== '') return String(st);
    }
    return null;
  }

  /**
   * Read the current netto via the strategy's read job (a READ; allowWrites
   * is forced false).
   * @param {WriteContext} ctx - the runner context.
   * @param {string} sgbd - the module.
   * @param {string|null} readJob - the read job, or null when the SGBD has none.
   * @returns {Promise<number[]|null>} the bytes, or null with no read job.
   * @throws {Error} ERROR_VERIFY when the read job reports a non-OKAY status.
   */
  async function readNetto(ctx, sgbd, readJob) {
    if (!readJob) return null;
    const sets = await runJobOverBus(
      { ...ctx, allowWrites: false },
      sgbd,
      readJob,
      ''
    );
    const st = jobStatusOf(sets);
    if (st && st !== JOB_OK) {
      throw errVerify(`re-read job ${readJob} returned JOB_STATUS ${st}`);
    }
    return extractNetto(sets);
  }

  /** Result names that carry the coding bytes, in preference order. */
  const NETTO_RESULT_NAMES = [
    'CODIERDATEN',
    'CODIERDATENSATZ',
    'CODIERUNG',
    'CODIERSTRING',
    'NETTODATEN',
    'DATEN',
  ];

  /**
   * Pull the coding bytes out of a read job's result sets. Prefers an explicit
   * CODIERDATEN / CODIERDATENSATZ / CODIERUNG field, else the first field
   * whose value looks like packed or dash-separated hex.
   * @param {Array<Record<string, string>>|null|undefined} sets - result sets.
   * @returns {number[]|null} the bytes, or null when nothing decodes.
   */
  function extractNetto(sets) {
    for (const set of sets || []) {
      if (!set || typeof set !== 'object') continue;
      for (const key of NETTO_RESULT_NAMES) {
        if (typeof set[key] === 'string' && set[key]) {
          const b = decodeHexField(set[key]);
          if (b) return b;
        }
      }
    }
    // fall back to any hex-looking field (skip the diagnostic echo fields)
    for (const set of sets || []) {
      if (!set || typeof set !== 'object') continue;
      for (const [k, v] of Object.entries(set)) {
        if (k.startsWith('_') || k === 'JOB_STATUS') continue;
        if (typeof v === 'string') {
          const b = decodeHexField(v);
          if (b && b.length) return b;
        }
      }
    }
    return null;
  }

  /**
   * "A1B2C3" or "A1-B2-C3" or "A1 B2 C3" -> bytes.
   * @param {string} v - the field text.
   * @returns {number[]|null} the bytes, or null if it is not hex.
   */
  function decodeHexField(v) {
    const clean = v.trim();
    if (!/^[0-9a-fA-F]([\s-]?[0-9a-fA-F]{2})*[0-9a-fA-F]?$/.test(clean)) {
      // allow pure packed hex too
      if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
    }
    const hex = clean.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length < 2 || hex.length % 2 !== 0) return null;
    const out = [];
    for (let i = 0; i < hex.length; i += 2)
      out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  /**
   * Build the verification failure the write path throws.
   * @param {string} msg - what did not verify.
   * @returns {Error & {code: 'ERROR_VERIFY'}} the error.
   */
  function errVerify(msg) {
    const e = /** @type {Error & {code: 'ERROR_VERIFY'}} */ (
      new Error(`ERROR_VERIFY: ${msg}`)
    );
    e.code = 'ERROR_VERIFY';
    return e;
  }

  // ---- the entry point -----------------------------------------------------

  // Sequence: read current netto (before) -> run the strategy's write steps,
  // asserting JOB_STATUS OKAY at each -> PROVE-BY-RE-READ: read it back and
  // assert it equals nettoBytes, else throw ERROR_VERIFY.
  /**
   * Write a module's FULL netto, behind the confirm gate, and prove it.
   * @param {string} sgbd - SGBD name (for messages / job lookup).
   * @param {string|ArrayLike<number>} nettoBytes - the FULL netto to write,
   *   as a hex string or byte array.
   * @param {WriteOptions} opts - see {@link WriteOptions}.
   * @returns {Promise<WriteResult>} the outcome.
   * @throws {Error} when not confirmed, the netto is empty, no exchange is
   *   given, or the SGBD exposes no known write path; ERROR_VERIFY when a
   *   step reports failure or the re-read does not match.
   */
  async function writeCoding(sgbd, nettoBytes, opts = /** @type {any} */ ({})) {
    if (!opts.confirmed) {
      throw new Error(
        'coding write refused: opts.confirmed must be set ' +
          '(the UI must confirm this actuation before it can transmit)'
      );
    }
    const Best2Vm = getVm(opts);
    const want = toBytes(nettoBytes);
    if (!want.length) throw new Error('coding write refused: empty netto');
    if (typeof opts.exchange !== 'function') {
      throw new Error('coding write refused: no bus exchange provided');
    }

    const session = opts.session || {
      shared: new Map(),
      inited: false,
      comm: null,
    };
    /** @type {WriteContext} */
    const baseCtx = {
      Best2Vm,
      code: opts.code,
      tables: opts.tables || (opts.code && opts.code.tables) || {},
      exchange: opts.exchange,
      session,
      now: opts.now || null,
    };

    // DISPATCHER PATH. When the caller ships the derived A_<cabd> program
    // (opts.dispatch), execute BMW's own coding dispatcher instead of the
    // hand-sequenced strategy: it picks the jobs and builds the wire packet
    // itself (core/coding/dispatch.js). We still prove the write by re-read
    // below, using whichever read job the SGBD exposes. Falls through to the
    // strategy path when no dispatcher is shipped for this module.
    if (opts.dispatch && typeof root.runCodingDispatch === 'function') {
      return writeViaDispatch(sgbd, want, baseCtx, opts);
    }

    const jobs = opts.jobs || (opts.code && opts.code.jobs) || {};
    const strategy = codingWriteStrategy(sgbd, jobs);
    // C_S_AUFTRAG does not take a coding image. Its argument is BMW's binary
    // buffer -- 21 header bytes, a run of words, a closing 0x03 -- one run at
    // a time, which only the module's dispatcher builds. Handed the bare
    // image it would read the first 21 coding bytes as a header.
    if (strategy === 'cfg-chunked') {
      throw new Error(
        `coding write refused: ${sgbd} is coded through its dispatcher ` +
          '(C_S_AUFTRAG takes request buffers, not an image) and none is shipped for it'
      );
    }
    if (!strategy) {
      throw new Error(
        `coding write refused: ${sgbd} exposes no known coding ` +
          'write job (CODIERDATEN_SCHREIBEN / CODIERUNG_SCHREIBEN / C_S_AUFTRAG)'
      );
    }

    const readJob = readJobFor(strategy, jobs);
    /** @type {Array<[string, string]>} */
    const sequence = [];

    // --- before: current netto (a READ; allowWrites stays false)
    const before = await readNetto(baseCtx, sgbd, readJob);
    if (readJob) sequence.push([readJob, JOB_OK]);

    // Already equal? Nothing to transmit -- do NOT open the write gate.
    if (before && bytesEqual(before, want)) {
      return {
        ok: true,
        before,
        after: before,
        sequence,
        strategy,
        note: 'netto already matches; no write transmitted',
      };
    }

    // --- the write steps (allowWrites TRUE, only here)
    const steps = writeSteps(strategy, want, jobs);
    if (!steps || !steps.length) {
      throw new Error(
        `coding write refused: strategy ${strategy} produced ` +
          'no runnable steps for this SGBD'
      );
    }
    const writeCtx = { ...baseCtx, allowWrites: true };
    for (const step of steps) {
      const sets = await runJobOverBus(writeCtx, sgbd, step.job, step.arg);
      const st = jobStatusOf(sets);
      sequence.push([step.job, st == null ? JOB_OK : st]);
      // A step that reports an explicit non-OKAY status aborts the sequence:
      // do not keep pushing writes at a module that rejected the last one.
      if (st != null && st !== JOB_OK) {
        throw errVerify(`step ${step.job} returned JOB_STATUS ${st}`);
      }
    }

    // --- PROVE BY RE-READ (a READ; allowWrites false again)
    const after = await readNetto(baseCtx, sgbd, readJob);
    if (readJob) sequence.push([readJob, JOB_OK]);
    if (after == null) {
      throw errVerify(
        'cannot prove the write: SGBD exposes no coding read job ' +
          'to re-read and verify against'
      );
    }
    if (!bytesEqual(after, want)) {
      throw errVerify(
        `re-read does not match written netto ` +
          `(wanted ${toHex(want)}, read back ${toHex(after)})`
      );
    }

    return { ok: true, before, after, sequence, strategy };
  }

  // ---- dispatcher-driven write --------------------------------------------
  //
  // Run BMW's derived A_<cabd> dispatcher (opts.dispatch). It owns the job
  // order and the request buffers; this owns what surrounds it:
  //
  //   1. READ the coding region, through the script's own CODIERDATEN_LESEN.
  //      That is the same route the proof uses, so a module that cannot be
  //      read back this way is refused BEFORE anything is sent.
  //   2. WRITE the whole region -- every coding block, as the factory tool
  //      does -- with what was just read and the edits laid on. What is not
  //      being edited goes back as the module held it a moment ago, not as a
  //      read from before the review dialog held it. The script still
  //      decides what it leaves out (the VIN, the checksum, the service data).
  //   3. PROVE: read it again; every edited byte must be as written.
  /** Without the caller's own base image, more differing bytes than this is
   *  taken for a wrong layout, not for an edit. */
  const MAX_UNBASED_EDITS = 64;
  /** The dispatcher jobname that reads the coding back. */
  const READ_JOBNAME = 'CODIERDATEN_LESEN';

  /**
   * Every byte address the coding description gives a meaning to: its
   * functions, and (for a read) its named blocks, which reach bytes no
   * function names. The factory tool reads those too.
   * @param {CabdLayout} cabd - the description.
   * @param {number} size - the image size.
   * @param {boolean} [blocks] - include the named blocks' whole ranges.
   * @returns {number[]} the addresses, ascending.
   */
  function codedAddrs(cabd, size, blocks) {
    const map = new Uint8Array(size);
    for (const f of cabd.fields || []) {
      const start = f.word | 0;
      const end = start + Math.max(1, f.byte | 0);
      for (let a = Math.max(0, start); a < end && a < size; a++) map[a] = 1;
    }
    for (const g of (blocks && cabd.groups) || []) {
      const start = g.start | 0;
      const end = start + Math.max(0, g.length | 0);
      for (let a = Math.max(0, start); a < end && a < size; a++) map[a] = 1;
    }
    const out = [];
    for (let a = 0; a < size; a++) if (map[a]) out.push(a);
    return out;
  }

  /**
   * How big a module's coding image is: up to the end of the last function
   * or named block, in whole words.
   * @param {CabdLayout} cabd - the coding description.
   * @param {number} wb - word width in bytes.
   * @returns {number} the size in bytes.
   */
  function imageSize(cabd, wb) {
    let end = 0;
    for (const f of cabd.fields || [])
      end = Math.max(end, (f.word | 0) + Math.max(1, f.byte | 0));
    for (const g of cabd.groups || [])
      end = Math.max(end, (g.start | 0) + Math.max(0, g.length | 0));
    return Math.ceil(end / wb) * wb;
  }

  /**
   * Read a module's coding image through its own coding script: every byte
   * the coding description gives a meaning to. This is what the coding
   * screens show a module's settings from. Nothing can be written by it: the
   * run's gate is shut.
   * @param {string} sgbd - the coding SGBD.
   * @param {WriteOptions} opts - `exchange`, `code`, `tables`, `dispatch`,
   *   `cabd`, and `dataOrg` when the script file carries none.
   * @returns {Promise<{netto: number[], read: number[], size: number,
   *   log: WireLogEntry[]}>} the image, which addresses of it were read (the
   *   rest are 0 and mean nothing), its size, and the jobs that ran.
   * @throws {Error} when there is no script or description, or the read fails.
   */
  async function readCoding(sgbd, opts = /** @type {any} */ ({})) {
    if (typeof opts.exchange !== 'function')
      throw new Error('coding read refused: no bus exchange provided');
    if (!opts.dispatch || typeof root.runCodingDispatch !== 'function')
      throw new Error(`coding read refused: no coding script for ${sgbd}`);
    const cabd = opts.cabd;
    if (!cabd || !Array.isArray(cabd.fields) || !cabd.fields.length)
      throw new Error('coding read refused: no coding description');
    const org = opts.dataOrg || opts.dispatch.dataOrg || {};
    const wb = org.wortBreite === 2 ? 2 : 1;
    const size = imageSize(cabd, wb);
    const baseCtx = {
      Best2Vm: getVm(opts),
      code: opts.code,
      tables: opts.tables || (opts.code && opts.code.tables) || {},
      exchange: opts.exchange,
      session: opts.session || { shared: new Map(), inited: false, comm: null },
      now: opts.now || null,
    };
    const r = await root.runCodingDispatch(opts.dispatch, {
      sgbd,
      cabd,
      dataOrg: {
        wortBreite: wb,
        byteFolge: org.byteFolge === 1 ? 1 : 0,
        adrMode: 0,
      },
      mode: 'read',
      jobname: READ_JOBNAME,
      netto: new Array(size).fill(0),
      readAddrs: codedAddrs(cabd, size, true),
      // read-only whatever the script asks for
      runJob: async (jobSgbd, job, argText, o) =>
        runJobOverBus(
          { ...baseCtx, allowWrites: false },
          jobSgbd || sgbd,
          job,
          o && o.binary
            ? { bin: Array.from(argText, (c) => c.charCodeAt(0)) }
            : argText
        ),
    });
    if (!r.ok) {
      throw new Error(
        `coding read failed (${r.info || `error ${r.err}, return ${r.ret}`})`
      );
    }
    return { netto: r.netto, read: r.read, size, log: r.log };
  }

  /**
   * What a coding script may ask about the car and the place it is coded at.
   * @param {WriteOptions} opts - `vin` and/or `systemData`.
   * @returns {Record<string, string>} the system data for the run.
   */
  function systemDataFor(opts) {
    // WERK_NR 0000 is "not a plant": the cluster's script resets the
    // time-based service counter for a car on the line (any other number).
    const data = { WERK_NR: '0000' };
    // FAHRGESTELL_NR is the 17-character VIN and its check character. The
    // cluster's script compares its last seven with the module's own to
    // decide whether the VIN is to be written; the body module's passes it
    // to a job that takes exactly 18 characters.
    const vin = String(opts.vin || '')
      .trim()
      .toUpperCase();
    const Encode =
      typeof root !== 'undefined' && root.CodingEncode
        ? root.CodingEncode
        : typeof require !== 'undefined'
          ? require('./encode.js')
          : null;
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) && Encode)
      data.FAHRGESTELL_NR = Encode.formatFahrgestellNr(vin);
    return { ...data, ...(opts.systemData || {}) };
  }

  /**
   * Write via the derived dispatcher, then prove by re-read.
   * @param {string} sgbd - the module.
   * @param {number[]} want - the FULL image the module should hold.
   * @param {WriteContext} baseCtx - the runner context (gate closed).
   * @param {WriteOptions} opts - the caller's options (dispatch, cabd, base,
   *   dataOrg, systemData, jobname).
   * @returns {Promise<WriteResult>} the outcome.
   * @throws {Error} a refusal before anything is sent (no coding description,
   *   an edit outside it, a module that cannot be read back); ERROR_VERIFY
   *   when the dispatcher reports failure or the re-read does not match.
   */
  async function writeViaDispatch(sgbd, want, baseCtx, opts) {
    const cabd = opts.cabd;
    if (!cabd || !Array.isArray(cabd.fields) || !cabd.fields.length) {
      throw new Error(
        'coding write refused: the dispatcher needs the coding description ' +
          'of the module (its functions and their addresses) to select from'
      );
    }
    // data-org: word width (1 byte / 2 word), byte order (0 low-first), from
    // the CABD's SPEICHERORG.
    const org = opts.dataOrg || opts.dispatch.dataOrg || {};
    const wb = org.wortBreite === 2 ? 2 : 1;
    const dataOrg = {
      wortBreite: wb,
      byteFolge: org.byteFolge === 1 ? 1 : 0,
      adrMode: 0,
    };
    if (want.length % wb) {
      throw new Error(
        `coding write refused: a ${want.length}-byte image for a module that stores ${wb}-byte words`
      );
    }
    const coded = codedAddrs(cabd, want.length);
    // the description's blocks, when it says which are coding data
    const kinds = (cabd.groups || []).filter((g) => g.kind);
    const isCoded = new Uint8Array(want.length);
    for (const a of coded) isCoded[a] = 1;

    // WHAT IS BEING EDITED: where the wanted image differs from the image the
    // edits were made on (opts.base, the caller's own read). Without a base
    // it is where it differs from the module, bounded.
    const base = opts.base ? toBytes(opts.base) : null;
    if (base && base.length !== want.length) {
      throw new Error(
        `coding write refused: the base image is ${base.length} bytes, the wanted one ${want.length}`
      );
    }

    /** @type {CdhRunJob} */
    const runJob = async (jobSgbd, job, argText, o) => {
      const ctx = { ...baseCtx, allowWrites: !!(o && o.allowWrites) };
      const arg =
        o && o.binary
          ? { bin: Array.from(argText, (c) => c.charCodeAt(0)) }
          : argText;
      return runJobOverBus(ctx, jobSgbd || sgbd, job, arg);
    };
    const common = { sgbd, cabd, dataOrg, confirmed: true, runJob };

    /**
     * Read byte addresses through the script's own read route.
     * @param {number[]} addrs - the addresses.
     * @param {string} what - for the message ("before the write").
     * @param {(msg: string) => Error} fail - how a failure is reported.
     * @returns {Promise<number[]>} the image, filled at those addresses' words.
     */
    const readBack = async (addrs, what, fail) => {
      const r = await root.runCodingDispatch(opts.dispatch, {
        ...common,
        mode: 'read',
        jobname: READ_JOBNAME,
        netto: new Array(want.length).fill(0),
        readAddrs: addrs,
      });
      if (!r.ok) {
        throw fail(
          `the module could not be read ${what} (${r.info || `error ${r.err}, return ${r.ret}`})`
        );
      }
      const got = new Set(r.read);
      const missed = addrs.filter((a) => !got.has(a));
      if (missed.length) {
        throw fail(
          `the read ${what} left ${missed.length} of ${addrs.length} bytes unanswered`
        );
      }
      return r.netto;
    };
    const refuse = (msg) => new Error(`coding write refused: ${msg}`);

    let edits;
    if (base) {
      edits = [];
      for (let a = 0; a < want.length; a++)
        if (want[a] !== base[a]) edits.push(a);
    } else {
      const now = await readBack(coded, 'to find what changes', refuse);
      edits = coded.filter((a) => now[a] !== want[a]);
      if (edits.length > MAX_UNBASED_EDITS) {
        throw refuse(
          `${edits.length} bytes differ from the module; that is not an edit ` +
            '(a wrong coding index or image?)'
        );
      }
    }
    const stray = edits.filter((a) => !isCoded[a]);
    if (stray.length) {
      throw refuse(
        `an edit at 0x${stray[0].toString(16)} is outside what the coding description covers`
      );
    }
    if (!edits.length) {
      return {
        ok: true,
        before: null,
        after: null,
        strategy: 'dispatch',
        log: [],
        note: 'netto already matches; no write transmitted',
      };
    }
    // ONLY CODING DATA. A coding description sorts its blocks into coding
    // data, manufacturer data and reserved data, and a module is reported to
    // refuse its coding job on the last two (the job answers
    // ERROR_ECU_PARAMETER). That refusal would come mid-run; knowing the
    // blocks, it is said here instead, before anything is sent. A word that
    // is only half coding data counts as not.
    if (kinds.length) {
      const codingData = new Uint8Array(want.length);
      for (const g of kinds) {
        if (g.kind !== 'coding') continue;
        const end = (g.start | 0) + Math.max(0, g.length | 0);
        for (let a = Math.max(0, g.start | 0); a < end && a < want.length; a++)
          codingData[a] = 1;
      }
      const outside = edits.find((a) => {
        const w = a - (a % wb);
        for (let k = 0; k < wb; k++) if (!codingData[w + k]) return true;
        return false;
      });
      if (outside != null) {
        const block = kinds.find(
          (g) => outside >= g.start && outside < g.start + g.length
        );
        throw refuse(
          `the edit at 0x${outside.toString(16)} is not coding data` +
            (block && block.kind !== 'coding'
              ? ` (it is in the ${block.kind} block ${block.name})`
              : ' (no coding block holds its whole word)')
        );
      }
    }

    // THE WHOLE CODING REGION GOES OUT, as the factory tool sends it: every
    // word of the description's coding blocks, not just the ones an edit is
    // in. (Without block kinds: every word a function lives in.) Only whole
    // words count; a word half outside the region is not the coding job's.
    const inRegion = new Uint8Array(want.length);
    if (kinds.length) {
      for (const g of kinds) {
        if (g.kind !== 'coding') continue;
        const end = (g.start | 0) + Math.max(0, g.length | 0);
        for (let a = Math.max(0, g.start | 0); a < end && a < want.length; a++)
          inRegion[a] = 1;
      }
    } else {
      for (const a of coded) inRegion[a] = 1;
    }
    const region = [];
    for (let w = 0; w + wb <= want.length; w += wb) {
      let whole = true;
      for (let k = 0; k < wb; k++) if (!inRegion[w + k]) whole = false;
      if (whole) for (let k = 0; k < wb; k++) region.push(w + k);
    }
    const regionSet = new Set(region);
    const lost = edits.find((a) => !regionSet.has(a));
    if (lost != null) {
      throw refuse(
        `the edit at 0x${lost.toString(16)} is not in a whole word of the coding region`
      );
    }

    // where the run is, for whoever is watching (it takes a while, and the
    // module is being written for part of it)
    const stage = (text) => {
      if (typeof opts.onStage === 'function') opts.onStage(text);
    };

    // 1. the region, as the module holds it NOW
    stage('Reading the module');
    const before = await readBack(region, 'before the write', refuse);

    // 2. the write: what was just read, with the edits laid on. Everything
    // that is not being edited goes back exactly as it came, seconds old.
    const image = want.slice();
    for (const a of region) image[a] = before[a];
    for (const a of edits) image[a] = want[a];
    stage('Writing: do not disconnect or switch the ignition off');
    const result = await root.runCodingDispatch(opts.dispatch, {
      ...common,
      mode: 'write',
      jobname: opts.jobname || DEFAULT_JOBNAME,
      netto: image,
      changed: region,
      held: before,
      systemData: systemDataFor(opts),
    });
    const sent = new Set(result.written);
    const unsent = edits.filter((a) => !sent.has(a));
    if (!result.ok) {
      throw errVerify(
        `the coding run failed (${result.info || `error ${result.err}, return ${result.ret}`})` +
          (sent.size
            ? `; ${sent.size} bytes had already been sent`
            : '; nothing was sent')
      );
    }
    if (unsent.length) {
      // the script switched the function off (it does that for the VIN, the
      // checksum and the service data), or issued no write job at all
      throw errVerify(
        `the coding run ended without sending ${unsent.length} of ${edits.length} edited bytes ` +
          `(first at 0x${unsent[0].toString(16)})`
      );
    }

    // 3. PROVE BY RE-READ, on every byte a write job carried. An edited byte
    // must read back as written. Another byte that reads back differently
    // was written with what the module held a moment before and has since
    // been changed by the module itself (each write job has already read its
    // own telegram back): that is reported, not called a failed write.
    const carried = result.written;
    stage('Written. Reading it back to verify');
    const after = await readBack(carried, 'back after the write', errVerify);
    const edited = new Set(edits);
    const wrong = carried.filter((a) => edited.has(a) && after[a] !== image[a]);
    if (wrong.length) {
      const a = wrong[0];
      throw errVerify(
        `re-read does not match at ${wrong.length} edited bytes (first at 0x${a.toString(16)}: ` +
          `wrote ${toHex([image[a]])}, read back ${toHex([after[a]])})`
      );
    }
    const moved = carried.filter(
      (a) => !edited.has(a) && after[a] !== image[a]
    );
    return {
      ok: true,
      before: carried.map((a) => before[a] ?? null),
      after: carried.map((a) => after[a]),
      addrs: carried,
      edited: edits,
      moved,
      strategy: 'dispatch',
      log: result.log,
      ...(moved.length
        ? {
            note: `${moved.length} bytes outside the edit read back differently than written (first at 0x${moved[0].toString(16)}): the module changed them itself`,
          }
        : {}),
    };
  }

  const api = {
    codingWriteStrategy,
    writeCoding,
    readCoding,
    saveCodingBackup,
    listCodingBackups,
    // exposed for the UI/tests to introspect without running anything
    writeSteps,
    readJobFor,
    _toBytes: toBytes,
    _toHex: toHex,
    _bytesToArgString: bytesToArgString,
    _extractNetto: extractNetto,
    _systemDataFor: systemDataFor,
  };

  if (typeof root !== 'undefined') {
    root.codingWriteStrategy = codingWriteStrategy;
    root.writeCoding = writeCoding;
    root.readCoding = readCoding;
    root.codingWrite = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
