// Coding WRITE dispatcher: run the per-ECU-family write job SEQUENCE on the
// BEST2 VM, over the live bus.
//
// We cannot run A_*.ipo (the coding dispatcher .ipo that INPA/ISTA execute
// host-side); we replicate its job sequence by driving the module's OWN SGBD
// jobs in the right order over our VM. The sequence DIFFERS per ECU family,
// keyed off which jobs the SGBD exposes:
//
//   codierdaten   AUTHENTISIERUNG -> NORMALER_DATENVERKEHR "NEIN"
//                 -> CODIERDATEN_SCHREIBEN <netto-hex>
//                 -> NORMALER_DATENVERKEHR "JA" -> SG_RESET
//                 (E46 body/others; netto as ASCII-hex string arg)
//   codierung     CODIERUNG_SCHREIBEN <netto-hex>   (IHKA46 and kin)
//   cfg-chunked   C_S_AUFTRAG <binbuf> loop -> C_CHECKSUM <binbuf>
//                 (ZKE5/GM5; needs BINARY job args)
//
// SAFETY. The VM itself permits write jobs by default (bestvm.js, owner's
// decision 2026-08-19: the classifier cannot tell an actuator drive from an
// EEPROM write, and blocking one blocked both), so the write protection for
// CODING lives HERE, not in the VM: writeCoding() refuses unless
// opts.confirmed is set by the UI's review dialog, the read steps in this
// module explicitly pass allowWrites:false, and every write is proved by
// re-read (below) before it is reported as a success.
//
// PROVE-BY-RE-READ. After the write sequence reports JOB_STATUS OKAY, we
// re-read the coding block and assert it now equals what we asked to write.
// A mismatch throws ERROR_VERIFY -- the strongest form of the app's
// prove-by-re-read hardware-safety contract, applied to the write path.
//
// app/renderer/core/*.js style: browser global, no imports. Dual-exported
// for require() so tools/verify/test_coding_write.js can drive it headless.

