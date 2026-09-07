/**
 * @file EDIABAS's session model and the job runner: run a job the way the
 * server's /run endpoint did, but in the VM, over the live bus.
 */
/* exported sessionFor, switchSession, forgetSessions, newTally, driveJobOverBus, webRunJob */

/**
 * How many telegram exchanges a single job may need before it is declared
 * stuck (one VM replay pass per exchange).
 */
const MAX_JOB_PASSES = 64;

/**
 * The VM's send callback: synchronous, returns a memoised answer or throws
 * the needAnswer sentinel to unwind the pass.
 * @callback SendFn
 * @param {ArrayLike<number>} out - The request without its checksum.
 * @param {CommParams} comm - Its wire parameters.
 * @returns {number[]} The answer bytes.
 */

/**
 * One SGBD's session state.
 * @typedef {object} Session
 * @property {Map<string, any>} shared - shmset data carried across jobs.
 * @property {boolean} inited - Has INITIALISIERUNG run.
 * @property {CommParams|null} comm - The wire parameters xsetpar left behind.
 */

/**
 * What a VM job produced once every telegram it needed had been exchanged.
 * @typedef {object} DriveResult
 * @property {object[]} sets - The result sets.
 * @property {Best2Vm} vm - The VM instance that completed the job.
 */

/**
 * How the wire answered a job's telegrams, kept OUTSIDE the drive so the
 * counts survive a pass that throws (the resolver reports them beside the
 * error).
 * @typedef {object} AnswerTally
 * @property {number} empty - Telegrams the wire could not answer.
 * @property {number} real - Telegrams that came back with bytes.
 */

/**
 * A fresh, zeroed answer tally.
 * @returns {AnswerTally}
 */
function newTally() {
  return { empty: 0, real: 0 };
}

/**
 * EDIABAS's session model, which a fresh-VM-per-job does not have:
 * INITIALISIERUNG runs ONCE when an SGBD is loaded, shared data (shmset)
 * persists across that SGBD's jobs, and ENDE runs when it is unloaded.
 * MS450 hands its AIF block from init to later jobs exactly this way.
 * The session also carries COMM: xsetpar lives in INITIALISIERUNG, so a
 * later job's fresh VM never executes it -- without the carry, every
 * ordinary job transmitted with default BMW-FAST framing and every K-line
 * module got 115200 8N1 line noise.
 * Keyed by SGBD; switching ECUs ends the previous session.
 * @type {Map<string, Session>}
 */
const sessions = new Map();

/**
 * The session for an SGBD, created empty on first sight.
 * @param {string} sgbd - The SGBD name (any case).
 * @returns {Session}
 */
function sessionFor(sgbd) {
  const key = String(sgbd).toLowerCase();
  let s = sessions.get(key);
  if (!s) {
    s = { shared: new Map(), inited: false, comm: null };
    sessions.set(key, s);
  }
  return s;
}

/**
 * Run ENDE for a session being dropped. Fire-and-forget: the answer does
 * not matter, but the ECU is entitled to the notification.
 * @param {string} sgbd - The SGBD whose session ends.
 */
async function endSession(sgbd) {
  const key = String(sgbd).toLowerCase();
  const s = sessions.get(key);
  if (!s || !s.inited) {
    sessions.delete(key);
    return;
  }
  sessions.delete(key);
  try {
    const code = await webFetchJson(`data/job-code/${key}.json`);
    if (code && code.jobs && code.jobs.ENDE !== undefined) {
      await webRunJob(sgbd, 'ENDE', null, {
        noInit: true,
        shared: s.shared,
        comm: s.comm,
      });
    }
  } catch {
    /* the session is over either way */
  }
}

/**
 * The currently-loaded SGBD (lowercased). EDIABAS holds one at a time;
 * switching ends the old session so its ENDE runs while the bus is still up.
 * @type {string|null}
 */
let loadedSgbd = null;

