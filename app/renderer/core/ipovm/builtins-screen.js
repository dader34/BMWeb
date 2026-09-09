/**
 * @file Builtins that shape what the user sees: titles, menu items, menu and
 * screen switches, printed text, the lamp and bar instruments, message
 * boxes, and the key actions (select, deselect, exit, print, scriptchange).
 */

/** A unit key: the *_EINH/*_EINHEIT result drawn beside a value. */
const IPO_UNIT_KEY_RE = /(_EINH|_EINHEIT)$/;

/** Format-string builtin argument of analogout: "<width>.<decimals>". */
const IPO_ANALOG_FMT_RE = /^(\d+)\.(\d+)$/;

/** toFixed()'s upper bound on decimals; a stray format never asks for more. */
const IPO_MAX_DECIMALS = 20;

/** Bytes per line of INPA's hexdump. */
const IPO_HEXDUMP_LINE = 16;

/** The fewest hex digits a hexdump address column shows. */
const IPO_HEXDUMP_ADDR_MIN = 4;

/**
 * settitle / setmenutitle: the first argument is the title.
 * @type {IpoBuiltin}
 */
function bSetTitle(vm, stack) {
  if (stack.length) vm.out.title = asStr(stack[0]);
}

/**
 * setitem(nr, caption): a menu item declared by call rather than ITEM token.
 * @type {IpoBuiltin}
 */
function bSetitem(vm, stack) {
  // setitem(nr, caption[, shown]): the third argument shows (1) or hides
  // (0) the key -- E46.IPO's read enables "FS drucken" on F9 once there is
  // a protocol to print, and the save keys hide it again
  const ints = allInts(stack);
  const nr = ints.length ? ints[0] : null;
  const cap = stack.find(isPlainStr);
  const on = ints.length > 1 ? ints[ints.length - 1] : null;
  if (nr != null) vm.out.items.push({ nr, label: cap, on, fromSetitem: true });
}

/**
 * setmenu(&menu): hand control to a menu; the item that did it remembers.
 * @type {IpoBuiltin}
 */
function bSetmenu(vm, stack, item) {
  const ref = stack.find(isRef);
  const tgt = vm.target(ref, 'menu');
  if (tgt) {
    vm.out.menu = tgt;
    if (item) item.menu = tgt;
  }
}

/**
 * setscreen(&screen, frequent): set the backdrop screen; the bool rides as a
 * 0/1 const after the ref and says whether the screen re-runs on a timer.
 * @type {IpoBuiltin}
 */
function bSetscreen(vm, stack, item) {
  const ref = stack.find(isRef);
  const tgt = vm.target(ref, 'screen');
  if (tgt) {
    vm.out.screen = tgt;
    if (item) item.screen = tgt;
    const flags = stack.filter((x) => isPlainInt(x) || typeof x === 'boolean');
    vm.out.screenFrequent = flags.length ? !!flags[flags.length - 1] : false;
  }
}

/**
 * The line the next element lands on: the last one, opened if none exists.
 * @param {IpoVm} vm - the running VM
 * @returns {IpoLine}
 */
function currentLine(vm) {
  if (!vm.out.lines.length) vm.out.lines.push({ label: null, elements: [] });
  return vm.out.lines[vm.out.lines.length - 1];
}

/**
 * ftextout(text/slot, row, col, ...): a printed literal, or a printed VALUE
 * whose key comes from the binding. A bound value wins over a literal. A
 * drawn unit folds onto the value element sharing its base key instead of
 * becoming an element of its own.
 * @type {IpoBuiltin}
 */
/**
 * userboxopen(x, y, w, title, ...): INPA's progress window. The
 * whole-vehicle scripts open one over a long read and write the module
 * being asked into it (userboxftextout); a live run shows it as it fills.
 * @type {IpoBuiltin}
 */
function bUserboxOpen(vm, stack) {
  const strs = stack.filter((x) => isPlainStr(x) || isBound(x)).map(asStr);
  vm.userbox = { title: strs.find((s) => s.trim()) || '', lines: [] };
  if (vm.onUserbox) vm.onUserbox(vm.userbox);
}

/**
 * userboxclose(): the progress window goes away.
 * @type {IpoBuiltin}
 */
function bUserboxClose(vm) {
  vm.userbox = null;
  if (vm.onUserbox) vm.onUserbox(null);
}

