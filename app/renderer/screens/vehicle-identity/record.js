/**
 * @file Vehicle identity: decoding a module's reply into the build record --
 * the three coding keys (named, or found inside a raw region) and the
 * vehicle order (text, or the packed stream FA.PRG decodes).
 *
 * Second piece of screens/vehicle-identity/; pure helpers over result maps,
 * plus viRunValues, the one way every read here drives a job.
 */

/**
 * The coding keys as read off a reply.
 * @typedef {object} ViReadKeys
 * @property {string} gm - GM key body (8 hex digits).
 * @property {string} sa - SA key body (16 hex digits).
 * @property {string} vn - VN key body (10 hex digits).
 * @property {'named'|'region'} source - Whether the ECU named each key or
 *   the region was found inside a blob.
 * @property {string} [from] - The result the region was found in.
 * @property {number} [offset] - Byte offset of the region in that result.
 */

/**
 * A ZCS region located inside a blob by its check characters.
 * @typedef {object} ViFoundRegion
 * @property {string} gm - GM key body.
 * @property {string} sa - SA key body.
 * @property {string} vn - VN key body.
 * @property {number} offset - Byte offset the region starts at.
 */

/** Hex digits in each coding key's body, check character excluded. */
const VI_KEY_WIDTH = { gm: 8, sa: 16, vn: 10 };

/** Bytes in a ZCS region: three keys, each with its check character. */
const VI_REGION_BYTES = 20;

/** The result FA.PRG's decoder answers the marker-delimited order in. */
const VI_FA_DECODER = {
  sgbd: 'fa',
  job: 'FA_STREAM2STRUCT',
  result: 'STANDARD_FA',
};

/** Block number FA_STREAM2STRUCT is asked to decode (the whole order). */
const VI_FA_BLOCK = 1;

/** A VIN with its Mod-36 check character appended. */
const VI_VIN_CHECKED_LEN = 18;
/** A full VIN. */
const VI_VIN_LEN = 17;
/** Positions 4..7 of a full VIN carry the type key (WBA AV36 ...). */
const VI_VIN_TYPE_KEY = [3, 7];

/**
 * hex text -> bytes, or null. Accepts "0A 0B", "0A-0B", "0x0A0B" and plain
 * hex, plus a byte array or typed array as the web VM hands binary results
 * back. KD_DATEN and DATEN arrive in any of these shapes.
 * @param {unknown} v - The result value.
 * @returns {number[]|null} The bytes, or null for anything else.
 */
function viBytes(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((b) => b & 0xff);
  if (ArrayBuffer.isView(v)) return Array.from(v, (b) => b & 0xff);
  const s = String(v).trim().replace(/^0x/i, '');
  if (/^[0-9A-Fa-f]{2}([\s-][0-9A-Fa-f]{2})+$/.test(s)) {
    return s.split(/[\s-]+/).map((h) => parseInt(h, 16));
  }
  if (/^[0-9A-Fa-f]+$/.test(s) && s.length % 2 === 0) {
    const out = [];
    for (let i = 0; i < s.length; i += 2)
      out.push(parseInt(s.substr(i, 2), 16));
    return out;
  }
  return null;
}

/**
 * Pull the three coding keys out of a reply, using the result names the ECU
 * itself declared for this job.
 *
 * Two shapes in the wild: an ECU that names each key, and one that answers
 * with a raw region the keys sit inside. The named form needs no offset. The
 * raw form goes through coding-zcs, which knows the 4-1-8-1-5-1 layout.
 * @param {Map<string, unknown>} values - The reply's results by name.
 * @param {ViKeyNames|null|undefined} keyNames - The declared key results.
 * @returns {ViReadKeys|null} The keys, or null when nothing verifies.
 */
