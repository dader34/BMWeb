/**
 * @file Tuning screen: LIVE mode. When armed and a car running the
 * live-tune build is on the cable, every edit the editor makes inside the
 * calibration is mirrored onto the DME as it happens, so the change takes
 * effect while the engine runs; a Save folds the open tables into the
 * calibration for good.
 *
 * The seam is tnWriteBytes: cells, axes, bulk ops, hex edits and undo/redo
 * all land there, so live mode sees them all without touching any of them.
 * A write inside the calibration opens its owning table on the DME (once)
 * and sends the differing bytes; writes elsewhere in the image are the
 * program and are left for a reflash, said so plainly.
 */
/* exported tnLiveBeat, tnLiveOpenItems, tnLiveBaselineKnown, tnLiveApplyStaged, tnLiveDropStaged */
/* exported tnLive, tnLiveInit, tnLiveToolbarHtml, tnLivePaint, tnLiveOnWrite, tnLiveDisarm, tnLiveFillTable */

/** The calibration as an IMAGE offset: XDF BASEOFFSET is 0x40000, so a
 *  parameter's mmedaddress is also its offset into the DME's calibration. */
const TN_CAL_START = 0x40000;
/** Bytes in the calibration. */
const TN_CAL_LENGTH = 0x1d000;
const TN_CAL_END = TN_CAL_START + TN_CAL_LENGTH;
/** The MS45 definition live mode auto-loads from the shared library (full 1 MB image). */
const TN_LIVE_XDF = 'Siemens_MS451_457LO02S_1024K.xdf';
/** The monitor's own stored sum and the byte that switches the monitor off:
 *  never sent live on any build. The program reads both through the live
 *  view, so an edit would trip the monitor, or silence it, at once. */
const TN_LIVE_LOCKED = [
  [0x57bf, 0x57c0],
  [0x57dc, 0x57e4],
];

/** Remembers that live mode was on, so a reloaded page goes back into it. */
const TN_LIVE_KEY = 'bmweb.tuning.live';
/** How long a reloaded page waits for the cable to come back before it tries. */
const TN_LIVE_REJOIN_MS = 8000;

/**
 * Note (or forget) that live mode is on, for the next load of the page.
 * @param {boolean} on
 * @returns {void}
 */
function tnLiveRemember(on) {
  try {
    if (on) localStorage.setItem(TN_LIVE_KEY, '1');
    else localStorage.removeItem(TN_LIVE_KEY);
  } catch (e) {
    /* private mode: it just will not rejoin */
  }
}

/** The working image live mode starts when no BIN is loaded: blank, filled
 *  in from the car as items are opened. */
const TN_LIVE_IMAGE = 'ecu (live).bin';

/**
 * Whether the working image is that blank one. Its "original" is not a file:
 * it is whatever the DME's calibration holds, known only for what has been
 * read (see tnLiveBaseline).
 * @returns {boolean}
 */
function tnLiveBlankImage() {
  return tuningState.fileName === TN_LIVE_IMAGE;
}

/**
 * Record what the DME's calibration holds for a span as the image's original
 * values -- what Revert goes back to, what "vs original" compares with, what
 * counts as changed. On the blank live image that snapshot starts as erased
 * flash (0xFF), and reverting a cell to it sent 65535 to the car.
 * @param {number} start - IMAGE offset.
 * @param {Uint8Array} stored - The calibration's own bytes there.
 * @returns {void}
 */
function tnLiveBaseline(start, stored) {
  if (!tnLiveBlankImage() || !tuningState.orig) return;
  tuningState.orig.set(stored, start);
  const at = start - TN_CAL_START;
  tnLive.baseKnown.fill(1, at, at + stored.length);
}

/**
 * Whether the original values of every byte of an item are known. Always so
 * for a loaded file; on the blank live image only once they have been read
 * off the car.
 * @param {XdfItem} item
 * @returns {boolean}
 */
function tnLiveBaselineKnown(item) {
  if (!tnLiveBlankImage()) return true;
  let range = null;
  try {
    range = tnItemByteRange(item);
  } catch (e) {
    range = null;
  }
  if (!range) return false;
  for (
    let a = Math.max(TN_CAL_START, range.start);
    a < Math.min(TN_CAL_END, range.end);
    a++
  )
    if (!tnLive.baseKnown[a - TN_CAL_START]) return false;
  return true;
}

/** How often live mode looks at the link while nothing else is being said. */
const TN_LIVE_BEAT_MS = 1000;
/** The DME is asked how it is when nothing has been heard from it this long. */
const TN_LIVE_QUIET_MS = 3000;
/** While it is not answering it is asked this often instead. */
const TN_LIVE_RETRY_MS = 1500;
/** Unanswered checks in a row before the DME is called disconnected: one
 *  lost telegram on a K line is ordinary. */
const TN_LIVE_MISSES = 2;
/** A check that has not come back in this long counts as unanswered: a
 *  dead line can hold an exchange far longer than its own timeouts say. */
const TN_LIVE_PROBE_MS = 6000;

/**
 * Live-mode state for the screen. One per visit; `send` and `lt` exist only
 * while armed.
 * @type {{armed:boolean, lt:LiveTune|null, busy:boolean, error:string|null,
 *   ed:TuningEditor|null, els:{bar:HTMLElement, arm:HTMLButtonElement,
 *   save:HTMLButtonElement, keep:HTMLElement, keepBox:HTMLInputElement,
 *   discard:HTMLButtonElement, open:HTMLButtonElement, rest:HTMLElement,
 *   status:HTMLElement}|null, cell:1|2}}
 */
