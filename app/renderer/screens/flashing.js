// MS45 DME flashing: identify, region backup (read only)
const FLASH_SGBD = 'ms450ds0';            // MS45 only
const flashEcu = { sgbd: FLASH_SGBD, label: 'MS45.1 DME', code: 'MS450' };

function showFlashing() {
  lastScreen = showFlashing;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Flashing' }]);
  sbLeft.textContent = 'flashing';
  view.innerHTML = head('DME flashing', 'Flashing',
    'Identify and back up the engine ECU. Writing/flashing is not enabled yet; back up first.');

  const warn = document.createElement('div');
  warn.className = 'act-warning';
  warn.innerHTML = `⚠ DME flashing is high-risk and can render the engine unbootable. This screen currently only <b>reads</b> (safe). Use a fully-charged battery and the wired K+DCAN cable, ignition on. Always keep a full backup.`;
  view.appendChild(warn);

  // identify button + result panel
  const idBar = document.createElement('div');
  idBar.className = 'flash-tools';
  idBar.innerHTML = `<button class="btn primary" id="identify-dme">Identify DME</button>
                     <span class="pill" id="flash-port">cable: …</span>`;
  view.appendChild(idBar);

  const ident = document.createElement('div');
  ident.className = 'results-panel';
  view.appendChild(ident);

  // two backup modes (matching MS45-Flasher): Tune (calibration only) and Full Bin
  // (external flash + MPC internal). disabled until the DME is identified.
  const tools = document.createElement('div');
  tools.className = 'flash-tools';
  tools.innerHTML = `
    <button class="btn primary" data-mode="tune" disabled>Backup Tune <span class="flash-sub">~118 KB · ~1-2 min</span></button>
    <button class="btn" data-mode="full" disabled>Backup Full Bin <span class="flash-sub">flash + MPC · ~15-20 min</span></button>
    <span class="flash-hint" id="backup-hint">Identify the DME first</span>`;
  view.appendChild(tools);

  const out = document.createElement('div');
  out.className = 'results-panel';
  view.appendChild(out);

  api('/api/port').then(p => {
    document.getElementById('flash-port').textContent =
      p.port ? `cable: ${p.port.replace('/dev/', '')}` : 'no cable';
  }).catch(() => {});

  // gate: identify enables the backup buttons + their f-keys
  let identified = false;
  const enableBackups = () => {
    identified = true;
    tools.querySelectorAll('button').forEach(b => b.disabled = false);
    const hint = document.getElementById('backup-hint'); if (hint) hint.remove();
  };
  const doIdentify = async () => { const ok = await identifyDme(ident); if (ok) enableBackups(); };

  document.getElementById('identify-dme').onclick = doIdentify;
  tools.querySelectorAll('button').forEach(b => {
    b.onclick = () => { if (identified) backupMode(flashEcu, b.dataset.mode, out); };
  });

  setActions([
    { key: '1', label: 'Identify DME', kind: 'primary', fn: doIdentify },
    { key: '2', label: 'Backup Tune', fn: () => { if (identified) backupMode(flashEcu, 'tune', out); } },
    { key: '3', label: 'Backup Full Bin', fn: () => { if (identified) backupMode(flashEcu, 'full', out); } },
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showChassis },
  ]);
}

// Tune = calibration region (one file). Full Bin = external flash + MPC internal,
// read in one session so the second read doesn't collide. one .bin per region.
async function backupMode(ecu, mode, out) {
  await backupRegion(ecu, mode === 'tune' ? 'data' : 'fullbin', out);
}

