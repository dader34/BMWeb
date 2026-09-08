/**
 * @file Builtins that talk to the diagnostic API and the user: INPAapiJob and
 * the INPAapiResult* reads, string arrays, binary results, the input
 * dialogs, the component picker, files, timers and state-machine entry.
 */

/** getinputstate's "confirmed" answer: the guard tests `== 0`. */
const IPO_INPUT_CONFIRMED = 0;

/** What an offline input stores: never sent live (see ipoDriveBuiltin). */
const IPO_INPUT_PLACEHOLDER = '0';

/**
 * INPAapiJob(sgbd, job, arg): record the job, attribute it to the item, mark
 * the per-line arg boundary, and run it through the host. Python's _b_job
 * tests isinstance(x, str), TRUE for _Bound: sgbd/job/arg are frequently
 * concatenations (a bound value), so accept those and read their text --
 * otherwise the job arg (LWS5's coding block index, LAR;0x;0) and an
 * empty-string sgbd are lost.
 * @type {IpoBuiltin}
 */
function bJob(vm, stack, item) {
  const strv = (x) => (isPlainStr(x) ? x : isBound(x) ? x.s : null);
  const sgbd = stack.length > 0 ? strv(stack[0]) : null;
  const job = stack.length > 1 ? strv(stack[1]) : null;
  const arg = stack.length > 2 ? strv(stack[2]) : null;
  if (job == null) return;
  /** @type {IpoJobRecord} */
  const rec = { job, sgbd: sgbd == null ? null : sgbd };
  if (arg && !vm.inputFed) rec.arg = arg;
  vm.out.jobs.push(rec);
  if (item && !('job' in item)) {
    item.job = job;
    if (rec.arg) item.jobArg = rec.arg;
  }
  // Per-line arg boundary (per-wheel loop draws one line per job arg).
  if (rec.arg) {
    let last = vm.out.lines.length
      ? vm.out.lines[vm.out.lines.length - 1]
      : null;
    const drawn = !!(last && last.elements && last.elements.length);
    if (drawn && last.jobArg != null && last.jobArg !== rec.arg) {
      vm.out.lines.push({ label: null, elements: [] });
      last = vm.out.lines[vm.out.lines.length - 1];
    }
    if (last && !('jobArg' in last)) last.jobArg = rec.arg;
  }
  vm.globals.set('__last_job__', vm.host.job(sgbd, job, arg, null));
}

/**
 * INPAapiFsMode: the item switches the fault-read mode.
 * @type {IpoBuiltin}
 */
function bFsmode(vm, stack, item) {
  if (item) item.faultRead = true;
}

/**
 * INPAapiCheckJobStatus: the host's verdict on the last job.
 * @type {IpoBuiltin}
 */
function bCheckStatus(vm) {
  vm.globals.set('__status__', vm.host.status());
}

/**
 * INPAapiResult*(->dest, KEY, set[, format]): read a result key into the last
 * out-ref, bound to the key; a two-ref form (INP1api...) gets rc = 1 in the
 * first. The set number is the one numeric argument (a literal or a bound
 * variable); the format is a string.
 * @param {IpoVm} vm - the running VM
 * @param {IpoValue[]} stack - the call's arguments
 * @param {IpoItem|null} item - the item being executed
 * @param {boolean} [integer] - read as a number (INPAapiResultInt)
 * @returns {void}
 */
function bResult(vm, stack, item, integer) {
  const key = stack.find(isPlainStr) || null;
  const setArg = stack.find((x) => !isRef(x) && !isPlainStr(x));
  const set = setArg != null ? Math.trunc(num(setArg)) : undefined;
  let val = key ? vm.host.result(key, { integer, set }) : '';
  const refs = stack.filter(isRef);
  if (refs.length >= 2) storeOut(vm, [refs[0]], 1);
  const dest = refs.length ? refs[refs.length - 1] : null;
  if (dest != null) {
    const { dsc: sc, n, map } = vm._refTarget(dest, vm.frame);
    if (key) {
      val = mkBound(mkSlot(sc, n), val == null ? '' : asStr(val), key);
      vm.setBind(sc, n, key);
    }
    vm.globals.set(`ref:${n}`, val);
    map.set(n, val);
  }
  if (key) {
    vm.globals.set('__lastkey__', key);
    vm.out.reads.push(key);
  }
}

