/**
 * @file ZCS Editor: edit and write the three ZCS keys (GM, SA, VN).
 *
 * Reached from the coding hub when a ZCS-capable module (KMB, IKE) is
 * selected. Reads the current 20-byte ZCS region, parses it, lets the user
 * edit each key, validates check digits, and writes the new region back --
 * through the same gates as any coding write: confirm, backup first, then
 * webWriteCoding's prove-by-re-read.
 */

/** Bytes in the ZCS region. */
const ZCS_EDITOR_REGION_LEN = 20;

/**
 * Read a module's coding image and return it as bytes plus the raw hex the
 * read returned (the hex is what the backup stores).
 * @param {string} sgbd - the module.
 * @param {string} noJobMessage - the error when the module has no read job.
 * @returns {Promise<{netto: number[], nettoHex: unknown}>} the image.
 * @throws {Error} when there is no read job or the read returned no netto.
 */
async function zcsReadNetto(sgbd, noJobMessage) {
  const entry = typeof codingFor === 'function' ? await codingFor(sgbd) : null;
  if (!entry || !entry.read) {
    throw new Error(noJobMessage);
  }
  const readRes = await api(`/api/ecu/${sgbd}/run/${entry.read}`, {
    method: 'POST',
  });
  const nettoHex = codingNettoOf(new Map(flatResults(readRes.sets)));
  if (!nettoHex) {
    throw new Error('Read did not return netto');
  }
  return { netto: codingNettoBytes(nettoHex), nettoHex };
}

/**
 * Where the ZCS region sits in a module's netto, per its DATEN description:
 * the word of the first field named GM_SCHLUESSEL / ZCS on the car's chassis.
 * @param {string} sgbd - the module.
 * @param {string} chassisId - chassis id.
 * @returns {Promise<number>} the byte offset (0 when DATEN does not say).
 */
async function zcsRegionOffset(sgbd, chassisId) {
  const daten = typeof datenFor === 'function' ? await datenFor(sgbd) : null;
  let zcsOffset = 0;
  if (daten && daten.chassis) {
    const chId = String(chassisId || '').toUpperCase();
    const chassis =
      daten.chassis[chId] || daten.chassis[Object.keys(daten.chassis)[0]];
    if (chassis) {
      // Look for a field named ZCS or GM_SCHLUESSEL to find the offset
      const keys = Object.keys(chassis);
      for (const vk of keys) {
        for (const f of chassis[vk]) {
          if (f.name && /GM_SCHLUESSEL|ZCS/i.test(f.name)) {
            zcsOffset = f.word || 0;
            break;
          }
        }
        if (zcsOffset) break;
      }
    }
  }
  return zcsOffset;
}

/**
 * One key's editor row.
 * @param {string} id - input id (zcs-gm / zcs-sa / zcs-vn).
 * @param {string} title - the row label.
 * @param {string} value - the body being edited.
 * @param {number} maxlength - body length in hex chars.
 * @param {string} currentValue - the key as currently on the ECU.
 * @param {string|null} err - the validation error, if any.
 * @param {string} withCheck - the key with its check char, when valid.
 * @param {string} [extra] - extra HTML under the row.
 * @returns {string} HTML.
 */
function zcsKeyRow(
  id,
  title,
  value,
  maxlength,
  currentValue,
  err,
  withCheck,
  extra
) {
  return `
        <div class="zcs-row">
          <label class="zcs-label">${title}</label>
          <div class="zcs-input-wrap">
            <input class="zcs-input mono" id="${id}" type="text"
                   value="${esc(value)}" maxlength="${maxlength}"
                   placeholder="${maxlength} hex chars">
            <span class="zcs-current mono" title="Current value">
              ${esc(currentValue)}</span>
          </div>
          ${err ? `<div class="zcs-error">${esc(err)}</div>` : ''}
          ${withCheck ? `<div class="zcs-check">With check: <span class="mono">${esc(withCheck)}</span></div>` : ''}
          ${extra || ''}
        </div>`;
}

