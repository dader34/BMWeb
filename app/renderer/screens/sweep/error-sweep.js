/**
 * @file Whole-vehicle sweep, F4 -- Full Module Error Scan (INPA FSQUICK):
 * read every module's fault memory, detail the faulty ones, offer to clear
 * them and to print the report.
 *
 * Fifth piece of screens/sweep/.
 */

/**
 * The error sweep's running tallies.
 * @typedef {object} ErrorSweepCounts
 * @property {number} read - Modules whose fault memory was read.
 * @property {number} absent - Addresses that stayed silent or failed.
 * @property {number} withFaults - Modules with stored faults.
 * @property {number} dupes - Fault lists hidden as echoes of another row.
 * @property {number} unbuilt - Modules identified but not in this build.
 */

/**
 * What the report is told about the sweep.
 * @typedef {object} SweepStats
 * @property {number} scanned - Modules read.
 * @property {number} skipped - Modules absent or not in build.
 * @property {number} withFaults - Modules with faults.
 * @property {number} [present] - Faults present now (single-module export).
 */

/**
 * The progress headline during the sweep.
 * @param {ErrorSweepCounts} n - The tallies.
 * @returns {string} "3 read · 1 absent · 2 with faults".
 */
const errorProgressText = (n) =>
  `${n.read} read · ${n.absent} absent · ${n.withFaults} with faults`;

/**
 * Read one resolved module's fault memory into its row.
 *
 * A module with no FS_LESEN keeps no fault memory at all -- CARB's whole
 * job list is INFO/INITIALISIERUNG/SET_PARAMETER/START_BUS_COMMUNICATION/
 * DIAGNOSTICEND, because it is the emissions interface, not a control
 * unit. There is no fault question to ask it, so it is not a row in a
 * FAULT scan: drop it rather than print a status that means "not asked".
 * Checked BEFORE the read so it costs no wire traffic.
 * @param {SweepTarget} t - The target.
 * @param {SweepResolution} r - Its resolution (state ok).
 * @param {HTMLElement} row - Its row.
 * @param {ErrorSweepCounts} n - The tallies, updated in place.
 * @param {Map<string, string>} seen - Fault signature -> first ECU label.
 * @param {FaultyModule[]} faulty - Modules with faults, appended to.
 * @returns {Promise<boolean>} False when the row was dropped (no fault
 *   memory to ask about); true once the row reflects the read.
 */
async function errorSweepRead(t, r, row, n, seen, faulty) {
  const status = row.querySelector('.quick-status');
  if (!(await jobNamesFor(r.sgbd)).includes('FS_LESEN')) {
    row.remove();
    return false;
  }
  let codes;
  try {
    codes = await readFaults(r.sgbd);
  } catch (e) {
    // The job exists but the wire failed: that is a dead address, and it
    // must never be confused with a module that answered clean.
    n.absent++;
    setRowNoResponse(row, 'no response');
    return true;
  }
  n.read++;
  if (!codes.length) {
    row.classList.add('clean');
    status.textContent = 'OK';
    return true;
  }
  const sig = _faultSig(codes);
  if (seen.has(sig)) {
    // the identical fault list from two addresses is one module answering
    // twice (a gateway echoing, a satellite mirrored onto its master)
    n.dupes++;
    setRowNoResponse(row, `echo of ${seen.get(sig)}`);
    return true;
  }
  const label = await nameFor(t, r);
  seen.set(sig, label);
  n.withFaults++;
  row.classList.add('has-faults');
  status.innerHTML = faultCountHtml(codes.length);
  faulty.push({
    ecu: { ...(r.ecu || {}), sgbd: r.sgbd, label },
    row,
    codes,
  });
  return true;
}

/**
 * Deep pass: each faulty module gets a detailed read (FS_LESEN_DETAIL),
 * shown inline under its row.
 * @param {FaultyModule[]} faulty - The modules with faults.
 * @param {HTMLElement} headEl - The headline to report progress in.
 * @param {ErrorSweepCounts} n - The tallies.
 * @param {() => boolean} alive - This run's liveness test.
 * @returns {Promise<boolean>} False when the user left mid-pass.
 */
async function errorSweepDetail(faulty, headEl, n, alive) {
  await loadFaultDb(); // names resolve synchronously in the detail rows
  let done = 0;
  for (const f of faulty) {
    if (!alive()) return false; // user left mid deep-read; stop
    f.row.classList.add('scanning-detail');
    f.row.querySelector('.quick-status').innerHTML =
      `${faultCountHtml(f.codes.length)} · reading…`;
    try {
      await fillFaultDetail(f.ecu.sgbd, f.codes);
    } catch {
      /* keep base codes */
    }
    f.row.classList.remove('scanning-detail');
    setRowFaultStatus(f);
    appendFaultDetailRows(f.row, f.codes, f.ecu.sgbd);
    done++;
    headEl.textContent = `${errorProgressText(n)} · details ${done}/${faulty.length}`;
  }
  return true;
}

/**
 * Wire the Clear all button: clears every faulty module in turn, after one
 * confirmation.
 * @param {HTMLElement} btn - The button.
 * @param {FaultyModule[]} faulty - The modules with faults.
 * @returns {void}
 */
