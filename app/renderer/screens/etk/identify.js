/**
 * @file The Vehicle Identification page: enter a VIN (or its last 7) and it
 * resolves to the exact vehicle, or identify the vehicle by series, body and
 * model the way ETK's dealer terminal does. Either path opens the parts
 * catalogue pre-filtered to that vehicle.
 *
 * `opts` retargets the SAME screen for other sections (the wiring picker
 * reuses it 1:1 so the two never drift). Defaults to Parts. The
 * identify-by-attributes group box itself lives in attributes.js.
 */

/* exported showVinDecoder, openDecoded */

/**
 * How a section retargets the identification page.
 * @typedef {object} EtkIdentifyOpts
 * @property {string} [eyebrow] - small caption over the title (default "ETK")
 * @property {string} [title] - page title
 * @property {string} [subtitle] - page subtitle
 * @property {{ label: string, fn?: () => void }[]} [crumbs] - breadcrumb trail
 * @property {() => void} [back] - where Esc / Back goes
 * @property {string} [savedKey] - Settings key of this section's saved-vehicles list
 * @property {(hit: EtkVinHit) => void} [onResolve] - what go / open does with the vehicle
 * @property {(chassis: string) => boolean|Promise<boolean>} [resolvable] - gate: can the section open this chassis?
 * @property {(disp: string) => string} [openLabel] - caption of the open button
 * @property {(disp: string) => string} [unavailable] - message when the gate says no
 */

/**
 * A saved vehicle row, as persisted in Settings: the resolved vehicle plus
 * the captions shown for it.
 * @typedef {EtkVinHit & { disp?: string, bits?: string, date?: string }} EtkSavedVehicle
 */

/**
 * The saved-vehicles panel's surface.
 * @typedef {object} EtkSavedPanel
 * @property {HTMLDivElement} el - the panel element
 * @property {(entry: EtkSavedVehicle) => void} add - remember a vehicle (newest first, de-duplicated by VIN)
 */

/** Settings key for the parts catalogue's saved vehicles (other sections keep their own). */
const ETK_SAVED_KEY = 'savedVins';

/** How many saved vehicles a section keeps. */
const ETK_SAVED_MAX = 12;

/** Shortest date string that still carries a year and a month. */
const ETK_DATE_MIN_LEN = 6;

/**
 * The captions shown for a resolved vehicle: chassis display name, the
 * attribute bits line and the production year-month.
 * @param {EtkVinHit} hit - the resolved vehicle
 * @returns {{ disp: string, bits: string, date: string }}
 */
function etkVinSummary(hit) {
  const bits = [
    hit.model,
    bodyLabel(hit.body),
    hit.motor,
    etkSteerAbbrev(hit.steer),
  ]
    .filter(Boolean)
    .join(' · ');
  const date =
    hit.prod && String(hit.prod).length >= ETK_DATE_MIN_LEN
      ? etkYearMonth(String(hit.prod))
      : '';
  return { disp: dispChassis(hit.chassis), bits, date };
}

/**
 * Show the identification page.
 * @param {EtkIdentifyOpts} [opts] - section overrides; omitted = the parts catalogue
 * @returns {void}
 */
function showVinDecoder(opts) {
  opts = opts || {};
  const onResolve = opts.onResolve || openDecoded; // default: open the parts catalogue
  const backFn = opts.back || showEtk;
  lastScreen = () => showVinDecoder(opts);
  setCrumbs(
    opts.crumbs || [
      { label: 'Vehicles', fn: showChassis },
      { label: 'Apps', fn: showApps },
      { label: 'Parts', fn: showEtk },
      { label: 'VIN Decoder' },
    ]
  );
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'vin decoder';
  view.innerHTML = head(
    opts.eyebrow || 'ETK',
    opts.title || 'Vehicle Identification',
    opts.subtitle ||
      'Enter your VIN, or identify your vehicle by series, body and model.'
  );
  setActions([etkBackAction(backFn)]);

  // Two columns: the VIN box + attributes selector on the left, a full-height
  // saved-vehicles panel down the right.
  const layout = document.createElement('div');
  layout.className = 'etk-vin-layout';
  const leftCol = document.createElement('div');
  leftCol.className = 'etk-vin-left';
  layout.appendChild(leftCol);

  // Saved vehicles panel: a full-height column down the right, alongside both
  // the VIN box and the attributes selector. Persisted in Settings under
  // opts.savedKey (sections keep their own list).
  const saved = etkSavedVehiclesPanel(
    opts.savedKey || ETK_SAVED_KEY,
    onResolve
  );
  layout.appendChild(saved.el);
  view.appendChild(layout);

  const vinBox = etkVinBox(opts, onResolve, saved.add);
  leftCol.appendChild(vinBox.el);
  vinBox.input.focus();

  leftCol.appendChild(etkAttributeSelector(opts, onResolve));
}

