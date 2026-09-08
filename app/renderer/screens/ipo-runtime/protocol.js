/**
 * @file The whole-vehicle protocol as data. A script's "read every module"
 * key puts FS_LESEN on the wire per group and writes a text file; the
 * runtime also kept every answer. This joins those answers with the app's
 * fault dictionaries (names, P-codes, the lookup), draws them the way the
 * module error scan draws its result, and prints them like its report.
 * INPA's own text stays one toggle away, and is what F9 prints below the
 * table.
 */

/** the fault-memory reads a whole-vehicle script sends per module */
const IPO_FAULT_READ_RE = /^(FS|IS)_LESEN$/;
/** the per-fault detail read the same script sends afterwards */
const IPO_FAULT_DETAIL_RE = /^(FS|IS)_LESEN_DETAIL$/;
/** the protocol's overview line: "MRS4 2    Airbag ..." / "D_009C *    Cabrio ..." */
const IPO_PROTOCOL_OVERVIEW_RE = /^(\S+)\s+(\d+|\*)\s+(\S.*)$/;

/**
 * @typedef {object} IpoWireRead
 * @property {string} target - the SGBD the script named (a group, or a variant)
 * @property {string} [variant] - the SGBD that answered (VARIANTE)
 * @property {string} job
 * @property {string|null} [arg]
 * @property {object[]} [sets] - the job's data sets
 * @property {string} [error] - the failure, when nothing answered
 */

/**
 * @typedef {object} IpoProtocolModule
 * @property {string} sgbd - the variant that answered, lower-case
 * @property {string} via - the group it was reached through
 * @property {string} label - the module's name (the script's, or the app's)
 * @property {object[]} codes - FS_LESEN entries, detail merged in
 */

/**
 * @typedef {object} IpoProtocolReport
 * @property {IpoProtocolModule[]} modules - every module that answered, script order
 * @property {{target: string, label: string, error: string}[]} silent - addresses that did not
 * @property {boolean} showText - the viewer is on INPA's text, not the table
 */

/**
 * Fold what the read put on the wire into one record per module.
 * @param {IpoWireRead[]} reads - the body's wire log
 * @param {string[]} [lines] - the protocol's text (its overview names the modules)
 * @returns {IpoProtocolReport}
 */
function ipoProtocolReport(reads, lines) {
  const names = ipoProtocolNames(lines);
  const modules = new Map();
  const silent = new Map();
  for (const r of reads || []) {
    const job = String(r.job || '').toUpperCase();
    if (r.error) {
      if (IPO_FAULT_READ_RE.test(job) && !silent.has(r.target))
        silent.set(r.target, r.error);
      continue;
    }
    const sgbd = String(r.variant || r.target).toLowerCase();
    if (IPO_FAULT_READ_RE.test(job)) {
      silent.delete(r.target);
      const codes = (r.sets || []).filter((c) => c.F_HEX_CODE || c.F_ORT_NR);
      const m = modules.get(sgbd);
      if (!m) {
        modules.set(sgbd, {
          sgbd,
          via: String(r.target).toLowerCase(),
          label:
            names.get(sgbd) ||
            names.get(String(r.target).toLowerCase()) ||
            sgbd,
          codes,
        });
      } else if (codes.length && !m.codes.length) {
        m.codes = codes;
      }
    } else if (IPO_FAULT_DETAIL_RE.test(job)) {
      const m = modules.get(sgbd);
      if (!m) continue;
      const nr = ipoProtocolFaultNr(r.arg);
      const code = m.codes.find((c) => Number(c.F_ORT_NR) === nr);
      const det = code ? ipoProtocolMatchDetail(r.sets, nr) : null;
      if (det) {
        // the detail's own hex/text never replace the memory's (wire.js
        // keeps them the same way)
        const { F_HEX_CODE, F_ORT_TEXT, ...rich } = det;
        Object.assign(code, rich);
      }
    }
  }
  // a group the script asked again by its variant name is one module
  return {
    modules: [...modules.values()],
    silent: [...silent.entries()].map(([target, error]) => ({
      target,
      label: names.get(target) || target.toUpperCase(),
      error,
    })),
    showText: false,
  };
}