/**
 * userboxclear(): the window stays, its lines go.
 * @type {IpoBuiltin}
 */
function bUserboxClear(vm) {
  if (!vm.userbox) return;
  vm.userbox.lines = [];
  if (vm.onUserbox) vm.onUserbox(vm.userbox);
}

/**
 * The foreground / background pair a colour builtin was handed: its last
 * two integer arguments (userboxsetcolor leads with the box number).
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {{fg: number, bk: number}|null} null when the call named no pair
 */
function ipoColorArgs(stack) {
  const n = allInts(stack);
  if (n.length < 2) return null;
  return { fg: n[n.length - 2], bk: n[n.length - 1] };
}

/**
 * setcolor(FgColor, BkColor): the colour every text printed after it takes.
 * Recorded on the run so a host that draws colour can honour it; the
 * browser's skins keep their own palette.
 * @type {IpoBuiltin}
 */
function bSetcolor(vm, stack) {
  const c = ipoColorArgs(stack);
  if (c) vm.out.color = c;
}

/**
 * userboxsetcolor(BoxNum, FgColor, BkColor): the progress window's colours.
 * @type {IpoBuiltin}
 */
function bUserboxSetcolor(vm, stack) {
  const c = ipoColorArgs(stack);
  if (c && vm.userbox) vm.userbox.color = c;
}

/**
 * userboxftextout(text, row, col ...): a line of the progress window. It is
 * also a textout, so a body without a box paints it with the screen.
 * @type {IpoBuiltin}
 */
function bUserboxTextout(vm, stack) {
  if (vm.userbox) {
    const t = firstText(stack);
    if (t != null && String(asStr(t)).trim()) {
      vm.userbox.lines.push(asStr(t));
      if (vm.onUserbox) vm.onUserbox(vm.userbox);
    }
  }
  bTextout(vm, stack);
}

/**
 * A screen area the body blanks: recorded for the runtime, and every
 * element this cycle already printed inside it goes.
 * @param {Best2Vm} vm
 * @param {{row: number, col: number, h: number, w: number}} rect
 */
function ipoClearRect(vm, rect) {
  vm.out.clears.push(rect);
  const inside = (el) =>
    el.row != null &&
    el.col != null &&
    el.row >= rect.row &&
    el.row < rect.row + rect.h &&
    el.col >= rect.col &&
    el.col < rect.col + rect.w;
  for (const ln of vm.out.lines) {
    if (ln.elements) ln.elements = ln.elements.filter((el) => !inside(el));
  }
}

/**
 * clearrect(row, col, height, width): blank a rectangle of the screen
 * (the activation screens clear a gauge area before redrawing it).
 * @type {IpoBuiltin}
 */
function bClearRect(vm, stack) {
  const n = allInts(stack);
  if (n.length < 4) return;
  ipoClearRect(vm, {
    row: n[0],
    col: n[1],
    h: Math.max(0, n[2]),
    w: Math.max(0, n[3]),
  });
}

/**
 * ftextclear(text, row, col, size, attr): erase a text printed with
 * ftextout at the same place ("switch the ignition on" banners come and
 * go this way).
 * @type {IpoBuiltin}
 */
function bFtextClear(vm, stack) {
  const t = firstText(stack);
  const n = allInts(stack);
  if (n.length < 2) return;
  const len = t == null ? 1 : Math.max(1, asStr(t).length);
  ipoClearRect(vm, { row: n[0], col: n[1], h: 1, w: len });
}