/**
 * The saved-vehicles panel. Each entry shows the car above its VIN and opens
 * that vehicle in this section.
 * @param {string} savedKey - Settings key the list lives under
 * @param {(hit: EtkVinHit) => void} onResolve - opens a saved vehicle
 * @returns {EtkSavedPanel}
 */
function etkSavedVehiclesPanel(savedKey, onResolve) {
  const el = document.createElement('div');
  el.className = 'etk-saved-panel';

  /** @returns {EtkSavedVehicle[]} */
  const read = () => {
    if (typeof Settings !== 'object' || !Settings.get) return [];
    const v = Settings.get(savedKey, []);
    return Array.isArray(v) ? v : [];
  };
  /** @param {EtkSavedVehicle[]} list */
  const write = (list) => {
    if (typeof Settings === 'object' && Settings.set)
      Settings.set(savedKey, list.slice(0, ETK_SAVED_MAX));
  };
  /** @param {EtkSavedVehicle} entry */
  const add = (entry) => {
    const vin = String(entry.vin || '').toUpperCase();
    if (!vin) return;
    const rest = read().filter((e) => String(e.vin).toUpperCase() !== vin);
    write([{ ...entry, vin }, ...rest]);
    render();
  };
  /** @param {string} vin */
  const del = (vin) => {
    const V = String(vin).toUpperCase();
    write(read().filter((e) => String(e.vin).toUpperCase() !== V));
    render();
  };
  /** Redraw the list from Settings. */
  function render() {
    const list = read();
    el.innerHTML = '';
    const heading = document.createElement('div');
    heading.className = 'etk-saved-head';
    heading.textContent = 'Saved vehicles';
    el.appendChild(heading);
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'etk-saved-empty';
      e.textContent = 'Decode a VIN and press Save to keep it here.';
      el.appendChild(e);
      return;
    }
    list.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'etk-saved-row';
      const disp = it.disp || dispChassis(it.chassis);
      const meta = [disp, it.bits, it.date].filter(Boolean).join(' · ');
      row.innerHTML = `
        <button type="button" class="etk-saved-open" title="Open ${esc(disp)}">
          <span class="etk-saved-veh">${esc(meta)}</span>
          <span class="etk-saved-vin">${esc(it.vin)}</span>
        </button>
        <button type="button" class="etk-saved-del" title="Remove" aria-label="Remove">✕</button>`;
      row.querySelector('.etk-saved-open').onclick = () =>
        onResolve({
          chassis: it.chassis,
          model: it.model,
          body: it.body,
          motor: it.motor,
          steer: it.steer,
          prod: it.prod,
          vin: it.vin,
        });
      row.querySelector('.etk-saved-del').onclick = () => del(it.vin);
      el.appendChild(row);
    });
  }
  render();
  return { el, add };
}

/**
 * ETK's top group box: "Identification by VIN number" -- a labelled input
 * with the go-arrow and a Save button at the right, inside an etched fieldset.
 * @param {EtkIdentifyOpts} opts - section overrides
 * @param {(hit: EtkVinHit) => void} onResolve - opens the decoded vehicle
 * @param {(entry: EtkSavedVehicle) => void} addSaved - remembers it when Save was pressed
 * @returns {{ el: HTMLFieldSetElement, input: HTMLInputElement }}
 */
