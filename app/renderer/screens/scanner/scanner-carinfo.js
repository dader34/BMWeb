/**
 * @file BMWeb Scanner: Car ident's "Information about car and ZCS/FA coding"
 * window, the reference scanner's TForm15 (BMW Scanner 1.4.0.7).
 *
 * What it reads is what the reference read in the USB capture of its car
 * identification on an E46 (capture-frames.txt):
 *   IKE  02 02 (VIN), 02 01 (odometer), 06 03 00 hi lo 10 from 0x00C2 in
 *        twelve steps of 0x10 (the FA, 384 bytes)
 *   LCM  02 00 (VIN and odometer), 15 00 .. 15 11 (the FA, 16 bytes each)
 * How it decodes and looks up the FA is the reference's own code: the
 * 6-bit decoder at 0x5B9014 and the type-key / option lookup at 0x5BB3A8,
 * over its tables (core/generated/scanner-fa-tables.js).
 */

/* exported scannerFaDecode, scannerFaLookup, scannerReadCarInfo, scannerCarInfoBody, scannerParseVin, scannerParseOdometer */

/**
 * The reference's FA decoder (0x5B9014): byte 0 is skipped, the bytes up to
 * the first 00 become a bit string padded with eight zeros, read six bits
 * at a time -- "1xxxxx" is '@'+x (letters), "01xxxx" is '0'+x (digits),
 * "00xxxx" ends a group. Fields: chassis, time criterion, type key, paint,
 * upholstery (four characters each), three seven-character fields, four
 * bits, then the three-character option codes, then the four-character
 * sections that follow a '4' or '<' marker.
 * @param {ArrayLike<number>} raw - The FA as read (IKE or LCM).
 * @returns {{chassis: string, time: string, typeKey: string, paint: string,
 *   upholstery: string, options: string[], words: string[]}|null} Null for a
 *   buffer that does not decode.
 */
function scannerFaDecode(raw) {
  const b = Array.from(raw || []);
  if (b.length < 8) return null;
  const end = b.indexOf(0, 1);
  const body = b.slice(1, end < 0 ? b.length : end);
  let bits =
    body.map((x) => x.toString(2).padStart(8, '0')).join('') + '00000000';
  let p = 0;
  const ch = () => {
    const g = bits.slice(p, p + 6);
    if (g.length < 6) return null;
    if (g[0] === '1')
      return {
        c: String.fromCharCode(0x40 + parseInt(g.slice(1), 2)),
        ok: true,
      };
    return {
      c: String.fromCharCode(0x30 + parseInt(g.slice(2), 2)),
      ok: g[1] === '1',
    };
  };
  const take = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = ch();
      if (!c || !c.ok) throw new Error('bad FA group');
      s += c.c;
      p += 6;
    }
    return s;
  };
  try {
    const time = take(4);
    const chassis = take(4);
    const typeKey = take(4);
    const paint = take(4);
    const upholstery = take(4);
    for (let i = 0; i < 3; i++) take(7);
    p += 4;
    const options = [];
    const words = [];
    let width = 3;
    let into = options;
    for (;;) {
      let last = null;
      for (;;) {
        let code = '';
        let ok = true;
        for (let k = 0; k < width; k++) {
          const c = ch();
          if (!c) {
            ok = false;
            break;
          }
          last = c.c;
          if (!c.ok) {
            if (k > 0) throw new Error('broken FA code');
            ok = false;
            break;
          }
          code += c.c;
          p += 6;
        }
        if (!ok) break;
        into.push(code);
      }
      p += 6;
      if (last === '4' || last === '<') {
        width = 4;
        into = words;
      } else break;
    }
    bits = '';
    return {
      chassis: chassis.replace(/_+$/, ''),
      time,
      typeKey,
      paint,
      upholstery,
      options,
      words,
    };
  } catch (e) {
    return null;
  }
}