function bTextout(vm, stack) {
  if (vm.onText) {
    const t = firstText(stack);
    if (t != null && String(t).trim()) vm.onText(asStr(t));
  }
  let key = null,
    also = [],
    liveText = null;
  for (const x of stack) {
    if (isBound(x) && x.key) {
      key = x.key;
      also = (x.extra || []).filter((k) => k !== key);
      liveText = x.s;
      break;
    }
    const sl = isBound(x) ? x.slot : isSlot(x) ? x : null;
    if (sl != null) {
      key = vm.bindKey(sl.sc, sl.n);
      if (key) break;
    }
  }
  const lit = firstStr(stack);
  if (key == null && lit == null) return;
  const ints = allInts(stack);
  const line = currentLine(vm);
  if (key && IPO_UNIT_KEY_RE.test(key.toUpperCase())) {
    for (let e = line.elements.length - 1; e >= 0; e--) {
      const el = line.elements[e];
      if (
        el.key &&
        baseKey(el.key) === baseKey(key) &&
        !IPO_UNIT_KEY_RE.test(el.key.toUpperCase())
      ) {
        el.unit = key;
        return;
      }
    }
  }
  /** @type {IpoElement} */
  let el;
  if (key) {
    el = { t: 'value', key };
    // the text the value HAD when drawn: a live run fed real results, and
    // the painter shows this rather than polling the key again
    if (vm.wireJobs && liveText != null && liveText !== '') el.s = liveText;
    if (also.length) el.also = also;
    const amap = stack.map((x) => (isBound(x) ? x.amap : null)).find((m) => m);
    if (amap) el.map = amap;
  } else {
    el = { t: 'text', s: lit };
  }
  if (ints.length >= 2) {
    el.row = ints[0];
    el.col = ints[1];
  }
  // the colour setcolor chose for what follows rides on the live cell so a
  // host that draws colour (the terminal UI) can; offline the element stays
  // byte-identical to the Python twin's
  if (vm.wireJobs && vm.out.color) el.color = vm.out.color;
  line.elements.push(el);
}

/**
 * The lines of INPA's hexdump: one per 16 bytes, the address (the start
 * address plus the line's offset, in hex, at least as wide as the start
 * address was written) then the bytes as two hex digits each. A start
 * address that is not hex counts from 0.
 * @param {string} startAdr - the address the bytes were read from ("0x1000")
 * @param {number[]} bytes - the bytes to show
 * @returns {string[]}
 */
function ipoHexdumpLines(startAdr, bytes) {
  const digits = String(startAdr || '')
    .trim()
    .replace(/^0x/i, '');
  const base = /^[0-9a-f]+$/i.test(digits) ? parseInt(digits, 16) : 0;
  const width = Math.max(IPO_HEXDUMP_ADDR_MIN, digits.length);
  const out = [];
  for (let i = 0; i < bytes.length; i += IPO_HEXDUMP_LINE) {
    const addr = (base + i).toString(16).toUpperCase().padStart(width, '0');
    const hex = bytes
      .slice(i, i + IPO_HEXDUMP_LINE)
      .map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0'));
    out.push(`${addr}  ${hex.join(' ')}`);
  }
  return out;
}

/**
 * hexdump(StartAdr, numbytes, row, col): the bytes of the last
 * INPAapiResultBinary painted as a hex table at (row, col), the way the
 * Speicher-lesen screens show memory. The bytes come from the wire, so
 * offline there is nothing to paint (the lift sees the call, not a table).
 * Each line is printed as ftextout would print it, one row down from the
 * last, so the grid, the sheet and Select treat it as text.
 * @type {IpoBuiltin}
 */
function bHexdump(vm, stack) {
  if (!vm.wireJobs) return;
  const key = vm.globals.get('__pending_binary__');
  if (!key || !vm.host || typeof vm.host.raw !== 'function') return;
  const set = vm.globals.get('__pending_binary_set__');
  const hex = ipoBinaryHex(
    vm.host.raw(key, { set: set == null ? undefined : set })
  );
  if (!hex) return;
  let bytes = (hex.match(/[0-9A-F]{2}/g) || []).map((h) => parseInt(h, 16));
  const args = stack.filter((x) => !isRef(x));
  const count = args.length > 1 ? Math.trunc(num(args[1])) : bytes.length;
  if (count > 0) bytes = bytes.slice(0, count);
  const row = args.length > 2 ? Math.trunc(num(args[2])) : 0;
  const col = args.length > 3 ? Math.trunc(num(args[3])) : 0;
  const startAdr = args.length ? asStr(args[0]) : '';
  ipoHexdumpLines(startAdr, bytes).forEach((text, i) =>
    bTextout(vm, [text, row + i, col])
  );
}

