// The test-module step player.
//
// A recovered test module is a graph, not a script: one entry step, a node
// list per step, and edges. This runs it. Nothing here touches the DOM or
// the bus -- the user and the car both arrive as injected functions -- so
// the whole engine is testable in node, which is the only way the branch
// semantics below can be held still while the screen around them changes.
//
//   const eng = new AblEngine(graph, {
//     ui: { message, selection, question, value, progress },
//     job: async (spec) => ({ sets }),      // the car
//     module: async (ref) => graph2,        // callModuleRef
//     native: { faultList, context },       // the services with no GUI
//   });
//   const verdict = await eng.run();        // 'Ok' | 'NotOk' | ...
//
// WHY A GRAPH WALKER AND NOT AN INTERPRETER. The recovery undid the
// compiler's control-flow flattening by walking it symbolically, so what
// ships is already the resolved shape: every branch's arms are node ids,
// every loop is a back edge. Re-deriving any of that here would be a second
// opinion about code we cannot see, and a second place to be wrong. So this
// walks what the JSON says and refuses what it does not cover.
//
// THE RULE THAT MAKES THE CONTROL FLOW COME OUT RIGHT: an unset register
// reads as zero. The compiler's exit dispatch is a chain of `num != 0` /
// `num3 != 1` tests on registers the recovery deliberately did not track,
// and in a step that ran to its end those registers hold 0 -- which is why
// the false arm is the one carrying `goto_step`. Treating unset as 0
// reproduces the real exit without the engine knowing anything about exit
// registers. It is NOT the same test as `x != null`, which asks whether a
// read happened at all; see ablCompare for why conflating the two stops
// every module at its first job.
//
// WHAT IT REFUSES. An unknown node kind halts the run with a message naming
// the kind and the step it sat in. A module that used a dialog no handler
// covers is a module this build cannot run honestly, and saying so is worth
// more than skipping the step and showing a procedure that quietly did less
// than the tool would have.

/** The module's verdict register, in the tool's own order. */
/**
 * How long one job may take before the flow treats it as no communication.
 *
 * Generous on purpose: a group probe legitimately walks several diagnostic
 * addresses, each waiting out its own bus timeout, so this is a backstop
 * against a promise that never settles rather than a performance limit.
 */
const ABL_JOB_TIMEOUT_MS = 60000;

/**
 * Reject a promise that takes too long, naming what it was waiting on.
 * @param {Promise<*>} p - the work
 * @param {number} ms - how long to allow
 * @param {string} what - for the message
 * @returns {Promise<*>}
 */
function ablWithTimeout(p, ms, what) {
  let timer = null;
  return Promise.race([
    Promise.resolve(p).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, rej) => {
      timer = setTimeout(
        () =>
          rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
        ms
      );
    }),
  ]);
}

const ABL_RESULTS = ['Ok', 'Verified', 'NotOk', 'Unknown', 'Repaired', 'None'];

/**
 * One halt: the engine stopped because it met something it does not model.
 */
class AblHalt extends Error {
  /**
   * @param {string} message - what stopped, in words a technician can act on
   * @param {object} [where] - {step, node, kind}
   */
  constructor(message, where) {
    super(message);
    this.name = 'AblHalt';
    /** @type {object} */
    this.where = where || {};
  }
}

/**
 * Render one recovered text object to a plain string.
 *
 * A text is `{en, text, name}`, a concat is `{text_concat:[...]}` whose
 * parts are texts or bare separator strings, and `{Plad_v}` placeholders
 * name module variables. Anything else (a null parameter, a bare string the
 * recovery left inline) renders as itself, because a missing text should
 * read as nothing rather than as "undefined".
 * @param {*} t - the text object, a string, or null
 * @param {Object<string, *>} [vars] - the module variables, for placeholders
 * @returns {string}
 */
function ablText(t, vars) {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map((x) => ablText(x, vars)).join('');
  if (Array.isArray(t.text_concat)) return ablConcat(t.text_concat, vars);
  let s = typeof t.en === 'string' ? t.en : '';
  // the recovery names the placeholders it found; substituting only those
  // keeps a literal brace in a text (a unit, a range) from being eaten
  const names = t.params && typeof t.params === 'object' ? t.params : null;
  if (names) {
    for (const k of Object.keys(names)) {
      const v = ablValueText(vars ? vars[k] : undefined);
      s = s.split(`{${k}}`).join(v);
    }
  }
  return s;
}

/**
 * Join the parts of a composite text the way the tool lays them out.
 *
 * THE CONCAT IS LINES, NOT ONE RUN. The base API's Concat takes a newline
 * flag beside each part, and what the recovery carries of that flag is the
 * part it produced: an empty text whose name ends in _NEWLINE. A bare
 * string in the list is a separator the flow put there itself (the space
 * between "Test probe 1 (+):" and the pin name), so it joins what is around
 * it; every other part starts a line. Joining the whole list with nothing
 * runs a measurement instruction together into one unreadable sentence,
 * which is what the frames show it is not.
 * @param {Array<*>} parts - the concat list
 * @param {Object<string, *>} [vars] - the module variables
 * @returns {string}
 */
function ablConcat(parts, vars) {
  /** @type {string[]} the lines built so far */
  const lines = [];
  let glue = false;
  for (const part of parts) {
    if (typeof part === 'string') {
      // a separator belongs to the line it sits in, and holds the next
      // part on that same line
      if (lines.length) lines[lines.length - 1] += part;
      else lines.push(part);
      glue = true;
      continue;
    }
    const s = ablText(part, vars);
    const name = String((part && part.name) || '');
    if (!s) {
      // the recovery's newline marker: an empty part that only breaks
      if (/NEWLINE/i.test(name)) lines.push('');
      glue = false;
      continue;
    }
    if (glue && lines.length) lines[lines.length - 1] += s;
    else lines.push(s);
    glue = false;
  }
  return lines.join('\n');
}

/**
 * A variable as it reads inside a text.
 *
 * The tool prints a measured double without its float noise: the frames
 * show "1034mbar" and "-32mbar", never "1034.0" or "-32.000000001".
 * @param {*} v - the value
 * @returns {string}
 */
