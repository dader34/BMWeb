/**
 * @file The Fast flasher rail page: what Identify found of the fast flash
 * bootloader and the flasher on the DME, the "Use the fast flasher"
 * setting, and the bootloader's own buttons (screens/flashing/bl-install.js)
 * and EEPROM read (screens/flashing/isn-ews.js), which used to sit in
 * Custom Options.
 */
/* exported fbFastPageHtml, fbFastWire, fbFastAvailable, fbFastShow, fbFastPaint */

function fbFastPageHtml() {
  // Removed per user request:
  //   - the "ON THIS DME" status panel (installed-ring / installed-body
  //     presence summary) -- redundant now that the one-click handles
  //     everything ring-free
  //   - the long "When the DME has a ready fast flasher..." explanation
  //     under the Use-the-fast-flasher checkbox -- the behaviour is now
  //     the default and the explanation is noise
  //   - the FAST FLASH BOOTLOADER section (install / repair / restore /
  //     update boot sector) -- fbBlHtml() now returns '' (see bl-install.js)
  // The checkbox itself stays so the user can still turn fast-flash off.
  // The one-click tools section and EEPROM section stay as-is.
  return `
      <div class="fb-page" id="fb-page-fast" hidden>
        <div class="fb-section">
          <div class="fb-code">FAST FLASHER</div>
          <label class="fb-check"><input type="checkbox" id="fb-set-fast"> Use the fast flasher</label>
          <div class="fb-faint" id="fb-fast-route"></div>
        </div>
        ${fbOneClickToolsHtml()}
        ${fbBlHtml()}
      </div>`;
  // The EEPROM section (fbIsnEepromHtml inside fb-opt-eeprom-section) was
  // removed from this page per user request: the EEPROM read button lives
  // on the EWS/ISN rail page's ONE-CLICK TOOLS row ("Read EEPROM to file",
  // id fb-isnp-dump) now and doesn't need a second home here.
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
  return !!(
    d &&
    d.identified &&
    fbDmeIsMs451() &&
    d.ident.progRef &&
    d.ident.progRef.includes('0044570LO02S')
  );
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
}
