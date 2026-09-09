/**
 * @file The Service functions app: the tasks a workshop actually asks for,
 * by name, mapped to the INPA key that performs them on the chosen car.
 *
 * WHY THIS APP EXISTS. Nearly all of these functions are already in INPA --
 * the steering angle calibration is a key on the LWS script, the transmission
 * adaptation reset is a key on the gearbox script, the service reset is a key
 * on the cluster script. What INPA does not have is a way to FIND them: they
 * sit behind menu paths named for the module, in the language and vocabulary
 * of the script's author, and nothing anywhere says "this is the steering
 * angle calibration". The gap is discovery, so this app is a catalogue: each
 * task under its English name, what it does to the car, what must be true
 * first, and a button that opens the module right at the key.
 *
 * THE APP DOES NOT TALK TO THE CAR. It resolves a name to a place and then
 * hands over to the module view, which IS the running INPA script. Every
 * safety contract lives there and keeps holding: the write confirmation, the
 * release-on-leave, the "No adapter connected" gate when there is no cable.
 * See open.js for why pressing goes through the runtime rather than around it.
 */

/* exported showService, serviceState */

/** Stagger step (ms) of the task rows. */
const SERVICE_STAGGER = 14;

/** The screen's chassis choice, kept across re-entries within a visit. */
const serviceState = { chassis: '' };

/**
 * The chassis the app should open on when none is named: the Garage's car
 * when exactly one is saved, so the common case ("my car") needs no picking.
 * Several saved cars is ambiguous, so those fall through to the picker.
 * @param {ServiceIndex} index - the loaded mapping
 * @returns {string} a chassis id, or '' when there is no obvious one
 */
function serviceMyCarChassis(index) {
  if (typeof garageCars !== 'function') return '';
  let cars;
  try {
    cars = garageCars();
  } catch (e) {
    // the Garage reads localStorage, which throws outright in some contexts
    // (a private window, site data blocked); no saved car is the right answer
    return '';
  }
  if (!Array.isArray(cars)) return '';
  const known = (index && index.chassis) || {};
  const ids = [
    ...new Set(
      cars
        .map((c) => String(c && c.chassis).toUpperCase())
        .filter((c) => known[c])
    ),
  ];
  return ids.length === 1 ? ids[0] : '';
}

/**
 * The header controls: the chassis picker, and the Garage shortcut when a
 * saved car names a chassis the mapping covers.
 * @param {ServiceIndex} index - the loaded mapping
 * @param {(v: string) => void} onPick - called with the chosen chassis
 * @returns {HTMLDivElement}
 */
function serviceControls(index, onPick) {
  const el = document.createElement('div');
  el.className = 'lookup-controls service-controls';
  el.innerHTML = `
    <div class="lookup-filters">
      <label class="lookup-filter">
        <span class="lookup-filter-lbl">Vehicle</span>
        <span class="lookup-filter-slot"></span>
      </label>
    </div>`;
  const slot = el.querySelector('.lookup-filter-slot');
  if (typeof lookupDropdown === 'function') {
    const dd = lookupDropdown(
      'Pick a vehicle',
      serviceChassisOptions(index),
      serviceState.chassis,
      onPick
    );
    slot.appendChild(dd.el);
  }
  return el;
}

/**
 * One task row: what it is, what it needs, and where it lives on this car.
 * A task with no hits renders greyed with the reason, because "this car does
 * not have that function" is an answer worth showing.
 * @param {ServiceTask} task - the curated task
 * @param {ServiceHit[]} hits - where it resolved on this chassis
 * @param {string} chassis - the chassis id
 * @returns {HTMLDivElement}
 */
function serviceRow(task, hits, chassis) {
  const row = document.createElement('div');
  const has = hits.length > 0;
  row.className = 'service-row' + (has ? '' : ' service-row-absent');
  row.dataset.task = task.id;

  const best = has ? hits[0] : null;
  // the key's caption through the app's own translation, where a dictionary
  // carries it; INPA's own wording otherwise
  const caption =
    best && typeof irLabel === 'function'
      ? irLabel(best.label) || best.label
      : best
        ? best.label
        : '';

  const before = (task.before || []).map((b) => `<li>${esc(b)}</li>`).join('');

  row.innerHTML = `
    <div class="service-row-head">
      <span class="service-row-name">${esc(task.name)}</span>
      <span class="search-tag ${task.risk === 'write' ? 'search-tag-write' : 'service-tag-read'}">${
        task.risk === 'write' ? 'writes' : 'reads'
      }</span>
    </div>
    <div class="service-row-what">${esc(task.what)}</div>
    ${before ? `<div class="service-row-before"><span class="service-row-lbl">Before you run it</span><ul>${before}</ul></div>` : ''}
    ${
      task.after
        ? `<div class="service-row-after"><span class="service-row-lbl">Afterwards</span> ${esc(task.after)}</div>`
        : ''
    }
    <div class="service-row-where"></div>`;

  const where = row.querySelector('.service-row-where');
  if (!has) {
    where.innerHTML = `<span class="service-row-none">Not in INPA for ${esc(
      typeof dispChassis === 'function' ? dispChassis(chassis) : chassis
    )}: no script this build ships carries a key for it.</span>`;
    return row;
  }

  where.innerHTML = `
    <div class="service-row-hit">
      <span class="service-row-mod">${esc(best.module)}</span>
      <code class="service-row-sgbd">${esc(best.sgbd)}.prg</code>
      <span class="service-row-key">F${esc(String(best.nr > 10 ? best.nr - 10 : best.nr))}${
        best.nr > 10 ? ' (shifted)' : ''
      }</span>
      <span class="service-row-caption">${esc(caption)}</span>
      ${best.job ? `<code class="service-row-job">${esc(best.job)}</code>` : ''}
    </div>`;

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'btn service-run';
  run.textContent = 'Open on the car';
  run.title = `Open ${best.module} at ${best.menu} and press ${caption}`;
  run.onclick = () => serviceRunHit(best, chassis);
  where.appendChild(run);

  // the other modules that answer this task on this car, when more than one
  // does -- an E46 has several engines, and the mapping resolved each
  if (hits.length > 1) {
    const more = document.createElement('div');
    more.className = 'service-row-alts';
    more.innerHTML = `<span class="service-row-lbl">Also on</span>`;
    hits.slice(1).forEach((h) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'service-alt';
      b.textContent = h.module;
      b.title = `${h.sgbd}.prg · ${h.label}`;
      b.onclick = () => serviceRunHit(h, chassis);
      more.appendChild(b);
    });
    where.appendChild(more);
  }
  return row;
}