const tnLive = {
  armed: false,
  lt: null,
  busy: false,
  error: null,
  ed: null,
  els: null,
  cell: 1,
  suppressWrite: false, // set while folding an ECU read-back in, so it does not loop
  note: '', // what the last edit could not do live
  progress: '', // what a slow step on the ECU is doing (making room)
  pending: new Map(), // cal offset -> range still to send
  staged: new Map(), // cal offset -> range edited in the open table, held until Apply
  pumping: false,
  readOffsets: null, // Set of "start:end" cal ranges already read on demand (no-BIN live)
  saveAsked: false, // the DME will save what is open at key-off (builds that save only on request)
  wholeRead: false, // the image is a whole tune read off the ECU: nothing to read on demand
  editedAt: 0, // when the last edit was made
  baseKnown: new Uint8Array(TN_CAL_LENGTH), // 1 per calibration byte whose original (the DME's stored value) has been read
  link: 'up', // 'lost' while the DME is out of reach
  why: 'silent', // how: 'ignition' (the cable says KL15 is off), 'cable', or 'silent'
  probe: null, // the state read that is out, so a hung one is not piled onto
  heardAt: 0, // when the DME last answered anything
  checkedAt: 0, // when its state was last looked at
  misses: 0, // checks in a row it did not answer
  beatTimer: null,
};

/**
 * The live-mode toolbar: an arm toggle, a Save button, and a status line.
 * Sits under the main toolbar.
 * @returns {string}
 */
function tnLiveToolbarHtml() {
  return `
    <div class="tn-live" id="tn-live" hidden>
      <button class="btn tn-live-arm" id="tn-live-arm" title="Mirror edits onto a running DME">● LIVE</button>
      <button class="btn tn-live-discard" id="tn-live-discard" hidden title="Close every open table on the ECU and put back the values its calibration holds">Discard edits</button>
      <span class="tn-live-status" id="tn-live-status"></span>
      <button type="button" class="tn-live-open" id="tn-live-open" hidden title="Show only these in the list on the left; click again for everything"></button>
      <span class="tn-live-status" id="tn-live-rest"></span>
      ${typeof tnGaugesToolbarHtml === 'function' ? tnGaugesToolbarHtml() : ''}
      <!-- the save to the ECU sits apart, at the far right -->
      <label class="tn-tool-check tn-live-keep" id="tn-live-keep" hidden title="Keep these edits: the ECU writes them into its calibration when the ignition is switched off"><input type="checkbox" id="tn-live-keep-box"> Save to ECU (on key off)</label>
    </div>`;
}

/**
 * Repaint the live toolbar from the state.
 * @returns {void}
 */
function tnLivePaint() {
  const e = tnLive.els;
  if (!e) return;
  e.bar.hidden = false; // with no BIN too: arming reads the maps off the ECU
  const lost = tnLive.armed && tnLive.link === 'lost';
  if (typeof tnGaugesSync === 'function') tnGaugesSync(); // the gauge windows follow live mode
  // While live, what is being edited is the car's own calibration: loading
  // another image or definition under it, or starting a whole read, has no
  // place, so those buttons step aside until live mode is off.
  for (const cls of [
    'tn-load-bin',
    'tn-read-ecu',
    'tn-load-xdf',
    'tn-browse-xdf',
    'tn-clear',
  ]) {
    const b = document.querySelector(`.${cls}`);
    if (b) b.hidden = tnLive.armed;
  }
  // Save BIN is the one file button that still means something live (a copy
  // of what the car holds): it comes down into this row, next to LIVE, and
  // goes back up beside Clear when live mode is off.
  const saveBin = document.querySelector('.tn-save');
  const clear = document.querySelector('.tn-clear');
  if (saveBin && clear) {
    if (tnLive.armed && saveBin.parentElement !== e.bar) e.arm.after(saveBin);
    else if (!tnLive.armed && saveBin.parentElement === e.bar)
      clear.before(saveBin);
  }
  e.arm.classList.toggle('on', tnLive.armed);
  e.arm.classList.toggle('lost', lost);
  e.arm.textContent = lost
    ? tnLive.why === 'ignition'
      ? '● LIVE · IGNITION OFF'
      : tnLive.why === 'cable'
        ? '● LIVE · NO CABLE'
        : '● LIVE · NO ECU'
    : tnLive.armed
      ? '● LIVE ON'
      : '○ LIVE';
  // the build saves at key-off and is only told whether to: a tick box
  e.keep.hidden = !tnLive.armed;
  e.keepBox.checked = tnLive.saveAsked;
  e.keepBox.disabled = tnLive.busy;
  const openCount = tnLive.armed && tnLive.lt ? tnLive.lt.tables.length : 0;
  e.discard.hidden = !tnLive.armed;
  e.discard.disabled = tnLive.busy || lost || !openCount;
  // the count of what is open is a switch: the list on the left shows only those
  const counting = tnLive.armed && !lost && !tnLive.error && !tnLive.busy;
  e.open.hidden = !counting;
  e.open.classList.toggle('on', !!tuningState.liveOnly);
  e.open.textContent = `${openCount} table${openCount === 1 ? '' : 's'} open on the ECU`;
  e.rest.textContent = '';
  e.rest.className = 'tn-live-status on';
  if (lost) {
    // the button says what is wrong; here only what that means for the edits
    const waiting = tnLive.pending.size;
    e.status.textContent = waiting
      ? `${waiting} edit${waiting === 1 ? '' : 's'} waiting to be sent`
      : '';
    e.status.className = 'tn-live-status err';
  } else if (tnLive.error) {
    e.status.textContent = tnLive.error;
    e.status.className = 'tn-live-status err';
  } else if (tnLive.armed) {
    const open = tnLive.lt ? tnLive.lt.tables.length : 0;
    e.status.textContent = tnLive.busy
      ? tnLive.progress || 'syncing…'
      : 'armed ·';
    e.status.className = 'tn-live-status on';
    if (!tnLive.busy)
      e.rest.textContent =
        `${tuningState.liveOnly ? '(only these are listed) ' : ''}${tnLiveSaveNote(open)}${tnLive.note || ''}`.replace(
          /^ · /,
          '· '
        );
  } else {
    e.status.textContent = '';
    e.status.className = 'tn-live-status';
  }
  // the row cuts a long sentence short; the whole of it is in the tooltip
  e.status.title = e.status.textContent;
  e.rest.title = e.rest.textContent;
}