/**
 * Make `sgbd` the loaded SGBD, ending the previous one's session first.
 *
 * NOTE this must NOT run between an SGBD's session init and its jobs: those
 * are the same session. Clearing there let the job's BMW-FAST concept
 * become the session concept, the port reopened at 115200, and the wake
 * performed at 10400 was undone before the telegram went out.
 * @param {string} sgbd - The SGBD about to run.
 */
async function switchSession(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (loadedSgbd === key) return;
  const prev = loadedSgbd;
  loadedSgbd = key;
  // Only a REAL switch clears the wire state. The early return above already
  // skipped the no-op case, so reaching here means a different ECU -- which
  // may live on a different wire, so the remembered concept and the wake
  // that went with it do not carry over.
  if (prev) {
    await endSession(prev);
    webBus.sessionConcept = null;
    webBus.inited = null;
  }
}

/**
 * Forget every session and the loaded SGBD, without running ENDE. Called
 * when the cable goes away: the wire is already gone.
 */
function forgetSessions() {
  sessions.clear();
  loadedSgbd = null;
}

/**
 * The sentinel a send() throws to unwind a VM pass whose answer is not yet
 * known. bestvm's INITIALISIERUNG handling rethrows it instead of swallowing
 * it -- an init whose telegrams were never fetched used to "succeed" having
 * sent nothing.
 * @returns {Error & {needAnswer: true}}
 */
function needAnswerError() {
  const need = new Error('__need_answer__');
  need.needAnswer = true;
  return need;
}

/**
 * Did this wire error mean the telegram got nothing usable -- silence or a
 * bad echo -- as opposed to a lying wire?
 *
 * A SILENT ECU IS AN ANSWER OF ZERO BYTES, NOT A DEAD JOB. The VM sets
 * f.zero from the answer's length and the bytecode branches on it. Tracing
 * EDIABAS proved the SGBD relies on exactly that: ms450ds0's INITIALISIERUNG
 * holds two telegrams as constants, sends "82 12 F1 1A 80", gets IFH-0009 --
 * and carries on to send "B8 12 F1 02 1A 80", which the ECU answers. Throwing
 * here killed the job on the first telegram, so the second was never tried
 * and a perfectly reachable DME looked silent.
 *
 * IFH-0009 (silence) and IFH-0003 (the echo did not come back cleanly) both
 * mean THIS TELEGRAM GOT NOTHING USABLE. The SGBD's fallback branches on the
 * answer's length via `slen`, so both must arrive as an empty answer or the
 * bytecode never reaches its second telegram. A half-duplex K line genuinely
 * produces both: an ECU that ignores a framing answers with silence, and the
 * stray leftover byte that follows makes the NEXT echo compare fail.
 * Treating only the timeout as "no answer" left the app dying on whichever
 * of the two happened to occur first.
 *
 * Only those two are swallowed. A damaged frame, a checksum failure or a
 * bus-level fault still throws: those mean the wire is lying, and continuing
 * would decode garbage.
 * @param {any} err - What webBus.exchange threw.
 * @returns {boolean} True for IFH-0009 / IFH-0003.
 */
function isNoUsableAnswer(err) {
  return !!(err && (err.ifh === 'IFH-0009' || err.ifh === 'IFH-0003'));
}

/**
 * Drive one VM job over the bus in passes.
 *
 * send() is synchronous but the wire is async, so the VM runs in passes:
 * each pass runs until a send whose answer we lack, which we fetch, memoise,
 * then retry from the top (the VM is deterministic, so replay is safe). The
 * memo is keyed by request bytes AND occurrence index: a job that sends the
 * same telegram twice (clear-then-verify) must get the second answer, not a
 * replay. One clock serves all passes -- a time that ticked between passes
 * would change the request bytes, miss the memo, and re-transmit an
 * already-sent telegram.
 *
 * REMEMBER THAT THE WIRE FAILED. The empty answer is what the SGBD's
 * fallback needs, but a job whose telegrams ALL came back empty has not read
 * the car -- it has read nothing. The tally lets the caller say so: without
 * it the fault screen rendered "No stored faults / clean fault memory" for a
 * DME holding nine real faults, which is the worst thing a diagnostic tool
 * can say.
 * @param {(send: SendFn, now: Date) => Best2Vm} buildVm - Builds a fresh VM
 *   for one pass around the given send callback and clock.
 * @param {string} job - The job name.
 * @param {string} arg - The job's argument string.
 * @param {AnswerTally} tally - Updated in place as telegrams are answered.
 * @returns {Promise<DriveResult>} The result sets and the finished VM.
 * @throws {Error} A VM error from the job itself, a wire error that is not
 *   silence, or 'did not settle' after MAX_JOB_PASSES exchanges.
 */