function viKeysFrom(values, keyNames) {
  const pick = (n) => {
    if (!n || !values.has(n)) return null;
    const s = String(values.get(n)).replace(/[^0-9A-Fa-f]/g, '');
    return s ? s.toUpperCase() : null;
  };
  const gm = pick(keyNames && keyNames.gm);
  const sa = pick(keyNames && keyNames.sa);
  const vn = pick(keyNames && keyNames.vn);
  // A key may carry its Mod-36 check character; the tables mask the body only.
  if (gm && sa && vn) {
    return {
      gm: gm.slice(0, VI_KEY_WIDTH.gm),
      sa: sa.slice(0, VI_KEY_WIDTH.sa),
      vn: vn.slice(0, VI_KEY_WIDTH.vn),
      source: 'named',
    };
  }
  // No named keys: the reply may still CONTAIN the region. Every non-internal
  // result is a candidate blob, and the region is found by verifying its
  // check characters rather than by assuming where it starts -- see
  // viFindRegion. A blob that never verifies yields nothing.
  for (const [name, v] of values) {
    if (VI_INTERNAL.test(name)) continue;
    const bytes = viBytes(v);
    if (!bytes || bytes.length < VI_REGION_BYTES) continue;
    const found = viFindRegion(bytes);
    if (found) return { ...found, source: 'region', from: name };
  }
  return null;
}

/**
 * Find the 20-byte ZCS region inside a larger blob by verifying its check
 * characters.
 * @param {number[]} bytes - The blob.
 * @returns {ViFoundRegion|null} The region and its offset, or null when no
 *   offset verifies (never a fallback to offset 0).
 */
function viFindRegion(bytes) {
  if (typeof CodingZcs === 'undefined' || !CodingZcs.parseZcsRegion)
    return null;
  for (let off = 0; off + VI_REGION_BYTES <= bytes.length; off++) {
    let r;
    try {
      r = CodingZcs.parseZcsRegion(bytes.slice(off, off + VI_REGION_BYTES));
    } catch (e) {
      continue;
    }
    // All three check characters must verify. One passing by chance is
    // common (1 in 36); three at the same offset is not.
    if (r.gm.valid && r.sa.valid && r.vn.valid) {
      return { gm: r.gm.body, sa: r.sa.body, vn: r.vn.body, offset: off };
    }
  }
  return null;
}

/**
 * The vehicle order, read from the result the ECU declared for it.
 * @param {Map<string, unknown>} values - The reply's results by name.
 * @param {string|null|undefined} resultName - The declared order result.
 * @returns {string|null} The order text, or null when the result is absent
 *   or carries no marker.
 */