/**
 * The element a lamp or bar builtin declares, placed on the current line.
 * Offline the row/col come from the int scan the Python twin uses (for
 * byte-identical IR); LIVE the value comes first and may itself be an int
 * (digitalout's bool arrives as 1/0 from a result compare), so per Inpa.h's
 * (val, row, col, ...) the two ints after the value are taken by position.
 * Wire mode also fills the cell's text: digitalout shows one of its two words
 * for the value it was handed, analogout shows the number; the offline twins
 * emit the declaration, never a value.
 * @param {IpoVm} vm - the running VM
 * @param {IpoValue[]} stack - the call's arguments
 * @param {'analog'|'digital'} kind - which instrument
 * @returns {IpoElement} the element pushed
 */
function drawField(vm, stack, kind) {
  const ints = allInts(stack);
  const strs = allStrs(stack);
  /** @type {IpoElement} */
  const el = { t: kind === 'analog' ? 'gauge' : 'lamp' };
  if (ints.length >= 2) {
    el.row = ints[0];
    el.col = ints[1];
  }
  if (vm.wireJobs && stack.length >= 3) {
    const isInt = (x) => isPlainInt(x) && typeof x !== 'boolean';
    if (isInt(stack[1]) && isInt(stack[2])) {
      el.row = stack[1];
      el.col = stack[2];
    }
  }
  let key = keyed(stack);
  if (key == null) {
    let sl = null;
    for (const x of stack)
      if (isBound(x) && x.slot) {
        sl = x.slot;
        break;
      }
    if (sl == null) sl = stack.find(isSlot) || null;
    if (sl != null) key = vm.bindKey(sl.sc, sl.n);
  }
  if (key) el.key = key;
  if (kind === 'digital' && strs.length >= 2) {
    el.on = strs[strs.length - 2].trim();
    el.off = strs[strs.length - 1].trim();
  }
  if (vm.wireJobs && stack.length) {
    const v = stack[0];
    const n = isBound(v)
      ? parseFloat(v.s)
      : isFloat(v)
        ? v.v
        : typeof v === 'number' || typeof v === 'boolean'
          ? Number(v)
          : NaN;
    if (kind === 'digital') {
      const on = !Number.isNaN(n) ? n !== 0 : isBound(v) && !!v.s.trim();
      el.s = on ? (el.on != null ? el.on : '1') : el.off != null ? el.off : '0';
    } else {
      el.s = Number.isNaN(n) ? (isBound(v) ? v.s : '') : String(n);
    }
  }
  currentLine(vm).elements.push(el);
  return el;
}

/**
 * analogout(val, row, col, min, max, minvalid, maxvalid, fmt): a bar. The
 * bounds are the numbers after the first three arguments (ints and floats
 * both count, as in Python: `[x for x in stack[3:] if isinstance(x,
 * (int,float)) and not bool]`); the format is the first non-blank string-like
 * argument (a fmt built by concatenation is a bound value).
 * @type {IpoBuiltin}
 */
function bAnalogout(vm, stack) {
  const el = drawField(vm, stack, 'analog');
  const nums = stack
    .slice(3)
    .filter(
      (x) => isFloat(x) || (typeof x === 'number' && typeof x !== 'boolean')
    )
    .map(num);
  if (nums.length >= 2) {
    el.min = nums[0];
    el.max = nums[1];
  }
  if (nums.length >= 4) {
    el.warnLo = nums[2];
    el.warnHi = nums[3];
  }
  const fmt = stack.find(
    (x) => (isPlainStr(x) || isBound(x)) && asStr(x).trim()
  );
  if (fmt) el.fmt = asStr(fmt).trim();
  // live text in the declared format ("6.2" = width 6, 2 decimals). The
  // format is the LAST plain string argument; the first string-like value on
  // the stack can be the reading itself (a bound real with a long tail),
  // which is not a format and once asked toFixed for 100+ digits.
  if (vm.wireJobs && el.s != null) {
    let fmtStr = null;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (isPlainStr(stack[k]) && stack[k].trim()) {
        fmtStr = stack[k].trim();
        break;
      }
    }
    const m = fmtStr ? IPO_ANALOG_FMT_RE.exec(fmtStr) : null;
    const n = Number(el.s);
    if (m && !Number.isNaN(n)) {
      const digits = Math.max(0, Math.min(IPO_MAX_DECIMALS, Number(m[2])));
      el.s = n.toFixed(digits);
    }
  }
}

/**
 * multianalogout: several analogout groups in one call, each ended by its
 * non-blank format string; a call with no format is one plain analogout.
 * @type {IpoBuiltin}
 */