async function driveJobOverBus(buildVm, job, arg, tally) {
  const answers = new Map();
  const jobNow = new Date();
  for (let attempt = 0; attempt < MAX_JOB_PASSES; attempt++) {
    let missing = null;
    let sendSeq = 0;
    const send = (out, comm) => {
      const key = `${sendSeq++}:${Array.from(out)}`;
      if (answers.has(key)) return answers.get(key);
      // Carry the wire parameters along with the request: the exchange
      // below needs the concept to frame, checksum and pace it. Unwind this
      // pass: nothing sensible to return, and continuing would decode
      // garbage.
      missing = { key, out: Array.from(out), comm };
      throw needAnswerError();
    };
    const vm = buildVm(send, jobNow);
    try {
      const sets = vm.run(job, arg);
      return { sets, vm };
    } catch (e) {
      // Only the needAnswer sentinel may turn into a wire exchange. A real
      // VM error thrown in the same pass must surface as itself, not be
      // recycled into "did not settle".
      if (!missing || !e.needAnswer) throw e;
      let answer;
      try {
        answer = await webBus.exchange(missing.out, missing.comm);
      } catch (err) {
        if (!isNoUsableAnswer(err)) throw err;
        answer = [];
        tally.empty++;
      }
      if (answer && answer.length) tally.real++;
      answers.set(missing.key, answer);
    }
  }
  throw new Error(
    `job did not settle after ${MAX_JOB_PASSES} telegram exchanges`
  );
}

/**
 * Run a job on an SGBD over the live bus, inside its EDIABAS session.
 * @param {string} sgbd - The SGBD name.
 * @param {string} job - The job name.
 * @param {string|null} arg - The argument string (null for none).
 * @param {{shared?: Map<string, any>, comm?: CommParams|null, noInit?: boolean}} [opts] -
 *   A detached session to run in (endSession's ENDE uses this).
 * @returns {Promise<{sets: object[]}>} The job's result sets.
 * @throws {Error} When no job code is shipped, when the ECU answered nothing
 *   at all (IFH-0009), or whatever the job or wire threw.
 */
async function webRunJob(sgbd, job, arg, opts = {}) {
  const code = await webFetchJson(`data/job-code/${sgbd.toLowerCase()}.json`);
  if (!code) throw new Error(`no job code shipped for ${sgbd}`);
  const sharedTables = await loadSharedTables();
  const tables =
    (await webFetchJson(`data/sgbd-tables/${sgbd.toLowerCase()}.json`)) || {};
  const session = opts.shared
    ? { shared: opts.shared, inited: true, comm: opts.comm || null }
    : sessionFor(sgbd);
  const argText = arg == null ? '' : String(arg);
  const tally = newTally();

  const { sets, vm } = await driveJobOverBus(
    (send, now) =>
      new Best2Vm(code, {
        tables,
        extTables: sharedTables,
        args: argText,
        // Writes permitted -- see the note on Best2Vm.allowWrites. This is
        // the main job runner, so it is what lets an actuator test reach the
        // wire.
        allowWrites: true,
        shared: session.shared,
        inited: session.inited,
        comm: session.comm,
        now,
        send,
      }),
    job,
    argText,
    tally
  );
  session.inited = true;
  session.comm = vm.comm || session.comm;
  // A job that transmitted and was answered by NOTHING did not read the
  // car. Saying so is the only honest outcome: the alternative is a
  // "clean fault memory" that is really a dead wire.
  if (tally.empty && !tally.real) {
    throw ifhError(
      'IFH-0009',
      'the ECU did not answer any telegram in this job'
    );
  }
  return { sets };
}
