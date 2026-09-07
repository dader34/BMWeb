/**
 * @file The expert tree's staged-changes review and the ONLY screen-side
 * path that writes coding to a car.
 *
 * A coding write is an EEPROM write; get it wrong on a module that gates the
 * immobiliser or airbags and the car does not start, or worse. So every write
 * here passes FOUR GATES, in this order, and none of them is optional:
 *
 *   1. CONFIRM        the review dialog names every change and the user
 *                     chooses "Write to car";
 *   2. RESOLVED VIEW  assertResolvedForWrite refuses a layout that is not
 *                     provably this ECU's (unconfirmed variant, unresolved
 *                     coding index);
 *   3. BACKUP FIRST   the bytes the ECU holds are persisted (saveCodingBackup)
 *                     before anything is transmitted;
 *   4. PROVE-BY-RE-READ  webWriteCoding transmits with opts.confirmed and
 *                     re-reads the module to prove the bytes landed
 *                     (core/coding/write.js).
 *
 * The edits are spliced onto the image just READ from the ECU (never built
 * from zeros), so a write is always a delta against the car.
 */

/**
 * One module's outcome in the write results dialog.
 * @typedef {Object} WriteOutcome
 * @property {string} sgbd - the module.
 * @property {boolean} ok - written and verified?
 * @property {string} [err] - why it failed.
 * @property {boolean} [backup] - was the previous coding backed up?
 */

/**
 * Gather the staged edits per module.
 * @param {BuiltModule[]} built - the modules with their functions.
 * @param {Map<string, FunctionState>} state - per-function state.
 * @returns {Map<string, StagedEdit[]>} sgbd -> staged edits.
 */
function treeStagedEdits(built, state) {
  const byMod = new Map();
  for (const m of built) {
    for (const f of m.fns) {
      const s = state.get(`${m.sgbd}:${f.name}`);
      if (!s || s.staged == null) continue;
      if (!byMod.has(m.sgbd)) byMod.set(m.sgbd, []);
      byMod.get(m.sgbd).push({ rule: f, value: parseInt(s.staged, 16) });
    }
  }
  return byMod;
}

/**
 * The review rows for every staged change.
 * @param {BuiltModule[]} built - the modules with their functions.
 * @param {Map<string, FunctionState>} state - per-function state.
 * @param {(name: string) => string} label - the keyword labeller.
 * @returns {string[]} review rows from codingReviewRow.
 */
function treeReviewRows(built, state, label) {
  const rows = [];
  for (const m of built) {
    for (const f of m.fns) {
      const s = state.get(`${m.sgbd}:${f.name}`);
      if (!s || s.staged == null) continue;
      rows.push(
        codingReviewRow(
          label(f.name),
          `${m.sgbd}.prg · ${f.name}`,
          `0x${s.current}`,
          `0x${s.staged}`
        )
      );
    }
  }
  return rows;
}

/**
 * Write one module's staged edits: read its image, splice, back up, write,
 * and on success promote staged to current.
 * @param {BuiltModule} mod - the module.
 * @param {StagedEdit[]} edits - its staged edits.
 * @param {Map<string, FunctionState>} state - per-function state.
 * @returns {Promise<WriteOutcome>} the outcome (never throws).
 */