function ablValueText(v) {
  if (v == null) return '';
  if (typeof v === 'number') {
    if (!isFinite(v)) return '';
    const r = Math.round(v * 1000) / 1000;
    return String(Number.isInteger(r) ? r : r);
  }
  if (Array.isArray(v)) return v.length ? String(v[0]) : '';
  return String(v);
}

/**
 * The buttons of a selection node, in order, as {label, text}.
 * @param {object} node - a selection node
 * @param {Object<string, *>} vars - the module variables
 * @returns {Array<{label: string, text: string}>}
 */
function ablChoices(node, vars) {
  const p = node.params || {};
  const n = Number(p.ButtonCount) || 0;
  const out = [];
  for (let i = 1; i <= Math.max(n, 0) && i <= 6; i++) {
    const text = ablText(p[`ButtonText${i}`], vars);
    const label = ablText(p[`ButtonLabel${i}`], vars) || String(i);
    out.push({ label, text });
  }
  // a button count the recovery did not carry: take whatever texts exist
  if (!out.length) {
    for (let i = 1; i <= 6; i++) {
      if (p[`ButtonText${i}`] == null) continue;
      out.push({
        label: ablText(p[`ButtonLabel${i}`], vars) || String(i),
        text: ablText(p[`ButtonText${i}`], vars),
      });
    }
  }
  return out;
}

/**
 * A number out of whatever the car or the user handed over.
 *
 * THE VERDICT IS AN ENUM WITH Ok = 0. The flow writes it by name and reads
 * it by number: `CollectiveResult != 0` is how a measurement step asks
 * whether the technician answered No. Reading "NotOk" as "not a number, so
 * zero" makes that test false and sends the run down the passing arm of
 * every sensor test in the corpus.
 * @param {*} v - the value
 * @returns {number|null} null when it is not a number at all
 */
function ablNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && ABL_RESULTS.includes(v))
    return ABL_RESULTS.indexOf(v);
  // EDIABAS hands back strings, sometimes with the unit attached
  const m = String(v)
    .replace(',', '.')
    .match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * Read one ISTA result path out of a job's EDIABAS answer.
 *
 * The mapping is the report's, and it is exact: `/Result/Status/X` is the
 * system set EDIABAS synthesises ahead of the data, `/Result/Rows/Row[i]/X`
 * is data set i, and `/Result/Rows/$Count` is how many data sets came back.
 * @param {object|null} answer - {sets} as the job runner returns it
 * @param {string} path - the ISTA result path
 * @returns {*} the value, or null when the path names nothing
 */
function ablJobResult(answer, path) {
  if (!answer || !path) return null;
  const sets = Array.isArray(answer.sets) ? answer.sets : [];
  // the browser VM carries the system record beside the sets rather than
  // ahead of them; both shapes answer /Result/Status the same way here
  const isSystem = (s) =>
    !!s && typeof s === 'object' && ('SAETZE' in s || 'JOBNAME' in s);
  const system =
    answer.system && typeof answer.system === 'object'
      ? answer.system
      : sets.length && isSystem(sets[0])
        ? sets[0]
        : null;
  const rows = sets.length && isSystem(sets[0]) ? sets.slice(1) : sets;
  if (path === '/Result/Rows/$Count') return rows.length;
  let m = path.match(/^\/Result\/Status\/(.+)$/);
  if (m) {
    if (!system) return null;
    return m[1] in system ? system[m[1]] : null;
  }
  m = path.match(/^\/Result\/Rows\/Row\[(\d+)\]\/(.+)$/);
  if (m) {
    const row = rows[Number(m[1])];
    if (!row) return null;
    return m[2] in row ? row[m[2]] : null;
  }
  return null;
}

/**
 * The job a node asks the car for, flattened to what a runner needs.
 *
 * `group_path` is ISTA's own addressing: ["Group", "D_MOTOR", ...] means
 * resolve the group to the variant that answers on this car, then run the
 * job on it. An override on the ECUGroupOrVariant argument replaces that
 * with an SGBD a variable already holds -- which is how a module reuses the
 * variant its first IDENT resolved instead of resolving it again.
 * @param {object} node - an ecu_job node
 * @param {Object<string, *>} vars - the module variables
 * @returns {{job: string, args: object, argText: string, group: string,
 *            sgbd: string, results: string[]}}
 */
function ablJobSpec(node, vars) {
  const args = {};
  for (const [k, v] of Object.entries(node.args || {})) args[k] = v;
  let group = '';
  const gp = Array.isArray(node.group_path) ? node.group_path : [];
  const gi = gp.indexOf('Group');
  if (gi >= 0 && gp[gi + 1]) group = String(gp[gi + 1]);
  let sgbd = '';
  for (const [path, val] of Object.entries(node.overrides || {})) {
    if (!/\/Argument\/ECUGroupOrVariant$/.test(path)) continue;
    // a literal override names the group; an {expr} one names a variable
    // that a previous step filled with the resolved variant
    const resolved =
      val && typeof val === 'object' && 'expr' in val
        ? ablValueText(vars[String(val.expr)])
        : String(val == null ? '' : val);
    if (!resolved) continue;
    if (group && resolved.toUpperCase() === group.toUpperCase()) continue;
    sgbd = resolved;
  }
  // every argument but the addressing one, in declaration order, is what
  // EDIABAS takes as the job's argument text
  const argText = Object.entries(args)
    .filter(([k]) => k !== 'ECUGroupOrVariant')
    .map(([, v]) => String(v == null ? '' : v))
    .join(';');
  return {
    job: String(node.job || ''),
    args,
    argText,
    group,
    sgbd,
    results: Array.isArray(node.results) ? node.results.slice() : [],
  };
}

/**
 * Evaluate one recovered expression against the module's variables.
 *
 * The recovery leaves expressions as the decompiler's own source text, so
 * this is a small reader of that dialect rather than a general one: string
 * and number literals, variable and array reads, `job_result(path, type)`,
 * the `__convertTo*` casts, the comparison and arithmetic operators, and
 * `!`. Anything it cannot read returns undefined, and a CONDITION that
 * reads undefined is false -- which is the same rule as an unset register,
 * and lands on the arm that carries the flow.
 * @param {string} expr - the expression text
 * @param {object} ctx - {vars, answer}
 * @returns {*}
 */