/**
 * What will become of the open edits at key-off, for the status line. Only
 * said on a build that saves on request; older ones save whatever is open.
 * @param {number} open - Tables open on the DME.
 * @returns {string}
 */
function tnLiveSaveNote(open) {
  if (!open || !tnLive.lt) return '';
  return tnLive.saveAsked
    ? ' · will be saved when you switch the ignition off'
    : ' · not saved: lost at key-off unless you tick Save to ECU';
}

// NOTE on ROMX addressing (verified against the DME over the gateway): the
// speicher_lesen_ascii job takes a SEGMENT-RELATIVE 24-bit address, so the
// calibration -- image offset 0x40000 -- is read at ROMX offset 0x40000, NOT
// the absolute 0x2040000. The job builds `23 <addr:3> <segment> <len>`.
// tnLiveFillTable passes `imageOffset - TN_CAL_START` as the ROMX address,
// which for the calibration equals the image offset anyway (both 0x40000).

/**
 * A simple connecting modal with a line of progress text and a Cancel. The
 * returned handle updates the line and closes it.
 * @param {string} title
 * @returns {{say:(t:string)=>void, close:()=>void, cancelled:()=>boolean}}
 */
function tnLiveConnectingModal(title) {
  let cancelled = false;
  const { close } = openModal(
    `<div class="modal" role="dialog" aria-modal="true">
       <div class="modal-title">${title}</div>
       <div class="modal-body">
         <div class="tn-live-connecting">
           <span class="modal-spinner" aria-hidden="true"></span>
           <span class="tn-live-prog" id="tn-live-prog">reaching the ECU…</span>
         </div>
       </div>
       <div class="modal-actions">
         <button class="btn modal-cancel">Cancel</button>
       </div>
     </div>`,
    {
      onClose: () => {
        cancelled = true;
      },
    }
  );
  const prog = document.getElementById('tn-live-prog');
  const btn = document.querySelector('.modal-overlay .modal-cancel');
  if (btn)
    btn.onclick = () => {
      cancelled = true;
      close();
    };
  return {
    say: (t) => {
      if (prog) prog.textContent = t;
    },
    close,
    cancelled: () => cancelled,
  };
}

/**
 * Run a step that holds the wire, with the toolbar showing it: busy (and
 * what it is doing) while `fn` runs, repainted before and after. The step's
 * own error handling sets `tnLive.error`; this only clears it going in.
 * @template T
 * @param {string} progress - What the status line says meanwhile ('' for
 *   the plain "syncing…").
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function tnLiveWhileBusy(progress, fn) {
  tnLive.busy = true;
  tnLive.error = null;
  tnLive.progress = progress;
  tnLivePaint();
  try {
    return await fn();
  } finally {
    tnLive.busy = false;
    tnLive.progress = '';
    tnLivePaint();
  }
}

/**
 * Arm live mode. Shows a connecting modal while it initialises the MS45
 * session, probes for the live-tune build (op 04), and -- when no image is
 * loaded -- reads the calibration off the ECU and adopts it as the working
 * image, so the tables show the car's own values with no BIN to load.
 * Leaves `armed` false and an error set on failure.
 * @returns {Promise<void>}
 */
async function tnLiveArm(rejoin = false) {
  if (tnLive.busy) return;
  await tnLiveWhileBusy('', () => tnLiveConnect(rejoin));
}

/**
 * The connecting step of `tnLiveArm`, behind its modal.
 * @param {boolean} rejoin
 * @returns {Promise<void>}
 */
async function tnLiveConnect(rejoin) {
  const modal = tnLiveConnectingModal(
    rejoin ? 'Reconnecting to the ECU' : 'Connecting to the ECU'
  );
  try {
    if (typeof ms45LiveTuneSender !== 'function')
      throw new Error('the MS45 engine is not loaded');
    // every answer is a sign of life: the link check only speaks up when
    // nothing else has been heard for a while
    const raw = ms45LiveTuneSender();
    const send = async (data) => {
      const answer = await raw(data);
      if (answer) tnLive.heardAt = Date.now();
      return answer;
    };
    const lt = new LiveTune(send);
    modal.say('checking for the live-tune program…');
    const st = await lt.ping(); // op 04 brings the block up; absent build => null
    if (modal.cancelled()) throw new LtError('cancelled', 'cancelled');
    if (st === null)
      throw new Error('this ECU is not running the live-tune program');

    // No definition loaded: fetch the MS45 1024K XDF from the shared
    // library so the tables are there to browse the moment live mode is on,
    // with no file to load. A mirror being unreachable is not fatal -- the
    // user can still load one by hand -- so this only warns.
    if (
      !tuningState.def &&
      tnLive.ed &&
      typeof tnDownloadDefinition === 'function'
    ) {
      modal.say('loading the MS45 definition…');
      let loaded = false;
      for (const base of typeof XDF_MIRRORS !== 'undefined'
        ? XDF_MIRRORS
        : []) {
        if (modal.cancelled()) break;
        loaded = await tnDownloadDefinition(tnLive.ed, base, TN_LIVE_XDF);
        if (loaded) break;
      }
      if (!loaded && !modal.cancelled())
        tnLive.error = 'could not fetch the MS45 definition; load one by hand';
    }

    // No image loaded: give the editor a blank full-size image to decode
    // against, with the calibration marked as not-yet-read. Each map is then
    // read on demand when it is opened (tnLiveFillTable) -- a map is a few
    // hundred bytes, instant, where the whole 116 KB calibration is minutes.
    // The one thing that still needs the whole read is a backup download, on
    // its own button.
    if (!tuningState.bin) {
      const image = new Uint8Array(TN_CAL_END);
      image.fill(0xff, TN_CAL_START); // unread calibration reads as erased flash
      tnAdoptImage(image, TN_LIVE_IMAGE);
      tnLive.readOffsets = new Set(); // which cal offsets have been read in
      tnLive.wholeRead = false;
      if (tnLive.ed) {
        tnShowLoadedImage(tnLive.ed);
        tnBuildCoverage();
        tnLive.ed.hex.refresh();
        if (tuningState.def) tnRenderDefs(tnLive.ed);
        tnUpdateStatus(tnLive.ed);
      }
    }

    lt.onProgress = (text) => {
      tnLive.progress = text;
      tnLivePaint();
    };
    modal.say('reading which single values are live…');
    await lt.loadSingles();
    await lt.adopt(); // what the DME already has open (from before a reload)
    tnLive.saveAsked = await lt.saveAsked();
    // what was read on demand before may have been saved over since
    if (tnLive.readOffsets) tnLive.readOffsets = new Set();
    tnLive.baseKnown.fill(0); // the calibration may have been saved over: read the originals again
    tnLive.lt = lt;
    tnLive.note = '';
    tnLive.armed = true;
    tnLive.link = 'up';
    tnLive.misses = 0;
    tnLive.checkedAt = Date.now();
    clearTimeout(tnLive.beatTimer);
    tnLive.beatTimer = setTimeout(tnLiveBeat, TN_LIVE_BEAT_MS);
    tnLiveRemember(true);
  } catch (e) {
    // cancelling, or a DME that is not the build, ends it; anything else (the
    // ignition is off just now) leaves the next load free to try again
    if (
      e instanceof LtError
        ? e.code === 'cancelled' || e.code === 'absent'
        : /not running the live-tune/.test(String(e && e.message))
    )
      tnLiveRemember(false);
    tnLive.armed = false;
    tnLive.lt = null;
    tnLive.error =
      e instanceof LtError && e.code === 'cancelled'
        ? null
        : (e && e.message) || String(e);
  } finally {
    modal.close();
  }
}

