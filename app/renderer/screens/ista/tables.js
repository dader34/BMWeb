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
   istaPageServicePlan istaModuleGroups */

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
 * One row per module the chassis can carry, with the state square coloured
 * from the newest stored scan. A module nobody has read is GREY, not green:
 * "not read" and "no faults" are different answers and the tool must not
 * blur them.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - {config, report, onPick}
 * @returns {object[]} the rows drawn
 */
function istaPageUnitList(host, ctx) {
  const report = ctx.report || null;
  // index the stored scan by the sgbd each module answered on
  const byId = new Map();
  for (const m of (report && report.modules) || [])
    byId.set(String(m.via || m.sgbd || '').toLowerCase(), {
      state: (m.codes || []).length ? 'faults' : 'ok',
      n: (m.codes || []).length,
    });
  for (const s of (report && report.silent) || [])
    byId.set(String(s.target || '').toLowerCase(), { state: 'silent', n: 0 });

  const rows = [];
  for (const g of istaModuleGroups(ctx.config))
    for (const e of g.ecus) rows.push(e);

  const body = rows
    .map((e, i) => {
      const hit =
        byId.get(String(e.sgbd || '').toLowerCase()) ||
        byId.get(String(e.group || '').toLowerCase()) ||
        null;
      const st = hit ? hit.state : 'unread';
      return (
        `<tr data-i="${i}">` +
        `<td class="irstate"><i class="${ISTA_STATE_CLASS[st]}"></i></td>` +
        `<td>${esc(e.code || e.sgbd || '')}</td>` +
        `<td>${esc(e.label || e.sgbd || '')}</td></tr>`
      );
    })
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
  };
}
