/**
 * @file The schematic viewer: zoom and pan by rewriting the SVG's viewBox,
 * so nothing re-renders but the attribute. Wheel, pinch, drag and the
 * on-screen zoom controls all drive one WiringPanZoom; a resize observer
 * re-fits a diagram the user has not touched.
 */

/* exported
   fitAndPan */

/** Zoom factor of one key press or button click. */
const WIRING_ZOOM_STEP = 1.3;
/** Zoom factor of one wheel notch. */
const WIRING_WHEEL_STEP = 1.12;
/** The widest view allowed, as a multiple of the diagram's own width. */
const WIRING_ZOOM_OUT_MAX = 20;
/** The narrowest view allowed, as a fraction of the diagram's own width. */
const WIRING_ZOOM_IN_MAX = 100;
/** A stage narrower than this (px) is not laid out yet; skip fitting. */
const WIRING_STAGE_MIN_PX = 2;
/**
 * The sheet assumed when an SVG carries neither viewBox nor width/height:
 * a WDS strip is roughly 4:1.
 */
const WIRING_DEFAULT_SHEET = { w: 10000, h: 2500 };

/**
 * An SVG viewBox as numbers.
 * @typedef {Object} WiringViewBox
 * @property {number} x - left edge in user units
 * @property {number} y - top edge in user units
 * @property {number} w - width in user units
 * @property {number} h - height in user units
 */

/**
 * The diagram's own viewBox: the attribute when it parses, else the
 * width/height, else the default sheet.
 * @param {SVGSVGElement} svg - the schematic
 * @returns {WiringViewBox}
 */
function wiringHomeViewBox(svg) {
  const rawVb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
  let vb = rawVb
    ? rawVb
        .trim()
        .split(/[\s,]+/)
        .map(Number)
    : [];
  if (vb.length !== 4 || vb.some(Number.isNaN)) {
    const w = parseFloat(svg.getAttribute('width')) || WIRING_DEFAULT_SHEET.w;
    const h = parseFloat(svg.getAttribute('height')) || WIRING_DEFAULT_SHEET.h;
    vb = [0, 0, w, h];
  }
  return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
}

/**
 * The viewBox camera over one schematic. `touched` records whether the user
 * has zoomed or panned by hand; an untouched diagram re-fits on resize, a
 * touched one is left alone.
 */
class WiringPanZoom {
  /**
   * @param {SVGSVGElement} svg - the schematic
   * @param {HTMLElement} stage - the box the schematic fills
   */
  constructor(svg, stage) {
    this.svg = svg;
    this.stage = stage;
    /** @type {WiringViewBox} the diagram's own extent */
    this.home = wiringHomeViewBox(svg);
    /** @type {WiringViewBox} what is on screen now */
    this.cur = { ...this.home };
    this.touched = false;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const h = this.home;
    svg.dataset.homeViewbox = `${h.x} ${h.y} ${h.w} ${h.h}`;
  }

  /**
   * Write the current viewBox to the SVG.
   * @returns {void}
   */
  apply() {
    const c = this.cur;
    this.svg.setAttribute('viewBox', `${c.x} ${c.y} ${c.w} ${c.h}`);
  }

  /**
   * User units per screen pixel at the current zoom, with the stage's box.
   * @returns {{r: DOMRect, k: number}}
   */
  metrics() {
    const r = this.stage.getBoundingClientRect();
    const k = Math.max(
      this.cur.w / (r.width || 1),
      this.cur.h / (r.height || 1)
    );
    return { r, k };
  }

  /**
   * Where a screen point sits in the current view, as fractions of its width
   * and height (unclamped: a point in the letterbox falls outside 0..1).
   * @param {number} clientX - screen x
   * @param {number} clientY - screen y
   * @returns {{k: number, fx: number, fy: number}}
   */
  focusAt(clientX, clientY) {
    const { r, k } = this.metrics();
    const cur = this.cur;
    const fx = ((clientX - r.left) * k - (r.width * k - cur.w) / 2) / cur.w;
    const fy = ((clientY - r.top) * k - (r.height * k - cur.h) / 2) / cur.h;
    return { k, fx, fy };
  }

  /**
   * Zoom by a factor about a point of the view. k > 1 widens the view (zooms
   * out); the view is clamped between the diagram's own width divided by
   * WIRING_ZOOM_IN_MAX and multiplied by WIRING_ZOOM_OUT_MAX.
   * @param {number} k - width multiplier
   * @param {number} [fx] - anchor x as a fraction of the view (0.5 = centre)
   * @param {number} [fy] - anchor y as a fraction of the view
   * @returns {void}
   */
  by(k, fx = 0.5, fy = 0.5) {
    this.touched = true;
    const cur = this.cur;
    const w = Math.min(
      this.home.w * WIRING_ZOOM_OUT_MAX,
      Math.max(this.home.w / WIRING_ZOOM_IN_MAX, cur.w * k)
    );
    const h = w * (cur.h / cur.w);
    cur.x += (cur.w - w) * fx;
    cur.y += (cur.h - h) * fy;
    cur.w = w;
    cur.h = h;
    this.apply();
  }

