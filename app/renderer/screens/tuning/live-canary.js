/**
 * @file Tuning > live mode: the RAM canary (testing only, localhost). The
 * emulator's survey names stretches of the DME's SRAM that nothing it ran
 * ever wrote (ms45-emu tools/ram_writers.py); the single-value pool could
 * grow by whatever is really free. Plant fills them with a byte over the
 * live-tune service (op 0A); after a drive, Check reads them back: a byte
 * the DME changed was not free. Scribbling on RAM the DME does use can
 * upset it once -- do it parked first.
 */
/* exported tnCanaryInit, tnCanarySync */

/** The candidate stretches, [from, to), session1clean program; 1564 B. */
const TN_CANARY = [
  [0x3fa387, 0x3fa4db],
  [0x3fdddc, 0x3fdee4],
  [0x3fad5c, 0x3fadb8],
  [0x3fe9c4, 0x3fea0c],
  [0x3fb1dc, 0x3fb21c],
  [0x3fa6be, 0x3fa6f8],
  [0x3fbb8c, 0x3fbbc6],
  [0x3fbca4, 0x3fbcde],
  [0x3fa709, 0x3fa739],
  [0x3fa749, 0x3fa778],
  [0x3fa647, 0x3fa670],
  [0x3fdd04, 0x3fdd2c],
  [0x3fabe8, 0x3fac0c],
  [0x3fb85e, 0x3fb87e],
  [0x3fc0ec, 0x3fc10c],
  [0x3fc624, 0x3fc644],
  [0x3fa695, 0x3fa6b4],
  [0x3ff564, 0x3ff580],
  [0x3fe997, 0x3fe9b3],
  [0x3fd59c, 0x3fd5b8],
  [0x3fe820, 0x3fe83c],
  [0x3fa102, 0x3fa11e],
  [0x3fb5d0, 0x3fb5ec],
  [0x3face5, 0x3fad00],
  [0x3fdcac, 0x3fdcc4],
];
const TN_CANARY_BYTE = 0xa5;
const TN_CANARY_KEY = 'bmweb.tuning.canary';
const TN_CANARY_CHUNK = 250;

const tnCanary = { panel: null, report: null };

/**
 * Add the "RAM canary" entry to the UI apps menu and build its panel
 * (localhost only); called when the live toolbar is built.
 * @returns {void}
 */
function tnCanaryInit() {
  if (typeof fbProtectTesting !== 'function' || !fbProtectTesting()) return;
  const menu = document.getElementById('tn-live-apps-menu');
  if (!menu || menu.querySelector('#tn-live-canary-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tn-tool-check';
  btn.id = 'tn-live-canary-btn';
  btn.title =
    'Plant a byte pattern in the SRAM the survey calls free, drive, read it back';
  btn.textContent = 'RAM canary';
  menu.appendChild(btn);
  for (const old of document.querySelectorAll('.tn-canary')) old.remove();
  const panel = document.createElement('div');
  panel.className = 'tn-canary';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="tn-canary-head"><b>RAM canary</b> · ${TN_CANARY.length} stretches, 1564 B
      <button type="button" class="btn tn-canary-close" title="Close">×</button></div>
    <div class="tn-canary-tools">
      <button type="button" class="btn tn-canary-plant">Plant</button>
      <button type="button" class="btn tn-canary-check">Check</button>
      <span class="tn-canary-note">Plant with the engine already running (a start or a reset re-initialises this RAM and wipes the pattern), drive with everything exercised, Check before switching off.</span>
    </div>
    <pre class="tn-canary-report"></pre>`;
  document.body.appendChild(panel);
  tnCanary.panel = panel;
  tnCanary.report = panel.querySelector('.tn-canary-report');
  btn.onclick = () => {
    panel.hidden = !panel.hidden;
    tnCanaryShowLast();
  };
  panel.querySelector('.tn-canary-close').onclick = () => {
    panel.hidden = true;
  };
  panel.querySelector('.tn-canary-plant').onclick = () => tnCanaryRun(true);
  panel.querySelector('.tn-canary-check').onclick = () => tnCanaryRun(false);
  tnCanaryShowLast();
}

/** Hide the panel when live mode is off. */
function tnCanarySync() {
  if (!tnCanary.panel) return;
  const armed = typeof tnLive !== 'undefined' && tnLive.armed && tnLive.lt;
  if (!armed) tnCanary.panel.hidden = true;
}

function tnCanaryShowLast() {
  if (!tnCanary.report) return;
  try {
    const last = JSON.parse(localStorage.getItem(TN_CANARY_KEY) || 'null');
    if (last && !tnCanary.report.textContent)
      tnCanary.report.textContent = last.text || '';
  } catch (e) {
    /* nothing remembered */
  }
}

/**
 * Plant (write the pattern) or check (read it back) every stretch.
 * @param {boolean} plant
 * @returns {Promise<void>}
 */
async function tnCanaryRun(plant) {
  const lt = typeof tnLive !== 'undefined' && tnLive.armed ? tnLive.lt : null;
  const out = tnCanary.report;
  if (!lt) {
    out.textContent = 'Live mode must be on.';
    return;
  }
  const lines = [];
  let intact = 0;
  let planted = 0;
  try {
    for (const [lo, hi] of TN_CANARY) {
      let changed = 0;
      for (let a = lo; a < hi; a += TN_CANARY_CHUNK) {
        const n = Math.min(TN_CANARY_CHUNK, hi - a);
        if (plant) {
          await lt.canary(a, n, TN_CANARY_BYTE);
          planted += n;
        } else {
          const back = await lt.readMemory(a, n);
          for (const b of back) if (b !== TN_CANARY_BYTE) changed++;
        }
      }
      if (!plant) {
        if (!changed) intact += hi - lo;
        lines.push(
          `${lo.toString(16).toUpperCase()}-${hi.toString(16).toUpperCase()} ${String(hi - lo).padStart(4)} B  ` +
            (changed ? `${changed} changed` : 'intact')
        );
      }
    }
  } catch (e) {
    lines.push(`stopped: ${(e && e.message) || e}`);
  }
  const when = new Date().toLocaleString();
  let plantedAt = null;
  try {
    plantedAt =
      (JSON.parse(localStorage.getItem(TN_CANARY_KEY) || 'null') || {})
        .plantedAt || null;
  } catch (e) {
    /* none remembered */
  }
  if (plant) plantedAt = when;
  const text = plant
    ? `Planted ${planted} B in ${TN_CANARY.length} stretches at ${when}. Drive, then Check (before key-off).`
    : `Checked ${when}${plantedAt ? ` (planted ${plantedAt})` : ' (nothing planted this browser session)'}: ${intact} B intact of 1564.` +
      (intact === 0
        ? ' Every byte changed: the DME reset (or restarted) since the plant and re-initialised this RAM.'
        : '') +
      '\n' +
      lines.join('\n');
  out.textContent = text;
  try {
    localStorage.setItem(
      TN_CANARY_KEY,
      JSON.stringify({ at: when, plantedAt, text })
    );
  } catch (e) {
    /* not remembered */
  }
}
