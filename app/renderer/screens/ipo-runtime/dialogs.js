/**
 * @file The app's dialogs for INPA's own: the togglelist component picker,
 * the Select line picker, and the parked state machine's Continue/Stop
 * control. (The input prompts are irAskInput in screens/ir.js.)
 */

/** A picker with more rows than this scrolls and says so. */
const IPO_PICK_LONG = 12;

/**
 * INPA's togglelist lists the ACTIVE screen's LINE declarations: the name is
 * the LINE's label, the argument its key string (SHD46's s_steuern_digital:
 * "Switch Sunroof Open" / SSHDA ...). With MultipleSelectFlag set (LSZ's
 * in/output selection) it is a tick list and the script gets every picked
 * key, ";"-joined, as one argument; with ArgNumFlag set it gets the lines'
 * numbers instead of their keys.
 * @param {IpoProgram} p - the program (its exec and current screen)
 * @param {IpoStep} step - the toggle suspension
 * @returns {Promise<IpoPick|null>} {ort, ein}, or null when cancelled
 */
async function ipoPickComponent(p, step) {
  const multiple = !!(step && step.multiple);
  const argnum = !!(step && step.argnum);
  const rows = ipoScreenComponents(p.exec, p.screen).map((l, i) => ({
    key: argnum ? String(i + 1) : String(l.keys).split(';')[0],
    caption: ipoText(l.label || String(l.keys).split(';')[0]),
  }));
  if (!rows.length) {
    await messageDialog({
      title: 'No components to pick',
      body: 'This screen lists no components for the picker.',
    });
    return null;
  }
  return new Promise((resolveRaw) => {
    // closing the modal fires onClose, which used to resolve null BEFORE
    // the pick resolved: every pick read as cancelled
    let settled = false;
    const resolve = (v) => {
      if (settled) return;
      settled = true;
      resolveRaw(v);
    };
    const type = multiple ? 'checkbox' : 'radio';
    const actions = multiple
      ? `<button class="btn" data-x="cancel">Cancel</button>
             <button class="btn primary" data-x="ok">Select</button>`
      : `<button class="btn" data-x="cancel">Cancel</button>
             <button class="btn" data-x="off">Off</button>
             <button class="btn primary" data-x="on">On</button>`;
    const long = rows.length > IPO_PICK_LONG;
    const { overlay, close } = openModal(
      `<div class="modal" role="dialog" aria-modal="true">
            <div class="modal-title">${multiple ? 'Select components' : 'Select component'}</div>
            <div class="modal-body ipo-pick${long ? ' ipo-pick-long' : ''}">${rows
              .map(
                (r, i) =>
                  `<label class="ipo-pick-row"><input type="${type}" name="ipo-pick" value="${i}"${!multiple && i === 0 ? ' checked' : ''}/> ` +
                  `<span>${esc(r.caption)}</span> <span class="mono ipo-pick-key">${esc(r.key)}</span></label>`
              )
              .join('')}</div>
            ${
              long
                ? `<div class="ipo-pick-hint">${rows.length} components · scroll the list for more</div>`
                : ''
            }
            <div class="modal-actions">${actions}</div></div>`,
      { onClose: () => resolve(null) }
    );
    overlay.querySelectorAll('[data-x]').forEach((b) => {
      b.onclick = () => {
        const x = b.dataset.x;
        const picked = [
          ...overlay.querySelectorAll('input[name="ipo-pick"]:checked'),
        ].map((el) => rows[Number(el.value)]);
        if (x === 'cancel' || !picked.length) resolve(null);
        else if (multiple)
          resolve({ ort: picked.map((r) => r.key).join(';'), ein: 0 });
        else resolve({ ort: picked[0].key, ein: x === 'on' ? 0 : 1 });
        close();
      };
    });
  });
}

/**
 * INPA's Select: tick the logical lines to keep on screen.
 * @param {string[]} names - the screen's named logical lines
 * @param {boolean} multiple - a tick list rather than one choice
 * @param {Set<string>|null} current - the lines currently kept
 * @returns {Promise<string[]|null>} the names to keep ([] = show all), or
 *   null when cancelled
 */
function ipoPickLines(names, multiple, current) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(
      `<div class="modal" role="dialog" aria-modal="true">
            <div class="modal-title">Select lines</div>
            <div class="modal-body ipo-pick">${names
              .map(
                (n, i) =>
                  `<label class="ipo-pick-row"><input type="${multiple ? 'checkbox' : 'radio'}" name="ipo-lines" value="${i}"${
                    current ? (current.has(n) ? ' checked' : '') : ''
                  }/> <span>${esc(ipoText(n))}</span></label>`
              )
              .join('')}</div>
            <div class="modal-actions">
              <button class="btn" data-x="cancel">Cancel</button>
              <button class="btn" data-x="all">Show all</button>
              <button class="btn primary" data-x="ok">Show selected</button>
            </div></div>`,
      { onClose: () => resolve(null) }
    );
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      close();
    };
    overlay.querySelectorAll('[data-x]').forEach((b) => {
      b.onclick = () => {
        const x = b.dataset.x;
        if (x === 'cancel') return done(null);
        if (x === 'all') return done([]);
        const picked = [
          ...overlay.querySelectorAll('input[name="ipo-lines"]:checked'),
        ].map((el) => names[Number(el.value)]);
        done(picked);
      };
    });
  });
}

/**
 * A %STATE park: show the state's name with a Continue key when the parked
 * segment tests a keypress flag, and a Stop key; tick on after
 * IPO_TICK_MS on both the page clock and the worker clock (a hidden tab's
 * setTimeout is throttled).
 * @param {HTMLElement|null} machineEl - the machine strip (none: tick at once)
 * @param {IpoStep} step - the yield suspension
 * @param {Set<number>} guards - the keypress flags the segment tests
 * @returns {Promise<'tick'|'press'|'stop'>}
 */
function ipoMachineTick(machineEl, step, guards) {
  return new Promise((resolve) => {
    if (!machineEl) return resolve('tick');
    machineEl.hidden = false;
    const name = String(step.name || '').replace(/^%/, '');
    machineEl.innerHTML =
      `<span class="ipo-machine-state">${esc(name)}</span>` +
      (guards && guards.size
        ? ` <button class="btn primary ipo-continue">Continue</button>`
        : '') +
      ` <button class="btn ipo-stop">Stop</button>`;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      // the park is over either way; the next park draws its own control
      machineEl.hidden = true;
      resolve(v);
    };
    const t = setTimeout(() => done('tick'), IPO_TICK_MS);
    if (typeof bmwSleep === 'function')
      bmwSleep(IPO_TICK_MS).then(() => done('tick'));
    const c = machineEl.querySelector('.ipo-continue');
    if (c) c.onclick = () => done('press');
    machineEl.querySelector('.ipo-stop').onclick = () => {
      machineEl.hidden = true;
      done('stop');
    };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ipoPickComponent, ipoPickLines, ipoMachineTick };
}