/**
 * Disarm: close the open tables on the DME (best-effort) and drop the link.
 * @returns {Promise<void>}
 */
async function tnLiveDisarm() {
  const lt = tnLive.lt;
  const lost = tnLive.link === 'lost';
  tnLiveRemember(false); // switched off on purpose: a reload stays off
  tnLive.staged.clear();
  tnLive.armed = false;
  tnLive.lt = null;
  tnLive.error = null;
  tnLive.link = 'up';
  clearTimeout(tnLive.beatTimer);
  if (tuningState.liveOnly) tnLiveShowOpenOnly(false);
  tnLivePaint();
  if (lt && lt.tables.length && !lost) {
    try {
      await lt.closeAll();
    } catch (e) {
      /* the wire may be gone; nothing to do but forget */
    }
  }
}

/**
 * The calibration range an edited byte belongs to, as DME offsets: the
 * table that owns it (coverage owner map), clipped to the calibration. A
 * single scalar or flag is a range too. Null when the byte is outside the
 * calibration, or the definition describes nothing there.
 * @param {number} address - An IMAGE offset.
 * @param {Map<XdfItem,1|2>} [cells] - Cell widths already worked out, so a
 *   bulk edit decodes each table once rather than once per byte.
 * @returns {{offset:number, length:number, cell:1|2}|null}
 */
function tnLiveRangeAt(address, cells) {
  if (address < TN_CAL_START || address >= TN_CAL_END) return null;
  const rec = tnOwnerRecordAt(address);
  if (!rec) return null;
  const start = Math.max(TN_CAL_START, rec.start);
  const end = Math.min(TN_CAL_END, rec.end);
  if (end <= start) return null;
  const table = rec.item.kind === 'table';
  let cell = cells && cells.get(rec.item);
  if (!cell) {
    cell = tnLiveCellWidth(rec.item);
    if (cells) cells.set(rec.item, cell);
  }
  return { offset: start - TN_CAL_START, length: end - start, cell, table };
}

/**
 * How wide an item's cells are on the wire, so sync never leaves a 16-bit
 * cell half-written: tables carry a Z spec, scalars an embed size.
 * @param {XdfItem} item
 * @returns {1|2}
 */
function tnLiveCellWidth(item) {
  try {
    if (item.kind === 'table') {
      const t = window.XDF.decodeTable(
        item,
        tuningState.bin,
        tuningState.def.header
      );
      if (t && t.spec.sizeBits > 8) return 2;
    }
  } catch (e) {
    /* shown as single bytes */
  }
  return 1;
}

/**
 * A write just landed in the image. If live mode is armed and it fell in
 * the calibration, mirror it onto the DME: open the owning table (once) and
 * sync its bytes. Fire-and-forget by design -- tnWriteBytes is synchronous
 * and the editor must not block on the wire -- so failures surface in the
 * status line, not as a thrown error that would undo the local edit.
 * @param {number} address - IMAGE offset the write started at.
 * @param {number} length - Bytes written.
 * @returns {void}
 */
function tnLiveOnWrite(address, length) {
  if (!tnLive.armed || !tnLive.lt) return;
  if (tnLive.suppressWrite) return; // this write is a read-back, not an edit
  tnLive.editedAt = Date.now(); // the live cursor keeps off the line for a while after
  // every byte of a bulk op may span several tables; collect the ranges hit
  const ranges = new Map();
  const cells = new Map();
  for (let a = address; a < address + length; a++) {
    const r = tnLiveRangeAt(a, cells);
    if (r) ranges.set(r.offset, r);
  }
  if (!ranges.size) {
    if (address < TN_CAL_END && address + length > TN_CAL_START) {
      tnLive.error = 'edit outside any defined table is not sent live';
      tnLivePaint();
    }
    return;
  }
  let locked = false;
  for (const r of ranges.values()) {
    if (
      TN_LIVE_LOCKED.some(
        ([lo, hi]) => r.offset < hi && r.offset + r.length > lo
      )
    ) {
      locked = true;
      continue;
    }
    if (
      typeof tnTableStages === 'function' &&
      tnTableStages(TN_CAL_START + r.offset, r.length)
    )
      tnLive.staged.set(r.offset, r); // the open table's: sent when Apply is pressed
    else tnLive.pending.set(r.offset, r);
  }
  if (locked) {
    tnLive.error =
      'not sent: this is the safety monitor’s own checksum or its off switch, which live mode leaves alone';
    tnLivePaint();
  }
  tnLivePump();
}

