/**
 * @file WebKFP: programming a module the way WinKFP does, by running BMW's
 * own programming script for it (the PABD) on the CDH host. Published as the
 * `kfp` global.
 *
 * WinKFP's own part, recovered from winkfpt.exe (projects/winkfp-re), is
 * small, and this is it:
 *
 *   1. SG_STATUS_LESEN, told whether the program is new (HWNR_IS_NEW): the
 *      script answers PROG_TYP and PROG_ORDER, and they say which files go
 *      and in what order (coapiKfGetProgOrderBsuD2):
 *        PROG_TYP 1 -> data;  2 -> program;
 *        3 with PROG_ORDER 2 -> program, then data;  3 with 1 -> data, then program.
 *   2. SG_AIF_LESEN: where the programming record goes and whether there is
 *      room for one (none free: WinKFP refuses).
 *   3. For each file (coapiKfProgSgD2): PROG_MODE (2 program, 1 data),
 *      PROG_HWNR from the .0PA's name, the fast-baud switch, the record's
 *      fields and PROG_WITH_AIF, then SG_PROGRAMMIEREN with the file, then
 *      SG_AIF_SCHREIBEN. A script that writes the record during programming
 *      (the MS45's) has a dummy SG_AIF_SCHREIBEN; one that does not (the
 *      GS20's) ignores PROG_WITH_AIF. The record goes with the LAST file of
 *      the order only (winkfpt.exe FUN_004169a0: the flag it hands
 *      coapiKfProgSgD2 is "nothing follows in the queue", re-evaluated as the
 *      queue moves on); expert mode's after-data / after-program options can
 *      ask for one per file. On a GS20 a record after the program alone is
 *      refused (B0): until the matching data is in, the boot block's ID check
 *      leaves it out of the state its record area is writable in.
 *
 * Everything else -- the session, the unlock, the erase, the block writes,
 * the checks, the reset -- is the script's.
 *
 * app/renderer/core/*.js style: browser global, no imports; dual-exported for
 * require() so a headless test can drive it.
 */

/**
 * A module WebKFP programs.
 * @typedef {Object} KfpModule
 * @property {string} id - 'gs20', 'ms45'; for a family from families.json,
 *   its folder in lower case ('mds43').
 * @property {string} label - For the screen.
 * @property {string} folder - Its SP-Daten folder (GD20, MDS451).
 * @property {string} table - Its ZB table in that folder.
 * @property {string} pabd - Its programming script (data/kfp/<pabd>.json).
 * @property {string} sgbd - Its programming SGBD.
 * @property {string} address - Its diagnosis address, as WinKFP shows it.
 * @property {string} protocol - Its diagnosis protocol, as WinKFP shows it.
 */

/**
 * What the record (AIF) says about this programming.
 * @typedef {Object} KfpAif
 * @property {string} vin - 17 characters, or the last 7.
 * @property {string} zb - The ZB number programmed.
 * @property {string} [km] - The odometer.
 * @property {string} [dealer] - Dealer number, 6 digits.
 * @property {string} [tester] - Tester serial, 5 characters.
 * @property {string} [approval] - Type approval number.
 * @property {string} [progRef] - Programming reference.
 * @property {string} [sw] - The software number (the ZB table's, 7 digits).
 * @property {string} [changeIndex] - What follows it in the table ("DA").
 *   WinKFP writes the two as the record's software number and change
 *   index; the SGBD wants them 9 characters together.
 */

