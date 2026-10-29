/**
 * @file Read Vin/ZCS from car, the way NCS Expert does it.
 *
 * No guessing which module holds what: the chassis's SGFAM marks the key
 * holders (ZCS column) and the order holders (FA column) -- on the E46 that
 * is EWS and KMB for the key, AKMB and ALSZ for the order -- and names each
 * one's coding SGBD and coding script. NCS runs those scripts' own read jobs
 * and takes what they hand back:
 *
 *   ZCS_LESEN            GM_SCHLUESSEL, SA_SCHLUESSEL, VN_SCHLUESSEL
 *   FA_READ / FA_LESEN   FA_STREAM (and its parts)
 *   FGNR_LESEN           FAHRGESTELL_NR -- the VIN, NCS's FG
 *
 * Every attempt is reported, so a car that answers nothing says which module
 * was asked, with which job, and what came back.
 *
 * An erased key is no key: NCS (coapiReadFgNr) passes over a holder whose
 * ZCS_LESEN answers all F -- FFFFFFFF / FFFFFFFFFFFFFFFF / FFFFFFFFFF, with
 * or without the check characters -- and asks the next one.
 */

/* exported ncsReadKeyFromCar */
/* global loadTables, codingScriptIndex, webCodingScript, webCodingReadJob */

/**
 * @typedef {object} NcsKeyRead
 * @property {{gm: string, sa: string, vn: string}|null} keys - the key.
 * @property {string} vin - the VIN (17 characters), '' when none was read.
 * @property {string} vinPart - a shorter VIN a module keeps (its last 7),
 *   when that is all that was read.
 * @property {string} fa - the vehicle order stream, '' when none.
 * @property {Array<{sg: string, sgbd: string, job: string, ok: boolean,
 *   info: string}>} tried - every job run, in order.
 */

/**
 * Read the car's key, order and VIN from the modules NCS reads them from.
 * @param {string} chassisId - chassis id.
 * @returns {Promise<NcsKeyRead>}
 */
async function ncsReadKeyFromCar(chassisId) {
  const out = { keys: null, vin: '', vinPart: '', fa: '', tried: [] };
  if (typeof loadTables === 'function') await loadTables();
  const tables = (typeof window !== 'undefined' && window.BMW_TABLES) || {};
  const ch = tables[String(chassisId || '').toUpperCase()];
  const sgfam = (ch && ch.sgfam) || {};
  const scripts =
    typeof codingScriptIndex === 'function' ? await codingScriptIndex() : {};
  // key holders first (ZCS), then order holders (FA), each in SGFAM's order
  const masters = Object.entries(sgfam)
    .filter(([, r]) => r && (r.zcs || r.fa))
    .sort(([, a], [, b]) => Number(!!b.zcs) - Number(!!a.zcs));

  const run = async (sg, row, job) => {
    const sgbd = String(row.cabd).toLowerCase();
    const dispatchKey = scripts[String(row.asw).toUpperCase()];
    if (!dispatchKey) {
      out.tried.push({
        sg,
        sgbd,
        job,
        ok: false,
        info: `${row.asw} not shipped`,
      });
      return null;
    }
    try {
      const r = await webCodingReadJob(sgbd, { dispatchKey, jobname: job });
      out.tried.push({ sg, sgbd, job, ok: r.ok, info: r.info || '' });
      return r.ok ? r.pars : null;
    } catch (e) {
      out.tried.push({
        sg,
        sgbd,
        job,
        ok: false,
        info: String((e && e.message) || e),
      });
      return null;
    }
  };
  /** The read jobs a script answers (its job list names them). */
  const jobsOf = async (row) => {
    const key = scripts[String(row.asw).toUpperCase()];
    const d = key && (await webCodingScript(key));
    const names = new Set();
    for (const ops of Object.values((d && d.procs) || {}))
      for (const o of ops || [])
        if (o && o.op === 'const' && typeof o.v === 'string') names.add(o.v);
    return names;
  };
  const vinOf = (p) => {
    const v = String((p && p.FAHRGESTELL_NR) || '')
      .trim()
      .toUpperCase();
    if (/^[A-HJ-NPR-Z0-9]{17}/.test(v)) return v.slice(0, 17);
    if (v && !out.vinPart) out.vinPart = v;
    return '';
  };
  const hexKey = (v) =>
    String(v || '')
      .replace(/[^0-9A-Fa-f]/g, '')
      .toUpperCase();

  for (const [sg, row] of masters) {
    if (out.keys && out.vin && out.fa) break;
    const jobs = await jobsOf(row);
    if (row.zcs && !out.keys && jobs.has('ZCS_LESEN')) {
      const p = await run(sg, row, 'ZCS_LESEN');
      const gm = hexKey(p && p.GM_SCHLUESSEL);
      const sa = hexKey(p && p.SA_SCHLUESSEL);
      const vn = hexKey(p && p.VN_SCHLUESSEL);
      const erased = [gm.slice(0, 8), sa.slice(0, 16), vn.slice(0, 10)].every(
        (k) => /^F+$/.test(k)
      );
      if (gm && sa && vn && erased) {
        const last = out.tried[out.tried.length - 1];
        if (last) last.info = 'erased key (all F), next holder';
      } else if (gm && sa && vn) out.keys = { gm, sa, vn };
    }
    if (row.fa && !out.fa) {
      const job = ['FA_READ', 'FA_LESEN'].find((j) => jobs.has(j));
      if (job) {
        const p = await run(sg, row, job);
        const fa = String((p && p.FA_STREAM) || '').trim();
        if (fa) out.fa = fa;
      }
    }
    if (!out.vin && jobs.has('FGNR_LESEN')) {
      out.vin = vinOf(await run(sg, row, 'FGNR_LESEN'));
    }
  }
  return out;
}

if (typeof window !== 'undefined') {
  window.ncsReadKeyFromCar = ncsReadKeyFromCar;
}