/**
 * Apply: send the edits the open table has been holding. They are sent as
 * the editor holds the table now, so several edits to one table are one sync.
 * @returns {void}
 */
function tnLiveApplyStaged() {
  for (const [offset, r] of tnLive.staged) tnLive.pending.set(offset, r);
  tnLive.staged.clear();
  tnLivePump();
}

/**
 * The open table was closed without Apply: what it was holding is not sent.
 * (The editor puts its own copy back; see the table editor's close.)
 * @returns {void}
 */
function tnLiveDropStaged() {
  tnLive.staged.clear();
}

/**
 * Send what is pending, ONE sync at a time. A bulk edit lands as one write
 * per cell, and each used to start its own sync: nine of them all saw the
 * table not yet open and all opened it, which filled the DME's seven slots
 * with copies of one table (seen on the car). Writes that arrive while a
 * sync runs are picked up by the next pass, which sends the table as the
 * editor then holds it.
 * @returns {Promise<void>}
 */
async function tnLivePump() {
  if (tnLive.pumping) return;
  tnLive.pumping = true;
  try {
    await null; // let the rest of this edit's writes land first
    // with the DME gone the edits wait; the link check sends them when it is back
    while (
      tnLive.pending.size &&
      tnLive.armed &&
      tnLive.lt &&
      tnLive.link !== 'lost'
    ) {
      const batch = [...tnLive.pending.values()];
      tnLive.pending.clear();
      await tnLiveSync(batch);
    }
  } finally {
    tnLive.pumping = false;
  }
}

/**
 * Send the given calibration ranges to the DME, serialised so two edits in
 * a row cannot interleave on the half-duplex wire.
 * @param {Array<{offset:number,length:number,cell:1|2}>} ranges
 * @returns {Promise<void>}
 */
async function tnLiveSync(ranges) {
  await tnLiveWhileBusy('', () => tnLiveSend(ranges));
  // the list is showing what is open, and that has just changed
  if (tuningState.liveOnly && tnLive.ed && !tuningState.openTable)
    tnRenderDefs(tnLive.ed);
}

/**
 * The sending step of `tnLiveSync`: what it could not send is said in the
 * toolbar, and a DME that went quiet or restarted is dealt with.
 * @param {Array<{offset:number,length:number,cell:1|2}>} ranges
 * @returns {Promise<void>}
 */
async function tnLiveSend(ranges) {
  try {
    let moved = false;
    for (const r of ranges) {
      const lt = tnLive.lt;
      const table = await lt.open(r.offset, r.length);
      const want = tuningState.bin.slice(
        TN_CAL_START + r.offset,
        TN_CAL_START + r.offset + r.length
      );
      await lt.sync(table, want, r.cell);
      // Read the mirror the DME is actually using back, so the grid shows
      // what LANDED, not just what we sent -- the live confirmation. The
      // mirror reflects the edit instantly (stock 23 reads RAM).
      await tnLiveReadBack(table);
      // A single value no pool holds goes on the DME's data breakpoint
      // (build 6): the last one edited is live, the one before it is not
      if (!r.table && lt.canWatch() && !lt.liveSingle(r.offset, r.length)) {
        const was = lt.watching;
        await lt.watch(table);
        if (was && was.offset !== r.offset) moved = true;
      }
    }
    // Tables are read through the lookup library the build redirects. A
    // single value or a flag is read by the program straight from the
    // calibration: live on a build that patches those reads (and says so,
    // value by value), otherwise its mirror changes nothing until a save.
    const later = ranges.filter(
      (r) => !r.table && !tnLive.lt.liveSingle(r.offset, r.length)
    );
    tnLive.note = !later.length
      ? moved
        ? ' · one single value at a time is live this way: this one now, the one before after a save'
        : ''
      : later.length === ranges.filter((r) => !r.table).length &&
          !tnLive.lt.singles
        ? ' · single values and flags only take effect after a save'
        : ' · this value only takes effect after a save';
  } catch (e) {
    tnLive.error = (e && e.message) || String(e) || 'the live sync failed';
    if (e instanceof LtError && e.code === 'lost') {
      await tnLiveRestarted();
    } else if (e instanceof LtError && e.code === 'silent') {
      // the DME is not answering: keep the edits and let the link check
      // carry on asking. They are sent when it answers again.
      tnLive.error = null;
      tnLive.link = 'lost';
      tnLive.why = 'silent';
      for (const r of ranges) tnLive.pending.set(r.offset, r);
    } else if (e instanceof LtError && e.code === 'absent') {
      // it was never the build: stop pretending we are live
      tnLive.armed = false;
      tnLive.lt = null;
    }
  }
}

/**
 * The definition items that are open on the DME: every item owning a byte of
 * an open range. What the list on the left narrows to when the count in the
 * toolbar is clicked.
 * @returns {Set<XdfItem>}
 */
function tnLiveOpenItems() {
  const items = new Set();
  if (!tnLive.lt) return items;
  for (const t of tnLive.lt.tables)
    for (
      let a = TN_CAL_START + t.offset;
      a < TN_CAL_START + t.offset + t.length;
      a++
    ) {
      const rec = tnOwnerRecordAt(a);
      if (rec) items.add(rec.item);
    }
  return items;
}

