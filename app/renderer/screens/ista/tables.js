/**
 * @file The ISTA pages that are a TABLE: Operations Finished and Active, the
 * Control unit list, Repair history, and the Service plan's three lists.
 *
 * Every one of these used to open an app screen inside the workshop chrome,
 * which put a second tool's layout inside this one's frame. They are all the
 * same shape in ISTA -- a header row, rows the reader picks from, a status
 * line counting them and a bottom bar acting on the selection -- so they are
 * all drawn here from data the app already holds, and none of them reads the
 * car.
 *
 * THE SERVICE PLAN IS NOT A SECOND FAULT LIST. Its rows are DOCUMENTS: the
 * procedures a stored fault points at, grouped under the fault that pointed
 * at them. That is why the group heading rows exist and why the Type column
 * carries a document class rather than a module name.
 */

/* exported istaPageFinished istaPageUnitList istaPageHistory
   istaPageServicePlan istaModuleGroups istaPageReport */

/** How ISTA colours a module's state square. */
const ISTA_STATE_CLASS = {
  ok: 'ok',
  faults: 'warn',
  silent: 'bad',
  unread: 'dim',
};

/**
 * Operations / Finished: every scan the Garage kept for this car.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - {car, onPick}
 * @returns {object[]} the scans drawn
 */
function istaPageFinished(host, ctx) {
  const car = ctx.car;
  const scans =
    car && typeof garageScans === 'function' ? garageScans(car.id) : [];
  const name =
    car && typeof garageCarLabel === 'function' ? garageCarLabel(car) : '';
  const body = scans
    .map((s, i) => {
      const sum = s.summary || {};
      // what the scan FOUND, in the tool's one-line form: a scan is a
      // result, not just an event, and the row has to say which
      const result =
        s.kind === 'ident'
          ? `${sum.modules || 0} modules identified`
          : `${sum.faults || 0} fault${sum.faults === 1 ? '' : 's'} in ` +
            `${sum.withFaults || 0} of ${sum.modules || 0} modules`;
      return (
        `<tr data-i="${i}">` +
        `<td>${esc(String(s.at || '').slice(0, 10))}</td>` +
        `<td>${esc((car && car.vin) || '-')}</td>` +
        `<td>${esc(name || '-')}</td>` +
        `<td>${esc(result)}</td></tr>`
      );
    })
    .join('');

  host.innerHTML =
    `<table class="irtable"><thead><tr>` +
    `<th>Date</th><th>VIN</th><th>Vehicle</th><th>Result</th>` +
    `</tr></thead><tbody>${body}</tbody></table>` +
    (scans.length
      ? ''
      : `<div class="irvin-empty">No operation has been finished on this ` +
        `vehicle yet.</div>`);

  host.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
    tr.onclick = () => {
      host.querySelectorAll('tbody tr.sel').forEach((x) => {
        x.classList.remove('sel');
      });
      tr.classList.add('sel');
      if (ctx.onPick) ctx.onPick(scans[Number(tr.dataset.i)]);
    };
  });
  return scans;
}

/**
 * Repair history: the same scans, in the tool's three columns.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - {car, onPick}
 * @returns {object[]} the scans drawn
 */
function istaPageHistory(host, ctx) {
  const car = ctx.car;
  const scans =
    car && typeof garageScans === 'function' ? garageScans(car.id) : [];
  const body = scans
    .map((s, i) => {
      const sum = s.summary || {};
      return (
        `<tr data-i="${i}">` +
        `<td>${esc(
          String(s.at || '')
            .replace('T', ' ')
            .slice(0, 16)
        )}</td>` +
        `<td>${s.kind === 'ident' ? 'Identification' : 'Vehicle test'}</td>` +
        `<td>${esc(
          s.kind === 'ident'
            ? `${sum.modules || 0} modules`
            : `${sum.faults || 0} faults, ${sum.silent || 0} silent`
        )}</td></tr>`
      );
    })
    .join('');
  host.innerHTML =
    `<table class="irtable"><thead><tr>` +
    `<th>Date</th><th>Type</th><th>Result</th>` +
    `</tr></thead><tbody>${body}</tbody></table>` +
    (scans.length
      ? ''
      : `<div class="irvin-empty">Nothing has been read on this vehicle ` +
        `yet.</div>`);
  host.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
    tr.onclick = () => {
      host.querySelectorAll('tbody tr.sel').forEach((x) => {
        x.classList.remove('sel');
      });
      tr.classList.add('sel');
      if (ctx.onPick) ctx.onPick(scans[Number(tr.dataset.i)]);
    };
  });
  return scans;
}

