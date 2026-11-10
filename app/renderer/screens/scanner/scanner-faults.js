/**
 * @file BMWeb Scanner: the reference scanner's "Errors" window (TForm33 in
 * BMW Scanner 1.4.0.7) -- a unit's fault memory and shadow memory, each
 * fault as "code [ dec ]", its text, and the red / yellow marker for
 * "currently present" / "currently not present".
 *
 * Where each piece comes from:
 *  - the reads and the reply layouts: the reference's own telegrams on the
 *    E46 (USB capture, capture-frames.txt), module by module below;
 *  - the texts and the markers: the reference's own text routine
 *    (0x5B2618 / 0x5B26A0), run over its memory dump for every code and
 *    parameter of the variants its identification gave that car
 *    (core/generated/scanner-fault-texts.js);
 *  - the rows: its list filler 0x5B2E74 -- faults, or "no errors"; then,
 *    for a unit with a shadow memory, a blank row, "Shadow:" and its faults.
 */

/* exported SCANNER_FAULT_READ, scannerReadFaultList, scannerFaultText, scannerFaultCode, scannerErrorsWindow */

/**
 * How the reference reads each unit's fault list, as its adapter put it on
 * the line (capture) and as it parsed the answers (the oracle's codes and
 * parameters for the same answers):
 *   kwp      KWP2000 18 02 FF FF: count at byte 5, then code hi, code lo,
 *            status in threes
 *   blocks   DS2 04 00 count, then 04 n for each fault: code at byte 4,
 *            parameter at byte 5 (shadow: 14 00 / 14 n the same way)
 *   list     DS2 04 00 count, then one 04 01 answer with all the faults from
 *            byte 4, `size` bytes each, code at `code`, parameter at `param`
 *            (shadow: 14 00 / 14 01 the same way)
 *   inline   the 04 00 answer itself carries the faults (ZKE: from byte 6)
 *   lcm      eight blocks 04 01 .. 04 08 of pairs, which the reference files
 *            as the light module's shadow memory
 * @type {Object<string, object>}
 */
const SCANNER_FAULT_READ = {
  DME: { kwp: true },
  ABS: { kwp: true },
  EGS: { blocks: true },
  EWS: { blocks: true },
  SRS: { blocks: true, shadow: 'blocks', access: true },
  LEW: { list: { size: 3, code: 0, param: 2 } },
  'A/C': { list: { size: 2, code: 0, param: 1 } },
  IKE: { list: { size: 3, code: 0, param: 1 } },
  LCM: { lcm: true },
  ZKE: { inline: 6, shadow: 'inline' },
  AIC: { bare: true, list: { size: 2, code: 0, param: 1 } },
  SHD: { bare: true, list: { size: 2, code: 0, param: 1 } },
  TEL: { list: { size: 2, code: 0, param: 1 }, shadow: 'list' },
  SZM: { list: { size: 2, code: 0, param: 1 }, shadow: 'list' },
  SMF: { list: { size: 2, code: 0, param: 1 } },
};

/**
 * One fault as read.
 * @typedef {{code: number, param: number}} ScannerFault
 */

/**
 * Read a unit's faults the reference's way.
 * @param {ScannerLink} link
 * @param {ScannerModule} m
 * @param {{kwp: boolean, raw: number[]|null}} found - How it identified.
 * @returns {Promise<{errors: ScannerFault[]|null, shadow: ScannerFault[]|null}>}
 *   null for a list the unit does not have or did not give.
 */
