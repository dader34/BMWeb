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
 * @property {(sgbd: string) => Promise<{code: object|null, tables?: object}|null>} [codeFor]
 *   - another SGBD's program, for a job the coding script addresses to it
 *   (FA.PRG's FA_STREAM2STRUCT).
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
 * @property {string} [fa] - the car's vehicle order as text, for a script
 *   that reads elements of it (CDHGetFaElement).
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
   * The context a coding script's job runs in. A job the script addresses to
   * another SGBD (A_KMB46's FA_READ asks FA.PRG for FA_STREAM2STRUCT) runs on
   * that SGBD's own code, in a session of its own, as EDIABAS loads the SGBD
   * a job names; the write permission is the caller's either way. Without a
   * loader (opts.codeFor) or the SGBD's code, the module's own code runs and
   * the VM says it has no such job.
   * @param {string} sgbd - the coding SGBD.
   * @param {{codeFor?: (sgbd: string) => Promise<{code: object|null,
   *   tables?: object}|null>}} opts - the loader.
   * @returns {(ctx: WriteContext, jobSgbd: string|undefined) =>
   *   Promise<WriteContext>}
   */
  function foreignJobs(sgbd, opts) {
    const own = String(sgbd).toLowerCase();
    /** @type {Map<string, {shared: Map<string, any>, inited: boolean, comm: any}>} */
    const sessions = new Map();
    return async (ctx, jobSgbd) => {
      const key = String(jobSgbd || '').toLowerCase();
      if (!key || key === own || typeof opts.codeFor !== 'function') return ctx;
      const got = await opts.codeFor(key);
      if (!got || !got.code) return ctx;
      if (!sessions.has(key))
        sessions.set(key, { shared: new Map(), inited: false, comm: null });
      return {
        ...ctx,
        code: got.code,
        tables: got.tables || {},
        session: sessions.get(key),
      };
    };
  }

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

  // BLOCK-ADDRESSED CODING. A module whose description numbers its blocks
  // (SPEICHERORG TYP BLOCK: the light module, the body module ...) keeps each
  // block as its own little memory, and its coding jobs take a block number
  // rather than an address. The factory tool's own CBD reader (CBD_READ.C,
  // CBDParzuwFsw / CBDParzuwDir, read out of its binary) folds the block into
  // the address when it loads a row:
  //
  //     if (BLOCKNR != 0) {
  //       if (WORTADR > 0xFF || BLOCKNR > 0xFFFFFF) -> error 0x115A
  //       WORTADR |= wordWidth * BLOCKNR * 0x100
  //     }
  //
  // and the request buffer carries that address little-endian from HDR_ADDR
  // (dispatch-host.js). So the block is the address's upper bytes and the
  // offset its low byte, and every coding SGBD reads it there in its own way:
  // the LSZ, body module (ZKE5, ZKE5_S12), airbag, PDC ... send byte 0x12 as
  // the block (`08 <block>`); the ALC sends 0x13 and 0x12 (`08 <hi> <lo>`,
  // its blocks are 0x3000..); the ME9 KWP jobs send 0x13 and 0x14 as the data
  // identifier (`22 30 00`). None of that is the host's business: a blocked
  // description is laid into one flat image, block N at N * 256 (one byte per
  // word: every blocked E46 description is byte-wide), and a request is
  // always one whole block. Nothing else in the read/write path needs to know
  // about blocks.
  /** Bytes per block in the flat image of a block-addressed module. */
  const BLOCK_STRIDE = 256;

  /**
   * Do this SGBD's coding jobs tell the description's blocks apart on the
   * wire? The factory tool trusts them blindly; the case worth refusing is a
   * description whose blocks the jobs cannot all name -- two of them would
   * be written to the same place. Asked of the module's own jobs, in the VM,
   * with nothing on the wire: each job is run once per block (the first
   * eight the description names) and its first telegram kept; the blocks
   * are on the wire when no two telegrams are the same.
   * @param {object} code - the SGBD's job code.
   * @param {object} tables - its tables.
   * @param {Function} Vm - the BEST/2 VM.
   * @param {number[]} blocks - the description's block numbers.
   * @returns {boolean}
   */
  function blockOnTheWire(code, tables, Vm, blocks) {
    const jobs = (code && code.jobs) || {};
    const has = (j) =>
      Array.isArray(jobs) ? jobs.some((x) => (x.name || x) === j) : j in jobs;
    const pair = [
      ['C_C_LESEN', 'C_C_AUFTRAG'],
      ['C_S_LESEN', 'C_S_AUFTRAG'],
    ].find(([r, w]) => has(r) && has(w));
    if (!pair || !Vm) return false;
    const N = 8;
    const telegram = (job, addr) => {
      const p = new Array(21 + N + 1).fill(0);
      p[0] = 1;
      p[1] = 1;
      p[9] = 0xff;
      p[13] = N;
      p[15] = N;
      p[17] = addr & 0xff;
      p[18] = (addr >> 8) & 0xff;
      p[19] = (addr >> 16) & 0xff;
      p[20] = (addr >> 24) & 0xff;
      p[p.length - 1] = 3;
      const args = String.fromCharCode(...p);
      let first = null;
      const vm = new Vm(code, {
        tables: tables || {},
        args,
        allowWrites: true,
        shared: new Map(),
        inited: false,
        comm: null,
        now: new Date(0),
        send: (out) => {
          first = Array.from(out);
          throw new Error('probe');
        },
      });
      try {
        vm.run(job, args);
      } catch {
        /* stopped at the first telegram, or refused the buffer */
      }
      return first ? first.join(',') : null;
    };
    const probe = [...new Set((blocks || []).map((b) => b | 0))]
      .sort((a, b) => a - b)
      .slice(0, 8);
    if (probe.length < 2) return true;
    return pair.every((job) => {
      const t = probe.map((b) => telegram(job, b * BLOCK_STRIDE));
      return t.every((x) => x) && new Set(t).size === t.length;
    });
  }

  /**
   * The block numbers a coding description names, ascending (just [0] for a
   * flat one).
   * @param {CabdLayout|null|undefined} cabd - the description.
   * @returns {number[]}
   */
  function codingBlocks(cabd) {
    const out = new Set([0]);
    for (const g of (cabd && cabd.groups) || []) out.add(g.block | 0);
    for (const f of (cabd && cabd.fields) || []) out.add(f.block | 0);
    return [...out].sort((a, b) => a - b);
  }

  /**
   * Does a description number its blocks?
   * @param {CabdLayout} cabd - the description.
   * @returns {boolean}
   */
  function isBlocked(cabd) {
    return !!(
      cabd &&
      (cabd.typ === 'BLOCK' ||
        (cabd.fields || []).some((f) => (f.block | 0) > 0) ||
        (cabd.groups || []).some((g) => (g.block | 0) > 0))
    );
  }

  /**
   * A block-addressed description laid flat (address = block * 256 +
   * offset, every block 0 afterwards), marked with its stride. A flat
   * description, or one already laid flat, comes back unchanged.
   * @param {CabdLayout} cabd - the description.
   * @returns {CabdLayout & {blockStride?: number}}
   */
  function flattenBlocked(cabd) {
    if (!cabd || cabd.blockStride || !isBlocked(cabd)) return cabd;
    const at = (block, word) => (block | 0) * BLOCK_STRIDE + (word | 0);
    return {
      ...cabd,
      fields: (cabd.fields || []).map((f) => ({
        ...f,
        word: at(f.block, f.word),
        block: 0,
      })),
      groups: (cabd.groups || []).map((g) => ({
        ...g,
        start: at(g.block, g.start),
        block: 0,
      })),
      ...(cabd.fill
        ? {
            fill: cabd.fill.map((r) => ({
              ...r,
              start: at(r.block, r.start),
              block: 0,
            })),
          }
        : {}),
      ...(cabd.own
        ? {
            own: cabd.own.map((r) => ({
              ...r,
              start: at(r.block, r.start),
              block: 0,
            })),
          }
        : {}),
      blockStride: BLOCK_STRIDE,
    };
  }

  /**
   * One function of a block-addressed module, addressed in the flat image.
   * @param {object} f - the function (its own block and word).
   * @returns {object} the same function at block * 256 + word, block 0.
   */
  function flatRule(f) {
    if (!f || !(f.block | 0)) return f;
    return {
      ...f,
      word: (f.block | 0) * BLOCK_STRIDE + (f.word | 0),
      block: 0,
    };
  }

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
   * What the factory tool writes of a module when it codes all of it (the
   * netto build, CBD_PROC.C): per byte, the bits its functions own together
   * with the description's unused bits (UNBELEGT1), and the value those
   * unused bits get (UNBELEGT2: the row's value, shifted into its mask, the
   * mask's bytes big end first). A byte with no bit in either is never sent.
   * Null for a description that carries no unused-bit rows (an older data
   * build): then nothing is known beyond the functions.
   * @param {CabdLayout & {fill?: Array<{start: number, length: number,
   *   masks: number[], values: number[]}>}} cabd - the description (laid flat).
   * @param {number} size - the image size.
   * @returns {{mask: Uint8Array, fillMask: Uint8Array, fillBits: Uint8Array}|null}
   */
  function factoryCoverage(cabd, size) {
    if (!cabd || !Array.isArray(cabd.fill)) return null;
    const mask = new Uint8Array(size);
    const fillMask = new Uint8Array(size);
    const fillBits = new Uint8Array(size);
    // every function row, named or not (cabd.own); without it, the
    // functions the description's caller kept
    const rows = cabd.own
      ? cabd.own
      : (cabd.fields || []).map((f) => ({
          start: f.word | 0,
          length: f.byte,
          masks:
            f.masks && f.masks.length
              ? f.masks
              : [f.mask == null ? 0xff : f.mask],
        }));
    for (const r of rows) {
      const n = Math.max(1, r.length | 0);
      for (let k = 0; k < n; k++) {
        const a = (r.start | 0) + k;
        if (a >= 0 && a < size) mask[a] |= r.masks[k % r.masks.length] & 0xff;
      }
    }
    for (const r of cabd.fill) {
      const w = r.masks.length;
      if (!w) continue;
      let m = 0n;
      let v = 0n;
      for (let k = 0; k < w; k++) {
        m = (m << 8n) | BigInt(r.masks[k] & 0xff);
        v =
          (v << 8n) | BigInt((r.values[k - (w - r.values.length)] ?? 0) & 0xff);
      }
      let shift = 0n;
      if (m) while (!((m >> shift) & 1n)) shift++;
      const bits = (v << shift) & m;
      for (let k = 0; k < Math.max(1, r.length | 0); k++) {
        const a = (r.start | 0) + k;
        if (a < 0 || a >= size) continue;
        const j = BigInt(w - 1 - (k % w)) * 8n;
        const bm = Number((m >> j) & 0xffn);
        mask[a] |= bm;
        fillMask[a] |= bm;
        fillBits[a] = (fillBits[a] & ~bm) | Number((bits >> j) & 0xffn);
      }
    }
    return { mask, fillMask, fillBits };
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
    // a block-addressed module is read in the flat image (see flattenBlocked)
    const cabd = flattenBlocked(opts.cabd);
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
    const ctxFor = foreignJobs(sgbd, opts);
    const r = await root.runCodingDispatch(opts.dispatch, {
      sgbd,
      fa: opts.fa || undefined,
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
          await ctxFor({ ...baseCtx, allowWrites: false }, jobSgbd),
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
   * Does a vehicle order carry an element with this marker (and a value)?
   * The markers are the factory tool's (dispatch-host.js FA_MARKS).
   * @param {string} fa - the order as text.
   * @param {string} mark - the marker character.
   * @returns {boolean}
   */
  function faHasElement(fa, mark) {
    const m = String(mark).charAt(0);
    for (let i = 0; i < fa.length; i++)
      if (fa[i] === m && i + 1 < fa.length && !'*$#%&-+|'.includes(fa[i + 1]))
        return true;
    return false;
  }

  /**
   * A vehicle-order marker in words.
   * @param {string} mark - the marker character.
   * @returns {string}
   */
  function faMarkName(mark) {
    return (
      {
        '&': 'upholstery code',
        '%': 'paint code',
        '#': 'build date',
        '*': 'type key',
        $: 'option codes',
      }[String(mark).charAt(0)] || `"${mark}" element`
    );
  }

  /** A VIN whose last seven (chars 10-16) are BMW's "not known" marker. */
  const NO_VIN = '0000000000ZZ00000';

  /**
   * Does this coding script use a given text constant (a system-data key,
   * a job name)?
   * @param {object|null|undefined} dispatch - the script.
   * @param {string} text - the constant.
   * @returns {boolean}
   */
  function scriptAsks(dispatch, text) {
    if (!dispatch || !dispatch.procs) return false;
    for (const ops of Object.values(dispatch.procs))
      for (const o of ops || [])
        if (o && o.op === 'const' && o.v === text) return true;
    return false;
  }

  /**
   * Does this coding script treat ZZ00000 as "no VIN"?
   * @param {object|null|undefined} dispatch - the script.
   * @returns {boolean}
   */
  function scriptKnowsNoVin(dispatch) {
    return scriptAsks(dispatch, 'ZZ00000');
  }

  /**
   * Run one of a coding script's READ jobs (ZCS_LESEN, FGNR_LESEN, FA_READ,
   * CODIERINDEX_LESEN, ...) and return what it hands back -- how NCS Expert
   * reads the car's key, order and VIN from the modules that hold them. The
   * run's write gate is shut.
   * @param {string} sgbd - the coding SGBD.
   * @param {WriteOptions & {jobname: string}} opts - `exchange`, `code`,
   *   `tables`, `dispatch`, `jobname`.
   * @returns {Promise<{ok: boolean, pars: Record<string, string|number>,
   *   info: string, log: WireLogEntry[]}>} the outcome and the values.
   */
  async function runCodingReadJob(sgbd, opts = /** @type {any} */ ({})) {
    if (typeof opts.exchange !== 'function')
      throw new Error('coding read refused: no bus exchange provided');
    if (!opts.dispatch || typeof root.runCodingDispatch !== 'function')
      throw new Error(`coding read refused: no coding script for ${sgbd}`);
    if (/SCHREIBEN|CODIEREN|LOESCHEN|WRITE/i.test(String(opts.jobname)))
      throw new Error(`coding read refused: ${opts.jobname} is not a read`);
    const org = opts.dataOrg || opts.dispatch.dataOrg || {};
    const baseCtx = {
      Best2Vm: getVm(opts),
      code: opts.code,
      tables: opts.tables || (opts.code && opts.code.tables) || {},
      exchange: opts.exchange,
      session: opts.session || { shared: new Map(), inited: false, comm: null },
      now: opts.now || null,
    };
    const ctxFor = foreignJobs(sgbd, opts);
    const r = await root.runCodingDispatch(opts.dispatch, {
      sgbd,
      fa: opts.fa || undefined,
      cabd: flattenBlocked(opts.cabd) || { fields: [] },
      dataOrg: {
        wortBreite: org.wortBreite === 2 ? 2 : 1,
        byteFolge: org.byteFolge === 1 ? 1 : 0,
        adrMode: 0,
      },
      mode: 'read',
      jobname: opts.jobname,
      netto: [],
      readAddrs: [],
      systemData: systemDataFor(opts),
      runJob: async (jobSgbd, job, argText, o) =>
        runJobOverBus(
          await ctxFor({ ...baseCtx, allowWrites: false }, jobSgbd),
          jobSgbd || sgbd,
          job,
          o && o.binary
            ? { bin: Array.from(argText, (c) => c.charCodeAt(0)) }
            : argText
        ),
    });
    return { ok: r.ok, pars: r.pars || {}, info: r.info, log: r.log };
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
    else if (scriptKnowsNoVin(opts.dispatch))
      // No VIN known: BMW's marker for that is ZZ00000 in the last seven,
      // which the scripts that check for it (LSZ, KMB46, LCM, ...) take as
      // "leave the module's VIN alone". Only those get it -- the rest would
      // write whatever they were handed.
      data.FAHRGESTELL_NR = NO_VIN;
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
    // a block-addressed module is written in the flat image (flattenBlocked);
    // `want` and `base` are already laid out that way by the reader
    const cabd = flattenBlocked(opts.cabd);
    if (!cabd || !Array.isArray(cabd.fields) || !cabd.fields.length) {
      throw new Error(
        'coding write refused: the dispatcher needs the coding description ' +
          'of the module (its functions and their addresses) to select from'
      );
    }
    if (
      cabd.blockStride &&
      !blockOnTheWire(
        baseCtx.code,
        baseCtx.tables,
        baseCtx.Best2Vm,
        codingBlocks(opts.cabd)
      )
    ) {
      throw new Error(
        `coding write refused: ${sgbd} numbers its coding blocks, but its ` +
          'own read and write jobs cannot tell them all apart on the wire'
      );
    }
    // THE VIN. A script that asks for FAHRGESTELL_NR writes it to the module
    // (A_IHK46 does on every SG_CODIEREN, unconditionally). NCS always has
    // it -- the FG of the car's key -- so without it the run would code the
    // module and then fail on the VIN job, mid-sequence. Refuse before
    // anything is sent, unless the script knows BMW's "no VIN" marker.
    if (
      !systemDataFor(opts).FAHRGESTELL_NR &&
      scriptAsks(opts.dispatch, 'FAHRGESTELL_NR')
    ) {
      throw new Error(
        `coding write refused: ${sgbd}'s coding script writes the car's VIN ` +
          'into the module, and no VIN is known. Enter it or read it from ' +
          'the car (VIN/ZCS/FA) first.'
      );
    }
    // WHAT ELSE THE SCRIPT WILL ASK FOR, asked before anything is sent: a
    // script that reads the car's order (EWS3 writes its paint and
    // upholstery codes after the coding) or the module's ident lists, and
    // finds them missing, would stop with the coding already written.
    const D = root.codingDispatch || {};
    if (typeof D.scriptCalls === 'function') {
      const calls = D.scriptCalls(opts.dispatch);
      if (calls.includes('CDHGetFaElement')) {
        const fa = String(opts.fa || '').trim();
        if (!fa) {
          throw new Error(
            `coding write refused: ${sgbd}'s coding script reads the car's ` +
              'vehicle order (FA), and none was read. Read the car (VIN/ZCS/FA) first.'
          );
        }
        const lacking = [
          ...new Set(D.scriptCallArgs(opts.dispatch, 'CDHGetFaElement', 3)),
        ].filter((m) => m && !faHasElement(fa, m));
        if (lacking.length) {
          throw new Error(
            `coding write refused: ${sgbd}'s coding script writes the car's ` +
              `${lacking.map(faMarkName).join(' and ')} from its vehicle order, ` +
              'and the order read from the car has none'
          );
        }
      }
      if (calls.includes('CDHGetInfo')) {
        const sys = systemDataFor(opts);
        const lacking = [
          ...new Set(D.scriptCallArgs(opts.dispatch, 'CDHGetInfo', 5)),
        ].filter((k) => !sys[String(k).toUpperCase()]);
        if (lacking.length) {
          throw new Error(
            `coding write refused: ${sgbd}'s coding script asks for the ` +
              `module's ${lacking.join(', ')}, which this app does not read`
          );
        }
      }
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
    // THE CENTRAL CODING KEY IS A BLOCK, NOT A FUNCTION. ZCS_SCHREIBEN and
    // ZCS_LOESCHEN write the "ZCS" group (GM/SA/VN with their check
    // characters), which no function covers. Those two jobs, and only those,
    // may edit its bytes.
    const zcsJob = /^ZCS_(SCHREIBEN|LOESCHEN)$/i.test(
      String(opts.jobname || '')
    );
    if (zcsJob) {
      const g = (cabd.groups || []).find(
        (x) => String(x.name).toUpperCase() === 'ZCS'
      );
      if (!g) {
        throw new Error(
          'coding write refused: this coding description has no ZCS block'
        );
      }
      for (let a = g.start | 0; a < (g.start | 0) + (g.length | 0); a++)
        if (a < isCoded.length) {
          if (!isCoded[a]) coded.push(a);
          isCoded[a] = 1;
        }
    }

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
    const ctxFor = foreignJobs(sgbd, opts);
    const runJob = async (jobSgbd, job, argText, o) => {
      const ctx = await ctxFor(
        { ...baseCtx, allowWrites: !!(o && o.allowWrites) },
        jobSgbd
      );
      const arg =
        o && o.binary
          ? { bin: Array.from(argText, (c) => c.charCodeAt(0)) }
          : argText;
      return runJobOverBus(ctx, jobSgbd || sgbd, job, arg);
    };
    const common = {
      sgbd,
      cabd,
      dataOrg,
      confirmed: true,
      runJob,
      fa: opts.fa || undefined,
    };

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
    //
    // With the description's unused-bit rows known (factoryCoverage), it is
    // the factory's set exactly: a coding-block word goes when a function or
    // an unused-bit row owns a bit of it. The rest of a coding block -- on the
    // cluster its coding date, VIN, ZCS key and odometer bytes, which their
    // own jobs write -- is not touched.
    const cover = factoryCoverage(cabd, want.length);
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
    const zcsGroup = zcsJob
      ? (cabd.groups || []).find((x) => String(x.name).toUpperCase() === 'ZCS')
      : null;
    const owned = (a) =>
      !cover ||
      cover.mask[a] !== 0 ||
      (zcsGroup && a >= zcsGroup.start && a < zcsGroup.start + zcsGroup.length);
    const region = [];
    for (let w = 0; w + wb <= want.length; w += wb) {
      let whole = true;
      let any = false;
      for (let k = 0; k < wb; k++) {
        if (!inRegion[w + k]) whole = false;
        if (owned(w + k)) any = true;
      }
      if (whole && any) for (let k = 0; k < wb; k++) region.push(w + k);
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
    // and the unused bits as the factory tool codes them: the description's
    // fill value (they belong to no function, so no edit is in them)
    if (cover)
      for (const a of region)
        if (cover.fillMask[a])
          image[a] = (image[a] & ~cover.fillMask[a]) | cover.fillBits[a];
    stage('Writing: do not disconnect or switch the ignition off');
    const result = await root.runCodingDispatch(opts.dispatch, {
      ...common,
      mode: 'write',
      jobname: opts.jobname || DEFAULT_JOBNAME,
      netto: image,
      changed: region,
      held: before,
      systemData: systemDataFor(opts),
      sget: opts.sget,
    });
    const sent = new Set(result.written);
    const unsent = edits.filter((a) => !sent.has(a));
    if (!result.ok) {
      const tried = result.writesTried | 0;
      throw errVerify(
        `the coding run failed (${result.info || `error ${result.err}, return ${result.ret}`})` +
          (tried
            ? `; ${tried} write telegram${tried === 1 ? '' : 's'} had gone out` +
              ` (${sent.size} bytes confirmed), so the module may hold part of ` +
              'the new coding: read it again, then write the saved backup ' +
              'back or run the coding again'
            : '; nothing was written')
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
    runCodingReadJob,
    blockOnTheWire,
    codingBlocks,
    flattenBlocked,
    flatRule,
    factoryCoverage,
    BLOCK_STRIDE,
  };

  if (typeof root !== 'undefined') {
    root.codingWriteStrategy = codingWriteStrategy;
    root.writeCoding = writeCoding;
    root.readCoding = readCoding;
    root.runCodingReadJob = runCodingReadJob;
    root.codingWrite = api;
    root.codingFlatRule = flatRule;
    root.codingBlockOnTheWire = blockOnTheWire;
    root.codingBlocks = codingBlocks;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
