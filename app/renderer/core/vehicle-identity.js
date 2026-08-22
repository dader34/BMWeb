// vehicle-identity: what the car says it is, and what equipment it carries.
//
// Two vehicle-level identity records, on different generations of car:
//
//   ZCS (Zentral-Codier-Schluessel) -- E36..E53. Three keys (GM/SA/VN) in a
//        20-byte region on the cluster or light module. The SA key is a
//        64-bit FIELD OF BITS, not a list of option numbers.
//   FA  (Fahrzeugauftrag) -- E60 and later. The build order as TEXT, whose
//        `$` tokens ARE the SA catalog numbers.
//
// WHY THIS MODULE EXISTS. An SGET row decides whether the car has an ECU by
// testing a predicate over SA CATALOG NUMBERS (S205 = automatic, S210 = DSC).
// A ZCS key can only say "bit 45 is set". Comparing those two directly is a
// namespace error: measured on a real E46 it hid 37 of 44 modules, DSC and
// the airbag among them, which is why the equipment filter has been sitting
// disabled behind an unconditional `return mods`.
//
// BMW ships the translation as two text tables (tools/decompile/ncs_tables.py):
//
//   ZST -> which keywords hold when given key bits are set
//   AT  -> which SA number each keyword belongs to
//
// so the chain is
//
//   ZCS keys -> ZST mask match -> keywords -> AT -> SA numbers -> SGET
//
// On FA cars none of that is needed: the `$` tokens are already SA numbers.
// That is the whole reason an FA read is worth having beyond showing a build
// sheet -- it sidesteps the bridge entirely.
//
// COVERAGE IS PARTIAL AND SAYS SO. Of 63 E46 ZST keywords only 12 carry an SA
// number; the rest are body, engine and market names (LIM, COUP, M52B25, US)
// that have no catalog number by design. So this module reports what it could
// resolve AND what it could not, and callers must treat an unresolved car as
// "filter unknown" rather than "option absent" -- see saCodesFromZcs().

