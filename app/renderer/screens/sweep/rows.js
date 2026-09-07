/**
 * @file Whole-vehicle sweep: the screen chrome the two sweeps share -- the
 * cable gate, the results panel, the per-module rows, and clearing one
 * module's fault memory with proof.
 *
 * Fourth piece of screens/sweep/.
 */

/**
 * A module with faults, as the error sweep collects it for the deep pass,
 * the clear buttons and the report.
 * @typedef {object} FaultyModule
 * @property {{ sgbd: string, label: string, code?: string }} ecu - The
 *   module as read (resolved SGBD and the name printed for it).
 * @property {HTMLElement} row - Its sweep row.
 * @property {FaultEntry[]} codes - Its faults.
 */

/**
 * The scaffold of a sweep screen: the panel to draw into and this run's
 * liveness test.
 * @typedef {object} SweepScreen
 * @property {HTMLElement} out - The results panel.
 * @property {() => boolean} alive - True while this run still owns the bus.
 * @property {() => void} leave - Cancel the run and go back to the sections.
 */

/**
 * A CABLE IS REQUIRED TO SCAN. With nothing connected no module was ever
 * asked, so every row the sweep would print -- "not installed" included --
 * is a claim about a car it never spoke to. (The two groups whose probes
 * identify without wire traffic even split the labels: their reads fail a
 * stage later and said "no response" while everything else said "not
 * installed".) Same gate the coding hub uses.
 * @param {string} id - Chassis id.
 * @param {string} title - The sweep's title, for the crumbs and head.
 * @param {() => void} leave - Back action.
 * @returns {Promise<boolean>} True when blocked, after rendering the
 *   explanation in place of the sweep.
 */
async function sweepNeedsCable(id, title, leave) {
  let port = null;
  try {
    ({ port } = await api('/api/port'));
  } catch {
    /* treated as none */
  }
  if (port) return false;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(id), fn: leave },
    { label: title },
  ]);
  view.innerHTML = head('Whole vehicle', title, '');
  const need = document.createElement('div');
  need.className = 'empty';
  need.innerHTML =
    `<div class="empty-big" style="color:var(--amber)">Connect a cable to scan</div>` +
    `<div>A scan asks every module on the car to answer. With nothing ` +
    `connected there is nothing to ask, and reporting modules as present ` +
    `or absent would be a guess.</div>` +
    `<div style="font-size:12px;color:var(--ink-faint);max-width:48ch">` +
    `Connect the cable and start the scan again.</div>`;
  view.appendChild(need);
  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: leave },
  ]);
  sbLeft.textContent = 'scanning needs a cable';
  return true;
}

/**
 * Claim a run and draw the sweep screen: crumbs, head, an empty results
 * panel and the Back action.
 * @param {string} id - Chassis id.
 * @param {string} title - The sweep's title.
 * @param {string} subtitle - The head's subtitle.
 * @returns {SweepScreen} The panel, liveness test and leave action.
 */
function sweepScreen(id, title, subtitle) {
  const alive = claimSweep();
  const leave = () => {
    cancelSweep();
    showSections(id);
  };
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(id), fn: leave },
    { label: title },
  ]);
  view.innerHTML = head('Whole vehicle', title, subtitle);
  const out = document.createElement('div');
  out.className = 'results-panel';
  view.appendChild(out);
  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: leave },
  ]);
  return { out, alive, leave };
}

/**
 * Draw the sweep's bar (headline plus buttons) and its empty row list.
 * @param {HTMLElement} out - The results panel.
 * @param {string} headText - The initial headline.
 * @param {string} buttonsHtml - The bar's buttons.
 * @returns {{ rows: HTMLElement, headEl: HTMLElement }} The row container
 *   and the headline element.
 */
function sweepBar(out, headText, buttonsHtml) {
  out.innerHTML = `<div class="quick-sweep">
    <div class="quick-bar">
      <div class="quick-head">${headText}</div>
      <div class="quick-bar-btns">${buttonsHtml}</div>
    </div>
    <div class="quick-rows" id="quick-rows"></div></div>`;
  return {
    rows: out.querySelector('#quick-rows'),
    headEl: out.querySelector('.quick-head'),
  };
}

/**
 * Append a row for a target, in the "scanning" state.
 * @param {HTMLElement} rows - The row container.
 * @param {string} label - The target's label.
 * @returns {HTMLElement} The row.
 */
function addSweepRow(rows, label) {
  const row = document.createElement('div');
  row.className = 'quick-row';
  row.innerHTML = `<span class="quick-ecu">${esc(label)}</span><span class="quick-status">scanning…</span>`;
  rows.appendChild(row);
  return row;
}

/**
 * Rename a row once resolution names the module that actually answered. The
 * note is for the weaker path: an ungrouped row was read without a presence
 * test, and the display should not look identical to one that had one.
 * @param {HTMLElement} row - The row.
 * @param {string|null|undefined} label - The new label.
 * @param {string|null} [note] - A tooltip, for the direct-read case.
 * @returns {void}
 */