function etkVinBox(opts, onResolve, addSaved) {
  const card = document.createElement('fieldset');
  card.className = 'etk-fs etk-fs-vin';
  card.innerHTML = `
    <legend>Identification by VIN number</legend>
    <div class="etk-vin-row">
      <span class="etk-vin-label">VIN number:</span>
      <input class="etk-vin-input" type="text" maxlength="17" spellcheck="false"
             autocapitalize="characters" placeholder="WBA… or last 7 chars">
      <button class="etk-vin-go" type="button" aria-label="Decode VIN">→</button>
      <button class="etk-vin-save" type="button"
              title="Decode and save this VIN">Save</button>
    </div>
    <div class="etk-vin-hint">A BMW VIN's last 7 characters are the production
      number. Paste the full VIN or just those 7.</div>
    <div class="etk-vin-result" hidden></div>`;

  const input = card.querySelector('.etk-vin-input');
  const go = card.querySelector('.etk-vin-go');
  const saveBtn = card.querySelector('.etk-vin-save');
  const result = card.querySelector('.etk-vin-result');

  /**
   * Decode what's in the box and show the vehicle (or why not).
   * @param {boolean} alsoSave - Save was pressed: remember the vehicle too
   */
  async function decode(alsoSave) {
    const vin = input.value.trim();
    if (vin.length < VIN_PROD_LEN) {
      result.hidden = false;
      result.className = 'etk-vin-result etk-vin-err';
      result.textContent =
        'Enter at least the 7-character production number (or a full VIN).';
      return;
    }
    result.hidden = false;
    result.className = 'etk-vin-result';
    result.innerHTML = `<span class="wiring-spinner"></span> Looking up ${esc(vin.toUpperCase())}…`;
    go.disabled = true;
    try {
      const idx = await loadVinIndex((loaded, total) => {
        if (total > 0) {
          const pct = Math.round((loaded / total) * 100);
          result.innerHTML = `<span class="wiring-spinner"></span> Loading VIN data… ${pct}%`;
        }
      });
      const hit = decodeVin(idx, vin);
      go.disabled = false;
      if (!hit) {
        result.className = 'etk-vin-result etk-vin-err';
        result.textContent = `No vehicle found for “${vin.toUpperCase()}”. Check the VIN, or pick a chassis on the previous screen.`;
        return;
      }
      hit.vin = vin.toUpperCase();
      const { disp, bits, date } = etkVinSummary(hit);
      const dateStr = date ? ` · ${date}` : '';
      // Save was pressed: remember this vehicle (car above the VIN in the panel)
      if (alsoSave) {
        addSaved({
          vin: hit.vin,
          chassis: hit.chassis,
          disp,
          bits,
          date,
          model: hit.model,
          body: hit.body,
          motor: hit.motor,
          steer: hit.steer,
          prod: hit.prod,
        });
      }
      // the section may not be able to open every decoded chassis (wiring ships
      // fewer than the VIN index covers): gate, and say what it found either way
      const canOpen = opts.resolvable
        ? await opts.resolvable(hit.chassis)
        : true;
      result.className = 'etk-vin-result etk-vin-ok';
      if (canOpen) {
        result.innerHTML = `
          <div class="etk-vin-veh"><b>${esc(disp)}</b> ${esc(bits)}${esc(dateStr)}</div>
          <button class="etk-vin-open" type="button">${esc(opts.openLabel ? opts.openLabel(disp) : `Open ${disp} parts →`)}</button>`;
        result.querySelector('.etk-vin-open').onclick = () => onResolve(hit);
      } else {
        result.innerHTML = `
          <div class="etk-vin-veh"><b>${esc(disp)}</b> ${esc(bits)}${esc(dateStr)}</div>
          <div class="etk-vin-note">${esc(opts.unavailable ? opts.unavailable(disp) : `Not available for ${disp}.`)}</div>`;
      }
    } catch (e) {
      go.disabled = false;
      result.className = 'etk-vin-result etk-vin-err';
      result.textContent = String(e.message || e);
    }
  }

  go.onclick = () => decode(false);
  saveBtn.onclick = () => decode(true); // decode + remember
  input.onkeydown = (e) => {
    if (e.key === 'Enter') decode(false);
  };
  return { el: card, input };
}

/**
 * The index of the catalogue variant that best matches a resolved vehicle.
 * The VIN hit and the drill-down pick share model/body/steer; motor is present
 * only on the VIN path, so match progressively from most to least specific.
 * @param {EtkVariant[]} variants - the chassis's variants
 * @param {EtkVinHit} hit - the resolved vehicle
 * @returns {number} the variant index, or -1 when nothing matches even by model
 */
function etkMatchVariant(variants, hit) {
  const eq = (a, b) => (a || '') === (b || '');
  let match = -1;
  if (hit.motor) {
    // VIN path: model+body+motor+steer
    match = variants.findIndex(
      (v) =>
        eq(v.model, hit.model) &&
        eq(v.body, hit.body) &&
        eq(v.motor, hit.motor) &&
        eq(v.steer, hit.steer)
    );
  }
  if (match < 0)
    match = variants.findIndex(
      (v) =>
        eq(v.model, hit.model) && eq(v.body, hit.body) && eq(v.steer, hit.steer)
    );
  if (match < 0) match = variants.findIndex((v) => eq(v.model, hit.model));
  return match;
}

/**
 * After a VIN resolves, open its chassis and pre-select the matching variant.
 * @param {EtkVinHit} hit - the resolved vehicle
 * @returns {Promise<void>}
 */
async function openDecoded(hit) {
  await showEtkChassis(hit.chassis);
  try {
    const data = await loadEtk(hit.chassis);
    const vs = data.tree.variants || [];
    const match = etkMatchVariant(vs, hit);
    if (match >= 0) {
      ETK_STATE.variant = match;
      const cur = document.querySelector('.etk-vdd-cur');
      if (cur) {
        cur.textContent = etkVariantLabel(vs[match]);
        cur.classList.add('etk-vdd-filtered');
      }
    }
  } catch (e) {
    /* the chassis still opened; just unfiltered */
  }
}
