/**
 * @file The ISTA layout's chrome: the toolbar row, the title row, the header
 * line, the three tab bars, the status line and the bottom button bar.
 *
 * WHAT THIS FILE IS FOR. The shell already knew how to be a frame around the
 * app's screens (banner.js/screen.js); what it did not know was how to look
 * like the tool it is named after. This file is the second face: with the
 * layout setting on INPA it paints the workshop tool's own chrome, and with
 * it on Modern nothing here is called at all and the shell keeps the look it
 * had. One shell, two faces, no second copy of the routing.
 *
 * EVERY ICON IS DRAWN. The toolbar's home, print, settings, help, restore and
 * close glyphs are inline SVG paths, and so are the star, the nav arrows and
 * the details page's warning triangle. No emoji: an emoji is a font the
 * machine may not have, and a workshop chrome that renders a tofu box where
 * its close button should be is worse than no icon at all.
 *
 * THE ONE SHAPE RULE. A tab strip is square when another strip sits under it
 * and trapezoid (top-right corner cut) when it is the last strip on the
 * page. That is the rule the frames show and it is the whole difference
 * between reading as the real tool and reading as an imitation of it, so it
 * lives in one place: istaStripClass below.
 */

/* exported istaSkinOn istaPaintReal istaRealBottom istaRealStatus
   istaRealIcon istaRealProgress istaAscii istaSeries istaGearbox
   istaMarket */

/** The bottom button bar's element id. */
const ISTA_BOTTOM_ID = 'ista-bottom';

/** The status line's element id. */
const ISTA_STATUS_ID = 'ista-status';

/**
 * Is the ISTA layout on?
 *
 * Deliberately the LAYOUT setting (inpaMode: Settings 'inpaScreens'), not the
 * skin setting: the user asked for the tool's layout, and the two are
 * separate choices. inpaMode is already forced off on phones, which is what
 * we want here too -- this chrome is 1728px of fixed bands and cannot be
 * folded into a phone.
 * @returns {boolean}
 */
function istaSkinOn() {
  return typeof inpaMode === 'function' ? inpaMode() : false;
}

/**
 * One drawn icon.
 *
 * Paths are on a 16x16 grid and stroke in currentColor, so a glyph reads the
 * same on the grey toolbar and on a teal title bar without a second copy.
 * @param {string} name - the icon's name
 * @returns {string} an <svg> element, or '' for a name with no glyph
 */
function istaRealIcon(name) {
  const paths = {
    // a house: roof, then the box under it
    home: '<path d="M2 8 L8 2.5 L14 8"/><path d="M4 8 V14 H12 V8"/>',
    // two windows, side by side (the tile button)
    tile: '<path d="M2 3 H7 V13 H2 Z"/><path d="M9 3 H14 V13 H9 Z"/>',
    // a printer: paper above, body, sheet below
    print:
      '<path d="M4.5 6 V2.5 H11.5 V6"/><path d="M2.5 6 H13.5 V11 H2.5 Z"/>' +
      '<path d="M4.5 9.5 H11.5 V14 H4.5 Z"/>',
    // a spanner, laid diagonally
    wrench:
      '<path d="M10.6 2.2 a3.4 3.4 0 1 0 3.2 3.2 l-2.3 2.3 -1.6 -0.3 ' +
      '-0.3 -1.6 Z"/><path d="M9.1 7.4 L3 13.5"/>',
    // a question mark, drawn as a stroke so it needs no font
    help:
      '<path d="M5.6 5.4 a2.6 2.6 0 1 1 2.9 2.7 V10"/>' +
      '<path d="M8.4 12.4 h0.01"/>',
    // the restore-window glyph: a bar over a box
    restore: '<path d="M2.5 3.5 H13.5"/><path d="M2.5 6.5 H13.5 V13 H2.5 Z"/>',
    // a close cross
    close: '<path d="M3.5 3.5 L12.5 12.5"/><path d="M12.5 3.5 L3.5 12.5"/>',
    // the session list glyph: three dotted rows
    list:
      '<path d="M3 4.5 h1"/><path d="M6 4.5 h7"/><path d="M3 8 h1"/>' +
      '<path d="M6 8 h7"/><path d="M3 11.5 h1"/><path d="M6 11.5 h7"/>',
    // a five-pointed star, for the favourites pin
    star:
      '<path d="M8 1.8 L9.9 6 L14.3 6.4 L11 9.3 L12 13.6 L8 11.3 ' +
      'L4 13.6 L5 9.3 L1.7 6.4 L6.1 6 Z"/>',
    // the warning triangle on a details label
    warn: '<path d="M8 1.6 L15 14 H1 Z"/>',
  };
  const d = paths[name];
  if (!d) return '';
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
}

