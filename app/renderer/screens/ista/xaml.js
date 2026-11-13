/**
 * @file Drawing an ISTA page from the tool's OWN layout.
 *
 * WHAT A TEMPLATE IS. tools/ista/xaml_compile.py turns one of ISTA's XAML
 * views into JSON: its panels, its tables and their columns, every label as
 * a string key, and the bindings that show, hide, disable and fill each
 * control. This file draws one against a context the app supplies. So the
 * STRUCTURE of the page is BMW's -- which columns, which buttons, in which
 * order, under which conditions -- and the data and the handlers are ours.
 *
 * WHY THE CHROME IS STILL OURS. A view carries its own status row and button
 * row. The shell already has a status line and a bottom bar, painted to
 * match the tool, so a view is split into three parts and each goes where
 * the shell keeps that part: the content into the page, the status row into
 * the status line, the buttons into the bottom bar. Nothing is drawn twice.
 *
 * WHAT A BINDING NAMES. `{bind: 'FaultsCollectionView'}` is a property on
 * the view model ISTA's C# builds. Here it is a key on `ctx.data`, and a
 * command (`CmdQuickDelete`) is a key on `ctx.commands`. A command the
 * context does not supply draws its button DISABLED, which is the honest
 * shape for a control the tool has and this build cannot yet perform: the
 * button is where a technician expects it and does not pretend to work.
 *
 * WHAT IS NOT IN A TEMPLATE. Styles, control templates and triggers. The
 * page paints with the shell's stylesheet, and a cell whose look came from a
 * trigger (a state dot's colour) is supplied by the context through
 * `ctx.cells`. That is also the "keep ours" switch at the smallest grain:
 * any cell, any custom control, can be handed back to the app's own drawing.
 */

/* exported istaXamlLoad istaXamlStrings istaXamlParts istaXamlButtons
   istaXamlStatus istaXamlRender istaXamlEval istaXamlOn istaXamlText
   ISTA_XAML_KEY */

/** Settings key: which pages draw from the tool's own layout. */
const ISTA_XAML_KEY = 'bmweb.ista.xaml';

/** @type {Map<string, Promise<object|null>>} view name -> its template */
const istaXamlTemplates = new Map();
/** @type {Map<string, Promise<object|null>>} culture -> its string table */
const istaXamlTables = new Map();

/** The string keys of the plan-state legend, and the dot each one paints. */
const ISTA_XAML_LEGEND = {
  '#EcuWithoutFaultMemory': 'ok',
  '#EcuResponding': 'ok',
  '#EcuWithFaultMemory': 'warn',
  '#EcuNotResponding': 'bad',
  '#EcuWithProgrammingAbort': 'blue',
  '#ECUunconfirmed': 'dim',
  '#EcuStateUnknown': 'dim',
  '#NotCalled': 'none',
  '#Performed': 'ok',
  '#Minimized': 'warn',
  '#Canceled': 'bad',
  '#Suspected': 'blue',
};

/**
 * Whether a page draws from the tool's layout.
 *
 * ON UNLESS TURNED OFF. The tool's layout is the page; the hand-built one
 * is what draws when a build ships no template, or when the setting names
 * the page off -- 'off' for every page, or {page: false} for one. That
 * switch is the way back while a template is still being checked against a
 * real car, and the reason the hand-built pages stay in the tree.
 * @param {string} page - the page id (fault-memory, test-plan, basic ...)
 * @returns {boolean}
 */
function istaXamlOn(page) {
  if (typeof Settings !== 'object' || !Settings) return true;
  const v = Settings.get(ISTA_XAML_KEY, null);
  if (v === 'off') return false;
  return !(v && typeof v === 'object' && v[page] === false);
}

/**
 * One compiled view, or null when this build does not ship it.
 * @param {string} view - the view's class name (FaultMemoryView)
 * @returns {Promise<object|null>}
 */