/**
 * The detail set for one fault: the set that names the number, else -- when
 * no set names any number -- the one carrying a P-code or hex (the same
 * rule the module error scan applies, sweep/wire.js matchDetail).
 * @param {object[]} sets - the detail job's data sets
 * @param {number} nr - the fault number asked about
 * @returns {object|null}
 */
function ipoProtocolMatchDetail(sets, nr) {
  const list = sets || [];
  const named = list.find((s) => Number(s.F_ORT_NR) === nr);
  if (named) return named;
  if (list.some((s) => s.F_ORT_NR != null)) return null;
  return list.find((s) => s.F_PCODE_STRING || s.F_HEX_CODE) || null;
}

/**
 * The fault number a detail read was asked about ("0x1F", "31").
 * @param {string|null|undefined} arg
 * @returns {number}
 */
function ipoProtocolFaultNr(arg) {
  const s = String(arg == null ? '' : arg).trim();
  return /^0x/i.test(s) ? parseInt(s.slice(2), 16) : parseInt(s, 10);
}

/**
 * Module names from the protocol's overview table, keyed by the SGBD or
 * group name in lower case.
 * @param {string[]} [lines]
 * @returns {Map<string, string>}
 */
function ipoProtocolNames(lines) {
  const names = new Map();
  for (const l of lines || []) {
    const m = IPO_PROTOCOL_OVERVIEW_RE.exec(String(l).trim());
    if (m && /^[A-Za-z0-9_]+$/.test(m[1]))
      names.set(m[1].toLowerCase(), m[3].trim());
  }
  return names;
}

/**
 * Draw the report into the module view: the scan's rows (one per module,
 * fault detail rows under those with faults, "no response" for the silent
 * ones) with a toggle to INPA's own text.
 * @param {HTMLElement} el - the screen area
 * @param {object} p - the running program (its view carries the report)
 * @returns {Promise<void>}
 */
async function ipoProtocolRender(el, p) {
  const view = p.view;
  const rep = view && view.report;
  if (!rep) return;
  const withFaults = rep.modules.filter((m) => m.codes.length);
  const total = withFaults.reduce((n, m) => n + m.codes.length, 0);
  const head =
    `${withFaults.length} module${withFaults.length === 1 ? '' : 's'} with faults · ` +
    `${total} fault${total === 1 ? '' : 's'} · ` +
    `${rep.modules.length} read · ${rep.silent.length} no response`;
  // the bar (counts + the toggle) stays whichever side is showing
  el.innerHTML =
    `<div class="quick-sweep ipo-protocol-report">` +
    `<div class="quick-bar"><div class="quick-head">${esc(head)}</div>` +
    `<div class="quick-bar-btns"><button class="btn ipo-protocol-toggle"></button></div></div>` +
    `<div class="quick-rows"></div>` +
    `<pre class="ipo-protocol mono" hidden></pre></div>`;
  const rowsEl = el.querySelector('.quick-rows');
  const pre = el.querySelector('.ipo-protocol');
  const toggle = el.querySelector('.ipo-protocol-toggle');
  pre.textContent = (view.lines || []).join('\n');
  const side = () => {
    rowsEl.hidden = !!rep.showText;
    pre.hidden = !rep.showText;
    toggle.textContent = rep.showText ? 'Report' : 'INPA text';
  };
  toggle.onclick = () => {
    rep.showText = !rep.showText;
    side();
  };
  side();
  if (typeof loadFaultDb === 'function') await loadFaultDb();
  if (p.view !== view) return; // the script moved on while the DB loaded
  for (const m of rep.modules) {
    const row = addSweepRow(rowsEl, ipoText(m.label || m.sgbd));
    if (!m.codes.length) {
      row.classList.add('clean');
      row.querySelector('.quick-status').textContent = 'OK';
    } else {
      // the scan's row: the count and a Clear that runs FS_LOESCHEN on the
      // module and re-reads it (sweep/rows.js clearModule)
      row.classList.add('has-faults');
      const f = { row, codes: m.codes, ecu: { sgbd: m.sgbd, label: m.label } };
      setRowFaultStatus(f);
      appendFaultDetailRows(row, m.codes, m.sgbd);
      ipoProtocolLinkLookup(row.nextElementSibling, m);
      ipoProtocolBetterLabel(m, row, f);
      continue;
    }
    ipoProtocolBetterLabel(m, row, null);
  }
  for (const s of rep.silent) {
    const row = addSweepRow(rowsEl, ipoText(s.label));
    setRowNoResponse(row, 'no response');
  }
}

