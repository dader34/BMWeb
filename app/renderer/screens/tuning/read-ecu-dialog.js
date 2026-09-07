/**
 * @file Tuning screen: the Read from ECU dialog. Pull a live memory image
 * off a module and treat it exactly like a loaded file, so the whole hex
 * editor (find, inspector, goto, .xdf overlay) works on it unchanged.
 * READ ONLY: every job offered here is a *_LESEN.
 *
 * The regions are not hardcoded and not mined from an INPA screen -- they
 * come from a sourced flash profile where one exists, else from each job's
 * own argument spec (address range, max chunk, and crucially its UNIT),
 * else the user types a start and a length. See memory-spec.js.
 *
 * Before any read the module is IDENTIFIED (group probe or IDENT), so a
 * module that is not on this car says so in words, instead of a bare status
 * token. A refused read shows the SGBD's own status text, and says whether
 * the ECU refused or the job never transmitted.
 */

/* exported tnOpenReadFromEcu */

/** Debounce between typing in the module box and listing its jobs. */
const TN_LOOKUP_DEBOUNCE_MS = 250;
/** The largest count a single read argument may carry. */
const TN_MAX_CHUNK = 255;
/** Bytes read by default when nothing sourced bounds the memory. */
const TN_UNBOUNDED_DEFAULT_BYTES = 256;

/**
 * Identify outcomes that stop a read before it starts.
 * @type {Set<string>}
 */
const TN_IDENT_BLOCKS = new Set([
  'silent',
  'unmatched',
  'variant',
  'refused',
  'no-cable',
  'error',
]);

/**
 * @typedef {Object} ReadPlan
 * @property {number} start - First address, in the region's address unit.
 * @property {number} end - Last address, inclusive.
 * @property {number} chunk - Per-read count.
 */

/**
 * The range / per-read line on a region card.
 * @param {TmRegion} r
 * @returns {string}
 */
function tnRegionMeta(r) {
  const span = r.hi != null ? r.hi - r.lo + 1 : 0;
  const bytes = span * r.wordBytes;
  const unitWord = r.unit === 'word';
  let range;
  if (r.rangeKind === 'profile') {
    range = `${tnFmtAddr(r.lo, r.addrDigits)}–${tnFmtAddr(r.hi, r.addrDigits)} · ${fmtBytes(bytes)}`;
  } else if (r.rangeKind === 'declared') {
    range =
      `${tnFmtAddr(r.lo, r.addrDigits)}–${tnFmtAddr(r.hi, r.addrDigits)}` +
      ` · ${span} ${unitWord ? 'words' : 'bytes'}` +
      (unitWord ? ` (${bytes} bytes)` : '');
  } else if (r.rangeKind === 'field') {
    range = `${r.addrDigits * 4}-bit address field · extent not declared`;
  } else {
    range = 'range not declared';
  }
  const chunk = r.maxKnown
    ? `${r.max}${unitWord ? ' words' : ''}/read`
    : `per read not declared (${TM_UNKNOWN_CHUNK} default)`;
  return `${range} · ${chunk}`;
}

/**
 * The provenance line on a region card: the lock reason, the profile, or
 * the SGBD author's own words for the bounds.
 * @param {TmRegion} r
 * @returns {string}
 */
function tnRegionNote(r) {
  if (r.locked) return r.locked;
  if (r.source === 'profile') {
    return (
      `${r.profile} flash profile` +
      (r.verified ? ' · real-car verified' : ' · not yet real-car verified')
    );
  }
  const bits = [];
  if (r.addrComment) bits.push(`${r.addrArg}: ${r.addrComment}`);
  if (r.countComment) bits.push(`${r.lenArg}: ${r.countComment}`);
  return bits.join(' · ') || 'the job documents no bounds';
}

/**
 * The span to prefill for a region. A field-width or undeclared range
 * leaves the length for the user, since nothing sourced says how much
 * memory is there.
 * @param {TmRegion} r
 * @returns {{ len: number, note: string }}
 */
