/**
 * @file The value model of a coding function -- which of its DATEN values
 * are pickable options, which is current, how a byte displays in its unit --
 * and the chip renderer both the desktop tree and the mobile module view
 * draw from, so a function reads identically on either.
 */

/**
 * Per-function edit state, keyed "sgbd:name".
 * @typedef {Object} FunctionState
 * @property {string} current - the hex byte the car holds (or a stable pick).
 * @property {string|null} staged - the hex byte staged, or null when unchanged.
 */

/**
 * One pickable option: `[label, hexValue, final?]`. `final` marks a label
 * that is already display text (a decimal, or a merged "12 · Alpina") that
 * must NOT go through the keyword translator.
 * @typedef {[string, string] | [string, string, boolean]} TreeOption
 */

/** Longest hex a value may be and still count as a byte-sized number. */
const TREE_BYTE_HEX_MAX = 4;

/**
 * A value NAME that is a bare number (or wert_NN) is not a real setting name
 * -- it is a numeric field's raw byte from another variant, not an enum label.
 * @param {unknown} n - the value name.
 * @returns {boolean} true for a numeric name.
 */
function treeIsNumericName(n) {
  return (
    typeof n === 'number' ||
    /^-?\d+$/.test(String(n)) ||
    /^wert_\d+$/i.test(String(n))
  );
}

/**
 * All-numeric-named, byte-sized values: the shape that takes free entry.
 * @param {Array<[string, string]>} vals - the DATEN values.
 * @returns {boolean} true for a numeric field.
 */
function treeNumericField(vals) {
  return (
    vals.length > 0 &&
    vals.every(([n]) => treeIsNumericName(n)) &&
    vals.every(
      ([, v]) => typeof v === 'string' && v.length <= TREE_BYTE_HEX_MAX
    )
  );
}

/**
 * Sort options by their hex value.
 * @param {TreeOption} a - left.
 * @param {TreeOption} b - right.
 * @returns {number} sort order.
 */
const treeByValue = (a, b) => parseInt(a[1], 16) - parseInt(b[1], 16);

// Two shapes qualify: real setting names (aktiv/nicht_aktiv/automatik...),
// and NUMERIC fields whose variants disagree -- EWS's ABSCHALTDREHZAHL_ANLASSER
// ships 0a/0e/0b across engine fits, and those bytes ARE the choice BMW's tool
// offers, so they render as picks labelled by their decimal value (the names
// in the DATEN blob are meaningless line ids there). Empty when the function
// is not a choice at all -- including named options that all collapse to ONE
// byte (E46 EWS codes gasoline and diesel cut-off time identically: nothing to
// pick, so no buttons to show).
/**
 * The pickable options of a function, excluding buffers.
 * @param {Array<[string, string]>} vals - the DATEN values.
 * @returns {TreeOption[]} the options; empty when not a choice.
 */