async function identifyDme(ident) {
  ident.className = 'results-panel';
  ident.innerHTML = `<div class="empty"><span class="loader"></span><span>Identifying DME…</span></div>`;
  ident.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  sbLeft.textContent = 'IDENT…';
  try {
    const info = await api(`/api/flash/${FLASH_SGBD}/identify`, { method: 'POST' });
    ident.className = 'live-panel';
    const typeColor = info.supported ? 'var(--green)' : 'var(--red)';
    ident.innerHTML = `
      <div class="live-head">
        <span class="live-dot"></span>
        <span class="live-title">DME identity</span>
        <span class="dme-type" style="border-color:${typeColor};color:${typeColor}">${info.dmeType || 'Unknown'}</span>
      </div>
      <div class="dme-grid">
        <div class="live-cell"><div class="live-k">VIN</div><div class="live-v">${info.vin || '-'}</div></div>
        <div class="live-cell"><div class="live-k">HW ref</div><div class="live-v">${info.hwRef || '-'}</div></div>
        <div class="live-cell"><div class="live-k">SW ref</div><div class="live-v" style="font-size:14px">${info.swRef || '-'}</div></div>
        <div class="live-cell"><div class="live-k">Prog status</div><div class="live-v" style="font-size:13px">${info.programmingStatus || '-'}</div></div>
        <div class="live-cell"><div class="live-k">Protocol</div><div class="live-v" style="font-size:13px">${info.diagProtocol || '-'}</div></div>
      </div>`;
    sbLeft.textContent = `identified: ${info.dmeType}`;
    // only back up a recognized, supported DME
    if (!info.supported) {
      ident.insertAdjacentHTML('beforeend',
        `<div style="padding:10px 16px;color:var(--red);font-size:12px">⚠ Unsupported/unrecognized DME, backups disabled.</div>`);
      return false;
    }
    return true;
  } catch (e) {
    ident.className = 'results-panel';
    ident.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'identify failed';
    return false;
  }
}

// stream a backup (one or two regions, single session). server emits
// region/progress/done SSE events; panel per region, save each file.
async function backupRegion(ecu, region, out) {
  const REGION_TITLE = { data: 'Tune (calibration)', full: 'External flash (1 MB)', mpc: 'MPC internal (448 KB)' };
  out.className = 'live-panel';
  out.innerHTML = '';
  out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const stamp = (kind) => `MS45_${kind}_${ts}.bin`;

  let curName = null, fill = null, pctEl = null;
  let saved = 0;
  function newPanel(name) {
    curName = name;
    const block = document.createElement('div');
    block.className = 'flash-job';
    block.innerHTML = `
      <div class="live-head"><span class="live-dot"></span>
        <span class="live-title">Reading ${REGION_TITLE[name] || name}</span>
        <span class="live-meta job-pct">0%</span></div>
      <div style="padding:14px 16px"><div class="flash-bar"><div class="flash-bar-fill job-fill"></div></div></div>`;
    out.appendChild(block);
    fill = block.querySelector('.job-fill');
    pctEl = block.querySelector('.job-pct');
  }

  flashing = true; // pause the status poll so it doesn't queue behind the flash
  try {
    const res = await fetch(`${API}/api/flash/${ecu.sgbd}/read/${region}`, { method: 'POST' });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', err = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const blk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = (blk.match(/event: (.*)/) || [])[1];
        const data = (blk.match(/data: ([\s\S]*)/) || [])[1];
        if (ev === 'region') { newPanel(data); sbLeft.textContent = `reading ${data}…`; }
        else if (ev === 'progress' && fill) { fill.style.width = data + '%'; pctEl.textContent = data + '%'; }
        else if (ev === 'error') err = data;
        else if (ev === 'done') {
          // data = "<region>|<base64>"
          const sep = data.indexOf('|');
          const name = data.slice(0, sep), b64 = data.slice(sep + 1);
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: 'application/octet-stream' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = stamp(name); a.click();
          if (fill) { fill.style.width = '100%'; pctEl.textContent = `100% · saved (${(bytes.length/1024).toFixed(0)} KB)`; }
          saved++;
        }
      }
    }
    if (err) throw new Error(err);
    if (saved === 0) throw new Error('no data received');
    sbLeft.textContent = `backup complete (${saved} file${saved === 1 ? '' : 's'})`;
  } catch (e) {
    out.insertAdjacentHTML('beforeend', errorBlock(e.message));
    sbLeft.textContent = 'backup failed';
  } finally {
    flashing = false;
  }
}

// sub-screen: one section's functions for an ECU