/**
 * Draw the task list for one chassis into a container.
 * @param {HTMLElement} host - where the list is drawn
 * @param {ServiceIndex} index - the loaded mapping
 * @param {string} chassis - the chassis id
 * @returns {{available: number, total: number}} how many tasks this car carries
 */
function serviceRenderList(host, index, chassis) {
  host.innerHTML = '';
  const groups = serviceTasksFor(index, chassis);
  let available = 0;
  let total = 0;
  for (const { category, tasks } of groups) {
    const sec = document.createElement('div');
    sec.className = 'service-group';
    const h = document.createElement('div');
    h.className = 'service-group-head';
    const n = tasks.filter((t) => t.hits.length).length;
    h.innerHTML = `<span class="service-group-name">${esc(category)}</span>
      <span class="service-group-count">${n} of ${tasks.length} on this car</span>`;
    sec.appendChild(h);
    const list = document.createElement('div');
    list.className = 'service-list stagger';
    tasks.forEach(({ task, hits }) => {
      total++;
      if (hits.length) available++;
      list.appendChild(serviceRow(task, hits, chassis));
    });
    sec.appendChild(list);
    host.appendChild(sec);
    if (typeof stagger === 'function') stagger(list, SERVICE_STAGGER);
  }
  return { available, total };
}

/**
 * What the screen shows before a vehicle is chosen.
 * @returns {string} HTML
 */
function serviceEmptyHtml() {
  return `
    <div class="empty">
      <div class="empty-big">Pick a vehicle</div>
      <div>Every service function this build can find in INPA's own scripts,
        by what it does rather than which module hides it. Choose a car and
        the list says which ones it carries, where each one lives, and what
        to check before running it.</div>
    </div>`;
}

/**
 * The Service functions screen.
 * @param {string|null} [chassis] - a chassis from the route (#apps/service/<C>)
 * @param {string|null} [taskId] - a task to scroll to (#apps/service/<C>/<task>)
 * @returns {Promise<void>}
 */
async function showService(chassis, taskId) {
  if (typeof cancelSweep === 'function') cancelSweep();
  if (typeof chassis === 'string' && chassis)
    serviceState.chassis = chassis.toUpperCase();
  lastScreen = () => showService(serviceState.chassis);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Service functions' },
  ]);
  sbLeft.textContent = 'service functions';

  view.innerHTML = head(
    'Reference',
    'Service functions',
    'Calibrations, adaptation resets and service routines, by what they do. ' +
      'Each one opens the INPA script that performs it, right at the key.'
  );

  const backAction = {
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    kind: 'back',
    fn: () => showApps(),
  };

  const body = document.createElement('div');
  body.className = 'service-body';
  view.appendChild(body);

  let index = serviceIndexPeek();
  if (!index) {
    body.innerHTML =
      '<div class="empty"><span class="loader"></span>' +
      '<span>Loading the service function list…</span></div>';
    index = await serviceIndexLoad();
    if (!index) {
      body.innerHTML = errorBlock(
        'No service function mapping in this build. Re-run the export ' +
          '(tools/export/service_functions.py) to add one.'
      );
      setActions([backAction]);
      return;
    }
  }

  // "my car" from the Garage, when it names one the mapping covers
  if (!serviceState.chassis) serviceState.chassis = serviceMyCarChassis(index);

  body.innerHTML = '';
  const list = document.createElement('div');

  /**
   * Draw the current selection and mirror it into the URL.
   * @returns {void}
   */
  function render() {
    const cid = serviceState.chassis;
    if (typeof routeSetService === 'function') routeSetService(cid);
    if (!cid) {
      list.innerHTML = serviceEmptyHtml();
      sbRight.textContent = '';
      return;
    }
    const { available, total } = serviceRenderList(list, index, cid);
    sbRight.textContent = `${available} of ${total} on ${
      typeof dispChassis === 'function' ? dispChassis(cid) : cid
    }`;
    // a deep link naming a task brings it into view
    if (taskId) {
      const el = list.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
      if (el) {
        el.classList.add('service-row-target');
        el.scrollIntoView({ block: 'center' });
      }
      taskId = null; // only on the first draw
    }
  }

  body.appendChild(
    serviceControls(index, (v) => {
      serviceState.chassis = v;
      render();
    })
  );
  body.appendChild(list);
  render();

  setActions([
    backAction,
    {
      key: '1',
      label: 'Vehicle',
      fn: () => {
        const dd = body.querySelector('.lkd-val');
        if (dd) dd.click();
      },
    },
  ]);
}

if (typeof window !== 'undefined') {
  window.showService = showService;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    showService,
    serviceState,
    serviceMyCarChassis,
    serviceRenderList,
  };
}
