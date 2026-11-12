/**
 * @file BMWeb Scanner: draws the reference scanner's Delphi forms
 * (core/generated/scanner-forms.js) the way the VCL drew them on Windows --
 * every control at its own Left/Top/Width/Height, Align honoured, VCL's
 * defaults where the form leaves a property out (a TPanel is raised, a
 * TEdit sunken and white, a TGroupBox etched with its caption on the line).
 *
 * The renderer only draws. scannerOpenForm hosts a form in a dialog over the
 * scanner window and hands back every control by its component name, so a
 * window's own code binds its buttons and fills its panels by the names the
 * reference uses (PanelBMWTNR, Button7, ...).
 */

/* exported scannerRenderForm, scannerOpenForm, scannerVclColor, scannerPleaseWait, scannerLitLink */

/** The VCL's named colours the forms use. */
const SCANNER_VCL_COLORS = {
  clBtnFace: '#f0f0f0',
  clWindow: '#ffffff',
  clWindowText: '#000000',
  clBlack: '#000000',
  clWhite: '#ffffff',
  clGray: '#808080',
  clSilver: '#c0c0c0',
  clRed: '#ff0000',
  clGreen: '#008000',
  clLime: '#00ff00',
  clBlue: '#0000ff',
  clNavy: '#000080',
  clYellow: '#ffff00',
  clMaroon: '#800000',
  clGrayText: '#6d6d6d',
  clInfoBk: '#ffffe1',
  clHighlight: '#3399ff',
};

/**
 * A VCL colour as CSS: a named one, or a TColor integer (0x00BBGGRR).
 * @param {string|number|undefined} c
 * @returns {string|null}
 */
