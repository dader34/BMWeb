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
 * @property {string} [note] - why nothing was transmitted / not re-read.
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
  // Run BMW's derived A_<cabd> dispatcher (opts.dispatch) to produce the write.
  // We hand it the target netto as a slot table (one slot per byte address) and
  // the data-org (word width / byte order) from the CABD's SPEICHERORG, then
  // read back and prove equality. The dispatcher owns the job order and the
  // wire-packet framing; we own the confirm gate, the slot/data-org seeding,
  // and the prove-by-re-read.
  /**
   * Write via the derived dispatcher, then prove by re-read.
   * @param {string} sgbd - the module.
   * @param {number[]} want - the FULL netto to write.
   * @param {WriteContext} baseCtx - the runner context (gate closed).
   * @param {WriteOptions} opts - the caller's options (dispatch, dataOrg, jobs).
   * @returns {Promise<WriteResult>} the outcome.
   * @throws {Error} ERROR_VERIFY when the dispatcher reports failure or the
   *   re-read does not match.
   */
  async function writeViaDispatch(sgbd, want, baseCtx, opts) {
    // data-org: word width (1 byte / 2 word), byte order (0 low-first).
    // The CABD SPEICHERORG STRUKTUR: BYTE -> wb 1; WORDMSB/WORDLSB -> wb 2,
    // byteFolge 0 (LSB) or 1 (MSB). Default byte mode when unspecified.
    const org = opts.dataOrg || {};
    const wb = org.wortBreite === 2 ? 2 : 1;
    const byteFolge = org.byteFolge === 1 ? 1 : 0;
    // The netto to write as a byte-addressed slot table. The dispatcher's
    // CDHGetApiJobData walks these in address order to build each chunk.
    const slots = want.map((v, addr) => ({
      addr,
      value: v & 0xff,
      mask: 0xff,
      flags: 0,
    }));

    // runJob for the dispatcher: the SAME memoised bus replay the strategy
    // path uses, with allowWrites threaded per call. Reads (the dispatcher's
    // own ident/index/current-netto) come with the gate closed.
    /** @type {CdhRunJob} */
    const runJob = async (jobSgbd, job, argText, o) => {
      const ctx = { ...baseCtx, allowWrites: !!(o && o.allowWrites) };
      const arg =
        o && o.binary
          ? { bin: Array.from(argText, (c) => c.charCodeAt(0)) }
          : argText;
      return runJobOverBus(ctx, jobSgbd || sgbd, job, arg);
    };

    // Seed data-org before the dispatcher runs (NCSEXPER's C layer does this at
    // CABD load, before the IPO): the SGBD's len == 22 + N*wortBreite check
    // fails if the width does not match, so a word-mode module (E46 KMB) needs
    // wb 2 here.
    const result = await root.runCodingDispatch(opts.dispatch, {
      sgbd,
      slots,
      jobname: opts.jobname || DEFAULT_JOBNAME,
      dataOrg: { wortBreite: wb, byteFolge, adrMode: 0 },
      confirmed: true,
      runJob,
    });
    if (!result.ok) {
      throw errVerify(
        `dispatcher reported failure (err ${result.err}, ` +
          `ret ${result.ret})`
      );
    }

    // PROVE BY RE-READ, independent of the dispatcher's own verify. Use the
    // SGBD's coding read job; compare to what we asked to write.
    const jobs = opts.jobs || (opts.code && opts.code.jobs) || {};
    const readJob =
      readJobFor('codierdaten', jobs) || readJobFor('codierung', jobs);
    const after = readJob ? await readNetto(baseCtx, sgbd, readJob) : null;
    if (after == null) {
      // No read job to verify with: the dispatcher's post-write C_CHECKSUM is
      // the only proof. Report it but flag the missing independent re-read.
      return {
        ok: true,
        before: null,
        after: null,
        strategy: 'dispatch',
        log: result.log,
        note: 'no coding read job to prove by re-read',
      };
    }
    if (!bytesEqual(after, want)) {
      throw errVerify(
        `re-read does not match written netto ` +
          `(wanted ${toHex(want)}, read back ${toHex(after)})`
      );
    }
    return {
      ok: true,
      before: null,
      after,
      strategy: 'dispatch',
      log: result.log,
    };
  }

  const api = {
    codingWriteStrategy,
    writeCoding,
    saveCodingBackup,
    listCodingBackups,
    // exposed for the UI/tests to introspect without running anything
    writeSteps,
    readJobFor,
    _toBytes: toBytes,
    _toHex: toHex,
    _bytesToArgString: bytesToArgString,
    _extractNetto: extractNetto,
  };

  if (typeof root !== 'undefined') {
    root.codingWriteStrategy = codingWriteStrategy;
    root.writeCoding = writeCoding;
    root.codingWrite = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