(function (root) {
  'use strict';

  const Zcs = (typeof window !== 'undefined' && window.CodingZcs)
    ? window.CodingZcs
    : (typeof require === 'function' ? require('./coding-zcs.js') : null);

  // ---- table access ------------------------------------------------------

  function tables() {
    return (typeof window !== 'undefined' && window.BMW_TABLES) || null;
  }

  // A chassis's tables, or null. Chassis ids arrive in mixed case from routes.
  function tablesFor(chassis) {
    const t = tables();
    if (!t) return null;
    const id = String(chassis || '').toUpperCase();
    return t[id] || null;
  }

  // ---- SGFAM: which ECU holds the identity --------------------------------

  // The ECUs that can answer an identity read, in the order the UI should
  // offer them: [{ sg, cabd, asw, fa, zcs }].
  //
  // Derived from SGFAM's own flag columns rather than a hardcoded per-chassis
  // list, because the answer differs by chassis AND by which SGFAM ships: on
  // E46 it is AKMB and KMB (both CABD C_KMB46), ALSZ (C_LSZA) and EWS
  // (C_EWS3), with FA and ZCS split across them.
  function identityMasters(chassis) {
    const t = tablesFor(chassis);
    const sgfam = t && t.sgfam;
    if (!sgfam) return [];
    return Object.keys(sgfam)
      .filter((sg) => sgfam[sg].fa || sgfam[sg].zcs)
      .sort()
      .map((sg) => ({
        sg,
        cabd: sgfam[sg].cabd,
        asw: sgfam[sg].asw,
        fa: !!sgfam[sg].fa,
        zcs: !!sgfam[sg].zcs,
      }));
  }

  // The whole family map, for showing which SGBD backs a logical ECU name.
  function familyMap(chassis) {
    const t = tablesFor(chassis);
    return (t && t.sgfam) || null;
  }

  // ---- ZST: ZCS key bits -> equipment keywords ----------------------------

  // Does `key` (hex string) have every bit of `mask` (hex string) set?
  //
  // The keys are up to 64 bits, past what a JS number holds exactly, so this
  // compares nibble by nibble rather than going through parseInt.
  function maskHolds(key, mask) {
    if (!key || !mask || key.length !== mask.length) return false;
    let any = false;
    for (let i = 0; i < mask.length; i++) {
      const m = parseInt(mask[i], 16);
      if (!m) continue;                       // this nibble is unconstrained
      any = true;
      const k = parseInt(key[i], 16);
      if (Number.isNaN(k) || (k & m) !== m) return false;
    }
    return any;                               // all-zero mask matches nothing
  }

  // Every ZST row whose masks hold for these keys.
  //
  // A row constrains any combination of GM, SA and VN, and an all-zero row is
  // BMW retiring an entry ("ausblenden fuer ZEKO") rather than a wildcard --
  // so a row matches only where it actually constrains something, and every
  // field it does constrain must hold.
  function zstMatches(chassis, keys) {
    const t = tablesFor(chassis);
    const rows = (t && t.zst) || [];
    const gm = up(keys && keys.gm);
    const sa = up(keys && keys.sa);
    const vn = up(keys && keys.vn);
    return rows.filter((r) => {
      if (r.empty) return false;
      let held = false;
      for (const [field, key] of [['gm', gm], ['sa', sa], ['vn', vn]]) {
        const mask = r[field];
        if (!mask || !/[^0]/.test(mask)) continue;   // unconstrained here
        if (!maskHolds(key, mask)) return false;     // constrained and failed
        held = true;
      }
      return held;
    });
  }

  function up(s) {
    return s == null ? '' : String(s).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  }

  // ---- the bridge: ZCS -> SA catalog numbers ------------------------------

  // What the car's ZCS keys say about its equipment.
  //
  // Returns { codes, keywords, ci, resolved, unresolved } where
  //   codes      SA catalog numbers, the namespace SGET predicates use
  //   keywords   every ZST keyword that held, resolved or not
  //   ci         { SG: index } coding-index stamps (KMBI_CI_04 -> KMBI: 4),
  //              which say WHICH .Cxx a module should be read against
  //   unresolved keywords carrying no SA number -- body/engine/market names,
  //              and the reason a caller must not read "no code" as "no option"
  function saCodesFromZcs(chassis, keys) {
    const t = tablesFor(chassis);
    const at = (t && t.at) || null;
    const rows = zstMatches(chassis, keys);
    const keywords = [];
    const ci = {};
    for (const r of rows) {
      for (const k of r.keywords) if (!keywords.includes(k)) keywords.push(k);
      for (const sg of Object.keys(r.ci || {})) ci[sg] = r.ci[sg];
    }
    const codes = [];
    const unresolved = [];
    for (const k of keywords) {
      const nums = at && at.kw && at.kw[k];
      if (nums && nums.length) {
        for (const n of nums) if (!codes.includes(n)) codes.push(n);
      } else {
        unresolved.push(k);
      }
    }
    return {
      codes: codes.sort((a, b) => Number(a) - Number(b)),
      keywords, ci, unresolved,
      resolved: codes.length > 0,
      rows: rows.length,
    };
  }

  // ---- FA: the vehicle order, as text -------------------------------------
  //
  // Wire form:
  //   E46_#0303*BW32%0A08&N6TT|7531125$205$210
  //     ^BR  ^date ^type ^lack ^polster ^zusbau ^SA...
  //
  // Two traps, both of which produce a rejected write if got wrong:
  //
  //   1. `#` belongs to the token. The order dictionary keys date codes by
  //      their `#`-prefixed form, so stripping it loses the lookup.
  //   2. The marker is set by the SLOT a token sits in, not by what category
  //      the dictionary puts it in. Rebuilding from dictionary category is
  //      what turns every marker into `$` and gets the order rejected.
  //
  // So the parse keeps each token's own marker, and the rebuild replays them.

  const FA_MARKERS = {
    '_': 'br',
    '#': 'date',
    '*': 'typ',
    '%': 'lack',
    '&': 'polster',
    '|': 'zusbau',
    '$': 'sa',
  };

  // "E46_#0303*BW32..." -> { br, date, typ, lack, polster, zusbau[], sa[],
  //                          tokens[{marker,value}], raw }
  // Returns null for input that carries no marker at all.
  function parseFa(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    // The chassis is everything before the first marker; `_` terminates it.
    const first = raw.search(/[_#*%&|$]/);
    if (first < 0) return null;
    const out = {
      br: raw.slice(0, first) || null,
      date: null, typ: null, lack: null, polster: null,
      zusbau: [], sa: [], tokens: [], raw,
    };
    // Walk marker-delimited runs, keeping the marker with its value.
    const re = /([_#*%&|$])([^_#*%&|$]*)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const marker = m[1];
      // `#` is part of the value (the dictionary keys dates as "#0303"),
      // every other marker is a separator only.
      const value = (marker === '#' ? '#' : '') + m[2];
      const field = FA_MARKERS[marker];
      out.tokens.push({ marker, value, field });
      switch (field) {
        case 'br': if (m[2]) out.br = m[2]; break;
        case 'date': out.date = value; break;
        case 'typ': out.typ = m[2]; break;
        case 'lack': out.lack = m[2]; break;
        case 'polster': out.polster = m[2]; break;
        case 'zusbau': if (m[2]) out.zusbau.push(m[2]); break;
        case 'sa': if (m[2]) out.sa.push(m[2]); break;
        default: break;
      }
    }
    return out;
  }

  // Back to the wire form, replaying each token's OWN marker. Round-trips
  // parseFa exactly; that is what the test asserts, because a rebuild that
  // re-derives markers from category is the documented way to corrupt an order.
  function formatFa(fa) {
    if (!fa) return '';
    let out = fa.br || '';
    for (const t of fa.tokens || []) {
      // the `#` a date carries in its value is the marker itself
      const v = t.marker === '#' ? String(t.value).replace(/^#/, '') : t.value;
      out += t.marker + v;
    }
    return out;
  }

  // The SA numbers an order carries, normalised to the unpadded form SGET
  // predicates use (S205, never S0205).
  function saCodesFromFa(fa) {
    const f = (typeof fa === 'string') ? parseFa(fa) : fa;
    if (!f) return [];
    const out = [];
    for (const s of f.sa) {
      const n = String(s).replace(/[^0-9]/g, '');
      if (!n) continue;
      const k = String(parseInt(n, 10));
      if (!out.includes(k)) out.push(k);
    }
    return out.sort((a, b) => Number(a) - Number(b));
  }

  // What an SA number means, from the order dictionary. Falls back to null so
  // a caller can show the bare number rather than invent a label.
  function saLabel(chassis, code) {
    const t = tablesFor(chassis);
    const at = t && t.at;
    const key = String(code).replace(/[^0-9]/g, '');
    if (!at || !at.sa || !key) return null;
    const names = at.sa[String(parseInt(key, 10))];
    return (names && names.length) ? names.join(', ') : null;
  }

  // ---- ZCS region off a raw read ------------------------------------------

  // Pull the three keys out of a 20-byte ZCS region. Thin wrapper over
  // coding-zcs so callers get {gm,sa,vn} without knowing the layout.
  function keysFromRegion(bytes) {
    if (!Zcs || !bytes || bytes.length < 20) return null;
    try {
      const r = Zcs.parseZcsRegion(bytes.slice(0, 20));
      return { gm: r.gm, sa: r.sa, vn: r.vn, region: r };
    } catch (e) {
      return null;
    }
  }

  const api = {
    identityMasters, familyMap,
    zstMatches, maskHolds,
    saCodesFromZcs,
    parseFa, formatFa, saCodesFromFa, saLabel,
    keysFromRegion,
    FA_MARKERS,
  };

  root.VehicleIdentity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