function bMultiAnalogout(vm, stack) {
  let group = [],
    drawn = 0;
  for (const x of stack) {
    group.push(x);
    if (isPlainStr(x) && x.trim()) {
      bAnalogout(vm, group);
      drawn += 1;
      group = [];
    }
  }
  if (!drawn) bAnalogout(vm, stack);
}

/**
 * digitalout(val, row, col, TrueText, FalseText): a lamp.
 * @type {IpoBuiltin}
 */
function bDigitalout(vm, stack) {
  drawField(vm, stack, 'digital');
}

/**
 * messagebox(title, body): recorded, and tapped to onText. The body is often
 * a concatenation, so a bound value counts as text (Python's isinstance str).
 * @type {IpoBuiltin}
 */
function bMessage(vm, stack, item) {
  const strs = stack.filter((x) => isPlainStr(x) || isBound(x)).map(asStr);
  if (vm.onText && strs.length) vm.onText(strs.join(' — '));
  if (strs.length) {
    vm.out.messages.push({
      title: strs[0],
      body: strs.length > 1 ? strs[1] : null,
    });
    if (item) (item.messages = item.messages || []).push(strs[0]);
  }
}

/**
 * select(): the item is INPA's Select key (a line filter picker).
 * @type {IpoBuiltin}
 */
function bSelect(vm, stack, item) {
  if (item && !item.action) item.action = 'select';
}

/**
 * deselect(): the item is INPA's Deselect key; LIVE, every logical line shows
 * again.
 * @type {IpoBuiltin}
 */
function bDeselect(vm, stack, item) {
  if (item && !item.action) item.action = 'deselect';
  if (vm.wireJobs) vm.out.deselect = true;
}

/**
 * exit(): the script ends itself.
 * @type {IpoBuiltin}
 */
function bExit(vm, stack, item) {
  if (item) item.action = 'exit';
  vm.out.exit = true;
}

/**
 * blankscreen: the next paint starts from an empty grid.
 * @type {IpoBuiltin}
 */
function bBlankscreen(vm) {
  vm.out.blank = true;
  vm.out.lines = [];
}

/**
 * printscreen: the item is INPA's Print key.
 * @type {IpoBuiltin}
 */
function bPrint(vm, stack, item) {
  if (item) item.action = 'printscreen';
}

/**
 * scriptchange("IHKA46") hands the WHOLE UI to another .IPO: INPA unloads
 * this script and runs the named one, inpainit and all. KLIMA_5B does it from
 * its variant check (IHKA46_3 -> IHKA46, IHKA85 -> IHKX85), so a script that
 * never names a variant in its own menus is still correct -- it left before
 * the menu drew. Record the target for the entry gate to follow; the key
 * itself stays an app-side tool.
 * @type {IpoBuiltin}
 */
function bScriptchange(vm, stack, item) {
  const name = firstText(stack);
  if (name != null && asStr(name)) vm.out.scriptChange = asStr(name);
  if (item) item.appTool = true;
}

/**
 * callwin: an external program; the item is an app-side tool.
 * @type {IpoBuiltin}
 */
function bCallwin(vm, stack, item) {
  if (item) item.appTool = true;
}

/**
 * viewclose(): INPA closes its viewer window. Live, the run says so and
 * drops a view it opened earlier in the same body; a viewopen after it
 * sets a new one, which wins (the runtime reads the view first, the close
 * only when there is none). Offline nothing is lifted from a window.
 * @type {IpoBuiltin}
 */
function bViewclose(vm) {
  if (!vm.wireJobs) return;
  vm.out.view = null;
  vm.out.viewClose = true;
}

/**
 * A builtin with no effect on the model (window chrome, stop).
 * @type {IpoBuiltin}
 */
function bNoop() {}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    bSetTitle,
    bSetitem,
    bSetmenu,
    bSetscreen,
    bTextout,
    ipoHexdumpLines,
    bHexdump,
    bSetcolor,
    bUserboxSetcolor,
    bViewclose,
    drawField,
    bAnalogout,
    bMultiAnalogout,
    bDigitalout,
    bMessage,
    bSelect,
    bDeselect,
    bExit,
    bBlankscreen,
    bPrint,
    bScriptchange,
    bCallwin,
    bNoop,
  };
}
