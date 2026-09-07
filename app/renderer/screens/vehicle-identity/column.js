/**
 * @file Vehicle identity: reading ONE identity master completely -- its
 * record (FA or ZCS), its VIN and its stored odometer -- into the column the
 * screen shows for it.
 *
 * Fourth piece of screens/vehicle-identity/. ONE COLUMN PER IDENTITY MASTER,
 * read separately and never merged. The car stores its record twice (E46:
 * cluster and EWS), and the whole reason the dialog exists is to compare the
 * copies -- a swapped module shows up as two columns that disagree, which a
 * first-answer-wins page can never show.
 */

/**
 * One entry of the source strip: which ECU answered, and how.
 * @typedef {object} ViSource
 * @property {string} sg - The family name shown (EWS, KMB) or the SGBD.
 * @property {boolean} ok - Whether the read succeeded.
 * @property {string} what - What was read, or why it failed.
 */

/**
 * A job picked for a car-info role, and the result to read off it.
 * @typedef {object} ViInfoPick
 * @property {string} job - The job to run.
 * @property {string} result - The result that carries the role.
 */

/**
 * One master's column: what it answered, before decoding.
 * @typedef {object} ViColumn
 * @property {ViIdentityModule} m - The master.
 * @property {ViReadKeys|null} keys - Its coding keys, on a ZCS answer.
 * @property {FaOrder|null} fa - Its parsed order, on an FA answer.
 * @property {string|null} faRaw - The order text as decoded.
 * @property {string|null} vin - Its VIN (full or production number).
 * @property {number|null} km - Its stored odometer, km.
 * @property {string} [title] - Column title (family name), set by the screen.
 * @property {ViEtkDecode|null} [etk] - Parts-catalogue decode of the VIN.
 * @property {ViColumnInfo} [info] - What the column says about the car.
 * @property {string[]} [codes] - Its SA codes.
 */

// Roles for the car-info results, matched against DECLARED result names --
// same contract as VI_KEY_ROLE: the regex names the ROLE, never one spelling.
// (kombi46 declares AIF_FG_NR, ews declares FG_NR; both are the VIN.)
/** Result-name role of the VIN. */
const VI_VIN_ROLE = /^(AIF_)?FG_?NR$|^FGSTNR/i;
/**
 * The STORED odometer a cluster declares outright: the Gesamtwegstrecken-
 * zaehler out of its Anwenderinfofeld (AIF_GWSZ_LESEN on kombi39, kombi46,
 * ike). Exact name, so GWSZ_MINUS_OFFSET's derived value never stands in.
 */
const VI_KM_STORED_ROLE = /^STAT_GWSZ_WERT$/i;

/**
 * An odometer past this is a misread, not a mileage: an E46 cluster tops
 * out well under 2M km.
 */
const VI_KM_MAX = 2000000;
/** The all-FF sentinel a blank 3-byte odometer field reads as. */
const VI_KM_BLANK = 0xffffff;

/** Cluster EEPROM read: the odometer sits at word 0x28, four words read. */
const VI_KMB_EEPROM_ARG = '0x28;4';
/** The EEPROM job the cluster declares. */
const VI_KMB_EEPROM_JOB = 'EEPROM_LESEN';

/** The EWS KD block that carries the odometer. */
const VI_EWS_KD_BLOCK = '0';
/** The KD-block job the EWS declares. */
const VI_EWS_KD_JOB = 'KD_DATEN_LESEN';
/** Bytes of KD block 0 needed: the km field is bytes 2..4. */
const VI_EWS_KD_MIN_BYTES = 5;