/**
 * Which of ISTA's three groups a config section belongs to.
 *
 * ISTA files every module under Power train, Chassis and suspension or Body.
 * The chassis config already groups its modules into sections with names of
 * its own (Engine, Transmission, Chassis, Body, Communication), so this is a
 * mapping between two vocabularies and not a guess about any one module:
 * engine and gearbox drive the car, the chassis section holds what steers
 * and stops it, and everything else is body.
 * @param {string} section - the config section's name
 * @returns {string} the ISTA group
 */
function istaModuleGroup(section) {
  const s = String(section || '').toLowerCase();
  if (/engine|motor|transmission|gearbox|getriebe/.test(s))
    return 'Power train';
  if (/chassis|brake|abs|dsc|steer|suspension|axle/.test(s))
    return 'Chassis and suspension';
  return 'Body';
}

/**
 * The chassis's modules, grouped the way ISTA groups them.
 * @param {object|null} config - a chassis config
 * @returns {Array<{name: string, ecus: object[]}>} the groups, in ISTA order
 */
function istaModuleGroups(config) {
  const order = [
    'Power train',
    'Chassis and suspension',
    'Body',
    'BMW Group Mobile Service',
  ];
  /** @type {Object<string, object[]>} */
  const by = {};
  for (const g of order) by[g] = [];
  for (const sec of (config && config.sections) || [])
    for (const ecu of sec.ecus || [])
      by[istaModuleGroup(sec.name)].push(
        Object.assign({ _section: sec.name }, ecu)
      );
  return order.map((name) => ({ name, ecus: by[name] }));
}

/**
 * Vehicle information / Control unit list.
 *
 * ONE ROW PER SLOT, not per SGBD the chassis could carry. See slots.js: the
 * config lists eight engine variants for an E46 because the model ran with
 * any of them, and drawing that list gave one car eight engines with the
 * installed one's faults smeared across its siblings.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - {slots, onPick}
 * @returns {object[]} the rows drawn
 */
function istaPageUnitList(host, ctx) {
  const rows = ctx.slots || [];
  const body = rows
    .map(
      (s, i) =>
        `<tr data-i="${i}">` +
        `<td class="irstate"><i class="${
          ISTA_STATE_CLASS[s.state] || 'dim'
        }"></i></td>` +
        `<td>${esc(s.abbr)}</td>` +
        `<td>${esc(s.name)}</td></tr>`
    )
    .join('');

  host.innerHTML =
    `<table class="irtable irunits"><thead><tr>` +
    `<th>State</th><th>Abbreviation</th><th>Control unit name</th>` +
    `</tr></thead><tbody>${body}</tbody></table>` +
    (rows.length
      ? ''
      : `<div class="irvin-empty">No module list ships for this ` +
        `chassis.</div>`);

  host.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
    tr.onclick = () => {
      host.querySelectorAll('tbody tr.sel').forEach((x) => {
        x.classList.remove('sel');
      });
      tr.classList.add('sel');
      if (ctx.onPick) ctx.onPick(rows[Number(tr.dataset.i)]);
    };
  });
  return rows;
}

/**
 * Service plan: Hit list, Test plan or Programming plan.
 *
 * The rows are DOCUMENTS, grouped under whatever pointed at them. The hit
 * list groups by the fault whose text matched a procedure; the test plan
 * groups by whatever added the row. A group with no rows still draws its
 * heading, because "this fault has no procedure in this build" is worth
 * seeing.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - {groups, onPick, empty}
 * @returns {object[]} the flat row list, in draw order
 */
