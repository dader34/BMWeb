/**
 * @file BMWeb Scanner: the reference scanner's "Unit info" windows, opened
 * by a double-click on a unit's name. Each unit kind has its own form in
 * BMW Scanner 1.4.0.7 (chosen at 0x6CD5E8); they share the identification
 * block (PanelUnit .. PanelOdometer) and differ in their buttons.
 *
 * What is wired so far: the identification panels from the scan, the
 * Errors panels and the Errors button (the Errors window), OK, and the body
 * module's Read / Write EEPROM with the hex editor. The other buttons are
 * drawn as the reference draws them and stay disabled until their own
 * functions are built (SCANNER_UNIT_ACTIONS).
 */

/* exported SCANNER_UNIT_FORM, SCANNER_UNIT_ACTIONS, scannerUnitFormFor, scannerUnitFields, scannerUnitInfo */

/** The form each unit opens (the rest: TForm3). */
const SCANNER_UNIT_FORM = {
  IKE: 'TForm4',
  EWS: 'TForm5',
  LCM: 'TForm6',
  DME: 'TForm8',
  DME2: 'TForm8',
  EGS: 'TForm8',
  LEW: 'TForm9',
  SRS: 'TForm10',
  ZKE: 'TForm11',
  TEL: 'TForm12',
  VID: 'TForm13',
};

/**
 * @param {ScannerModule} m
 * @returns {string} The form class.
 */
const scannerUnitFormFor = (m) => SCANNER_UNIT_FORM[m.name] || 'TForm3';

/** The body module's algorithm per variant (the reference's 0x5E0BF8). */
const SCANNER_ZKE_ALGORITHM = [
  '-',
  'BC1',
  'BC1RD',
  'ZKE3 GM1',
  'ZKE3 GM4',
  'ZKE3 GM5',
  'ZKE3 GM6',
  'ZKE4',
  'ZKE5',
  'ZKE5 S12',
];

/**
 * What each form's buttons do, by the reference's own component names (the
 * same caption sits on different buttons from form to form, and one form
 * spells it "Error ..."). A button not listed is drawn and stays disabled
 * until its function is built; tools/verify/test_scanner_unit.js holds every
 * name here to a real button with the caption the action expects.
 * @type {Object<string, Object<string, 'ok'|'errors'|'readEeprom'|'writeEeprom'>>}
 */
const SCANNER_UNIT_ACTIONS = {
  TForm3: {
    Button1: 'ok',
    Button7: 'errors',
    Button9: 'readEeprom',
    Button10: 'writeEeprom',
  },
  TForm4: {
    Button1: 'ok',
    Button10: 'errors',
    Button2: 'readEeprom',
    Button3: 'writeEeprom',
  },
  TForm5: { Button1: 'ok', Button7: 'errors' },
  TForm6: {
    Button1: 'ok',
    Button7: 'errors',
    Button2: 'readEeprom',
    Button3: 'writeEeprom',
  },
  TForm8: {
    Button1: 'ok',
    Button7: 'errors',
    Button2: 'readEeprom',
    Button3: 'writeEeprom',
  },
  TForm9: {
    Button1: 'ok',
    Button10: 'errors',
    Button2: 'readEeprom',
    Button3: 'writeEeprom',
  },
  TForm10: {
    Button1: 'ok',
    Button10: 'errors',
    Button2: 'readEeprom',
    Button3: 'writeEeprom',
  },
  TForm11: {
    Button1: 'ok',
    Button10: 'errors',
    Button2: 'readEeprom',
    Button3: 'writeEeprom',
  },
  TForm12: { Button1: 'ok', Button7: 'errors' },
  TForm13: {
    Button1: 'ok',
    Button7: 'errors',
    Button2: 'readEeprom',
    Button9: 'writeEeprom',
  },
};

/**
 * The identification panels' texts from a scan result.
 * @param {ScannerModule} m
 * @param {{id: ScannerIdent|null, errors: number|null, shadow?: number|null,
 *   after?: number|null}|undefined} r
 * @returns {Object<string, string>} Panel name -> caption.
 */
function scannerUnitFields(m, r) {
  const count = (n) =>
    n == null
      ? ''
      : n === 0
        ? 'no errors'
        : n === 1
          ? '1 error'
          : `${n} errors`;
  const out = { PanelUnit: m.name };
  if (!r || !r.id) return out;
  const id = r.id;
  Object.assign(out, {
    PanelBMWTNR: id.part || '',
    PanelHW: id.hw || '',
    PanelSW: id.sw || '',
    PanelCI: id.ci || '',
    PanelDI: id.di || '',
    PanelBIVI: id.bi || '',
    PanelDate: id.date || '',
    PanelErrors1: count(r.errors),
    PanelErrors2: r.after !== undefined ? count(r.after) : '',
  });
  // the body module has no chassis number: the reference's window
  // (0x5DD08C) puts "-" in FGSTNR; its timer names the algorithm after the
  // variant (0x5E0BF8)
  if (m.name === 'ZKE') {
    out.PanelFGSTNR = '-';
    out.PanelAlgo = SCANNER_ZKE_ALGORITHM[scannerZkeVariant(r.raw)] || '-';
  }
  return out;
}