/**
 * INPAapiResultInt: bResult reading a number.
 * @type {IpoBuiltin}
 */
function bResultInt(vm, stack, item) {
  bResult(vm, stack, item, true);
}

/**
 * INP1apiErrorCode: no error.
 * @type {IpoBuiltin}
 */
function bErrorCode(vm, stack) {
  storeOut(vm, stack, 0);
}

/**
 * INP1apiErrorText: no error text.
 * @type {IpoBuiltin}
 */
function bErrorText(vm, stack) {
  storeOut(vm, stack, '');
}

/**
 * INPAapiResultSets(->n) / INP1apiResultSets(->rc, ->n): how many sets the
 * job produced -- the wire's own count when a feed carries it (a fault list
 * is one set per fault plus the JOB_STATUS set: INPA subtracts one and
 * loops); 1 for the offline hosts.
 * @type {IpoBuiltin}
 */
function bResultSets(vm, stack) {
  const refs = stack.filter(isRef);
  if (refs.length >= 2) storeOut(vm, [refs[0]], 1);
  const n =
    vm.host && typeof vm.host.count === 'function' ? vm.host.count() : 1;
  storeOut(vm, refs.length ? [refs[refs.length - 1]] : [], n);
}

/**
 * StrArrayCreate(->rc, ->handle): a fresh string array.
 * @type {IpoBuiltin}
 */
function bStrArrayCreate(vm, stack) {
  const refs = stack.filter(isRef);
  vm._arrN += 1;
  vm.strArrays.set(vm._arrN, new Map());
  if (refs.length >= 2) storeOut(vm, [refs[0]], 1);
  storeOut(vm, refs.length ? [refs[refs.length - 1]] : [], vm._arrN);
}

/**
 * StrArrayWrite(handle, index, text).
 * @type {IpoBuiltin}
 */
function bStrArrayWrite(vm, stack) {
  // StrArrayWrite(array, index, text): the text is usually computed (a
  // module's name + its fault count), not a literal
  const args = stack.filter((x) => !isRef(x));
  if (args.length < 3) return;
  const id = Math.trunc(num(args[0]));
  const idx = Math.trunc(num(args[1]));
  const txt = asStr(args[2]);
  if (vm.strArrays.has(id)) vm.strArrays.get(id).set(idx, txt);
}

/**
 * StrArrayRead(handle, index, ->text): the entry, bound to the index's key
 * and carrying the whole array as a lookup map so a painter can caption the
 * value.
 * @type {IpoBuiltin}
 */
function bStrArrayRead(vm, stack) {
  const vals = stack.filter((x) => !isRef(x));
  const arr = vals.length
    ? vm.strArrays.get(Math.trunc(num(vals[0]))) || new Map()
    : new Map();
  const text = vals.length > 1 ? arr.get(Math.trunc(num(vals[1]))) || '' : '';
  const out = mkBound(null, text, keyed(stack));
  const amap = {};
  for (const [k, v] of arr) amap[String(k)] = v;
  out.amap = Object.keys(amap).length ? amap : null;
  storeOut(vm, stack, out, out.key);
}

/**
 * INPAapiResultBinary(KEY): a coding image; the next store (or
 * GetBinaryDataString) binds to the key.
 * @type {IpoBuiltin}
 */
/**
 * builtin_90(array, &n): how many entries a string array holds. The
 * whole-vehicle scripts fill an array with the modules that answered with
 * faults and walk it `for (i = 0; i < n; i++)` to write the short overview
 * of the protocol, so n must be the real count, not a slot.
 * @param {Best2Vm} vm
 * @param {*[]} stack
 */
function bStrArraySize(vm, stack) {
  const vals = stack.filter((x) => !isRef(x));
  const arr = vals.length
    ? vm.strArrays.get(Math.trunc(num(vals[0]))) || new Map()
    : new Map();
  storeOut(vm, stack, arr.size);
}

