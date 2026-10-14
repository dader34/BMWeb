/**
 * @file Tuning > an item's editor: what the DME does with it. From the
 * emulator's scan of the program (core/ms45-table-map.js): the routines that
 * read the item, the OS task each runs under, and the RAM variables each
 * writes, which is what the item ends up driving. A routine the names file
 * knows is named; the rest are shown by address, still with their task.
 */
/* exported tnUsesFor, tnUsesRender */

/**
 * The readers of an item, from the map, for the program the definition is
 * for; none when the map is absent or for another program.
 * @param {Object} item - An XDF item.
 * @returns {Array<{start: string, task: string, name: string, writes: string[], wrote: number}>}
 */
function tnUsesFor(item) {
  if (
    typeof MS45_TABLE_MAP === 'undefined' ||
    typeof tnItemByteRange !== 'function' ||
    typeof TN_CAL_START === 'undefined' ||
    !tuningState.def
  )
    return [];
  const range = tnItemByteRange(item);
  if (!range) return [];
  const key = (range.start - TN_CAL_START).toString(16).toUpperCase();
  const readers = MS45_TABLE_MAP.items[key];
  if (!readers) return [];
  return readers.map(([start, task, name, writes, wrote]) => ({
    start,
    task: MS45_TABLE_MAP.tasks[task] || '',
    name: name || '',
    writes: writes.map(tnUsesVariable).filter(Boolean),
    wrote,
  }));
}

/** RAM address (hex) -> the logging label of the value the DME keeps there. */
let tnUsesLabels = null;

/**
 * A RAM variable's name: from the names file, else the logging label of
 * the DME's own value kept there (the value table gives the address, the
 * Comfort list the English name).
 * @param {string} hex - The address, upper-case hex.
 * @returns {string}
 */
function tnUsesVariable(hex) {
  const named = MS45_TABLE_MAP.vars[hex];
  if (named) return named;
  if (!tnUsesLabels) {
    tnUsesLabels = new Map();
    if (
      typeof MS45_VALUE_MAP !== 'undefined' &&
      typeof logComfortLabel === 'function' &&
      typeof logPacketKey === 'function' &&
      typeof LOG_PACKET_JOB !== 'undefined'
    )
      for (const [id, v] of Object.entries(MS45_VALUE_MAP.values)) {
        const label = logComfortLabel(
          'ms450ds0',
          LOG_PACKET_JOB,
          logPacketKey(Number(id))
        );
        const key = v[0].toString(16).toUpperCase();
        if (label && !tnUsesLabels.has(key)) tnUsesLabels.set(key, label);
      }
  }
  return tnUsesLabels.get(hex) || '';
}

/**
 * A task's name the way the panel says it.
 * @param {string} task
 * @returns {string}
 */
function tnUsesTask(task) {
  if (!task) return '';
  if (task === 'segment_task') return 'every crank segment';
  if (task === 'scheduler_task') return 'the scheduler';
  if (/^task\d+$/.test(task)) return `OS ${task}`;
  return task.replace(/_task$/, '').replace(/_/g, ' ');
}

/**
 * Put the "used by" panel under an item's editor. (The map is the emulator's
 * scan of the program: who reads the item, under which task, what they write.)
 * @param {Object} item
 * @param {HTMLElement} container - Where the editor was built.
 * @returns {void}
 */
function tnUsesRender(item, container) {
  const uses = tnUsesFor(item);
  const box = document.createElement('div');
  box.className = 'tn-uses';
  if (!uses.length) {
    box.classList.add('tn-uses-none');
    box.textContent =
      typeof MS45_TABLE_MAP === 'undefined'
        ? ''
        : 'No routine of the program was seen reading this item directly: it is reached through a pointer, or by the loader only.';
    if (box.textContent) container.appendChild(box);
    return;
  }
  const rows = uses.map((u) => {
    const who = u.name
      ? `<b>${esc(u.name)}</b> <code>${esc(u.start)}</code>`
      : `routine <code>${esc(u.start)}</code>`;
    const task = u.task
      ? ` <span class="tn-uses-task">${esc(tnUsesTask(u.task))}</span>`
      : '';
    let writes = '';
    if (u.writes.length) {
      const more = u.wrote - u.writes.length;
      writes = ` → ${u.writes.map((w) => `<i>${esc(w)}</i>`).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
    } else if (u.wrote) {
      writes = ` → ${u.wrote} RAM variable${u.wrote === 1 ? '' : 's'} not yet named`;
    }
    return `<div class="tn-uses-row">${who}${task}${writes}</div>`;
  });
  box.innerHTML = rows.join('');
  container.appendChild(box);
}