function istaXamlLoad(view) {
  if (!istaXamlTemplates.has(view))
    istaXamlTemplates.set(
      view,
      typeof hfFetchFirst === 'function'
        ? hfFetchFirst(`ista/xaml/${view}.json`).catch(() => null)
        : Promise.resolve(null)
    );
  return istaXamlTemplates.get(view);
}

/**
 * ISTA's string table for one language, or null.
 * @param {string} [culture] - en-GB, de-DE ...
 * @returns {Promise<object|null>}
 */
function istaXamlStrings(culture) {
  const c = culture || 'en-GB';
  if (!istaXamlTables.has(c))
    istaXamlTables.set(
      c,
      typeof hfFetchFirst === 'function'
        ? hfFetchFirst(`ista/xaml/strings.${c}.json`).catch(() => null)
        : Promise.resolve(null)
    );
  return istaXamlTables.get(c);
}

// ---- expressions ------------------------------------------------------------

/**
 * Read a dotted path off an object. `.` is the object itself; `Count` on an
 * array is its length, which is what a WPF collection calls it.
 * @param {*} obj - the data context
 * @param {string} path - e.g. 'DTC.F_UW_KM'
 * @returns {*}
 */
function istaXamlPath(obj, path) {
  if (!path || path === '.') return obj;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && part === 'Count') cur = cur.length;
    else cur = cur[part];
  }
  return cur;
}

/** Whether a converter parameter asks for the inverse. */
const istaXamlInv = (p) => /^(true|invers|inverse)$/i.test(String(p || ''));

/**
 * The converters a template can name, by the tool's own class names.
 *
 * Each is (value, param, ctx) -> value. Only the ones that are pure logic
 * live here; one that needs the app's data (a fault class, a brand) is
 * supplied per page through `ctx.converters`.
 * @type {Object<string, Function>}
 */
const ISTA_XAML_CONVERTERS = {
  BooleanVisibilityConverter: (v, p) => !!v !== istaXamlInv(p),
  BooleanInversionConverter: (v) => !v,
  HasValueVisibilityConverter: (v, p) =>
    (v != null && v !== '') !== istaXamlInv(p),
  HasValueBooleanConverter: (v, p) =>
    (v != null && v !== '') !== istaXamlInv(p),
  IsNullBooleanConverter: (v, p) => (v == null) !== istaXamlInv(p),
  NumberBooleanConverter: (v, p) => Number(v) > 0 !== istaXamlInv(p),
  EnumBooleanConverter: (v, p) => String(v) === String(p),
  // the tool runs in several modes (ISTA, TELESERVICE ...) and a control
  // lists the modes it shows in; this build is plain ISTA
  OperationalModeVisibilityConverter: (v, p, ctx) =>
    String(p || '')
      .split(',')
      .map((s) => s.trim())
      .includes((ctx && ctx.mode) || 'ISTA'),
  ParameterVisibilityConverter: () => true,
  FilterDefaultInfoConverter: (v, p, ctx) =>
    istaXamlText(ctx, v === false ? '#FilterUserDefined' : '#FilterDefault'),
};

/**
 * A string key as text.
 * @param {object} ctx - the render context (`strings`)
 * @param {string} key - e.g. '#ShowFaultCode'
 * @returns {string} the text, or the key without its '#' when unknown
 */
function istaXamlText(ctx, key) {
  const t = ctx && ctx.strings ? ctx.strings[key] : null;
  // the table writes a line break as the two characters \n
  return t != null ? String(t).replace(/\\n/g, '\n') : String(key).slice(1);
}

/**
 * Evaluate one template expression.
 * @param {object|null} e - the expression
 * @param {*} data - the data context it reads
 * @param {object} ctx - the render context
 * @returns {*} the value; undefined when the expression names nothing known
 */