function setRowLabel(row, label, note) {
  const el = row.querySelector('.quick-ecu');
  if (!el || !label) return;
  el.textContent = label;
  if (note) el.title = note;
}

/**
 * Mark a row as one nothing can be said about: absent, unbuilt, duplicate.
 * @param {HTMLElement} row - The row.
 * @param {string} text - The status text.
 * @returns {void}
 */
function setRowNoResponse(row, text) {
  row.classList.add('noresp');
  row.querySelector('.quick-status').textContent = text;
}

/**
 * The "N faults" fragment.
 * @param {number} n - The count.
 * @returns {string} "1 fault" / "3 faults", bold.
 */
const faultCountHtml = (n) => `<b>${n} fault${n === 1 ? '' : 's'}</b>`;

/**
 * Status cell for a faulty module: fault count plus a Clear button.
 * @param {FaultyModule} f - The module.
 * @returns {void}
 */
function setRowFaultStatus(f) {
  const st = f.row.querySelector('.quick-status');
  st.innerHTML =
    faultCountHtml(f.codes.length) +
    `<button class="quick-clear" title="Clear ${esc(f.ecu.label)}">Clear</button>`;
  st.querySelector('.quick-clear').onclick = () => clearModule(f);
}

/** How long a transient "clear failed" note stays on the row, ms. */
const CLEAR_FAIL_NOTE_MS = 4000;

/**
 * Erase one module's fault memory (FS_LOESCHEN): confirm, clear, then
 * RE-READ to prove it -- "cleared" without evidence hides a live fault that
 * re-enters the memory the moment the ECU sees it again.
 * @param {FaultyModule} f - The module.
 * @returns {Promise<void>} Resolves when the row reflects the outcome.
 */
async function clearModule(f) {
  const n = f.codes.length;
  const ok = await confirmDialog({
    title: `Clear ${esc(f.ecu.label)} fault memory?`,
    body:
      `Erases ${n} stored fault${n === 1 ? '' : 's'} on ` +
      `<b>${esc(f.ecu.label)}</b> (<span class="mono">FS_LOESCHEN</span>). ` +
      `The memory is re-read afterwards; anything still present will ` +
      `show again.`,
    confirmLabel: 'Clear',
    danger: true,
  });
  if (!ok) return;
  const st = f.row.querySelector('.quick-status');
  st.innerHTML = '<span class="quick-clearing">clearing…</span>';
  try {
    await api(`/api/ecu/${f.ecu.sgbd}/run/FS_LOESCHEN`, { method: 'POST' });
    // trust the re-read, not the clear
    st.innerHTML = '<span class="quick-clearing">re-reading…</span>';
    let remaining = null;
    try {
      const codes = await readFaults(f.ecu.sgbd);
      remaining = codes.length;
      if (remaining) f.codes = codes;
    } catch {
      /* re-read failed; report the clear alone below */
    }
    if (remaining) {
      setRowFaultStatus(f);
      const back = document.createElement('span');
      back.className = 'quick-clear-fail';
      back.textContent = ' still present after clear';
      st.appendChild(back);
      return;
    }
    f.row.classList.remove('has-faults');
    f.row.classList.add('clean');
    st.innerHTML =
      remaining === null
        ? '<span class="quick-cleared">cleared (re-read failed)</span>'
        : '<span class="quick-cleared">cleared · re-read clean</span>';
    if (f.row.nextElementSibling?.classList.contains('quick-detail'))
      f.row.nextElementSibling.remove();
  } catch (e) {
    setRowFaultStatus(f); // rebuild the count + working Clear button
    const fail = document.createElement('span');
    fail.className = 'quick-clear-fail';
    fail.textContent = ' clear failed';
    fail.title = e.message;
    st.appendChild(fail);
    setTimeout(() => fail.remove(), CLEAR_FAIL_NOTE_MS);
  }
}

/**
 * Render the DTCs for one faulty module beneath its sweep row, via the
 * shared faultFields projection (faults.js) so rows and PDF read the same.
 * @param {HTMLElement} row - The module's row.
 * @param {FaultEntry[]} codes - Its faults.
 * @param {string} sgbd - The SGBD they were read from.
 * @returns {void}
 */
function appendFaultDetailRows(row, codes, sgbd) {
  const wrap = document.createElement('div');
  wrap.className = 'quick-detail';
  wrap.innerHTML = codes
    .map((c) => {
      const { code, name, present } = faultFields(c, sgbd);
      return `<div class="quick-detail-row${present ? ' present' : ''}">
      <span class="quick-detail-code">${esc(code)}</span>
      <span class="quick-detail-name">${esc(name)}</span>
      <span class="quick-detail-state">${present ? 'PRESENT' : 'stored'}</span>
    </div>`;
    })
    .join('');
  row.insertAdjacentElement('afterend', wrap);
}
