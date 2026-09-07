/**
 * @file Tuning screen: the hex view's data inspector -- decode the bytes at
 * the cursor as every common width and endianness, and paint the panel. The
 * decode is split from the DOM so it can be unit-checked against known
 * patterns.
 */

/* exported tnInspectAt, tnPaintInspector */

/** Bytes the inspector decodes at once (enough for a float64). */
const TN_INSPECT_WIDTH = 8;

// Scratch view over one 8-byte window, reused so the inspector never
// allocates per keystroke.
const tnInspBuf = new ArrayBuffer(TN_INSPECT_WIDTH);
const tnInspU8 = new Uint8Array(tnInspBuf);
const tnInspDV = new DataView(tnInspBuf);

/**
 * @typedef {Object} InspectResult
 * @property {number} avail - Bytes actually available at the offset.
 * @property {string} binary
 * @property {string|null} char - The printable ASCII character, or null.
 * @property {number} int8
 * @property {number} uint8
 * @property {number|null} int16le
 * @property {number|null} uint16le
 * @property {number|null} int16be
 * @property {number|null} uint16be
 * @property {number|null} int32le
 * @property {number|null} uint32le
 * @property {number|null} int32be
 * @property {number|null} uint32be
 * @property {number|null} f32le
 * @property {number|null} f32be
 * @property {number|null} f64le
 * @property {number|null} f64be
 */

/**
 * Pure decode of up to 8 bytes at `off`. Widths that run past the end of
 * the image read as null.
 * @param {Uint8Array} bytes
 * @param {number} off
 * @returns {InspectResult}
 */
function tnInspectAt(bytes, off) {
  const avail = Math.min(TN_INSPECT_WIDTH, bytes.length - off);
  tnInspU8.fill(0);
  for (let i = 0; i < avail; i++) tnInspU8[i] = bytes[off + i];
  const b = tnInspU8[0];
  const dv = tnInspDV;
  return {
    avail,
    binary: b.toString(2).padStart(8, '0'),
    char: b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : null,
    int8: dv.getInt8(0),
    uint8: b,
    int16le: avail >= 2 ? dv.getInt16(0, true) : null,
    uint16le: avail >= 2 ? dv.getUint16(0, true) : null,
    int16be: avail >= 2 ? dv.getInt16(0, false) : null,
    uint16be: avail >= 2 ? dv.getUint16(0, false) : null,
    int32le: avail >= 4 ? dv.getInt32(0, true) : null,
    uint32le: avail >= 4 ? dv.getUint32(0, true) : null,
    int32be: avail >= 4 ? dv.getInt32(0, false) : null,
    uint32be: avail >= 4 ? dv.getUint32(0, false) : null,
    f32le: avail >= 4 ? dv.getFloat32(0, true) : null,
    f32be: avail >= 4 ? dv.getFloat32(0, false) : null,
    f64le: avail >= 8 ? dv.getFloat64(0, true) : null,
    f64be: avail >= 8 ? dv.getFloat64(0, false) : null,
  };
}

/**
 * A float for the inspector. Floats in firmware are as often garbage as
 * not, so show enough digits to recognise a real constant without letting
 * 1e-40 noise blow the column out.
 * @param {number|null} v
 * @returns {string}
 */
function tnFmtFloat(v) {
  if (v == null) return '—';
  if (!Number.isFinite(v))
    return Number.isNaN(v) ? 'NaN' : v > 0 ? '+Inf' : '-Inf';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e-4 && a < 1e9) return String(Number(v.toPrecision(9)));
  return v.toExponential(6);
}

/**
 * An integer for the inspector; a dash when the width did not fit.
 * @param {number|null} v
 * @returns {string}
 */
function tnFmtInt(v) {
  return v == null ? '—' : String(v);
}

/**
 * Paint the inspector rows for the bytes at `off`.
 * @param {HTMLElement} rowsEl - The inspector's row container.
 * @param {Uint8Array|null} bytes - The image, or null to clear.
 * @param {number} off
 * @returns {void}
 */
function tnPaintInspector(rowsEl, bytes, off) {
  if (!bytes || !bytes.length) {
    rowsEl.innerHTML = '';
    return;
  }
  const d = tnInspectAt(bytes, off);
  const rows = [
    ['int8', String(d.int8), ''],
    ['uint8', String(d.uint8), `0x${tnHex2(d.uint8)}`],
    ['int16 LE', tnFmtInt(d.int16le), tnFmtInt(d.uint16le)],
    ['int16 BE', tnFmtInt(d.int16be), tnFmtInt(d.uint16be)],
    ['int32 LE', tnFmtInt(d.int32le), tnFmtInt(d.uint32le)],
    ['int32 BE', tnFmtInt(d.int32be), tnFmtInt(d.uint32be)],
    ['float32 LE', tnFmtFloat(d.f32le), ''],
    ['float32 BE', tnFmtFloat(d.f32be), ''],
    ['float64 LE', tnFmtFloat(d.f64le), ''],
    ['float64 BE', tnFmtFloat(d.f64be), ''],
    ['binary', d.binary, ''],
    [
      'char',
      d.char == null ? '—' : d.char,
      d.char == null ? 'non-printable' : '',
    ],
  ];
  rowsEl.innerHTML = rows
    .map(
      ([k, v, alt]) =>
        `<div class="tn-insp-row"><span class="tn-insp-k">${esc(k)}</span>` +
        `<span class="tn-insp-v">${esc(v)}</span>` +
        `<span class="tn-insp-alt">${esc(alt || '')}</span></div>`
    )
    .join('');
}
