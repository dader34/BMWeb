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
 * @property {string} [savedKey] - unused since the panel lists the Garage; accepted so older callers keep working
 * @property {(hit: EtkVinHit) => void} [onResolve] - what go / open does with the vehicle
 * @property {(chassis: string) => boolean|Promise<boolean>} [resolvable] - gate: can the section open this chassis?
 * @property {(disp: string) => string} [openLabel] - caption of the open button
 * @property {(disp: string) => string} [unavailable] - message when the gate says no
 */

/**
 * The vehicles panel's surface.
 * @typedef {object} EtkSavedPanel
 * @property {HTMLDivElement} el - the panel element
 */

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

  // The Garage's cars: a full-height column down the right, alongside both
  // the VIN box and the attributes selector.
  const saved = etkSavedVehiclesPanel(onResolve);
  layout.appendChild(saved.el);
  view.appendChild(layout);

  const vinBox = etkVinBox(opts, onResolve);
  leftCol.appendChild(vinBox.el);
  vinBox.input.focus();

  leftCol.appendChild(etkAttributeSelector(opts, onResolve));
}

/**
 * The vehicles panel down the right: the cars kept in the Garage. Each entry
 * shows the car above its VIN and opens that vehicle in this section, with
 * the variant its VIN decoded to when the Garage knows it.
 * @param {(hit: EtkVinHit) => void} onResolve - opens a saved vehicle
 * @returns {EtkSavedPanel}
 */
function etkSavedVehiclesPanel(onResolve) {
  const el = document.createElement('div');
  el.className = 'etk-saved-panel';

  /** @returns {GarageCar[]} */
  const read = () => (typeof garageCars === 'function' ? garageCars() : []);

  /** Redraw the list from the Garage. */
  function render() {
    const list = read();
    el.innerHTML = '';
    const heading = document.createElement('div');
    heading.className = 'etk-saved-head';
    heading.textContent = 'Garage';
    el.appendChild(heading);
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'etk-saved-empty';
      e.textContent =
        typeof showGarage === 'function'
          ? 'Cars saved to the Garage appear here.'
          : 'No saved vehicles in this build.';
      el.appendChild(e);
      if (typeof showGarage === 'function') {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'btn etk-saved-go';
        go.textContent = 'Open Garage';
        go.onclick = () => showGarage();
        el.appendChild(go);
      }
      return;
    }
    list.forEach((car) => {
      const row = document.createElement('div');
      row.className = 'etk-saved-row';
      const name =
        typeof garageCarLabel === 'function'
          ? garageCarLabel(car)
          : car.label || dispChassis(car.chassis);
      const bits = [car.body, car.motor].filter(Boolean).join(' · ');
      row.innerHTML = `
        <button type="button" class="etk-saved-open" title="Open ${esc(name)}">
          <span class="etk-saved-veh">${esc(bits ? `${name} · ${bits}` : name)}</span>
          <span class="etk-saved-vin">${esc(car.vin || dispChassis(car.chassis))}</span>
        </button>`;
      row.querySelector('.etk-saved-open').onclick = () =>
        onResolve({
          chassis: car.chassis,
          model: car.model,
          body: car.body,
          motor: car.motor,
          prod: car.prod,
          vin: car.vin,
        });
      el.appendChild(row);
    });
  }
  render();
  return { el };
}

/**
 * ETK's top group box: "Identification by VIN number" -- a labelled input
 * with the go-arrow at the right, inside an etched fieldset.
 * @param {EtkIdentifyOpts} opts - section overrides
 * @param {(hit: EtkVinHit) => void} onResolve - opens the decoded vehicle
 * @returns {{ el: HTMLFieldSetElement, input: HTMLInputElement }}
 */
function etkVinBox(opts, onResolve) {
  const card = document.createElement('fieldset');
  card.className = 'etk-fs etk-fs-vin';
  card.innerHTML = `
    <legend>Identification by VIN number</legend>
    <div class="etk-vin-row">
      <span class="etk-vin-label">VIN number:</span>
      <input class="etk-vin-input" type="text" maxlength="17" spellcheck="false"
             autocapitalize="characters" placeholder="WBA… or last 7 chars">
      <button class="etk-vin-go" type="button" aria-label="Decode VIN">→</button>
    </div>
    <div class="etk-vin-hint">A BMW VIN's last 7 characters are the production
      number. Paste the full VIN or just those 7.</div>
    <div class="etk-vin-result" hidden></div>`;

  const input = card.querySelector('.etk-vin-input');
  const go = card.querySelector('.etk-vin-go');
  const result = card.querySelector('.etk-vin-result');

  /**
   * Decode what's in the box and show the vehicle (or why not).
   */
  async function decode() {
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

  go.onclick = () => decode();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') decode();
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
  // steer is known on the VIN path only; a Garage car saved without it must
  // not be refused a match on that account
  const steerOk = (v) => !hit.steer || eq(v.steer, hit.steer);
  const tiers = [
    (v) =>
      !!hit.motor &&
      eq(v.model, hit.model) &&
      eq(v.body, hit.body) &&
      eq(v.motor, hit.motor) &&
      steerOk(v),
    (v) => eq(v.model, hit.model) && eq(v.body, hit.body) && steerOk(v),
    (v) => eq(v.model, hit.model),
  ];
  for (const ok of tiers) {
    const found = [];
    variants.forEach((v, i) => {
      if (ok(v)) found.push(i);
    });
    if (found.length) return etkNearestVariant(variants, found, hit.prod);
  }
  return -1;
}

/**
 * Of several variants that all fit the car, the one introduced last before
 * it was built: the catalogue splits a model by introduction date, and the
 * car belongs to the split it was built into. Without a build date (or when
 * every candidate came after it) the first candidate stands.
 * @param {EtkVariant[]} variants - the chassis's variants
 * @param {number[]} found - indexes of the candidates, in catalogue order
 * @param {string|number} [prod] - the car's build date, YYYYMM or YYYYMMDD
 * @returns {number} the chosen index
 */
function etkNearestVariant(variants, found, prod) {
  const p = String(prod || '').slice(0, 6);
  if (p.length < 6 || found.length < 2) return found[0];
  let best = -1;
  let bestDate = '';
  for (const i of found) {
    const d = String(variants[i].date || '').slice(0, 6);
    if (d.length === 6 && d <= p && d > bestDate) {
      best = i;
      bestDate = d;
    }
  }
  return best >= 0 ? best : found[0];
}

/**
 * After a VIN resolves, open its chassis and pre-select the matching variant.
 * @param {EtkVinHit} hit - the resolved vehicle
 * @returns {Promise<void>}
 */
async function openDecoded(hit) {
  // the variant is worked out first, so the chassis screen draws its picker
  // already set to it (the picker is built from ETK_STATE when the screen
  // renders; patching it afterwards was fragile)
  let pre = null;
  try {
    const data = await loadEtk(hit.chassis);
    const vs = data.tree.variants || [];
    const match = etkMatchVariant(vs, hit);
    if (match >= 0) pre = { variant: match, label: etkVariantLabel(vs[match]) };
  } catch (e) {
    /* the chassis still opens; just unfiltered */
  }
  await showEtkChassis(hit.chassis, pre);
}