function treeOptions(vals) {
  if (!vals.length) return [];
  if (
    vals.some(([, v]) => typeof v === 'string' && v.length > TREE_BYTE_HEX_MAX)
  )
    return [];
  const anyNumeric = vals.some(([n]) => treeIsNumericName(n));

  // ONE DATEN ROW, ONE OPTION. BMW's PARZUWEISUNG_PSW1 rows ARE the choices
  // the tool offers, and several legitimately share a byte:
  // ABSCHALTDREHZAHL_ANLASSER lists 4/6/8/12-cylinder gasoline all at 0x0A,
  // because the engine variant is what the installer picks -- the byte just
  // happens to be equal. NCS-Expert lists all nine; so do we.
  //
  // We used to dedupe by hex and merge the names into one chip
  // ("4_zylinder_benziner / 6_zylinder_benziner / ..."), which collapsed
  // nine real choices into three and read as data loss. Values that share a
  // byte stay separate rows; picking any of them stages the same byte, which
  // is correct and is what the ECU sees either way.
  const named = vals.filter(([n]) => !treeIsNumericName(n));

  // A purely numeric field (every "name" is an unresolved id) has no labels
  // to show, so it collapses to its distinct VALUES -- there is nothing to
  // tell two rows apart but the byte.
  if (!named.length) {
    const seen = new Map();
    for (const [, v] of vals) seen.set(String(v).toLowerCase(), true);
    if (seen.size < 2) return [];
    return [...seen.keys()]
      .map(
        (v) => /** @type {TreeOption} */ ([String(parseInt(v, 16)), v, true])
      )
      .sort(treeByValue);
  }

  // Mixed (some rows named, some bare ids): keep the named rows as labelled
  // options and fold the anonymous ids into whichever value they name, so a
  // bare id never renders as a chip of its own next to a real label.
  /** @type {TreeOption[]} */
  const out = [];
  const emitted = new Set();
  for (const [n, v] of vals) {
    const key = String(v).toLowerCase();
    if (treeIsNumericName(n)) {
      // only surface an id-only value when NO named row shares that byte
      if (named.some(([, nv]) => String(nv).toLowerCase() === key)) continue;
      if (emitted.has('#' + key)) continue;
      emitted.add('#' + key);
      out.push([String(parseInt(key, 16)), key, true]);
      continue;
    }
    const dedupe = n + '\u0000' + key; // identical row twice: once
    if (emitted.has(dedupe)) continue;
    emitted.add(dedupe);
    out.push([String(n), key]); // label(): keeps translation
  }
  if (out.length < 2) return [];
  if (anyNumeric) out.sort(treeByValue);
  return out;
}

/**
 * Pair a DATEN function to its value in a module's coding read. The read
 * names results differently (COD_* / STAT_*), so match on shared tokens, then
 * reduce the answer to one of the function's known option hex values.
 * @param {string} kw - the DATEN keyword.
 * @param {TreeOption[]} opts - the function's options.
 * @param {Map<string, string>} read - the module's flattened coding read.
 * @returns {string|null} the matched hex value, or null.
 */
function treeMatchRead(kw, opts, read) {
  const num =
    typeof codMatchRead === 'function' ? codMatchRead(kw, read) : null;
  if (num == null) return null;
  const hex = num.toString(16).padStart(2, '0');
  // only accept if it is actually one of this function's options
  return opts.some(([, v]) => String(v).toLowerCase() === hex) ? hex : null;
}

// Ops-carrying (DIR "property") fields keep the raw byte -- the transform
// needs the full field value, not a per-byte gloss, so we don't fake it.
/**
 * Render one coded byte as its DATEN unit says: 'd' decimal, 'a'/'A' the
 * ASCII character it stands for, 'b' binary, else hex. The raw 0x byte rides
 * along as a tooltip so it can still be cross-checked against another tool.
 * @param {string} hex - the byte as hex.
 * @param {DatenField|null|undefined} f - the field.
 * @returns {{text: string, tip: string}} display text and tooltip.
 */
function treeFmt(hex, f) {
  const raw = '0x' + hex;
  const u = f && f.unit;
  if (!u || u === 'h' || (f && f.ops && f.ops.length))
    return { text: raw, tip: '' };
  const n = parseInt(hex, 16);
  if (u === 'd') return { text: String(n), tip: raw };
  if (u === 'b')
    return { text: n.toString(2).padStart(hex.length * 4, '0'), tip: raw };
  if (u === 'a' || u === 'A') {
    const ch = n >= 0x20 && n < 0x7f ? String.fromCharCode(n) : '.';
    return { text: `'${ch}'`, tip: raw };
  }
  return { text: raw, tip: '' };
}

/**
 * The static reference rendering of a function that is not a choice
 * (numeric field, default, buffer, or unread).
 * @param {Array<[string, string]>} vals - the DATEN values.
 * @param {(name: string) => string} label - the keyword labeller.
 * @param {DatenField|null|undefined} f - the field.
 * @returns {string} HTML.
 */