/**
 * Open a unit's Unit info window.
 * @param {HTMLElement} win - The scanner window.
 * @param {ScannerModule} m
 * @param {object|undefined} r - Its scan result.
 * @param {{errors: (where: HTMLElement) => Promise<void>,
 *   link: () => ScannerEepromLink|null}} ops - The Errors window, opened in
 *   `where`; the link to the car (null without a cable).
 * @returns {Promise<void>}
 */
function scannerUnitInfo(win, m, r, ops) {
  const cls = scannerUnitFormFor(m);
  return scannerOpenForm(win, cls, (ctl, close, layer) => {
    for (const [name, text] of Object.entries(scannerUnitFields(m, r))) {
      const el = ctl[name] && ctl[name].querySelector('.vcl-caption');
      if (el) el.textContent = text;
    }
    // the logo panel and the hex editor's status panel start empty
    for (const name of ['PanelLogo', 'Panel7']) {
      const el = ctl[name] && ctl[name].querySelector('.vcl-caption');
      if (el) el.textContent = '';
    }
    const errors = () => {
      if (r && r.id) ops.errors(layer);
    };
    for (const name of ['PanelErrors1', 'PanelErrors2'])
      if (ctl[name]) ctl[name].ondblclick = errors;
    const tools = scannerUnitTools(ctl, m, r, layer, ops);
    const actions = SCANNER_UNIT_ACTIONS[cls] || {};
    const has = !!SCANNER_EEPROM[m.name] && !!(r && r.id);
    for (const [name, el] of Object.entries(ctl)) {
      // the form's own buttons; the hex editor's are the tools' (GroupBox2)
      if (el.tagName !== 'BUTTON' || /^SpeedButton/.test(name)) continue;
      const action = actions[name];
      if (action === 'ok') el.onclick = close;
      else if (action === 'errors') {
        el.disabled = !(r && r.id);
        el.onclick = errors;
      } else if (action === 'readEeprom' || action === 'writeEeprom') {
        el.disabled = !has;
        if (!SCANNER_EEPROM[m.name])
          el.title = 'Not in BMWeb yet for this unit';
        el.onclick = action === 'readEeprom' ? tools.read : tools.write;
      } else {
        el.disabled = true;
        el.title = 'Not in BMWeb yet';
      }
    }
    return { canClose: tools.canClose, cancel: tools.cancel };
  });
}

/**
 * Read / Write EEPROM and the Internal HEX-Editor of a Unit info window.
 * A read or write in hand keeps the window open: closing it asks the work
 * to stop, and the window says where it stopped before it can be closed.
 * @param {Object<string, HTMLElement>} ctl
 * @param {ScannerModule} m
 * @param {object|undefined} r - Its scan result.
 * @param {HTMLElement} layer - Where its own message boxes go.
 * @param {{link: () => ScannerEepromLink|null}} ops
 * @returns {{read: () => void, write: () => void, canClose: () => boolean,
 *   cancel: () => void}}
 */