function bResultBinary(vm, stack) {
  // INPAapiResultBinary(&rc, key, set): the key is a literal or a variable
  // holding one (protokoll_hexcode passes its parameter), the set a number
  let key = null;
  let set = null;
  for (const a of stack) {
    if (isRef(a)) continue;
    const s = asStr(a);
    if (key == null && /^[A-Za-z_]/.test(s)) key = s;
    else if (set == null && s !== '' && Number.isFinite(Number(s)))
      set = Math.trunc(Number(s));
  }
  if (key) {
    vm.globals.set('__pending_binary__', key);
    // the set it was asked of, for the live read behind GetBinaryDataString
    vm.globals.set('__pending_binary_set__', set);
    vm.out.reads.push(key);
  }
  // rc: the script prints "????" for a code it could not read; live that
  // is a result the wire did not carry, offline every read succeeds
  const refs = stack.filter(isRef);
  if (refs.length) {
    const have =
      !vm.wireJobs ||
      (key &&
        vm.host &&
        typeof vm.host.raw === 'function' &&
        vm.host.raw(key, { set: set == null ? undefined : set }) != null);
    storeOut(vm, [refs[0]], have ? 1 : 0);
  }
}

/**
 * A binary result as the hex text INPA's GetBinaryDataString hands the
 * script ("27C3"): bytes from a typed array, a plain array, or the object
 * a typed array turns into through JSON; a string with its separators
 * dropped ("27-C3", "0x27C3"); a number as four digits.
 * @param {*} v - the result value
 * @returns {string}
 */
function ipoBinaryHex(v) {
  if (v == null || v === '') return '';
  const byte = (b) =>
    (Number(b) & 0xff).toString(16).toUpperCase().padStart(2, '0');
  if (Array.isArray(v) || ArrayBuffer.isView(v))
    return Array.from(v, byte).join('');
  if (typeof v === 'number')
    return Number.isFinite(v)
      ? (v >>> 0).toString(16).toUpperCase().padStart(4, '0')
      : '';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => /^\d+$/.test(k));
    if (keys.length)
      return keys
        .sort((a, b) => a - b)
        .map((k) => byte(v[k]))
        .join('');
  }
  return String(v)
    .replace(/^0x/i, '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
}

/**
 * GetBinaryDataString(->dst, ->src, ...): the destination takes the source's
 * binding (or the pending binary key) so a sliced display stays bound.
 * @type {IpoBuiltin}
 */
function bGetBinaryDataString(vm, stack) {
  const refs = stack.filter(isRef);
  if (refs.length < 2) return;
  const dst = refs[0],
    src = refs[1];
  // a live run: GetBinaryDataString(&text, &length) gives the script the
  // bytes of the last INPAapiResultBinary as hex text, and their length in
  // characters (E46.IPO's protokoll_hexcode walks it two characters a byte)
  if (vm.wireJobs) {
    const key = vm.globals.get('__pending_binary__');
    const set = vm.globals.get('__pending_binary_set__');
    if (key && vm.host && typeof vm.host.raw === 'function') {
      const hex = ipoBinaryHex(
        vm.host.raw(key, { set: set == null ? undefined : set })
      );
      vm.globals.delete('__pending_binary__');
      vm.globals.delete('__pending_binary_set__');
      storeOut(vm, [dst], mkBound(null, hex, key), key);
      storeOut(vm, [src], hex.length);
      return;
    }
  }
  const dsc = dst[1] === IPO_REF_LOCAL && vm.frame != null ? LOCAL : GLOBAL;
  const ssc = src[1] === IPO_REF_LOCAL && vm.frame != null ? LOCAL : GLOBAL;
  let key = vm.bindKey(ssc, src[2]);
  if (!key) {
    key = vm.globals.get('__pending_binary__');
    vm.globals.delete('__pending_binary__');
  }
  if (!key) return;
  const val = mkBound(mkSlot(dsc, dst[2]), '0', key);
  vm.setBind(dsc, dst[2], key);
  if (dsc === GLOBAL) vm.globals.set(dst[2], val);
  else if (vm.frame) vm.frame.set(dst[2], val);
}