function treeStaticValues(vals, label, f) {
  const long = vals.filter(
    ([, v]) => typeof v === 'string' && v.length > TREE_BYTE_HEX_MAX
  );
  if (long.length === vals.length && vals.length > 1) {
    const bytes = String(vals[0][1]).length / 2;
    return (
      `<span class="tree-val" title="${esc(
        vals.map(([n, v]) => `${n}: ${v}`).join('\n')
      )}">` +
      `<span class="tree-val-n">${vals.length} variants</span>` +
      `<span class="tree-val-v mono">${bytes} bytes each</span></span>`
    );
  }
  if (vals.every(([n]) => treeIsNumericName(n))) {
    // numeric quantities read in their DATEN unit -- decimal by default (an
    // RPM threshold is 10, not 0x0a), the character for an ASCII field, the
    // raw byte for hex. A DIR property field (VIN/date/key) is read-only.
    const uniq = [...new Set(vals.map(([, v]) => String(v)))].sort(
      (a, b) => parseInt(a, 16) - parseInt(b, 16)
    );
    const tag =
      f && f.dir ? 'property' : uniq.length === 1 ? 'default' : 'value';
    return (
      `<span class="tree-val"><span class="tree-val-n">${tag}</span>` +
      uniq
        .map((v) => {
          const { text, tip } = treeFmt(v, f);
          return (
            `<span class="tree-val-v mono"${tip ? ` title="${tip}"` : ''}>` +
            `${esc(text)}</span>`
          );
        })
        .join('') +
      `</span>`
    );
  }
  // named options that all hold the SAME byte are one fact, not a choice --
  // two chips read as broken buttons (E46 EWS: gasoline and diesel cut-off
  // time both 0x01), so fold the names into a single reference chip
  const uniqV = [...new Set(vals.map(([, v]) => String(v).toLowerCase()))];
  if (
    uniqV.length === 1 &&
    vals.length > 1 &&
    String(vals[0][1]).length <= TREE_BYTE_HEX_MAX
  ) {
    return (
      `<span class="tree-val">` +
      `<span class="tree-val-n">${esc(vals.map(([n]) => label(n)).join(' / '))}</span>` +
      `<span class="tree-val-v mono">0x${esc(vals[0][1])}</span></span>`
    );
  }
  return vals
    .map(([n, v]) => {
      const big = typeof v === 'string' && v.length > TREE_BYTE_HEX_MAX;
      return (
        `<span class="tree-val"${big ? ` title="${esc(v)}"` : ''}>` +
        `<span class="tree-val-n">${esc(label(n))}</span>` +
        `<span class="tree-val-v mono">` +
        `${big ? `${String(v).length / 2} bytes` : '0x' + esc(v)}</span></span>`
      );
    })
    .join('');
}

/**
 * Render a function's value list as DATEN means it. A real multiple-choice
 * with a read current renders as SELECTABLE chips (current marked, picking
 * another stages it); otherwise static reference (numeric field, default, or
 * buffer).
 * @param {Array<[string, string]>} vals - the DATEN values.
 * @param {(name: string) => string} label - the keyword labeller.
 * @param {string} fkey - "sgbd:name".
 * @param {Map<string, FunctionState>|null} state - per-function state.
 * @param {DatenField|null|undefined} f - the field.
 * @returns {string} HTML.
 */
