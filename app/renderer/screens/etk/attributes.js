/**
 * @file ETK's "Identification by attributes" group box, 1:1 with the dealer
 * terminal: a Brand / Prod. type / Catalogue filter row, then [Series* |
 * chassis] [Body* + car image] [Model* with Steering / Gearbox / Year / Month
 * in a 2x2 beneath it], go-arrow bottom right. Each pick fills the next pane
 * from vehicles.json; the pure steps (series filter, year expansion, newest
 * intro year) are separate so they can be checked without a DOM.
 */

/* exported etkAttributeSelector */

/**
 * The series filter result: one marketing series and the chassis under it.
 * @typedef {{ series: string, codes: string[] }} EtkSeriesEntry
 */

/**
 * The year digits of a YYYYMMDD date.
 * @param {string|number} d - the date
 * @returns {string}
 */
function etkYearOf(d) {
  return String(d).slice(0, 4);
}

/**
 * The month digits of a YYYYMMDD date.
 * @param {string|number} d - the date
 * @returns {string}
 */
function etkMonthOf(d) {
  return String(d).slice(4, 6);
}

/**
 * The value a cascade select currently holds, read back through its `_vals`
 * sidecar (the raw codes behind the displayed labels); null when nothing is
 * picked.
 * @param {EtkSelect} sel - a makeSelect() control with `_vals` set
 * @returns {string|null}
 */
function etkSelValue(sel) {
  return sel._vals && sel.value !== '' ? sel._vals[+sel.value] : null;
}

/**
 * A labelled column wrapper (a heading over a list box or dropdown).
 * @param {string} labelText - the heading
 * @param {HTMLElement} el - the control beneath it
 * @param {string} [cls] - extra class on the column
 * @returns {HTMLDivElement}
 */
function etkLabelledCol(labelText, el, cls) {
  const c = document.createElement('div');
  c.className = 'etk-idcol' + (cls ? ' ' + cls : '');
  const l = document.createElement('span');
  l.className = 'etk-idlabel';
  l.textContent = labelText;
  c.append(l, el);
  return c;
}

/**
 * The filter row over the attribute selector: Brand dropdown + Auto/Moto
 * radios + Main/Classic radios. These narrow which series show, same as the
 * terminal's selectors.
 * @returns {{
 *   el: HTMLDivElement,
 *   prodType: () => string,
 *   scope: () => string,
 *   brand: () => string,
 *   onChange: (fn: () => void) => void,
 * }}
 */
function etkAttrFilters() {
  const el = document.createElement('div');
  el.className = 'etk-idfilters';
  el.innerHTML = `
    <div class="etk-idfilter etk-idfilter-brand"><span class="etk-idflabel">Brand</span></div>
    <div class="etk-idfilter"><span class="etk-idflabel">Prod. type</span>
      <label class="etk-idradio"><input type="radio" name="etk-ptype" value="auto" checked> Auto</label>
      <label class="etk-idradio"><input type="radio" name="etk-ptype" value="moto"> Moto</label>
    </div>
    <div class="etk-idfilter"><span class="etk-idflabel">Catalogue</span>
      <label class="etk-idradio"><input type="radio" name="etk-scope" value="main" checked> Main catalogue</label>
      <label class="etk-idradio"><input type="radio" name="etk-scope" value="classic"> BMW Classic</label>
    </div>
    <span class="etk-idreq">* required attributes</span>`;
  const selBrand = makeSelect('BMW');
  selBrand.setOptions(['BMW', 'MINI'], 'BMW');
  selBrand.selectedIndex = 1; // BMW preselected
  el.querySelector('.etk-idfilter-brand').appendChild(selBrand);
  return {
    el,
    prodType: () => el.querySelector('input[name="etk-ptype"]:checked').value,
    scope: () => el.querySelector('input[name="etk-scope"]:checked').value,
    brand: () => (selBrand.value === '1' ? 'MINI' : 'BMW'),
    onChange: (fn) => {
      el.querySelectorAll('input[type="radio"]').forEach((r) => {
        r.onchange = fn;
      });
      selBrand.onchange = fn;
    },
  };
}

