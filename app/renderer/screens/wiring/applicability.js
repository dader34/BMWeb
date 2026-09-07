/**
 * @file Wiring applicability: match diagrams and documents to a decoded VIN
 * using BMW's OWN validity data.
 *
 * Every WDS wiring schematic (an "SP" doc) carries a validity rule in ISTA's
 * DiagDocDb keyed by the same id; the rule names the chassis (E-Bezeichnung)
 * and engine (Motor) the diagram is valid for. tools/wiring/build_applicability.py
 * decodes those rule BLOBs offline into data/wiring-applicability.json.gz:
 *
 *     { "sp": { "SP0000014320": { "c": ["E46"], "e": ["S54"] }, ... } }
 *
 * c = chassis codes the doc applies to, e = engine codes. This is BMW's real
 * applicability (from ISTA's own validity rules) -- NOT parsed from the
 * diagram name. A doc missing from the index, or with no c/e, is "generally
 * valid" and always shows.
 *
 * Match rule against a decoded VIN {chassis, motor, body}:
 *   off      -> the doc names a chassis set and the VIN's chassis isn't in it,
 *               OR it names an engine set and the VIN's engine isn't in it,
 *               OR it names a body set and the VIN's body isn't in it
 *   match    -> the doc constrains chassis / engine / body and the VIN
 *               satisfies every constraint it names
 *   neutral  -> the doc has no constraint (generally valid), or we can't decide
 *
 * The index loads lazily (fetched once, cached). Until it's loaded, match()
 * returns 'neutral' so nothing is hidden.
 *
 * ISTA reference documents (.docs archives) embed the same rule shape per
 * document ({e, b}), so the merged wiring/documents screen scores them with
 * the same matchRule.
 */

/**
 * One applicability rule: the sets a document is valid for. Every field is
 * optional; an absent or empty set constrains nothing.
 * @typedef {Object} WiringApplicabilityRule
 * @property {string[]} [c] - chassis codes (E46, E39, ...)
 * @property {string[]} [e] - engine codes, matched exactly (M54 != M54N != S54)
 * @property {string[]} [b] - ISTA body codes (LIM, COU, TOU, ...)
 * @property {string} [f] - build date from (YYYYMM, >=), carried but not applied
 * @property {string} [t] - build date to (YYYYMM, <=), carried but not applied
 */

/**
 * How a document relates to the decoded VIN: it names the car ('match'), it
 * names a different car ('off'), or it constrains nothing decidable
 * ('neutral').
 * @typedef {'match' | 'off' | 'neutral'} WiringVinMatch
 */

