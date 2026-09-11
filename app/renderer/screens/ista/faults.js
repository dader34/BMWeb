/**
 * @file Troubleshooting / Fault memory, and the fault detail dialog.
 *
 * WHAT THIS REPLACES. The tab used to open INPA's whole-car script, which
 * put a black terminal with F-keys inside the workshop chrome -- a different
 * tool wearing this one's frame. ISTA shows a flat TABLE of every fault on
 * the car, whichever module it came from, and that is what this draws.
 *
 * IT READS NOTHING. The table is built from the newest scan the Garage
 * already holds. A tab must never wake a car nobody asked it to touch, so
 * the read lives where ISTA puts it: the "Start vehicle test" button on
 * Vehicle details and the Control unit list. With no stored scan the table
 * is empty and the status line says 0 / 0, which is the honest answer.
 *
 * THE WIRE DATA IS NOT NORMALISED. `codes[]` in a stored scan is raw
 * EDIABAS FS_LESEN output and its fields vary by SGBD, so every row goes
 * through faultFields(c, sgbd) -- the same projection the fault screen uses
 * -- rather than reading F_* here. The fault DB is SGBD-scoped for the same
 * reason: 27C3 is an oil-level fault on one engine and something else
 * entirely on another, and the flat table cannot tell them apart.
 */

/* exported istaFaultRows istaPageFaultMemory istaFaultDialog istaPageSae */

/**
 * One row of the fault table.
 * @typedef {object} IstaFaultRow
 * @property {string} code - the fault code, as a workshop writes it
 * @property {string} desc - what it means
 * @property {string} km - the odometer at the read, or ''
 * @property {boolean} present - is it there now?
 * @property {string} sgbd - the module it came from
 * @property {string} module - that module's display name
 * @property {object} raw - the wire row, for the detail dialog
 */

/**
 * Every fault in a stored scan, flattened across modules.
 *
 * ISTA's table is the whole car at once: a technician reads down it, not
 * module by module. The module each fault came from is carried anyway,
 * because Delete fault memory clears ONE module and has to know which.
 * @param {object|null} report - a stored scan's report
 * @returns {IstaFaultRow[]}
 */
function istaFaultRows(report) {
  const out = [];
  for (const m of (report && report.modules) || []) {
    const sgbd = m.sgbd || m.via || '';
    for (const c of m.codes || []) {
      const f =
        typeof faultFields === 'function'
          ? faultFields(c, sgbd)
          : { code: c.F_HEX_CODE || '', name: '', present: false };
      // the odometer rides in the freeze frame, not in the fault row; the
      // env pairs are label/value text, so the reading is found by its label
      let km = '';
      const pairs = typeof envPairs === 'function' ? envPairs(c) : [];
      for (const [k, v] of pairs)
        if (/km|mileage|kilometer|laufleistung/i.test(k)) {
          km = String(v).replace(/[^0-9]/g, '');
          break;
        }
      out.push({
        code: f.code || '',
        desc: f.name || '',
        km,
        present: !!f.present,
        sgbd,
        module: m.label || sgbd,
        raw: c,
      });
    }
  }
  return out;
}

/**
 * The newest stored scan for a car, or null.
 * @param {object|null} car - the picked GarageCar
 * @returns {object|null} the scan
 */
function istaNewestScan(car) {
  if (!car || typeof garageScans !== 'function') return null;
  const scans = garageScans(car.id) || [];
  return scans.find((s) => s.kind === 'faults') || scans[0] || null;
}

/**
 * Troubleshooting / Fault memory.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - the shell's hooks
 * @param {object|null} ctx.car - the picked GarageCar
 * @param {(row: IstaFaultRow|null) => void} ctx.onPick - selection changed
 * @returns {IstaFaultRow[]} the rows drawn
 */
