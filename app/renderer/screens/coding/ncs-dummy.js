/**
 * @file The trace editor: what NCS Dummy does beside NCS Expert. A module's
 * FSW_PSW.TRC -- the one Read ECU just wrote, or one loaded from disk (real
 * NCS's included) -- as a table: each function in English (NCS Dummy's
 * community translations, BMW_DATEN_I18N, word by word where there is none),
 * the parameter it holds, and every parameter BMW's DATEN allows for it.
 * What is changed becomes FSW_PSW.MAN, which Execute job (SG_CODIEREN) codes
 * the module from -- the same write path, backup and read-back as ever.
 */

/* exported ncsDummyRows, ncsDummyMan, ncsDummyVariant, ncsBindDummy */
/* global ncsFiles, ncsSaveFiles, ncsParseMan, ncsParamHex, ncsDownload,
   datLabel, datI18n, moduleFunctions, ncsSlots, ncsDatenFile */

/**
 * An English label, or '' when it would only repeat the keyword.
 * @param {string} name - a DATEN keyword (function or parameter).
 * @returns {string}
 */
function ncsDummyLabel(name) {
  const own =
    typeof datI18n === 'function' && datI18n(name) ? datI18n(name) : '';
  if (own) return own;
  const t = typeof datLabel === 'function' ? datLabel(name) : '';
  return t && t.toLowerCase() !== String(name).toLowerCase() ? t : '';
}

/**
 * The table: one row per function the trace names that the description
 * knows, in the description's order, with what the trace says it holds.
 * @param {object[]} fns - the module's functions (moduleFunctions).
 * @param {string} trc - FSW_PSW.TRC.
 * @returns {{rows: object[], unknown: string[]}} the rows, and the trace's
 *   functions the description does not have.
 */
function ncsDummyRows(fns, trc) {
  const held = new Map();
  for (const [fsw, psw] of ncsParseMan(trc))
    held.set(String(fsw).toUpperCase(), psw);
  const rows = [];
  const seen = new Set();
  for (const f of fns || []) {
    const key = String(f.name).toUpperCase();
    if (!held.has(key) || !(f.values || []).length) continue;
    if (fns.codingLocked && fns.codingLocked.has(f.name)) continue;
    seen.add(key);
    const psw = String(held.get(key));
    const options = f.values.map(([name, hex]) => ({
      name: String(name),
      hex: String(hex).toLowerCase(),
      label: ncsDummyLabel(String(name)),
    }));
    // a value no parameter is named for (wert_<hex>) is still an option:
    // it is what the module holds
    if (!options.some((o) => o.name.toLowerCase() === psw.toLowerCase())) {
      const hex = ncsParamHex(f, psw);
      options.push({ name: psw, hex: hex || '', label: '' });
    }
    rows.push({
      fsw: f.name,
      label: ncsDummyLabel(f.name),
      block: f.block || 0,
      psw,
      hex: ncsParamHex(f, psw),
      options,
    });
  }
  const unknown = [...held.keys()].filter((k) => !seen.has(k));
  return { rows, unknown };
}

/**
 * FSW_PSW.MAN for the picks: only the functions whose parameter changed, as
 * NCS takes it (the function flush left, its parameter after a tab).
 * @param {object[]} rows - from ncsDummyRows.
 * @param {Map<string, string>} picks - function -> picked parameter.
 * @returns {{text: string, count: number}}
 */
function ncsDummyMan(rows, picks) {
  const out = [];
  for (const r of rows) {
    const p = picks.get(r.fsw);
    if (p == null || p.toLowerCase() === r.psw.toLowerCase()) continue;
    out.push(r.fsw, `\t${p}`);
  }
  return {
    text: out.join('\r\n') + (out.length ? '\r\n' : ''),
    count: out.length / 2,
  };
}

/**
 * Which of a module's coding files a trace was made with: the one that knows
 * most of its functions. Ties go to the newest (last-listed) file.
 * @param {object} daten - the module's DATEN entry (datenFor).
 * @param {string} chassis - chassis id.
 * @param {string} trc - FSW_PSW.TRC.
 * @returns {{key: string, ci: number|null, hits: number}|null}
 */
function ncsDummyVariant(daten, chassis, trc) {
  const ch =
    daten && daten.chassis && (daten.chassis[chassis] ? chassis : null);
  if (!ch) return null;
  const names = new Set(
    ncsParseMan(trc).map(([fsw]) => String(fsw).toUpperCase())
  );
  let best = null;
  for (const [key, fields] of Object.entries(daten.chassis[ch])) {
    let hits = 0;
    for (const f of fields) if (names.has(String(f.name).toUpperCase())) hits++;
    if (!best || hits >= best.hits) {
      const lay = daten.layout && daten.layout[ch] && daten.layout[ch][key];
      const listed = lay && Array.isArray(lay.index) ? lay.index[0] : null;
      const m = /C([0-9A-F]{2})/i.exec(key);
      best = {
        key,
        ci: listed != null ? listed : m ? parseInt(m[1], 16) : null,
        hits,
      };
    }
  }
  return best && best.hits ? best : null;
}