/**
 * getinputstate(->state): when the state machine is being DRIVEN (a resume
 * fed the user's on/off), that answer is the input state; the guard tests
 * `== 0`, so a valid pick is 0. Offline it falls to the host's placeholder.
 * @type {IpoBuiltin}
 */
function bGetInputState(vm, stack) {
  const iv = vm._driveInput;
  storeOut(vm, stack, iv != null ? iv : vm.host.inputstate());
}

/**
 * builtin_16 = togglelist. Offline a noop (the picked row is runtime-only,
 * so the diff harness sees nothing). When DRIVEN, it writes the user's
 * picked component (an ORT key from the BITS table) into its out-var,
 * exactly as the widget does at runtime -- so the INPAapiJob that reads that
 * slot sends the pick as its argument (STEUERN_DIGITAL <ORT>).
 * @type {IpoBuiltin}
 */
function bToggleList(vm, stack) {
  if (vm._pickInput == null) return;
  storeOut(vm, stack, vm._pickInput);
}

/**
 * The input family (inputint, inputhex, input2int, ...): record the prompts
 * on the item, store the placeholder through every out-ref, and taint the
 * next job (mirrors Python _b_input: a job sent after an ask has no static
 * arg).
 * @type {IpoBuiltin}
 */
function bInput(vm, stack, item) {
  const prompts = stack.filter((x) => isPlainStr(x) && x.trim());
  if (item && prompts.length) {
    const have = item.prompt || (item.prompt = []);
    for (const p of prompts) if (!have.includes(p)) have.push(p);
  }
  for (const ref of stack.filter(isRef))
    storeOut(vm, [ref], IPO_INPUT_PLACEHOLDER);
  vm.inputFed = true;
}

/**
 * inputdigital: capture+taint via bInput, then the CONFIRMING choice as the
 * placeholder -- the lift keeps the yes-branch's job (mirrors
 * _b_inputdigital).
 * @type {IpoBuiltin}
 */
function bInputDigital(vm, stack, item) {
  bInput(vm, stack, item);
  for (const ref of stack.filter(isRef)) storeOut(vm, [ref], 1);
}

/**
 * fileopen(path..., mode): open an in-memory file; the path is every
 * string/slot argument that is not the mode letter.
 * @type {IpoBuiltin}
 */
function bFileopen(vm, stack) {
  // fileopen(path, mode): the path is usually computed (folder + name +
  // extension), so take whatever string value the expression produced
  const args = stack.filter((x) => !isRef(x));
  let mode = 'r';
  const last = args.length > 1 ? asStr(args[args.length - 1]) : '';
  if (['r', 'w', 'a'].includes(last)) {
    mode = last;
    args.pop();
  }
  const path = args.map(asStr).join('');
  if (mode === 'w') vm.files.set(path, []);
  else if (mode === 'a' && !vm.files.has(path)) vm.files.set(path, []);
  if (mode !== 'r') vm.lastWritten = path;
  vm.fh = { path, mode, line: 0 };
}

/**
 * fileclose.
 * @type {IpoBuiltin}
 */
function bFileclose(vm) {
  vm.fh = null;
}

/**
 * viewopen(path): INPA opens the file the script just wrote in its viewer
 * window (the whole-vehicle fault protocol). The runtime shows the same
 * text as the screen and prints it as the sheet.
 * @param {Best2Vm} vm
 * @param {*[]} stack
 */
function bViewopen(vm, stack) {
  // viewopen(path, title): the path is computed (folder + name + extension),
  // the title is the window caption
  const args = stack.filter((x) => !isRef(x)).map(asStr);
  let path = args[0] || '';
  if (!vm.files.has(path) && vm.lastWritten && vm.files.has(vm.lastWritten))
    path = vm.lastWritten;
  vm.out.view = {
    path,
    title: args.length > 1 ? args[args.length - 1] : '',
    lines: [...(vm.files.get(path) || [])],
  };
}

/**
 * filewrite(text): append a line to the open file.
 * @type {IpoBuiltin}
 */
