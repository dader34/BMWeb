// Spec walker: run a lifted job spec against an ECU response, in the browser.
//
// This is the runtime half of the jobs-to-JSON work (docs/sgbd-to-json.md).
// tools/sgbd_spec.py lifts a job's compiled BEST2 bytecode into declarative
// JSON -- request template, response byte offsets, masks, scales, table
// lookups -- and this executes that JSON. No .prg, no BEST2 interpreter, no
// WASM: a few hundred lines of plain JS.
//
// Ported from decode_with_spec() in tools/sgbd_value_diff.py, which is the
// reference implementation the value harness verifies against the real
// EDIABAS engine. tools/test_specwalk.js checks the two agree byte for byte,
// so a divergence is a test failure rather than a silent difference between
// what we verify and what we ship.
//
// ONE DELIBERATE DIFFERENCE from the Python: this walker resolves table
// lookups. The Python decoder runs without a runtime and reports the raw word
// for a loop record whose scale is keyed by a value in the RESPONSE
// (FUmweltTexte.UWNR -- see specWalkRecord below). A walker holding the
// response can do what EDIABAS does: read the key, seek the row, apply its
// scale. That is the whole reason this exists rather than shipping the Python.

// A response frame is BMW-FAST or DS2, and the two put the caller's offsets in
// different places. Detected from the LENGTH FIELD, never from bit 7 of byte 0
// -- plenty of DS2 ECUs have an address with that bit set (AIC sends E8,04,00)
// and were misread as BMW-FAST for a whole corpus run.
function specIsDs2(frame) {
  return frame.length >= 2 &&
    (frame[1] === frame.length || frame[1] === frame.length + 1);
}

// The bytes a result's offsets are measured against. BMW-FAST strips its
// 3-byte header (len|dst|src) into a register before indexing, so offsets are
// payload-relative; DS2 indexes the frame directly, header included.
function specFrameFor(result, frame) {
  const ds2 = specIsDs2(frame);
  if (result.base === 'payload' && !ds2 && frame.length > 3) return frame.slice(3);
  return frame;
}

const specHex = (b) => b.toString(16).toUpperCase().padStart(2, '0');

// digits only, as a2fix parses them: "AA" holds none, so the value is 0 --
// which is exactly what an ECU means by "no date"
function specDigits(text) {
  const d = text.replace(/[^0-9]/g, '');
  return d ? parseInt(d, 10) : 0;
}

// latin-1, NUL-terminated. Never trimmed: BMS46's ID_DIAG_INDEX is the bytes
// 08,09, and 0x09 is a TAB -- trimming whitespace deletes half the value.
function specText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

// A lifted offset list must be in range, and must not be the accumulator bug:
// AIC's ID_BMW_NR lifts as [4,5,6,0,2,1,0], non-monotonic and repeating, which
// is not a field at all. Decoding it produced garbage that looked like a value.
function specOffsetsUsable(offs, frame) {
  if (!Array.isArray(offs) || offs.length === 0) return false;
  return offs.every((o) => Number.isInteger(o) && o >= 0 && o < frame.length);
}

// Resolve a table-keyed scale. `tables` is {TABLENAME: [row, ...]} as the
// SGBD ships them (the engine serves these at /api/ecu/<sgbd>/table/<name>).
//
// The key is NOT the iteration index. FUmweltTexte is keyed by measurement
// NUMBER (UWNR), and that number arrives in the response -- the caller asks
// for measurements by id and the ECU says which it returned. Indexing by
// position picks the wrong row: MS450's third measurement wants MUL_WORD
// 0.125 where row 2 holds 0.00390625.
function specSeekRow(tables, lookup, key) {
  const rows = tables && tables[lookup.table];
  if (!rows || key == null) return null;
  const col = lookup.keyColumn || 'UWNR';
  const want = String(key).toLowerCase();
  const wantHex = typeof key === 'number' ? '0x' + key.toString(16) : null;
  for (const row of rows) {
    const cell = String(row[col] ?? '').toLowerCase();
    if (cell === want || (wantHex && cell === wantHex)) return row;
  }
  return null;
}

const specNum = (v, dflt) => {
  if (v == null) return dflt;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : dflt;
};

// Decode one result. `ctx` carries {tables, keys} -- `keys` maps an iteration
// index to the measurement number read out of the response, which is what
// makes the table lookup resolvable here and not in the static decoder.
function specWalkResult(result, frame, ctx) {
  if (result.const !== undefined && result.const !== null) return result.const;

  const buf = specFrameFor(result, frame);
  const offs = result.bytes;
  if (!specOffsetsUsable(offs, buf)) return null;
  const picked = offs.map((o) => buf[o]);

  // y2bcd/y2hex render each byte as its two hex nibbles, which for BCD data
  // ARE the decimal digits: 0x55 -> "55". When a2fix follows, the two compose
  // rather than being alternatives -- the text is then parsed as a number.
  if (result.convert === 'bcd' || result.convert === 'hex') {
    const txt = picked.map(specHex).join('');
    return result.ascii ? specDigits(txt) : txt;
  }
  if (result.type === 'string') return specText(picked);
  if (result.ascii) return specDigits(specText(picked));

  // Big-endian, in bytecode read order. Neither `<<` nor Number arithmetic
  // survives real field widths: JS bitwise ops truncate to 32 bits (a 5-byte
  // field wrapped 0x11191F272D to 421472045), and a Number loses precision
  // past 53 bits -- ZKE5's COD_DATEN is TWENTY-NINE bytes, where the low bits
  // a mask selects are exactly the ones float rounding destroys. BigInt
  // accumulation is the only thing that matches Python's unbounded ints, so
  // wide fields go through it and come back as a Number only when they fit.
  let big = 0n;
  for (const b of picked) big = (big << 8n) | BigInt(b);
  if (result.mask != null) big &= BigInt(result.mask);
  if (result.addend) big += BigInt(result.addend);
  const raw = big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;

  const lk = result.lookup;
  if (result.iteration != null && lk && lk.scaleColumn) {
    const row = specSeekRow(ctx.tables, lk, ctx.keys && ctx.keys[result.iteration]);
    if (row) {
      return raw * specNum(row[lk.scaleColumn], 1) +
        specNum(row[lk.offsetColumn], 0);
    }
    return raw;   // no key yet: the raw word is still honest
  }
  if (result.scale != null) return raw * result.scale + (result.offset || 0);
  return raw;
}

// Run a whole spec against a response frame.
//   spec   the lifted JSON for one job
//   frame  the full response telegram, as a byte array
//   ctx    {tables, keys} (both optional)
// Returns {name: value}; a result the spec does not pin down is null rather
// than a guess, so a caller can tell "unknown" from "zero".
function specWalk(spec, frame, ctx) {
  const out = {};
  const c = ctx || {};
  for (const r of (spec.results || [])) {
    try {
      out[r.name] = specWalkResult(r, frame, c);
    } catch (e) {
      out[r.name] = null;
    }
  }
  return out;
}

// Build the request telegram for a job. argSlots are positions the caller
// fills; everything else is the fixed template the bytecode assembles.
function specRequest(spec, args) {
  const req = spec.request;
  if (!req || !Array.isArray(req.bytes)) return null;
  const bytes = req.bytes.slice();
  const slots = req.argSlots || [];
  (args || []).forEach((v, i) => {
    if (i < slots.length) bytes[slots[i]] = v & 0xff;
  });
  return bytes.some((b) => b == null) ? null : bytes;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { specWalk, specWalkResult, specRequest, specIsDs2,
                     specSeekRow, specText, specDigits };
}
