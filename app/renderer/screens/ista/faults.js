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

/* exported istaFaultRows istaPageFaultMemory istaFaultDialog istaPageSae
   istaEnvFind */

/**
 * The first environment value whose label matches.
 *
 * The env rows are label/value text straight off the module, and their names
 * vary by SGBD, so a column is found by what its label says rather than by
 * a fixed result name.
 * @param {Array<[string, string]>} pairs - the env rows
 * @param {RegExp} re - what the label should look like
 * @returns {string} the value, or ''
 */
function istaEnvFind(pairs, re) {
  for (const [k, v] of pairs || []) if (re.test(k)) return String(v);
  return '';
}

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
    `<div class="modal-title irfd-title">${esc(title)}` +
    `<span class="irfd-icons">` +
    `<button type="button" class="irfd-print" aria-label="Print">` +
    `${typeof istaRealIcon === 'function' ? istaRealIcon('print') : ''}` +
    `</button>` +
    `<button type="button" class="irfd-x" aria-label="Close">` +
    `${typeof istaRealIcon === 'function' ? istaRealIcon('close') : ''}` +
    `</button></span></div>` +
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
    // a fault the reader reached from the SAE box was never read off this
    // car, so it has no recorded detail at all; saying "-" there would claim
    // the module answered and gave nothing
    if (!row.sgbd)
      return (
        `<div class="irgrey-w">This fault code was looked up, not read on ` +
        `this car, so there is nothing the module recorded about it.</div>`
      );
    const f = typeof faultFields === 'function' ? faultFields(c, row.sgbd) : {};
    const pairs = typeof envPairs === 'function' ? envPairs(c) : [];
    const head = [
      ['Fault code', row.code || '-'],
      ['Fault class', '-'],
      ['Fault text', row.desc || '-'],
      [
        'Fault types',
        row.present ? 'Fault currently present' : 'Fault currently not present',
      ],
      ['Occurrence [km]', row.km || '-'],
      ['Occurrence time [s]', istaEnvFind(pairs, /zeit|time/i) || '-'],
      ['Frequency', f.count || '-'],
    ];
    // everything else the module returned, under the tool's own heading:
    // an unparsed name is still a fact the module reported, and dropping the
    // rows this build has no label for would hide exactly what a technician
    // came here to see
    const known = /km|mileage|kilometer|laufleistung|zeit|time/i;
    const rest = pairs.filter(([k]) => !known.test(k));
    return (
      `<table class="irtable irfd-two"><tbody>` +
      head
        .map(
          ([k, v]) =>
            `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`
        )
        .join('') +
      `</tbody></table>` +
      (rest.length
        ? `<div class="irfd-sub">Fault memory ambient conditions</div>` +
          `<table class="irtable"><thead><tr>` +
          `<th>Condition</th><th>First entry</th></tr></thead><tbody>` +
          rest
            .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
            .join('') +
          `</tbody></table>`
        : '')
    );
  }

  /** The freeze frame: what the car was doing when it was stored. */
  function contextHtml() {
    if (!row.sgbd)
      return (
        `<div class="irgrey-w">This fault code was looked up, not read on ` +
        `this car, so there is no ambient snapshot for it.</div>`
      );
    const pairs = typeof envPairs === 'function' ? envPairs(c) : [];
    // the tool's eight columns, filled from whichever env rows map onto
    // them; a module that supplies none of them still gets its own rows
    // listed below rather than an empty page
    const want = [
      ['Timestamp', /zeit|time|stamp/i],
      ['Mileage', /km|mileage|kilometer|laufleistung/i],
      ['Vehicle voltage', /spannung|voltage|batt/i],
      ['Outdoor temp.', /aussen|ambient|outdoor/i],
      ['Engine temp.', /motor.*temp|coolant|kuehl/i],
      ['Terminal', /klemme|terminal/i],
      ['Velocity', /geschw|speed|velocit/i],
      ['Engine speed', /drehzahl|rpm|engine speed/i],
    ];
    const mapped = want.map(([label, re]) => [
      label,
      istaEnvFind(pairs, re) || '-',
    ]);
    const used = new Set();
    for (const [, re] of want)
      for (const [k] of pairs) if (re.test(k)) used.add(k);
    const rest = pairs.filter(([k]) => !used.has(k));
    return (
      `<table class="irtable irfd-two"><tbody>` +
      mapped
        .map(
          ([k, v]) =>
            `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`
        )
        .join('') +
      `</tbody></table>` +
      (rest.length
        ? `<div class="irfd-sub">Also recorded</div>` +
          `<table class="irtable"><tbody>` +
          rest
            .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
            .join('') +
          `</tbody></table>`
        : !pairs.length
          ? `<div class="irgrey-w">This module stored no ambient ` +
            `conditions with the fault.</div>`
          : '')
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
  const x = overlay.querySelector('.irfd-x');
  if (x) x.onclick = () => close();
  const pr = overlay.querySelector('.irfd-print');
  if (pr) pr.onclick = () => window.print();
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

  /**
   * The text for a code, resolved the way the Fault Lookup app resolves it.
   *
   * THE CAR'S OWN MODULES COME FIRST. The flat fault table collides across
   * ECU families: 2761 is the secondary-air fault on the E46's MS45 and
   * something else entirely on another engine, and only the SGBD's own table
   * can tell them apart. So every module this car carries is asked in turn,
   * and the shared table is the fallback rather than the answer.
   * @param {string} code - the BMW hex code
   * @returns {{text: string, sgbd: string}} the text and which module knew it
   */
  const textFor = (code) => {
    if (typeof faultName !== 'function') return { text: '', sgbd: '' };
    for (const sgbd of ctx && ctx.sgbds ? ctx.sgbds : []) {
      const own =
        typeof scopedFaultDb === 'function' ? scopedFaultDb(sgbd) : null;
      if (own && own[code]) {
        const t = faultName('', code, sgbd);
        if (t) return { text: t, sgbd };
      }
    }
    return { text: faultName('', code, '') || '', sgbd: '' };
  };

  /** Look up whatever is in the boxes and draw the rows. */
  const run = () => {
    const p = String(sae.value || '')
      .trim()
      .toUpperCase();
    const b = String(bmw.value || '')
      .trim()
      .toUpperCase();
    /** @type {Array<[string, string, string, string]>} */
    const found = [];
    if (p && typeof hexForPcode === 'function') {
      const hex = hexForPcode(p);
      if (hex) {
        const t = textFor(hex);
        found.push([p, hex, t.text, t.sgbd]);
      }
    }
    if (b) {
      const ps =
        typeof pcodesForHex === 'function' ? pcodesForHex(b) || [] : [];
      const t = textFor(b);
      if (ps.length) for (const one of ps) found.push([one, b, t.text, t.sgbd]);
      else found.push(['-', b, t.text, t.sgbd]);
    }
    tb.innerHTML = found.length
      ? found
          .map(
            ([a, code, text, sgbd]) =>
              `<tr><td>${esc(a)}</td><td>${esc(code)}</td>` +
              `<td>${esc(text || '-')}` +
              // which module's table answered, when one did: the same code
              // reads differently on another engine and the row says whose
              (sgbd ? ` <span class="irsae-of">(${esc(sgbd)})</span>` : '') +
              `</td></tr>`
          )
          .join('')
      : '';
    if (ctx && ctx.onRows) ctx.onRows(found);
  };
  sae.oninput = run;
  bmw.oninput = run;
  // the P-code table and the fault texts are separate loads; a page that
  // opens before they land simply finds nothing until they do
  Promise.all([
    typeof loadPcodes === 'function' ? loadPcodes() : null,
    typeof loadFaultDb === 'function' ? loadFaultDb() : null,
  ])
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
    istaEnvFind,
    istaNewestScan,
    istaPageFaultMemory,
    istaFaultDialog,
    istaPageSae,
  };
}