function bFilewrite(vm, stack) {
  if (!vm.fh || vm.fh.mode === 'r') return;
  // the line is usually computed (caption + value), not a literal
  const args = stack.filter((x) => !isRef(x));
  const txt = args.length ? asStr(args[0]) : '';
  if (!vm.files.has(vm.fh.path)) vm.files.set(vm.fh.path, []);
  vm.files.get(vm.fh.path).push(txt);
}

/**
 * fileread(->line): the next line of the open file, '' at its end.
 * @type {IpoBuiltin}
 */
function bFileread(vm, stack) {
  // fileread(&line, &status): status 0 while a line came, else the end --
  // the save keys copy the protocol with `while (status == 0)`
  let line = '';
  let status = 1;
  if (vm.fh && vm.fh.mode === 'r') {
    const lines = vm.files.get(vm.fh.path) || [];
    if (vm.fh.line < lines.length) {
      line = lines[vm.fh.line];
      vm.fh.line += 1;
      status = 0;
    }
  }
  const refs = stack.filter(isRef);
  if (refs.length) storeOut(vm, [refs[0]], line);
  if (refs.length > 1) storeOut(vm, [refs[1]], status);
}

/**
 * settimer(n, ms): arm one of INPA's per-script timer slots. A screen INIT
 * arms one and a LINE tests it every cycle; without them the test never
 * fires and a timed refresh runs on every tick instead.
 * @type {IpoBuiltin}
 */
function bSettimer(vm, stack) {
  const ints = allInts(stack);
  if (ints.length < 2) return;
  if (!vm.timers) vm.timers = new Map();
  const now = typeof vm.now === 'function' ? vm.now() : Date.now();
  vm.timers.set(ints[0], now + Math.max(0, ints[1]));
}

/**
 * testtimer(n, ->expired): 1 once the timer's deadline has passed.
 * @type {IpoBuiltin}
 */
function bTesttimer(vm, stack) {
  const ints = allInts(stack);
  const n = ints.length ? ints[0] : 0;
  const now = typeof vm.now === 'function' ? vm.now() : Date.now();
  const due = vm.timers && vm.timers.has(n) ? vm.timers.get(n) : null;
  const expired = due != null && now >= due ? 1 : 0;
  storeOut(vm, stack, expired);
}

/**
 * setstate/start(&sm): enter a state machine. LIVE the machine is a guided
 * procedure (togglelist -> job -> parks): running it through the offline
 * executor here stopped at its first %STATE and the driver never saw the
 * picker, so it is emitted for the driver to run. Offline it runs to its
 * first yield and the job it fired is attributed to the item (the simple
 * case; the togglelist/fixed-job recovery of ipo_vm.py's _b_setstate is a
 * refinement not needed here).
 * @type {IpoBuiltin}
 */
function bSetstate(vm, stack, item) {
  const ref = stack.find(
    (x) => isRef(x) && (x[1] === IPO_REF_STATE || x[1] === IPO_REF_STATE_ALT)
  );
  if (ref == null) return;
  const name = vm.byid('state', ref[2]);
  if (!name || !vm.procs[name]) return;
  if (item) item.stateEnter = name;
  if (vm.wireJobs) {
    vm.out.stateEnter = name;
    return;
  }
  if (vm.entered.has(name)) return;
  vm.entered.add(name);
  const before = vm.out.jobs.length;
  try {
    vm._exec(vm.procs[name], new Map());
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
  }
  if (item && !('job' in item) && vm.out.jobs.length > before) {
    const j = vm.out.jobs[before];
    item.job = j.job;
    item.stateJob = true;
    if (j.arg && !item.jobArg) item.jobArg = j.arg;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IPO_INPUT_CONFIRMED,
    bJob,
    bFsmode,
    bCheckStatus,
    bResult,
    bResultInt,
    bErrorCode,
    bErrorText,
    bResultSets,
    bStrArrayCreate,
    bStrArrayWrite,
    bStrArrayRead,
    bResultBinary,
    bGetBinaryDataString,
    bGetInputState,
    bToggleList,
    bInput,
    bInputDigital,
    bFileopen,
    bFileclose,
    bFilewrite,
    bFileread,
    bSettimer,
    bTesttimer,
    bSetstate,
  };
}