function tnSpanDefaults(r) {
  const cap = r.source === 'profile' ? Infinity : TM_MAX_TOTAL;
  const span = r.hi != null ? r.hi - r.lo + 1 : 0;
  let len;
  let note;
  if (r.rangeKind === 'profile' || r.rangeKind === 'declared') {
    len = span;
    note =
      r.rangeKind === 'profile'
        ? `Whole region as the ${r.profile} profile documents it.`
        : 'Whole declared range; shorten it to read part.';
  } else if (r.rangeKind === 'field' && span * r.wordBytes <= cap) {
    len = span;
    note =
      `The whole ${r.addrDigits * 4}-bit address field. The module may hold less ` +
      'and answer short, which ends the read.';
  } else {
    // nothing sourced bounds this memory: start small, say so, and let
    // the user widen it
    len = Math.max(1, Math.floor(TN_UNBOUNDED_DEFAULT_BYTES / r.wordBytes));
    note =
      `The module's memory map is not declared anywhere this build can read: ` +
      `this reads ${fmtBytes(len * r.wordBytes)} from the start. Change the start and ` +
      `length as needed (up to ${fmtBytes(TM_MAX_TOTAL)}).`;
  }
  if (!r.maxKnown) {
    note +=
      ' The job does not say how many bytes one read may return; lower "per read" if the module refuses.';
  }
  return { len, note };
}

/**
 * Validate the typed span.
 * @param {TmRegion|null} r
 * @param {string} startTxt
 * @param {string} lenTxt
 * @param {string} chunkTxt
 * @returns {ReadPlan|string} The plan, or the error to show.
 */
function tnReadPlan(r, startTxt, lenTxt, chunkTxt) {
  if (!r) return 'pick a region';
  const startHex = startTxt.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(startHex)) return 'start must be a hex address';
  const start = parseInt(startHex, 16);
  const len = parseInt(lenTxt.trim(), 10);
  if (!Number.isFinite(len) || len <= 0)
    return 'length must be a positive number';
  const chunk = parseInt(chunkTxt.trim(), 10);
  if (!Number.isFinite(chunk) || chunk <= 0)
    return 'per read must be a positive number';
  if (r.maxKnown && chunk > r.max)
    return `this job allows at most ${r.max} per read`;
  if (chunk > TN_MAX_CHUNK) return `per read cannot exceed ${TN_MAX_CHUNK}`;
  const end = start + len - 1;
  if (r.hi != null && (start < r.lo || end > r.hi)) {
    return `outside the region ${tnFmtAddr(r.lo, r.addrDigits)}–${tnFmtAddr(r.hi, r.addrDigits)}`;
  }
  const cap = r.source === 'profile' ? Infinity : TM_MAX_TOTAL;
  if (len * r.wordBytes > cap)
    return `at most ${fmtBytes(cap)} per read session`;
  return { start, end, chunk };
}

/**
 * The dialog's markup.
 * @returns {string}
 */
function tnReadEcuHtml() {
  return `
      <div class="modal tn-ecu-modal" role="dialog" aria-modal="true">
        <div class="modal-title">Read memory from an ECU</div>
        <div class="modal-body">
          <div class="tn-ecu-row">
            <label class="tn-ecu-lbl" for="tn-ecu-car">Car</label>
            <select class="tn-ecu-car" id="tn-ecu-car">
              <option value="">any chassis</option>
            </select>
          </div>
          <div class="tn-ecu-row">
            <label class="tn-ecu-lbl" for="tn-ecu-sgbd">Module</label>
            <div class="tn-ecu-combo" id="tn-ecu-combo">
              <input class="tn-ecu-in" id="tn-ecu-sgbd" role="combobox"
                     aria-expanded="false" aria-controls="tn-ecu-sug" aria-autocomplete="list"
                     placeholder="Select or search a module…" spellcheck="false" autocomplete="off">
              <button type="button" class="tn-ecu-caret" id="tn-ecu-caret"
                      aria-label="Show all modules" tabindex="-1">▾</button>
            </div>
          </div>
          <div class="tn-ecu-sug" id="tn-ecu-sug" role="listbox" hidden></div>
          <div class="tn-ecu-ident" id="tn-ecu-ident" hidden></div>
          <div class="tn-ecu-regions" id="tn-ecu-regions">
            <div class="tn-ecu-hint">Pick a module to see what it can read.</div>
          </div>
          <div class="tn-ecu-span" id="tn-ecu-span" hidden>
            <label class="tn-ecu-field">Start
              <input class="tn-ecu-num" id="tn-ecu-start" spellcheck="false" autocomplete="off"></label>
            <label class="tn-ecu-field">Length
              <input class="tn-ecu-num" id="tn-ecu-len" inputmode="numeric" autocomplete="off">
              <span id="tn-ecu-unit">bytes</span></label>
            <label class="tn-ecu-field">Per read
              <input class="tn-ecu-num" id="tn-ecu-chunk" inputmode="numeric" autocomplete="off"></label>
            <div class="tn-ecu-span-note" id="tn-ecu-span-note"></div>
          </div>
          <div class="tn-ecu-prog" id="tn-ecu-prog" hidden></div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="tn-ecu-cancel">Cancel</button>
          <button class="btn primary" id="tn-ecu-go" disabled>Read</button>
        </div>
      </div>`;
}

