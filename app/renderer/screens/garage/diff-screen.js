/**
 * @file What changed between two scans, drawn and printed. The comparison
 * itself is screens/garage/diff.js; this only draws it, in the sweep's row
 * classes so a change list reads like every other module list in the app.
 */

/* exported showGarageDiff */

/**
 * Compare two of a car's scans. Defaults to the newest against the one
 * before it.
 * @param {string} carId - the car
 * @param {string} fromId - the older scan
 * @param {string} toId - the newer scan
 * @returns {Promise<void>}
 */
async function showGarageDiff(carId, fromId, toId) {
  const car = garageCar(carId);
  if (!car) return showGarage();
  const scans = garageScans(carId);
  if (scans.length < 2) return showGarageCar(carId);
  const to = garageScan(carId, toId) || scans[0];
  const from = garageScan(carId, fromId) || scans[1];

  lastScreen = () => showGarageDiff(carId, from.id, to.id);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Garage', fn: showGarage },
    { label: garageCarLabel(car), fn: () => showGarageCar(carId) },
    { label: 'Changes' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'compare scans';
  view.innerHTML = head(
    'Garage',
    'What Changed',
    `${garageCarLabel(car)} · ${garageDateText(from.at)} → ${garageDateText(to.at)}`
  );

  const diff = garageDiffScans(from, to);
  const counts = garageDiffCounts(diff);
  sbRight.textContent = `${counts.added} new · ${counts.cleared} cleared`;

  view.appendChild(garageDiffPickers(carId, scans, from, to));

  const wrap = document.createElement('div');
  wrap.className = 'quick-sweep garage-diff';
  const headText =
    diff.kind === 'ident'
      ? `${counts.fields} field${counts.fields === 1 ? '' : 's'} changed · ` +
        `${counts.silence} answering change${counts.silence === 1 ? '' : 's'}`
      : `${counts.added} new · ${counts.cleared} cleared · ` +
        `${counts.same} still present` +
        (counts.recurred ? ` (${counts.recurred} logged again)` : '') +
        ` · ${counts.silence} answering change${counts.silence === 1 ? '' : 's'}`;
  wrap.innerHTML =
    `<div class="quick-bar"><div class="quick-head">${esc(headText)}</div>` +
    `<div class="quick-bar-btns"></div></div><div class="quick-rows"></div>`;
  const rowsEl = wrap.querySelector('.quick-rows');
  view.appendChild(wrap);

  const changed = diff.modules.filter((m) => m.changed);
  if (!changed.length && !diff.silence.length) {
    const same = document.createElement('div');
    same.className = 'garage-empty';
    same.textContent =
      diff.kind === 'ident'
        ? 'Nothing changed: every module reports the same identification.'
        : 'Nothing changed: the same faults are stored in the same modules.';
    rowsEl.appendChild(same);
  }

  for (const m of changed)
    rowsEl.appendChild(garageDiffModuleRow(m, diff.kind));
  for (const s of diff.silence) {
    const row = document.createElement('div');
    row.className = 'quick-row ' + (s.state === 'silent' ? 'noresp' : 'clean');
    row.innerHTML = `
      <span class="quick-ecu">${esc(s.label)}</span>
      <span class="quick-status">${esc(
        s.state === 'silent' ? 'stopped answering' : 'answers again'
      )}</span>`;
    rowsEl.appendChild(row);
  }

  setActions([
    {
      key: 'p',
      label: 'Print',
      kind: 'print',
      fn: () => garagePrintDiff(car, diff, counts),
    },
    garageBackAction(() => showGarageCar(carId)),
  ]);
}

/**
 * The two pickers that choose which scans are compared.
 * @param {string} carId - the car
 * @param {GarageScan[]} scans - its scans, newest first
 * @param {GarageScan} from - the older side
 * @param {GarageScan} to - the newer side
 * @returns {HTMLDivElement}
 */
function garageDiffPickers(carId, scans, from, to) {
  const box = document.createElement('div');
  box.className = 'garage-diff-pick';
  const opts = (sel) =>
    scans
      .map(
        (s) =>
          `<option value="${esc(s.id)}"${s.id === sel ? ' selected' : ''}>${esc(
            `${garageDateText(s.at)} · ${s.kind === 'ident' ? 'ident' : `${s.summary.faults} faults`}`
          )}</option>`
      )
      .join('');
  box.innerHTML = `
    <label class="garage-diff-label">Compare
      <select class="garage-diff-from">${opts(from.id)}</select>
    </label>
    <span class="garage-diff-arrow">→</span>
    <label class="garage-diff-label">with
      <select class="garage-diff-to">${opts(to.id)}</select>
    </label>`;
  const f = box.querySelector('.garage-diff-from');
  const t = box.querySelector('.garage-diff-to');
  const go = () => showGarageDiff(carId, f.value, t.value);
  f.onchange = go;
  t.onchange = go;
  return box;
}

/**
 * One module's row, with its changed faults or fields under it.
 * @param {GarageDiffModule} m - the module's changes
 * @param {string} kind - 'faults' or 'ident'
 * @returns {DocumentFragment}
 */
function garageDiffModuleRow(m, kind) {
  const frag = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = 'quick-row ' + (m.added.length ? 'has-faults' : 'clean');
  const bits = [];
  const again = (m.recurred || []).length;
  if (m.added.length) bits.push(`${m.added.length} new`);
  if (m.cleared.length) bits.push(`${m.cleared.length} cleared`);
  if (m.fields.length) bits.push(`${m.fields.length} changed`);
  if (again) bits.push(`${again} logged again`);
  if (m.same.length - again > 0)
    bits.push(`${m.same.length - again} unchanged`);
  row.innerHTML = `
    <span class="quick-ecu" title="${esc(m.sgbd)}">${esc(
      typeof ipoText === 'function' ? ipoText(m.label) : m.label
    )}</span>
    <span class="quick-status">${esc(bits.join(' · '))}</span>`;
  frag.appendChild(row);

  const detail = document.createElement('div');
  detail.className = 'quick-detail';
  const parts = [];
  if (kind === 'ident') {
    for (const f of m.fields)
      parts.push(
        garageDiffLine('changed', f.label, `${f.from || '—'} → ${f.to || '—'}`)
      );
  } else {
    const again = new Set(m.recurred || []);
    for (const c of m.added) parts.push(garageDiffFault('new', c, m.sgbd));
    for (const c of m.cleared)
      parts.push(garageDiffFault('cleared', c, m.sgbd));
    // a fault still stored but logged again since reads as recurred, not
    // unchanged: the freeze frame moved even though the code did not
    for (const c of m.same)
      parts.push(
        garageDiffFault(again.has(c) ? 'recurred' : 'unchanged', c, m.sgbd)
      );
  }
  if (parts.length) {
    detail.innerHTML = parts.join('');
    frag.appendChild(detail);
  }
  return frag;
}

/**
 * One changed fault as a detail row, badged with what happened to it.
 * @param {'new'|'cleared'|'unchanged'} state - what happened
 * @param {object} code - the fault
 * @param {string} sgbd - the module that reported it
 * @returns {string} markup
 */
function garageDiffFault(state, code, sgbd) {
  const ff =
    typeof faultFields === 'function'
      ? faultFields(code, sgbd)
      : { code: '', name: '' };
  // the values the module captured when it logged this, flagged where a
  // range rule fired
  const env =
    typeof garageEnvRowHtml === 'function' ? garageEnvRowHtml(code) : '';
  return garageDiffLine(state, ff.code || '—', ff.name || '') + env;
}

/**
 * One badged detail row.
 * @param {string} state - the badge ('new', 'cleared', 'unchanged', 'changed')
 * @param {string} left - the code or field name
 * @param {string} right - the description or the value change
 * @returns {string} markup
 */
function garageDiffLine(state, left, right) {
  return (
    `<div class="quick-detail-row garage-diff-row garage-diff-${state}">` +
    `<span class="quick-detail-code">${esc(left)}</span>` +
    `<span class="quick-detail-name">${esc(right)}</span>` +
    `<span class="quick-detail-state garage-diff-badge">${esc(state)}</span>` +
    `</div>`
  );
}

/**
 * Print the comparison on the app's sheet.
 * @param {GarageCar} car - the car
 * @param {GarageDiff} diff - the comparison
 * @param {object} counts - its headline counts
 * @returns {Promise<void>}
 */
function garagePrintDiff(car, diff, counts) {
  if (typeof printDoc !== 'function') return Promise.resolve();
  const sections = [];
  const changed = diff.modules.filter((m) => m.changed);
  if (!changed.length && !diff.silence.length) {
    sections.push(
      printHtml('<p class="pr-p">Nothing changed between the two reads.</p>')
    );
  }
  for (const m of changed) {
    sections.push(
      printHeading(
        `${typeof ipoText === 'function' ? ipoText(m.label) : m.label}  ·  ${m.sgbd}`
      )
    );
    if (diff.kind === 'ident') {
      sections.push({
        html: printTable(
          ['State', 'Field', 'Change'],
          m.fields.map((f) => [
            'changed',
            f.label,
            `${f.from || '—'} → ${f.to || '—'}`,
          ])
        ),
      });
      continue;
    }
    const again = new Set(m.recurred || []);
    const rows = [
      ...m.added.map((c) => garageDiffPrintRow('new', c, m.sgbd)),
      ...m.cleared.map((c) => garageDiffPrintRow('cleared', c, m.sgbd)),
      ...m.same.map((c) =>
        garageDiffPrintRow(again.has(c) ? 'recurred' : 'unchanged', c, m.sgbd)
      ),
    ];
    sections.push({
      html: printTable(['State', 'Code', 'Description', 'Freeze frame'], rows),
    });
  }
  if (diff.silence.length) {
    sections.push(printHeading('Answering'));
    sections.push({
      html: printTable(
        ['Module', 'Change'],
        diff.silence.map((s) => [
          s.label,
          s.state === 'silent' ? 'stopped answering' : 'answers again',
        ])
      ),
    });
  }
  return printDoc({
    title: garageCarLabel(car),
    subtitle: 'What changed between two reads',
    meta: [
      ['From', garageDateText(diff.from.at)],
      ['To', garageDateText(diff.to.at)],
      ['New', String(counts.added)],
      ['Cleared', String(counts.cleared)],
      ['VIN', car.vin || '—'],
    ],
    sections,
  });
}

/**
 * One fault as a printed table row.
 * @param {string} state - what happened to it
 * @param {object} code - the fault
 * @param {string} sgbd - the module
 * @returns {string[]}
 */
function garageDiffPrintRow(state, code, sgbd) {
  const ff =
    typeof faultFields === 'function'
      ? faultFields(code, sgbd)
      : { code: '', name: '' };
  // the freeze frame as plain text, each flagged value marked so the printed
  // sheet carries the same warnings the screen shows
  const env =
    typeof garageEnvChecks === 'function'
      ? garageEnvChecks(code)
          .map((f) => {
            const label =
              typeof envLabel === 'function' ? envLabel(f.label) : f.label;
            const value =
              typeof envValueText === 'function'
                ? envValueText(f.value, f.unit)
                : `${f.value} ${f.unit}`.trim();
            return `${label}: ${value}${f.warn ? ' (!)' : ''}`;
          })
          .join(', ')
      : '';
  return [state, ff.code || '—', ff.name || '', env];
}
