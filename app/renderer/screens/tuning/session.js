/**
 * @file Tuning screen: session persistence and the Save / Clear actions.
 * Survive a reload with the files (and edits) intact through
 * core/tuning-store.js; save the edited BIN to disk; clear everything.
 */

/* exported tnSaveSoon, tnRestoreSession, tnClearEverything, tnSaveBin */

/** How long a browser download's object URL stays alive. */
const TN_DOWNLOAD_URL_TTL_MS = 30000;

/**
 * What is worth keeping. Derived state (parsed definition, coverage map) is
 * deliberately excluded and rebuilt on restore; see core/tuning-store.js.
 * @returns {Object}
 */
function tnSessionSnapshot() {
  return {
    fileName: tuningState.fileName,
    defName: tuningState.defName,
    bin: tuningState.bin,
    orig: tuningState.orig,
    defText: tuningState.defText,
    filter: tuningState.filter,
    coverOn: tuningState.coverOn,
    kinds: tuningState.kinds,
    openCats: tuningState.openCats,
    openTable: tuningState.openTable,
    history: tuningState.history,
    redo: tuningState.redo,
  };
}

/**
 * Whether there is anything to persist.
 * @returns {boolean}
 */
function tnHasSession() {
  if (typeof TuningStore === 'undefined') return false;
  return !!(tuningState.bin || tuningState.defText);
}

/**
 * Schedule a debounced save of the current session.
 * @returns {void}
 */
function tnSaveSoon() {
  if (!tnHasSession()) return; // nothing to keep
  TuningStore.scheduleSave(tnSessionSnapshot);
}

/**
 * Flush any pending save on the way out. A reload can arrive without
 * warning, and a debounce timer will not survive it. pagehide covers the
 * bfcache case that beforeunload misses on Safari/iOS.
 * @returns {void}
 */
function tnFlushSession() {
  if (!tnHasSession()) return;
  TuningStore.flushSave(tnSessionSnapshot);
}
window.addEventListener('pagehide', tnFlushSession);
window.addEventListener('beforeunload', tnFlushSession);

/**
 * Restore, if a previous session left anything. Runs once per screen
 * entry; an already-loaded image wins, so re-entering the screen
 * mid-session never clobbers what is open.
 * @param {TuningEditor} ed
 * @returns {Promise<void>}
 */
async function tnRestoreSession(ed) {
  const els = ed.els;
  if (typeof TuningStore === 'undefined') return;
  if (tuningState.bin || tuningState.def) return;
  let rec = null;
  try {
    rec = await TuningStore.loadSession();
  } catch (e) {
    rec = null;
  }
  if (!rec || (!rec.bin && !rec.defText)) return;

  if (rec.bin) {
    tuningState.bin = rec.bin;
    tuningState.orig = rec.orig || rec.bin.slice();
    tuningState.fileName = rec.fileName || 'firmware.bin';
    tnShowLoadedImage(ed);
  }
  if (rec.defText) {
    try {
      tuningState.def = window.XDF.parseXdf(rec.defText);
      tuningState.defText = rec.defText;
      tuningState.defName = rec.defName || 'definition.xdf';
    } catch (e) {
      tuningState.def = null; // a definition we can no longer parse
      tuningState.defText = null; // is not worth carrying forward
    }
  }
  // view state
  tuningState.filter = rec.filter || '';
  tuningState.coverOn = rec.coverOn !== false;
  tuningState.kinds = rec.kinds && rec.kinds.length ? new Set(rec.kinds) : null;
  tuningState.openCats = rec.openCats ? new Set(rec.openCats) : null;
  tuningState.history = Array.isArray(rec.history) ? rec.history : [];
  tuningState.redo = Array.isArray(rec.redo) ? rec.redo : [];
  // NOT the selection. Restoring selectedId made the tree call the spotlight
  // for that item on load, painting a highlight over bytes the user never
  // clicked -- which then survived every reload and looked like the hex view
  // was highlighting at random. The files and the view state are worth
  // keeping across a reload; a transient selection is not.
  tuningState.selectedId = null;
  tuningState.highlight = null;

  tnRecountChanges();
  tnBuildCoverage();
  if (tuningState.def) tnRenderDefs(ed);
  ed.hex.refresh();
  tnUpdateStatus(ed);

  // A table editor that was open comes back open: mid-edit is exactly when
  // a reload (or a crash) hurts most, and the bytes are already restored.
  if (rec.openTable && tuningState.def && tuningState.bin) {
    const item = tuningState.def.items.find(
      (it) => it.key === rec.openTable && it.kind === 'table'
    );
    if (item) tnOpenTableModal(ed, item);
  }

  // Say so, rather than silently resurrecting files: seeing an image you did
  // not just load is confusing unless the app tells you why it is there.
  const when = rec.savedAt ? new Date(rec.savedAt) : null;
  els.status.innerHTML =
    `<span class="tn-restored">restored` +
    `${when ? ' from ' + esc(when.toLocaleString()) : ''}</span>` +
    `<span class="tn-sep">·</span><span>` +
    `<button type="button" class="tn-linklike" id="tn-forget">clear</button></span>`;
  const forget = els.status.querySelector('#tn-forget');
  if (forget) forget.onclick = () => tnClearEverything(ed);
}