function istaXamlEval(e, data, ctx) {
  if (!e) return undefined;
  if ('lit' in e) return e.lit;
  if ('loc' in e) {
    const t = istaXamlText(ctx, e.loc);
    return e.colon && !/:\s*$/.test(t) ? `${t}:` : t;
  }
  if (e.multi) {
    const vals = e.multi.map((p) => istaXamlEval(p, data, ctx));
    const conv = e.conv && istaXamlConv(e.conv, ctx);
    if (conv) return conv(vals, e.param, ctx);
    // nothing to format: an empty field, not a line of separators
    if (e.fmt && vals.every((v) => v == null || v === '')) return '';
    if (e.fmt)
      return e.fmt.replace(/\{(\d+)[^}]*\}/g, (_, i) => {
        const v = vals[Number(i)];
        return v == null ? '' : String(v);
      });
    return vals.filter((v) => v != null).join(' ');
  }
  if (!('bind' in e)) return undefined;
  let v;
  if (e.res) v = istaXamlPath(istaXamlResource(e.res, data, ctx), e.bind);
  // a binding to another element or a relative source reads live WPF state
  // (a grid's actual width); nothing here stands in for that
  else if (e.el || e.rel) v = undefined;
  else v = istaXamlPath(data, e.bind);
  if (e.conv) {
    const conv = istaXamlConv(e.conv, ctx);
    if (conv) v = conv(v, e.param, ctx);
    else if (ctx) (ctx.missing = ctx.missing || new Set()).add(e.conv);
  }
  if (v == null && e.fallback != null) v = e.fallback;
  return v;
}

/**
 * A converter by name: the page's own first, then the built-ins.
 * @param {string} name - the converter's class name
 * @param {object} ctx - the render context
 * @returns {Function|null}
 */
function istaXamlConv(name, ctx) {
  return (
    (ctx && ctx.converters && ctx.converters[name]) ||
    ISTA_XAML_CONVERTERS[name] ||
    null
  );
}

/**
 * What a named resource lists. The page may hand the rows over directly
 * (`ctx.resources`); otherwise the resource's own Source binding is read.
 * @param {string} key - the resource key (TestPlanCollectionViewSource)
 * @param {*} data - the data context
 * @param {object} ctx - the render context
 * @returns {*}
 */
function istaXamlResource(key, data, ctx) {
  if (ctx && ctx.resources && key in ctx.resources) return ctx.resources[key];
  const r = ctx && ctx.declared ? ctx.declared[key] : null;
  return r && r.source ? istaXamlEval(r.source, data, ctx) : undefined;
}

/**
 * Whether an expression says "shown". Unknown reads as shown: a control the
 * build cannot decide about is drawn rather than silently dropped.
 * @param {object|undefined} e - the Visibility expression
 * @param {*} data - the data context
 * @param {object} ctx - the render context
 * @returns {boolean}
 */
function istaXamlVisible(e, data, ctx) {
  if (!e) return true;
  const v = istaXamlEval(e, data, ctx);
  if (v === false) return false;
  return !(typeof v === 'string' && /^(collapsed|hidden)$/i.test(v));
}

/**
 * Whether an expression says "enabled". Unknown reads as enabled.
 * @param {object|undefined} e - the IsEnabled expression
 * @param {*} data - the data context
 * @param {object} ctx - the render context
 * @returns {boolean}
 */
function istaXamlEnabled(e, data, ctx) {
  if (!e) return true;
  const v = istaXamlEval(e, data, ctx);
  return !(v === false || (typeof v === 'string' && /^false$/i.test(v)));
}

// ---- the three parts of a view ----------------------------------------------

/**
 * Whether a subtree holds a node matching a test.
 * @param {object} node - a template node
 * @param {(n: object) => boolean} test - the predicate
 * @returns {boolean}
 */
function istaXamlHas(node, test) {
  if (test(node)) return true;
  return (node.kids || []).some((k) => istaXamlHas(k, test));
}

const istaXamlIsButton = (n) => n.t === 'Button' || n.t === 'ToggleButton';
/** A control the reader types into or ticks: never part of a status row. */
const istaXamlIsInput = (n) =>
  /^(TextBox|MaskedTextBox|CheckBox|RadioButton|ComboBox|ListBox|DatePicker)$/.test(
    n.t
  );
