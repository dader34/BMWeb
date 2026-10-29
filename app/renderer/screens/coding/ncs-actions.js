/**
 * @file NCS Expert's flow: the F-key and menu actions, bound to one render's
 * context (ncs.js passes `ctx`). The window and painting are ncs.js; the files
 * and FSW_PSW format are ncs-files.js.
 *
 * This runs the coding engine: a car's key (ZCS/FA) decides equipment, a
 * module is read through its own coding script and decoded with BMW's DATEN,
 * and a write goes back through treeWriteModule (backup, then prove-by-re-read).
 */

/* exported ncsBindActions */
/* global wkfpDialog, wkfpMessage, ncsReadKeyFromCar, VehicleIdentity,
   VehicleIdentity, ncsBindActions2 */

/**
 * Bind NCS's actions to a render.
 * @param {object} ctx - {state, profile, win, $, paint, setStatus, say,
 *   setMode, log, keys}
 * @returns {object} the named actions the keys and menu call.
 */
function ncsBindActions(ctx) {
  const { state, win, paint, setStatus, say, log } = ctx;

  /** NCS's error box: a warning over the window, logged to ERROR.LOG. */
  function ncsError(text) {
    log(`ERROR ${text.replace(/\n+/g, ' | ')}`);
    return wkfpMessage(win, 'warn', text, ['OK'], 'Error');
  }

  /**
   * A list to pick from, NCS's selection box.
   * @param {string} title
   * @param {Array<{label: string, value: any}>} items
   * @param {string} [prompt]
   * @returns {Promise<any|null>} the picked value, or null.
   */
  async function choose(title, items, prompt) {
    const body = document.createElement('div');
    body.className = 'ncs-choose';
    body.innerHTML =
      (prompt ? `<div>${esc(prompt)}</div>` : '') +
      `<select class="wkfp-pick ncs-pick" size="14">${items
        .map((it, i) => `<option value="${i}">${esc(it.label)}</option>`)
        .join('')}</select>`;
    const sel = body.querySelector('select');
    if (items.length) sel.selectedIndex = 0;
    sel.ondblclick = () => {
      const ok = sel
        .closest('.wkfp-dlg')
        .querySelector('.wkfp-dlg-btns .wkfp-btn');
      if (ok) ok.click();
    };
    const b = await wkfpDialog(win, {
      title,
      body,
      buttons: ['OK', 'Cancel'],
    });
    if (b !== 'OK' || sel.selectedIndex < 0) return null;
    return items[sel.selectedIndex].value;
  }

  /**
   * A text file in an editor.
   * @param {string} title
   * @param {string} text
   * @param {string[]} buttons
   * @param {boolean} [readOnly]
   * @returns {Promise<{button: string|null, text: string}>}
   */
  async function textDialog(title, text, buttons, readOnly) {
    const body = document.createElement('div');
    body.innerHTML = `<textarea class="wkfp-logview ncs-text" spellcheck="false"${
      readOnly ? ' readonly' : ''
    }></textarea>`;
    const ta = body.querySelector('textarea');
    ta.value = text || '';
    const button = await wkfpDialog(win, {
      title,
      body,
      buttons,
      cls: 'ncs-textdlg',
    });
    return { button, text: ta.value };
  }

  async function pickChassis() {
    const ids = await api('/api/chassis').catch(() => []);
    const order = state.chassis
      ? [state.chassis, ...ids.filter((x) => x !== state.chassis)]
      : ids;
    return choose(
      'Choose CHASSIS',
      order.map((id) => ({ label: dispChassis(id), value: id })),
      'Chassis:'
    );
  }

  /** The equipment a coding key stands for, for module selection. */
  function codesFromKey(chassis, keys) {
    try {
      if (
        typeof VehicleIdentity === 'undefined' ||
        !VehicleIdentity.saCodesFromZcs
      )
        return null;
      const eq = VehicleIdentity.saCodesFromZcs(chassis, keys);
      const codes = (eq.codes || []).slice();
      Object.defineProperty(codes, 'keywords', {
        value: eq.keywords || [],
      });
      return codes.length ? codes : null;
    } catch {
      return null;
    }
  }

  function carChanged() {
    state.mod = null;
    state.read = null;
    state.cabdPick = {};
    state.mode = 'main';
  }

  // ---- VIN/ZCS/FA -----------------------------------------------------------
  async function pickChassisOnly() {
    const ch = await pickChassis();
    if (!ch) return;
    if (ch !== state.chassis) {
      state.fg = '';
      state.zcs = null;
      state.fa = '';
      state.saCodes = null;
    }
    state.chassis = ch;
    carChanged();
    say(`CHASSIS ${ch} chosen. Process car, or Process ECU.`);
  }

  // NCS's "Enter ZCS" dialog (DIALOG 105): Vin, then GM/SA/VN, with a
  // "Calculate checksum" box that appends each key's Mod-36 check character.
  async function enterZcs() {
    const body = document.createElement('div');
    body.className = 'ncs-form';
    body.innerHTML =
      `<label>Vin:<input class="wkfp-input ncs-fg" maxlength="17" value="${esc(state.fg)}"></label>` +
      `<label>GM:<input class="wkfp-input ncs-gm" maxlength="9" value="${esc(state.zcs ? state.zcs.gm : '')}"></label>` +
      `<label>SA:<input class="wkfp-input ncs-sa" maxlength="17" value="${esc(state.zcs ? state.zcs.sa : '')}"></label>` +
      `<label>VN:<input class="wkfp-input ncs-vn" maxlength="11" value="${esc(state.zcs ? state.zcs.vn : '')}"></label>` +
      `<label class="ncs-check"><input type="checkbox" class="ncs-cks"> Calculate checksum</label>`;
    const b = await wkfpDialog(win, {
      title: 'Enter ZCS',
      body,
      buttons: ['OK', 'Cancel'],
    });
    if (b !== 'OK') return;
    const g = (c) => body.querySelector(c).value.trim().toUpperCase();
    const cks = body.querySelector('.ncs-cks').checked;
    state.fg = g('.ncs-fg');
    const zcs = { gm: g('.ncs-gm'), sa: g('.ncs-sa'), vn: g('.ncs-vn') };
    if (cks && typeof window.CodingEncode !== 'undefined') {
      const E = window.CodingEncode;
      const body8 = (s, n) =>
        String(s)
          .replace(/[^0-9A-Fa-f]/g, '')
          .slice(0, n);
      if (zcs.gm) zcs.gm = body8(zcs.gm, 8) + E.mod36('C1', body8(zcs.gm, 8));
      if (zcs.sa) zcs.sa = body8(zcs.sa, 16) + E.mod36('C2', body8(zcs.sa, 16));
      if (zcs.vn) zcs.vn = body8(zcs.vn, 10) + E.mod36('C3', body8(zcs.vn, 10));
    }
    if (!zcs.gm && !zcs.sa && !zcs.vn) {
      state.zcs = null;
    } else {
      state.zcs = zcs;
      if (state.chassis) state.saCodes = codesFromKey(state.chassis, zcs);
    }
    carChanged();
    say('ZCS entered.');
  }

  async function zcsFromEcu() {
    if (!state.chassis) {
      const ch = await pickChassis();
      if (!ch) return;
      state.chassis = ch;
    }
    state.busy = true;
    setStatus('Reading the coding key from the car...');
    paint();
    try {
      // NCS's own procedure: the modules SGFAM marks as key / order holders,
      // through their coding scripts' read jobs (ncs-key.js)
      const got = await ncsReadKeyFromCar(state.chassis);
      for (const t of got.tried)
        log(
          `READ KEY ${t.sg} (${t.sgbd}) ${t.job}: ${t.ok ? 'ok' : 'failed'}${t.info ? ` -- ${t.info}` : ''}`
        );
      if (!got.keys && !got.fa && !got.vin) {
        say('No module answered with the coding key.');
        await ncsError(
          'No control unit returned the coding key (ZCS), vehicle order (FA) ' +
            'or VIN.\n\n' +
            got.tried
              .map(
                (t) =>
                  `${t.sg} ${t.sgbd.toUpperCase()} ${t.job}: ${t.ok ? 'no value' : t.info || 'failed'}`
              )
              .join('\n') +
            '\n\nCheck the cable and ignition (engine off, key on).'
        );
        return;
      }
      carChanged();
      state.zcs = got.keys;
      state.fa = got.fa || '';
      state.fg = got.vin || '';
      // the car's equipment, for picking each module's coding file
      const VI =
        typeof VehicleIdentity !== 'undefined' ? VehicleIdentity : null;
      let codes = [];
      try {
        if (got.fa && VI) codes = VI.saCodesFromFa(VI.parseFa(got.fa));
        else if (got.keys && VI)
          codes = VI.saCodesFromZcs(state.chassis, got.keys).codes || [];
      } catch {
        /* equipment unknown: modules are picked by the expert */
      }
      state.saCodes = codes.length ? codes : null;
      say(
        `Read from the car: ${[got.keys && 'ZCS', got.fa && 'FA', got.vin && 'VIN'].filter(Boolean).join(', ')}.`,
        ...(got.vin
          ? []
          : [
              `No full VIN was read${got.vinPart ? ` (a module holds ${got.vinPart})` : ''}: enter it with Enter Vin/ZCS before coding a module that writes it.`,
            ]),
        // no key and no order: say what each holder answered
        ...(got.keys || got.fa
          ? []
          : [
              'No coding key (ZCS) or vehicle order (FA):',
              ...got.tried
                .filter((t) => t.job !== 'FGNR_LESEN')
                .map(
                  (t) =>
                    `  ${t.sg} ${t.sgbd.toUpperCase()} ${t.job}: ${t.ok ? t.info || 'no key in the answer' : t.info || 'failed'}`
                ),
            ])
      );
    } catch (e) {
      await ncsError(`ZCS/FA read failed: ${e.message || e}`);
    } finally {
      state.busy = false;
      setStatus('Ready');
      paint();
    }
  }

  function zcsFromFile() {
    const picker = ctx.$('ncs-file');
    picker.accept = '.man,.txt,.fsw,.key,.pfl';
    picker.onchange = async () => {
      const file = (picker.files || [])[0];
      picker.value = '';
      if (!file) return;
      const text = await file.text();
      // ZCS as three labelled lines, or a bare FA stream
      const gm = /GM[:\s]+([0-9A-Fa-f]+)/.exec(text);
      const sa = /SA[:\s]+([0-9A-Fa-f]+)/.exec(text);
      const vn = /VN[:\s]+([0-9A-Fa-f]+)/.exec(text);
      if (gm || sa || vn) {
        state.zcs = {
          gm: (gm && gm[1]) || '',
          sa: (sa && sa[1]) || '',
          vn: (vn && vn[1]) || '',
        };
        if (state.chassis)
          state.saCodes = codesFromKey(state.chassis, state.zcs);
        carChanged();
        say(`FG/ZCS/FA loaded from ${esc(file.name)}.`);
      } else {
        await ncsError(`No ZCS/FA found in ${file.name}.`);
      }
    };
    picker.click();
  }

  // the rest of the flow (ECU pick, read, code, files, profile) is added by
  // ncsBindActions2 so no one file grows too large.
  const base = {
    ncsError,
    choose,
    textDialog,
    pickChassis,
    codesFromKey,
    carChanged,
    pickChassisOnly,
    enterZcs,
    zcsFromEcu,
    zcsFromFile,
  };
  return typeof ncsBindActions2 === 'function'
    ? ncsBindActions2(ctx, base)
    : base;
}