function ablEval(expr, ctx) {
  const src = String(expr == null ? '' : expr).trim();
  if (!src) return undefined;
  const toks = ablTokens(src);
  if (!toks) return undefined;
  const p = { toks, i: 0 };
  let v;
  try {
    v = ablParseOr(p, ctx);
  } catch (e) {
    return undefined;
  }
  return p.i === p.toks.length ? v : undefined;
}

/**
 * Split an expression into tokens, or null when it holds something this
 * reader does not model (a lambda, a generic, an indexer chain).
 * @param {string} s - the expression text
 * @returns {string[]|null}
 */
function ablTokens(s) {
  const out = [];
  // A CAST IS A TYPE ANNOTATION, NOT A VALUE. The compiler writes every
  // increment as `__convertToInt32((float)(num2 + 1))`, and reading
  // `(float)` as a parenthesised name makes the whole expression unknown --
  // which stops a counter incrementing and hangs the loop it drives.
  s = String(s).replace(
    /\((?:float|double|int|long|short|byte|bool|string|object|decimal)\)\s*/g,
    ''
  );
  let i = 0;
  const ops = [
    '!=',
    '==',
    '<=',
    '>=',
    '&&',
    '||',
    '+',
    '-',
    '*',
    '/',
    '<',
    '>',
    '(',
    ')',
    '[',
    ']',
    ',',
    '!',
  ];
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let lit = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) {
          const n = s[j + 1];
          lit += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
          continue;
        }
        lit += s[j];
        j++;
      }
      if (j >= s.length) return null;
      out.push('"' + lit);
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_$.]/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    const op = ops.find((o) => s.startsWith(o, i));
    if (!op) return null;
    out.push(op);
    i += op.length;
  }
  return out;
}

/** @param {object} p - the token cursor @returns {string|undefined} */
const ablPeek = (p) => p.toks[p.i];
/** @param {object} p - the cursor @param {string} t - expected @returns {void} */
function ablTake(p, t) {
  if (p.toks[p.i] !== t) throw new Error(`expected ${t}`);
  p.i++;
}

/** @param {object} p @param {object} ctx @returns {*} */
function ablParseOr(p, ctx) {
  let v = ablParseAnd(p, ctx);
  while (ablPeek(p) === '||') {
    p.i++;
    const r = ablParseAnd(p, ctx);
    v = ablTruthy(v) || ablTruthy(r);
  }
  return v;
}

/** @param {object} p @param {object} ctx @returns {*} */
function ablParseAnd(p, ctx) {
  let v = ablParseCmp(p, ctx);
  while (ablPeek(p) === '&&') {
    p.i++;
    const r = ablParseCmp(p, ctx);
    v = ablTruthy(v) && ablTruthy(r);
  }
  return v;
}

/** @param {object} p @param {object} ctx @returns {*} */
function ablParseCmp(p, ctx) {
  let v = ablParseAdd(p, ctx);
  for (;;) {
    const op = ablPeek(p);
    if (!['==', '!=', '<', '<=', '>', '>='].includes(op)) return v;
    p.i++;
    const r = ablParseAdd(p, ctx);
    v = ablCompare(op, v, r);
  }
}

/** @param {object} p @param {object} ctx @returns {*} */
function ablParseAdd(p, ctx) {
  let v = ablParseMul(p, ctx);
  for (;;) {
    const op = ablPeek(p);
    if (op !== '+' && op !== '-') return v;
    p.i++;
    const r = ablParseMul(p, ctx);
    // `+` is concatenation as soon as either side is a string, exactly as
    // it is in the language the module was compiled from
    if (op === '+' && (typeof v === 'string' || typeof r === 'string'))
      v = ablValueText(v) + ablValueText(r);
    else v = (ablNum(v) || 0) + (op === '-' ? -1 : 1) * (ablNum(r) || 0);
  }
}

/** @param {object} p @param {object} ctx @returns {*} */
function ablParseMul(p, ctx) {
  let v = ablParseUnary(p, ctx);
  for (;;) {
    const op = ablPeek(p);
    if (op !== '*' && op !== '/') return v;
    p.i++;
    const r = ablParseUnary(p, ctx);
    const a = ablNum(v) || 0;
    const b = ablNum(r) || 0;
    v = op === '*' ? a * b : b === 0 ? 0 : a / b;
  }
}

/** @param {object} p @param {object} ctx @returns {*} */
function ablParseUnary(p, ctx) {
  if (ablPeek(p) === '!') {
    p.i++;
    return !ablTruthy(ablParseUnary(p, ctx));
  }
  if (ablPeek(p) === '-') {
    p.i++;
    return -(ablNum(ablParseUnary(p, ctx)) || 0);
  }
  return ablParsePrimary(p, ctx);
}