function wireClearAll(btn, faulty) {
  btn.disabled = false;
  btn.onclick = async () => {
    const ok = await confirmDialog({
      title: 'Clear all fault memory?',
      body: `Erase stored faults on ${faulty.length} module${faulty.length === 1 ? '' : 's'}. This cannot be undone.`,
      confirmLabel: 'Clear all',
      danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Clearing…';
    for (const f of faulty) await clearModule(f);
    btn.textContent = 'Cleared';
  };
}

/**
 * Wire the report button. Native saves a PDF via the Electron bridge; the
 * web build prints a clean sheet via the shared helper, and registers it as
 * the screen's print action too: Cmd/Ctrl+P routes through the current
 * action list (core/print.js), and the mobile functions sheet reads the
 * same list -- without this, both print the live page instead.
 * @param {HTMLElement|null} btn - The report button.
 * @param {string} id - Chassis id.
 * @param {FaultyModule[]} faulty - The modules with faults.
 * @param {SweepStats} stats - The sweep's tallies for the report.
 * @param {() => void} leave - Back action.
 * @returns {void}
 */
function wireFaultReport(btn, id, faulty, stats, leave) {
  if (!btn) return;
  if (window.bmacw && window.bmacw.savePdf) {
    btn.disabled = false;
    btn.onclick = () => exportFaultPdf(id, faulty, stats);
    return;
  }
  btn.textContent = 'Print report';
  btn.disabled = false;
  btn.onclick = () => printFaultReport(id, faulty, stats);
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: leave,
    },
    {
      key: 'p',
      keyLabel: 'P',
      label: 'Print report',
      kind: 'print',
      fn: () => printFaultReport(id, faulty, stats),
    },
  ]);
}

/**
 * Full Module Error Scan: confirm, then read every module on the car.
 * @param {string|null|undefined} chassisId - Chassis id (E46 when absent).
 * @returns {Promise<void>} Resolves when the sweep finishes or is left.
 */
async function quickErrorSweep(chassisId) {
  const id = chassisId || 'E46';
  const title = 'Full Module Error Scan';
  if (await sweepNeedsCable(id, title, () => showSections(id))) return;
  // scanning every module holds the bus; confirm before touching the K-line
  const ok = await confirmDialog({
    title: 'Scan all modules?',
    body:
      `Reads the fault memory of every module on the ${esc(dispChassis(id))}. ` +
      'Each module takes a few seconds to answer, so a full scan can take ' +
      'several minutes. You can leave the scan at any time with Esc.',
    confirmLabel: 'Start scan',
  });
  if (!ok) return;
  const { out, alive, leave } = sweepScreen(
    id,
    title,
    `Scanning every module on the ${dispChassis(id)} for stored faults…`
  );
  loadFaultDb(); // warm the name db before detail rows render
  const ch = await tryApi(`/api/chassis/${id}`, null, out);
  if (!ch) return;
  const targets = sweepPlan(ch);
  const resolve = variantResolver();

  const { rows, headEl } = sweepBar(
    out,
    `${targets.length} modules · scanning…`,
    `<button class="quick-pdf" id="quick-pdf" disabled>Export PDF</button>
        <button class="quick-clear-all" id="quick-clear-all" disabled>Clear all</button>`
  );
  /** @type {ErrorSweepCounts} */
  const n = { read: 0, absent: 0, withFaults: 0, dupes: 0, unbuilt: 0 };
  const seen = new Map(); // fault-signature -> first ECU label
  const faulty = []; // modules with faults, for the deep pass
  // ONE PHYSICAL MODULE, ONE ROW. Several groups can reach the same ECU --
  // E46 lists both D_0012 (address 12) and D_MOTOR (broadcast FF), and on an
  // MS45 car BOTH identify ms450ds0. Reading it twice showed the same faults
  // under two names, one of them an engine the car does not have.
  const readSgbds = new Map(); // resolved sgbd -> the row that claimed it
  const progress = () => {
    headEl.textContent = errorProgressText(n);
  };

  for (const t of targets) {
    if (!alive()) return; // user left the sweep; stop reading the bus
    const row = addSweepRow(rows, targetLabel(t));
    const r = await resolveTargetSafe(t, resolve);

    if (r.state === 'absent') {
      n.absent++;
      setRowNoResponse(row, absentLabel(t));
      progress();
      continue;
    }
    if (r.state === 'unbuilt') {
      // The car answered and named itself; this build just has no job code
      // for that variant. Say exactly that -- reading a sibling instead is
      // what produces confident wrong answers.
      n.unbuilt++;
      setRowNoResponse(row, `${r.via} not in build`);
      progress();
      continue;
    }

    const key = String(r.sgbd).toLowerCase();
    if (readSgbds.has(key)) {
      // another group already reached this exact module
      setRowLabel(row, r.sgbd);
      setRowNoResponse(row, `same module as ${readSgbds.get(key)}`);
      progress();
      continue;
    }
    readSgbds.set(key, await nameFor(t, r));

    // resolution succeeded: name the row for what actually answered -- the
    // matching config row, else the address's one shared name, else the
    // identified SGBD; never a differently-named sibling (see nameFor).
    setRowLabel(row, await nameFor(t, r), r.strict ? null : 'direct read');
    if (await errorSweepRead(t, r, row, n, seen, faulty)) progress();
  }

  if (faulty.length && !(await errorSweepDetail(faulty, headEl, n, alive)))
    return;

  if (faulty.length)
    wireClearAll(out.querySelector('#quick-clear-all'), faulty);

  // Fault report, available even with no faults.
  const stats = {
    scanned: n.read,
    skipped: n.absent + n.unbuilt,
    withFaults: n.withFaults,
  };
  wireFaultReport(out.querySelector('#quick-pdf'), id, faulty, stats, leave);

  const extra = [
    n.dupes ? `${n.dupes} echo${n.dupes === 1 ? '' : 'es'} hidden` : null,
    n.unbuilt ? `${n.unbuilt} not in build` : null,
  ].filter(Boolean);
  headEl.textContent =
    `Done · ${n.read} read, ${n.absent} absent · ` +
    `${n.withFaults} with stored faults${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
  sbLeft.textContent = `full module error scan · ${n.withFaults} faulty`;
}