function istaPageFaultMemory(host, ctx) {
  const scan = istaNewestScan(ctx.car);
  const rows = istaFaultRows(scan && scan.report);
  const filter = ctx.filter || '';
  const shown = filter ? rows.filter((r) => r.sgbd === filter) : rows;

  const body = shown
    .map(
      (r, i) =>
        `<tr data-i="${i}">` +
        `<td>${esc(r.code)}</td>` +
        `<td>${esc(r.desc)}</td>` +
        `<td>${esc(r.km || '')}</td>` +
        `<td>${r.present ? 'yes' : 'No'}</td>` +
        `<td>-</td></tr>`
    )
    .join('');

  host.innerHTML =
    `<table class="irtable irfaults"><thead><tr>` +
    `<th>Code</th><th>Description</th><th>Mileage</th>` +
    `<th>Existent</th><th>Class</th>` +
    `</tr></thead><tbody>${body}</tbody></table>` +
    (rows.length
      ? ''
      : `<div class="irvin-empty">No fault memory has been read on this ` +
        `vehicle yet. Run Start vehicle test on Vehicle details or the ` +
        `Control unit list.</div>`);

  host.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
    tr.onclick = () => {
      host.querySelectorAll('tbody tr.sel').forEach((x) => {
        x.classList.remove('sel');
      });
      tr.classList.add('sel');
      if (ctx.onPick) ctx.onPick(shown[Number(tr.dataset.i)]);
    };
    tr.ondblclick = () => istaFaultDialog(shown[Number(tr.dataset.i)]);
  });
  return shown;
}

/**
 * The fault detail dialog: Description, Details, System context.
 *
 * The three tabs are three different questions about one fault: what it
 * means, what the ECU recorded about it, and what the car was doing when it
 * was stored. Each is filled from what the scan actually carries, and says
 * "-" where the SGBD returned nothing -- a freeze frame is optional and many
 * modules ship none.
 * @param {IstaFaultRow} row - the picked fault
 * @returns {void}
 */
function istaFaultDialog(row) {
  if (!row || typeof openModal !== 'function') return;
  let tab = 'description';
  const c = row.raw || {};

  const title = `${row.module} ${row.code} ${row.desc}`;
  const html =
    `<div class="modal irfd" role="dialog" aria-modal="true">` +
    `<div class="modal-title irfd-title">${esc(title)}</div>` +
    `<div class="irfd-tabs"></div>` +
    `<div class="irfd-host"></div>` +
    `<div class="modal-actions irfd-actions">` +
    `<button type="button" class="btn irfd-back" disabled>Back</button>` +
    `<button type="button" class="btn irfd-fwd" disabled>Forward</button>` +
    `<button type="button" class="btn irfd-close">Close</button>` +
    `</div></div>`;
  const { overlay, close } = openModal(html);

  /** The two-column Description table. */
  function descriptionHtml() {
    // the ISTA document for this fault where the lookup data links one; its
    // chapters are the tool's own rows, so they are shown as they come
    const doc =
      typeof istaTestFor === 'function' ? istaTestFor(row.desc) : null;
    const rows = [['Fault description', row.desc || '-']];
    for (const ch of (doc && doc.chapters) || [])
      rows.push([ch.heading || '', (ch.paras || []).join('\n')]);
    if (!doc)
      for (const k of [
        'Condition for fault identification',
        'Condition for fault memory entry',
        'Action in service',
        'Note on effect of fault',
        'Driver information',
        'Service instruction',
      ])
        rows.push([k, '-']);
    return (
      `<table class="irtable irfd-two"><tbody>` +
      rows
        .map(
          ([k, v]) =>
            `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`
        )
        .join('') +
      `</tbody></table>`
    );
  }

  /** What the ECU recorded: the fault's own counters and status. */
  function detailsHtml() {
    const f = typeof faultFields === 'function' ? faultFields(c, row.sgbd) : {};
    const head = [
      ['Fault code', row.code || '-'],
      ['Fault class', '-'],
      ['Fault text', row.desc || '-'],
      ['Fault types', f.ftype || '-'],
      ['Occurrence [km]', row.km || '-'],
      ['Frequency', f.count || '-'],
    ];
    return (
      `<table class="irtable irfd-two"><tbody>` +
      head
        .map(
          ([k, v]) =>
            `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`
        )
        .join('') +
      `</tbody></table>`
    );
  }

  /** The freeze frame: what the car was doing when it was stored. */
  function contextHtml() {
    const pairs = typeof envPairs === 'function' ? envPairs(c) : [];
    if (!pairs.length)
      return (
        `<div class="irgrey-w">This module stored no ambient conditions ` +
        `with the fault.</div>`
      );
    return (
      `<table class="irtable"><thead><tr>` +
      `<th>Condition</th><th>First entry</th></tr></thead><tbody>` +
      pairs
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join('') +
      `</tbody></table>`
    );
  }

  /** Redraw the tab strip and the body. */
  function paint() {
    const strip = overlay.querySelector('.irfd-tabs');
    const tabs = [
      ['description', 'Description'],
      ['details', 'Details'],
      ['context', 'System context'],
    ];
    strip.innerHTML = tabs
      .map(
        ([id, label]) =>
          `<button type="button" class="iradmin-tab${
            id === tab ? ' on' : ''
          }" data-t="${id}">${esc(label)}</button>`
      )
      .join('');
    strip.querySelectorAll('[data-t]').forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.t;
        paint();
      };
    });
    overlay.querySelector('.irfd-host').innerHTML =
      tab === 'description'
        ? descriptionHtml()
        : tab === 'details'
          ? detailsHtml()
          : contextHtml();
  }

  overlay.querySelector('.irfd-close').onclick = () => close();
  paint();
}