function scannerVclColor(c) {
  if (c == null) return null;
  if (typeof c === 'string') return SCANNER_VCL_COLORS[c] || null;
  const n = c >>> 0;
  const r = n & 0xff;
  const g = (n >> 8) & 0xff;
  const b = (n >> 16) & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

/** Controls that are not drawn (menus, timers, file dialogs). */
const SCANNER_VCL_HIDDEN = new Set([
  'TMainMenu',
  'TPopupMenu',
  'TMenuItem',
  'TTimer',
  'TOpenDialog',
  'TSaveDialog',
  'TImageList',
  'TActionList',
]);

/**
 * Lay the aligned children out the VCL's way: alTop and alBottom take bands
 * off the parent's client area in order, alLeft and alRight then, and
 * alClient gets what is left.
 * @param {object[]} kids - The child nodes.
 * @param {number} w - Client width.
 * @param {number} h - Client height.
 * @returns {Map<object, {l: number, t: number, w: number, h: number}>}
 */
function scannerVclAlign(kids, w, h) {
  const out = new Map();
  let top = 0;
  let bottom = h;
  let left = 0;
  let right = w;
  const of = (n, k, d) => (n.p && n.p[k] != null ? n.p[k] : d);
  for (const pass of ['alTop', 'alBottom', 'alLeft', 'alRight', 'alClient']) {
    for (const n of kids) {
      if (of(n, 'Align', 'alNone') !== pass || of(n, 'Visible', true) === false)
        continue;
      const nh = of(n, 'Height', 0);
      const nw = of(n, 'Width', 0);
      if (pass === 'alTop') {
        out.set(n, { l: left, t: top, w: right - left, h: nh });
        top += nh;
      } else if (pass === 'alBottom') {
        bottom -= nh;
        out.set(n, { l: left, t: bottom, w: right - left, h: nh });
      } else if (pass === 'alLeft') {
        out.set(n, { l: left, t: top, w: nw, h: bottom - top });
        left += nw;
      } else if (pass === 'alRight') {
        right -= nw;
        out.set(n, { l: right, t: top, w: nw, h: bottom - top });
      } else {
        out.set(n, { l: left, t: top, w: right - left, h: bottom - top });
      }
    }
  }
  return out;
}

/**
 * Draw one form.
 * @param {object} form - A SCANNER_FORMS entry.
 * @returns {{el: HTMLElement, ctl: Object<string, HTMLElement>}} The form's
 *   client area and its controls by component name.
 */
function scannerRenderForm(form) {
  const ctl = {};
  const fp = form.p || {};
  const root = document.createElement('div');
  root.className = 'vcl-form';
  root.style.width = `${fp.ClientWidth || fp.Width || 400}px`;
  root.style.height = `${fp.ClientHeight || fp.Height || 300}px`;
  const formFont = fp['Font.Height'] ? Math.abs(fp['Font.Height']) : 11;
  root.style.fontSize = `${formFont}px`;
  ctl[form.n] = root;
  const pics =
    (typeof SCANNER_FORM_IMAGES !== 'undefined' &&
      SCANNER_FORM_IMAGES &&
      SCANNER_FORM_IMAGES.map[form.c]) ||
    {};
  const picture = (name) => {
    if (pics[name] == null) return null;
    const [src, w, h] = SCANNER_FORM_IMAGES.pool[pics[name]];
    const img = document.createElement('img');
    img.src = src;
    img.width = w;
    img.height = h;
    img.alt = '';
    img.draggable = false;
    return img;
  };

  const draw = (node, parent, box, inheritedFont) => {
    const p = node.p || {};
    const el = document.createElement(
      node.c === 'TButton' || node.c === 'TSpeedButton' ? 'button' : 'div'
    );
    el.className = `vcl vcl-${node.c.slice(1).toLowerCase()}`;
    el.dataset.name = node.n;
    el.style.left = `${box.l}px`;
    el.style.top = `${box.t}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    if (p.Visible === false) el.hidden = true;
    if (p.Enabled === false) el.classList.add('vcl-disabled');
    const font =
      p['Font.Height'] && p.ParentFont !== true
        ? Math.abs(p['Font.Height'])
        : inheritedFont;
    if (font !== formFont) el.style.fontSize = `${font}px`;
    if (Array.isArray(p['Font.Style'])) {
      if (p['Font.Style'].includes('fsBold')) el.style.fontWeight = 'bold';
      if (p['Font.Style'].includes('fsItalic')) el.style.fontStyle = 'italic';
      if (p['Font.Style'].includes('fsUnderline'))
        el.style.textDecoration = 'underline';
    }
    const fc = scannerVclColor(p['Font.Color']);
    if (fc && fc !== '#000000') el.style.color = fc;
    const bg = scannerVclColor(p.Color);
    const caption =
      p.Caption != null ? String(p.Caption).replace(/&(.)/g, '$1') : '';

    switch (node.c) {
      case 'TPanel': {
        const outer = p.BevelOuter || 'bvRaised';
        const inner = p.BevelInner || 'bvNone';
        el.classList.add(`vcl-bo-${outer}`, `vcl-bi-${inner}`);
        if (bg) el.style.background = bg;
        const al = p.Alignment || 'taCenter';
        el.classList.add(`vcl-al-${al}`);
        const span = document.createElement('span');
        span.className = 'vcl-caption';
        span.textContent = caption;
        el.appendChild(span);
        break;
      }
      case 'TLabel': {
        el.textContent = caption;
        el.classList.add(`vcl-al-${p.Alignment || 'taLeftJustify'}`);
        if (p.WordWrap) el.classList.add('vcl-wrap');
        if (p.AutoSize !== false && !p.WordWrap) {
          el.style.width = 'auto';
          if (p.Alignment === 'taRightJustify') {
            el.style.left = 'auto';
            el.style.right = `calc(100% - ${box.l + box.w}px)`;
          }
        }
        if (bg && p.Transparent === false) el.style.background = bg;
        break;
      }
      case 'TGroupBox': {
        const legend = document.createElement('span');
        legend.className = 'vcl-legend';
        legend.textContent = caption;
        if (caption) el.appendChild(legend);
        break;
      }
      case 'TButton':
      case 'TSpeedButton': {
        el.type = 'button';
        el.textContent = caption;
        el.disabled = p.Enabled === false;
        if (p.Flat) el.classList.add('vcl-flat');
        const img = picture(node.n);
        if (img) el.prepend(img);
        break;
      }
      case 'TImage': {
        const img = picture(node.n);
        if (img) {
          if (p.Stretch) {
            img.style.width = '100%';
            img.style.height = '100%';
          }
          el.appendChild(img);
        }
        break;
      }
      case 'TCheckBox':
      case 'TRadioButton': {
        const input = document.createElement('input');
        input.type = node.c === 'TCheckBox' ? 'checkbox' : 'radio';
        input.checked = !!p.Checked || p.State === 'cbChecked';
        input.disabled = p.Enabled === false;
        const lab = document.createElement('label');
        lab.append(input, document.createTextNode(caption));
        el.appendChild(lab);
        break;
      }
      case 'TEdit': {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = p.Text != null ? String(p.Text) : '';
        input.readOnly = !!p.ReadOnly;
        input.disabled = p.Enabled === false;
        if (bg) input.style.background = bg;
        el.appendChild(input);
        break;
      }
      case 'TComboBox': {
        const sel = document.createElement('select');
        for (const it of p['Items.Strings'] || []) {
          const o = document.createElement('option');
          o.textContent = it;
          sel.appendChild(o);
        }
        if (p.ItemIndex != null) sel.selectedIndex = p.ItemIndex;
        sel.disabled = p.Enabled === false;
        el.appendChild(sel);
        break;
      }
      case 'TBevel':
        el.classList.add(`vcl-shape-${p.Shape || 'bsBox'}`);
        break;
      case 'TListView': {
        const head = document.createElement('div');
        head.className = 'vcl-lvhead';
        for (const col of p.Columns || []) {
          const c = document.createElement('span');
          c.style.width = `${col.Width || 50}px`;
          c.textContent = col.Caption || '';
          head.appendChild(c);
        }
        const rows = document.createElement('div');
        rows.className = 'vcl-lvrows';
        el.append(head, rows);
        if (bg) el.style.background = bg;
        break;
      }
      case 'TRichEdit':
      case 'TMemo': {
        const ta = document.createElement('textarea');
        ta.readOnly = true;
        ta.value = (p['Lines.Strings'] || []).join('\n');
        el.appendChild(ta);
        break;
      }
      case 'TStatusBar':
        el.textContent = caption;
        break;
      default:
        // THexEditor, TImage and anything else: an empty well in its place
        if (bg) el.style.background = bg;
        break;
    }
    ctl[node.n] = el;
    parent.appendChild(el);

    const kids = (node.k || []).filter((k) => !SCANNER_VCL_HIDDEN.has(k.c));
    if (kids.length) {
      const laid = scannerVclAlign(kids, box.w, box.h);
      for (const k of kids) {
        const kp = k.p || {};
        const b = laid.get(k) || {
          l: kp.Left || 0,
          t: kp.Top || 0,
          w: kp.Width != null ? kp.Width : 75,
          h: kp.Height != null ? kp.Height : 21,
        };
        draw(k, el, b, font);
      }
    }
  };

  const kids = (form.k || []).filter((k) => !SCANNER_VCL_HIDDEN.has(k.c));
  const w = fp.ClientWidth || fp.Width || 400;
  const h = fp.ClientHeight || fp.Height || 300;
  const laid = scannerVclAlign(kids, w, h);
  for (const k of kids) {
    const kp = k.p || {};
    draw(
      k,
      root,
      laid.get(k) || {
        l: kp.Left || 0,
        t: kp.Top || 0,
        w: kp.Width != null ? kp.Width : 75,
        h: kp.Height != null ? kp.Height : 21,
      },
      formFont
    );
  }
  return { el: root, ctl };
}

/**
 * Open one of the reference's forms as a dialog over the whole app.
 * @param {HTMLElement} win - The scanner window (its screen owns the form).
 * @param {string} cls - The form's class (TForm8, ...).
 * @param {(ctl: Object<string, HTMLElement>, close: () => void,
 *   layer: HTMLElement) => ({canClose?: () => boolean, cancel?: () => void}|void)} [bind] -
 *   Fills the form and wires its controls; `close` closes it; `layer` is
 *   where its own dialogs go, over it. It may hand back `canClose` (false
 *   keeps the form open, e.g. while it writes) and `cancel` (stop the work
 *   in hand: the app is leaving the screen).
 * @returns {Promise<void>} Resolves when the form is closed.
 */
async function scannerOpenForm(win, cls, bind) {
  const form =
    typeof SCANNER_FORMS !== 'undefined' && SCANNER_FORMS
      ? SCANNER_FORMS[cls]
      : null;
  if (!form) throw new Error(`no form ${cls}`);
  const { el, ctl } = scannerRenderForm(form);
  const wrap = document.createElement('div');
  wrap.className = 'vcl-host';
  wrap.appendChild(el);
  // over the whole app, not inside the scanner window, so it is never cut
  const layer = document.createElement('div');
  layer.className = 'vcl-layer';
  document.body.appendChild(layer);
  let closer = null;
  let hooks = null;
  let leaving = false;
  const done = wkfpDialog(layer, {
    title: (form.p && form.p.Caption) || cls,
    body: wrap,
    cls: 'vcl-dlg',
    buttons: [],
    canClose: () => leaving || !hooks || !hooks.canClose || hooks.canClose(),
    onOpen: (dlg) => {
      closer = () => dlg.querySelector('.wkfp-x').click();
    },
  });
  if (bind) hooks = bind(ctl, () => closer && closer(), layer) || null;
  // the app moving to another screen stops the form's work and closes it
  const away = () => {
    leaving = true;
    if (hooks && hooks.cancel) hooks.cancel();
    if (closer) closer();
  };
  window.addEventListener('hashchange', away);
  try {
    await done;
  } finally {
    window.removeEventListener('hashchange', away);
    layer.remove();
  }
}

/**
 * What the light of the "Please wait ..." window shows, as the reference's
 * cable transaction sets it after every telegram (0x6CD1E4, through the
 * form's own 0x5FDFE4): the unit answered and took it, the unit answered
 * with a refusal, or nothing came back. The form opens with it off
 * (FormActivate, 0x5FDFC8).
 */
const SCANNER_WAIT_LIGHT = {
  ok: 0x00f000,
  refused: 0x00f0f0,
  silent: 0x0000ff,
  off: 'clBtnFace',
};

/**
 * The reference's "Please wait ..." window (TForm98), up while a unit is
 * read or written: one line saying what is being done, a light for how the
 * last telegram went, and Cancel.
 *
 * Cancel (and the window's X, and Escape) does not close it: it asks the
 * work to stop, as the reference's sets a flag its loops look at
 * (Button1Click, 0x5FDFC0), and the work closes the window when it ends.
 * @param {HTMLElement} win - The window the work belongs to.
 * @param {string} text - What is being done.
 * @param {() => void} onCancel - The user asked the work to stop.
 * @returns {{say: (text: string) => void,
 *   light: (state: keyof typeof SCANNER_WAIT_LIGHT) => void,
 *   close: () => void}}
 */
function scannerPleaseWait(win, text, onCancel) {
  let line = null;
  let lamp = null;
  let shut = null;
  let finished = false;
  const api = {
    say(t) {
      if (line) line.textContent = t;
    },
    light(state) {
      if (lamp)
        lamp.style.background = scannerVclColor(SCANNER_WAIT_LIGHT[state]);
    },
    close() {
      if (finished) return;
      finished = true;
      if (shut) shut();
    },
  };
  scannerOpenForm(win, 'TForm98', (ctl, close) => {
    shut = close;
    line = ctl.Panel1 && ctl.Panel1.querySelector(':scope > .vcl-caption');
    lamp = ctl.PanelLight || null;
    // the frame's design-time name is not something the reference shows
    const frame =
      ctl.Panel2 && ctl.Panel2.querySelector(':scope > .vcl-caption');
    if (frame) frame.textContent = '';
    api.say(text);
    api.light('off');
    if (ctl.Button1) ctl.Button1.onclick = close;
    return {
      canClose: () => {
        if (!finished) onCancel();
        return finished;
      },
      cancel: onCancel,
    };
  }).catch(() => {
    // no such form in the pack: the work runs without the window
  });
  return api;
}

/**
 * A link whose every telegram sets the light of a "Please wait ..." window,
 * the reference's way: green for an answer the unit took (A0), yellow for
 * one it refused, red when nothing came back.
 * @param {ScannerLink} link
 * @param {{light: (state: string) => void}} wait
 * @returns {ScannerLink}
 */
function scannerLitLink(link, wait) {
  const lit = (fn) =>
    fn &&
    (async (...args) => {
      let r;
      try {
        r = await fn(...args);
      } catch (e) {
        wait.light('silent');
        throw e;
      }
      wait.light(!r || !r.length ? 'silent' : r[2] === 0xa0 ? 'ok' : 'refused');
      return r;
    });
  return { ...link, ds2: lit(link.ds2), word: lit(link.word) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scannerVclAlign,
    scannerVclColor,
    scannerRenderForm,
    scannerLitLink,
    SCANNER_WAIT_LIGHT,
  };
}