/**
 * Open the dialog, and on a successful read hand the bytes to the editor
 * as a loaded image.
 * @param {TuningEditor} ed
 * @returns {Promise<void>}
 */
async function tnOpenReadFromEcu(ed) {
  const els = ed.els;
  if (typeof window.TuningMemory === 'undefined') {
    els.status.textContent = 'memory reader not loaded';
    return;
  }
  const TM = window.TuningMemory;

  let sgbds = [];
  try {
    sgbds = typeof tool32SgbdList === 'function' ? await tool32SgbdList() : [];
  } catch (e) {
    /* fall through to the empty-state below */
  }

  const { overlay, close } = openModal(tnReadEcuHtml(), {
    backdropValue: null,
  });

  const $ = (sel) => overlay.querySelector(sel);
  const carSel = $('#tn-ecu-car');
  const sgbdIn = $('#tn-ecu-sgbd');
  const identEl = $('#tn-ecu-ident');
  const regionBox = $('#tn-ecu-regions');
  const spanBox = $('#tn-ecu-span');
  const startIn = $('#tn-ecu-start');
  const lenIn = $('#tn-ecu-len');
  const unitEl = $('#tn-ecu-unit');
  const chunkIn = $('#tn-ecu-chunk');
  const spanNote = $('#tn-ecu-span-note');
  const prog = $('#tn-ecu-prog');
  const goBtn = $('#tn-ecu-go');
  const st = {
    sgbd: '',
    /** @type {TmRegion[]} */
    regions: [],
    /** @type {TmRegion|null} */
    pick: null,
    busy: false,
    cancel: false,
    car: '',
    /** @type {TmCarModule[]} from the chassis config */
    carRows: [],
    /** @type {string[]} */
    other: [],
    /** @type {Map<string, TmIdentResult>} sgbd -> identify result, once per dialog */
    ident: new Map(),
  };

  $('#tn-ecu-cancel').onclick = () => {
    st.cancel = true;
    close();
  };

  const groupOf = (sgbd) => {
    const row = st.carRows.find((r) => r.sgbd === sgbd);
    return row ? row.group : null;
  };
  const setBusy = (b) => {
    st.busy = b;
    goBtn.disabled = b || !st.pick || !!(st.pick && st.pick.locked);
    sgbdIn.disabled = b;
    carSel.disabled = b;
  };
  const carLabel = () =>
    st.car
      ? `This car (${typeof dispChassis === 'function' ? dispChassis(st.car) : st.car})`
      : '';

  // -- the car ---------------------------------------------------------------
  // The chassis config lists the modules this car carries, with their labels
  // and diagnostic groups; those go first in the picker, and the group is
  // what lets a module be identified before it is read.
  async function setCar(id) {
    st.car = String(id || '').toUpperCase();
    st.carRows = [];
    st.other = sgbds.slice();
    if (st.car) {
      const cfg = await TM.chassisConfig(st.car);
      const ranked = TM.rankModules(sgbds, cfg);
      st.carRows = ranked.car;
      st.other = ranked.other;
    }
  }
  (async () => {
    const ids = await TM.chassisList();
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = typeof dispChassis === 'function' ? dispChassis(id) : id;
      carSel.appendChild(o);
    }
    const def = await TM.defaultChassis();
    if (def && ids.includes(def)) carSel.value = def;
    await setCar(carSel.value);
  })();
  carSel.onchange = async () => {
    TM.rememberChassis(carSel.value);
    await setCar(carSel.value);
    if (picker.isOpen()) picker.open(!sgbdIn.value.trim());
  };

  // -- identify --------------------------------------------------------------
  function paintIdent(sgbd, r) {
    if (!r) {
      identEl.hidden = true;
      identEl.innerHTML = '';
      return;
    }
    identEl.hidden = false;
    identEl.className =
      'tn-ecu-ident ' +
      (r.state === 'ok'
        ? 'ok'
        : r.state === 'pending' || r.state === 'no-cable'
          ? 'dim'
          : 'bad');
    if (r.state === 'pending') {
      identEl.textContent = `Identifying ${sgbd}…`;
      return;
    }
    identEl.textContent = TM.identText(sgbd, r);
    if (r.state === 'variant') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn tn-ecu-use';
      b.textContent = `Use ${r.variant}`;
      b.onclick = () => choose(r.variant);
      identEl.appendChild(b);
    }
  }

  // One probe per module per dialog. Runs when a module is picked and again
  // on Read only if the earlier attempt could not reach the car.
  async function identify(sgbd, force) {
    const had = st.ident.get(sgbd);
    if (
      had &&
      !force &&
      had.state !== 'pending' &&
      had.state !== 'no-cable' &&
      had.state !== 'error'
    ) {
      return had;
    }
    st.ident.set(sgbd, { state: 'pending' });
    if (st.sgbd === sgbd) paintIdent(sgbd, { state: 'pending' });
    let r;
    try {
      r = await TM.identify(sgbd, groupOf(sgbd));
    } catch (e) {
      r = { state: 'error', detail: String((e && e.message) || e) };
    }
    st.ident.set(sgbd, r);
    if (st.sgbd === sgbd) paintIdent(sgbd, r);
    return r;
  }

  // -- regions ---------------------------------------------------------------
  function paintRegions() {
    spanBox.hidden = true;
    if (!st.regions.length) {
      regionBox.innerHTML =
        `<div class="tn-ecu-hint">` +
        `This module declares no memory-read job (RAM/ROM/EEPROM/SPEICHER_LESEN).</div>`;
      goBtn.disabled = true;
      return;
    }
    regionBox.innerHTML = st.regions
      .map((r, i) => {
        const sel = r.types.length
          ? `<select class="tn-ecu-type" data-i="${i}">${r.types
              .map((t) => `<option>${esc(t)}</option>`)
              .join('')}</select>`
          : '';
        const title = r.source === 'profile' ? r.label : r.kind;
        return `<label class="tn-ecu-region${r.locked ? ' locked' : ''}">
          <input type="radio" name="tn-ecu-r" value="${i}"${r.locked ? ' disabled' : ''}>
          <span class="tn-ecu-kind">${esc(title)}</span>
          <span class="tn-ecu-job">${esc(r.job)}</span>
          <span class="tn-ecu-meta">${esc(tnRegionMeta(r))}</span>
          <span class="tn-ecu-comment">${esc(tnRegionNote(r))}</span>${sel}</label>`;
      })
      .join('');
    regionBox.querySelectorAll('input[name=tn-ecu-r]').forEach((el) => {
      el.onchange = () => {
        st.pick = st.regions[+el.value];
        paintSpan();
        goBtn.disabled = !!st.pick.locked;
      };
    });
    regionBox.querySelectorAll('.tn-ecu-type').forEach((sel) => {
      sel.onchange = () => {
        st.regions[+sel.dataset.i].selType = sel.value;
      };
    });
  }

  // The span to read, prefilled from what is known.
  function paintSpan() {
    const r = st.pick;
    if (!r) {
      spanBox.hidden = true;
      return;
    }
    spanBox.hidden = false;
    unitEl.textContent = r.unit === 'word' ? 'words' : 'bytes';
    startIn.value = tnFmtAddr(r.lo, r.addrDigits);
    chunkIn.value = String(r.max);
    const { len, note } = tnSpanDefaults(r);
    lenIn.value = String(len);
    spanNote.textContent = note;
  }

  // -- the module picker -----------------------------------------------------
  const picker = tnCreateModulePicker({
    input: sgbdIn,
    list: $('#tn-ecu-sug'),
    caret: $('#tn-ecu-caret'),
    rows: () => ({ car: st.carRows, other: st.other, carLabel: carLabel() }),
    onChoose: () => lookup(),
    onInput: () => {
      clearTimeout(sgbdIn._t);
      sgbdIn._t = setTimeout(lookup, TN_LOOKUP_DEBOUNCE_MS);
    },
  });
  function choose(name) {
    sgbdIn.value = name;
    picker.close();
    lookup();
  }

  let lookupSeq = 0;
  async function lookup() {
    const sgbd = sgbdIn.value.trim().toLowerCase();
    st.sgbd = sgbd;
    st.pick = null;
    goBtn.disabled = true;
    spanBox.hidden = true;
    prog.hidden = true;
    paintIdent(sgbd, st.ident.get(sgbd) || null);
    if (!sgbd) {
      regionBox.innerHTML =
        `<div class="tn-ecu-hint">` +
        `Pick a module to see what it can read.</div>`;
      return;
    }
    const seq = ++lookupSeq;
    regionBox.innerHTML = `<div class="tn-ecu-hint">Reading ${esc(sgbd)} job list…</div>`;
    let regions;
    try {
      regions = await TM.regionsFor(sgbd);
    } catch (e) {
      regions = [];
    }
    if (seq !== lookupSeq) return; // a newer lookup already won
    st.regions = regions;
    paintRegions();
    // Ask the car whether this module is there, as soon as it is named:
    // the answer is what the user actually needs before choosing a range.
    if (regions.length && sgbds.includes(sgbd)) identify(sgbd, false);
  }

  const showFail = (x) => {
    prog.hidden = false;
    prog.innerHTML =
      `<b>${esc(x.headline)}</b>` + (x.detail ? `<br>${esc(x.detail)}` : '');
  };

  // Name a failure in the SGBD's own words, and say whether the ECU
  // refused or the job never transmitted (an argument the job itself
  // rejects, e.g. a count above its "max.", sends nothing at all).
  async function showReadError(sgbd, e) {
    let info = {};
    if (e && e.jobStatus) {
      try {
        info = await TM.statusInfo(sgbd, e.jobStatus);
      } catch (e2) {
        info = {};
      }
    }
    showFail(
      TM.explainFailure({
        ...info,
        status: e && e.jobStatus,
        arg: e && e.arg,
        job: e && e.job,
        message: String((e && e.message) || e),
        sgbd,
      })
    );
  }

  goBtn.onclick = async () => {
    if (!st.pick || st.busy) return;
    const plan = tnReadPlan(st.pick, startIn.value, lenIn.value, chunkIn.value);
    if (typeof plan === 'string') {
      showFail({ headline: plan, detail: '' });
      return;
    }
    st.cancel = false;
    setBusy(true);
    prog.hidden = false;
    const r = st.pick;
    const sgbd = st.sgbd;
    try {
      // 1. Is the module there? A probe that could not reach the car
      //    earlier (no cable then) is retried now.
      prog.textContent = `Identifying ${sgbd}…`;
      const idr = await identify(sgbd, true);
      if (TN_IDENT_BLOCKS.has(idr.state)) {
        showFail({
          headline: TM.identText(sgbd, idr),
          detail:
            idr.state === 'variant'
              ? 'Switch to that module to read it.'
              : idr.state === 'silent'
                ? 'Nothing was read. Check the module is fitted and the ignition is on.'
                : '',
        });
        setBusy(false);
        return;
      }
      // 2. Read.
      prog.textContent = 'Reading…';
      const { bytes, firstArg } = await TM.readRange(
        sgbd,
        r,
        plan.start,
        plan.end,
        (done, total, arg) => {
          if (st.cancel) return false;
          const pct = Math.min(100, Math.round((done / total) * 100));
          prog.textContent = `${pct}%  ·  ${arg}`;
          return true;
        },
        { chunk: plan.chunk }
      );
      if (!bytes.length) {
        showFail({
          headline: `${sgbd} returned no data for ${firstArg}.`,
          detail:
            'The module answered, but with an empty block at this address.',
        });
        setBusy(false);
        return;
      }
      // Hand it to the editor as a loaded image. tuningState.orig is the
      // same bytes so the dirty count starts at zero and any later edit is
      // measured against what the car actually holds.
      tnAdoptImage(
        bytes,
        `${sgbd}-${r.job}-${tnFmtAddr(plan.start, r.addrDigits)}.bin`
      );
      // Reading is not editing: the image came off a car, and there is no
      // write path back. Save is still offered because saving it to disk is
      // exactly how you keep a backup before touching anything.
      tnShowLoadedImage(ed);
      els.clear.disabled = false;
      tnBuildCoverage();
      tnSaveSoon();
      ed.hex.refresh();
      if (tuningState.def) tnRenderDefs(ed);
      tnUpdateStatus(ed);
      els.status.textContent = `read ${bytes.length} B from ${sgbd} · ${firstArg}`;
      close();
    } catch (e) {
      await showReadError(sgbd, e);
      setBusy(false);
    }
  };

  setTimeout(() => sgbdIn.focus(), 0);
}