(function () {
  'use strict';

  /** @type {{sp: Object<string, WiringApplicabilityRule>} | null} */
  let INDEX = null;
  /** @type {Promise<{sp: Object<string, WiringApplicabilityRule>}> | null} */
  let loading = null;

  /** The empty index: nothing constrained, everything neutral. */
  const EMPTY_INDEX = () => ({ sp: {} });

  /**
   * Load the applicability index once. Tolerates gz or plain JSON; any failure
   * (missing file, no inflater, bad JSON) yields an empty index so the screen
   * shows everything rather than nothing.
   * @returns {Promise<{sp: Object<string, WiringApplicabilityRule>}>}
   */
  async function loadIndex() {
    if (INDEX) return INDEX;
    if (loading) return loading;
    loading = (async () => {
      const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
      const url = `${base}/data/wiring/applicability.json.gz`;
      try {
        const r = await fetch(url);
        if (!r || !r.ok) {
          INDEX = EMPTY_INDEX();
          return INDEX;
        }
        const buf = new Uint8Array(await r.arrayBuffer());
        let text;
        const isGz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
        if (isGz) {
          if (typeof fflate === 'undefined') {
            INDEX = EMPTY_INDEX();
            return INDEX;
          }
          text = fflate.strFromU8(fflate.gunzipSync(buf));
        } else {
          text = new TextDecoder('utf-8').decode(buf);
        }
        INDEX = JSON.parse(text);
        if (!INDEX.sp) INDEX = EMPTY_INDEX();
      } catch {
        INDEX = EMPTY_INDEX();
      }
      return INDEX;
    })();
    return loading;
  }

  /**
   * Upper-case a code for comparison; null and undefined become ''.
   * @param {unknown} s - any code value
   * @returns {string}
   */
  const up = (s) => String(s == null ? '' : s).toUpperCase();

  /**
   * ISTA body codes (LIM/COU/TOU/CAB/COM/ROA/SAV...) vs the vin-index body codes
   * decodeVin returns (Lim/Cou/Cab/Roa/SAV/CM...). Maps the VIN's body to the
   * ISTA code so a doc's body constraint can be compared.
   * @type {Object<string, string>}
   */
  const BODY_TO_ISTA = {
    LIM: 'LIM',
    COU: 'COU',
    CAB: 'CAB',
    ROA: 'ROA',
    SAV: 'SAV',
    SAC: 'SAC',
    SAT: 'SAT',
    MPV: 'MPV',
    TOU: 'TOU',
    COM: 'COM',
    CM: 'COM',
    HB: 'HAT',
    HC: 'HAT',
    GC: 'HAT',
    GT: 'HAT',
  };

  /**
   * Translate a vin-index body code into ISTA's; unknown codes pass through
   * upper-cased.
   * @param {string} b - body code as decodeVin returns it
   * @returns {string}
   */
  const istaBody = (b) => BODY_TO_ISTA[up(b)] || up(b);

  /**
   * Score one applicability rule against a decoded VIN. Each constraint the
   * rule names AND the VIN can answer (a rule with engines but a VIN with no
   * engine skips that test) decides the result; a rule naming nothing
   * decidable is 'neutral'.
   *
   * Build dates (f / t) are carried for the caption but NOT used to exclude.
   * ISTA's date behaviour is a presentation heuristic (viewers keep the window
   * straddling the build date PLUS the adjacent ones, and dedup identical
   * docs) rather than strict containment -- a strict prod-in-window filter
   * both over- and under-excludes against the reference behaviour. Chassis +
   * engine + body is the authoritative applicability; showing every
   * date-variant of a matched component is a safe superset.
   * @param {WiringApplicabilityRule | null | undefined} rec - the rule
   * @param {{chassis?: string, motor?: string, body?: string} | null} hit - the decoded VIN
   * @returns {WiringVinMatch}
   */
  function matchRule(rec, hit) {
    if (!rec || !hit) return 'neutral';
    let decided = false,
      ok = true;
    if (rec.c && rec.c.length && hit.chassis) {
      decided = true;
      if (!rec.c.some((c) => up(c) === up(hit.chassis))) ok = false;
    }
    if (ok && rec.e && rec.e.length && hit.motor) {
      decided = true;
      const m = up(hit.motor);
      // engine codes match exactly (M54 != M54N != S54)
      if (!rec.e.some((e) => up(e) === m)) ok = false;
    }
    if (ok && rec.b && rec.b.length && hit.body) {
      decided = true;
      const b = istaBody(hit.body);
      if (!rec.b.some((x) => up(x) === b)) ok = false;
    }
    if (!decided) return 'neutral';
    return ok ? 'match' : 'off';
  }

  /**
   * Match one SP doc against a decoded VIN. Needs the index preloaded; returns
   * 'neutral' if the doc isn't indexed or nothing is decidable.
   * @param {string} spId - the SP doc id the tree carries (leaf.doc)
   * @param {{chassis?: string, motor?: string, body?: string} | null} hit - the decoded VIN
   * @returns {WiringVinMatch}
   */
  function matchDoc(spId, hit) {
    if (!INDEX || !INDEX.sp || !hit) return 'neutral';
    return matchRule(INDEX.sp[spId], hit); // unindexed = generally valid
  }

  window.wiringApplicability = {
    load: loadIndex,
    // match(spId, hit): the doc id is what the tree carries (leaf.doc)
    match: matchDoc,
    // matchRule(rec, hit): the same scoring for a rule carried inline (ISTA
    // documents embed theirs)
    matchRule: matchRule,
    ready: () => !!INDEX,
    // map a VIN-index body code to ISTA's, for filtering ISTA docs by body
    istaBody: istaBody,
  };
  // a small global alias the merged wiring/docs screen uses for doc VIN matching
  window.istaBodyOf = istaBody;
})();
