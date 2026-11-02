/**
 * @file The Fast flasher rail page: what Identify found of the fast flash
 * bootloader and the flasher on the DME, the "Use the fast flasher"
 * setting, and the bootloader's own buttons (screens/flashing/bl-install.js)
 * and EEPROM read (screens/flashing/isn-ews.js), which used to sit in
 * Custom Options.
 */
/* exported fbFastPageHtml, fbFastWire, fbFastAvailable, fbFastShow, fbFastPaint */

function fbFastPageHtml() {
  return `
      <div class="fb-page" id="fb-page-fast" hidden>
        <div class="fb-section">
          <div class="fb-code">ON THIS DME</div>
          <div class="fb-mono fb-report" id="fb-fast-state"></div>
        </div>
        <div class="fb-section">
          <div class="fb-code">FAST FLASHER</div>
          <label class="fb-check"><input type="checkbox" id="fb-set-fast"> Use the fast flasher</label>
          <div class="fb-dim">When the DME has a ready fast flasher, Read DME, Flash Tune and Flash Program on the flashing page go through it (compressed, only what differs); otherwise, and with this off, they use the DME's stock flashing loader. A fast flash writes no programming record (AIF).</div>
          <div class="fb-faint" id="fb-fast-route"></div>
        </div>
        <div class="fb-section">
          ${fbBlHtml()}
        </div>
        <div class="fb-section" id="fb-opt-eeprom-section" hidden>
          ${fbIsnEepromHtml()}
        </div>
      </div>`;
}

function fbFastWire() {
  fbEls['set-fast'].checked = fbFastFlasherWanted();
  fbEls['set-fast'].onchange = () => {
    Settings.set('flashUseFastFlasher', fbEls['set-fast'].checked);
    fbRefreshAll();
  };
}

/** Whether the rail offers the page: a DME chosen (or the dev UI on). */
function fbFastAvailable() {
  return fbDevUi() || fbState.module === 'dme';
}

/** The page shown: everything on it from the current state. */
function fbFastShow() {
  fbFastPaint();
}

/** What Identify found, in a few lines. */
function fbFastStateText() {
  const d = fbState.dme;
  if (!d || !d.identified) return 'Identify the DME to see what is on it.';
  const id = d.ident || {};
  const lines = [
    `DME ${id.hwRef || '?'}${id.progRef ? `, program ${id.progRef}` : ''}`,
  ];
  const have = d.bootLoader;
  if (!have) lines.push('Bootloader: stock (no fast flash bootloader found)');
  else {
    const broken = have.health && have.health.broken;
    lines.push(
      `Bootloader: ${bl.isCurrent(have) ? 'up to date' : 'old, an update is offered'}${broken ? `, needs a fix: ${have.health.problems[0]}` : ''}`
    );
  }
  lines.push(
    d.fastFlasher
      ? fastFlasher.describe(d.fastFlasher)
      : 'Program: no fast flasher or installer in it'
  );
  return lines.join('\n');
}

/** Repaint the page's own lines and the buttons' gates. */
function fbFastPaint() {
  if (!fbEls['fast-state']) return;
  fbEls['fast-state'].textContent = fbFastStateText();
  fbEls['set-fast'].checked = fbFastFlasherWanted();
  const d = fbState.dme;
  fbEls['fast-route'].textContent = !(d && d.identified)
    ? ''
    : fbDmeUseFastFlasher()
      ? 'Now: Read DME, Flash Tune and Flash Program use the fast flasher.'
      : fbFastFlasherWanted()
        ? 'Now: no ready fast flasher on this DME, so they use the stock loader.'
        : 'Now: switched off, so they use the stock loader.';
  fbBlRefresh();
  fbIsnEepromRefresh();
}