/**
 * The reference's lookup (0x5BB3A8): the type key in its table (rows
 * without a ZCS key: the FA cars), giving series, body, model, engine and
 * gearbox -- "Unknown" gearbox reads "Manual", and option 205 makes it
 * "Automatic" -- and the options the FA carries, in the order of the
 * series' option table, with their texts.
 * @param {ReturnType<typeof scannerFaDecode>} fa
 * @param {typeof SCANNER_FA_TABLES} [tables]
 * @returns {{chassis: string, body: string, model: string, engine: string,
 *   gearbox: string, options: {code: string, text: string}[]}|null}
 */
function scannerFaLookup(fa, tables) {
  const t =
    tables ||
    (typeof SCANNER_FA_TABLES !== 'undefined' ? SCANNER_FA_TABLES : null);
  if (!fa || !t) return null;
  const row = t.typeKeys.find((r) => !r[1] && r[2] === fa.typeKey);
  if (!row) return null;
  const [series, , , body, model, engine, gearbox0] = row;
  const table = t.options[String(series)] || [];
  const have = new Set(fa.options);
  const options = table
    .filter(([code]) => have.has(code))
    .map(([code, text]) => ({ code, text }));
  let gearbox = gearbox0 === 'Unknown' ? 'Manual' : gearbox0;
  if (have.has('205')) gearbox = 'Automatic';
  return {
    chassis: t.series[series - 1],
    body,
    model,
    engine,
    gearbox,
    options,
  };
}

/** Two BCD digits of a byte. */
const bcd2 = (b) => (b >> 4).toString(16) + (b & 15).toString(16);

/**
 * A VIN as the IKE (02 02) and the LCM (02 00) answer it: two letters, then
 * five digits as BCD ("41 42 12 34 50" -> "AB12345").
 * @param {ArrayLike<number>} r - The answer frame.
 * @param {number} at - Offset of the first letter.
 * @returns {string|null}
 */
function scannerParseVin(r, at) {
  if (!r || r.length < at + 5) return null;
  const letters = String.fromCharCode(r[at], r[at + 1]);
  if (!/^[A-Z]{2}$/.test(letters)) return null;
  return (
    letters + (bcd2(r[at + 2]) + bcd2(r[at + 3]) + bcd2(r[at + 4])).slice(0, 5)
  );
}

/**
 * The odometer: the IKE's 02 01 answer carries it as BCD ("12 34 56" ->
 * 123456 km), the LCM's 02 00 answer as a 16-bit count of hundreds of
 * kilometres after its VIN ("04 D2" -> 123400 km).
 * @param {ArrayLike<number>} r - The answer frame.
 * @param {'ike'|'lcm'} from
 * @returns {string|null} "123456 km", or null.
 */
function scannerParseOdometer(r, from) {
  if (!r) return null;
  if (from === 'ike') {
    if (r.length < 7) return null;
    const km = parseInt(bcd2(r[4]) + bcd2(r[5]) + bcd2(r[6]), 10);
    return Number.isFinite(km) ? `${km} km` : null;
  }
  if (r.length < 11) return null;
  return `${((r[9] << 8) | r[10]) * 100} km`;
}

/**
 * Read what the window shows, the reference's telegrams in its order.
 * @param {{ds2: (addr: number, payload: number[]) => Promise<number[]|null>}} link
 * @returns {Promise<{ike: object|null, lcm: object|null}>} Per module: the
 *   raw FA, its decoding and lookup, VIN and odometer; null when silent.
 */
