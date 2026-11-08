/**
 * @file The Fast flasher rail page: what Identify found of the fast flash
 * bootloader and the flasher on the DME, the "Use the fast flasher"
 * setting, and the bootloader's own buttons (screens/flashing/bl-install.js)
 * and EEPROM read (screens/flashing/isn-ews.js), which used to sit in
 * Custom Options.
 */
/* exported fbFastPageHtml, fbFastWire, fbFastAvailable, fbFastShow, fbFastPaint */

function fbFastPageHtml() {
  // One "Use the fast flasher" toggle, then the bootloader section
  // (fbOneClickToolsHtml) and the GS20 relay section. The one-click
  // tools (Read/Write ISN, Read EEPROM) and the fault page live on their
  // own rail tabs, not here.
  return `
      <div class="fb-page" id="fb-page-fast" hidden>
        <div class="fb-section">
          <div class="fb-code">FAST FLASHER</div>
          <label class="fb-check"><input type="checkbox" id="fb-set-fast"> Use the fast flasher</label>
          <div class="fb-faint" id="fb-fast-route"></div>
        </div>
        ${fbOneClickToolsHtml()}
        ${fbRelayAllowed() ? `${fbRelayHtml()}` : ''}
        ${fbBlHtml()}
      </div>`;
}

/**
 * The GS20 relay test is a bench tool: shown only when BMWeb is served from
 * this machine (localhost), never on the hosted site.
 * @returns {boolean}
 */
function fbRelayAllowed() {
  if (typeof location === 'undefined') return false;
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
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
  if (fbDevUi()) return true;
  const d = fbState.dme;
  if (!(d && d.identified && fbDmeIsMs451())) return false;
  // a DME found in its fast flasher answers no KWP, so its program reference
  // is whatever an earlier identify left (nothing after a reload) -- but the
  // flasher is the one thing certainly on it, and this page is how a cut
  // push is finished
  if (d.ident.inFlasher) return true;
  return !!(d.ident.progRef && d.ident.progRef.includes('0044570LO02S'));
}

/** The page shown: everything on it from the current state. */
function fbFastShow() {
  fbFastPaint();
}

/** Repaint the page's own lines and the buttons' gates. */
function fbFastPaint() {
  if (!fbEls['set-fast']) return;
  fbEls['set-fast'].checked = fbFastFlasherWanted();
  const d = fbState.dme;
  fbEls['fast-route'].textContent =
    d && d.identified && fbDmeUseFastFlasher()
      ? 'Now: Read DME, Flash Tune and Flash Program use the fast flasher.'
      : '';
  fbBlRefresh();
  fbIsnEepromRefresh();
  fbOneClickToolsRefresh();
  if (fbRelayAllowed()) fbRelayRefresh();
}
