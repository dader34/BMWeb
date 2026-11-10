#!/usr/bin/env node
// BMWeb Scanner's Unit info windows (app/renderer/screens/scanner/
// scanner-vcl.js, scanner-unit.js): every one of the reference's forms
// draws, the alignment follows the VCL's rules, each unit opens the form
// BMW Scanner 1.4.0.7 gives it, and the identification panels carry the
// scan's answer.
//
// Run: node tools/verify/test_scanner_unit.js
const assert = require('assert');

// a small DOM: enough for the renderer to build its tree
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    const cls = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)),
      contains: (c) => cls.has(c) || this.className.split(' ').includes(c),
    };
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  prepend(c) {
    this.children.unshift(c);
  }
  append(...c) {
    c.forEach((x) => this.appendChild(x));
  }
  querySelector(sel) {
    const want = sel.replace(/^\./, '');
    for (const c of this.children) {
      if (c.classList && c.classList.contains(want)) return c;
      const d = c.querySelector && c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
}
global.document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ textContent: t }),
};
const pack = require('./scanner_pack.js').scannerPackOrSkip('scanner unit');
global.SCANNER_FORMS = pack.forms;
global.SCANNER_FORM_IMAGES = pack.formImages;
const vcl = require('../../app/renderer/screens/scanner/scanner-vcl.js');
global.scannerZkeVariant =
  require('../../app/renderer/screens/scanner/scanner-eeprom.js').scannerZkeVariant;
const unit = require('../../app/renderer/screens/scanner/scanner-unit.js');

let n = 0;
// every form draws, and every named control comes back by name
for (const [cls, form] of Object.entries(SCANNER_FORMS)) {
  const { ctl } = vcl.scannerRenderForm(form);
  assert.ok(ctl[form.n], cls);
  n++;
}
assert.ok(n > 100, `forms: ${n}`);

// alignment: top band, bottom band, left, right, client in between
const k = (Align, Width, Height) => ({ p: { Align, Width, Height } });
const kids = [
  k('alClient'),
  k('alTop', 0, 20),
  k('alBottom', 0, 10),
  k('alLeft', 30),
  k('alRight', 40),
];
const laid = vcl.scannerVclAlign(kids, 200, 100);
assert.deepStrictEqual(laid.get(kids[1]), { l: 0, t: 0, w: 200, h: 20 });
assert.deepStrictEqual(laid.get(kids[2]), { l: 0, t: 90, w: 200, h: 10 });
assert.deepStrictEqual(laid.get(kids[3]), { l: 0, t: 20, w: 30, h: 70 });
assert.deepStrictEqual(laid.get(kids[4]), { l: 160, t: 20, w: 40, h: 70 });
assert.deepStrictEqual(laid.get(kids[0]), { l: 30, t: 20, w: 130, h: 70 });
assert.strictEqual(vcl.scannerVclColor(15790320), 'rgb(240, 240, 240)');
assert.strictEqual(vcl.scannerVclColor('clRed'), '#ff0000');

// the reference's choice of form per unit
const form = (name) => unit.scannerUnitFormFor({ name });
assert.strictEqual(form('DME'), 'TForm8');
assert.strictEqual(form('EGS'), 'TForm8');
assert.strictEqual(form('IKE'), 'TForm4');
assert.strictEqual(form('ZKE'), 'TForm11');
assert.strictEqual(form('ABS'), 'TForm3');

// every unit form has the identification panels the controller fills
const fields = unit.scannerUnitFields(
  { name: 'DME', desc: 'Engine' },
  {
    id: {
      part: '7.519.308',
      hw: '05',
      sw: '15',
      ci: '01',
      di: '0B',
      bi: '20',
      date: '09.04',
    },
    errors: 2,
    after: 0,
  }
);
assert.strictEqual(fields.PanelBMWTNR, '7.519.308');
assert.strictEqual(fields.PanelErrors1, '2 errors');
assert.strictEqual(fields.PanelErrors2, 'no errors');
for (const cls of new Set([
  ...Object.values(unit.SCANNER_UNIT_FORM),
  'TForm3',
])) {
  const { ctl } = vcl.scannerRenderForm(SCANNER_FORMS[cls]);
  for (const name of Object.keys(fields))
    assert.ok(ctl[name], `${cls} ${name}`);
  const caps = Object.values(ctl)
    .filter((e) => e.tagName === 'BUTTON')
    .map((e) => e.textContent);
  assert.ok(caps.includes('OK'), `${cls} OK`);
  assert.ok(
    caps.some((c) => /^Errors? \.\.\.$/.test(c)),
    `${cls} Errors`
  );
}

// the hex editor's glyphs are drawn; the maker's logo is not carried
const t8 = vcl.scannerRenderForm(SCANNER_FORMS.TForm8).ctl;
assert.strictEqual(t8.SpeedButton3.children[0].tagName, 'IMG');
assert.strictEqual(t8.Image1.children.length, 0);

// the body module: "-" for FGSTNR, the algorithm by variant (DI 0x46 -> 9)
const zf = unit.scannerUnitFields(
  { name: 'ZKE', desc: 'Body' },
  {
    id: { part: '6.944.840' },
    raw: [
      0, 0x10, 0xa0, 0x86, 0x94, 0x48, 0x40, 0x20, 0x05, 0x46, 0x13, 0x31, 0x04,
      0x19, 0x41, 0xb7,
    ],
    errors: 0,
  }
);
assert.strictEqual(zf.PanelFGSTNR, '-');
assert.strictEqual(zf.PanelAlgo, 'ZKE5 S12');

// the button table: every name is a real button of that form with the
// caption its action expects, and no button with such a caption is missed
const CAPTION = {
  ok: /^OK$/,
  errors: /^Errors? \.\.\.$/,
  readEeprom: /^Read EEPROM$/,
  writeEeprom: /^Write EEPROM$/,
};
for (const cls of new Set([
  ...Object.values(unit.SCANNER_UNIT_FORM),
  'TForm3',
])) {
  const table = unit.SCANNER_UNIT_ACTIONS[cls];
  assert.ok(table, `${cls} has a button table`);
  const { ctl } = vcl.scannerRenderForm(SCANNER_FORMS[cls]);
  for (const [name, action] of Object.entries(table)) {
    assert.ok(ctl[name] && ctl[name].tagName === 'BUTTON', `${cls}.${name}`);
    assert.ok(
      CAPTION[action].test(ctl[name].textContent),
      `${cls}.${name} is ${action}: "${ctl[name].textContent}"`
    );
  }
  for (const [name, el] of Object.entries(ctl)) {
    if (el.tagName !== 'BUTTON') continue;
    const action = Object.keys(CAPTION).find((a) =>
      CAPTION[a].test(el.textContent)
    );
    if (action)
      assert.strictEqual(
        table[name],
        action,
        `${cls}.${name} "${el.textContent}" is in the table`
      );
  }
}

console.log(`scanner unit: ${n} forms draw, unit windows OK`);
