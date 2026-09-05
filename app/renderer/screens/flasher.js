// ECU Backup: read a control unit's firmware off the car and save it as a .bin.
//
// The engine is core/flasher.js (profile-driven, read-only). This screen is
// the thin operator console over it: pick the module, pick which region to
// read (the "tune" data block, or the whole flash), watch the stages and
// progress, and save the bytes. It never writes to the ECU -- there is no
// write path in the engine to call.
//
// Only modules that have a flash profile are offered. Listing every SGBD and
// greying most of them would invite people to try an unsupported DME and get
// a confusing failure; the honest list is the short one.

async function showFlasher() {
  lastScreen = showFlasher;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'ECU Backup' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'ecu backup';
  view.innerHTML = head(
    'BACKUP',
    'ECU Backup',
    'Read a control unit’s firmware off the car and save it. Read only: ' +
      'nothing here writes to the ECU.'
  );
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showApps,
    },
  ]);

  const wrap = document.createElement('div');
  wrap.className = 'flasher';
  wrap.innerHTML = `
    <div class="flasher-grid">
      <div class="flasher-col">
        <label class="flasher-label">Control unit</label>
        <div class="flasher-ecus" id="fl-ecus"></div>
        <label class="flasher-label">What to read</label>
        <div class="flasher-regions" id="fl-regions"></div>
        <div class="flasher-note" id="fl-note">
          Ignition on, engine off, battery healthy. A full read takes a few
          minutes at 115200 (MS45, MSV70, MSS70) and around ten at DS2’s 9600
          (MS42, MS43); don’t turn the key off until it finishes.
        </div>
      </div>
      <div class="flasher-col flasher-run">
        <div class="flasher-ident" id="fl-ident"></div>
        <div class="flasher-stage" id="fl-stage">Pick a control unit to begin.</div>
        <div class="flasher-bar"><span class="flasher-bar-fill" id="fl-fill"></span></div>
        <div class="flasher-pct" id="fl-pct"></div>
        <div class="flasher-btns">
          <button class="btn primary" id="fl-start" disabled>Read &amp; save</button>
          <button class="btn" id="fl-cancel" hidden>Cancel</button>
        </div>
        <div class="flasher-log" id="fl-log"></div>
      </div>
    </div>`;
  view.appendChild(wrap);

  const ecusEl = wrap.querySelector('#fl-ecus');
  const regionsEl = wrap.querySelector('#fl-regions');
  const identEl = wrap.querySelector('#fl-ident');
  const stageEl = wrap.querySelector('#fl-stage');
  const fillEl = wrap.querySelector('#fl-fill');
  const pctEl = wrap.querySelector('#fl-pct');
  const startBtn = wrap.querySelector('#fl-start');
  const cancelBtn = wrap.querySelector('#fl-cancel');
  const logEl = wrap.querySelector('#fl-log');

  const state = { profile: null, region: null, running: false, abort: null };

  const log = (text) => {
    const line = document.createElement('div');
    line.className = 'flasher-logline';
    line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };

  // -- the module list: one row per flash profile ---------------------------
  const profiles = typeof FLASH_PROFILES !== 'undefined' ? FLASH_PROFILES : [];
  if (!profiles.length) {
    ecusEl.innerHTML = `<div class="flasher-empty">No flash profiles in this build.</div>`;
  }
  profiles.forEach((p) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'flasher-ecu';
    row.dataset.id = p.id;
    row.innerHTML =
      `<span class="flasher-ecu-name">${esc(p.label)}</span>` +
      `<span class="flasher-ecu-sgbd">${esc(p.sgbd)}` +
      (p.verified ? '' : ' · <em>not yet proven on a car</em>') +
      `</span>`;
    row.onclick = () => pickProfile(p);
    ecusEl.appendChild(row);
  });
  // the DMEs people will look for, and why each is not here yet
  const missing =
    typeof FLASH_UNSUPPORTED !== 'undefined' ? FLASH_UNSUPPORTED : [];
  missing.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'flasher-ecu flasher-ecu-absent';
    row.innerHTML =
      `<span class="flasher-ecu-name">${esc(u.label)}</span>` +
      `<span class="flasher-ecu-why">${esc(u.reason)}</span>`;
    ecusEl.appendChild(row);
  });

  function pickProfile(p) {
    if (state.running) return;
    state.profile = p;
    state.region = p.regions[p.regions.length - 1]; // default to the full read
    ecusEl
      .querySelectorAll('.flasher-ecu')
      .forEach((b) => b.classList.toggle('active', b.dataset.id === p.id));
    paintRegions();
    identEl.textContent = '';
    stageEl.textContent = `${p.label}: choose what to read, then Read & save.`;
    fillEl.style.width = '0%';
    pctEl.textContent = '';
    startBtn.disabled = false;
  }

  function paintRegions() {
    regionsEl.innerHTML = '';
    const p = state.profile;
    if (!p) return;
    p.regions.forEach((r) => {
      const size = flashRegionSize(r);
      const kb = Math.round(size / 1024);
      const span = r.parts
        .map(
          (q) =>
            `${q.segment} 0x${q.start.toString(16).toUpperCase()}–0x${q.end
              .toString(16)
              .toUpperCase()}`
        )
        .join(' + ');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'flasher-region' + (state.region === r ? ' active' : '');
      row.innerHTML =
        `<span class="flasher-region-name">${esc(r.label)}</span>` +
        `<span class="flasher-region-meta">${esc(span)} · ${kb} KB</span>`;
      row.onclick = () => {
        if (state.running) return;
        state.region = r;
        paintRegions();
      };
      regionsEl.appendChild(row);
    });
  }

  // -- save: an <a download> of the bytes, the same way the tuning editor and
  //    the offline export hand a file to the browser
  function saveBytes(name, bytes) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // -- run -------------------------------------------------------------------
  startBtn.onclick = async () => {
    const p = state.profile;
    const region = state.region;
    if (!p || !region || state.running) return;
    state.running = true;
    state.abort = new AbortController();
    startBtn.disabled = true;
    cancelBtn.hidden = false;
    ecusEl.classList.add('flasher-locked');
    regionsEl.classList.add('flasher-locked');
    logEl.innerHTML = '';
    fillEl.style.width = '0%';
    pctEl.textContent = '';
    log(`${p.label} — ${region.label}`);
    sbLeft.textContent = 'reading ECU…';

    try {
      const result = await flashBackup(p.sgbd, {
        region: region.name,
        abort: state.abort.signal,
        onStage: (t) => {
          stageEl.textContent = t;
          log(t);
        },
        onProgress: (pct) => {
          fillEl.style.width = `${pct}%`;
          pctEl.textContent = `${pct}%`;
        },
      });
      const info = result.info;
      identEl.innerHTML =
        `<span class="flasher-ident-k">Module</span> ${esc(info.type)}` +
        (info.swRef
          ? ` &nbsp;<span class="flasher-ident-k">Software</span> ${esc(info.swRef)}`
          : '') +
        (info.vin
          ? ` &nbsp;<span class="flasher-ident-k">VIN</span> ${esc(info.vin)}`
          : '');
      stageEl.textContent = `Done: ${result.bytes.length.toLocaleString()} bytes read.`;
      log(
        `saved ${result.name} (${result.bytes.length.toLocaleString()} bytes)`
      );
      saveBytes(result.name, result.bytes);
      sbLeft.textContent = 'backup saved';
    } catch (e) {
      const msg = (e && e.message) || String(e);
      stageEl.textContent = `Stopped: ${msg}`;
      log(`ERROR ${msg}`);
      sbLeft.textContent = 'backup failed';
    } finally {
      state.running = false;
      state.abort = null;
      startBtn.disabled = !state.profile;
      cancelBtn.hidden = true;
      ecusEl.classList.remove('flasher-locked');
      regionsEl.classList.remove('flasher-locked');
    }
  };

  cancelBtn.onclick = () => {
    if (state.abort) {
      state.abort.abort();
      log('cancel requested; stopping after the current chunk');
    }
  };
}

if (typeof window !== 'undefined') {
  window.showFlasher = showFlasher;
}