/**
 * Narrow the list on the left to what is open on the DME, or widen it again.
 * @param {boolean} on
 * @returns {void}
 */
function tnLiveShowOpenOnly(on) {
  tuningState.liveOnly = on;
  tnLivePaint();
  if (tnLive.ed) tnRenderDefs(tnLive.ed);
}

/**
 * Discard every live edit: close all the open tables on the DME, which goes
 * back to reading its calibration (a single value with RAM of its own is
 * refilled from it), take back a save that was asked for, and put the
 * calibration's values back into the editor for everything that was open.
 * "Before the edits" is what the DME's calibration holds: an edit a key-off
 * has already saved is part of that and stays.
 * @returns {Promise<void>}
 */
async function tnLiveDiscard() {
  const lt = tnLive.lt;
  if (!lt || tnLive.busy || !lt.tables.length) return;
  const open = lt.tables.map((t) => ({ offset: t.offset, length: t.length }));
  const ok = await confirmDialog({
    title: 'Discard the live edits?',
    body: `<p>${open.length} table${open.length === 1 ? '' : 's'} open on the ECU will be closed and go back to the values its calibration holds. This cannot be undone.</p>`,
    confirmLabel: 'Discard edits',
    cancelLabel: 'Cancel',
  });
  if (!ok || tnLive.lt !== lt) return;
  await tnLiveWhileBusy('discarding…', async () => {
    try {
      tnLive.pending.clear();
      tnLive.staged.clear();
      await lt.closeAll();
      if (tnLive.saveAsked) {
        await lt.askSave(false);
        tnLive.saveAsked = false;
      }
      tnLive.suppressWrite = true;
      try {
        for (const r of open) {
          const stock = await lt.readCal(r.offset, r.length);
          tuningState.bin.set(stock, TN_CAL_START + r.offset);
          tnLiveBaseline(TN_CAL_START + r.offset, stock);
        }
      } finally {
        tnLive.suppressWrite = false;
      }
      tnLive.note = '';
    } catch (e) {
      tnLive.error = `could not discard: ${(e && e.message) || e}`;
    } finally {
      if (tuningState.liveOnly) tuningState.liveOnly = false; // nothing is open any more
    }
  });
  if (tnLive.ed) {
    if (typeof tnRecountChanges === 'function') tnRecountChanges();
    tnLive.ed.hex.refresh();
    tnRenderDefs(tnLive.ed);
    if (typeof tnTableRefreshOpen === 'function') tnTableRefreshOpen(); // a table left open shows them too
  }
}

/**
 * The link check: live mode's ping. While armed it asks the DME for its
 * state whenever nothing has been heard from it for a few seconds (traffic
 * of any kind counts, so a running cursor needs no extra requests), and
 * never while an edit is on the wire. That tells three things apart:
 *
 *  - it does not answer, twice running: disconnected (ignition off, cable
 *    out). Said in the toolbar; edits wait; it keeps asking.
 *  - it answers again: connected. Waiting edits are sent.
 *  - it answers but holds nothing of ours: it restarted. What this page
 *    thought was open is dropped and values are read again when opened.
 * @returns {Promise<void>}
 */
async function tnLiveBeat() {
  const lt = tnLive.lt;
  if (!tnLive.armed || !lt) return;
  const again = () => {
    if (tnLive.armed && tnLive.lt === lt)
      tnLive.beatTimer = setTimeout(tnLiveBeat, TN_LIVE_BEAT_MS);
  };
  const lose = (why) => {
    if (tnLive.link === 'lost' && tnLive.why === why) return;
    tnLive.link = 'lost';
    tnLive.why = why;
    tnLivePaint();
  };

  // The cable knows two things before the DME goes quiet: that it is still
  // plugged in, and (a K+DCAN cable, on its DSR line) whether the ignition
  // is on. Ignition off is said at once -- the DME answers for half a minute
  // more while it shuts down, and an edit sent then is an edit lost.
  const line = await tnLiveLine();
  if (tnLive.lt !== lt) return;
  if (line) {
    lose(line);
    again();
    return;
  }

  const now = Date.now();
  const lost = tnLive.link === 'lost';
  const due =
    now - Math.max(tnLive.heardAt, tnLive.checkedAt) >=
    (lost ? TN_LIVE_RETRY_MS : TN_LIVE_QUIET_MS);
  if (
    (due || (lost && tnLive.why !== 'silent')) &&
    !tnLive.busy &&
    !tnLive.pumping
  ) {
    tnLive.checkedAt = now;
    if (!tnLive.probe) {
      const asked = lt.readState().then(
        (state) => ({ answered: true, state }),
        () => ({ answered: false })
      );
      tnLive.probe = asked;
      asked.then(() => {
        if (tnLive.probe === asked) tnLive.probe = null;
      });
    }
    const r = await Promise.race([
      tnLive.probe,
      new Promise((resolve) =>
        setTimeout(() => resolve({ answered: false }), TN_LIVE_PROBE_MS)
      ),
    ]);
    if (tnLive.lt !== lt) return; // disarmed while the question was out
    if (!r.answered) {
      if (++tnLive.misses >= TN_LIVE_MISSES || lost) lose('silent');
    } else {
      tnLive.misses = 0;
      tnLive.link = 'up';
      // the block gone, or fewer tables than this page opened: a restart
      if (!r.state || r.state.count < lt.tables.length) await tnLiveRestarted();
      if (lost || !r.state) tnLivePaint();
      if (tnLive.pending.size) tnLivePump();
    }
  }
  again();
}

/**
 * What the cable itself says is wrong, without a word to the DME: 'cable'
 * when it is unplugged, 'ignition' when it reports the ignition off (only a
 * cable that really senses it; one that assumes it is on says nothing).
 * @returns {Promise<'cable'|'ignition'|null>}
 */
