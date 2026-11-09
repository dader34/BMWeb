/**
 * @file BMWeb Scanner: the reference scanner's "Unit info" windows, opened
 * by a double-click on a unit's name. Each unit kind has its own form in
 * BMW Scanner 1.4.0.7 (chosen at 0x6CD5E8); they share the identification
 * block (PanelUnit .. PanelOdometer) and differ in their buttons.
 *
 * What is wired so far: the identification panels from the scan, the
 * Errors panels and the Errors button (the Errors window), OK. The other
 * buttons are drawn as the reference draws them and stay disabled until
 * their own functions are built.
 */

/* exported SCANNER_UNIT_FORM, scannerUnitFormFor, scannerUnitFields, scannerUnitInfo */

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

/** Captions of the buttons that are wired. */
const SCANNER_UNIT_WIRED = new Set([
  'OK',
  'Errors ...',
  'Error ...',
  'Read EEPROM',
  'Write EEPROM',
]);

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
  return scannerOpenForm(win, scannerUnitFormFor(m), (ctl, close, layer) => {
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
    scannerUnitTools(ctl, m, r, layer, ops);
    for (const el of Object.values(ctl)) {
      if (
        el.tagName !== 'BUTTON' ||
        el.closest('.vcl-groupbox:not([data-name="GroupBox1"])')
      )
        continue;
      const cap = el.textContent;
      if (cap === 'OK') el.onclick = close;
      else if (cap === 'Errors ...' || cap === 'Error ...') {
        el.disabled = !(r && r.id);
        el.onclick = errors;
      } else if (!SCANNER_UNIT_WIRED.has(cap)) {
        el.disabled = true;
        el.title = 'Not in BMWeb yet';
      }
    }
  });
}

/**
 * Read / Write EEPROM and the Internal HEX-Editor of a Unit info window.
 * @param {Object<string, HTMLElement>} ctl
 * @param {ScannerModule} m
 * @param {object|undefined} r - Its scan result.
 * @param {HTMLElement} layer - Where its own message boxes go.
 * @param {{link: () => ScannerEepromLink|null}} ops
 */
function scannerUnitTools(ctl, m, r, layer, ops) {
  const status = (t) => {
    const c = ctl.Panel7 && ctl.Panel7.querySelector('.vcl-caption');
    if (c) c.textContent = t;
  };
  status('');
  const button = (cap) =>
    Object.values(ctl).find(
      (e) => e.tagName === 'BUTTON' && e.textContent === cap
    );
  const say = (kind, text, buttons = ['OK']) =>
    wkfpMessage(layer, kind, text, buttons, 'Unit info');
  const hex = scannerHexEditor(ctl.HexEditor1 || ctl.PanelEditor, status);
  const showEditor = () => {
    if (ctl.PanelEditor) ctl.PanelEditor.hidden = false;
    if (ctl.PanelLogo) ctl.PanelLogo.hidden = true;
    for (const n of ['SpeedButton1', 'SpeedButton2', 'SpeedButton4'])
      if (ctl[n]) ctl[n].disabled = false;
  };
  let busy = false;
  const all = Object.values(ctl).filter((e) => e.tagName === 'BUTTON');
  const run = async (fn) => {
    if (busy) return;
    busy = true;
    const was = all.map((b) => b.disabled);
    all.forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      await say('error', String((e && e.message) || e));
    } finally {
      all.forEach((b, i) => (b.disabled = was[i]));
      busy = false;
    }
  };
  const has = !!SCANNER_EEPROM[m.name];
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
  const findPlan = async () => {
    if (!plan) plan = scannerEepromPlan(m, null, r && r.raw);
    return plan;
  };
  const progress = (what) => (done, size) =>
    status(`${what} ${Math.min(100, Math.round((done / size) * 100))}%`);

  const read = button('Read EEPROM');
  if (read) {
    read.disabled = !(has && r && r.id);
    if (!has) read.title = 'Not in BMWeb yet for this unit';
    read.onclick = () =>
      run(async () => {
        const l = link();
        const p = await findPlan();
        const data = await scannerEepromRead(l, m, p, progress('Reading'));
        showEditor();
        hex.set(data, p.base, `${m.name}_eep.bin`);
      });
  }
  const write = button('Write EEPROM');
  if (write) {
    write.disabled = !(has && r && r.id);
    if (!has) write.title = 'Not in BMWeb yet for this unit';
    write.onclick = () =>
      run(async () => {
        const data = hex.get();
        if (!data) {
          await say(
            'info',
            'Read the EEPROM or load a file into the editor first.'
          );
          return;
        }
        const l = link();
        const p = await findPlan();
        if (data.length !== p.size) {
          await say(
            'error',
            `The editor holds ${data.length} bytes; the ${m.name} EEPROM is ${p.size} bytes (0x${p.base.toString(16).toUpperCase()}).`
          );
          return;
        }
        const ok = await say(
          'warn',
          `Write all ${p.size} bytes from the editor into the ${m.name} EEPROM at 0x${p.base.toString(16).toUpperCase()}?\n\nKeep the ignition on until it is done.`,
          ['Write', 'Cancel']
        );
        if (ok !== 'Write') return;
        const out = await scannerEepromWrite(
          l,
          m,
          p,
          data,
          progress('Writing')
        );
        hex.set(out.back, p.base, `${m.name}_eep.bin`);
        status('Written');
        await say(
          out.differ.length ? 'warn' : 'info',
          out.differ.length
            ? `Written, but ${out.differ.length} byte(s) read back different (first at 0x${(p.base + out.differ[0]).toString(16).toUpperCase()}). The editor now shows what the unit holds.`
            : 'EEPROM written and read back identical.'
        );
      });
  }

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
    ctl.SpeedButton3.onclick = () => {
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
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCANNER_UNIT_FORM,
    scannerUnitFormFor,
    scannerUnitFields,
  };
}