/**
 * The read job on this ECU declaring a result in `role`. Scanning is archive
 * reads only (each job's result table ships in the .ecu); the wire sees just
 * the one job that wins.
 *
 * Several jobs may declare the role: the E46 light module's service-interval
 * read (SIA_LESEN) returns FG_NR beside a dozen counters, and C_FG_LESEN
 * returns FG_NR alone. The job that EXISTS to answer the question is the one
 * declaring the fewest other results, so that is the one asked -- not the
 * first in declaration order, which is where SIA_LESEN happens to sit.
 * @param {string} sgbd - The SGBD.
 * @param {ViJob[]} jobs - Its declared jobs.
 * @param {RegExp} role - The result-name role wanted.
 * @returns {Promise<ViInfoPick|null>} The narrowest read declaring the
 *   role, or null.
 */
async function viPickInfoJob(sgbd, jobs, role) {
  let best = null;
  for (const j of jobs) {
    if (!viIsRead(j.name)) continue;
    const names = await viJobResults(sgbd, j.name);
    const hit = names.find((n) => role.test(n));
    if (!hit) continue;
    const others = names.filter((n) => n !== hit && n !== 'JOB_STATUS').length;
    if (!best || others < best.others) {
      best = { job: j.name, result: hit, others };
    }
  }
  return best ? { job: best.job, result: best.result } : null;
}

/**
 * The SGFAM family a master belongs to, for the column title and the source
 * strip: EWS, KMB, LSZ -- the terse names NCS Expert's own dialog uses. The
 * bridge is the one that chose the coding SGBD (viSgShortNames), read back:
 * of the families the module's config names could be, the base name (KMB)
 * beats its "A" variant (AKMB, the same module's second coding role), and
 * between equals the family whose CABD is the SGBD that answered wins.
 * Absent is fine -- it is a nicety, and the config label stands in.
 * @param {Object<string, SgfamRow>|null} fam - The chassis family map.
 * @param {ViIdentityModule|null|undefined} m - The master.
 * @returns {string|null} The family short name, or null.
 */
function viFamilyName(fam, m) {
  if (!fam || !m) return null;
  const sg = String(m.sgbd || '').toUpperCase();
  const want = viSgShortNames(m.diagSgbd || m.sgbd, m.code);
  const cands = Object.keys(fam).filter((k) => k === sg || want.includes(k));
  if (!cands.length) return null;
  const cabdIs = (k) =>
    String((fam[k] && fam[k].cabd) || '').toUpperCase() === sg ? 0 : 1;
  cands.sort(
    (a, b) => a.length - b.length || cabdIs(a) - cabdIs(b) || (a < b ? -1 : 1)
  );
  return cands[0];
}

/**
 * Read the master's order into the column, noting the outcome on the strip.
 * @param {ViIdentityModule} m - A master with `fa`.
 * @param {ViColumn} col - The column being filled.
 * @param {ViSource[]} sources - The source strip.
 * @param {string} sg - The name to report under.
 * @returns {Promise<void>} Resolves once the column is updated.
 */
async function viReadOrderInto(m, col, sources, sg) {
  try {
    const values = await viRunValues(m.sgbd, m.faJob.job);
    const text = await viFaText(values, m.faJob.result);
    if (text) {
      col.faRaw = text;
      col.fa = VehicleIdentity.parseFa(text);
      sources.push({ sg, ok: true, what: `order via ${m.faJob.job}` });
    } else {
      sources.push({
        sg,
        ok: false,
        what: `${m.faJob.job}: no order in reply`,
      });
    }
  } catch (e) {
    sources.push({ sg, ok: false, what: 'no answer' });
  }
}

/**
 * Read the master's coding keys into the column, noting the outcome.
 * @param {ViIdentityModule} m - A master with `zcs`.
 * @param {ViColumn} col - The column being filled.
 * @param {ViSource[]} sources - The source strip.
 * @param {string} sg - The name to report under.
 * @returns {Promise<void>} Resolves once the column is updated.
 */
