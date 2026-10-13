/**
 * @file The ONE explicitly-coding write path.
 *
 * Everything else in this shim runs the VM read-mindedly (webRunJob, the
 * probe with allowWrites:false). A coding write is different: it is the app's
 * most safety-critical action, so it gets its own gate, its own
 * confirmation, and prove-by-re-read.
 *
 * The write permission itself lives in coding-write.js, NOT here: that
 * module is the only place that constructs the VM writeable, and it does so
 * only after this function has checked opts.confirmed. Keeping the
 * write-enabling VM construction out of the shim is deliberate -- webRunJob
 * and every ordinary job run stay provably read-only (test_write_gate.js
 * reads the shim and asserts what it builds).
 *
 * It runs over the SAME bus lock as reads (withBusLock), so a coding sequence
 * cannot interleave with the topbar state poll or any job on the wire.
 */
/* exported webWriteCoding, webReadCoding */

/**
 * A module's coding script, by the file it ships in.
 * @param {string} key - the file key under data/coding-dispatch.
 * @returns {Promise<object|null>} the script, or null when it is not one.
 */
async function webCodingScript(key) {
  const d = await webFetchJson(
    `data/coding-dispatch/${String(key).toLowerCase()}.json`
  );
  return d && d.coding && d.procs ? d : null;
}

/**
 * Read a module's whole coding image through its own coding script
 * (coding-write.js readCoding). A read: the run's write gate is shut, so it
 * needs no confirmation.
 * @param {string} sgbd - The CODING SGBD the car's selection row names.
 * @param {{dispatchKey: string, cabd: object}} opts - which script file, and
 *   the module's coding description.
 * @returns {Promise<{netto: number[], read: number[], size: number}>} the
 *   image and which of its addresses were read.
 * @throws {Error} When no cable is connected, or the SGBD or its script is
 *   not shipped, or the read fails.
 */
async function webReadCoding(sgbd, opts = {}) {
  if (typeof window.readCoding !== 'function')
    throw new Error('coding-write.js is not loaded');
  if (!webBus.connected) throw new Error('no cable connected');
  const key = String(sgbd).toLowerCase();
  const code = await webFetchJson(`data/job-code/${key}.json`);
  if (!code) throw new Error(`no job code shipped for ${sgbd}`);
  const tables = (await webFetchJson(`data/sgbd-tables/${key}.json`)) || {};
  const dispatch = await webCodingScript(opts.dispatchKey || key);
  if (!dispatch) throw new Error(`no coding script shipped for ${sgbd}`);
  await switchSession(sgbd);
  const session = sessionFor(sgbd);
  return withBusLock(() =>
    window.readCoding(sgbd, {
      code,
      tables,
      exchange: (out, comm) => webBusRawExchange(out, comm),
      session,
      dispatch,
      dataOrg: dispatch.dataOrg || null,
      cabd: opts.cabd,
    })
  );
}

/**
 * Write coding data to a module through coding-write.js's confirmed path.
 * @param {string} sgbd - The SGBD to code.
 * @param {string} nettoHex - The netto coding bytes as hex.
 * @param {{confirmed?: boolean, jobname?: string, dispatchKey?: string, base?: string, cabd?: object,
 *   vin?: string, systemData?: Record<string, string>}} [opts] - `confirmed` must be true
 *   (the UI's explicit confirmation); `jobname` picks the dispatcher job when
 *   a derived dispatcher is shipped (default SG_CODIEREN). For that path:
 *   `base` is the image the edits were made on, `cabd` the module's coding
 *   description (its functions, named blocks and coding indexes), and
 *   `vin` / `systemData` what the script may ask about the car.
 * @returns {Promise<any>} Whatever writeCoding resolves with.
 * @throws {Error} When coding-write.js is absent, the write is unconfirmed,
 *   no cable is connected, or no job code is shipped for the SGBD.
 */
async function webWriteCoding(sgbd, nettoHex, opts = {}) {
  if (typeof window.writeCoding !== 'function') {
    throw new Error('coding-write.js is not loaded');
  }
  if (!opts.confirmed) {
    throw new Error(
      'coding write requires an explicit confirmation ' +
        '(opts.confirmed) from the UI before it can transmit'
    );
  }
  if (!webBus.connected) throw new Error('no cable connected');

  const key = String(sgbd).toLowerCase();
  // The SGBD program, its tables, and its job list -- the same sources the
  // read path uses, so the strategy sees exactly the jobs this module exposes.
  const code = await webFetchJson(`data/job-code/${key}.json`);
  if (!code) throw new Error(`no job code shipped for ${sgbd}`);
  const tables = (await webFetchJson(`data/sgbd-tables/${key}.json`)) || {};

  // DISPATCHER PROGRAM (optional). When a derived A_<cabd> coding dispatcher
  // is shipped for this module, writeCoding runs BMW's own dispatcher instead
  // of the hand-sequenced strategy (see coding-write.js writeViaDispatch). The
  // exec ships next to the module's job-code as <sgbd>.ipoexec.json with a
  // "coding":true marker; opts.dataOrg carries the CABD word width. Absent, the
  // strategy path runs unchanged, so this is additive and safe.
  // opts.dispatchKey names the file when the script is not the one keyed by
  // this SGBD: the car's selection row names both, and they differ (the late
  // E46 cluster is KOMBI46R, coded by A_KMB46 or A_AKMB46).
  const dispatch = await webCodingScript(opts.dispatchKey || key);
  const dispatchOk = !!dispatch;

  // One SGBD is loaded at a time, exactly like a read: end the previous
  // session (its ENDE) before this one initialises, then run the whole write
  // sequence under the bus lock so nothing else touches the wire mid-coding.
  await switchSession(sgbd);
  const session = sessionFor(sgbd);
  return withBusLock(() =>
    window.writeCoding(sgbd, nettoHex, {
      confirmed: true,
      code,
      tables,
      jobs: code.jobs,
      // the bus-locked wire, called from inside the lock we already hold --
      // webBus.exchange re-enters withBusLock, which the promise chain
      // serialises, so pass the RAW exchange to avoid queuing behind ourselves
      exchange: (out, comm) => webBusRawExchange(out, comm),
      session,
      // the dispatcher program + its word width, only when shipped for this CABD
      dispatch: dispatchOk ? dispatch : null,
      dataOrg: dispatchOk ? dispatch.dataOrg || null : null,
      jobname: dispatchOk ? opts.jobname || 'SG_CODIEREN' : undefined,
      // what the dispatcher path writes from; writeCoding refuses that path
      // without the coding description rather than guess a selection
      cabd: dispatchOk ? opts.cabd || null : undefined,
      base: dispatchOk ? opts.base || null : undefined,
      systemData: dispatchOk ? opts.systemData || undefined : undefined,
      vin: dispatchOk ? opts.vin || undefined : undefined,
      onStage: opts.onStage,
    })
  );
}
