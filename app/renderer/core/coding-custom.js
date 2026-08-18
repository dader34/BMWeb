// coding-custom: user-defined coding parameters, overlaid on BMW's DATEN.
//
// BMW's DATEN describes a lot of a coding block, but not all of it -- every
// module has bytes no PARZUWEISUNG_FSW row claims. Community coding knowledge
// lives exactly there ("byte 5 bit 2 is the welcome-light delay"), and today
// that knowledge has nowhere to go: the app renders BMW's description and
// nothing else.
//
// A custom parameter is a row the USER adds: a name, an address (block, byte
// offset, mask) and a value list. Once added it renders, filters, stages and
// writes exactly like a BMW-described field, because it IS one -- the same
// {name, block, word, byte, mask, shift, values} shape datenmap.js emits, so
// coding-encode's splice and the write path need no special case.
//
// TWO RULES, both load-bearing:
//
//   1. VENDOR DATA IS READ-ONLY. Nothing here mutates BMW_DATEN_MAP. The
//      overlay lives in localStorage and is merged into a COPY at read time.
//      Re-generating datenmap.js never destroys a user's parameters, and a
//      user's parameter never corrupts the shipped description.
//
//   2. SYNTHETIC IDS START AT 0xF000. BMW's FSW ids are well below that, so a
//      custom row can never collide with a real one, and `isCustom()` is a
//      cheap numeric test rather than a lookup.
//
// The address is the dangerous part -- a wrong mask writes the wrong bits --
// so addCustom() validates hard and refuses anything it cannot place.