async function viReadKeysInto(m, col, sources, sg) {
  try {
    const values = await viRunValues(m.sgbd, m.zcsJob.job);
    const k = viKeysFrom(values, m.zcsJob.keys);
    if (k) {
      col.keys = k;
      sources.push({
        sg,
        ok: true,
        what:
          k.source === 'named'
            ? `keys via ${m.zcsJob.job}`
            : `key region at byte ${k.offset}`,
      });
    } else {
      // a reply whose keys do not check out is NOT shown as the car's
      sources.push({
        sg,
        ok: false,
        what: `${m.zcsJob.job}: no valid key in reply`,
      });
    }
  } catch (e) {
    sources.push({ sg, ok: false, what: 'no answer' });
  }
}

/**
 * The VIN from the first of the module's SGBDs that declares one, read off
 * that module's own named result.
 * @param {string[]} sgbds - Coding SGBD first, then the diagnostic one.
 * @param {Map<string, ViJob[]>} jobsOf - Declared jobs per SGBD.
 * @returns {Promise<string|null>} The VIN body, or null when none answers.
 */
async function viReadVin(sgbds, jobsOf) {
  for (const sg of sgbds) {
    const pick = await viPickInfoJob(sg, jobsOf.get(sg), VI_VIN_ROLE);
    if (!pick) continue;
    try {
      const values = await viRunValues(sg, pick.job);
      const v = values.has(pick.result)
        ? String(values.get(pick.result)).trim()
        : '';
      if (v) return viVinBody(v);
    } catch (e) {
      /* try the next source; the row shows an em dash if none answers */
    }
  }
  return null;
}

/**
 * Read ONE master completely: its record (FA or ZCS), its VIN, its odometer.
 *
 * ODOMETER. Prefer the STORED value each module keeps in non-volatile
 * memory, never a live CAN broadcast:
 *   - Cluster (KMB): EEPROM word 0x28, bytes 1..3 BE km. The named
 *     STAT_KILOMETERSTAND_WERT is the CAN-signal mileage, which reads stale
 *     and DIFFERENT every time with the engine off (it is not being
 *     broadcast) -- exactly the drifting 79k/82k/94k values that looked like
 *     a mismatch. The EEPROM copy is stable and matches the dash.
 *   - EWS: KD block 0, bytes 2..4 LE km.
 * Both verified on a 231,364 mi car: KMB 372,358 km, EWS 372,346 km -- they
 * agree, which is why the car shows no tamper dot.
 * STORED copies only. A module without one shows an em dash rather than
 * a stand-in: the light module's service-interval counter is kept in
 * 100 km steps, and the cluster's CAN mileage drifts with the engine off
 * -- neither is the odometer, and putting either in the row made the
 * copies look like they disagreed.
 * @param {ViIdentityModule} m - The master.
 * @param {ViSource[]} sources - The source strip to append to.
 * @param {(m: ViIdentityModule) => string|null} famName - Family name lookup.
 * @returns {Promise<ViColumn>} The column, fields null where nothing
 *   answered.
 */
async function viReadColumn(m, sources, famName) {
  /** @type {ViColumn} */
  const col = { m, keys: null, fa: null, faRaw: null, vin: null, km: null };
  const sg = famName(m) || m.sgbd;
  if (m.fa) await viReadOrderInto(m, col, sources, sg);
  if (m.zcs && !col.fa) await viReadKeysInto(m, col, sources, sg);
  // VIN and odometer, from whatever job the module declares for them -- on
  // its coding SGBD first, then on its diagnostic one.
  const sgbds = [m.sgbd];
  if (m.diagSgbd && m.diagSgbd !== m.sgbd) sgbds.push(m.diagSgbd);
  const jobsOf = new Map();
  for (const sg of sgbds) jobsOf.set(sg, await viJobs(sg));
  col.vin = await viReadVin(sgbds, jobsOf);
  for (const sg of sgbds) {
    const stored = await viReadStoredOdometer(sg, jobsOf.get(sg));
    if (stored != null) {
      col.km = stored;
      break;
    }
  }
  return col;
}