function scannerUnitTools(ctl, m, r, layer, ops) {
  const status = (t) => {
    const c = ctl.Panel7 && ctl.Panel7.querySelector('.vcl-caption');
    if (c) c.textContent = t;
  };
  status('');
  const say = (kind, text, buttons = ['OK']) =>
    wkfpMessage(layer, kind, text, buttons, 'Unit info');
  const hex = scannerHexEditor(ctl.HexEditor1 || ctl.PanelEditor, status);
  const showEditor = () => {
    if (ctl.PanelEditor) ctl.PanelEditor.hidden = false;
    if (ctl.PanelLogo) ctl.PanelLogo.hidden = true;
    for (const n of ['SpeedButton1', 'SpeedButton2', 'SpeedButton4'])
      if (ctl[n]) ctl[n].disabled = false;
  };
  const at = (plan, offset) =>
    '0x' + (plan.base + offset).toString(16).toUpperCase();

  // one piece of work at a time; `stop` asks it to end at its next step
  let busy = null; // 'read' | 'write' | null
  let stop = false;
  let quiet = false; // the app is leaving: no message boxes
  const stopped = () => stop;
  const all = Object.values(ctl).filter((e) => e.tagName === 'BUTTON');
  const run = async (what, fn) => {
    if (busy) return;
    busy = what;
    stop = false;
    const was = all.map((b) => b.disabled);
    all.forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      if (!quiet) await say('error', String((e && e.message) || e));
    } finally {
      all.forEach((b, i) => (b.disabled = was[i]));
      busy = null;
    }
  };
  const link = () => {
    const l = ops.link();
    if (!l)
      throw new Error(
        'No cable is connected. Connect it in the top bar first.'
      );
    return l;
  };
  // the range and commands follow the variant the reference gives the unit
  // from its identification answer (scannerZkeVariant)
  let plan = null;
  const thePlan = () => plan || (plan = scannerEepromPlan(m, null, r && r.raw));
  const progress = (what) => (done, size) =>
    status(`${what} ${Math.min(100, Math.round((done / size) * 100))}%`);
  /** Edits not written or saved are only lost when the user says so. */
  const mayReplace = async () =>
    !hex.dirty() ||
    (await say(
      'question',
      'The editor has changes that are neither written nor saved. Discard them?',
      ['Discard', 'Cancel']
    )) === 'Discard';

  const read = () =>
    run('read', async () => {
      if (!(await mayReplace())) return;
      const l = link();
      const p = thePlan();
      try {
        const data = await scannerEepromRead(
          l,
          m,
          p,
          progress('Reading'),
          stopped
        );
        showEditor();
        hex.set(data, p.base, `${m.name}_eep.bin`);
      } catch (e) {
        if (!e || !e.stopped) throw e;
        status('Read stopped');
      }
    });

  const write = () =>
    run('write', async () => {
      const data = hex.get();
      if (!data) {
        await say(
          'info',
          'Read the EEPROM or load a file into the editor first.'
        );
        return;
      }
      const l = link();
      const p = thePlan();
      if (data.length !== p.size) {
        await say(
          'error',
          `The editor holds ${data.length} bytes; the ${m.name} EEPROM is ${p.size} bytes (${at(p, 0)}).`
        );
        return;
      }
      const ok = await say(
        'warn',
        `Write all ${p.size} bytes from the editor into the ${m.name} EEPROM at ${at(p, 0)}?\n\nKeep the ignition on and this window open until it is done.`,
        ['Write', 'Cancel']
      );
      if (ok !== 'Write') return;
      let out;
      try {
        out = await scannerEepromWrite(
          l,
          m,
          p,
          data,
          progress('Writing'),
          stopped
        );
      } catch (e) {
        if (!e || !e.stopped) throw e;
        status(`Write stopped at ${at(p, e.at)}`);
        if (!quiet)
          await say(
            'warn',
            `The write was stopped at ${at(p, e.at)}. Everything before it is written; from there on the unit still holds its old bytes. Write again to finish, or read the EEPROM to see what it holds now.`
          );
        return;
      }
      hex.set(out.back, p.base, `${m.name}_eep.bin`);
      status('Written');
      await say(
        out.differ.length ? 'warn' : 'info',
        out.differ.length
          ? `Written, but ${out.differ.length} byte(s) read back different (first at ${at(p, out.differ[0])}). The editor now shows what the unit holds.`
          : 'EEPROM written and read back identical.'
      );
    });

  // the editor's own buttons: load, save, find, find next
  let last = '';
  const ask = async () => {
    const box = document.createElement('div');
    box.innerHTML =
      '<label>Find (hex bytes or text): <input type="text" class="scn-hex-q"></label>';
    const input = box.querySelector('input');
    input.value = last;
    const b = await wkfpDialog(layer, {
      title: 'Find',
      body: box,
      buttons: ['OK', 'Cancel'],
    });
    return b === 'OK' ? input.value : null;
  };
  const find = async (next) => {
    const q = next && last ? last : await ask();
    if (!q) return;
    last = q;
    if (!hex.find(q, next)) await say('info', `"${q}" not found.`);
  };
  if (ctl.SpeedButton1) ctl.SpeedButton1.onclick = () => find(false);
  if (ctl.SpeedButton2) ctl.SpeedButton2.onclick = () => find(true);
  if (ctl.SpeedButton3)
    ctl.SpeedButton3.onclick = async () => {
      if (busy || !(await mayReplace())) return;
      const f = document.createElement('input');
      f.type = 'file';
      f.onchange = async () => {
        const file = f.files && f.files[0];
        if (!file) return;
        const data = new Uint8Array(await file.arrayBuffer());
        showEditor();
        hex.set(data, plan ? plan.base : 0, file.name);
      };
      f.click();
    };
  if (ctl.SpeedButton4)
    ctl.SpeedButton4.onclick = () => {
      const data = hex.get();
      if (!data) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data]));
      a.download = hex.name() || `${m.name}_eep.bin`;
      a.click();
      hex.saved();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

  return {
    read,
    write,
    // closing with work in hand asks it to stop; the window stays until the
    // work has said where it stopped
    canClose: () => {
      if (!busy) return true;
      stop = true;
      status(busy === 'write' ? 'Stopping the write…' : 'Stopping…');
      return false;
    },
    // the app is leaving the screen: stop, and say nothing over the next one
    cancel: () => {
      stop = true;
      quiet = true;
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCANNER_UNIT_FORM,
    SCANNER_UNIT_ACTIONS,
    scannerUnitFormFor,
    scannerUnitFields,
  };
}