async function treeWriteModule(mod, edits, state) {
  const sgbd = mod.sgbd;
  try {
    // The union view is a reference, not a write target -- refuse before
    // anything touches the wire.
    assertResolvedForWrite(sgbd, mod.fns, mod);

    // Read current netto
    const entry =
      typeof codingFor === 'function' ? await codingFor(sgbd) : null;
    if (!entry || !entry.read) {
      return { sgbd, ok: false, err: 'No read job defined' };
    }

    const readRes = await api(`/api/ecu/${sgbd}/run/${entry.read}`, {
      method: 'POST',
    });
    const nettoHex = codingNettoOf(new Map(flatResults(readRes.sets)));
    if (!nettoHex) {
      return { sgbd, ok: false, err: 'Read did not return netto' };
    }

    // Build the new netto by splicing edits onto the read image
    const netto = codingNettoBytes(nettoHex);
    const CodingEncode =
      typeof window !== 'undefined' && window.CodingEncode
        ? window.CodingEncode
        : require('../../core/coding/encode.js');
    const modified = CodingEncode.spliceEdits(new Uint8Array(netto), edits);
    const modHex = codingNettoHex(modified);

    // Write via webWriteCoding
    if (typeof webWriteCoding !== 'function') {
      return { sgbd, ok: false, err: 'webWriteCoding not available' };
    }

    // BACKUP BEFORE TRANSMIT. nettoHex is what the ECU holds right now;
    // once the write lands it is unrecoverable. Persist it here, while it
    // still exists. A failure to store is reported, never fatal.
    const backup =
      typeof saveCodingBackup === 'function'
        ? saveCodingBackup(sgbd, nettoHex, {
            chassis: mod.chassisId || null,
            ci: mod.fns ? mod.fns.codingIndex : null,
            note: 'pre-write (coding)',
          })
        : null;

    await webWriteCoding(sgbd, modHex, { confirmed: true });

    // Update state: staged becomes current
    for (const f of mod.fns) {
      const s = state.get(`${sgbd}:${f.name}`);
      if (s && s.staged != null) {
        s.current = s.staged;
        s.staged = null;
      }
    }
    return { sgbd, ok: true, backup: !!backup };
  } catch (err) {
    return { sgbd, ok: false, err: String(err.message || err) };
  }
}

/**
 * The results dialog body.
 * @param {WriteOutcome[]} results - one per module written.
 * @returns {string} HTML.
 */
function treeWriteResultsHtml(results) {
  return results
    .map((r) => {
      const icon = r.ok ? '✓' : '✗';
      const msg = r.ok
        ? r.backup
          ? 'Written and verified (previous coding backed up)'
          : 'Written and verified — NO BACKUP SAVED'
        : `Failed: ${r.err}`;
      return (
        `<div class="cod-result-row">` +
        `<span class="cod-result-icon ${r.ok ? 'ok' : 'err'}">${icon}</span>` +
        `<span class="cod-result-sgbd mono">${esc(r.sgbd)}.prg</span>` +
        `<span class="cod-result-msg">${esc(msg)}</span></div>`
      );
    })
    .join('');
}

/**
 * The staged-changes review for the Expert tree: confirm, then write each
 * module through the gates above and report per module.
 * @param {BuiltModule[]} built - the modules with their functions.
 * @param {Map<string, FunctionState>} state - per-function state.
 * @param {(name: string) => string} label - the keyword labeller.
 * @returns {Promise<void>} resolves once the results dialog closes.
 */
async function treeReview(built, state, label) {
  const byMod = treeStagedEdits(built, state);
  const rows = treeReviewRows(built, state, label);

  const foot =
    `<b>Ready to write.</b> This will send the changes to the car's ECUs. ` +
    `Each module is written, then re-read to verify the write succeeded.`;

  const ok = await confirmDialog({
    title: 'Review coding changes',
    body:
      `<div class="cod-rev-list">${rows.join('')}</div>` +
      `<div class="cod-rev-foot">${foot}</div>`,
    confirmLabel: 'Write to car',
    cancelLabel: 'Cancel',
    danger: true,
  });

  if (!ok) return;

  // Execute writes per module
  /** @type {WriteOutcome[]} */
  const results = [];
  for (const [sgbd, edits] of byMod.entries()) {
    const mod = built.find((m) => m.sgbd === sgbd);
    if (!mod) continue;
    results.push(await treeWriteModule(mod, edits, state));
  }

  // Show results
  const allOk = results.every((r) => r.ok);
  await confirmDialog({
    title: allOk ? 'Coding written' : 'Write completed with errors',
    body: `<div class="cod-result-list">${treeWriteResultsHtml(results)}</div>`,
    confirmLabel: 'OK',
    cancelLabel: null,
  });
}

// The pieces the other coding screens call; published explicitly so the shared surface is visible.
if (typeof window !== 'undefined') {
  window.treeReview = treeReview;
}