/**
 * The stored (non-volatile) odometer for a module, or null. Cluster reads its
 * EEPROM; EWS reads its KD block. Both return km. See viReadColumn's note for
 * why the stored copy is preferred over any CAN-signal km.
 *
 * A cluster that DECLARES its stored odometer is asked for it by name. The
 * EEPROM word below was verified on an E46 cluster only; an E39 IKE also
 * answers EEPROM_LESEN, with a layout nobody has checked, so the declared
 * job goes first wherever one exists.
 * @param {string} sgbd - The SGBD.
 * @param {ViJob[]} jobs - Its declared jobs.
 * @returns {Promise<number|null>} Kilometres, or null.
 */
async function viReadStoredOdometer(sgbd, jobs) {
  const has = (name) =>
    Array.isArray(jobs) && jobs.some((j) => j && j.name === name);
  const pick = await viPickInfoJob(sgbd, jobs, VI_KM_STORED_ROLE);
  if (pick) {
    try {
      const values = await viRunValues(sgbd, pick.job);
      const v = values.has(pick.result)
        ? Number(String(values.get(pick.result)).trim())
        : NaN;
      if (Number.isFinite(v) && v > 0 && v < VI_KM_MAX) return v;
    } catch (e) {
      /* fall through to the raw reads */
    }
  }
  if (has(VI_KMB_EEPROM_JOB)) {
    const km = await viReadKmbOdometer(sgbd);
    if (km != null) return km;
  }
  if (has(VI_EWS_KD_JOB)) {
    const km = await viReadEwsOdometer(sgbd);
    if (km != null) return km;
  }
  return null;
}

/**
 * Cluster stored odometer: EEPROM word 0x28 (4 words read), the mileage is
 * bytes 1..3 big-endian km. Verified: 00 05 AE 86 ... -> 0x05AE86 = 372,358
 * km, matching the dash. Rejects a blank/implausible read.
 * @param {string} sgbd - The cluster SGBD.
 * @returns {Promise<number|null>} Kilometres, or null.
 */
async function viReadKmbOdometer(sgbd) {
  try {
    const values = await viRunValues(
      sgbd,
      VI_KMB_EEPROM_JOB,
      VI_KMB_EEPROM_ARG
    );
    const bytes = viBytes(values.has('DATEN') ? values.get('DATEN') : null);
    if (!bytes || bytes.length < 4) return null;
    const km = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    if (km === 0 || km === VI_KM_BLANK) return null;
    if (km > VI_KM_MAX) return null;
    return km;
  } catch (e) {
    return null;
  }
}

/**
 * Read KD block 0 from an EWS and decode the stored odometer (3-byte LE km at
 * offset 2).
 * @param {string} sgbd - The EWS SGBD.
 * @returns {Promise<number|null>} Kilometres, or null when the module has no
 *   such job, the block is blank, or the value is implausible.
 */
async function viReadEwsOdometer(sgbd) {
  let jobs;
  try {
    jobs = await viJobs(sgbd);
  } catch (e) {
    return null;
  }
  // viJobs returns [{ name }]; match on the declared job name.
  const hasKd =
    Array.isArray(jobs) && jobs.some((j) => j && j.name === VI_EWS_KD_JOB);
  if (!hasKd) return null;
  try {
    // BLOCK 0. viRunValues drives the job the same way every other read here
    // does; the block index is the job's single int argument.
    const values = await viRunValues(sgbd, VI_EWS_KD_JOB, VI_EWS_KD_BLOCK);
    const raw = values.has('KD_DATEN') ? values.get('KD_DATEN') : null;
    const bytes = viBytes(raw);
    if (!bytes || bytes.length < VI_EWS_KD_MIN_BYTES) return null;
    // an all-FF (uninitialised) block carries no odometer
    if (bytes.slice(0, VI_EWS_KD_MIN_BYTES).every((b) => b === 0xff))
      return null;
    const km = bytes[2] | (bytes[3] << 8) | (bytes[4] << 16);
    // a 3-byte field maxes at ~16.7M km; reject 0 and the all-FF sentinel
    if (km === 0 || km === VI_KM_BLANK) return null;
    return km;
  } catch (e) {
    return null;
  }
}
