/**
 * @file The Fast flasher rail page: what Identify found of the fast flash
 * bootloader and the flasher on the DME, the "Use the fast flasher"
 * setting, the full backup, Restore stock bootloader (dme-oneclick.js) and,
 * on a bench, the GS20 relay test.
 */
/* exported fbFastPageHtml, fbFastWire, fbFastAvailable, fbFastShow, fbFastPaint */

function fbFastPageHtml() {
  // One "Use the fast flasher" toggle, then the full backup, the bootloader
  // section (fbOneClickToolsHtml) and the GS20 relay section. The ISN and
  // EEPROM tools and the fault page live on their own rail tabs, not here.
  return `
      <div class="fb-page" id="fb-page-fast" hidden>
        <div class="fb-section">
          <div class="fb-code">FAST FLASHER</div>
          <label class="fb-check"><input type="checkbox" id="fb-set-fast"> Use the fast flasher</label>
          <div class="fb-faint" id="fb-fast-route"></div>
        </div>
        ${fbBackupHtml()}
        ${fbOneClickToolsHtml()}
        ${fbRelayAllowed() ? `${fbRelayHtml()}` : ''}
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
  if (!(d && d.identified && fbDmeIsMs45())) return false;
  // a DME found in its fast flasher answers no KWP, so its program reference
  // is whatever an earlier identify left (nothing after a reload) -- but the
  // flasher is the one thing certainly on it, and this page is how a cut
  // push is finished
  if (d.ident.inFlasher) return true;
  // any identified MS45.1 (2026-11-09, the user's call): the page used to
  // need the program reference 0044570LO02S, which a DME waiting in its
  // loader ("program missing") does not report -- the very DME a flash is
  // for. The one-click from the loader state is untested
  return true;
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
  fbBackupRefresh();
  fbOneClickToolsRefresh();
  if (fbRelayAllowed()) fbRelayRefresh();
}