function treeValues(vals, label, fkey, state, f) {
  if (!vals.length) return '<span class="ink-faint">—</span>';
  let opts = treeOptions(vals);
  const numeric = treeNumericField(vals);
  // a single-value numeric field is still choosable in expert mode: its one
  // shipped default renders as a chip, and the ✎ chip takes any hand-typed
  // byte -- full access, same staging as everything else
  if (!opts.length && numeric && state && state.has(fkey)) {
    opts = [...new Set(vals.map(([, v]) => String(v).toLowerCase()))].map(
      (v) => /** @type {TreeOption} */ ([String(parseInt(v, 16)), v, true])
    );
  }
  if (!(opts.length && state && state.has(fkey))) {
    return treeStaticValues(vals, label, f);
  }
  const s = state.get(fkey); // {current, staged}
  const sel = s.staged != null ? s.staged : s.current;
  // a hand-typed value isn't among the shipped chips: show it as one
  if (
    numeric &&
    sel &&
    !opts.some(([, v]) => v.toLowerCase() === String(sel).toLowerCase())
  ) {
    opts = [
      ...opts,
      /** @type {TreeOption} */ ([
        String(parseInt(sel, 16)),
        String(sel).toLowerCase(),
        true,
      ]),
    ].sort(treeByValue);
  }
  // DIR "property" fields (VIN, date, keys) are computed/read-only -- no
  // free-entry chip; a raw hand-typed byte would bypass their transform
  const edit =
    numeric && f && !f.dir
      ? `<button class="tree-opt tree-opt-editbtn" data-edit="1" type="button"
           data-max="${String(vals[0][1]).length > 2 ? 65535 : (f.mask || 255) >> (f.shift || 0)}"
           data-w="${String(vals[0][1]).length}"
           title="Stage any value (expert)">✎ set…</button>`
      : '';
  // FIRST MATCH WINS. Several options can share a byte -- 4/6/8/12-cylinder
  // gasoline are all 0x0A -- and the ECU only ever tells us the byte, never
  // which of them the installer meant. Marking every match lit four chips
  // "current" at once, which reads as a bug. NCS-Expert resolves it the
  // same way (decodeCurrentPsw returns the FIRST parameter whose bytes
  // match), so the first option in BMW's file order carries the marker and
  // the rest stay pickable.
  const lc = (x) => String(x == null ? '' : x).toLowerCase();
  const firstAt = (want) => {
    const w = lc(want);
    if (!w) return -1;
    return opts.findIndex(([, v]) => lc(v) === w);
  };
  const selIdx = firstAt(sel);
  const curIdx = firstAt(s.current);

  return (
    `<div class="tree-opts" data-fkey="${esc(fkey)}">` +
    opts
      .map(([n, v, final], oi) => {
        const on = oi === selIdx;
        const isCur = oi === curIdx;
        // a numeric chip shows its unit-formatted value; a named option keeps
        // its label. The mono suffix is the raw byte either way.
        const { text, tip } = numeric
          ? treeFmt(v, f)
          : { text: '0x' + v, tip: '' };
        const nm = final ? n : numeric ? text : label(n);
        return (
          `<button class="tree-opt${on ? ' sel' : ''}" ` +
          `data-v="${esc(v)}" type="button">` +
          `<span class="tree-opt-n">${esc(nm)}</span>` +
          `<span class="tree-opt-v mono"${tip ? ` title="${tip}"` : ''}>` +
          `0x${esc(v)}</span>` +
          `${isCur ? '<span class="tree-opt-cur">current</span>' : ''}` +
          `</button>`
        );
      })
      .join('') +
    edit +
    `</div>`
  );
}

/**
 * Seed per-function state {current, staged} for one module's functions from
 * the scan. Every choosable function gets a current (the read value where the
 * scan named it, else a stable deterministic pick) so options render selected
 * from the first frame -- no Read buttons, same rule on desktop and mobile.
 * @param {Map<string, FunctionState>} state - the state map, filled in place.
 * @param {string} sgbd - the module.
 * @param {DatenField[]} fns - its functions.
 * @param {Map<string, string>|null|undefined} read - its flattened coding read.
 * @returns {void}
 */