async function tnLiveLine() {
  if (typeof webBus === 'undefined' || !webBus) return null;
  if (!webBus.connected) return 'cable';
  if (typeof webBus.readState !== 'function') return null;
  try {
    const st = await Promise.race([
      webBus.readState(),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return st && !st.derived && st.ignition === false ? 'ignition' : null;
  } catch (e) {
    return null;
  }
}

/**
 * The DME restarted under us (a key cycle, a key-off save): nothing is open
 * on it any more and its calibration may have changed. Drop what this page
 * thought was open, and forget what was read on demand so every value is
 * read again. Edits that were not saved are gone from the DME; the
 * editor's own copy is put back to what the DME holds as each item is opened.
 * @returns {Promise<void>}
 */
async function tnLiveRestarted() {
  if (!tnLive.lt) return;
  try {
    await tnLive.lt.resync();
    tnLive.saveAsked = false;
    tnLive.readOffsets = new Set();
    tnLive.baseKnown.fill(0); // the calibration may have been saved over: read the originals again
    tnLive.wholeRead = false;
    tnLive.pending.clear();
    tnLive.error = null; // nothing to tell: values are read again as they are opened
  } catch (e2) {
    tnLive.armed = false;
    tnLive.lt = null;
    tnLive.error = 'the ECU restarted and did not answer again';
  }
}

/**
 * Read one definition item's calibration bytes from the ECU on demand and
 * fold them into the working image, so opening a map under live mode shows
 * the car's real values without having read the whole calibration. A no-op
 * unless live mode is on, the item is in the calibration, and its range has
 * not already been read. Reads from ROMX (the stored calibration), so it
 * reflects what is flashed; an open table's live edits still come through
 * tnLiveReadBack.
 * @param {XdfItem} item - The definition item being opened.
 * @returns {Promise<boolean>} Whether image bytes were actually read in (so
 *   a caller knows to re-render).
 */
async function tnLiveFillTable(item) {
  if (!tnLive.armed || !tnLive.lt || !tuningState.bin) return false;
  if (
    typeof ms45ReadMemory !== 'function' ||
    typeof tnItemByteRange !== 'function'
  )
    return false;
  if (!tnLive.readOffsets) tnLive.readOffsets = new Set(); // survives a restore
  const ranges = [];
  try {
    ranges.push(tnItemByteRange(item));
    // a table's break points are calibration too, stored somewhere else:
    // without them the grid is headed with whatever the blank image holds
    if (item.kind === 'table') {
      const h = tuningState.def.header;
      const t = window.XDF.decodeTable(item, tuningState.bin, h);
      for (const [axis, count] of t
        ? [
            [t.x, t.cols],
            [t.y, t.rows],
          ]
        : []) {
        if (!axis || !axis.embed || !axis.embed.address) continue;
        const spec = window.XDF.resolveEmbedded(
          axis.embed,
          h.baseOffset,
          h.defaults
        );
        const bytes = Math.max(1, Math.ceil(spec.sizeBits / 8));
        ranges.push({ start: spec.address, end: spec.address + count * bytes });
      }
    }
  } catch (e) {
    /* what could be worked out is read */
  }
  let filled = false;
  for (const range of ranges)
    if (range && (await tnLiveFillRange(range))) filled = true;
  return filled;
}

/**
 * Read one span of the calibration from the ECU into the working image
 * (see tnLiveFillTable), unless it has been read already.
 * @param {{start:number, end:number}} range - IMAGE offsets.
 * @returns {Promise<boolean>} Whether image bytes changed.
 */
async function tnLiveFillRange(range) {
  if (!tnLive.armed || !tnLive.lt) return false;
  const start = Math.max(TN_CAL_START, range.start);
  const end = Math.min(TN_CAL_END, range.end);
  if (end <= start) return false; // not in the calibration (program area, etc.)
  const key = `${start}:${end}`;
  // Is this range already open on the DME? If so its LIVE value lives in its
  // mirror (RAM, or the shelf), not where the calibration stores it -- reading
  // that here would paint the stock (unsaved) value over an edit the user
  // already made live. Read the mirror.
  let open = tnLive.lt.tables.find(
    (t) =>
      TN_CAL_START + t.offset <= start &&
      end <= TN_CAL_START + t.offset + t.length
  );
  // a mirror is only worth reading if the DME still holds it: after a key
  // cycle its address is just whatever RAM has there
  if (open) {
    let held = false;
    try {
      held = await tnLive.lt.inSync();
    } catch (e) {
      held = false;
    }
    if (!held) {
      await tnLiveRestarted();
      tnLivePaint();
      if (!tnLive.lt) return false;
      open = undefined;
    }
  }
  if (!open && (tnLive.wholeRead || tnLive.readOffsets.has(key))) return false; // flash already read
  // a read is not an edit: what the status line was saying stays
  const error = tnLive.error;
  return tnLiveWhileBusy('', () =>
    tnLiveFillRead(open, start, end, key, error)
  );
}

/**
 * The reading step of `tnLiveFillRange`.
 * @param {object|undefined} open - The open table holding the span, if any.
 * @param {number} start - IMAGE offset.
 * @param {number} end
 * @param {string} key - The span's entry in `readOffsets`.
 * @param {string|null} error - What the status line said before.
 * @returns {Promise<boolean>} Whether image bytes changed.
 */
async function tnLiveFillRead(open, start, end, key, error) {
  tnLive.error = error;
  let filled = false;
  try {
    let bytes;
    if (open) {
      // the mirror reflects every live edit instantly
      const rel = start - (TN_CAL_START + open.offset);
      bytes = await tnLive.lt.readTable(open, rel, end - start);
      // the mirror is the edit; what the calibration itself holds is the
      // original, and on the blank image it has to be fetched as well
      if (tnLiveBlankImage() && !tnLive.baseKnown[start - TN_CAL_START])
        tnLiveBaseline(start, await ms45ReadMemory(start, end - 1, 'ROMX'));
    } else {
      // ROMX address == image offset for the calibration (both place it at
      // 0x40000): the CLI proved `ROMX;0x40000` returns the cal header, so a
      // table at image 0x44395 is ROMX 0x44395.
      bytes = await ms45ReadMemory(start, end - 1, 'ROMX');
    }
    if (bytes && bytes.length) {
      tnLive.suppressWrite = true;
      try {
        for (let i = 0; i < bytes.length; i++) {
          // "filled" only when the image actually changed: the caller
          // re-renders on it, the re-render asks again, and an open table
          // is always re-read -- reporting true every time looped forever
          // (the status stuck on "syncing" and the bus never went quiet)
          if (tuningState.bin[start + i] !== bytes[i]) filled = true;
          tuningState.bin[start + i] = bytes[i];
        }
      } finally {
        tnLive.suppressWrite = false;
      }
      if (!open) {
        tnLive.readOffsets.add(key); // cache flash reads; mirrors re-read
        tnLiveBaseline(start, bytes);
      }
      if (tnLive.ed) {
        if (typeof tnRecountChanges === 'function') tnRecountChanges();
        tnLive.ed.hex.refresh();
      }
    }
  } catch (e) {
    tnLive.error = `could not read the map from the ECU: ${(e && e.message) || e}`;
  }
  return filled;
}

/**
 * Read an open table's mirror back from the DME and fold it into the loaded
 * image WITHOUT re-triggering a live write, so the grid repaints with the
 * ECU's actual values. Guarded by a flag the write hook checks, because
 * writing these bytes back through tnWriteBytes would otherwise loop.
 * @param {{slot:number,offset:number,length:number}} table
 * @returns {Promise<void>}
 */
async function tnLiveReadBack(table) {
  if (!tnLive.lt || !tuningState.bin) return;
  const mirror = tnLive.lt.tables.find((t) => t.slot === table.slot);
  if (!mirror) return;
  const bytes = await tnLive.lt.readTable(mirror, 0, table.length);
  tnLive.suppressWrite = true;
  try {
    for (let i = 0; i < bytes.length; i++)
      tuningState.bin[TN_CAL_START + table.offset + i] = bytes[i];
  } finally {
    tnLive.suppressWrite = false;
  }
  // repaint whatever is showing those bytes
  if (tnLive.ed) {
    if (typeof tnRecountChanges === 'function') tnRecountChanges();
    tnLive.ed.hex.refresh();
    if (tuningState.openTable && typeof tnRenderDefs === 'function')
      tnRenderDefs(tnLive.ed);
  }
}

/**
 * Tell the DME whether to keep the edits: it writes nothing now and folds
 * the open tables into its calibration itself at key-off when asked.
 * Unticking takes the request back.
 * @returns {Promise<void>}
 */
async function tnLiveSave() {
  if (!tnLive.lt || tnLive.busy) return;
  await tnLiveWhileBusy('', async () => {
    try {
      await tnLive.lt.askSave(!tnLive.saveAsked);
      tnLive.saveAsked = !tnLive.saveAsked;
    } catch (e) {
      tnLive.error = (e && e.message) || String(e);
    }
  });
}

/**
 * Live mode was on when the page was last open (a reload, or coming back to
 * this screen): go back into it. The DME kept everything that was open, so
 * arming takes it over again. Waits for the cable first -- it reconnects by
 * itself a moment after the page loads -- and gives up quietly if it has not.
 * @returns {Promise<void>}
 */
async function tnLiveRejoin() {
  let was = false;
  try {
    was = localStorage.getItem(TN_LIVE_KEY) === '1';
  } catch (e) {
    was = false;
  }
  if (!was || tnLive.armed) return;
  const ed = tnLive.ed;
  // the saved session first (the image and definition of the last visit):
  // arming with nothing loaded would start a blank image in its place
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await (ed && ed.restored);
  } catch (e) {
    /* nothing saved: arming starts from the car alone */
  }
  const deadline = Date.now() + TN_LIVE_REJOIN_MS;
  while (
    typeof webBus !== 'undefined' &&
    webBus &&
    !webBus.connected &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 250));
  if (tnLive.ed !== ed || tnLive.armed || tnLive.busy) return; // the screen moved on
  if (typeof webBus !== 'undefined' && webBus && !webBus.connected) return; // no cable: stay off, ask again next load
  await tnLiveArm(true);
}