/**
 * The app's own name for the variant (the chassis config's), once it is
 * known: the script's German label is what the row shows until then.
 * @param {IpoProtocolModule} m
 * @param {HTMLElement} row
 * @param {object|null} f - the row's clear record, whose label follows
 * @returns {void}
 */
function ipoProtocolBetterLabel(m, row, f) {
  if (typeof variantLabel !== 'function') return;
  variantLabel(m.sgbd)
    .then((name) => {
      if (name && row.isConnected) {
        m.label = name;
        if (f) f.ecu.label = name;
        setRowLabel(row, name, `${m.sgbd} via ${m.via}`);
      }
    })
    .catch(() => {});
}

/**
 * Each fault detail row opens the Fault Lookup on that code.
 * @param {HTMLElement|null} detailEl - the rows appendFaultDetailRows added
 * @param {IpoProtocolModule} m
 * @returns {void}
 */
function ipoProtocolLinkLookup(detailEl, m) {
  if (!detailEl || typeof setDtcParam !== 'function') return;
  const rows = detailEl.querySelectorAll('.quick-detail-row');
  rows.forEach((row, i) => {
    const c = m.codes[i];
    if (!c) return;
    const ff = faultFields(c, m.sgbd);
    row.classList.add('ipo-protocol-link');
    row.title = 'Open in Fault Lookup';
    row.onclick = () => {
      setDtcParam(hexText(c.F_HEX_CODE) || ff.code, m.sgbd, ff.name);
      if (typeof showLookup === 'function') showLookup();
    };
  });
}

/**
 * The printed sheet's sections for a protocol: the scan report's tables per
 * module with faults, the silent addresses, then INPA's own text.
 * @param {object} view - the program's view ({lines, report})
 * @returns {object[]} print sections (core/print.js)
 */
function ipoProtocolPrintSections(view) {
  const rep = view.report;
  const sections = [];
  const text = {
    html: `<pre class="pr-screen">${esc((view.lines || []).join('\n'))}</pre>`,
  };
  // the scan report's table helpers (sweep/report.js) draw the tables; a
  // page without them still prints INPA's text
  if (
    typeof faultColumns !== 'function' ||
    typeof printFaultTable !== 'function'
  )
    return [text];
  const withFaults = rep.modules.filter((m) => m.codes.length);
  const columns = faultColumns();
  if (!withFaults.length) {
    sections.push(
      printHtml(
        `<p class="pr-p">No stored faults. ${rep.modules.length} module` +
          `${rep.modules.length === 1 ? '' : 's'} read, ${rep.silent.length} did not answer.</p>`
      )
    );
  }
  for (const m of withFaults) {
    sections.push(
      printHeading(
        `${ipoText(m.label)}  ·  ${m.sgbd}  ·  ` +
          `${m.codes.length} fault${m.codes.length === 1 ? '' : 's'}`
      )
    );
    sections.push({
      html: printFaultTable(
        { ecu: { sgbd: m.sgbd, label: ipoText(m.label) }, codes: m.codes },
        columns
      ),
    });
  }
  if (rep.silent.length) {
    sections.push(
      printHtml(
        `<p class="pr-p">No response: ${esc(
          rep.silent.map((s) => ipoText(s.label)).join(', ')
        )}</p>`
      )
    );
  }
  sections.push(printHeading("INPA's protocol"));
  sections.push(text);
  return sections;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipoProtocolReport,
    ipoProtocolNames,
    ipoProtocolFaultNr,
    ipoProtocolPrintSections,
  };
}