function viFaFrom(values, resultName) {
  if (!resultName || !values.has(resultName)) return null;
  const s = String(values.get(resultName)).trim();
  return s && /[_#*%&|$]/.test(s) ? s : null;
}

/**
 * Is any character outside printable ASCII? Text is printable throughout; a
 * packed stream is not.
 * @param {string} s - The value as a string.
 * @returns {boolean} True for a packed (binary) value.
 */
function viIsPacked(s) {
  return Array.from(s).some((c) => {
    const b = c.charCodeAt(0);
    return b < 0x20 || b > 0x7e;
  });
}

/**
 * Is the region erased or never written (every byte 0x00 or 0xFF)?
 * @param {string} s - The stream as a string.
 * @returns {boolean} True when nothing in it can be an order.
 */
function viIsErased(s) {
  return (
    !s ||
    !Array.from(s).some((c) => {
      const b = c.charCodeAt(0);
      return b !== 0 && b !== 0xff;
    })
  );
}

/**
 * The vehicle order as TEXT, whatever form the module keeps it in.
 *
 * A ZCS-era coding module (E46 c_kmb46, c_lsza) hands the order back exactly
 * as its memory holds it: a bit-packed stream, six bits a character, that
 * starts with a version byte and carries no marker characters at all. EDIABAS
 * ships the decoder for that stream as its own SGBD -- FA.PRG's
 * FA_STREAM2STRUCT takes the block number and the raw stream and answers
 * with the marker-delimited order (STANDARD_FA) the parser understands. So a
 * reply that is not already text is put through that job, and only the
 * job's own answer is trusted: no hand-rolled unpacking of a format BMW
 * already decodes for us.
 *
 * Text or stream is decided by the BYTES, never by which characters happen
 * to occur: a packed stream carries 0x24 ('$') as data, and reading that
 * as "it has a marker, so it is text" fed the raw bytes to the order
 * parser.
 * @param {Map<string, unknown>} values - The reply's results by name.
 * @param {string|null|undefined} resultName - The declared order result.
 * @returns {Promise<string|null>} The order text, or null when the reply
 *   holds none or the decoder refuses it.
 */
async function viFaText(values, resultName) {
  if (!resultName || !values.has(resultName)) return null;
  const raw = values.get(resultName);
  const stream = Array.isArray(raw)
    ? String.fromCharCode(...raw.map((b) => Number(b) & 0xff))
    : String(raw);
  if (!viIsPacked(stream)) return viFaFrom(values, resultName);
  // an empty or erased region (all 0xFF / 0x00) carries no order
  if (viIsErased(stream)) return null;
  try {
    const decoded = await viRunValues(
      VI_FA_DECODER.sgbd,
      VI_FA_DECODER.job,
      `${VI_FA_BLOCK};${stream}`
    );
    const status = decoded.has('JOB_STATUS')
      ? String(decoded.get('JOB_STATUS'))
      : '';
    if (status !== 'OKAY') return null;
    return viFaFrom(decoded, VI_FA_DECODER.result);
  } catch (e) {
    return null;
  }
}

/**
 * Run a job and answer with its results by name. flatResults drops the
 * engine's JOB_STATUS as non-data, which it is for display -- but a decoder
 * (FA_STREAM2STRUCT) says whether it understood its input ONLY through that
 * status, so it travels along here under its own name.
 * @param {string} sgbd - The SGBD.
 * @param {string} job - The job.
 * @param {string|null} [arg] - The job argument, if any.
 * @returns {Promise<Map<string, unknown>>} Results by name, JOB_STATUS
 *   included when the engine reported one.
 */
async function viRunValues(sgbd, job, arg) {
  const q = arg != null ? `?arg=${encodeURIComponent(arg)}` : '';
  const d = await api(`/api/ecu/${sgbd}/run/${job}${q}`, { method: 'POST' });
  const values = new Map(flatResults(d.sets));
  const status = (d.sets || [])
    .map((s) => s && s.JOB_STATUS)
    .find((v) => v != null);
  if (status != null) values.set('JOB_STATUS', String(status));
  return values;
}

/**
 * The VIN as the car is registered by: a coding SGBD's C_FG_LESEN answers
 * with the check character appended (WBAET37495NJ87379 + Q), the diagnostic
 * SGBDs without it. The check is verified where the Mod-36 helper is
 * loaded, and the body is what the row shows either way.
 * @param {unknown} v - The VIN result.
 * @returns {string} The VIN without its check character, or the value as
 *   given when it is not an 18-character checked VIN.
 */
function viVinBody(v) {
  const s = String(v || '')
    .toUpperCase()
    .replace(/\s/g, '');
  if (!new RegExp(`^[A-Z0-9]{${VI_VIN_CHECKED_LEN}}$`).test(s)) return s;
  if (typeof CodingEncode !== 'undefined' && CodingEncode.vinCheckChar) {
    try {
      if (CodingEncode.vinCheckChar(s.slice(0, VI_VIN_LEN)) !== s[VI_VIN_LEN])
        return s;
    } catch (e) {
      /* no helper: trust the shape */
    }
  }
  return s.slice(0, VI_VIN_LEN);
}

/**
 * A full 17-char VIN carries the type key at positions 4..7 (WBA AV36 ...).
 * A short VIN cannot say; the row stays honest and empty.
 * @param {unknown} vin - The VIN.
 * @returns {string|null} The type key, or null for a short VIN.
 */
function viTypeKey(vin) {
  const v = String(vin || '')
    .toUpperCase()
    .replace(/\s/g, '');
  return new RegExp(`^[A-Z0-9]{${VI_VIN_LEN}}$`).test(v)
    ? v.slice(VI_VIN_TYPE_KEY[0], VI_VIN_TYPE_KEY[1])
    : null;
}