  /**
   * Move the view by an offset in user units.
   * @param {number} dx - horizontal offset
   * @param {number} dy - vertical offset
   * @returns {void}
   */
  panBy(dx, dy) {
    this.cur.x += dx;
    this.cur.y += dy;
    this.apply();
  }

  /**
   * Put the view's top-left corner at a point in user units.
   * @param {number} x - left edge
   * @param {number} y - top edge
   * @returns {void}
   */
  panTo(x, y) {
    this.cur.x = x;
    this.cur.y = y;
    this.apply();
  }

  /**
   * Show the whole diagram centred in the stage, letterboxed to the stage's
   * aspect ratio, and mark the view untouched.
   * @returns {void}
   */
  fit() {
    this.touched = false;
    const home = this.home;
    const r = this.stage.getBoundingClientRect();
    const pw = r.width || window.innerWidth || 360;
    const ph = r.height || window.innerHeight - 100 || 600;
    const paneRatio = pw / ph;
    let w = home.w,
      h = home.h;
    if (home.w / home.h > paneRatio) h = home.w / paneRatio;
    else w = home.h * paneRatio;
    this.cur.x = home.x - (w - home.w) / 2;
    this.cur.y = home.y - (h - home.h) / 2;
    this.cur.w = w;
    this.cur.h = h;
    this.apply();
  }
}

/**
 * Wheel zooms about the pointer.
 * @param {WiringPanZoom} zoom - the camera
 * @param {HTMLElement} stage - the schematic's box
 * @returns {void}
 */
function wiringBindWheel(zoom, stage) {
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { fx, fy } = zoom.focusAt(e.clientX, e.clientY);
      zoom.by(e.deltaY > 0 ? WIRING_WHEEL_STEP : 1 / WIRING_WHEEL_STEP, fx, fy);
    },
    { passive: false }
  );
}

/**
 * Touch: pinch-zoom about the touch centre and pan with it; one finger pans.
 * @param {WiringPanZoom} zoom - the camera
 * @param {HTMLElement} stage - the schematic's box
 * @returns {void}
 */
function wiringBindTouch(zoom, stage) {
  let lastTouchDist = 0;
  let lastTouchMidX = 0;
  let lastTouchMidY = 0;
  let lastTouchX = 0;
  let lastTouchY = 0;

  /**
   * The gap and midpoint of the first two touches.
   * @param {TouchList} touches - the event's touches
   * @returns {{dist: number, midX: number, midY: number}}
   */
  const pinchOf = (touches) => {
    const t1 = touches[0],
      t2 = touches[1];
    return {
      dist: Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY),
      midX: (t1.clientX + t2.clientX) / 2,
      midY: (t1.clientY + t2.clientY) / 2,
    };
  };

  stage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) {
        lastTouchX = e.touches[0].clientX;
        lastTouchY = e.touches[0].clientY;
        lastTouchDist = 0;
      } else if (e.touches.length >= 2) {
        const p = pinchOf(e.touches);
        lastTouchDist = p.dist;
        lastTouchMidX = p.midX;
        lastTouchMidY = p.midY;
      }
    },
    { passive: false }
  );

  stage.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      zoom.touched = true;

      if (e.touches.length >= 2) {
        const { dist, midX, midY } = pinchOf(e.touches);
        if (lastTouchDist > 0 && dist > 0) {
          const factor = lastTouchDist / dist;
          const f = zoom.focusAt(midX, midY);
          const fx = Math.max(0, Math.min(1, f.fx));
          const fy = Math.max(0, Math.min(1, f.fy));
          zoom.by(factor, fx, fy); // around the touch centre
          // pan with the midpoint, at the scale before the zoom
          zoom.panBy(
            (lastTouchMidX - midX) * f.k,
            (lastTouchMidY - midY) * f.k
          );
        }
        lastTouchDist = dist;
        lastTouchMidX = midX;
        lastTouchMidY = midY;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        const { k } = zoom.metrics();
        zoom.panBy((lastTouchX - t.clientX) * k, (lastTouchY - t.clientY) * k);
        lastTouchX = t.clientX;
        lastTouchY = t.clientY;
        lastTouchDist = 0;
      }
    },
    { passive: false }
  );

  const onTouchEnd = (e) => {
    if (e.touches.length === 1) {
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
      lastTouchDist = 0;
    } else if (e.touches.length === 0) {
      lastTouchDist = 0;
    }
  };
  stage.addEventListener('touchend', onTouchEnd, { passive: false });
  stage.addEventListener('touchcancel', onTouchEnd, { passive: false });
}