async function scannerReadFaultList(link, m, found) {
  const how = SCANNER_FAULT_READ[m.name] || {
    list: { size: 2, code: 0, param: 1 },
  };
  const ok = (r) => !!r && r[2] === 0xa0;
  const ask = async (payload) => {
    try {
      const r = await link.ds2(m.address, payload);
      return ok(r) ? r : null;
    } catch (e) {
      return null;
    }
  };
  const pairs = (r, from, n, spec) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const at = from + i * spec.size;
      if (at + spec.size > r.length - 1) break;
      out.push({ code: r[at + spec.code], param: r[at + spec.param] });
    }
    return out;
  };

  if (how.kwp || found.kwp) {
    let r;
    try {
      r = await link.kwp(scannerKwpAddress(m), [0x18, 0x02, 0xff, 0xff]);
    } catch (e) {
      r = null;
    }
    if (!r || r[4] !== 0x58) return { errors: null, shadow: null };
    const out = [];
    for (let i = 0; i < r[5]; i++) {
      const at = 6 + 3 * i;
      if (at + 3 > r.length - 1) break;
      out.push({ code: (r[at] << 8) | r[at + 1], param: r[at + 2] });
    }
    return { errors: out, shadow: null };
  }

  const readList = async (svc, kind) => {
    const head = await ask(how.bare && svc === 0x04 ? [svc] : [svc, 0x00]);
    if (!head) return null;
    const n = head[3];
    if (kind === 'inline')
      return pairs(head, svc === 0x04 ? how.inline : 4, n, {
        size: 2,
        code: 0,
        param: 1,
      });
    if (n === 0) return [];
    if (kind === 'blocks') {
      const out = [];
      for (let i = 1; i <= n; i++) {
        const r = await ask([svc, i]);
        if (r && r.length > 6) out.push({ code: r[4], param: r[5] });
      }
      return out;
    }
    const spec = how.list || { size: 2, code: 0, param: 1 };
    const r = await ask([svc, 0x01]);
    return r ? pairs(r, 4, n, spec) : null;
  };

  if (how.lcm) {
    const head = await ask([0x04, 0x00]);
    const shadow = [];
    for (let blk = 1; blk <= 8; blk++) {
      const r = await ask([0x04, blk]);
      if (r && r[3])
        shadow.push(...pairs(r, 4, r[3], { size: 2, code: 0, param: 1 }));
    }
    return { errors: head ? [] : null, shadow: head ? shadow : null };
  }

  const kind = how.blocks ? 'blocks' : how.inline != null ? 'inline' : 'list';
  const errors = await readList(0x04, kind);
  let shadow = null;
  if (how.shadow) {
    if (how.access && found.raw && found.raw.length > 14) {
      await ask([0x90, 0xff, 0xff]);
      await ask([0x95, ...found.raw.slice(11, 15)]);
    }
    shadow = await readList(0x14, how.shadow);
  }
  return { errors, shadow };
}

/**
 * The code column: two hex digits and the decimal in three for a one-byte
 * code, four and five for a two-byte one -- "32 [ 050 ]", "27C3 [ 10179 ]".
 * @param {number} code
 * @returns {string}
 */
function scannerFaultCode(code) {
  const wide = code >= 0x100;
  const hex = code
    .toString(16)
    .toUpperCase()
    .padStart(wide ? 4 : 2, '0');
  const dec = String(code).padStart(wide ? 5 : 3, '0');
  return `${hex} [ ${dec} ]`;
}

/**
 * The text and marker the reference gives a fault: its table text (or its
 * own "Error number XX" for a code it has none for), the parameter's added
 * wording joined with ", ", and the marker -- 2 currently present (red),
 * 1 currently not present (yellow).
 * @param {string} unit - The module's short name.
 * @param {number} code
 * @param {number} param
 * @param {boolean} [shadow]
 * @returns {{text: string, state: number, known: boolean}}
 */