(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const { KfpHost } = node ? require('./host.js') : root.KfpHostApi;
  const { Interp, scriptCalls } = node
    ? require('../coding/dispatch.js')
    : root.codingDispatch;

  /**
   * The calls a script makes that this host cannot serve. A programming run
   * that reached one would stop there -- possibly with the module erased and
   * half written -- so a script with any is refused before it starts.
   * @param {object} exec - The script.
   * @returns {string[]} Their names, empty when every call is served.
   */
  function unservedCalls(exec) {
    const has = (name) => {
      for (let p = KfpHost.prototype; p; p = Object.getPrototypeOf(p))
        if (
          Object.prototype.hasOwnProperty.call(p, name) &&
          typeof p[name] === 'function'
        )
          return true;
      return false;
    };
    return scriptCalls(exec).filter(
      (n) => !LIBRARY.has(n) && n !== 'exit' && !has(n)
    );
  }
  /** The language's own library, which the interpreter serves itself. */
  const LIBRARY = new Set(['strcat', 'strlen', 'midstr', 'inttostring']);

  /** @type {Record<string, KfpModule>} */
  const MODULES = {
    gs20: {
      id: 'gs20',
      label: 'GS20 transmission (A5S390R)',
      folder: 'GD20',
      table: 'GD20.DAT',
      pabd: '10gd20',
      sgbd: '10gd20',
      address: '32',
      protocol: 'DS2',
    },
    ms45: {
      id: 'ms45',
      label: 'MS45 engine (DME)',
      folder: 'MDS451',
      table: 'MDS451.DAT',
      pabd: '12mds451',
      sgbd: '10mds45',
      address: '12',
      protocol: 'KWP2000*',
    },
  };

  /**
   * A programming run takes some ten thousand blocks, each a few hundred
   * script steps; the coding host's budget is for a handful of records.
   */
  const STEP_BUDGET = 50000000;

  /**
   * Run one of the script's jobs (its cabimain JOBNAME).
   * @param {object} exec - The script, as data/kfp ships it.
   * @param {string} jobname - SG_IDENT_LESEN, SG_PROGRAMMIEREN, ...
   * @param {object} opts - KfpHost's options (sgbd, runJob, runs, params...).
   * @returns {Promise<{ok: boolean, err: number, ret: number, info: string,
   *   errors: KfpError[], params: Record<string, string|number>,
   *   unsupported: boolean}>}
   */
  async function runJob(exec, jobname, opts) {
    const unserved = unservedCalls(exec);
    if (unserved.length) {
      const info =
        `this module's programming script calls ${unserved.join(', ')}, ` +
        'which WebKFP cannot serve; it is refused before anything is sent';
      return {
        ok: false,
        err: -1,
        ret: -1,
        info,
        errors: [{ code: -1, file: 'WebKFP', proc: 'WebKFP', line: 0, info }],
        params: {},
        unsupported: true,
      };
    }
    // WinKFP's coapiKfSetGlobalPabdSgbdEcuAddr: with a module address, the
    // script's SET_ECU_ADDRESS runs with ECU_ADDRESS set (and only then).
    // The generic flash SGBDs (07flash, 11flash...) have no address of their
    // own; this job hands it to them (FLASH_PARAMETER_SETZEN, kept in the
    // SGBD's shared data), and without it they address 0x00. Run before
    // every job, not once: the shared data goes when the bus session moves
    // to another SGBD. A script without the job is fine, as in WinKFP.
    if (
      opts.address &&
      jobname !== 'SET_ECU_ADDRESS' &&
      scriptJobs(exec).has('SET_ECU_ADDRESS')
    ) {
      const set = await runScriptJob(exec, 'SET_ECU_ADDRESS', {
        ...opts,
        params: { ECU_ADDRESS: String(opts.address) },
      });
      if (!set.ok) return set;
    }
    return runScriptJob(exec, jobname, opts);
  }

  /**
   * The jobs a script's dispatcher (cabimain) names.
   * @param {object} exec - The script.
   * @returns {Set<string>} Its JOBNAMEs.
   */
  function scriptJobs(exec) {
    return new Set(
      ((exec.procs && exec.procs.cabimain) || [])
        .map((t) => t && t.v)
        .filter((v) => typeof v === 'string')
    );
  }

  /**
   * runJob without the address step.
   * @param {object} exec - The script.
   * @param {string} jobname - Its JOBNAME.
   * @param {object} opts - KfpHost's options.
   * @returns {Promise<object>} As runJob.
   */
  async function runScriptJob(exec, jobname, opts) {
    const host = new KfpHost(opts);
    host.CDHSetCabdPar('JOBNAME', jobname);
    const interp = new Interp(exec, host);
    interp.budget = STEP_BUDGET;
    let unsupported = false;
    try {
      await interp.run('__inpa_startup__');
    } catch (e) {
      if (!e || !e.dispatchAbort) throw e;
      unsupported = !!e.unsupported;
    }
    // WinKFP judges a script by its return value alone (coapiRunCabd reads
    // what CDHSetReturnVal last set, winkfpt.exe FUN_0045a3a0): an error the
    // script recorded and then recovered from -- 12MDS451's first
    // DIAGNOSE_MODE, refused until it authenticates -- stays in the list
    // WinKFP shows but does not fail the job, as SG_PROGRAMMIEREN ends with
    // CDHSetReturnVal(0).
    return {
      ok: host.ret === 0 && !unsupported,
      err: host.err,
      ret: host.ret,
      info: host.errInfo || '',
      errors: host.errors,
      params: host.params(),
      unsupported,
    };
  }

  /**
   * Which files go, in order, from the script's PROG_TYP / PROG_ORDER.
   * @param {number} typ - PROG_TYP.
   * @param {number} order - PROG_ORDER.
   * @returns {Array<'program'|'data'>|null} null when the pair means nothing.
   */
  function progOrder(typ, order) {
    if (typ === 1) return ['data'];
    if (typ === 2) return ['program'];
    if (typ === 3 && order === 2) return ['program', 'data'];
    if (typ === 3 && order === 1) return ['data', 'program'];
    return null;
  }

  /**
   * dd mm yy, as WinKFP writes the record's date.
   * @param {Date} d - The day.
   * @returns {string}
   */
  function aifDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getDate()) + p(d.getMonth() + 1) + p(d.getFullYear() % 100);
  }

  /**
   * The key to an MS45's seed, from BMWeb's own MS45 signing
   * (core/ms45/ms45.js): the 68 bytes from offset 21 of the message its
   * AUTHENTISIERUNG_START sends.
   * @param {{type: string, userId: Uint8Array, seed: Uint8Array,
   *   serialAnswer: Uint8Array}} req - The script's request.
   * @returns {Uint8Array|null}
   */
  function ms45Key(req) {
    const checks = root.ms45Checksums;
    const serialOf = root.flasherSerialFromReply;
    if (!checks || !serialOf || !/^Asym/i.test(req.type)) return null;
    const serial = serialOf(req.serialAnswer);
    if (serial.length !== 4 || !req.seed.length) return null;
    const message = checks.securityAccessMessage(req.userId, serial, req.seed);
    return message.subarray(21, 21 + message[13]);
  }

  /**
   * Program a module from a ZB number's files, the way WinKFP's comfort
   * mode does.
   * @param {Object} opts
   * @param {boolean} opts.confirmed - The operator's confirmation (required).
   * @param {KfpModule} opts.module - The module.
   * @param {object} opts.exec - Its programming script.
   * @param {Function} opts.runJob - (sgbd, job, argText, {binary}) -> sets.
   * @param {{program?: {name: string, file: object}, data?: {name: string, file: object}}} opts.files -
   *   The ZB number's files, parsed (kfpDaten.parseFile).
   * @param {boolean} opts.programIsNew - Whether the program differs from
   *   the module's (HWNR_IS_NEW): the script then asks for both files.
   * @param {KfpAif|null} opts.aif - The record to write, null for none.
   * @param {boolean} [opts.fast] - SCHNELLE_BAUDRATE (WinKFP's default is off).
   * @param {boolean} [opts.testChecksum=true] - TEST_CHECKSUMME.
   * @param {boolean} [opts.forceProgram] - PROGRAMM_ERZWINGEN: the program
   *   goes as well, even where the module would take the data alone.
   * @param {'program'|'data'} [opts.only] - Expert mode's Prog. Program /
   *   Prog. Data: that one file goes, without SG_STATUS_LESEN asking the
   *   module what it needs.
   * @param {boolean} [opts.aifAfterData=true] - AIF_SCHREIBEN_NACH_DATEN.
   * @param {boolean} [opts.aifAfterProgram=true] - AIF_SCHREIBEN_NACH_PROGRAMM.
   * @param {boolean} [opts.aifLastOnly] - Comfort mode: the record is written
   *   once, after the last file programmed (winkfpt.exe FUN_004169a0 passes
   *   the UIF flag only when nothing follows in its queue). An MS45 refuses
   *   it after the program alone (ERROR_CALIBRATION_DATASET_NR): it has no
   *   calibration until the data is in.
   * @param {Function} [opts.authenticate] - The key maker (MS45 by default).
   * @param {(text: string) => void} [opts.onStage] - Each step.
   * @param {(e: object) => void} [opts.onJob] - Each job.
   * @param {(sent: number, total: number, file: string) => void} [opts.onProgress]
   * @param {(ms: number) => Promise<void>} [opts.sleep] - CDHDelay's clock.
   * @param {Date} [opts.today] - The record's date.
   * @returns {Promise<{ok: boolean, step: string, info: string,
   *   errors: KfpError[], written: string[]}>} `step` names where it
   *   stopped, `errors` what the script recorded on the way there, and
   *   `written` the files programmed.
   */
  async function program(opts) {
    if (!opts.confirmed)
      throw new Error('programming needs the operator to confirm it first');
    const mod = opts.module;
    const stage = opts.onStage || (() => {});
    const base = {
      sgbd: mod.sgbd,
      address: mod.address,
      runJob: opts.runJob,
      onJob: opts.onJob,
      sleep: opts.sleep,
      // Asymmetric-auth flash SGBDs (NG_AUTHENTISIERUNG, scheme T_SMA) ask
      // for BMW's generation signing key -- the same one across that era, so
      // the MS45 signer serves them all (10mds45, 11flash, ...). ms45Key
      // self-gates on req.type being "Asym", so passing it is safe for a
      // symmetric/simple SGBD too: it returns null and the module's own
      // seed/key path runs.
      authenticate: opts.authenticate || ms45Key,
    };
    const written = [];
    const fail = (step, r) => ({
      ok: false,
      step,
      info: r.info || `error ${r.err}, return ${r.ret}`,
      errors: r.errors || [],
      written,
    });

    let order;
    if (opts.only) {
      order = [opts.only];
    } else {
      stage('Reading what the module needs');
      const status = await runJob(opts.exec, 'SG_STATUS_LESEN', {
        ...base,
        params: { HWNR_IS_NEW: opts.programIsNew || opts.forceProgram ? 1 : 0 },
      });
      if (!status.ok) return fail('SG_STATUS_LESEN', status);
      order = progOrder(
        Number(status.params.PROG_TYP),
        Number(status.params.PROG_ORDER)
      );
      // WinKFP's forced program: a data-only answer becomes program, then data
      if (opts.forceProgram && order && order.join() === 'data')
        order = ['program', 'data'];
      if (!order)
        return fail('SG_STATUS_LESEN', {
          info: `the module answered PROG_TYP ${status.params.PROG_TYP}, PROG_ORDER ${status.params.PROG_ORDER}`,
        });
    }
    const missing = order.filter((k) => !opts.files[k]);
    if (missing.length)
      return fail('SG_STATUS_LESEN', {
        info: `the module needs the ${missing.join(' and ')} file, and this ZB number has none`,
      });

    // Where the next programming record goes. Asked again before every
    // record after the first: each one written takes the slot, and a second
    // record sent to the same address is refused (MS43: status 02).
    const readSlot = async () => {
      stage('Reading the programming record');
      const aif = await runJob(opts.exec, 'SG_AIF_LESEN', {
        ...base,
        params: { AIF_NUMMER: '0' },
      });
      if (!aif.ok) return { fail: fail('SG_AIF_LESEN', aif) };
      if (Number(aif.params.AIF_ANZ_FREI) <= 0)
        return {
          fail: fail('SG_AIF_LESEN', {
            info: 'the module has no free programming record left',
          }),
        };
      return {
        address: String(
          ((Number(aif.params.AIF_ADRESSE_HIGH) & 0xffff) << 16) |
            (Number(aif.params.AIF_ADRESSE_LOW) & 0xffff)
        ),
        // the record's size, which the script's AifLesen keeps in the CABD
        // parameters; WinKFP's store outlives the job, so SG_PROGRAMMIEREN
        // finds it there and writes the long record (64 or 51: with the
        // calibration dataset, SW and approval numbers). Without it the MS45
        // gets VIN;date;ZB and refuses (7F .. 84, calibration dataset)
        size: aif.params.AIF_GROESSE,
      };
    };
    let aifAddress = '';
    let aifSize;
    let records = 0;
    if (opts.aif) {
      const slot = await readSlot();
      if (slot.fail) return slot.fail;
      aifAddress = slot.address;
      aifSize = slot.size;
    }

    for (const [at, kind] of order.entries()) {
      const f = opts.files[kind];
      const withAif =
        !!opts.aif &&
        (opts.aifLastOnly
          ? at === order.length - 1
          : kind === 'program'
            ? opts.aifAfterProgram !== false
            : opts.aifAfterData !== false);
      const params = {
        PROG_MODE: kind === 'program' ? 2 : 1,
        SCHNELLE_BAUDRATE: opts.fast ? 'ON' : 'OFF',
        TEST_CHECKSUMME: opts.testChecksum === false ? 'OFF' : 'ON',
        PROG_WITH_AIF: withAif ? 1 : 0,
      };
      if (kind === 'program') params.PROG_HWNR = f.name.slice(0, 7);
      if (withAif && records > 0) {
        const slot = await readSlot();
        if (slot.fail) return slot.fail;
        aifAddress = slot.address;
        aifSize = slot.size;
      }
      if (withAif) {
        const a = opts.aif;
        // WinKFP fills the tester serial, dealer and program reference from
        // its own configuration (SY_SERNO, SY_KDNR, record symbol 11), and an
        // MS45 checks each one's shape (ERROR_REPAIR_SHOP_NR for a dealer
        // that is not six digits). Empty, they take what BMWeb's own flasher
        // writes on an MS45, and the program file's own 12-character
        // reference (7561382A.0PA: 0044570LO02S).
        const programRef = String(
          (opts.files.program &&
            opts.files.program.file &&
            opts.files.program.file.reference) ||
            ''
        );
        Object.assign(params, {
          AIF_FG_NR: a.vin,
          AIF_DATUM: aifDate(opts.today || new Date()),
          AIF_AENDERUNGS_INDEX: a.changeIndex || '',
          AIF_SW_NR: a.sw || '',
          AIF_BEHOERDEN_NR: a.approval || '',
          AIF_ZB_NR: a.zb,
          AIF_SERIEN_NR: a.tester || 'BMWEB',
          AIF_HAENDLER_NR: a.dealer || '000000',
          AIF_KM: a.km || '0',
          AIF_PROG_NR:
            a.progRef || (/^[0-9A-Z]{12}$/.test(programRef) ? programRef : ''),
          AIF_ADRESSE: aifAddress,
        });
        if (aifSize !== undefined && aifSize !== '')
          params.AIF_GROESSE = Number(aifSize);
      }
      stage(`Programming the ${kind} (${f.name})`);
      const runs = root.kfpDaten
        ? root.kfpDaten.runs(f.file)
        : require('./daten.js').runs(f.file);
      const r = await runJob(opts.exec, 'SG_PROGRAMMIEREN', {
        ...base,
        params,
        runs,
        onProgress: (sent, total) =>
          opts.onProgress && opts.onProgress(sent, total, f.name),
      });
      if (!r.ok) return fail(`SG_PROGRAMMIEREN ${f.name}`, r);
      written.push(f.name);
      if (withAif) {
        stage('Writing the programming record');
        const w = await runJob(opts.exec, 'SG_AIF_SCHREIBEN', {
          ...base,
          params,
        });
        if (!w.ok) return fail('SG_AIF_SCHREIBEN', w);
        records += 1;
      }
    }
    stage('Done');
    return { ok: true, step: '', info: '', errors: [], written };
  }

  /**
   * A module from data/kfp/families.json (tools/export/kfp_pabd.py), which
   * lists every family KFCONF10.DA2 names and the SP-Daten carry.
   * @param {{folder: string, table: string, pabd: string, sgbd: string,
   *   address: string, protocol: string}} fam - Its entry.
   * @returns {KfpModule}
   */
  function moduleOf(fam) {
    return {
      id: fam.folder.toLowerCase(),
      label: fam.folder,
      folder: fam.folder,
      table: fam.table,
      pabd: fam.pabd,
      sgbd: fam.sgbd,
      address: fam.address,
      protocol: fam.protocol || '',
    };
  }

  const api = {
    MODULES,
    moduleOf,
    runJob,
    program,
    progOrder,
    aifDate,
    ms45Key,
    unservedCalls,
  };
  if (typeof root !== 'undefined') root.kfp = api;
  if (node) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
