/**
 * @file Tuning screen: UNDO / REDO for the table editor.
 *
 * Each entry is the set of byte writes an operation performed, held as
 * {address, before, after}: undo replays `before` backwards, redo replays
 * `after` forwards. Byte-level rather than cell-level because that is the
 * layer edits actually land at, and it stays correct for axis writes too.
 * The stacks live on tuningState -- one history per loaded image, shared by
 * every table dialog and saved with the session -- so closing the dialog or
 * reloading the page does not throw the trail away.
 */

/* exported tnCreateEditHistory */

/**
 * @typedef {Object} EditHistoryHooks
 * @property {() => void} onReplay - Re-decode and repaint after an undo/redo landed.
 * @property {() => void} onStateChange - The undo/redo availability may have changed.
 * @property {(msg: string) => void} onInfo - Show a transient message.
 */

/**
 * @typedef {Object} EditHistory
 * @property {() => void} begin - Start collecting writes for one operation.
 * @property {(label: string) => void} end - Close the operation as one undo step.
 * @property {(address: number, bytes: Uint8Array) => boolean} write - Record
 *   the prior bytes, then write. Everything that mutates the image from
 *   inside a dialog goes through here so undo can never miss a write.
 * @property {() => boolean} undo - False when there was nothing to undo.
 * @property {() => boolean} redo - False when there was nothing to redo.
 */

/**
 * Build the history controller for one dialog over the shared stacks.
 * @param {TuningEditor} ed
 * @param {EditHistoryHooks} hooks
 * @returns {EditHistory}
 */
function tnCreateEditHistory(ed, hooks) {
  let batch = null; // collects writes while an op is running

  function begin() {
    batch = [];
  }

  function end(label) {
    if (batch && batch.length) {
      tuningState.history.push({ label, writes: batch });
      if (tuningState.history.length > TN_HISTORY_MAX)
        tuningState.history.splice(
          0,
          tuningState.history.length - TN_HISTORY_MAX
        );
      tuningState.redo.length = 0; // a new edit forks the timeline
      tnSaveSoon();
    }
    batch = null;
    hooks.onStateChange();
  }

  function write(address, bytes) {
    // Snapshot BEFORE the write, but only keep it if the write was actually
    // accepted -- tnWriteBytes refuses out-of-bounds addresses, and recording
    // a no-op would make undo replay bytes that were never changed.
    const before = tuningState.bin.slice(address, address + bytes.length);
    const ok = tnWriteBytes(ed, address, bytes);
    if (ok && batch)
      batch.push({ address, before, after: Uint8Array.from(bytes) });
    return ok;
  }

  function undo() {
    const entry = tuningState.history.pop();
    if (!entry) return false;
    // backwards: later writes in the same op may overlap earlier ones
    for (let i = entry.writes.length - 1; i >= 0; i--) {
      const w = entry.writes[i];
      tnWriteBytes(ed, w.address, w.before);
    }
    tuningState.redo.push(entry);
    tnSaveSoon();
    hooks.onReplay();
    hooks.onStateChange();
    hooks.onInfo(`undid ${entry.label}`);
    return true;
  }

  function redo() {
    const entry = tuningState.redo.pop();
    if (!entry) return false;
    for (const w of entry.writes) {
      if (w.after) tnWriteBytes(ed, w.address, w.after);
    }
    tuningState.history.push(entry);
    tnSaveSoon();
    hooks.onReplay();
    hooks.onStateChange();
    hooks.onInfo(`redid ${entry.label}`);
    return true;
  }

  return { begin, end, write, undo, redo };
}