/**
 * The ZCS editor screen.
 * @param {string} chassisId - chassis id.
 * @param {string} sgbd - the module holding the ZCS keys.
 * @param {() => void} back - the Back action.
 * @returns {Promise<void>} resolves once drawn.
 */
async function showZcsEditor(chassisId, sgbd, back) {
  lastScreen = () => showZcsEditor(chassisId, sgbd, back);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Coding', fn: back },
    { label: 'ZCS Editor' },
  ]);
  sbLeft.textContent = `${dispChassis(chassisId)} · ZCS`;

  view.innerHTML = head(
    'ZCS Editor',
    `${dispChassis(chassisId)} · ${sgbd}.prg`,
    'Edit the three ZCS keys (Grundmodell, Sonderausstattung, Versionsnummer). ' +
      'Changes are validated and written to the ECU.'
  );

  const panel = document.createElement('div');
  panel.className = 'zcs-editor-panel';
  view.appendChild(panel);

  // Read current ZCS
  panel.innerHTML =
    '<div class="coding-scan"><div class="coding-scan-title">Reading ZCS…</div></div>';

  /** @type {ZcsRegion} */
  let currentZcs;
  try {
    const { netto } = await zcsReadNetto(
      sgbd,
      'No coding read job for this module'
    );
    const zcsOffset = await zcsRegionOffset(sgbd, chassisId);
    const zcsBytes = netto.slice(zcsOffset, zcsOffset + ZCS_EDITOR_REGION_LEN);
    if (zcsBytes.length < ZCS_EDITOR_REGION_LEN) {
      throw new Error('Netto too short to contain ZCS region');
    }

    currentZcs = CodingZcs.parseZcsRegion(zcsBytes);
    currentZcs.offset = zcsOffset;
  } catch (err) {
    panel.innerHTML = errorBlock(`Failed to read ZCS: ${err.message}`);
    return;
  }

  // Render editor
  const state = {
    gm: currentZcs.gm.body,
    sa: currentZcs.sa.body,
    vn: currentZcs.vn.body,
  };

  const draw = () => {
    const gmValid = CodingZcs.validateGm(state.gm);
    const saValid = CodingZcs.validateSa(state.sa);
    const vnValid = CodingZcs.validateVn(state.vn);
    const allValid = !gmValid && !saValid && !vnValid;

    const gmFmt = gmValid ? '' : CodingZcs.formatGm(state.gm);
    const saFmt = saValid ? '' : CodingZcs.formatSa(state.sa);
    const vnFmt = vnValid ? '' : CodingZcs.formatVn(state.vn);

    const changed =
      state.gm !== currentZcs.gm.body ||
      state.sa !== currentZcs.sa.body ||
      state.vn !== currentZcs.vn.body;

    const saCodes =
      !saValid && state.sa
        ? `<div class="zcs-sa-codes">SA codes: ${
            CodingZcs.extractSaCodes(state.sa).join(', ') || 'none'
          }</div>`
        : '';

    panel.innerHTML = `
      <div class="zcs-editor">
        ${zcsKeyRow('zcs-gm', 'GM (Grundmodell)', state.gm, 8, currentZcs.gm.value, gmValid, gmFmt)}
        ${zcsKeyRow('zcs-sa', 'SA (Sonderausstattung)', state.sa, 16, currentZcs.sa.value, saValid, saFmt, saCodes)}
        ${zcsKeyRow('zcs-vn', 'VN (Versionsnummer)', state.vn, 10, currentZcs.vn.value, vnValid, vnFmt)}

        <div class="zcs-actions">
          <button class="btn" id="zcs-write" ${allValid && changed ? '' : 'disabled'}>
            Write to ECU</button>
          <button class="btn btn-sec" id="zcs-reset">Reset</button>
        </div>
      </div>
    `;

    panel.querySelector('#zcs-gm').oninput = (e) => {
      state.gm = e.target.value.toUpperCase();
      draw();
    };
    panel.querySelector('#zcs-sa').oninput = (e) => {
      state.sa = e.target.value.toUpperCase();
      draw();
    };
    panel.querySelector('#zcs-vn').oninput = (e) => {
      state.vn = e.target.value.toUpperCase();
      draw();
    };
    panel.querySelector('#zcs-reset').onclick = () => {
      state.gm = currentZcs.gm.body;
      state.sa = currentZcs.sa.body;
      state.vn = currentZcs.vn.body;
      draw();
    };

    if (allValid && changed) {
      panel.querySelector('#zcs-write').onclick = async () => {
        await writeZcs();
      };
    }
  };

  const writeZcs = async () => {
    const ok = await confirmDialog({
      title: 'Write ZCS to ECU',
      body: `<div class="zcs-confirm">
        <div class="zcs-confirm-row">
          <span>GM:</span>
          <span class="mono">${esc(currentZcs.gm.value)}</span>
          <span>→</span>
          <span class="mono">${esc(CodingZcs.formatGm(state.gm))}</span>
        </div>
        <div class="zcs-confirm-row">
          <span>SA:</span>
          <span class="mono">${esc(currentZcs.sa.value)}</span>
          <span>→</span>
          <span class="mono">${esc(CodingZcs.formatSa(state.sa))}</span>
        </div>
        <div class="zcs-confirm-row">
          <span>VN:</span>
          <span class="mono">${esc(currentZcs.vn.value)}</span>
          <span>→</span>
          <span class="mono">${esc(CodingZcs.formatVn(state.vn))}</span>
        </div>
        <p><b>This will write the new ZCS keys to the ECU and verify.</b></p>
      </div>`,
      confirmLabel: 'Write',
      cancelLabel: 'Cancel',
      danger: true,
    });

    if (!ok) return;

    panel.innerHTML =
      '<div class="coding-scan"><div class="coding-scan-title">Writing ZCS…</div></div>';

    try {
      // Read current netto
      const { netto, nettoHex } = await zcsReadNetto(sgbd, 'No read job');

      // Build new ZCS region and splice it
      const zcsRegion = CodingZcs.buildZcsRegion(state.gm, state.sa, state.vn);
      for (let i = 0; i < ZCS_EDITOR_REGION_LEN; i++) {
        netto[currentZcs.offset + i] = zcsRegion[i];
      }

      const modHex = codingNettoHex(netto);

      // Write via webWriteCoding
      if (typeof webWriteCoding !== 'function') {
        throw new Error('webWriteCoding not available');
      }

      // BACKUP BEFORE TRANSMIT. nettoHex holds the ECU's current ZCS keys;
      // after the write they are gone. Persist first -- a ZCS mistake takes
      // the car's identity with it.
      const backup =
        typeof saveCodingBackup === 'function'
          ? saveCodingBackup(sgbd, nettoHex, {
              chassis: chassisId,
              note: 'pre-write (ZCS)',
            })
          : null;

      await webWriteCoding(sgbd, modHex, { confirmed: true });

      await confirmDialog({
        title: 'ZCS written',
        body:
          '<p>ZCS keys written and verified successfully.</p>' +
          (backup
            ? '<p class="cod-note">The previous keys were saved to this ' +
              'browser first, under Coding backups.</p>'
            : '<p class="cod-note"><b>No backup was saved</b> (browser ' +
              'storage unavailable) — the previous keys are not ' +
              'recoverable from this app.</p>'),
        confirmLabel: 'OK',
        cancelLabel: null,
      });

      // Reload
      showZcsEditor(chassisId, sgbd, back);
    } catch (err) {
      panel.innerHTML = errorBlock(`Failed to write ZCS: ${err.message}`);
    }
  };

  draw();
}

if (typeof window !== 'undefined') {
  window.showZcsEditor = showZcsEditor;
}