function seedState(state, sgbd, fns, read) {
  for (const f of fns) {
    const vals = f.values || [];
    const opts = treeOptions(vals);
    // numeric fields are choosable too, even with ONE shipped value: expert
    // mode lets any of them take a hand-typed byte (treeNumericField + the edit
    // chip), so they need a current like every other choice
    const numeric = treeNumericField(vals);
    if (!opts.length && !numeric) continue;
    const fkey = `${sgbd}:${f.name}`;
    let cur = read ? treeMatchRead(f.name, opts, read) : null;
    if (cur == null && numeric && read) {
      // a numeric field accepts ANY byte the read names, not just shipped ones
      const num =
        typeof codMatchRead === 'function' ? codMatchRead(f.name, read) : null;
      const w = String(vals[0][1]).length;
      if (num != null && num >= 0 && num <= parseInt('f'.repeat(w), 16)) {
        cur = num.toString(16).padStart(w, '0');
      }
    }
    if (cur == null) {
      if (opts.length) {
        let h = 0;
        for (const c of f.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        cur = opts[h % opts.length][1];
      } else {
        cur = String(vals[0][1]).toLowerCase(); // the factory default
      }
    }
    state.set(fkey, { current: cur, staged: null });
  }
}

/**
 * The ✎ chip tapped: prompt for a value (decimal, or 0x.. hex), bound it by
 * the field's mask, stage it like any picked option. Shared by the desktop
 * tree and the mobile module view so the two stay identical.
 * @param {HTMLElement} opt - the ✎ chip (carries data-max / data-w).
 * @param {FunctionState} s - the function's state, mutated.
 * @param {() => void} draw - redraw after staging.
 * @returns {void}
 */
function treeEditPrompt(opt, s, draw) {
  const max = parseInt(opt.dataset.max || '255', 10);
  const w = parseInt(opt.dataset.w || '2', 10);
  inputDialog({
    title: 'Set value',
    body:
      `Any value 0–${max} can be staged. Only values BMW shipped are ` +
      `proven on real cars — a hand-typed one is on you.`,
    kind: 'text',
    example: String(max),
    confirmLabel: 'Stage',
  }).then((val) => {
    if (val == null || String(val).trim() === '') return;
    const t = String(val).trim().toLowerCase();
    const n = t.startsWith('0x') ? parseInt(t.slice(2), 16) : parseInt(t, 10);
    if (!Number.isFinite(n) || n < 0 || n > max) return;
    const hex = n.toString(16).padStart(w, '0');
    s.staged = hex === String(s.current).toLowerCase() ? null : hex;
    draw();
  });
}

/**
 * The shared chip-tap handler: stage the tapped option, or open the ✎ prompt.
 * Both the desktop tree and the mobile module view delegate here.
 * @param {Event} e - the click event.
 * @param {Map<string, FunctionState>} state - per-function state.
 * @param {() => void} draw - redraw after staging.
 * @returns {void}
 */
function treeOptionClick(e, state, draw) {
  const opt = /** @type {HTMLElement} */ (e.target).closest('.tree-opt');
  if (!opt) return;
  const wrap = opt.closest('.tree-opts');
  const fkey = wrap && wrap.dataset.fkey;
  const s = fkey && state.get(fkey);
  if (!s) return;
  if (opt.dataset.edit != null) {
    treeEditPrompt(opt, s, draw);
    return;
  }
  const v = opt.dataset.v;
  s.staged =
    String(v).toLowerCase() === String(s.current).toLowerCase() ? null : v;
  draw();
}

/**
 * The staged-dot marker for a function header.
 * @param {Map<string, FunctionState>} state - per-function state.
 * @param {string} fkey - "sgbd:name".
 * @returns {string} HTML, empty when nothing is staged.
 */
function treeStagedDot(state, fkey) {
  return state.has(fkey) && state.get(fkey).staged != null
    ? '<span class="tree-staged-dot"></span>'
    : '';
}

/**
 * How many functions have a staged change.
 * @param {Map<string, FunctionState>} state - per-function state.
 * @returns {number} the count.
 */
function treeStagedCount(state) {
  return [...state.values()].filter((s) => s.staged != null).length;
}

// The pieces the other coding screens call; published explicitly so the shared surface is visible.
if (typeof window !== 'undefined') {
  window.treeIsNumericName = treeIsNumericName;
  window.treeNumericField = treeNumericField;
  window.treeOptions = treeOptions;
  window.treeMatchRead = treeMatchRead;
  window.treeFmt = treeFmt;
  window.treeValues = treeValues;
  window.seedState = seedState;
  window.treeEditPrompt = treeEditPrompt;
  window.treeOptionClick = treeOptionClick;
  window.treeStagedDot = treeStagedDot;
  window.treeStagedCount = treeStagedCount;
}