function scannerFaultText(unit, code, param, shadow = false) {
  const all =
    (typeof SCANNER_FAULT_TEXTS !== 'undefined' && SCANNER_FAULT_TEXTS) || {};
  const set = (shadow && all[unit] && all[unit].shadow) || all[unit];
  const hex = code.toString(16).toUpperCase();
  const fallback = `Error number ${hex.padStart(code >= 0x100 ? 4 : 2, '0')}`;
  if (!set) return { text: fallback, state: 1, known: false };
  const p = param & 0xff;
  const base = set.codes[hex];
  if (set.full && set.full[hex]) {
    const row = set.full[hex];
    const outcome = row.outcomes[row.index[p]];
    return {
      text: [base || fallback, ...outcome.slice(1)].join(', '),
      state: outcome[0],
      known: !!base,
    };
  }
  const state = set.state ? SCANNER_FAULT_ALPHABET.indexOf(set.state[p]) : 1;
  const suffix = (set.suffix && set.suffix[p]) || [];
  return {
    text: [base || fallback, ...suffix].join(', '),
    state,
    known: !!base,
  };
}

/**
 * The reference's Errors window for one unit: the rows of its list filler,
 * and its three buttons -- Read errors (read again), Clear errors (that
 * unit's own clear, then read again), Close.
 * @param {HTMLElement} win - The scanner window the dialog sits in.
 * @param {ScannerModule} m
 * @param {{kwp: boolean, raw: number[]|null}} found
 * @param {{read: () => Promise<{errors: ScannerFault[]|null, shadow: ScannerFault[]|null}>,
 *   clear: () => Promise<void>, initial?: object}} ops
 * @returns {Promise<void>}
 */
async function scannerErrorsWindow(win, m, found, ops) {
  const body = document.createElement('div');
  body.className = 'scn-errs';
  body.innerHTML = `
    <div class="scn-errs-list">
      <table class="scn-errs-table">
        <thead><tr><th></th><th>DTC, hex [dec]</th><th>Description</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="scn-errs-legend">
      <div><span class="scn-mark scn-mark-2"></span>Fault currently present</div>
      <div><span class="scn-mark scn-mark-1"></span>Fault currently not present</div>
    </div>`;
  const tbody = body.querySelector('tbody');
  const row = (mark, code, text, cls = '') => {
    const tr = document.createElement('tr');
    if (cls) tr.className = cls;
    tr.innerHTML = `<td>${mark ? `<span class="scn-mark scn-mark-${mark}"></span>` : ''}</td><td>${esc(code)}</td><td>${esc(text)}</td>`;
    tbody.appendChild(tr);
  };
  const paint = (res) => {
    tbody.innerHTML = '';
    const list = (faults, shadow) => {
      if (!faults) {
        row(0, 'unknown', '');
        return;
      }
      if (!faults.length) {
        row(4, 'no errors', '');
        return;
      }
      for (const f of faults) {
        const t = scannerFaultText(m.name, f.code, f.param, shadow);
        row(t.state, scannerFaultCode(f.code), t.text);
      }
    };
    list(res.errors, false);
    if (res.shadow) {
      row(0, '', '', 'scn-errs-gap');
      row(0, 'Shadow:', '', 'scn-errs-head');
      list(res.shadow, true);
    }
  };
  let busy = false;
  const run = async (fn) => {
    if (busy) return;
    busy = true;
    body.classList.add('scn-errs-busy');
    try {
      paint(await fn());
    } catch (e) {
      row(0, 'error', String((e && e.message) || e));
    }
    body.classList.remove('scn-errs-busy');
    busy = false;
  };
  const shown = run(() =>
    ops.initial ? Promise.resolve(ops.initial) : ops.read()
  );
  await wkfpDialog(win, {
    title: `Errors details - ${m.name}`,
    body,
    cls: 'scn-errsdlg',
    buttons: ['Read errors', 'Clear errors', 'Close'],
    check: (b) => {
      if (b === 'Read errors') {
        run(ops.read);
        return false;
      }
      if (b === 'Clear errors') {
        run(async () => {
          await ops.clear();
          return ops.read();
        });
        return false;
      }
      return true;
    },
  });
  await shown;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCANNER_FAULT_READ,
    scannerReadFaultList,
    scannerFaultText,
    scannerFaultCode,
  };
}