async function scannerReadCarInfo(link) {
  const ask = async (addr, payload) => {
    try {
      const r = await link.ds2(addr, payload);
      return r && r[2] === 0xa0 ? r : null;
    } catch (e) {
      return null;
    }
  };
  const out = { ike: null, lcm: null };
  // IKE: VIN, odometer, then the FA in twelve 32-byte reads
  const ikeVin = await ask(0x80, [0x02, 0x02]);
  if (ikeVin) {
    const odo = await ask(0x80, [0x02, 0x01]);
    const fa = [];
    for (let i = 0; i < 12; i++) {
      const at = 0xc2 + i * 0x10;
      const r = await ask(0x80, [
        0x06,
        0x03,
        0x00,
        (at >> 8) & 0xff,
        at & 0xff,
        0x10,
      ]);
      if (!r) break;
      fa.push(...r.slice(3, -1));
    }
    out.ike = scannerCarInfoModule(
      fa,
      scannerParseVin(ikeVin, 4),
      scannerParseOdometer(odo, 'ike')
    );
  }
  // LCM: VIN and odometer together, then the FA sixteen bytes at a time
  const lcmId = await ask(0xd0, [0x02, 0x00]);
  if (lcmId) {
    const fa = [];
    for (let n = 0; n < 18; n++) {
      const r = await ask(0xd0, [0x15, n]);
      if (!r) break;
      fa.push(...r.slice(3, -1));
    }
    out.lcm = scannerCarInfoModule(
      fa,
      scannerParseVin(lcmId, 4),
      scannerParseOdometer(lcmId, 'lcm')
    );
  }
  return out;
}

/**
 * @param {number[]} fa - Raw FA bytes.
 * @param {string|null} vin
 * @param {string|null} odometer
 * @returns {object}
 */
function scannerCarInfoModule(fa, vin, odometer) {
  const decoded = scannerFaDecode(fa);
  return { raw: fa, fa: decoded, car: scannerFaLookup(decoded), vin, odometer };
}

/**
 * The window's body: car information, the FA header and the options, IKE
 * and LCM side by side; a value the two disagree on is marked, as the
 * reference draws it red (its VIN compared on the last seven characters).
 * @param {{ike: object|null, lcm: object|null}} info
 * @returns {HTMLElement}
 */
function scannerCarInfoBody(info) {
  const cols = [info.ike, info.lcm];
  const cell = (m, f) => (m && f(m)) || '';
  const row = (label, f, cmp) => {
    const a = cell(cols[0], f);
    const b = cell(cols[1], f);
    const differ = cols[0] && cols[1] && (cmp ? cmp(a) !== cmp(b) : a !== b);
    return `<tr${differ ? ' class="scn-ci-diff"' : ''}><td>${esc(label)}</td><td>${esc(a)}</td><td>${esc(b)}</td></tr>`;
  };
  const head = '<tr><th>Parameter</th><th>IKE</th><th>LCM</th></tr>';
  const car = [
    row('Chassis', (m) => m.car && m.car.chassis),
    row('Model', (m) => m.car && m.car.model),
    row('Body', (m) => m.car && m.car.body),
    row('Engine', (m) => m.car && m.car.engine),
    row('Gearbox', (m) => m.car && m.car.gearbox),
    row(
      'VIN',
      (m) => m.vin,
      (v) => v.slice(-7)
    ),
    row('Odometer', (m) => m.odometer),
  ].join('');
  const fa = [
    row('Type-Key', (m) => m.fa && m.fa.typeKey),
    row('Time criterion', (m) => m.fa && m.fa.time),
    row('Paint code', (m) => m.fa && m.fa.paint),
    row('Upholstery code', (m) => m.fa && m.fa.upholstery),
  ].join('');
  const opt = (m) =>
    m && m.car
      ? m.car.options
          .map(
            (o) =>
              `<div>&lt; ${esc(o.code)} &gt;&nbsp;&nbsp;${esc(o.text)}</div>`
          )
          .join('')
      : '';
  const el = document.createElement('div');
  el.className = 'scn-carinfo';
  el.innerHTML = `
    <fieldset class="scn-ci-group"><legend>Information about car</legend>
      <table class="scn-ci-table">${head}${car}</table>
    </fieldset>
    <fieldset class="scn-ci-group"><legend>ZCS/FA coding</legend>
      <table class="scn-ci-table">${fa}</table>
      <div class="scn-ci-opts">
        <div class="scn-ci-optlabel">Options</div>
        <div class="scn-ci-optcol">${opt(cols[0])}</div>
        <div class="scn-ci-optcol">${opt(cols[1])}</div>
      </div>
    </fieldset>`;
  return el;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scannerFaDecode,
    scannerFaLookup,
    scannerReadCarInfo,
    scannerCarInfoBody,
    scannerParseVin,
    scannerParseOdometer,
  };
}