/** @param {object} p @param {object} ctx @returns {*} */
function ablParsePrimary(p, ctx) {
  const t = ablPeek(p);
  if (t === undefined) throw new Error('expression ended');
  if (t === '(') {
    p.i++;
    const v = ablParseOr(p, ctx);
    ablTake(p, ')');
    return v;
  }
  p.i++;
  if (t[0] === '"') return t.slice(1);
  if (/^[0-9.]+$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  // a call: job_result(...) and the casts are the only ones that mean
  // anything here; any other call reads as unknown, which is honest
  if (ablPeek(p) === '(') {
    const args = [];
    p.i++;
    if (ablPeek(p) !== ')') {
      args.push(ablParseOr(p, ctx));
      while (ablPeek(p) === ',') {
        p.i++;
        // the cast argument of job_result is a type name, not a value
        if (/^(int|double|string|bool|typeof)$/.test(ablPeek(p) || '')) p.i++;
        else args.push(ablParseOr(p, ctx));
      }
    }
    ablTake(p, ')');
    if (t === 'job_result') return ablJobResult(ctx.answer, String(args[0]));
    if (t === '__convertToInt32') {
      const n = ablNum(args[0]);
      return n == null ? null : Math.trunc(n);
    }
    if (t === '__convertToDouble') return ablNum(args[0]);
    if (t === '__convertToString') return ablValueText(args[0]);
    // __Part("49624331") / __State("49631243") wrap an id and nothing else:
    // the id is what a vehicle_state step resolves through the shipped table
    if (t === '__Part' || t === '__State') return ablValueText(args[0]);
    return undefined;
  }
  // an index read: Fehlerorte_v[0], gVerdacht_Versorgung_v[num2]
  let v = ablLookup(t, ctx);
  while (ablPeek(p) === '[') {
    p.i++;
    const idx = ablParseOr(p, ctx);
    ablTake(p, ']');
    const i = ablNum(idx);
    v = Array.isArray(v) && i != null ? v[Math.trunc(i)] : undefined;
  }
  return v;
}

/**
 * Read a name: a module variable, the verdict register, or the output of
 * the dialog the step just showed.
 * @param {string} name - the identifier, possibly dotted
 * @param {object} ctx - {vars, out, answer}
 * @returns {*}
 */
function ablLookup(name, ctx) {
  if (name === 'CollectiveResult' || name === 'ResultSet.CollectiveResult')
    return ctx.vars.CollectiveResult;
  // `out.Result`, `out.Quit`, `val3.Status_Fehlerspeicher_v`: the container
  // the last dialog or sub-module filled. The recovery names the container
  // after the decompiler's temporary, which differs per step, so the name
  // before the dot is ignored and the field decides.
  const dot = name.indexOf('.');
  if (dot > 0) {
    const field = name.slice(dot + 1);
    if (ctx.out && field in ctx.out) return ctx.out[field];
    if (field in ctx.vars) return ctx.vars[field];
    return undefined;
  }
  return name in ctx.vars ? ctx.vars[name] : undefined;
}

/**
 * Is a value true, in the sense the compiled flow means it?
 *
 * Unset reads as false. That is the rule the exit dispatch leans on.
 * @param {*} v - the value
 * @returns {boolean}
 */
function ablTruthy(v) {
  if (v == null || v === false || v === '') return false;
  if (typeof v === 'number') return v !== 0;
  return true;
}

/**
 * Compare two values the way the flow does.
 *
 * TWO KINDS OF NULL, AND THEY ARE NOT THE SAME TEST. The compiled flow
 * asks `x != null` about a BOXED result -- a job answer, a dialog output,
 * an object reference -- and it means "did this happen at all"; a job that
 * answered zero rows answered, so `0 != null` is true. It asks `num != 0`
 * about an UNBOXED register, and a register nobody set holds 0, so an unset
 * name compares as zero. Running the first test through the second is what
 * makes a module end at its first job instead of running: the identification
 * answered, the count was 0, and `0 != null` came out false.
 * @param {string} op - the operator
 * @param {*} a - left
 * @param {*} b - right
 * @returns {boolean}
 */
function ablCompare(op, a, b) {
  // the existence test: only a literal null on one side makes it one
  if ((op === '==' || op === '!=') && (a === null || b === null)) {
    const other = a === null ? b : a;
    const missing = other === null || other === undefined;
    return op === '==' ? missing : !missing;
  }
  const bothStrings =
    (typeof a === 'string' || a == null) &&
    (typeof b === 'string' || b == null) &&
    (typeof a === 'string' || typeof b === 'string');
  if (bothStrings) {
    const x = a == null ? '' : String(a);
    const y = b == null ? '' : String(b);
    if (op === '==') return x === y;
    if (op === '!=') return x !== y;
    return op === '<'
      ? x < y
      : op === '<='
        ? x <= y
        : op === '>'
          ? x > y
          : x >= y;
  }
  if (op === '==' || op === '!=') {
    const eq =
      typeof a === 'boolean' || typeof b === 'boolean'
        ? ablTruthy(a) === ablTruthy(b)
        : (ablNum(a) || 0) === (ablNum(b) || 0);
    return op === '==' ? eq : !eq;
  }
  const x = ablNum(a) || 0;
  const y = ablNum(b) || 0;
  return op === '<'
    ? x < y
    : op === '<='
      ? x <= y
      : op === '>'
        ? x > y
        : x >= y;
}

/**
 * The step player.
 */
class AblEngine {
  /**
   * @param {object} graph - a recovered module graph
   * @param {object} [host] - ui, job, module, native, onStep, limits
   */
  constructor(graph, host) {
    /** @type {object} the module graph */
    this.graph = graph || {};
    /** @type {object} the injected outside world */
    this.host = host || {};
    /** @type {Object<string, *>} the module's variables */
    this.vars = { CollectiveResult: 'Ok' };
    /** @type {Object<string, *>} the last dialog's or sub-module's outputs */
    this.out = {};
    /** @type {object|null} the last job's answer */
    this.answer = null;
    /** @type {object[]} what the user was shown, in order */
    this.trace = [];
    /** @type {string} the step being run */
    this.step = '';
    /** @type {object[]} the documents the module asked for */
    this.documents = [];
    /** @type {string[]} the diagnosis objects it marked suspicious */
    this.suspicions = [];
    /** @type {boolean} set once the module has ended */
    this.done = false;
    /** @type {object[]} the assignments rebind recovered, for the record */
    this.rebound = [];
    /** @type {number} a runaway guard: the graph is a graph, loops are real */
    this.budget = Number(this.host.budget) || 200000;
  }

  /** @returns {string} the module's identifier, as the title bar shows it */
  get identifier() {
    return String(this.graph.identifier || this.graph.module || '');
  }

  /** @returns {string} the module's title */
  get title() {
    const io = this.graph.infoobject || {};
    return String(io.title || '');
  }

  /** @returns {string} the version, as the title bar shows it */
  get version() {
    const io = this.graph.infoobject || {};
    return io.version == null ? '' : `V.${io.version}`;
  }

  /**
   * Seed the variables a caller hands in (a sub-module's inout container).
   * @param {Object<string, *>} vars - name to value
   * @returns {void}
   */
  seed(vars) {
    for (const [k, v] of Object.entries(vars || {})) this.vars[k] = v;
  }

  /**
   * Run the module to its end.
   * @returns {Promise<string>} the CollectiveResult it ended on
   * @throws {AblHalt} when it meets a node kind this build does not model
   */
  async run() {
    const entry = String(this.graph.entry || 'Start');
    let step = entry;
    let guard = 0;
    while (step && !this.done) {
      if (++guard > 5000)
        throw new AblHalt(
          'the module kept calling steps without ending; it is not runnable ' +
            'in this build',
          { step }
        );
      step = await this.runStep(step);
    }
    this.done = true;
    // the compiler's Reset hook always says the same sentence; the tool
    // shows it as the module's last screen
    await this.reset();
    return String(this.vars.CollectiveResult || 'Unknown');
  }

  /**
   * Show the end-of-module line the compiler's Reset hook carries, when the
   * recovery kept one.
   * @returns {Promise<void>}
   */
  async reset() {
    const reset = (this.graph.steps || {}).Reset;
    if (!reset || !Array.isArray(reset.nodes)) return;
    const msg = reset.nodes.find((n) => n && n.type === 'message');
    if (!msg) return;
    await this.showMessage(msg, 'Reset');
  }

  /**
   * Run one step; return the next step's name, or '' when the module ended.
   * @param {string} name - the step
   * @returns {Promise<string>}
   */
  async runStep(name) {
    const step = (this.graph.steps || {})[name];
    if (!step || !Array.isArray(step.nodes))
      throw new AblHalt(
        `the module calls a step this build did not recover: ${name}`,
        { step: name }
      );
    this.step = name;
    if (typeof this.host.onStep === 'function') this.host.onStep(name);
    const by = new Map();
    for (const n of step.nodes) if (n && n.id != null) by.set(n.id, n);
    let id =
      step.entry != null ? step.entry : step.nodes[0] && step.nodes[0].id;
    let next = '';
    for (;;) {
      if (--this.budget < 0)
        throw new AblHalt(
          'the module ran past its step budget without ending',
          { step: name }
        );
      const node = by.get(id);
      if (!node)
        throw new AblHalt(
          `the module jumps to a node the recovery does not carry (${id})`,
          { step: name, node: id }
        );
      const r = await this.runNode(node, name, by);
      // AN `end` AFTER A `goto_step` IS THE STEP RETURNING, NOT THE MODULE
      // ENDING. The compiler emits `Next_s(); return;`, so the recovery's
      // `end` is that `return` -- and reading it as the end of the module
      // stops every module at its first step.
      if (r && r.end) return next;
      if (r && r.goto) {
        next = r.goto;
        id = node.next;
        if (id == null) return next;
        continue;
      }
      if (r && r.jump != null) {
        id = r.jump;
        continue;
      }
      if (node.next == null) return next;
      id = node.next;
    }
  }

  /**
   * Run one node.
   * @param {object} node - the node
   * @param {string} stepName - the step it sits in
   * @param {Map<number, object>} [by] - the step's nodes by id
   * @returns {Promise<object|undefined>} {end}|{goto}|{jump}|undefined
   */
  async runNode(node, stepName, by) {
    const ctx = { vars: this.vars, out: this.out, answer: this.answer };
    switch (node.type) {
      // the protocol brackets and the compiler's own scaffolding: real in
      // the tool's log, nothing to the flow
      case 'startstep':
      case 'finishstep':
      case 'misc':
        return undefined;

      case 'end':
        return { end: true };

      case 'goto_step':
        return { goto: String(node.step || '') };

      case 'result':
        this.vars.CollectiveResult = String(node.value || 'Ok');
        return undefined;

      case 'assign': {
        const v = ablEval(node.rhs, ctx);
        this.assign(String(node.lhs || ''), v);
        return undefined;
      }

      case 'branch': {
        const cases = node.cases || {};
        const truth = ablTruthy(ablEval(node.cond, ctx));
        const to = truth ? cases.true : cases.false;
        if (to == null)
          throw new AblHalt(`a branch in ${stepName} has no arm for ${truth}`, {
            step: stepName,
            node: node.id,
          });
        // A BRANCH WHOSE TWO ARMS ARE THE SAME NODE IS A LOST ASSIGNMENT.
        // The recovery decided this test by tracking its destination
        // register as a constant, which kept the condition and dropped the
        // `reg = (int)X` that the real code ran on the taken arm. The shape
        // is the same everywhere it occurs in the corpus: the condition
        // asks whether a read produced anything, and the node both arms
        // reach tests the register that read was about to fill. So the
        // value is recovered from the condition rather than guessed, and
        // only for a register nothing in this step has written.
        if (cases.true === cases.false) this.rebind(node, by, ctx, stepName);
        return { jump: to };
      }

      case 'switch': {
        const cases = node.cases || {};
        const v = ablEval(node.expr, ctx);
        const key = ablSwitchKey(v);
        const to = key != null && key in cases ? cases[key] : cases.default;
        if (to == null)
          throw new AblHalt(
            `a switch in ${stepName} has no arm for ${String(key)}`,
            { step: stepName, node: node.id }
          );
        return { jump: to };
      }

      case 'sleep':
        // a flow's sleep is the car's settling time, not the screen's; the
        // host decides whether a run actually waits
        if (typeof this.host.sleep === 'function')
          await this.host.sleep(ablNum(ablEval(node.ms, ctx)) || 0);
        return undefined;

      case 'document':
        this.documents.push(ablDocument(node));
        return undefined;

      case 'suspicion':
        this.suspicions.push(String(node.arg || ''));
        return undefined;

      case 'hide_message':
        if (this.host.ui && typeof this.host.ui.hide === 'function')
          await this.host.ui.hide();
        return undefined;

      case 'message':
        await this.showMessage(node, stepName);
        return undefined;

      case 'selection':
        await this.showSelection(node, stepName);
        return undefined;

      case 'question':
        await this.showQuestion(node, stepName);
        return undefined;

      case 'measurement':
        await this.showMeasurement(node, stepName);
        return undefined;

      case 'ecu_job':
        await this.runJob(node, stepName);
        return undefined;

      case 'submodule':
        await this.runSubmodule(node, stepName);
        return undefined;

      case 'vehicle_state':
        await this.runVehicleState(node, stepName);
        return undefined;

      case 'dialog':
        await this.runNative(node, stepName);
        return undefined;

      default:
        throw new AblHalt(
          `this build does not run a "${node.type}" step, which ` +
            `${stepName} needs`,
          { step: stepName, node: node.id, kind: node.type }
        );
    }
  }

  /**
   * Recover the assignment a collapsed branch swallowed.
   *
   * See the branch case for why this is a reading of the graph rather than
   * a guess. It fires only when all four marks line up: the arms are the
   * same node, the condition is a value test on one readable expression,
   * the shared target compares a bare register, and the only writes to
   * that register in this step are the constant 0 the tracker pinned --
   * which is what every one of them is, in every module of the corpus that
   * has this shape. A register the module itself fills is left alone, and
   * so is an unreadable condition: an unset register then reads as zero,
   * which is the conservative answer and the one the graph already gives.
   * @param {object} node - the collapsed branch
   * @param {Map<number, object>} by - the step's nodes by id
   * @param {object} ctx - the evaluation context
   * @param {string} stepName - the step, for the write log
   * @returns {void}
   */
  rebind(node, by, ctx, stepName) {
    if (!by) return;
    // the condition must be `<expr> != null` or `<expr> == null`
    const m = String(node.cond || '').match(/^\(?(.+?)\)?\s*[!=]=\s*null$/);
    if (!m) return;
    const value = ablEval(m[1], ctx);
    if (value === undefined || value === null) return;
    const target = by.get(node.cases.true);
    if (!target || target.type !== 'branch') return;
    // the target compares a bare register against a literal
    const t = String(target.cond || '').match(
      /^\(?([A-Za-z_$][\w$]*)\)?\s*(?:[<>]=?|[!=]=)\s*-?[\w."']+$/
    );
    if (!t) return;
    const reg = t[1];
    // a write the module itself does wins; a write of the literal 0 is the
    // tracker's pin and is exactly what this recovers from
    const own = [...by.values()].some(
      (n) =>
        n.type === 'assign' &&
        n.lhs === reg &&
        String(n.rhs).trim() !== '0' &&
        String(n.rhs).trim() !== '0.0'
    );
    if (own) return;
    this.vars[reg] = value;
    this.rebound.push({ step: stepName, node: node.id, name: reg, value });
  }

  /**
   * Write a variable, honouring an indexed target.
   * @param {string} lhs - the target, possibly `name[3]`
   * @param {*} v - the value
   * @returns {void}
   */
  assign(lhs, v) {
    const m = lhs.match(/^([A-Za-z_$][\w$]*)\s*\[(\d+)\]$/);
    if (m) {
      const name = m[1];
      if (!Array.isArray(this.vars[name])) this.vars[name] = [];
      this.vars[name][Number(m[2])] = v;
      return;
    }
    if (/^[A-Za-z_$][\w$.]*$/.test(lhs)) {
      // `val3.Sgbd_v` reads a container the sub-module filled, but the
      // module's own name is what the flow goes on to use
      const dot = lhs.indexOf('.');
      this.vars[dot > 0 ? lhs.slice(dot + 1) : lhs] = v;
    }
  }

  /**
   * Show a message and wait for it as far as its parameters say.
   * @param {object} node - a message node
   * @param {string} stepName - the step
   * @returns {Promise<void>}
   */
  async showMessage(node, stepName) {
    const p = node.params || {};
    const text = ablText(p.txtParam, this.vars);
    const value = ablText(p.WertFeld, this.vars);
    const wait = p.Quittierung === true;
    const timeout = ablNum(p.TIMEOUT) || 0;
    const shown = {
      kind: 'message',
      step: stepName,
      text,
      value,
      wait,
      timeout,
      // a message that neither waits nor times out is the live-refresh
      // frame: it is redrawn every pass and the loop's own Continue ends it
      live: !wait && timeout === 0,
    };
    this.trace.push(shown);
    const r =
      this.host.ui && typeof this.host.ui.message === 'function'
        ? await this.host.ui.message(shown)
        : null;
    // the message dialog's only output is Quit: the Continue button. A live
    // frame that the user did not quit leaves it false and the loop runs on.
    this.out = { Quit: !!(r && r.quit) || (wait && r !== false) };
  }

  /**
   * Bring a part of the car to a state, then go on.
   *
   * VehicleStateServiceDlg (dialog 51872651): "Ignition -> Switch on
   * terminal R.", "Motor -> Turn engine on." 343 of the 891 E46 modules
   * call it, most often to have the ignition switched on or off around a
   * read. It has no output the flow reads; it returns when the state is
   * reached. VerificationMethod "TEST" means the tool checks the car itself,
   * "" means it asks the technician. A host that can read the state answers
   * through native.vehicleState (returning {confirmed: true}); otherwise the
   * instruction is put to the technician, in the tool's own words, and
   * Continue is the confirmation -- which is what the tool does when it
   * cannot verify either.
   * @param {object} node - a vehicle_state node
   * @param {string} stepName - the step
   * @returns {Promise<void>}
   */
  async runVehicleState(node, stepName) {
    const p = node.params || {};
    const ctx = { vars: this.vars, out: this.out, answer: this.answer };
    const read = (key) => {
      const v = p[key];
      return v && typeof v === 'object' && 'expr' in v
        ? ablValueText(ablEval(v.expr, ctx))
        : ablValueText(v);
    };
    const partId = read('/WurzelIn/Vehicle/VehicleParts[0]/VehiclePart');
    const stateId = read('/WurzelIn/Vehicle/VehicleParts[0]/VehicleState');
    const verify = read('/WurzelIn/Vehicle/VehicleParts[0]/VerificationMethod');
    // the ids resolve through the shipped XEP_VEHICLEPART / XEP_VEHICLESTATE
    // table (data/ista/abl/vehicle-states.json); without it the ids are
    // shown as they are rather than invented around
    const table = this.host.vehicleText || {};
    const part = (table.parts && table.parts[partId]) || partId || '';
    const state = (table.states && table.states[stateId]) || stateId || '';
    const shown = {
      kind: 'vehicle_state',
      step: stepName,
      part,
      state,
      partId,
      stateId,
      verify,
    };
    this.trace.push(shown);
    const native = this.host.native || {};
    if (typeof native.vehicleState === 'function') {
      const r = await native.vehicleState({ ...shown, vars: this.vars, node });
      if (r && r.confirmed) {
        shown.verified = 'read';
        this.out = {};
        return;
      }
    }
    if (!this.host.ui || typeof this.host.ui.message !== 'function')
      throw new AblHalt(
        `this build does not provide the vehicleState service that ` +
          `${stepName} needs`,
        { step: stepName, node: node.id, kind: 'dialog 51872651' }
      );
    shown.verified = 'asked';
    // the state text is already the instruction ("Switch on terminal R.");
    // the part names what it is about, the way the tool heads the dialog
    await this.host.ui.message({
      kind: 'message',
      step: stepName,
      text: part && state ? `${part}\n${state}` : state || part,
      value: '',
      wait: true,
      timeout: 0,
      live: false,
    });
    this.out = {};
  }

  /**
   * Show a numbered selection and take the 1-based answer.
   * @param {object} node - a selection node
   * @param {string} stepName - the step
   * @returns {Promise<void>}
   */
  async showSelection(node, stepName) {
    const p = node.params || {};
    const shown = {
      kind: 'selection',
      step: stepName,
      prior: ablText(p.priorText, this.vars),
      past: ablText(p.pastText, this.vars),
      choices: ablChoices(node, this.vars),
    };
    this.trace.push(shown);
    if (!this.host.ui || typeof this.host.ui.selection !== 'function')
      throw new AblHalt('this build cannot ask a selection', {
        step: stepName,
        node: node.id,
      });
    const pick = await this.host.ui.selection(shown);
    const n = ablNum(pick && typeof pick === 'object' ? pick.result : pick);
    if (n == null || n < 1)
      throw new AblHalt('the selection was left unanswered', {
        step: stepName,
        node: node.id,
      });
    this.out = { Result: Math.trunc(n), SelektionAuswahl: Math.trunc(n) };
  }

  /**
   * Show a yes/no question. Yes is 1, No is 2, as the dialog returns them.
   * @param {object} node - a question node
   * @param {string} stepName - the step
   * @returns {Promise<void>}
   */
  async showQuestion(node, stepName) {
    const p = node.params || {};
    const shown = {
      kind: 'question',
      step: stepName,
      text: ablText(p.txtParam, this.vars),
    };
    this.trace.push(shown);
    if (!this.host.ui || typeof this.host.ui.question !== 'function')
      throw new AblHalt('this build cannot ask a question', {
        step: stepName,
        node: node.id,
      });
    const a = await this.host.ui.question(shown);
    const yes = a === true || a === 1 || (a && a.yes === true) || a === 'yes';
    this.out = { Result: yes ? 1 : 2 };
  }

  /**
   * Run a measurement step without a meter: the instruction, a number box,
   * and the setpoint question.
   *
   * ANSWERING NO SETS THE VERDICT. That is the dialog's own behaviour, and
   * the modules branch on it -- Pruefung_Sensor_08_s reads CollectiveResult
   * immediately after this node and shows the causes-of-fault screen when
   * it is not Ok. Getting this backwards would send a technician down the
   * wrong half of every sensor test.
   * @param {object} node - a measurement node
   * @param {string} stepName - the step
   * @returns {Promise<void>}
   */
  async showMeasurement(node, stepName) {
    const p = node.params || {};
    const cfg = p.DSCConfig1 || {};
    const shown = {
      kind: 'value',
      step: stepName,
      instruction: ablText(p.AdaptionsText, this.vars),
      question: ablText(p.ToleranzFeldFrageText, this.vars),
      unit: String(p.Unit1 || node.unit || cfg.unit || ''),
      device: String(cfg.device || ''),
      manual: String(cfg.no_device || '') === 'SubstitutionValueInput',
    };
    this.trace.push(shown);
    if (!this.host.ui || typeof this.host.ui.value !== 'function')
      throw new AblHalt('this build cannot run a measurement step', {
        step: stepName,
        node: node.id,
      });
    const a = await this.host.ui.value(shown);
    const v = ablNum(a && typeof a === 'object' ? a.value : a);
    const reached =
      a && typeof a === 'object' ? a.reached === true : a !== false;
    if (v != null) this.vars.MessWert_v = v;
    this.out = {
      Value1: v,
      Value2: null,
      ERROR: null,
      Result: reached ? 1 : 2,
    };
    if (!reached) this.vars.CollectiveResult = 'NotOk';
  }

  /**
   * Run one job on the car.
   * @param {object} node - an ecu_job node
   * @param {string} stepName - the step
   * @returns {Promise<void>}
   */
  async runJob(node, stepName) {
    const spec = ablJobSpec(node, this.vars);
    const shown = {
      kind: 'job',
      step: stepName,
      job: spec.job,
      group: spec.group,
      sgbd: spec.sgbd,
      argText: spec.argText,
    };
    this.trace.push(shown);
    if (typeof this.host.job !== 'function')
      throw new AblHalt(
        `this build has no way to run ${spec.job || 'a job'} on the car`,
        { step: stepName, node: node.id }
      );
    // a job that does not answer is a real path through the flow (no
    // communication), so a thrown runner is an answer of nothing rather
    // than the end of the module
    //
    // AND A JOB THAT NEVER SETTLES MUST NOT STOP THE MODULE FOREVER. There
    // was no timeout here at all: a runner whose promise never resolves --
    // a group probe walking addresses that do not answer, a read the cable
    // never returns -- left the step waiting silently, with no error, no
    // halt and nothing in the console. A module that reads nothing is a
    // path the flow already handles; a module that hangs is not.
    let answer;
    try {
      answer = await ablWithTimeout(
        this.host.job(spec),
        // the host may shorten it (tests do); the default is the backstop
        Number(this.host.jobTimeoutMs) || ABL_JOB_TIMEOUT_MS,
        `${spec.job || 'a job'} on ${spec.sgbd || spec.group || 'the car'}`
      );
    } catch (e) {
      answer = null;
      shown.timedOut = /timed out/.test(String((e && e.message) || ''));
      if (shown.timedOut) console.warn(`[abl] ${e.message}`);
    }
    this.answer = answer || null;
    answer = this.answer;
    shown.answered = !!(answer && Array.isArray(answer.sets));
    this.out = {};
    // the ECU dialog's own outputs, in the names the flow reads them by
    const variante = ablJobResult(answer, '/Result/Status/VARIANTE');
    if (variante != null) this.out.VARIANTE = variante;
  }

  /**
   * Run a sub-module, or the native service that stands in for it.
   * @param {object} node - a submodule node
   * @param {string} stepName - the step
   * @returns {Promise<void>}
   */
  async runSubmodule(node, stepName) {
    const ref = String(node.ref || '');
    const ident = String((node.module || {}).identifier || '');
    // the inout container travels by NAME: the caller's expressions fill
    // it, the callee reads its own names out of it, and whatever the callee
    // leaves there comes back under those same names
    const seed = {};
    for (const [name, expr] of Object.entries(node.inout_params || {})) {
      const v =
        expr && typeof expr === 'object' && 'expr' in expr
          ? ablEval(expr.expr, {
              vars: this.vars,
              out: this.out,
              answer: this.answer,
            })
          : expr;
      seed[name] = v === undefined ? this.vars[name] : v;
    }
    this.trace.push({
      kind: 'submodule',
      step: stepName,
      ref,
      identifier: ident,
      title: String((node.module || {}).title || ''),
    });
    // a native stand-in first: the fault-memory library is a service this
    // app already performs, and running its 442-node graph would ask the
    // car for a fault list the app has already read
    const native = this.host.native || {};
    if (typeof native.submodule === 'function') {
      const r = await native.submodule({ ref, identifier: ident, seed });
      if (r && typeof r === 'object') {
        this.out = r;
        for (const k of Object.keys(node.inout_params || {}))
          if (k in r) this.vars[k] = r[k];
        for (const [k, v] of Object.entries(r)) this.vars[k] = v;
        return;
      }
    }
    if (typeof this.host.module !== 'function')
      throw new AblHalt(
        `this build cannot run the library module ${ident || ref} that ` +
          `${stepName} calls`,
        { step: stepName, node: node.id }
      );
    const sub = await this.host.module({ ref, identifier: ident });
    if (!sub)
      throw new AblHalt(
        `the library module ${ident || ref} does not ship in this build`,
        { step: stepName, node: node.id }
      );
    const child = new AblEngine(sub, this.host);
    child.budget = this.budget;
    child.seed(seed);
    await child.run();
    this.budget = child.budget;
    for (const t of child.trace) this.trace.push(t);
    for (const d of child.documents) this.documents.push(d);
    // everything the callee left under a name the caller asked for
    const back = {};
    for (const k of Object.keys(node.inout_params || {}))
      if (k in child.vars) back[k] = child.vars[k];
    for (const [k, v] of Object.entries(back)) this.vars[k] = v;
    this.out = Object.assign({}, child.vars);
  }

  /**
   * Run one of the services that have no screen of their own.
   * @param {object} node - a dialog node
   * @param {string} stepName - the step
   * @returns {Promise<void>}
   */
  async runNative(node, stepName) {
    const ref = String(node.dialog_ref || '');
    const native = this.host.native || {};
    const name = ABL_NATIVE[ref];
    const fn = name && typeof native[name] === 'function' ? native[name] : null;
    if (!fn)
      throw new AblHalt(
        `this build does not provide the ${name || ref} service that ` +
          `${stepName} needs`,
        { step: stepName, node: node.id, kind: `dialog ${ref}` }
      );
    this.trace.push({ kind: 'native', step: stepName, service: name, ref });
    const r = await fn({ vars: this.vars, node });
    this.out = r && typeof r === 'object' ? r : {};
    for (const [k, v] of Object.entries(this.out)) this.vars[k] = v;
  }
}

/**
 * The services a flow calls that answer from the session rather than from a
 * screen, by the control id the recovery carries.
 * @type {Object<string, string>}
 */
const ABL_NATIVE = {
  52637835: 'faultList',
  70271166731: 'context',
  69973561867: 'context',
  68072409611: 'context',
  67207569803: 'context',
  69913852939: 'context',
  52672267: 'systemVars',
  52677899: 'characteristics',
  51872651: 'vehicleState',
  61002193291: 'ignitionState',
};

/**
 * A switch's arm key for a value.
 *
 * The verdict register switches by enum name, everything else by number.
 * @param {*} v - the value
 * @returns {string|null}
 */
function ablSwitchKey(v) {
  if (v == null) return null;
  if (typeof v === 'string' && ABL_RESULTS.includes(v)) return v;
  const n = ablNum(v);
  if (n != null) return String(Math.trunc(n));
  return String(v);
}

/**
 * The document a `document` node asks for, read out of the call the
 * recovery kept as text.
 *
 * `__IndirectDocument("Ladedruckregelung_DDE", "Schaltplan", "...")` names a
 * wiring diagram for a component; the same call with a null name and
 * "Funktionsbeschreibung" names the function description of whatever the
 * module is about. The trailing number is the pane: 0 is the first tab, 1
 * the second.
 * @param {object} node - a document node
 * @returns {{action: string, name: string, info: string, formats: string[],
 *            slot: number}}
 */
function ablDocument(node) {
  const raw = String(node.arg || '');
  const strs = [...raw.matchAll(/"([^"]*)"|(\bnull\b)/g)].map((m) =>
    m[2] ? '' : m[1]
  );
  const slotM = raw.match(/,\s*(\d+)\s*$/);
  return {
    action: String(node.action || 'Add'),
    name: strs[0] || '',
    info: strs[1] || '',
    formats: (strs[2] || '').split('|').filter(Boolean),
    slot: slotM ? Number(slotM[1]) : 0,
  };
}

if (typeof module !== 'undefined')
  module.exports = {
    AblEngine,
    AblHalt,
    ABL_RESULTS,
    ABL_NATIVE,
    ablText,
    ablConcat,
    ablValueText,
    ablChoices,
    ablEval,
    ablJobResult,
    ablJobSpec,
    ablNum,
    ablTruthy,
    ablCompare,
    ablDocument,
    ablSwitchKey,
  };