const istaXamlIsTable = (n) => !!(n.columns && n.columns.length);

/**
 * Split a view into its content, its status row and its button row.
 *
 * ISTA's pages share one skeleton: a Grid whose rows are the content, a
 * status line and a row of buttons. The split is by what a row HOLDS, not
 * by its index, because a view may wrap the grid in a Border, leave the
 * status row out, or put the buttons first.
 * @param {object} tpl - a compiled view
 * @returns {{content: object[], status: object[], buttons: object[],
 *   resources: object}}
 */
function istaXamlParts(tpl) {
  const resources = { ...(tpl.resources || {}) };
  // nested views declare their own resources; one table for the page
  (function gather(n) {
    Object.assign(resources, n.resources || {});
    (n.kids || []).forEach(gather);
  })(tpl.root);
  // the skeleton is the first grid with rows, looking through wrappers
  let grid = tpl.root;
  while (grid && !(grid.t === 'Grid' && grid.rows)) {
    const kids = grid.kids || [];
    grid = kids.length === 1 ? kids[0] : kids.find((k) => k.t === 'Grid');
  }
  const out = { content: [], status: [], buttons: [], resources };
  if (!grid) {
    out.content = tpl.root.kids || [];
    return out;
  }
  for (const k of grid.kids || []) {
    const star = /\*/.test(
      (grid.rows || [])[Number((k.a && k.a.row) || 0)] || ''
    );
    if (
      istaXamlHas(k, istaXamlIsTable) ||
      istaXamlHas(k, istaXamlIsInput) ||
      (star && !istaXamlIsButton(k))
    )
      out.content.push(k);
    else if (istaXamlHas(k, istaXamlIsButton)) out.buttons.push(k);
    else out.status.push(k);
  }
  return out;
}

/**
 * The bottom bar's rows for a view's button row, in the shape
 * istaRealBottom draws.
 *
 * A button is LIVE when the context supplies its command, and drawn off
 * when it does not. A hidden one is left out. Everything docked or aligned
 * to the right goes after one spacer, which is how the tool splits the row.
 * @param {object[]} nodes - the button rows from istaXamlParts
 * @param {object} ctx - the render context (`data`, `commands`, `toggles`)
 * @returns {Array<object>} rows for istaRealBottom
 */
function istaXamlButtons(nodes, ctx) {
  const left = [];
  const right = [];
  const docked = [];
  const walk = (n, isRight, enabled) => {
    if (!istaXamlVisible(n.vis, ctx.data, ctx)) return;
    const a = n.a || {};
    const r =
      isRight || a.dock === 'Right' || a.horizontalAlignment === 'Right';
    if (!istaXamlIsButton(n)) {
      const en = enabled && istaXamlEnabled(n.en, ctx.data, ctx);
      // a button row laid out as a Grid splits at its star column: what
      // sits past the column that takes the slack is the right-hand group
      const star = (n.cols || []).findIndex((c) => /\*/.test(c));
      for (const k of n.kids || [])
        walk(k, r || (star >= 0 && Number((k.a || {}).col || 0) > star), en);
      return;
    }
    const name = n.cmd && n.cmd.bind;
    let fn = name && ctx.commands ? ctx.commands[name] : null;
    const tog = n.t === 'ToggleButton' && ctx.toggles && ctx.toggles[n.n];
    if (tog) fn = tog.toggle;
    const off =
      !fn || !enabled || !istaXamlEnabled(n.en, ctx.data, ctx) || !!fn.off;
    // a control docked right is placed from the right edge inwards
    (a.dock === 'Right' ? docked : r ? right : left).push({
      id: n.n || name || '',
      command: name || '',
      label: String(istaXamlEval(n.text, ctx.data, ctx) || ''),
      fn: off ? null : typeof fn === 'function' ? fn : fn.run,
      off,
      on: !!(tog && tog.on),
      title: n.tip ? String(istaXamlEval(n.tip, ctx.data, ctx) || '') : '',
    });
  };
  for (const n of nodes) walk(n, false, true);
  right.push(...docked.reverse());
  return right.length ? [...left, { spacer: true }, ...right] : left;
}

