/**
 * @file Whole-vehicle sweep, F2 -- Identification (INPA IDQUICK): name every
 * module on the car and its build, read-only end to end.
 *
 * Sixth piece of screens/sweep/.
 */

/**
 * One identified module, for the printable report.
 * @typedef {object} IdentFound
 * @property {string} label - The name printed for the module.
 * @property {string} section - The config section it lives in.
 * @property {string} sgbd - The SGBD it resolved to.
 * @property {string} variant - The variant name the car gave.
 * @property {string|null} build - Its software/build number, if read.
 */

/**
 * Identification fields, in the order INPA prints them. Every one of these
 * is a real EDIABAS result name; the first present wins.
 */
const IDENT_FIELDS = [
  'SG_VARIANTE',
  'VARIANTE',
  'AIF_SG_VARIANTE',
  'ID_SG_VARIANTE',
  'AIF_TYP',
  'ID_TYP',
  'HARDWARE_NUMMER',
  'ID_HW_NR',
];
/** Build/version fields shown after the variant name, same rule. */
const IDENT_BUILD = [
  'AIF_SW_NR',
  'ID_SW_NR',
  'SOFTWARE_NUMMER',
  'AIF_DATEN_NR',
  'ID_DATEN_NR',
  'AIF_ZB_NR',
  'ID_ZB_NR',
  'BMW_NUMMER',
];

/** Characters of the status cell an identification is cut to. */
const IDENT_STATUS_MAX = 40;

/**
 * The first present value among preferred result names, across the data
 * sets.
 * @param {object[]|null|undefined} sets - The job's result sets.
 * @param {string[]} keys - Result names in preference order.
 * @returns {string|null} The trimmed value, or null.
 */
const identValue = (sets, keys) => {
  for (const s of dataSets(sets)) {
    for (const k of keys) {
      const v = s[k];
      if (v != null && String(v).trim() && !String(v).startsWith('_'))
        return String(v).trim();
    }
  }
  return null;
};

/**
 * An identification job by name. IDENT is the usual name and 84% of the
 * shipped corpus has it, but 16% do not -- the F-series modules use
 * IDENT_FUNKTIONAL, and others name it differently again. Asking the module
 * what it declares is the formula; assuming IDENT is what made a present
 * F01 module report "no response".
 *
 * INITIALISIERUNG is deliberately NOT a candidate even though every one of
 * those modules declares it: bestvm's classifier reads it as a WRITE (it
 * starts a session and can change module state), and an identification sweep
 * must stay read-only end to end.
 */
const IDENT_JOB_RE = /^(IDENT|IDENTIFIKATION)(_|$)/i;
/**
 * The write verbs an ident-shaped name may carry. The corpus really does
 * ship IDENT_SCHREIBEN, IDENT_VIN_SCHREIBEN, IDENT_PRODUCTION_DATA_SCHREIBEN
 * and friends -- jobs that WRITE the module's identity. bestvm's isWriteJob()
 * clears all of them, and correctly so for its own contract: a read token
 * anywhere wins, and IDENT is a strong read token (that rule is what stops
 * FS_LESEN_DETAIL being guarded). It is the wrong gate HERE, where the name
 * is already known to start with IDENT, so the write verb has to be excluded
 * explicitly. Getting this backwards would let an identification sweep write
 * identity data to every module on the car.
 */
const IDENT_WRITE_RE = /(SCHREIBEN|_SETZEN|_WRITE|PROGRAMMIER)/i;
/**
 * Is a job name an identification READ?
 * @param {string} n - The job name.
 * @returns {boolean} True for an ident-shaped name with no write verb that
 *   the classifier also clears.
 */
const isIdentReadJob = (n) =>
  IDENT_JOB_RE.test(n) && !IDENT_WRITE_RE.test(n) && !isWriteJob(n);

/**
 * The ident job this SGBD actually declares: exact IDENT first, then the
 * narrowest prefixed variant -- shortest name wins, so IDENT_FUNKTIONAL is
 * preferred over IDENT_READ_CURRENT_UIF_TABLE.
 * @param {string} sgbd - The SGBD.
 * @returns {Promise<string|null>} The job name, or null when none is a read.
 */
