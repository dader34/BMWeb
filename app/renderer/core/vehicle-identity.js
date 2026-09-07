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

  const Zcs =
    typeof window !== 'undefined' && window.CodingZcs
      ? window.CodingZcs
      : typeof require === 'function'
        ? require('./coding-zcs.js')
        : null;

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
      if (!m) continue; // this nibble is unconstrained
      any = true;
      const k = parseInt(key[i], 16);
      if (Number.isNaN(k) || (k & m) !== m) return false;
    }
    return any; // all-zero mask matches nothing
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
      for (const [field, key] of [
        ['gm', gm],
        ['sa', sa],
        ['vn', vn],
      ]) {
        const mask = r[field];
        if (!mask || !/[^0]/.test(mask)) continue; // unconstrained here
        if (!maskHolds(key, mask)) return false; // constrained and failed
        held = true;
      }
      return held;
    });
  }

  function up(s) {
    return s == null
      ? ''
      : String(s)
          .replace(/[^0-9A-Fa-f]/g, '')
          .toUpperCase();
  }

  // Every SABITS row (ZST.K00, SA number -> the bits that option sets)
  // whose masks hold for these keys. Same rule as zstMatches: a row is a
  // match only where it constrains something, and all it constrains holds.
  //
  // This is the table the factory ENCODES a key from, and it outlives the
  // decoding table: E39's ZST.000 retired 0194/0364/0645 and never listed
  // 0223/0316/0403/0677, all of which K00 still carries. Without it an E39
  // shows six of the thirteen options the car actually has.
  function sabitsMatches(chassis, keys) {
    const t = tablesFor(chassis);
    const rows = (t && t.sabits) || [];
    const gm = up(keys && keys.gm);
    const sa = up(keys && keys.sa);
    const vn = up(keys && keys.vn);
    return rows.filter((r) => {
      let held = false;
      for (const [field, key] of [
        ['gm', gm],
        ['sa', sa],
        ['vn', vn],
      ]) {
        const mask = r[field];
        if (!mask || !/[^0]/.test(mask)) continue;
        if (!maskHolds(key, mask)) return false;
        held = true;
      }
      return held;
    });
  }

  // ---- the type-key row: the ONE row that says what the car is -------------

  // Bits set in a hex mask.
  function popcount(mask) {
    let n = 0;
    for (const ch of String(mask || '')) {
      const v = parseInt(ch, 16);
      if (!Number.isNaN(v))
        n += (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1);
    }
    return n;
  }

  // A type-key row is one keyed by a type (DE93), not an option number, and
  // constraining the GM. Several hold for one car -- the GM column is a
  // mask, and 54110000 (DE11, the 535i) is a subset of 54930000 (DE93, the
  // M5) bit for bit -- so "holds" is not "is". The row that NAMES the car is
  // the most specific one: the exact value first, else the most bits. Its
  // keywords are the car's body, engine, gearbox and market; the weaker
  // rows' keywords (M62B35 for an S62 car) are not.
  function typeRows(chassis, keys) {
    const gm = up(keys && keys.gm);
    const t = tablesFor(chassis);
    const rows = (t && t.zst) || [];
    // ON THE GM ALONE. A type row may also stamp a VN bit (DE93 carries
    // 0000000001), but the type is the GM value; the SA/VN keys say what
    // was fitted, not what the car is, and must not veto the name.
    return rows
      .filter(
        (r) =>
          !r.empty &&
          r.gm &&
          /[^0]/.test(r.gm) &&
          !/^\d+$/.test(r.key) &&
          maskHolds(gm, r.gm)
      )
      .sort((a, b) => {
        const ea = a.gm === gm ? 1 : 0;
        const eb = b.gm === gm ? 1 : 0;
        return (
          eb - ea ||
          popcount(b.gm) - popcount(a.gm) ||
          b.keywords.length - a.keywords.length
        );
      });
  }

  // ---- which car is this: the chassis, from the GM key alone ---------------

  // The chassis a set of keys belongs to, ranked: [{ chassis, key, keywords,
  // exact, bits, rows }], best first, empty when no table claims the key.
  //
  // THIS IS HOW A PLUG-IN-AND-GO TOOL KNOWS THE CAR WITHOUT BEING TOLD. The
  // Grundmerkmal key (54930000) is the car's type key in BMW's own numbering,
  // and every chassis ZST carries the type-key rows for the types it was
  // built as (DE93 -> LIM, S62B50, MAN, LL, US). Asking every table for its
  // most specific holding type row names the chassis -- no address list, no
  // VIN prefix table, and it keeps working for a car whose VIN the cluster
  // cannot say in full. An exact type value beats any subset (E38's GJ83
  // mask sits inside the M5's GM bit for bit; DE93 equals it).
  function chassisFromKeys(keys) {
    const t = tables();
    if (!t) return [];
    const gm = up(keys && keys.gm);
    const out = [];
    for (const chassis of Object.keys(t)) {
      if (chassis.startsWith('_')) continue;
      const held = typeRows(chassis, keys);
      if (!held.length) continue;
      const best = held[0];
      out.push({
        chassis,
        key: best.key,
        keywords: best.keywords,
        exact: best.gm === gm,
        bits: popcount(best.gm),
        rows: held.length,
      });
    }
    return out.sort(
      (a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || b.bits - a.bits
    );
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
    // A BLANK SA KEY IS NOT AN EQUIPMENT LIST. An all-FF (or all-00) SA body
    // is an erased or never-programmed region -- and BMW's own "no special
    // equipment" key is FFFFFFFFFFFFFFFF with a valid check char, so it looks
    // structurally sound while carrying zero options. A modern car keeps its
    // real equipment in the FA (parseFa/saCodesFromFa); its legacy ZCS SA key
    // is legitimately blank. Matching that blank against the assignment table
    // invents SA numbers the car does not have (the phantom-options bug), so
    // decline here and let the caller fall back to the FA or report "no VO".
    if (
      Zcs &&
      typeof Zcs.isBlankSaKey === 'function' &&
      Zcs.isBlankSaKey(keys && keys.sa)
    ) {
      return {
        codes: [],
        keywords: [],
        ci: {},
        unresolved: [],
        resolved: false,
        rows: 0,
        blank: true,
      };
    }
    const t = tablesFor(chassis);
    const at = (t && t.at) || null;
    const rows = zstMatches(chassis, keys);
    // Of the type-key rows only the most specific one speaks for the car
    // (see typeRows); every other row is an option or a series stamp.
    const types = typeRows(chassis, keys);
    const spoken = new Set(types.slice(1));
    const keywords = [];
    const ci = {};
    for (const r of rows) {
      if (spoken.has(r)) continue;
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
    // A ZST row KEYED BY A NUMBER is an option row, and the key is the SA
    // number itself (H 0214 ... ASC): that is how the chassis without an AT
    // dictionary -- every ZCS chassis but E46 -- still name their options.
    // Type-key rows (DE93) and words (GVN, PU97) are not numbers and fall
    // through to the keyword path above.
    for (const r of rows) {
      if (!/^\d+$/.test(r.key)) continue;
      const n = String(parseInt(r.key, 10));
      if (!codes.includes(n)) codes.push(n);
    }
    // The SA numbers straight off the encoding table. Unpadded, the way the
    // AT numbers and the SGET predicates (S261) spell them.
    const bits = sabitsMatches(chassis, keys);
    for (const r of bits) {
      const n = String(parseInt(r.key, 10));
      if (!codes.includes(n)) codes.push(n);
    }
    return {
      codes: codes.sort((a, b) => Number(a) - Number(b)),
      keywords,
      ci,
      unresolved,
      resolved: codes.length > 0,
      rows: rows.length,
      bits: bits.length,
    };
  }

  // ---- FA: the vehicle order, as text -------------------------------------
  //
  // Wire form:
  //   E46_#0303*BW32%0A08&N6TT|7531125$205$210+633L-1234
  //     ^BR  ^date ^type ^lack ^polster ^zusbau ^SA...  ^HO word ^E word
  //
  // The marker set is FA.PRG's own: its decoder answers with SA_n, HO_WORT_n,
  // E_WORT_n and ZUSBAU_n, and STANDARD_FA spells them `$`, `+`, `-`, `|`.
  // A HO word (+633L) is a build code, not an option; read as the tail of
  // the SA before it, it turned `$992+633L` into a phantom option 992633.
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
    _: 'br',
    '#': 'date',
    '*': 'typ',
    '%': 'lack',
    '&': 'polster',
    '|': 'zusbau',
    $: 'sa',
    '+': 'howort',
    '-': 'ewort',
  };
  const FA_MARKER_RE = /[_#*%&|$+-]/;

  // "E46_#0303*BW32..." -> { br, date, typ, lack, polster, zusbau[], sa[],
  //                          howort[], ewort[], tokens[{marker,value}], raw }
  // Returns null for input that carries no marker at all.
  function parseFa(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    // The chassis is everything before the first marker; `_` terminates it.
    const first = raw.search(FA_MARKER_RE);
    if (first < 0) return null;
    const out = {
      br: raw.slice(0, first) || null,
      date: null,
      typ: null,
      lack: null,
      polster: null,
      zusbau: [],
      sa: [],
      howort: [],
      ewort: [],
      tokens: [],
      raw,
    };
    // Walk marker-delimited runs, keeping the marker with its value.
    const re = /([_#*%&|$+-])([^_#*%&|$+-]*)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const marker = m[1];
      // `#` is part of the value (the dictionary keys dates as "#0303"),
      // every other marker is a separator only.
      const value = (marker === '#' ? '#' : '') + m[2];
      const field = FA_MARKERS[marker];
      out.tokens.push({ marker, value, field });
      switch (field) {
        case 'br':
          if (m[2]) out.br = m[2];
          break;
        case 'date':
          out.date = value;
          break;
        case 'typ':
          out.typ = m[2];
          break;
        case 'lack':
          out.lack = m[2];
          break;
        case 'polster':
          out.polster = m[2];
          break;
        case 'zusbau':
          if (m[2]) out.zusbau.push(m[2]);
          break;
        case 'sa':
          if (m[2]) out.sa.push(m[2]);
          break;
        case 'howort':
          if (m[2]) out.howort.push(m[2]);
          break;
        case 'ewort':
          if (m[2]) out.ewort.push(m[2]);
          break;
        default:
          break;
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

  // An SA code as the catalogue spells it: a number loses its zero padding
  // (S205, never S0205, the way SGET predicates write it); a code that is
  // not a number (1CA, the E46 "Nummernschild" code) is itself. Stripping
  // such a code to its digits would turn it into a DIFFERENT option -- 1CA
  // is not SA 1 -- so anything that is not purely numeric is kept whole.
  // Returns null for an empty token.
  function saCode(s) {
    const v = String(s == null ? '' : s)
      .trim()
      .toUpperCase();
    if (!v) return null;
    return /^\d+$/.test(v) ? String(parseInt(v, 10)) : v;
  }

  // Numbers first, in order; then the alphanumeric codes as the order lists
  // them.
  function saCompare(a, b) {
    const na = /^\d+$/.test(a);
    const nb = /^\d+$/.test(b);
    if (na && nb) return Number(a) - Number(b);
    return na === nb ? 0 : na ? -1 : 1;
  }

  // The SA codes an order carries, normalised (see saCode). Only the `$`
  // tokens: the HO and E words beside them are build codes, not options.
  function saCodesFromFa(fa) {
    const f = typeof fa === 'string' ? parseFa(fa) : fa;
    if (!f) return [];
    const out = [];
    for (const s of f.sa) {
      const k = saCode(s);
      if (k && !out.includes(k)) out.push(k);
    }
    return out.sort(saCompare);
  }

  // What an SA number means, from the order dictionary. Falls back to null so
  // a caller can show the bare number rather than invent a label. The
  // dictionaries are keyed by number; an alphanumeric code has no entry and
  // must not borrow one by way of its digits.
  function saLabel(chassis, code) {
    const t = tablesFor(chassis);
    const at = t && t.at;
    const key = saCode(code);
    if (!at || !at.sa || !key || !/^\d+$/.test(key)) return null;
    const names = at.sa[key];
    return names && names.length ? names.join(', ') : null;
  }

  // What an SA number is CALLED, in English, off the ETK catalogue
  // (tools/etk_sa_names.py -> data/sanames.js). BMW reused numbers over the
  // years, so the name is chosen by the car's build date (YYYYMMDD; a
  // YYYYMM00 from the VIN index is fine). Without a date the earliest
  // window wins, since a bare number is most often quoted in its original
  // sense. Returns null when the catalogue does not know the number (or is
  // not loaded), so the caller falls back to the SGET keywords.
  //
  // Options ('S') outrank the country/package/accessory codes that share
  // the number space: <0807> is "National version Japan" only because no
  // option 807 exists.
  const SA_ART_RANK = { S: 0, L: 1, Q: 2, N: 3, Y: 4, X: 5, V: 6 };
  function saName(code, date) {
    const db = (typeof window !== 'undefined' && window.BMW_SA_NAMES) || null;
    const key = saCode(code);
    if (!db || !key || !/^\d+$/.test(key)) return null;
    const rows = db[key];
    if (!rows || !rows.length) return null;
    const d = Number(date) || 0;
    const rank = (r) => (r[0] in SA_ART_RANK ? SA_ART_RANK[r[0]] : 9);
    const inWindow = (r) => d >= r[1] && (!r[2] || d < r[2]);
    const pool = d ? rows.filter(inWindow) : rows;
    if (!pool.length) return null;
    const best = pool
      .slice()
      .sort((a, b) => rank(a) - rank(b) || a[1] - b[1])[0];
    return best[3] || null;
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
    identityMasters,
    familyMap,
    zstMatches,
    sabitsMatches,
    chassisFromKeys,
    typeRows,
    maskHolds,
    saCodesFromZcs,
    parseFa,
    formatFa,
    saCode,
    saCodesFromFa,
    saLabel,
    saName,
    keysFromRegion,
    FA_MARKERS,
  };

  root.VehicleIdentity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
