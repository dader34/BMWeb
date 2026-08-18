// ZCS Editor: edit and write the three ZCS keys (GM, SA, VN)
//
// Reached from the coding hub when a ZCS-capable module (KMB, IKE) is selected.
// Reads the current 20-byte ZCS region, parses it, lets the user edit each key,
// validates check digits, and writes the new region back.

async function showZcsEditor(chassisId, sgbd, back) {
  lastScreen = () => showZcsEditor(chassisId, sgbd, back);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Coding', fn: back },
    { label: 'ZCS Editor' },
  ]);
  sbLeft.textContent = `${dispChassis(chassisId)} · ZCS`;

  view.innerHTML = head('ZCS Editor', `${dispChassis(chassisId)} · ${sgbd}.prg`,
    'Edit the three ZCS keys (Grundmodell, Sonderausstattung, Versionsnummer). '
    + 'Changes are validated and written to the ECU.');

  const panel = document.createElement('div');
  panel.className = 'zcs-editor-panel';
  view.appendChild(panel);

  // Read current ZCS
  panel.innerHTML = '<div class="coding-scan"><div class="coding-scan-title">Reading ZCS…</div></div>';

  let currentZcs = null;
  try {
    const entry = typeof codingFor === 'function' ? await codingFor(sgbd) : null;
    if (!entry || !entry.read) {
      throw new Error('No coding read job for this module');
    }

    const readRes = await api(`/api/ecu/${sgbd}/run/${entry.read}`, { method: 'POST' });
    const flatRes = new Map(flatResults(readRes.sets));
    const nettoHex = flatRes.get('COD_WERT_NETTO') || flatRes.get('CODIER_WERT_NETTO');
    if (!nettoHex) {
      throw new Error('Read did not return netto');
    }

    // Parse netto to find ZCS region
    const netto = [];
    const hex = String(nettoHex).replace(/^0x/i, '').replace(/\s/g, '');
    for (let i = 0; i + 1 < hex.length; i += 2) {
      netto.push(parseInt(hex.substr(i, 2), 16));
    }

    // Find ZCS region (20 bytes) - typically at a known offset per DATEN
    // For now, assume it's at the start or we can find it via DATEN
    const daten = typeof datenFor === 'function' ? await datenFor(sgbd) : null;
    let zcsOffset = 0;
    if (daten && daten.chassis) {
      const chId = String(chassisId || '').toUpperCase();
      const chassis = daten.chassis[chId] || daten.chassis[Object.keys(daten.chassis)[0]];
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

    const zcsBytes = netto.slice(zcsOffset, zcsOffset + 20);
    if (zcsBytes.length < 20) {
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

    const changed = state.gm !== currentZcs.gm.body
      || state.sa !== currentZcs.sa.body
      || state.vn !== currentZcs.vn.body;

    panel.innerHTML = `
      <div class="zcs-editor">
        <div class="zcs-row">
          <label class="zcs-label">GM (Grundmodell)</label>
          <div class="zcs-input-wrap">
            <input class="zcs-input mono" id="zcs-gm" type="text"
                   value="${esc(state.gm)}" maxlength="8"
                   placeholder="8 hex chars">
            <span class="zcs-current mono" title="Current value">
              ${esc(currentZcs.gm.value)}</span>
          </div>
          ${gmValid ? `<div class="zcs-error">${esc(gmValid)}</div>` : ''}
          ${gmFmt ? `<div class="zcs-check">With check: <span class="mono">${esc(gmFmt)}</span></div>` : ''}
        </div>

        <div class="zcs-row">
          <label class="zcs-label">SA (Sonderausstattung)</label>
          <div class="zcs-input-wrap">
            <input class="zcs-input mono" id="zcs-sa" type="text"
                   value="${esc(state.sa)}" maxlength="16"
                   placeholder="16 hex chars">
            <span class="zcs-current mono" title="Current value">
              ${esc(currentZcs.sa.value)}</span>
          </div>
          ${saValid ? `<div class="zcs-error">${esc(saValid)}</div>` : ''}
          ${saFmt ? `<div class="zcs-check">With check: <span class="mono">${esc(saFmt)}</span></div>` : ''}
          ${!saValid && state.sa ? `<div class="zcs-sa-codes">SA codes: ${
            CodingZcs.extractSaCodes(state.sa).join(', ') || 'none'
          }</div>` : ''}
        </div>

        <div class="zcs-row">
          <label class="zcs-label">VN (Versionsnummer)</label>
          <div class="zcs-input-wrap">
            <input class="zcs-input mono" id="zcs-vn" type="text"
                   value="${esc(state.vn)}" maxlength="10"
                   placeholder="10 hex chars">
            <span class="zcs-current mono" title="Current value">
              ${esc(currentZcs.vn.value)}</span>
          </div>
          ${vnValid ? `<div class="zcs-error">${esc(vnValid)}</div>` : ''}
          ${vnFmt ? `<div class="zcs-check">With check: <span class="mono">${esc(vnFmt)}</span></div>` : ''}
        </div>

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

    panel.innerHTML = '<div class="coding-scan"><div class="coding-scan-title">Writing ZCS…</div></div>';

    try {
      // Read current netto
      const entry = typeof codingFor === 'function' ? await codingFor(sgbd) : null;
      if (!entry || !entry.read) {
        throw new Error('No read job');
      }

      const readRes = await api(`/api/ecu/${sgbd}/run/${entry.read}`, { method: 'POST' });
      const flatRes = new Map(flatResults(readRes.sets));
      const nettoHex = flatRes.get('COD_WERT_NETTO') || flatRes.get('CODIER_WERT_NETTO');
      if (!nettoHex) {
        throw new Error('Read did not return netto');
      }

      const netto = [];
      const hex = String(nettoHex).replace(/^0x/i, '').replace(/\s/g, '');
      for (let i = 0; i + 1 < hex.length; i += 2) {
        netto.push(parseInt(hex.substr(i, 2), 16));
      }

      // Build new ZCS region and splice it
      const zcsRegion = CodingZcs.buildZcsRegion(state.gm, state.sa, state.vn);
      for (let i = 0; i < 20; i++) {
        netto[currentZcs.offset + i] = zcsRegion[i];
      }

      const modHex = netto.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');

      // Write via webWriteCoding
      if (typeof webWriteCoding !== 'function') {
        throw new Error('webWriteCoding not available');
      }

      await webWriteCoding(sgbd, modHex, { confirmed: true });

      await confirmDialog({
        title: 'ZCS written',
        body: '<p>ZCS keys written and verified successfully.</p>',
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