// A code is "classic" when it isn't a modern car chassis code (E/F/G/I/U +
// digits): the raw numeric and letter codes (114, 700, NK, V8...) are the
// old-timers BMW Classic covers, plus the hard-bucketed Classic group.
/**
 * Does BMW Classic (rather than the main catalogue) cover this chassis?
 * @param {string} code - chassis code
 * @param {string} series - its marketing series
 * @returns {boolean}
 */
function etkIsClassicCode(code, series) {
  // Z covers the literal Z1/Z3 chassis codes
  return (
    series === 'Classic' || series === 'Other' || !/^[EFGIUZ]\d/.test(code)
  );
}

/**
 * The series (and the chassis under each) the Brand / Prod. type / Catalogue
 * filters leave visible.
 * @param {EtkSeriesGroups} grouped - every series
 * @param {string} type - 'auto' | 'moto'
 * @param {string} brand - 'BMW' | 'MINI'
 * @param {string} scope - 'main' | 'classic'
 * @returns {EtkSeriesEntry[]}
 */
function etkVisibleSeries(grouped, type, brand, scope) {
  const out = [];
  for (const s of grouped.order) {
    let codes = grouped.groups[s];
    if (type === 'moto') {
      if (s !== 'Moto') continue;
    } else {
      if (s === 'Moto') continue;
      if (brand === 'MINI') {
        if (s !== 'MINI') continue;
      } else {
        if (s === 'MINI') continue;
        codes = codes.filter(
          (c) => etkIsClassicCode(c, s) === (scope === 'classic')
        );
      }
    }
    if (codes.length) out.push({ series: s, codes });
  }
  return out;
}

/**
 * Newest introduction year across every body / model of a chassis -- a
 * stand-in for end-of-build, so the Year list can run past the last per-model
 * introduction date.
 * @param {Record<string, Record<string, EtkVehicleRow[]>>} bodies - the chassis node of the vehicle tree
 * @returns {number} the year, or 0 when no row carries one
 */
function etkMaxIntroYear(bodies) {
  let max = 0;
  for (const mods of Object.values(bodies)) {
    for (const variants of Object.values(mods)) {
      for (const v of variants) {
        const y = +etkYearOf(v[2]);
        if (y && y > max) max = y;
      }
    }
  }
  return max;
}

// The dates in the data are each variant's INTRODUCTION date, not the model
// years it was sold. So a car whose build year sits between two intro dates
// (a 2005 E46 325i, say) had no exact row and its year went missing from the
// list. List every year from the first intro to the chassis's end of build,
// and map each to the variant "in force" then (newest intro <= that year).
/**
 * Expand introduction years into every sellable year, each mapped to the
 * introduction year of the variant in force then.
 * @param {string[]} introYears - distinct introduction years, sorted ascending
 * @param {number} maxYear - the chassis's end-of-build stand-in
 * @returns {{ years: string[], byYear: Record<string, string>|null }} byYear is null when there were no intro years
 */
function etkYearsInForce(introYears, maxYear) {
  if (!introYears.length) return { years: introYears, byYear: null };
  const lo = +introYears[0];
  const hi = Math.max(+introYears[introYears.length - 1], maxYear || 0);
  const years = [];
  const byYear = {};
  for (let y = lo; y <= hi; y++) {
    const ys = String(y);
    // the newest intro-year at or before y -- the variant valid that year
    const inForce = introYears.filter((iy) => +iy <= y).pop();
    if (inForce) {
      years.push(ys);
      byYear[ys] = inForce;
    }
  }
  return { years, byYear };
}

/**
 * ETK's lower group box, "Identification by attributes", 1:1 with the
 * terminal: a Brand / Prod. type / Catalogue filter row, then [Series* |
 * chassis] [Body* + car image] [Model* with Steering / Gearbox / Year / Month
 * in a 2x2 beneath it], go-arrow bottom right. Each pick fills the next pane.
 * @param {EtkIdentifyOpts} opts - section overrides (the gate and its message)
 * @param {(hit: EtkVinHit) => void} onResolve - opens the picked vehicle
 * @returns {HTMLFieldSetElement}
 */