/**
 * The status line for a view's status row, in the shape istaRealStatus
 * draws: label/value pairs, and a legend where the row carries dots.
 * @param {object[]} nodes - the status rows from istaXamlParts
 * @param {object} ctx - the render context
 * @returns {{items: Array<{k: string, v: string}>, legend: Array<object>}}
 */
function istaXamlStatus(nodes, ctx) {
  /** @type {Array<{kind: string, node: object}>} */
  const leaves = [];
  (function walk(n) {
    if (!istaXamlVisible(n.vis, ctx.data, ctx)) return;
    if (n.t === 'Ellipse') leaves.push({ kind: 'dot', node: n });
    else if (n.t === 'Label') leaves.push({ kind: 'label', node: n });
    else if (n.t === 'TextBlock' || n.t === 'UiAutomationTextBlock')
      leaves.push({ kind: 'value', node: n });
    (n.kids || []).forEach(walk);
  })({ t: 'root', kids: nodes });

  const items = [];
  const legend = [];
  const text = (n) => {
    const v = istaXamlEval(n.text, ctx.data, ctx);
    return v == null ? '' : String(v);
  };
  for (let i = 0; i < leaves.length; i++) {
    const l = leaves[i];
    if (l.kind === 'dot') {
      const next = leaves[i + 1];
      if (next && next.kind === 'label') {
        const key = next.node.text && next.node.text.loc;
        legend.push({
          cls: ISTA_XAML_LEGEND[key] || 'none',
          label: text(next.node),
        });
        i++;
      }
    } else if (l.kind === 'label') {
      const next = leaves[i + 1];
      const hasValue = next && next.kind === 'value';
      items.push({ k: text(l.node), v: hasValue ? text(next.node) : '' });
      if (hasValue) i++;
    }
  }
  return { items, legend };
}

// ---- drawing ----------------------------------------------------------------

/**
 * A WPF length as CSS: a number is pixels, `Auto` is auto, `*` is a share.
 * @param {string} v - the length as written
 * @param {boolean} [track] - a grid track, where `*` becomes a fraction
 * @returns {string}
 */
function istaXamlLen(v, track) {
  const s = String(v || '').trim();
  if (/^auto$/i.test(s)) return 'auto';
  const star = /^(\d*\.?\d*)\*$/.exec(s);
  if (star) return track ? `minmax(0, ${star[1] || 1}fr)` : '100%';
  return /^\d+(\.\d+)?$/.test(s) ? `${s}px` : '';
}

/**
 * A WPF thickness (left,top,right,bottom) as a CSS shorthand.
 * @param {string} v - one, two or four numbers
 * @returns {string}
 */
function istaXamlThickness(v) {
  const p = String(v || '')
    .split(/[ ,]+/)
    .filter(Boolean)
    .map(Number);
  if (p.some((n) => !Number.isFinite(n))) return '';
  if (p.length === 1) return `${p[0]}px`;
  if (p.length === 2) return `${p[1]}px ${p[0]}px`;
  if (p.length === 4) return `${p[1]}px ${p[2]}px ${p[3]}px ${p[0]}px`;
  return '';
}

/**
 * Apply a node's layout attributes to its element.
 * @param {HTMLElement} el - the element
 * @param {object} n - the template node
 * @returns {void}
 */