(function (root) {
  'use strict';

  const STORE_KEY = 'bmweb.coding.custom';
  const ID_BASE = 0xf000;      // synthetic ids start here
  const ID_MAX = 0xffff;

  function store() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { /* private mode: fall through */ }
    return null;
  }

  function readAll() {
    const s = store();
    if (!s) return {};
    try {
      const v = JSON.parse(s.getItem(STORE_KEY) || '{}');
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) {
      return {};
    }
  }

  function writeAll(all) {
    const s = store();
    if (!s) return false;
    try {
      s.setItem(STORE_KEY, JSON.stringify(all));
      return true;
    } catch (e) {
      return false;              // quota: caller reports, never throws
    }
  }

  // key: one module's overlay is scoped to (sgbd, chassis, variant). The same
  // byte means different things across variants -- that is the whole reason
  // BMW ships one file per coding index -- so a custom row must not leak
  // between them.
  function keyOf(sgbd, chassis, variant) {
    return [String(sgbd || '').toLowerCase(),
            String(chassis || '').toUpperCase(),
            String(variant || '')].join('|');
  }

  function isCustom(field) {
    return !!(field && field.custom);
  }

  // ---- validation ----------------------------------------------------------

  // Everything that must hold before a row can address real bytes. Returns an
  // error STRING (so the UI can show it) or null when the row is placeable.
  function validate(row, existing) {
    if (!row || typeof row !== 'object') return 'no parameter given';

    const name = String(row.name || '').trim();
    if (!name) return 'name is required';
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name)) {
      return 'name must start with a letter and use only letters, digits, '
        + '_ or - (max 40)';
    }

    const word = Number(row.word);
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) {
      return 'byte offset must be a whole number between 0 and 65535';
    }

    const width = Number(row.byte == null ? 1 : row.byte);
    if (!Number.isInteger(width) || width < 1 || width > 64) {
      return 'width must be a whole number of bytes between 1 and 64';
    }

    const mask = Number(row.mask == null ? 0xff : row.mask);
    if (!Number.isInteger(mask) || mask < 0 || mask > 0xff) {
      return 'mask must be a byte between 0x00 and 0xFF';
    }
    if (mask === 0) return 'mask 0x00 selects no bits';

    // A multi-byte field must take whole bytes: the codec masks only byte 0
    // and reads the rest raw, so a partial mask on a wide field would write
    // bits the user did not ask for.
    if (width > 1 && mask !== 0xff) {
      return 'a field wider than one byte must use mask 0xFF';
    }

    const values = Array.isArray(row.values) ? row.values : [];
    for (const v of values) {
      if (!Array.isArray(v) || v.length !== 2) {
        return 'each value must be a [label, hex] pair';
      }
      if (!String(v[0] || '').trim()) return 'a value label is empty';
      if (!/^[0-9a-fA-F]+$/.test(String(v[1] || ''))) {
        return `value "${v[0]}" must be hex`;
      }
    }
    // Duplicate labels make the picker ambiguous.
    const labels = values.map((v) => String(v[0]).toLowerCase());
    if (new Set(labels).size !== labels.length) {
      return 'two values share a label';
    }

    // Name collision inside the same module/variant -- including against
    // BMW's own rows, which the caller passes in.
    const lower = name.toLowerCase();
    for (const f of (existing || [])) {
      if (String(f.name || '').toLowerCase() === lower) {
        return `"${name}" already exists in this module`;
      }
    }
    return null;
  }

  // Does this row's mask overlap a BMW-described field at the same address?
  // Not fatal -- overlapping a known field is sometimes exactly the point --
  // but the UI should say so before the user writes it.
  function overlaps(row, fields) {
    const hits = [];
    const word = Number(row.word);
    const mask = Number(row.mask == null ? 0xff : row.mask);
    for (const f of (fields || [])) {
      if (Number(f.word) !== word) continue;
      const fm = Number(f.mask == null ? 0xff : f.mask);
      if ((fm & mask) !== 0) hits.push(f.name);
    }
    return hits;
  }

  // ---- CRUD ----------------------------------------------------------------

  function list(sgbd, chassis, variant) {
    const all = readAll();
    const rows = all[keyOf(sgbd, chassis, variant)];
    return Array.isArray(rows) ? rows : [];
  }

  function nextId(rows) {
    let id = ID_BASE;
    const used = new Set((rows || []).map((r) => Number(r.id)));
    while (used.has(id) && id < ID_MAX) id++;
    return id;
  }

  // addCustom(...) -> {ok:true, field} | {ok:false, err}
  // `existing` is the module's current field list (BMW's + any custom), used
  // for the name-collision and overlap checks.
  function addCustom(sgbd, chassis, variant, row, existing) {
    const err = validate(row, existing);
    if (err) return { ok: false, err };

    const rows = list(sgbd, chassis, variant);
    const width = Number(row.byte == null ? 1 : row.byte);
    const mask = Number(row.mask == null ? 0xff : row.mask);
    // shift = trailing-zero count of the mask, the same geometry
    // coding-encode uses to place a value inside its byte
    let shift = 0;
    while (shift < 8 && !((mask >> shift) & 1)) shift++;

    const field = {
      id: nextId(rows),
      name: String(row.name).trim(),
      block: Number(row.block == null ? 0 : row.block),
      word: Number(row.word),
      byte: width,
      mask,
      shift,
      values: (row.values || []).map((v) => [String(v[0]).trim(),
                                             String(v[1]).toUpperCase()]),
      custom: true,
      note: row.note ? String(row.note).slice(0, 200) : undefined,
    };

    rows.push(field);
    const all = readAll();
    all[keyOf(sgbd, chassis, variant)] = rows;
    if (!writeAll(all)) {
      return { ok: false, err: 'could not save (browser storage unavailable '
        + 'or full)' };
    }
    return { ok: true, field };
  }

  function removeCustom(sgbd, chassis, variant, id) {
    const all = readAll();
    const k = keyOf(sgbd, chassis, variant);
    const rows = Array.isArray(all[k]) ? all[k] : [];
    const keep = rows.filter((r) => Number(r.id) !== Number(id));
    if (keep.length === rows.length) return false;
    if (keep.length) all[k] = keep; else delete all[k];
    return writeAll(all);
  }

  // ---- the overlay ---------------------------------------------------------

  // Merge a module's custom rows onto BMW's field list. Returns a NEW array;
  // the input (which is BMW_DATEN_MAP's own array) is never touched. Custom
  // rows sort into their block so they appear under the right group header.
  function mergeCustom(fields, sgbd, chassis, variant) {
    const rows = list(sgbd, chassis, variant);
    if (!rows.length) return fields;
    const out = (fields || []).slice();
    for (const r of rows) {
      // place after the last field of the same block, else at the end
      let at = -1;
      for (let i = out.length - 1; i >= 0; i--) {
        if (Number(out[i].block) === Number(r.block)) { at = i + 1; break; }
      }
      if (at < 0) out.push(r); else out.splice(at, 0, r);
    }
    return out;
  }

  // Everything the user has defined, for an export / manage view.
  function exportAll() { return readAll(); }

  function importAll(obj, { merge = true } = {}) {
    if (!obj || typeof obj !== 'object') return false;
    const all = merge ? readAll() : {};
    for (const [k, rows] of Object.entries(obj)) {
      if (Array.isArray(rows)) all[k] = rows;
    }
    return writeAll(all);
  }

  const api = {
    ID_BASE,
    isCustom, validate, overlaps,
    list, addCustom, removeCustom, mergeCustom,
    exportAll, importAll,
    _keyOf: keyOf,
  };
  root.CodingCustom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
