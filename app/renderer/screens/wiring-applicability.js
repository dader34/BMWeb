// WIRING APPLICABILITY — match diagrams to a decoded VIN using BMW's OWN data.
//
// Every WDS wiring schematic (an "SP" doc) carries a validity rule in ISTA's
// DiagDocDb keyed by the same id; the rule names the chassis (E-Bezeichnung)
// and engine (Motor) the diagram is valid for. tools/wiring/build_applicability.py
// decodes those rule BLOBs offline into data/wiring-applicability.json.gz:
//
//     { "sp": { "SP0000014320": { "c": ["E46"], "e": ["S54"] }, ... } }
//
// c = chassis codes the doc applies to, e = engine codes. This is BMW's real
// applicability (from ISTA's own validity rules) -- NOT parsed from the
// diagram name. A doc missing from the index, or with no c/e, is "generally
// valid" and always shows.
//
// Match rule against a decoded VIN {chassis, motor}:
//   off      -> the doc names a chassis set and the VIN's chassis isn't in it,
//               OR it names an engine set and the VIN's engine isn't in it
//   match    -> the doc constrains chassis and/or engine and the VIN satisfies it
//   neutral  -> the doc has no constraint (generally valid), or we can't decide
//
// The index loads lazily (fetched once, cached). Until it's loaded, match()
// returns 'neutral' so nothing is hidden.

(function () {
  'use strict';

  let INDEX = null; // { sp: { SPID: {c:[],e:[]} } }
  let loading = null;

  // Load the applicability index. Tolerates gz or plain JSON, and the offline
  // folder handle (offlineReadFile) the file:// build uses.
  async function loadIndex() {
    if (INDEX) return INDEX;
    if (loading) return loading;
    loading = (async () => {
      const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
      const url = `${base}/data/wiring/applicability.json.gz`;
      try {
        const r = await fetch(url);
        if (!r || !r.ok) {
          INDEX = { sp: {} };
          return INDEX;
        }
        const buf = new Uint8Array(await r.arrayBuffer());
        let text;
        const isGz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
        if (isGz) {
          if (typeof fflate === 'undefined') {
            INDEX = { sp: {} };
            return INDEX;
          }
          text = fflate.strFromU8(fflate.gunzipSync(buf));
        } else {
          text = new TextDecoder('utf-8').decode(buf);
        }
        INDEX = JSON.parse(text);
        if (!INDEX.sp) INDEX = { sp: {} };
      } catch {
        INDEX = { sp: {} };
      }
      return INDEX;
    })();
    return loading;
  }

  const up = (s) => String(s == null ? '' : s).toUpperCase();

  // ISTA body codes (LIM/COU/TOU/CAB/COM/ROA/SAV...) vs the vin-index body codes
  // decodeVin returns (Lim/Cou/Cab/Roa/SAV/CM...). Map the VIN's body to the
  // ISTA code so a doc's Body constraint can be compared.
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
  const istaBody = (b) => BODY_TO_ISTA[up(b)] || up(b);

  // Match one SP doc against a decoded VIN. Needs the index preloaded; returns
  // 'neutral' if the doc isn't indexed or nothing is decidable.
  // hit = { chassis, motor, prod } — prod is YYYYMM(..) build date.
  // rec = { c:[chassis], e:[engine], f:dateFrom(YYYYMM,>=), t:dateTo(YYYYMM,<=) }
  function matchDoc(spId, hit) {
    if (!INDEX || !INDEX.sp || !hit) return 'neutral';
    const rec = INDEX.sp[spId];
    if (!rec) return 'neutral'; // generally valid / not indexed
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
    // Build dates (rec.f / rec.t) are carried for the caption but NOT used to
    // exclude. ISTA's date behaviour is a presentation heuristic (viewers keep
    // the window straddling the build date PLUS the adjacent ones, and dedups
    // identical docs) rather than strict containment -- a strict prod-in-window
    // filter both over- and under-excludes against the reference behaviour.
    // Chassis + engine + body is the authoritative applicability; showing every
    // date-variant of a matched component is a safe superset.
    if (!decided) return 'neutral';
    return ok ? 'match' : 'off';
  }

  window.wiringApplicability = {
    load: loadIndex,
    // match(spId, hit): the doc id is what the tree carries (leaf.doc)
    match: matchDoc,
    ready: () => !!INDEX,
    // map a VIN-index body code to ISTA's, for filtering ISTA docs by body
    istaBody: istaBody,
  };
  // a small global alias the merged wiring/docs screen uses for doc VIN matching
  window.istaBodyOf = istaBody;
})();