function istaPageServicePlan(host, ctx) {
  const groups = ctx.groups || [];
  /** @type {object[]} */
  const flat = [];
  let html = '';
  for (const g of groups) {
    html += `<tr class="irgroup"><td colspan="4">${esc(g.title)}</td></tr>`;
    if (!(g.rows || []).length)
      html +=
        `<tr class="irgroup-none"><td colspan="4">` +
        `${esc(g.none || 'no document in this build')}</td></tr>`;
    for (const r of g.rows || []) {
      const i = flat.length;
      flat.push(r);
      html +=
        `<tr data-i="${i}">` +
        `<td>${esc(r.type || '-')}</td>` +
        `<td>${esc(r.title || '')}</td>` +
        `<td>${esc(r.state || '')}</td>` +
        `<td>${esc(r.priority == null ? '' : String(r.priority))}</td>` +
        `</tr>`;
    }
  }

  host.innerHTML =
    `<table class="irtable irplan"><thead><tr>` +
    `<th>Type</th><th>Title</th><th>State</th><th>Priority</th>` +
    `</tr></thead><tbody>${html}</tbody></table>` +
    (groups.length
      ? ''
      : `<div class="irvin-empty">${esc(
          ctx.empty || 'Nothing in the plan.'
        )}</div>`);

  host.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
    tr.onclick = () => {
      host.querySelectorAll('tbody tr.sel').forEach((x) => {
        x.classList.remove('sel');
      });
      tr.classList.add('sel');
      if (ctx.onPick) ctx.onPick(flat[Number(tr.dataset.i)]);
    };
    tr.ondblclick = () => {
      if (ctx.onOpen) ctx.onOpen(flat[Number(tr.dataset.i)]);
    };
  });
  return flat;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_STATE_CLASS,
    istaModuleGroup,
    istaModuleGroups,
    istaPageFinished,
    istaPageHistory,
    istaPageUnitList,
    istaPageServicePlan,
    istaPageReport,
  };
}

/**
 * A stored scan, drawn as the workshop tool draws it.
 *
 * The Garage's own report is a faithful copy of INPA's printout: monospace,
 * its own headings, Share and Save keys. That is the right thing on the
 * INPA side and the wrong thing here, where every other page is a table. So
 * a scan opened from inside the shell is redrawn as one table per module in
 * the tool's own language, rather than the INPA sheet in a workshop frame.
 *
 * The two kinds answer different questions and get different columns: an
 * identification scan is label/value per module, a fault scan is ISTA's own
 * five fault columns.
 * @param {HTMLElement} host - where to draw
 * @param {object} scan - a GarageScan
 * @returns {void}
 */
function istaPageReport(host, scan) {
  const report = (scan && scan.report) || null;
  const mods = (report && report.modules) || [];
  const silent = (report && report.silent) || [];
  const faults = report && report.kind !== 'ident';

  const head = (label, sgbd) =>
    `<thead><tr><th colspan="5">${esc(label || sgbd || '')}` +
    (sgbd ? ` <span class="irrep-sgbd">${esc(sgbd)}</span>` : '') +
    `</th></tr>` +
    (faults
      ? `<tr class="irrep-cols"><th>Code</th><th>Description</th>` +
        `<th>Mileage</th><th>Existent</th><th>Class</th></tr>`
      : '') +
    `</thead>`;

  const blocks = mods
    .map((m) => {
      const sgbd = m.sgbd || m.via || '';
      let body;
      if (faults) {
        const rows =
          typeof istaFaultRows === 'function'
            ? istaFaultRows({ modules: [m] })
            : [];
        body = rows.length
          ? rows
              .map(
                (r) =>
                  `<tr><td>${esc(r.code)}</td><td>${esc(r.desc)}</td>` +
                  `<td>${esc(r.km || '')}</td>` +
                  `<td>${r.present ? 'yes' : 'No'}</td><td>-</td></tr>`
              )
              .join('')
          : `<tr><td colspan="5" class="irrep-none">No fault memory ` +
            `entries.</td></tr>`;
      } else {
        const id = m.ident || {};
        const keys = Object.keys(id).filter(
          (k) => !k.startsWith('_') && id[k] != null && String(id[k]).trim()
        );
        body = keys.length
          ? keys
              .map(
                (k) =>
                  `<tr><td>${esc(k)}</td><td colspan="4">${esc(
                    String(id[k])
                  )}</td></tr>`
              )
              .join('')
          : `<tr><td colspan="5" class="irrep-none">Nothing was ` +
            `returned.</td></tr>`;
      }
      return (
        `<table class="irtable irrep">${head(m.label, sgbd)}` +
        `<tbody>${body}</tbody></table>`
      );
    })
    .join('');

  const quiet = silent.length
    ? `<table class="irtable irrep">` +
      `<thead><tr><th colspan="5">Did not answer</th></tr></thead><tbody>` +
      silent
        .map(
          (s) =>
            `<tr><td>${esc(s.label || s.target || '')}</td>` +
            `<td colspan="4">${esc(s.error || 'no answer')}</td></tr>`
        )
        .join('') +
      `</tbody></table>`
    : '';

  host.innerHTML =
    `<div class="irrep-wrap">` +
    (mods.length || silent.length
      ? blocks + quiet
      : `<div class="irvin-empty">This scan holds no modules.</div>`) +
    `</div>`;
}
