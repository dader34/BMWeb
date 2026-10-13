/**
 * @file Tuning screen: Read tune from ECU. Reads the MS45 DME's calibration
 * -- the tune -- over the diagnostic read service and opens it in the editor
 * with the MS45 definition, so the maps show what the car holds and Save
 * writes it to disk as a backup. Nothing is written to the car, no
 * programming session is opened and the engine may be running. Tables open
 * in live mode are laid over what was read, so the image is the tune the
 * engine is using, unsaved edits included.
 *
 * The reader for any other module's memory (read-ecu-dialog.js) is one
 * button away in the same dialog.
 */
/* exported tnOpenReadTune */

/** Bytes of calibration, read from TN_CAL_START (live-mode.js). */
const TN_TUNE_LENGTH = 0x1d000;

/**
 * Minutes and seconds, for the time a read has left.
 * @param {number} seconds
 * @returns {string}
 */
function tnTuneClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Ask, read the calibration, and open it in the editor.
 * @param {TuningEditor} ed
 * @param {() => void} [onRead] - Called once the tune has been read and
 *   opened (Save BIN uses it to carry on to the save it was asked for).
 * @returns {Promise<void>}
 */
async function tnOpenReadTune(ed, onRead) {
  const els = ed.els;
  const abort = new AbortController();
  let reading = false;
  const { overlay, close } = openModal(
    `<div class="modal" role="dialog" aria-modal="true">
       <div class="modal-title">Read tune from ECU</div>
       <div class="modal-body">
         <p>Reads the DME's calibration (${fmtBytes(TN_TUNE_LENGTH)}) and opens it here.</p>
         <div class="tn-live-connecting" id="tn-tune-progress" hidden>
           <span class="modal-spinner" aria-hidden="true"></span>
           <span class="tn-live-prog" id="tn-tune-say"></span>
         </div>
       </div>
       <div class="modal-actions">
         <button class="btn" id="tn-tune-cancel">Cancel</button>
         <button class="btn primary" id="tn-tune-go">Read tune</button>
       </div>
     </div>`,
    { backdropValue: null, onClose: () => abort.abort() }
  );
  const $ = (sel) => overlay.querySelector(sel);
  const say = (text) => {
    $('#tn-tune-progress').hidden = false;
    $('#tn-tune-say').textContent = text;
  };
  $('#tn-tune-cancel').onclick = () => {
    abort.abort();
    close();
  };
  $('#tn-tune-go').onclick = async () => {
    if (reading) return;
    reading = true;
    $('#tn-tune-go').disabled = true;
    try {
      if (typeof ms45ReadMemory !== 'function')
        throw new Error('the MS45 engine is not loaded');
      say('reaching the DME…');
      // The read is 116 KB, and at the session's 9600 baud nearly all of its
      // three minutes is bytes on the wire. The DME will run its default
      // session at the rate the cable can carry, so the line is raised for
      // the read and put back after it, whatever happens in between. Live
      // mode's own traffic (cursor, gauges, link check, fault scan) stands
      // back meanwhile: a telegram sent between the two halves of the
      // change would go out at the wrong rate.
      const liveWasBusy = tnLive.busy;
      tnLive.busy = true;
      let baud = 9600;
      let cal;
      try {
        if (typeof ms45RaiseBaud === 'function') baud = await ms45RaiseBaud();
        const started = Date.now();
        cal = await ms45ReadMemory(
          TN_CAL_START,
          TN_CAL_START + TN_TUNE_LENGTH - 1,
          'ROMX',
          {
            abort: abort.signal,
            onProgress: (pct) => {
              const spent = (Date.now() - started) / 1000;
              const left = pct > 0 ? (spent * (100 - pct)) / pct : 0;
              say(
                `reading the tune… ${pct}% · about ${tnTuneClock(left)} left` +
                  (baud !== 9600 ? ` · ${baud} baud` : '')
              );
            },
          }
        );
      } finally {
        if (baud !== 9600 && typeof ms45DefaultBaud === 'function')
          await ms45DefaultBaud();
        tnLive.busy = liveWasBusy;
      }
      if (!cal.length)
        throw new Error(
          'the DME did not answer the read. Check the cable and that the ignition is on.'
        );
      if (cal.length !== TN_TUNE_LENGTH)
        throw new Error(
          `the read stopped at ${Math.round((cal.length * 100) / TN_TUNE_LENGTH)}%. Nothing was loaded.`
        );

      // the image the definition expects: the calibration at its place in
      // the external flash, the rest absent
      const image = new Uint8Array(TN_CAL_START + TN_TUNE_LENGTH);
      image.set(cal, TN_CAL_START);
      // tables open in live mode read from their mirrors, not from what is
      // stored: lay them over, so this is the tune the engine is using
      let live = 0;
      if (tnLive.armed && tnLive.lt) {
        for (const t of tnLive.lt.tables) {
          say('reading the open live tables…');
          image.set(
            await tnLive.lt.readTable(t, 0, t.length),
            TN_CAL_START + t.offset
          );
          live++;
        }
      }

      if (!tuningState.def && typeof tnDownloadDefinition === 'function') {
        say('loading the MS45 definition…');
        for (const base of typeof XDF_MIRRORS !== 'undefined'
          ? XDF_MIRRORS
          : [])
          if (await tnDownloadDefinition(ed, base, TN_LIVE_XDF)) break;
      }

      tnAdoptImage(image, 'ms45-tune (from ecu).bin');
      tnLive.wholeRead = true; // every map is already in the image
      tnShowLoadedImage(ed);
      els.clear.disabled = false;
      tnBuildCoverage();
      tnSaveSoon();
      ed.hex.refresh();
      if (tuningState.def) tnRenderDefs(ed);
      tnUpdateStatus(ed);
      els.status.textContent =
        `read the tune from the ECU · ${fmtBytes(TN_TUNE_LENGTH)}` +
        (live ? ` · ${live} live table${live === 1 ? '' : 's'} included` : '');
      close();
      if (typeof onRead === 'function') onRead();
    } catch (e) {
      if (abort.signal.aborted) return;
      reading = false;
      $('#tn-tune-go').disabled = false;
      $('#tn-tune-progress').hidden = true;
      const p = document.createElement('p');
      p.className = 'tn-tune-error';
      p.textContent = (e && e.message) || String(e);
      overlay.querySelectorAll('.tn-tune-error').forEach((el) => el.remove());
      $('.modal-body').appendChild(p);
    }
  };
}
