// MS45 DME flashing -- retired with the C# engine.
//
// This screen used to identify the DME and stream flash-region backups
// through /api/flash/* endpoints served by the C# sidecar. That engine is
// gone: the app runs on the in-renderer BEST2 VM now, and the VM does not
// yet speak the raw memory-read protocol a flash backup needs. The old
// buttons all called endpoints that no longer exist, so every press ended
// in a 404 dressed up as a cable error.
//
// The screen stays -- the toolbar button and the tutorial both point here,
// and navigation must not break -- but it now says what is true instead of
// failing. The identify/backup implementation is in git history for when
// the VM grows the read-memory primitives.

function showFlashing() {
  lastScreen = showFlashing;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Flashing' }]);
  sbLeft.textContent = 'flashing';
  view.innerHTML = head('DME flashing', 'Flashing',
    'Identify and back up the engine ECU.');

  const warn = document.createElement('div');
  warn.className = 'act-warning';
  warn.innerHTML = `⚠ <b>Flashing is not available in this build.</b> `
    + `DME identification and flash backup ran on the retired C# engine, `
    + `which this version no longer ships. Nothing here can read or write `
    + `an ECU's flash.`;
  view.appendChild(warn);

  const info = document.createElement('div');
  info.className = 'results-panel';
  info.innerHTML = `<div class="empty"><div>
      <div><strong>Why it went away</strong></div>
      <div>The app now runs BMW's own SGBD bytecode in a BEST2 virtual
           machine, in the browser. Diagnostics, coding and activations all
           work that way -- but backing up a DME means raw memory reads the
           VM does not implement yet, and a button that pretends otherwise
           only fails against a real car.</div>
      <div style="margin-top:10px"><strong>Backing up an MS45 today</strong></div>
      <div>Use a dedicated flasher (MS45-Flasher or similar) with a wired
           K+DCAN cable, a fully charged battery and the ignition on. Keep
           the full-bin backup somewhere safe before any tune touches the
           ECU.</div>
      <div style="margin-top:10px;color:var(--ink-faint);font-size:12px">
           If the VM gains flash support, this screen comes back as it was:
           identify first, then read-only backups.</div>
    </div></div>`;
  view.appendChild(info);

  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showChassis },
  ]);
}