/**
 * A left or right nav triangle, filled white for the black nav blocks.
 * @param {boolean} back - true for the left-pointing one
 * @returns {string} an <svg> element
 */
function istaRealArrow(back) {
  const d = back ? 'M14 1 L14 13 L2 7 Z' : 'M2 1 L2 13 L14 7 Z';
  return `<svg viewBox="0 0 16 14" aria-hidden="true"><path d="${d}"/></svg>`;
}

/**
 * The date and time the toolbar shows, in the tool's own format.
 * @param {Date} [now] - the moment, for tests
 * @returns {string} e.g. "27/01/2021 17:02:32"
 */
function istaRealClock(now) {
  const d = now || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * The header line's Vehicle description: the tool's slash-separated string.
 *
 * Its shape is Series / Development code / Body / - / Engine / Gearbox /
 * Basic version / Steering / Year / Month, and every part is a Vehicle
 * details field. A part nobody knows is a "-" rather than a gap, so the
 * slashes stay in their places and the line can be read positionally.
 * @param {object|null} car - the picked GarageCar
 * @param {object|null} etk - a viEtkDecode result for the car's VIN
 * @returns {string} the description, or '' with nothing at all to say
 */
function istaRealVehicleLine(car, etk) {
  if (!car && !etk) return '';
  const e = etk || {};
  const c = car || {};
  const dash = (v) => (v == null || v === '' ? '-' : String(v));
  const prod = String(e.prod || c.prod || '');
  const year = prod.length >= 4 ? prod.slice(0, 4) : '';
  const month = prod.length >= 6 ? prod.slice(4, 6) : '';
  // THE TOOL PRINTS ASCII HERE. Its header line is a fixed-pitch slash
  // string, and it writes "Coupe", not "Coupé" -- so the accent is folded
  // out rather than passed through from the catalogue label.
  const body = istaAscii(
    typeof bodyLabel === 'function' ? bodyLabel(e.body || c.body) : e.body
  );
  // the SERIES, not the model name: the frames read "3'/E46/Coupe", never
  // "330Ci/E46/Coupe". The catalogue's model field is the variant name, so
  // the series is taken off it (its leading digits) and given the trailing
  // apostrophe the tool writes.
  const series = istaSeries(e.model || c.model || '');
  const chassis = String(e.chassis || c.chassis || '').toUpperCase();
  const gear = istaGearbox(e, c);
  // the steering letter is the tool's basic-version/steering pair: it shows
  // the market it typed the car for and LL/RL for left or right hand drive
  const steer = e.steer === 'R' ? 'RL' : e.steer === 'L' ? 'LL' : '';
  return [
    dash(series),
    dash(chassis),
    dash(body),
    '-',
    dash(e.motor || c.motor),
    dash(gear),
    dash(istaMarket(e, c)),
    dash(steer),
    dash(year),
    dash(month),
  ].join('/');
}

/**
 * Fold a label to ASCII.
 *
 * The tool's header line and its details grid print "Coupe", not "Coupé":
 * the string is a fixed-pitch slash list and it carries no accents. Folding
 * here rather than shipping a second label table keeps the catalogue's own
 * names intact everywhere else in the app.
 * @param {string} v - the label
 * @returns {string} the same label, accents removed
 */
function istaAscii(v) {
  return String(v == null ? '' : v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * The SERIES a model name belongs to, as the tool writes it.
 *
 * The catalogue's model field is the variant ("330Ci", "525i tour"); the
 * tool's header wants the series it sits in, with the trailing apostrophe:
 * "3'", "5'". The series is the leading digit of the type number, which is
 * how BMW numbers them, so it is read off the front rather than looked up.
 * A name with no leading digit (a chassis-only car, an i or X name) is
 * passed through -- inventing a series for it would be worse than showing
 * what we have.
 * @param {string} model - the catalogue's model name
 * @returns {string} the series, e.g. "3'", or the name unchanged
 */
function istaSeries(model) {
  const m = String(model || '').trim();
  if (!m) return '';
  if (/^\d/.test(m)) return `${m[0]}'`;
  return m;
}

/**
 * The gearbox, as the tool writes it: MANUAL or AUTO.
 *
 * The catalogue decode carries it as a letter on the VIN row; where that is
 * absent the Garage's own saved column is tried before giving up. "-" only
 * when neither knows, which is the difference between "this car has no
 * gearbox recorded" and "we did not look".
 * @param {object} etk - the VIN decode
 * @param {object} car - the saved GarageCar
 * @returns {string} MANUAL, AUTO, or ''
 */
function istaGearbox(etk, car) {
  const g = String((etk && etk.gear) || (car && car.gear) || '').toUpperCase();
  if (g.startsWith('A')) return 'AUTO';
  if (g.startsWith('M')) return 'MANUAL';
  return '';
}

/**
 * The basic version: the market the car was typed for (US, ECE ...).
 *
 * The VIN index carries it where the production record had one. Like the
 * gearbox it falls back to the saved column before giving up.
 * @param {object} etk - the VIN decode
 * @param {object} car - the saved GarageCar
 * @returns {string} the market code, or ''
 */
function istaMarket(etk, car) {
  return String(
    (etk && (etk.market || etk.land)) || (car && car.market) || ''
  ).toUpperCase();
}

/**
 * Which shape a strip takes.
 *
 * THE RULE, in one function: a strip with another strip under it keeps the
 * main bar's square columns; the last strip on the page cuts its top-right
 * corner. Both sub-tab strips go through here, so the two can never drift
 * apart.
 * @param {boolean} last - is this the last strip on the page?
 * @returns {string} the class that shapes it
 */
function istaStripClass(last) {
  return last ? 'irstrip-cut' : 'irstrip-grid';
}

/**
 * One tab button, at any of the three levels.
 * @param {object} o - the button
 * @param {string} o.label - what it says
 * @param {string} o.cls - the level's class (irtab or irsub)
 * @param {boolean} o.on - is it the active one?
 * @param {boolean} o.off - is it greyed?
 * @param {object} o.data - data-* attributes to stamp on it
 * @param {string} [o.title] - a tooltip, usually a greyed tab's reason
 * @param {string} [o.extra] - markup to append inside (the pin star)
 * @returns {string} HTML
 */
function istaRealTab(o) {
  const data = Object.keys(o.data || {})
    .map((k) => ` data-${k}="${esc(o.data[k])}"`)
    .join('');
  return (
    `<button type="button" class="${o.cls}${o.on ? ' on' : ''}` +
    `${o.off ? ' off' : ''}"${data}` +
    (o.title ? ` title="${esc(o.title)}"` : '') +
    (o.on ? ' aria-current="page"' : '') +
    `>${esc(o.label)}${o.extra || ''}</button>`
  );
}

/**
 * The toolbar row: session squares on the left, clock and icons on the right.
 * @param {object[]} sessions - the open cars, as {id, n, label}
 * @param {string} activeId - the open car's id
 * @returns {string} HTML
 */
function istaRealToolbar(sessions, activeId) {
  const sq = (sessions.length ? sessions : [{ id: '', n: 1, label: '' }])
    .slice(0, 3)
    .map(
      (s, i) =>
        `<button type="button" class="irt-sq${
          s.id && s.id === activeId ? ' on' : ''
        }" data-sess="${esc(s.id)}" title="${esc(s.label || 'Session')}">` +
        `${i + 1}</button>`
    )
    .join('');
  const ico = (name, act, title) =>
    `<button type="button" class="irt-ico" data-act="${act}" ` +
    `title="${esc(title)}" aria-label="${esc(title)}">` +
    `${istaRealIcon(name)}</button>`;
  return (
    `<div class="irt">` +
    `<div class="irt-sess">${sq}` +
    `<button type="button" class="irt-ico" data-act="sessions" ` +
    `title="Sessions" aria-label="Sessions">${istaRealIcon('list')}</button>` +
    `</div>` +
    `<div class="irt-spacer"></div>` +
    `<span class="irt-clock" id="ista-clock">${esc(istaRealClock())}</span>` +
    ico('home', 'home', 'Back to the app') +
    ico('tile', 'tile', 'Tile windows (not in this build)') +
    ico('print', 'print', 'Print this view') +
    ico('wrench', 'settings', 'Settings') +
    ico('help', 'help', 'Documentation') +
    ico('restore', 'restore', 'Restore window (not in this build)') +
    ico('close', 'close', 'Leave the workshop view') +
    `</div>`
  );
}

/**
 * The header line: VIN, the vehicle description, and the two terminals.
 * @param {object|null} car - the picked GarageCar
 * @param {object|null} etk - the VIN decode for it
 * @param {boolean} tested - has a whole-car test finished this session?
 * @returns {string} HTML
 */
function istaRealHeader(car, etk, tested) {
  const vin = (car && car.vin) || '';
  // the tool shows the last seven of the VIN: the production number, which
  // is what a workshop writes on the job card
  const tail = vin ? vin.slice(-7) : '';
  const line = istaRealVehicleLine(car, etk);
  return (
    `<div class="irhead">` +
    `<span class="irhead-vin"><span class="irhead-k">VIN</span> ` +
    `<b>${esc(tail)}</b></span>` +
    `<span class="irhead-veh"><span class="irhead-k">Vehicle</span> ` +
    `<b>${esc(line)}</b></span>` +
    (tested ? `<span class="irhead-test">Vehicle test (Finished)</span>` : '') +
    `<span class="irhead-kl">` +
    `<span><span class="irhead-k">KL 15:</span> ` +
    `<b id="ista-kl15-v">--</b></span>` +
    `<span><span class="irhead-k">KL 30:</span> ` +
    `<b id="ista-kl30-v">--</b></span>` +
    `</span></div>`
  );
}

/**
 * Paint the whole ISTA chrome into the container.
 *
 * @param {HTMLElement} el - the chrome container
 * @param {object} ctx - what to draw
 * @param {object|null} ctx.car - the picked GarageCar
 * @param {object|null} ctx.etk - the VIN decode for it
 * @param {boolean} ctx.tested - a whole-car test finished this session
 * @param {string} ctx.tab - the active tab id
 * @param {string|null} ctx.sub - the active sub-tab id
 * @param {string|null} ctx.sub3 - the active level-3 tab id
 * @param {(kind: string, ids: object) => void} ctx.go - navigate
 * @param {(act: string) => void} ctx.act - a toolbar icon was pressed
 * @param {(ids: object) => void} ctx.pin - a star was pressed
 * @param {(id: string) => boolean} [ctx.subOff] - is this sub-tab greyed?
 * @returns {void}
 */
function istaPaintReal(el, ctx) {
  const car = ctx.car;
  const sessions = car
    ? [{ id: car.id, n: 1, label: car.label || car.vin || '' }]
    : [];
  const tabs = ISTA_TABS.map((t) =>
    istaRealTab({
      label: t.label,
      cls: 'irtab',
      on: t.id === ctx.tab,
      off: false,
      data: { tab: t.id },
    })
  ).join('');

  const subs = istaSubsOf(ctx.tab);
  const subs3 = ctx.sub ? istaSubs3Of(ctx.tab, ctx.sub) : [];
  // the level-2 strip is the last one only when no level-3 strip follows it
  const lvl2Last = !subs3.length;

  const star = (on) =>
    `<span class="irsub-star${on ? ' on' : ''}" role="button" tabindex="-1" ` +
    `aria-hidden="true">${istaRealIcon('star')}</span>`;

  const strip2 = subs.length
    ? `<div class="irstrip ${istaStripClass(lvl2Last)}">` +
      subs
        .map((s) => {
          const owner = s._tab || ctx.tab;
          const on = s.id === ctx.sub && owner === ctx.tab;
          const off = !!s.why;
          return istaRealTab({
            label: s.label,
            cls: 'irsub',
            on,
            off,
            title: s.why || '',
            data: { sub: s.id, owner },
            extra: star(istaIsFavourite(owner, s.id)),
          });
        })
        .join('') +
      `</div>`
    : '';

  const strip3 = subs3.length
    ? `<div class="irstrip irstrip-3 irstrip-cut">` +
      subs3
        .map((s) =>
          istaRealTab({
            label: s.label,
            cls: 'irsub',
            on: s.id === ctx.sub3,
            off: !!s.why,
            title: s.why || '',
            data: { sub3: s.id },
            extra: star(istaIsFavourite(ctx.tab, ctx.sub, s.id)),
          })
        )
        .join('') +
      `</div>`
    : '';

  el.innerHTML =
    istaRealToolbar(sessions, car ? car.id : '') +
    `<div class="irtitle">BMWeb workshop</div>` +
    istaRealHeader(car, ctx.etk, ctx.tested) +
    `<div class="irtabs" role="tablist">${tabs}</div>` +
    strip2 +
    strip3;

  el.querySelectorAll('.irtab[data-tab]').forEach((b) => {
    b.onclick = () => ctx.go('tab', { tab: b.dataset.tab });
  });
  el.querySelectorAll('.irsub[data-sub]').forEach((b) => {
    b.onclick = (e) => {
      if (e.target.closest('.irsub-star'))
        return ctx.pin({ tab: b.dataset.owner, sub: b.dataset.sub });
      ctx.go('sub', { tab: b.dataset.owner, sub: b.dataset.sub });
    };
  });
  el.querySelectorAll('.irsub[data-sub3]').forEach((b) => {
    b.onclick = (e) => {
      if (e.target.closest('.irsub-star'))
        return ctx.pin({ tab: ctx.tab, sub: ctx.sub, sub3: b.dataset.sub3 });
      ctx.go('sub3', { sub3: b.dataset.sub3 });
    };
  });
  el.querySelectorAll('.irt-ico[data-act]').forEach((b) => {
    b.onclick = () => ctx.act(b.dataset.act);
  });
  el.querySelectorAll('.irt-sq[data-sess]').forEach((b) => {
    b.onclick = () => ctx.act('sessions');
  });

  // the chrome's height is what .view starts under, and it changes with the
  // number of strips: measure rather than guess, so a two-line tab label
  // (Workshop/Operating fluids) does not tuck the content under the strip
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => istaRealMeasure(el));
  else istaRealMeasure(el);
}

/**
 * Tell the layout how tall the chrome came out.
 * @param {HTMLElement} el - the chrome container
 * @returns {void}
 */
function istaRealMeasure(el) {
  if (!el || !el.isConnected || typeof document === 'undefined') return;
  const h = el.getBoundingClientRect().height;
  if (h > 0) document.body.style.setProperty('--ista-h', `${Math.round(h)}px`);
}

/**
 * The element a floating bar lives in, created on first use and parked
 * beside #view so it floats over the content rather than scrolling with it.
 * @param {string} id - the bar's id
 * @param {string} cls - its class
 * @returns {HTMLElement|null}
 */
function istaRealBarEnsure(id, cls) {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(id);
  if (el) return el;
  const host = document.getElementById('view');
  if (!host || !host.parentNode) return null;
  el = document.createElement('div');
  el.id = id;
  el.className = cls;
  host.parentNode.insertBefore(el, host.nextSibling);
  return el;
}

/**
 * Draw the status line under the content.
 *
 * @param {object|null} o - what it says, or null to clear it
 * @param {Array<{k: string, v: string}>} [o.items] - the left-hand pairs
 * @param {Array<{cls: string, label: string}>} [o.legend] - the legend
 * @returns {void}
 */
function istaRealStatus(o) {
  const el = istaRealBarEnsure(ISTA_STATUS_ID, 'irstatus');
  if (!el) return;
  if (!o) {
    el.innerHTML = '';
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const items = (o.items || [])
    .map((i) => `<span>${esc(i.k)} <b>${esc(i.v)}</b></span>`)
    .join('');
  const legend = (o.legend || []).length
    ? `<span class="irlegend">` +
      o.legend
        .map((l) => `<span><i class="${esc(l.cls)}"></i>${esc(l.label)}</span>`)
        .join('') +
      `</span>`
    : '';
  el.innerHTML = items + `<span class="irstatus-spacer"></span>` + legend;
}

/**
 * Draw the bottom button bar.
 *
 * Buttons are given left to right. A `nav: true` entry becomes the centred
 * pair of black nav blocks; a `spacer: true` entry splits the row without
 * them. Everything after either goes to the right-hand group, which is how
 * every page in the frames is laid out.
 *
 * The nav blocks belong ONLY to the pages that step through a list of hits
 * (the two-pane browsers, the Service plan lists). Which pages those are is
 * the model's ISTA_BOTTOM table, not this function's business.
 * @param {Array<object>|null} buttons - {label, fn, off, nav, spacer}
 *   entries, or null to clear the bar
 * @returns {void}
 */
function istaRealBottom(buttons) {
  const el = istaRealBarEnsure(ISTA_BOTTOM_ID, 'irbottom');
  if (!el) return;
  if (!buttons) {
    el.innerHTML = '';
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const fns = [];
  const html = buttons
    .map((b) => {
      // a spacer pushes everything after it to the right-hand group, which is
      // how a page with no nav blocks still splits its row in two
      if (b.spacer) return `<span class="irbottom-spacer"></span>`;
      if (b.nav) {
        // the centred pair: a spacer either side keeps them centred however
        // many buttons sit left and right of them
        const one = (back, i) => {
          fns.push(back ? b.back : b.fwd);
          return (
            `<button type="button" class="irnav" data-i="${fns.length - 1}"` +
            `${(back ? b.back : b.fwd) ? '' : ' disabled'} ` +
            `aria-label="${back ? 'Back' : 'Forward'}">` +
            `${istaRealArrow(back)}</button>`
          );
        };
        return (
          `<span class="irbottom-spacer"></span>` +
          one(true) +
          one(false) +
          `<span class="irbottom-spacer"></span>`
        );
      }
      fns.push(b.fn);
      return (
        `<button type="button" class="irbtn" data-i="${fns.length - 1}"` +
        `${b.off ? ' disabled' : ''}` +
        (b.title ? ` title="${esc(b.title)}"` : '') +
        `>${esc(b.label)}</button>`
      );
    })
    .join('');
  el.innerHTML = html;
  el.querySelectorAll('[data-i]').forEach((b) => {
    const fn = fns[Number(b.dataset.i)];
    if (fn) b.onclick = () => fn();
    else b.disabled = true;
  });
}

/**
 * The tool's "Ongoing background process" dialog, for a read in flight.
 *
 * Returned as a handle rather than awaited: a read finishes when the bus
 * says so, and the caller closes it then.
 * @param {string} [note] - the line under the title
 * @returns {{close: () => void}} close it when the read is done
 */
function istaRealProgress(note) {
  if (typeof openModal !== 'function') return { close: () => {} };
  const { close } = openModal(
    `<div class="modal irprog" role="dialog" aria-modal="true">` +
      `<div class="modal-title">Ongoing background process</div>` +
      `<div class="irprog-body">${esc(note || 'It will take a moment...')}` +
      `<div class="irprog-bar"><div class="irprog-fill"></div></div>` +
      `</div></div>`
  );
  return { close };
}

if (typeof window !== 'undefined') {
  window.istaSkinOn = istaSkinOn;
  window.istaRealProgress = istaRealProgress;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_BOTTOM_ID,
    ISTA_STATUS_ID,
    istaSkinOn,
    istaRealIcon,
    istaRealArrow,
    istaRealClock,
    istaRealVehicleLine,
    istaAscii,
    istaSeries,
    istaGearbox,
    istaMarket,
    istaStripClass,
    istaRealTab,
    istaRealToolbar,
    istaRealHeader,
    istaPaintReal,
    istaRealMeasure,
    istaRealStatus,
    istaRealBottom,
    istaRealProgress,
  };
}