function istaXamlLayout(el, n) {
  const a = n.a || {};
  const s = el.style;
  for (const [k, css] of [
    ['width', 'width'],
    ['height', 'height'],
    ['minWidth', 'minWidth'],
    ['minHeight', 'minHeight'],
    ['maxWidth', 'maxWidth'],
    ['maxHeight', 'maxHeight'],
  ]) {
    const v = a[k] ? istaXamlLen(a[k]) : '';
    if (v && v !== 'auto') s[css] = v;
  }
  if (a.width && /^\d/.test(a.width)) s.flex = '0 0 auto';
  if (a.margin) s.margin = istaXamlThickness(a.margin);
  if (a.padding) s.padding = istaXamlThickness(a.padding);
  if (a.row != null || a.rowSpan)
    s.gridRow = `${Number(a.row || 0) + 1} / span ${Number(a.rowSpan || 1)}`;
  if (a.col != null || a.colSpan)
    s.gridColumn = `${Number(a.col || 0) + 1} / span ${Number(a.colSpan || 1)}`;
  if (a.horizontalAlignment === 'Right') s.marginLeft = 'auto';
  if (a.fontWeight === 'Bold') s.fontWeight = 'bold';
  if (n.style) el.dataset.xstyle = n.style;
  if (n.n) el.dataset.xname = n.n;
}

/**
 * Draw one table: a ListView, a GridView, a DataGrid -- anything with
 * columns.
 * @param {object} n - the table's template node
 * @param {*} data - the data context
 * @param {object} ctx - the render context
 * @returns {HTMLElement}
 */
function istaXamlTable(n, data, ctx) {
  const name = n.n || (n.items && (n.items.res || n.items.bind)) || '';
  const cols = n.columns.filter((c) => istaXamlVisible(c.vis, data, ctx));
  const rows = istaXamlEval(n.items, data, ctx) || [];
  const selected = n.sel ? istaXamlEval(n.sel, data, ctx) : undefined;
  const custom = (ctx.cells && ctx.cells[name]) || {};
  const colKey = (c) =>
    c.n || (c.header && (c.header.loc || c.header.bind)) || '';

  const table = document.createElement('table');
  table.className = 'irtable ixtable';
  istaXamlLayout(table, n);
  const head = table.createTHead().insertRow();
  for (const c of cols) {
    const th = document.createElement('th');
    const h = istaXamlEval(c.header, data, ctx);
    th.textContent = h == null ? '' : String(h);
    const w = c.width || c.minWidth;
    if (w && /^\d/.test(w)) th.style[c.width ? 'width' : 'minWidth'] = `${w}px`;
    // a star column takes whatever the fixed ones leave
    else if (/\*$/.test(c.width || '')) th.style.width = '100%';
    // a page sorts the columns it names (`cols`), or all of them
    const sorter = ctx.sort && ctx.sort[name];
    const sortable =
      sorter && (!sorter.cols || sorter.cols.includes(colKey(c)));
    if (sortable) {
      th.className = 'ixsort';
      th.tabIndex = 0;
      th.onclick = () => (sorter.run || sorter)(colKey(c), c);
    }
    head.appendChild(th);
  }

  const body = table.createTBody();
  const group = ctx.groups && ctx.groups[name];
  let lastGroup;
  rows.forEach((row, i) => {
    if (group) {
      const g = group(row);
      if (g && g.key !== lastGroup) {
        lastGroup = g.key;
        const tr = body.insertRow();
        tr.className = 'irgroup';
        const cells = g.cells || [g.title || ''];
        cells.forEach((text, ci) => {
          const td = tr.insertCell();
          td.textContent = text == null ? '' : String(text);
          if (ci === 0) td.colSpan = cols.length - (cells.length - 1);
        });
      }
    }
    const tr = body.insertRow();
    tr.dataset.i = String(i);
    if (selected !== undefined && selected === row) tr.className = 'sel';
    for (const c of cols) {
      const td = tr.insertCell();
      const own = custom[colKey(c)];
      if (own) {
        // the app's own drawing for this cell: a state dot, a note marker
        const got = own(row);
        if (got instanceof Node) td.appendChild(got);
        else td.innerHTML = got == null ? '' : String(got);
      } else if (c.cell) {
        td.appendChild(istaXamlNode(c.cell, row, ctx));
      } else {
        const v = c.bind
          ? istaXamlEval(c.bind, row, ctx)
          : row && typeof row === 'object'
            ? (row.Title ?? '')
            : row;
        td.textContent = v == null ? '' : String(v);
      }
    }
    tr.onclick = () => {
      // the highlight moves in place: the page decides whether a pick needs
      // more than its chrome repainted
      if (selected !== undefined || n.sel) {
        body.querySelectorAll('tr.sel').forEach((x) => {
          x.classList.remove('sel');
        });
        tr.classList.add('sel');
      }
      if (ctx.select) ctx.select(name, row, i);
    };
    const dbl = n.dbl && ctx.commands ? ctx.commands[n.dbl.bind] : null;
    if (dbl)
      tr.ondblclick = () => (typeof dbl === 'function' ? dbl : dbl.run)(row);
  });
  if (!rows.length && ctx.empty && ctx.empty[name]) {
    const tr = body.insertRow();
    tr.className = 'ixempty';
    const td = tr.insertCell();
    td.colSpan = cols.length;
    td.textContent = ctx.empty[name];
  }
  return table;
}