/**
 * Troubleshooting / SAE fault code input.
 *
 * Two boxes, one table. A SAE P-code is looked back to the BMW code that
 * carries it and then to its text; a BMW code goes the other way. The
 * mapping is BMW's own (data/pcodes.js, from ISTA), and a code with several
 * variant-gated alternates lists them all rather than guessing one.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - the shell's hooks
 * @returns {void}
 */
function istaPageSae(host, ctx) {
  host.innerHTML =
    `<div class="irsae">` +
    `<div class="irsae-form">` +
    `<label class="irsae-f"><span>SAE fault code input</span>` +
    `<input class="irvin-box" id="ista-sae" maxlength="8" ` +
    `autocomplete="off" /></label>` +
    `<label class="irsae-f"><span>Fault code input</span>` +
    `<input class="irvin-box" id="ista-bmw" maxlength="8" ` +
    `autocomplete="off" /></label>` +
    `</div>` +
    `<table class="irtable"><thead><tr>` +
    `<th>SAE fault code</th><th>Code</th><th>Fault text</th>` +
    `</tr></thead><tbody id="ista-sae-rows"></tbody></table>` +
    `</div>`;

  const tb = host.querySelector('#ista-sae-rows');
  const sae = host.querySelector('#ista-sae');
  const bmw = host.querySelector('#ista-bmw');

  /** Look up whatever is in the boxes and draw the rows. */
  const run = () => {
    const p = String(sae.value || '')
      .trim()
      .toUpperCase();
    const b = String(bmw.value || '')
      .trim()
      .toUpperCase();
    /** @type {Array<[string, string, string]>} */
    const found = [];
    if (p && typeof hexForPcode === 'function') {
      const hex = hexForPcode(p);
      if (hex)
        found.push([
          p,
          hex,
          typeof faultName === 'function' ? faultName('', hex, '') : '',
        ]);
    }
    if (b) {
      const ps =
        typeof pcodesForHex === 'function' ? pcodesForHex(b) || [] : [];
      const text = typeof faultName === 'function' ? faultName('', b, '') : '';
      if (ps.length) for (const one of ps) found.push([one, b, text]);
      else found.push(['-', b, text]);
    }
    tb.innerHTML = found.length
      ? found
          .map(
            ([a, code, text]) =>
              `<tr><td>${esc(a)}</td><td>${esc(code)}</td>` +
              `<td>${esc(text || '-')}</td></tr>`
          )
          .join('')
      : '';
    if (ctx && ctx.onRows) ctx.onRows(found);
  };
  sae.oninput = run;
  bmw.oninput = run;
  // the P-code table is a separate load; a page that opens before it lands
  // simply finds nothing until it does
  if (typeof loadPcodes === 'function')
    Promise.resolve(loadPcodes())
      .then(() => {
        if (host.isConnected) run();
      })
      .catch(() => {
        /* the mapping is optional */
      });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    istaFaultRows,
    istaNewestScan,
    istaPageFaultMemory,
    istaFaultDialog,
    istaPageSae,
  };
}