async function identJobFor(sgbd) {
  const names = await jobNamesFor(sgbd);
  const cands = names.filter(isIdentReadJob);
  if (!cands.length) return null;
  return cands.includes('IDENT')
    ? 'IDENT'
    : cands
        .slice()
        .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/**
 * Identification sweep: resolve every target, then read its variant and
 * build.
 * @param {string|null|undefined} chassisId - Chassis id (E46 when absent).
 * @returns {Promise<void>} Resolves when the sweep finishes or is left.
 */
async function quickIdentSweep(chassisId) {
  const id = chassisId || 'E46';
  const title = 'Identification';
  if (await sweepNeedsCable(id, title, () => showSections(id))) return;
  const { out, alive, leave } = sweepScreen(
    id,
    title,
    `Identifying every module on the ${dispChassis(id)}…`
  );
  const ch = await tryApi(`/api/chassis/${id}`, null, out);
  if (!ch) return;
  const targets = sweepPlan(ch);
  const resolve = variantResolver();

  const { rows, headEl } = sweepBar(
    out,
    `${targets.length} modules · identifying…`,
    `<button class="quick-pdf" id="quick-print" disabled>Print</button>`
  );
  let present = 0,
    absent = 0,
    unbuilt = 0,
    dupes = 0;
  /** @type {IdentFound[]} */
  const found = []; // for the printable report
  const seenSgbds = new Map(); // resolved sgbd -> row that claimed it (see error sweep)
  const progress = () => {
    headEl.textContent = `${present} present · ${absent} absent`;
  };

  for (const t of targets) {
    if (!alive()) return; // user left the sweep; stop reading the bus
    const row = addSweepRow(rows, targetLabel(t));
    const status = row.querySelector('.quick-status');
    const r = await resolveTargetSafe(t, resolve);

    if (r.state === 'absent') {
      absent++;
      setRowNoResponse(row, absentLabel(t));
      progress();
      continue;
    }
    if (r.state === 'unbuilt') {
      // Present and named, just not readable here. That IS an identification
      // -- the group told us the variant -- so count it as present and show
      // the name the car gave.
      unbuilt++;
      present++;
      row.classList.add('clean');
      setRowLabel(row, r.via);
      status.textContent = `${r.via} · not in build`;
      found.push({
        label: r.via,
        section: t.section,
        sgbd: r.via,
        variant: r.via,
        build: null,
      });
      progress();
      continue;
    }

    const key = String(r.sgbd).toLowerCase();
    if (seenSgbds.has(key)) {
      dupes++;
      setRowLabel(row, r.sgbd);
      setRowNoResponse(row, `same module as ${seenSgbds.get(key)}`);
      progress();
      continue;
    }
    seenSgbds.set(key, await nameFor(t, r));
    setRowLabel(row, await nameFor(t, r), r.strict ? null : 'direct read');

    // A strict resolution has ALREADY identified this module -- the group ran
    // IDENTIFIKATION and named the variant. Running a second ident job over
    // the wire to learn the same thing is pure traffic, so the job below only
    // fills in the build/version detail, and its absence is not a failure.
    let variant = r.strict ? r.sgbd.toUpperCase() : null;
    let build = null;
    try {
      const job = await identJobFor(r.sgbd);
      if (job) {
        const d = await api(`/api/ecu/${r.sgbd}/run/${job}`, {
          method: 'POST',
        });
        variant = identValue(d.sets, IDENT_FIELDS) || variant;
        build = identValue(d.sets, IDENT_BUILD);
      } else if (!r.strict) {
        // Ungrouped and no ident job to run: nothing here has spoken to the
        // car, so claiming it is present would be a guess. Report the gap.
        setRowNoResponse(row, 'no ident job');
        progress();
        continue;
      }
    } catch (e) {
      if (!r.strict) {
        // Direct read, and the wire refused: the module is not answering.
        absent++;
        setRowNoResponse(row, isMissingJob(e) ? 'no ident job' : 'no response');
        progress();
        continue;
      }
      // Strict path: the group already proved presence. A failed detail read
      // downgrades the row's detail, never its presence.
    }

    present++;
    row.classList.add('clean');
    status.textContent = [variant || r.sgbd, build]
      .filter(Boolean)
      .join(' · ')
      .slice(0, IDENT_STATUS_MAX);
    found.push({
      label: await nameFor(t, r),
      section: t.section,
      sgbd: r.sgbd,
      variant: variant || r.sgbd,
      build,
    });
    progress();
  }

  const printBtn = out.querySelector('#quick-print');
  if (printBtn) {
    printBtn.disabled = false;
    printBtn.onclick = () => printIdentReport(id, found, { present, absent });
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
        fn: () => printIdentReport(id, found, { present, absent }),
      },
    ]);
  }

  headEl.textContent =
    `Done · ${present} present, ${absent} absent` +
    (unbuilt ? ` · ${unbuilt} not in build` : '') +
    (dupes ? ` · ${dupes} duplicate address${dupes === 1 ? '' : 'es'}` : '');
  sbLeft.textContent = `identification · ${present} present`;
}