/**
 * Mouse drag pans (desktop). The move and up listeners sit on window so a
 * drag that leaves the stage still tracks and still ends.
 * @param {WiringPanZoom} zoom - the camera
 * @param {HTMLElement} stage - the schematic's box
 * @returns {void}
 */
function wiringBindMouse(zoom, stage) {
  let mouseDrag = null;
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    mouseDrag = { x: e.clientX, y: e.clientY, vx: zoom.cur.x, vy: zoom.cur.y };
    stage.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!mouseDrag) return;
    zoom.touched = true;
    const { k } = zoom.metrics();
    zoom.panTo(
      mouseDrag.vx - (e.clientX - mouseDrag.x) * k,
      mouseDrag.vy - (e.clientY - mouseDrag.y) * k
    );
  });
  window.addEventListener('mouseup', () => {
    if (mouseDrag) {
      mouseDrag = null;
      stage.classList.remove('grabbing');
    }
  });
}

/**
 * On-screen zoom controls, mirroring the F-keys, plus Share (copies a link to
 * this exact document so it can be sent to someone else). WDS kept these in
 * the footer; the modern layout puts them on the document bar.
 * @param {WiringPanZoom} zoom - the camera
 * @param {HTMLElement} bar - where the controls go
 * @param {boolean} classic - INPA mode: WDS's button glyphs and classes
 * @returns {void}
 */
function wiringZoomControls(zoom, bar, classic) {
  const controls = document.createElement('div');
  controls.className = 'wiring-zoom';
  [
    [
      classic ? '⊕' : '+',
      'Zoom in (+ key, or scroll the wheel)',
      () => zoom.by(1 / WIRING_ZOOM_STEP),
    ],
    [classic ? '⊖' : '−', 'Zoom out (- key)', () => zoom.by(WIRING_ZOOM_STEP)],
    [classic ? '⊡' : 'Fit', 'Fit the whole diagram (0 key)', () => zoom.fit()],
  ].forEach(([label, title, fn]) => {
    const b = document.createElement('button');
    b.className = classic ? 'wds-btn wds-btn-sq' : 'btn wiring-fit';
    b.textContent = label;
    b.title = title;
    b.onclick = fn;
    controls.appendChild(b);
  });
  controls.appendChild(wiringShareButton(classic));
  if (classic) bar.innerHTML = '';
  bar.appendChild(controls);
  if (typeof tipify === 'function') tipify(controls);
}

/**
 * Fit on every stage resize while the view is untouched, and once up front.
 * On a hard reload the stage is already at its final size when the observer
 * attaches, so the ResizeObserver's first callback can be a no-op (same
 * signature) and the diagram would render unfitted until the pane next
 * resized. A next-frame fit guarantees a correct first paint; it records the
 * size so the observer won't fight it, and skips if the user already zoomed
 * before the frame ran.
 * @param {WiringPanZoom} zoom - the camera
 * @param {HTMLElement} stage - the schematic's box
 * @returns {void}
 */
function wiringAutoFit(zoom, stage) {
  let last = '';
  const sizeOf = (r) => `${Math.round(r.width)}x${Math.round(r.height)}`;
  const ro = new ResizeObserver(() => {
    const r = stage.getBoundingClientRect();
    if (r.width < WIRING_STAGE_MIN_PX || r.height < WIRING_STAGE_MIN_PX) return;
    const sig = sizeOf(r);
    if (sig === last) return;
    last = sig;
    if (!zoom.touched) zoom.fit();
  });
  ro.observe(stage);
  requestAnimationFrame(() => {
    const r = stage.getBoundingClientRect();
    if (r.width < WIRING_STAGE_MIN_PX || r.height < WIRING_STAGE_MIN_PX) return;
    last = sizeOf(r);
    if (!zoom.touched) zoom.fit();
  });
}

/**
 * Make a schematic zoomable and pannable, add the zoom controls to the bar,
 * and fit it. The returned camera's `by` and `fit` back the F-keys.
 * @param {SVGSVGElement} svg - the schematic
 * @param {HTMLElement} stage - the box the schematic fills
 * @param {HTMLElement} bar - where the zoom controls go
 * @param {boolean} [classic] - INPA mode: WDS's footer buttons
 * @returns {WiringPanZoom}
 */
function fitAndPan(svg, stage, bar, classic = false) {
  const zoom = new WiringPanZoom(svg, stage);
  wiringBindWheel(zoom, stage);
  wiringBindTouch(zoom, stage);
  wiringBindMouse(zoom, stage);
  wiringZoomControls(zoom, bar, classic);
  wiringAutoFit(zoom, stage);
  return zoom;
}