/**
 * CLEAR: unload the session AND wipe the store.
 *
 * "forget" used to only delete the stored record, leaving the BIN and
 * definition loaded -- so the next edit re-saved them and a reload brought
 * everything back, which read as the button not working. Clearing has to
 * mean both: drop what is in memory, then drop what is on disk, in that
 * order so nothing can re-save in between. Unsaved edits are confirmed
 * first.
 * @param {TuningEditor} ed
 * @returns {Promise<void>}
 */
async function tnClearEverything(ed) {
  const els = ed.els;
  const dirty = tuningState.changed > 0;
  if (dirty) {
    const ok = await confirmDialog({
      title: 'Clear the editor?',
      body:
        `<p>${tuningState.changed.toLocaleString()} byte` +
        `${tuningState.changed === 1 ? '' : 's'} changed. Clearing discards ` +
        'the loaded firmware and definition along with those edits. ' +
        'Save the BIN first if you want to keep them.</p>',
      confirmLabel: 'Clear anyway',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
  }
  // memory first: any save scheduled after this point stores nothing
  tnResetState();

  try {
    await TuningStore.clearSession();
  } catch (e) {
    /* best-effort */
  }

  // put the screen back to its empty state
  els.loadXdf.disabled = true;
  els.save.disabled = true;
  els.file.textContent = '';
  els.status.textContent = '';
  els.defs.innerHTML = '';
  els.defs.appendChild(tnDefsEmptyState());
  ed.hex.refresh();
  tnUpdateStatus(ed);
}

/**
 * Save the edited image to disk, after saying plainly that the checksum
 * and signature are NOT corrected. Most flashing tools do that on write,
 * but a bin flashed by a tool that does not will be rejected by the ECU --
 * better said before every save than found out on a dead DME.
 * @param {TuningEditor} ed
 * @returns {Promise<void>}
 */
async function tnSaveBin(ed) {
  const els = ed.els;
  if (!tuningState.bin) return;

  const okToSave = await confirmDialog({
    title: 'Save tuned BIN',
    body:
      `<p>This saves your edited image as-is. BMWeb does <b>not</b> correct ` +
      `the checksum or firmware signature.</p>` +
      `<p>Correct the checksum in your flashing tool before writing it to ` +
      `the ECU. MS4X Flasher and WinKFP do this automatically; a tool that ` +
      `does not will produce an image the ECU rejects.</p>`,
    confirmLabel: 'Save anyway',
    cancelLabel: 'Cancel',
  });
  if (!okToSave) return;

  const name =
    tuningState.fileName.replace(/\.(bin|hex|ori|orig)$/i, '') + '-tuned.bin';
  try {
    // Prefer the host's real Save panel (macOS shell); fall back to a browser
    // download. Same pattern core/offline-export.js uses.
    if (window.bmacw && typeof window.bmacw.saveFile === 'function') {
      const r = await window.bmacw.saveFile(name, tuningState.bin);
      if (r && r.cancelled) return;
    } else {
      const blob = new Blob([tuningState.bin], {
        type: 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), TN_DOWNLOAD_URL_TTL_MS);
    }
    els.status.textContent = `saved ${name}`;
  } catch (e) {
    els.status.textContent = `save failed: ${e.message}`;
  }
}
