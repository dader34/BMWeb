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
/* exported webWriteCoding */

/**
 * Write coding data to a module through coding-write.js's confirmed path.
 * @param {string} sgbd - The SGBD to code.
 * @param {string} nettoHex - The netto coding bytes as hex.
 * @param {{confirmed?: boolean, jobname?: string}} [opts] - `confirmed` must
 *   be true (the UI's explicit confirmation); `jobname` picks the dispatcher
 *   job when a derived dispatcher is shipped (default SG_CODIEREN).
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
  const dispatch = await webFetchJson(`data/coding-dispatch/${key}.json`);
  const dispatchOk = dispatch && dispatch.coding && dispatch.procs;

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
    })
  );
}
