/**
 * @file Wire-mode suspensions: which builtins the DRIVEN executor must hand
 * to the renderer instead of answering itself, and the pending-action shape
 * each produces. A live actuator (INPA's %STATE loop) parks at a state,
 * shows a picker, and on the user's pick resumes past the yield into the
 * job; a live input asks the user; a live job goes on the wire. The
 * renderer does the async part and calls resume() to continue.
 */

/**
 * What a driven run hands back when it cannot continue on its own. `kind`
 * says why; `out` is the emissions so far (a parked machine's drawn screen
 * IS the picker).
 * @typedef {object} IpoStep
 * @property {'done'|'yield'|'job'|'wait'|'input'|'message'|'toggle'|'print'|'select'|'exit'} kind -
 *   done: the proc finished; yield: parked at a %STATE; job: a wire job to
 *   run and feed back; wait: a timed wartezeit; input: an INPA prompt;
 *   message: a blocking messagebox; toggle: the component picker; print:
 *   printscreen; select: INPA's line filter; exit: the script ended itself
 * @property {Emissions} [out] - emissions so far
 * @property {string} [name] - yield: the state label
 * @property {string} [job] - job: the job name
 * @property {string|null} [sgbd] - job: the SGBD the script addressed
 * @property {string|null} [arg] - job: the argument
 * @property {number} [ms] - wait: how long
 * @property {string[]} [prompts] - input: the prompt strings, title first
 * @property {number} [refs] - input: how many out-refs (fields) it fills
 * @property {number|null} [lo] - input: accepted range low, when declared
 * @property {number|null} [hi] - input: accepted range high, when declared
 * @property {IpoValue[]} [stack] - input/toggle: the call's arguments, kept for the resume store
 * @property {string} [title] - message: the box title
 * @property {string|null} [body] - message: the box text
 * @property {boolean} [multiple] - toggle/select: MultipleSelectFlag
 * @property {boolean} [argnum] - toggle: ArgNumFlag (line numbers instead of keys)
 */

/**
 * The step kinds that park the driven loop until the renderer resumes it.
 * @type {Set<string>}
 */
const IPO_SUSPEND_KINDS = new Set([
  'file', // the save-as dialog (structures.js ipoDllFileDialog)
  'job',
  'wait',
  'input',
  'message',
  'toggle',
  'print',
  'select',
  'exit',
]);

/** The job builtins whose sends the driven executor hands to the renderer. */
const IPO_JOB_BUILTINS = new Set([
  'INPAapiJob',
  'INP1apiJob',
  'INPAapiJobData',
]);

/** delay(ms) -- Inpa.h's name; the disassembler's builtin_1b. */
const IPO_WAIT_BUILTIN = 'delay';

/** builtin_16 = togglelist. */
const IPO_TOGGLELIST_BUILTIN = 'builtin_16';

/** The input builtins by name, for the ones the table maps without a name. */
const IPO_INPUT_NAME_RE = /^input(int|real|hex|string)?$/;

/**
 * The text of a job argument on the stack: a plain or bound string, or a
 * number's text; null for anything else.
 * @param {IpoValue} x - the argument
 * @returns {string|null}
 */
function jobArgText(x) {
  if (isPlainStr(x)) return x;
  if (isBound(x)) return x.s;
  if (typeof x === 'number') return String(x);
  if (isFloat(x)) return String(x.v);
  return null;
}

/**
 * The 0/1 flag an argument carries (a boxed float, a bound value or a number).
 * @param {IpoValue} v - the argument
 * @returns {boolean}
 */
function flagArg(v) {
  return !!(isFloat(v) ? v.v : isBound(v) ? Number(v.s) : Number(v));
}

/**
 * INPA's `stop` keyword as the disassembler names it: builtin 0x14.
 * @type {string}
 */
const IPO_STOP_BUILTIN = 'builtin_14';

/**
 * Builtin dispatch for the resumable path. Identical to `_builtin` EXCEPT
 * that, in wire mode, the builtins the renderer must answer are not run
 * offline -- they return a pending action instead. Which jobs must reach the
 * renderer even when the VM is not driving the wire: the ones that CHANGE
 * the car, by the write classifier's verdict (token-based, default-deny, the
 * same one the job route enforces -- not a name prefix: ANSTEUERN_*,
 * LAMPEN_TEST, SG_RESET are writes too).
 * @param {IpoVm} vm - the running VM
 * @param {IpoToken} t - the call token
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {IpoStep|null} the pending action, or null when the builtin ran
 */