/**
 * The trace editor's action, bound to the NCS window.
 * @param {object} ctx - the render context (ncs.js).
 * @param {object} actions - the window's other actions (dialogs, codeEcu).
 * @returns {{traceEditor: () => Promise<void>}}
 */
function ncsBindDummy(ctx, actions) {
  const { state, win, say, log } = ctx;

  /** A .TRC from disk, or null. */
  function pickFile() {
    return new Promise((resolve) => {
      const picker = ctx.$('ncs-file');
      picker.accept = '.trc,.man,.txt';
      picker.onchange = async () => {
        const file = (picker.files || [])[0];
        picker.value = '';
        resolve(file ? { name: file.name, text: await file.text() } : null);
      };
      picker.click();
    });
  }

  /**
   * The module and its functions for a trace from disk: the module picked,
   * the coding file found from the trace's own function names.
   */
  async function describeImported(trc) {
    let chassis = state.chassis;
    if (!chassis) {
      chassis = await actions.pickChassis();
      if (!chassis) return null;
      state.chassis = chassis;
    }
    let mod = state.mod;
    if (!mod) {
      // NCS's ECU list, as Choose ECU shows it
      const slots = await ncsSlots(chassis);
      mod = await actions.choose(
        'Choose ECU',
        slots.map((m) => ({
          label: `${m.umrsg.padEnd(6)} ${m.files.join(', ') || '-'}  (${m.asw})`,
          value: m,
        })),
        'Which control unit is this trace from?'
      );
      if (!mod) return null;
    }
    // the slot's coding files under NCS's names; the one that knows most of
    // the trace's functions is the one it was made with
    const daten = await ncsDatenFile(chassis);
    let best = null;
    for (const name of mod.files || []) {
      const entry = daten && daten.modules && daten.modules[name];
      const v = entry && ncsDummyVariant(entry, chassis, trc);
      if (v && (!best || v.hits > best.v.hits)) best = { name, entry, v };
    }
    if (!best) {
      await actions.ncsError(
        `None of ${mod.umrsg}'s coding files for ${chassis} names the ` +
          'functions in this trace.'
      );
      return null;
    }
    const fns = await moduleFunctions(
      chassis,
      mod.sgbd,
      best.v.ci,
      null,
      best.entry
    );
    return { mod, fns, file: `${best.name}.${best.v.key}` };
  }

  async function traceEditor() {
    const files = ncsFiles();
    let trc = files.trc;
    let desc =
      state.read && trc.trim()
        ? { mod: state.read.mod, fns: state.read.fns, file: null }
        : null;
    let origin = desc ? 'last Read ECU' : '';
    if (!desc) {
      const b = await actions.textDialog(
        'Trace editor',
        'No control unit has been read yet.\n\n' +
          'Read one first (Process ECU, Read ECU), or open an FSW_PSW.TRC ' +
          'saved by NCS Expert or by this app.',
        ['Open .TRC file...', 'Cancel'],
        true
      );
      if (b.button !== 'Open .TRC file...') return;
      const got = await pickFile();
      if (!got) return;
      trc = got.text;
      desc = await describeImported(trc);
      if (!desc) return;
      origin = got.name;
    }
    const { rows, unknown } = ncsDummyRows(desc.fns, trc);
    if (!rows.length) {
      await actions.ncsError(
        'The trace names no function this control unit has.' +
          (unknown.length ? `\n\n${unknown.slice(0, 12).join('\n')}` : '')
      );
      return;
    }
    const sameModule =
      !!state.read &&
      String(state.read.mod.umrsg || state.read.mod.sgbd) ===
        String(desc.mod.umrsg || desc.mod.sgbd);
    const result = await editorWindow(desc, rows, unknown, origin, sameModule);
    if (!result) return;
    const f = ncsFiles();
    f.man = result.man.text;
    ncsSaveFiles(f);
    log(
      `TRACE EDITOR ${desc.mod.umrsg || desc.mod.sgbd}: ${result.man.count} change(s) to FSW_PSW.MAN`
    );
    if (result.button === 'download') {
      ncsDownload('FSW_PSW.MAN', result.man.text);
    }
    if (result.button === 'code') {
      await actions.codeEcu();
      return;
    }
    say(
      `FSW_PSW.MAN: ${result.man.count} change${result.man.count === 1 ? '' : 's'} for ${String(desc.mod.umrsg || desc.mod.sgbd).toUpperCase()}.`,
      sameModule
        ? 'Code the control unit with Execute job (SG_CODIEREN).'
        : 'Read the control unit (Process ECU), then Execute job (SG_CODIEREN).'
    );
  }

  /**
   * The table in its own window over NCS's.
   * @returns {Promise<{button: string, man: {text: string, count: number}}|null>}
   */
  function editorWindow(desc, rows, unknown, origin, canCode) {
    return new Promise((resolve) => {
      const picks = new Map();
      const shade = document.createElement('div');
      shade.className = 'wkfp-shade';
      const dlg = document.createElement('div');
      dlg.className = 'wkfp-dlg ncsd-dlg';
      dlg.setAttribute('role', 'dialog');
      const sg = String(desc.mod.umrsg || desc.mod.sgbd).toUpperCase();
      dlg.innerHTML =
        `<div class="wkfp-dlg-title"><span>Trace editor - ${esc(sg)}${
          desc.file ? ` (${esc(desc.file)})` : ''
        }</span><button class="wkfp-x" aria-label="Close">&#x2715;</button></div>` +
        '<div class="wkfp-dlg-body ncsd-body">' +
        '<div class="ncsd-bar">' +
        '<input class="wkfp-input ncsd-filter" type="search" placeholder="Filter (English or keyword)">' +
        '<label class="ncsd-only"><input type="checkbox" class="ncsd-changed"> Changed only</label>' +
        `<span class="ncsd-count"></span></div>` +
        `<div class="ncsd-origin">${esc(rows.length)} functions from ${esc(origin)}${
          unknown.length
            ? ` · ${esc(unknown.length)} in the trace not in this coding file`
            : ''
        }</div>` +
        '<div class="ncsd-scroll"><table class="ncsd-table"><thead><tr>' +
        '<th>Function</th><th>Holds</th><th>Set to</th></tr></thead>' +
        '<tbody></tbody></table></div></div>' +
        '<div class="wkfp-dlg-btns">' +
        (canCode
          ? '<button class="wkfp-btn" data-b="code">Save &amp; code ECU</button>'
          : '') +
        '<button class="wkfp-btn" data-b="save">Save FSW_PSW.MAN</button>' +
        '<button class="wkfp-btn" data-b="download">Save &amp; download</button>' +
        '<button class="wkfp-btn" data-b="cancel">Cancel</button></div>';
      shade.appendChild(dlg);
      win.appendChild(shade);
      if (typeof wkfpDraggable === 'function') wkfpDraggable(dlg);

      const body = dlg.querySelector('tbody');
      const filter = dlg.querySelector('.ncsd-filter');
      const onlyChanged = dlg.querySelector('.ncsd-changed');
      const count = dlg.querySelector('.ncsd-count');
      const optText = (o) =>
        o.label
          ? `${o.label}  (${o.name})`
          : `${o.name}${o.hex && !/^wert_/i.test(o.name) ? `  = ${o.hex}` : ''}`;

      const trs = rows.map((r) => {
        const tr = document.createElement('tr');
        const cur = r.options.find(
          (o) => o.name.toLowerCase() === r.psw.toLowerCase()
        );
        tr.innerHTML =
          `<td><div class="ncsd-en">${esc(r.label || r.fsw)}</div>` +
          (r.label ? `<div class="ncsd-kw">${esc(r.fsw)}</div>` : '') +
          '</td>' +
          `<td><div>${esc(cur && cur.label ? cur.label : r.psw)}</div>` +
          `<div class="ncsd-kw">${esc(cur && cur.label ? r.psw : '')}${
            r.hex ? ` ${esc(r.hex)}` : ''
          }</div></td>` +
          '<td><select class="wkfp-input ncsd-sel"></select></td>';
        const sel = tr.querySelector('select');
        r.options.forEach((o, i) => {
          const op = document.createElement('option');
          op.value = String(i);
          op.textContent = optText(o);
          if (cur === o) op.selected = true;
          sel.appendChild(op);
        });
        sel.onchange = () => {
          const o = r.options[Number(sel.value)];
          if (o.name.toLowerCase() === r.psw.toLowerCase()) picks.delete(r.fsw);
          else picks.set(r.fsw, o.name);
          tr.classList.toggle('ncsd-changed-row', picks.has(r.fsw));
          refresh();
        };
        tr.dataset.text = `${r.label} ${r.fsw} ${r.options
          .map((o) => `${o.label} ${o.name}`)
          .join(' ')}`.toLowerCase();
        body.appendChild(tr);
        return { tr, r };
      });

      function refresh() {
        const q = filter.value.trim().toLowerCase();
        let shown = 0;
        for (const { tr, r } of trs) {
          const on =
            (!q || tr.dataset.text.includes(q)) &&
            (!onlyChanged.checked || picks.has(r.fsw));
          tr.hidden = !on;
          if (on) shown++;
        }
        count.textContent = `${shown} shown · ${picks.size} changed`;
        const code = dlg.querySelector('[data-b="code"]');
        if (code) code.disabled = !picks.size;
      }
      filter.oninput = refresh;
      onlyChanged.onchange = refresh;
      refresh();

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close('cancel');
        } else if (/^F\d$/.test(e.key)) {
          e.preventDefault();
          e.stopPropagation();
        }
      };
      document.addEventListener('keydown', onKey, true);
      function close(button) {
        shade.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(
          button === 'cancel' ? null : { button, man: ncsDummyMan(rows, picks) }
        );
      }
      dlg.querySelector('.wkfp-x').onclick = () => close('cancel');
      dlg
        .querySelectorAll('.wkfp-dlg-btns .wkfp-btn')
        .forEach((b) => (b.onclick = () => close(b.dataset.b)));
      filter.focus();
    });
  }

  return { traceEditor };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ncsDummyRows, ncsDummyMan, ncsDummyVariant };
}
if (typeof window !== 'undefined') {
  window.ncsBindDummy = ncsBindDummy;
}