/**
 * Wire the live toolbar once the screen is built.
 * @param {TuningEditor} ed
 * @returns {void}
 */
function tnLiveInit(ed) {
  tnLive.ed = ed;
  tnLive.armed = false;
  tnLive.lt = null;
  tnLive.busy = false;
  tnLive.error = null;
  tnLive.pending.clear();
  tnLive.link = 'up';
  clearTimeout(tnLive.beatTimer);
  const bar = document.getElementById('tn-live');
  if (!bar) return;
  tnLive.els = {
    bar,
    arm: document.getElementById('tn-live-arm'),
    keep: document.getElementById('tn-live-keep'),
    keepBox: document.getElementById('tn-live-keep-box'),
    discard: document.getElementById('tn-live-discard'),
    open: document.getElementById('tn-live-open'),
    rest: document.getElementById('tn-live-rest'),
    status: document.getElementById('tn-live-status'),
  };
  tnLive.els.arm.onclick = () => (tnLive.armed ? tnLiveDisarm() : tnLiveArm());
  if (typeof tnGaugesInit === 'function') tnGaugesInit();
  tnLiveRejoin();
  // the box shows what the DME was told, so it only moves once that is known
  tnLive.els.keepBox.onchange = () => tnLiveSave();
  tnLive.els.discard.onclick = () => tnLiveDiscard();
  tnLive.els.open.onclick = () => tnLiveShowOpenOnly(!tuningState.liveOnly);
  tnLivePaint();
}