function ipoDriveBuiltin(vm, t, stack) {
  const name = ipoBuiltinName(t);
  if (IPO_JOB_BUILTINS.has(name)) {
    const sgbd = stack.length > 0 ? jobArgText(stack[0]) : null;
    const job = stack.length > 1 ? jobArgText(stack[1]) : null;
    const arg = stack.length > 2 ? jobArgText(stack[2]) : null;
    // classifier absent: never assume safe
    const isDrive = typeof isWriteJob === 'function' ? isWriteJob(job) : true;
    if (job && (vm.wireJobs || isDrive)) {
      // hand the drive to the renderer; it confirms, registers for release,
      // sends on the wire, and hands the result sets back through resume()
      return {
        kind: 'job',
        job,
        sgbd: sgbd || null,
        arg: arg || null,
        out: vm.out,
      };
    }
  }
  // input builtins: INPA asks the user and parks until getinputstate says
  // confirmed. Offline they store '0' -- which a LIVE run must never send
  // (LLERH's Select would command idle target 0). Suspend instead; the
  // renderer shows INPA's own prompt and resume() stores the typed value.
  // inputdigital too: offline it stores the CONFIRMING placeholder (so the
  // static lift keeps the yes-branch), but live that would answer INPA's
  // "Are you sure?" for the user -- and IHKA46's compressor-lock key sends
  // on that answer. Suspend, ask, store what was pressed.
  if (
    vm.wireJobs &&
    (BUILTINS[name] === bInput ||
      BUILTINS[name] === bInputDigital ||
      IPO_INPUT_NAME_RE.test(name))
  ) {
    const prompts = stack.filter((x) => isPlainStr(x) && x.trim());
    // bounds may be ints (inputint) or doubles (builtin_40: MS43 pushes
    // 512.0/1600.0); take the last two numerics either way
    const nums = stack
      .map((x) => (isPlainInt(x) ? x : isFloat(x) ? x.v : null))
      .filter((x) => x != null && Number.isFinite(x));
    return {
      kind: 'input',
      name,
      prompts,
      refs: stack.filter(isRef).length,
      lo: nums.length > 1 ? nums[nums.length - 2] : null,
      hi: nums.length > 1 ? nums[nums.length - 1] : null,
      stack,
      out: vm.out,
    };
  }
  // A LIVE messagebox BLOCKS the script until OK, like INPA's own: the
  // renderer shows it in sequence and resumes. Offline it is only recorded.
  if (vm.wireJobs && BUILTINS[name] === bMessage) {
    vm._builtin(t, stack, null);
    const M = vm.out.messages;
    const m = M.length ? M[M.length - 1] : { title: '', body: null };
    return { kind: 'message', title: m.title, body: m.body, out: vm.out };
  }
  // INPA's Select key: select(MultipleSelectFlag) lists the current
  // screen's named logical lines and shows only the ones picked. Park;
  // the renderer offers the list and keeps the choice.
  if (vm.wireJobs && name === 'select') {
    const flag = stack.length ? stack[0] : 0;
    return {
      kind: 'select',
      multiple: !!(isFloat(flag) ? flag.v : Number(flag)),
      out: vm.out,
    };
  }
  // INPA's Print key (printscreen): live, the renderer prints the page --
  // the browser's print dialog stands in for INPA's printer
  if (vm.wireJobs && name === 'printscreen') {
    return { kind: 'print', out: vm.out };
  }
  // A LIVE togglelist is INPA's component picker: park until the renderer
  // hands back the pick ({ort, ein}); resume re-runs the builtin with it.
  // togglelist(MultipleSelectFlag, ArgNumFlag, ->ApiToggleString)
  if (vm.wireJobs && name === IPO_TOGGLELIST_BUILTIN && vm._pickInput == null) {
    return {
      kind: 'toggle',
      stack,
      multiple: stack.length > 0 && flagArg(stack[0]),
      argnum: stack.length > 1 && flagArg(stack[1]),
      out: vm.out,
    };
  }
  if (vm.wireJobs && BUILTINS[name] === bExit) {
    vm._builtin(t, stack, null);
    return { kind: 'exit', out: vm.out };
  }
  if (vm.wireJobs && IPO_STRUCT_FNS.has(name)) {
    ipoStructureCall(vm, name, stack);
    return null;
  }
  // wartezeit: offline a noop; a guided run honours it -- the S_ZUHEIZ
  // Pruefung waits 2000ms after DIAGNOSE_ENDE and 10000ms for the heater's
  // run-on, and rushing those changes what the ECU answers.
  if (vm.wireJobs && name === IPO_WAIT_BUILTIN) {
    const ms = stack.find((x) => isPlainInt(x));
    return { kind: 'wait', ms: ms != null ? ms : 0, out: vm.out };
  }
  // INPA's `stop`: end the body being run (this LINE, this ITEM, this
  // proc) here. The corpus puts it after an error messagebox ("box, then
  // stop, else read the results") and at the head of a screen that has
  // nothing selected yet -- MS45's injector screen guards its STEUERN_EV_n
  // send with `if (sel == 0) stop`, and falling through sent a job named
  // after the on-time. Offline it stays a noop (the derived twin's stamp).
  if (vm.wireJobs && name === IPO_STOP_BUILTIN) return 'stop';
  // not a drive: run it exactly as the offline builtin would
  vm._builtin(t, stack, null);
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IPO_SUSPEND_KINDS, ipoDriveBuiltin };
}