(function (root) {
  'use strict';

  // The VM class. In the browser it is window.Best2Vm (bestvm.js loaded as a
  // <script> before this one); under require() the test injects it.
  function getVm(opts) {
    if (opts && opts.Best2Vm) return opts.Best2Vm;
    if (typeof root.Best2Vm !== 'undefined') return root.Best2Vm;
    if (typeof require !== 'undefined') return require('./bestvm.js').Best2Vm;
    throw new Error('coding-write: Best2Vm not available');
  }

  // ---- netto <-> hex/bytes -------------------------------------------------

  // Accept netto as a hex string ("A1B2...") or a byte array; normalise both.
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

  function toHex(bytes) {
    return Array.from(bytes, (b) => (b & 0xff).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

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
  function bytesToArgString(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b & 0xff);
    return s;
  }

  // ---- job list detection --------------------------------------------------

  // Normalise a jobs list to an uppercase Set. Accepts an array of names, an
  // object keyed by name (the shape of code.jobs), or a Set.
  function jobSet(jobs) {
    const s = new Set();
    if (!jobs) return s;
    const add = (n) => {
      if (n) s.add(String(n).toUpperCase());
    };
    if (jobs instanceof Set || Array.isArray(jobs)) {
      for (const n of jobs) add(n);
    } else if (typeof jobs === 'object') {
      for (const n of Object.keys(jobs)) add(n);
    }
    return s;
  }

  // Pick the write strategy from which jobs the SGBD exposes. Order matters:
  // a module that has BOTH a chunked cfg path and a plain CODIERDATEN one is
  // written the cfg way (that is the family's real dispatcher). Returns the
  // strategy name or null when the SGBD exposes no write path we know.
  function codingWriteStrategy(sgbd, jobs) {
    const j = jobSet(jobs);
    if (j.has('C_S_AUFTRAG')) return 'cfg-chunked';
    if (j.has('CODIERDATEN_SCHREIBEN')) return 'codierdaten';
    if (j.has('CODIERUNG_SCHREIBEN')) return 'codierung';
    return null;
  }

  // Which job reads the current netto back, per strategy. cfg-chunked and
  // codierdaten both read via CODIERDATEN_LESEN when present; codierung reads
  // via CODIERUNG_LESEN. Returns null if the read job is absent (we then skip
  // the before-read but STILL prove by re-read after the write, comparing to
  // what we asked to write).
  function readJobFor(strategy, jobs) {
    const j = jobSet(jobs);
    if (strategy === 'codierung') {
      return j.has('CODIERUNG_LESEN') ? 'CODIERUNG_LESEN' : null;
    }
    return j.has('CODIERDATEN_LESEN')
      ? 'CODIERDATEN_LESEN'
      : j.has('CODIERUNG_LESEN')
        ? 'CODIERUNG_LESEN'
        : null;
  }

  // The ordered write steps for a strategy. Each step is {job, arg} where arg
  // is a string (hex or literal) or {bin: [...bytes]} for a binary job arg.
  // <netto-hex> is substituted per-call. Steps whose job the SGBD lacks are
  // dropped (SG_RESET / NORMALER_DATENVERKEHR are optional on many modules).
  function writeSteps(strategy, nettoBytes, jobs) {
    const j = jobSet(jobs);
    const hex = toHex(nettoBytes);
    let steps;
    if (strategy === 'codierdaten') {
      steps = [
        { job: 'AUTHENTISIERUNG', arg: '' },
        { job: 'NORMALER_DATENVERKEHR', arg: 'NEIN' },
        { job: 'CODIERDATEN_SCHREIBEN', arg: hex, required: true },
        { job: 'NORMALER_DATENVERKEHR', arg: 'JA' },
        { job: 'SG_RESET', arg: '' },
      ];
    } else if (strategy === 'codierung') {
      steps = [{ job: 'CODIERUNG_SCHREIBEN', arg: hex, required: true }];
    } else if (strategy === 'cfg-chunked') {
      // The SGBD's C_S_AUFTRAG takes the whole netto as a binary buffer and
      // writes it into the coding region itself (it walks its own slot table
      // internally, exactly as CDHGetApiJobData/CDHapiJobData feed it). We
      // hand it the whole blob once; C_CHECKSUM then validates the region.
      steps = [
        {
          job: 'C_S_AUFTRAG',
          arg: { bin: nettoBytes.slice() },
          required: true,
        },
        { job: 'C_CHECKSUM', arg: { bin: nettoBytes.slice() } },
      ];
    } else {
      return null;
    }
    return steps.filter(
      (s) => s.required || j.has(String(s.job).toUpperCase())
    );
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

    for (let attempt = 0; attempt < 128; attempt++) {
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

  // JOB_STATUS across the returned sets. EDIABAS publishes it as OKAY on
  // success; anything else (ERROR_ECU_*, Codierfehler, empty) is a failure.
  function jobStatusOf(sets) {
    for (let i = (sets || []).length - 1; i >= 0; i--) {
      const st = sets[i] && sets[i].JOB_STATUS;
      if (st != null && st !== '') return String(st);
    }
    return null;
  }

  // Read the current netto via the strategy's read job. Returns a byte array,
  // or null when the SGBD exposes no read job. The netto is published either
  // as a hex string or as dash/space-separated hex in a result field; we
  // search the last set for the first field that decodes to bytes.
  async function readNetto(ctx, sgbd, readJob) {
    if (!readJob) return null;
    const sets = await runJobOverBus(
      { ...ctx, allowWrites: false },
      sgbd,
      readJob,
      ''
    );
    const st = jobStatusOf(sets);
    if (st && st !== 'OKAY') {
      throw errVerify(`re-read job ${readJob} returned JOB_STATUS ${st}`);
    }
    return extractNetto(sets);
  }

  // Pull the coding bytes out of a read job's result sets. Prefers an explicit
  // CODIERDATEN / CODIERDATENSATZ / CODIERUNG field, else the first field
  // whose value looks like packed or dash-separated hex.
  function extractNetto(sets) {
    const PREF = [
      'CODIERDATEN',
      'CODIERDATENSATZ',
      'CODIERUNG',
      'CODIERSTRING',
      'NETTODATEN',
      'DATEN',
    ];
    for (const set of sets || []) {
      if (!set || typeof set !== 'object') continue;
      for (const key of PREF) {
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

  // "A1B2C3" or "A1-B2-C3" or "A1 B2 C3" -> bytes; null if it is not hex.
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

  function errVerify(msg) {
    const e = new Error(`ERROR_VERIFY: ${msg}`);
    e.code = 'ERROR_VERIFY';
    return e;
  }

  // ---- the entry point -----------------------------------------------------

  // writeCoding(sgbd, nettoBytes, opts) -> {ok, before, after, sequence}
  //
  //   sgbd        SGBD name (for messages / job lookup)
  //   nettoBytes  the FULL netto to write, as a hex string or byte array
  //   opts.confirmed   REQUIRED true -- the UI's actuate confirmation
  //   opts.code / opts.tables / opts.jobs   the SGBD program + tables + job list
  //   opts.exchange(out, comm) -> answer bytes   the (bus-locked) wire
  //   opts.session     { shared, inited, comm } carried across the sequence
  //   opts.Best2Vm     VM class (test injection; defaults to window.Best2Vm)
  //   opts.now         fixed clock (determinism for the replay memo)
  //
  // Sequence: read current netto (before) -> run the strategy's write steps,
  // asserting JOB_STATUS OKAY at each -> PROVE-BY-RE-READ: read it back and
  // assert it equals nettoBytes, else throw ERROR_VERIFY.
  async function writeCoding(sgbd, nettoBytes, opts = {}) {
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
    // itself (coding-dispatch.js). We still prove the write by re-read below,
    // using whichever read job the SGBD exposes. Falls through to the strategy
    // path when no dispatcher is shipped for this module.
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
    const sequence = [];

    // --- before: current netto (a READ; allowWrites stays false)
    const before = await readNetto(baseCtx, sgbd, readJob);
    if (readJob)
      sequence.push([readJob, jobStatusOf([{ JOB_STATUS: 'OKAY' }])]);

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
      sequence.push([step.job, st == null ? 'OKAY' : st]);
      // A step that reports an explicit non-OKAY status aborts the sequence:
      // do not keep pushing writes at a module that rejected the last one.
      if (st != null && st !== 'OKAY') {
        throw errVerify(`step ${step.job} returned JOB_STATUS ${st}`);
      }
    }

    // --- PROVE BY RE-READ (a READ; allowWrites false again)
    const after = await readNetto(baseCtx, sgbd, readJob);
    if (readJob) sequence.push([readJob, 'OKAY']);
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
      jobname: opts.jobname || 'SG_CODIEREN',
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

  // ---- pre-write backup ----------------------------------------------------
  //
  // The bytes an ECU held before we wrote are the ONLY way back from a bad
  // write, and they exist for exactly one moment: after the read, before the
  // transmit. Persist them there or they are gone. Kept deliberately dumb --
  // append-only, newest first, capped -- because the one job it has is to
  // still be there after a write goes wrong.
  const BACKUP_KEY = 'bmweb.coding.backups';
  const BACKUP_MAX = 50;

  function backupStore() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) {
      /* private mode / disabled: fall through */
    }
    return null;
  }

  // saveCodingBackup(sgbd, nettoHex, meta) -> the stored record (or null when
  // there is no storage). NEVER throws: a backup failure must not abort a
  // write the user already confirmed, so it returns null and the caller
  // decides. The caller is what surfaces "unbacked" to the user.
  function saveCodingBackup(sgbd, nettoHex, meta = {}) {
    const store = backupStore();
    if (!store) return null;
    const rec = {
      sgbd: String(sgbd),
      netto: String(nettoHex || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toUpperCase(),
      at: (meta.now instanceof Date ? meta.now : new Date()).toISOString(),
      chassis: meta.chassis || null,
      ci: meta.ci == null ? null : meta.ci,
      note: meta.note || null,
    };
    if (!rec.netto) return null;
    try {
      const prev = JSON.parse(store.getItem(BACKUP_KEY) || '[]');
      const list = Array.isArray(prev) ? prev : [];
      list.unshift(rec);
      store.setItem(BACKUP_KEY, JSON.stringify(list.slice(0, BACKUP_MAX)));
      return rec;
    } catch (e) {
      return null; // quota, serialisation, whatever: never block the write
    }
  }

  // Every stored backup, newest first.
  function listCodingBackups(sgbd) {
    const store = backupStore();
    if (!store) return [];
    try {
      const list = JSON.parse(store.getItem(BACKUP_KEY) || '[]');
      if (!Array.isArray(list)) return [];
      return sgbd
        ? list.filter((r) => r && String(r.sgbd) === String(sgbd))
        : list;
    } catch (e) {
      return [];
    }
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
    root.saveCodingBackup = saveCodingBackup;
    root.listCodingBackups = listCodingBackups;
    root.codingWrite = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