function etkAttributeSelector(opts, onResolve) {
  const idCard = document.createElement('fieldset');
  idCard.className = 'etk-fs etk-fs-attr';
  const idLegend = document.createElement('legend');
  idLegend.textContent = 'Identification by attributes';
  idCard.appendChild(idLegend);

  const filters = etkAttrFilters();
  idCard.appendChild(filters.el);

  // the ETK cascade's list boxes use the shared control (ui/listbox.js),
  // focusable for keyboard navigation
  const listBox = () => makeListBox({ focusable: true });
  const lbSeries = listBox();
  const lbChassis = listBox();
  const lbBody = listBox();
  const lbModel = listBox();
  const selSteer = makeSelect('All values');
  const selGear = makeSelect('All values');
  const selYear = makeSelect('All values');
  const selMonth = makeSelect('All values');
  [selSteer, selGear, selYear, selMonth].forEach((s) => {
    s.disabled = true;
  });

  // ETK's positioning: [Series | Chassis] paired on the left, then Body (with a
  // vehicle thumbnail beneath it), then Model on the right with the Steering /
  // Transmission / Year dropdowns tucked underneath the Model column.
  const lists = document.createElement('div');
  lists.className = 'etk-idlists';

  // left block: Series + chassis sitting flush together (ETK labels only the
  // Series pane; the chassis pane is its unlabelled expansion)
  const leftBlock = document.createElement('div');
  leftBlock.className = 'etk-idpair';
  leftBlock.append(
    etkLabelledCol('Series*', lbSeries, 'etk-idcol-series'),
    etkLabelledCol(' ', lbChassis, 'etk-idcol-chassis')
  );

  // middle block: Body, with the car image beneath it
  const midBlock = document.createElement('div');
  midBlock.className = 'etk-idmid';
  const thumb = document.createElement('div');
  thumb.className = 'etk-idthumb';
  thumb.hidden = true;
  midBlock.append(etkLabelledCol('Body*', lbBody), thumb);

  // right block: Model on top, the 2x2 dropdowns beneath it (ETK's Steering |
  // Gearbox on the first row, Year | Month on the second)
  const rightBlock = document.createElement('div');
  rightBlock.className = 'etk-idright';
  const drops = document.createElement('div');
  drops.className = 'etk-iddrops';
  drops.append(
    etkLabelledCol('Steering', selSteer),
    etkLabelledCol('Gearbox', selGear),
    etkLabelledCol('Year', selYear),
    etkLabelledCol('Month', selMonth)
  );
  rightBlock.append(etkLabelledCol('Model*', lbModel), drops);

  lists.append(leftBlock, midBlock, rightBlock);

  const foot = document.createElement('div');
  foot.className = 'etk-idfoot';
  const idHint = document.createElement('span');
  idHint.className = 'etk-idhint';
  idHint.textContent = 'Loading vehicles…';
  const idOpen = document.createElement('button');
  idOpen.type = 'button';
  idOpen.className = 'etk-vin-go etk-idgo';
  idOpen.hidden = true;
  idOpen.setAttribute('aria-label', 'Open parts catalogue');
  idOpen.textContent = '→';
  foot.append(idHint, idOpen);

  idCard.append(lists, foot);

  /** @type {EtkVehicleTree|null} the loaded vehicles.json */
  let veh = null;
  /** @type {EtkSeriesGroups|null} */
  let grouped = null;
  /** @type {EtkVinHit|null} the vehicle the current picks resolve to */
  let picked = null;
  let chassisMaxYear = 0; // newest intro-year anywhere in the chassis
  const state = {
    series: null,
    chassis: null,
    body: null,
    model: null,
    /** @type {Record<string, string[]>} series -> chassis codes after the filters */
    codesBySeries: {},
    /** @type {EtkVehicleRow[]} the picked model's rows */
    variants: [],
  };

  /** Clear the four dropdowns and hide the go arrow. */
  function resetDrops() {
    picked = null;
    idOpen.hidden = true;
    [selSteer, selGear, selYear, selMonth].forEach((s) => {
      s.setDisabledEmpty();
      s.disabled = true;
    });
  }

  // ---- the Brand / Prod. type / Catalogue filters narrow the Series pane ----
  /** Refill the Series pane from the filters and clear everything after it. */
  function refreshSeries() {
    if (!grouped) return;
    const out = etkVisibleSeries(
      grouped,
      filters.prodType(),
      filters.brand(),
      filters.scope()
    );
    state.series = state.chassis = state.body = state.model = null;
    state.codesBySeries = Object.fromEntries(
      out.map((o) => [o.series, o.codes])
    );
    lbChassis.clear();
    lbBody.clear();
    lbModel.clear();
    resetDrops();
    thumb.hidden = true;
    lbSeries.setItems(out.map((o) => ({ key: o.series, label: o.series })));
    idHint.textContent = 'Pick a series to begin.';
  }
  filters.onChange(refreshSeries);

  // Series picked -> fill Chassis
  lbSeries.onpick = (series) => {
    state.series = series;
    state.chassis = state.body = state.model = null;
    lbBody.clear();
    lbModel.clear();
    resetDrops();
    thumb.hidden = true;
    lbChassis.setItems(
      state.codesBySeries[series].map((c) => ({
        key: c,
        label: dispChassis(c),
      }))
    );
    idHint.textContent = 'Pick a chassis.';
  };

  // swap the placeholder silhouette for the real ETK car photo when we have
  // one for this chassis+body (thumbs.json indexes what shipped)
  /**
   * @param {string|null} ch - chassis code
   * @param {string|null} body - body code
   */
  function setThumb(ch, body) {
    const url = etkThumbUrl(ch, body);
    if (url) {
      thumb.style.background = `var(--bg) url("${url}") center/contain no-repeat`;
      thumb.classList.add('etk-idthumb-photo');
    } else {
      thumb.style.background = '';
      thumb.classList.remove('etk-idthumb-photo');
    }
  }

  // Chassis picked -> fill Body
  lbChassis.onpick = (ch) => {
    state.chassis = ch;
    state.body = state.model = null;
    lbModel.clear();
    resetDrops();
    thumb.hidden = false;
    setThumb(null, null);
    // the upper bound for the (expanded) Year dropdown, since no explicit end
    // date exists
    chassisMaxYear = etkMaxIntroYear(veh[ch]);
    const bodies = Object.keys(veh[ch]);
    lbBody.setItems(bodies.map((b) => ({ key: b, label: bodyLabel(b) })));
    idHint.textContent = 'Pick a body style.';
  };
  // Body picked -> fill Model (and show that body's car photo)
  lbBody.onpick = (body) => {
    state.body = body;
    state.model = null;
    resetDrops();
    setThumb(state.chassis, body);
    const models = Object.keys(veh[state.chassis][body]);
    lbModel.setItems(models.map((m) => ({ key: m, label: m })));
    idHint.textContent = 'Pick a model.';
  };
  // Model picked -> fill the Steering / Gearbox / Year / Month dropdowns
  lbModel.onpick = (model) => {
    state.model = model;
    resetDrops();
    const variants = veh[state.chassis][state.body][model]; // [[steer,gear,date,mospid]]
    state.variants = variants;
    const steers = [...new Set(variants.map((v) => v[0]))].filter(Boolean);
    selSteer.setOptions(
      steers.map(etkSteerLabel),
      steers.length > 1 ? 'All values' : ''
    );
    selSteer._vals = steers;
    selSteer.disabled = false;
    if (steers.length === 1) {
      selSteer.selectedIndex = 1;
    }
    selSteer.onchange();
  };

  selSteer.onchange = () => {
    [selGear, selYear, selMonth].forEach((s) => {
      s.setDisabledEmpty();
      s.disabled = true;
    });
    const steer = etkSelValue(selSteer);
    const vs = state.variants.filter((v) => !steer || v[0] === steer);
    const gears = [...new Set(vs.map((v) => v[1]))].filter(Boolean);
    selGear.setOptions(
      gears.map(etkGearLabel),
      gears.length > 1 ? 'All values' : ''
    );
    selGear._vs = vs;
    selGear._vals = gears;
    selGear.disabled = false;
    if (gears.length === 1) {
      selGear.selectedIndex = 1;
    }
    selGear.onchange();
  };
  selGear.onchange = () => {
    [selYear, selMonth].forEach((s) => {
      s.setDisabledEmpty();
      s.disabled = true;
    });
    const gear = etkSelValue(selGear);
    const vs = selGear._vs.filter((v) => !gear || v[1] === gear);
    const introYears = [...new Set(vs.map((v) => etkYearOf(v[2])))]
      .filter(Boolean)
      .sort();
    const { years, byYear } = etkYearsInForce(introYears, chassisMaxYear);
    selYear.setOptions(years, years.length > 1 ? 'All values' : '');
    selYear._vs = vs;
    selYear._vals = years;
    selYear._byYear = byYear;
    selYear.disabled = false;
    if (years.length === 1) {
      selYear.selectedIndex = 1;
    }
    selYear.onchange();
  };
  selYear.onchange = () => {
    selMonth.setDisabledEmpty();
    selMonth.disabled = true;
    const yearPick = etkSelValue(selYear);
    // resolve the displayed year to the intro-year of the variant in force
    const introYear =
      yearPick && selYear._byYear ? selYear._byYear[yearPick] : yearPick;
    const vs = selYear._vs.filter(
      (v) => !introYear || etkYearOf(v[2]) === introYear
    );
    const months = [...new Set(vs.map((v) => etkMonthOf(v[2])))]
      .filter(Boolean)
      .sort();
    selMonth.setOptions(months, months.length > 1 ? 'All values' : '');
    selMonth._vs = vs;
    selMonth._vals = months;
    selMonth.disabled = false;
    if (months.length === 1) {
      selMonth.selectedIndex = 1;
    }
    recompute();
  };
  selMonth.onchange = recompute;

  // pick the most specific variant the current filters allow; show the go
  // arrow once a vehicle resolves (with "All values" left alone it takes the
  // first match, same as the terminal's behaviour).
  /** Resolve the current picks to a vehicle and show / hide the go arrow. */
  function recompute() {
    let vs = state.variants || [];
    const steer = etkSelValue(selSteer);
    if (steer) vs = vs.filter((v) => v[0] === steer);
    const gear = etkSelValue(selGear);
    if (gear) vs = vs.filter((v) => v[1] === gear);
    const yearSel = etkSelValue(selYear);
    // displayed year -> the intro-year of the variant in force (see selGear.onchange)
    const year =
      yearSel && selYear._byYear ? selYear._byYear[yearSel] : yearSel;
    if (year) vs = vs.filter((v) => etkYearOf(v[2]) === year);
    const month = etkSelValue(selMonth);
    if (month) vs = vs.filter((v) => etkMonthOf(v[2]) === month);
    const v = vs[0];
    if (!v || !state.model) {
      picked = null;
      idOpen.hidden = true;
      return;
    }
    picked = {
      chassis: state.chassis,
      mospid: v[3],
      model: state.model,
      body: state.body,
      steer: v[0],
      gear: v[1],
      prod: v[2],
    };
    idHint.textContent =
      `${dispChassis(picked.chassis)} · ${picked.model} · ` +
      `${bodyLabel(picked.body)} · ${etkSteerLabel(picked.steer)}`;
    idOpen.hidden = false;
  }

  idOpen.onclick = async () => {
    if (!picked) return;
    // the section may not cover this manually-picked chassis (wiring)
    const canOpen = opts.resolvable
      ? await opts.resolvable(picked.chassis)
      : true;
    if (!canOpen) {
      idHint.textContent = opts.unavailable
        ? opts.unavailable(dispChassis(picked.chassis))
        : `Not available for ${dispChassis(picked.chassis)}.`;
      return;
    }
    onResolve(picked);
  };

  // populate the Series pane once vehicles.json is in hand (car photos load
  // alongside; missing thumbs just leave the silhouette)
  (async () => {
    try {
      loadEtkThumbs();
      veh = await loadVehicles();
      grouped = groupBySeries(veh);
      refreshSeries();
    } catch (e) {
      idHint.textContent = String(e.message || e);
    }
  })();

  return idCard;
}