/**
 * Draw one template node and everything under it.
 * @param {object} n - the node
 * @param {*} data - the data context it reads
 * @param {object} ctx - the render context
 * @returns {Node} an element, or an empty text node for a hidden control
 */
function istaXamlNode(n, data, ctx) {
  if (!istaXamlVisible(n.vis, data, ctx)) return document.createTextNode('');
  // a nested view may rebind its data context; `.` keeps the parent's
  const dc = n.dc && n.dc.bind !== '.' ? istaXamlEval(n.dc, data, ctx) : data;
  const scope = dc === undefined ? data : dc;

  if (istaXamlIsTable(n)) return istaXamlTable(n, scope, ctx);

  // a control the tool draws in C#: the app's own widget, where it has one,
  // and nothing at all where it does not (an on-screen keyboard panel)
  if (n.custom && n.t !== 'MaskedTextBox') {
    const el = document.createElement('div');
    el.className = 'ixcustom';
    el.dataset.xcustom = n.t;
    istaXamlLayout(el, n);
    const w = ctx.widgets && ctx.widgets[n.t];
    if (w) w(el, n, scope, ctx);
    else el.hidden = true;
    return el;
  }

  const kids = () => (n.kids || []).map((k) => istaXamlNode(k, scope, ctx));
  const text = () => {
    const v = istaXamlEval(n.text, scope, ctx);
    return v == null ? '' : String(v);
  };
  let el;
  switch (n.t) {
    case 'Grid': {
      el = document.createElement('div');
      el.className = 'ixgrid';
      if (n.rows)
        el.style.gridTemplateRows = n.rows
          .map((r) => istaXamlLen(r, true) || 'auto')
          .join(' ');
      if (n.cols)
        el.style.gridTemplateColumns = n.cols
          .map((c) => istaXamlLen(c, true) || 'auto')
          .join(' ');
      el.append(...kids());
      break;
    }
    case 'StackPanel':
    case 'WrapPanel':
    case 'DockPanel': {
      el = document.createElement('div');
      const row =
        n.t === 'DockPanel'
          ? !(n.kids || []).some((k) => /Top|Bottom/.test((k.a || {}).dock))
          : (n.a || {}).orientation === 'Horizontal';
      el.className = `ixstack ${row ? 'ixrow' : 'ixcol'}`;
      el.append(...kids());
      break;
    }
    case 'TextBlock':
    case 'Label':
    case 'UiAutomationTextBlock': {
      el = document.createElement('span');
      el.className = n.t === 'Label' ? 'ixlabel' : 'ixtext';
      el.textContent = text();
      el.append(...kids());
      break;
    }
    case 'Button':
    case 'ToggleButton':
    case 'IstaButton': {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'irbtn';
      el.textContent = text();
      const fn = n.cmd && ctx.commands ? ctx.commands[n.cmd.bind] : null;
      if (fn && istaXamlEnabled(n.en, scope, ctx))
        el.onclick = () => (typeof fn === 'function' ? fn : fn.run)(scope);
      else el.disabled = true;
      break;
    }
    case 'CheckBox':
    case 'RadioButton': {
      el = document.createElement('label');
      el.className = 'ixcheck';
      const box = document.createElement('input');
      box.type = n.t === 'CheckBox' ? 'checkbox' : 'radio';
      if ((n.a || {}).groupName) box.name = n.a.groupName;
      box.checked = !!istaXamlEval(n.checked, scope, ctx);
      box.disabled = !istaXamlEnabled(n.en, scope, ctx);
      const pick = n.cmd && ctx.commands ? ctx.commands[n.cmd.bind] : null;
      box.onchange = () => {
        if (n.checked && n.checked.bind && ctx.set)
          ctx.set(n.checked.bind, box.checked, n);
        // a radio that carries a command reports which answer it stands for
        if (pick)
          (typeof pick === 'function' ? pick : pick.run)(
            n.checked ? n.checked.param : undefined,
            box.checked
          );
      };
      el.append(box, document.createTextNode(` ${text()}`));
      break;
    }
    case 'TextBox':
    case 'MaskedTextBox': {
      el = document.createElement('input');
      el.type = 'text';
      el.className = 'ixinput';
      el.value = text();
      if ((n.a || {}).maxLength) el.maxLength = Number(n.a.maxLength);
      el.autocomplete = 'off';
      el.spellcheck = false;
      if (n.text && n.text.bind && ctx.set)
        el.oninput = () => ctx.set(n.text.bind, el.value, n);
      // the view's own key binding: Enter runs the command it names
      if (n.key && n.key.bind)
        el.onkeydown = (e) => {
          const fn = ctx.commands ? ctx.commands[n.key.bind] : null;
          if (e.key === 'Enter' && fn)
            (typeof fn === 'function' ? fn : fn.run)();
        };
      break;
    }
    case 'Ellipse': {
      el = document.createElement('i');
      el.className = 'ixdot';
      break;
    }
    case 'Image': {
      // the views use one image inside a page: the warning triangle beside
      // a field whose online lookup failed
      el = document.createElement('span');
      el.className = 'ixwarn';
      if (typeof istaRealIcon === 'function')
        el.innerHTML = istaRealIcon('warn');
      break;
    }
    default: {
      // Border, ScrollViewer, UserControl, a nested view: a plain box
      el = document.createElement('div');
      el.className = n.t === 'ScrollViewer' ? 'ixbox ixscroll' : 'ixbox';
      if (n.view) el.dataset.xview = n.view;
      el.append(...kids());
    }
  }
  istaXamlLayout(el, n);
  if (n.tip) {
    const tip = istaXamlEval(n.tip, scope, ctx);
    if (tip) el.title = String(tip);
  }
  return el;
}

/**
 * Draw a view's content into a host.
 * @param {HTMLElement} host - where to draw
 * @param {object[]} nodes - the content rows from istaXamlParts
 * @param {object} ctx - the render context: `data`, `commands`, `strings`,
 *   and optionally `resources`, `declared`, `converters`, `cells`, `groups`,
 *   `widgets`, `select`, `sort`, `empty`, `set`, `mode`
 * @returns {void}
 */
function istaXamlRender(host, nodes, ctx) {
  const root = document.createElement('div');
  root.className = 'ixaml';
  for (const n of nodes) root.appendChild(istaXamlNode(n, ctx.data, ctx));
  host.replaceChildren(root);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_XAML_KEY,
    ISTA_XAML_CONVERTERS,
    istaXamlOn,
    istaXamlLoad,
    istaXamlStrings,
    istaXamlPath,
    istaXamlText,
    istaXamlEval,
    istaXamlVisible,
    istaXamlEnabled,
    istaXamlParts,
    istaXamlButtons,
    istaXamlStatus,
    istaXamlLen,
    istaXamlThickness,
    istaXamlRender,
  };
}
