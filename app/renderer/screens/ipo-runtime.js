// Live .IPO runtime: the module view IS the running script.
//
// See docs/live-ipo-runtime.md. The derived IR (data/inpa-ir) approximated
// what a script would do and was corrected by heuristics; each heuristic was
// a place the guess differed from a run. This module runs the script instead:
// `inpainit` names the root menu and screen, a menu's ITEMs are the keys, a
// key press runs its body in the SAME VM the previous press left behind, a
// screen's LINE blocks paint cells and send their own jobs (keep-alives
// included), and a frequent screen re-runs its cycle on a timer -- INPA's own
// INIT -> LINE -> EXIT tick. Nothing above the VM decides what a key does.
//
// SAFETY. Confirm before any key whose body can send a job the write
// classifier flags; a screen's own writes are confirmed once per screen.
// Release on leave is the script's own Back ITEM (that is how INPA releases
// what it energised) plus `inpaexit` on module exit; the Back job is also
// registered with registerMenuLeave so a route change still sends it. Reads
// never prompt. Jobs go to the SGBD the car identified.

const IPO_TICK_MS = 600; // a frequent screen's cycle period
const IPO_MAX_HOPS = 4; // scriptchange chain bound
const IPO_COLS = 80;
const IPO_MAX_STEPS = 4000; // suspensions per drive, a runaway guard

// The live runtime is the default; `?ir=1` forces the derived renderer for a
// side-by-side comparison, and Settings 'liveIpo' turns it off persistently.
function ipoLiveEnabled() {
  try {
    if (/[?&]ir=1\b/.test(String(location.search || ''))) return false;
  } catch (e) {
    /* no location: headless */
  }
  if (typeof Settings !== 'undefined' && Settings && Settings.get) {
    const v = Settings.get('liveIpo', true);
    return v !== false && v !== 'false' && v !== '0';
  }
  return true;
}

// ITEM tokens of a menu proc: [{nr, label, shift, start, end}] in proc order.
function ipoMenuItems(exec, menuName) {
  const toks = exec && exec.procs && exec.procs[menuName];
  if (!Array.isArray(toks)) return [];
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op !== 'ITEM') continue;
    let end = toks.length;
    for (let j = i + 1; j < toks.length; j++) {
      if (toks[j].op === 'ITEM' || toks[j].op === 'unk') {
        end = j;
        break;
      }
    }
    out.push({
      nr: t.nr,
      label: t.label || '',
      shift: t.nr > 10,
      hidden: !String(t.label || '').trim(),
      start: i + 1,
      end,
    });
  }
  return out;
}

// Where a menu proc's prologue ends (the first ITEM), or the proc end.
function ipoPrologueEnd(exec, menuName) {
  const toks = exec && exec.procs && exec.procs[menuName];
  if (!Array.isArray(toks)) return 0;
  const i = toks.findIndex((t) => t.op === 'ITEM');
  return i < 0 ? toks.length : i;
}

// The backdrop a menu is normally shown with: the setscreen the key that
// opens it performs right before its setmenu. A deep link (the URL route)
// lands on the menu without pressing that key, so its screen is looked up
// here rather than left as whatever was current.
function ipoScreenForMenu(exec, menuName) {
  const byid = (exec && exec.byid) || {};
  const menuId = Object.entries(byid).find(
    ([k, v]) => k.startsWith('menu:') && v === menuName
  );
  if (!menuId) return null;
  const mid = Number(menuId[0].split(':')[1]);
  for (const toks of Object.values(exec.procs || {})) {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!(t.op === 'procref' && t.kind === 65 && t.n === mid)) continue;
      const nxt = toks[i + 1];
      if (!(nxt && nxt.op === 'call' && nxt.name === 'setmenu')) continue;
      // walk back within the same ITEM body for a setscreen
      for (let j = i - 1; j >= 0 && toks[j].op !== 'ITEM'; j--) {
        const c = toks[j];
        if (c.op === 'call' && c.name === 'setscreen') {
          let ref = null,
            flag = false;
          for (let k = j - 1; k >= 0 && toks[k].op !== 'frame'; k--) {
            if (toks[k].op === 'procref' && toks[k].kind === 64) ref = toks[k];
            if (
              toks[k].op === 'const' &&
              (toks[k].t === 'b' || toks[k].t === 'i')
            )
              flag = !!toks[k].v;
          }
          const scr = ref && byid[`screen:${ref.n}`];
          if (scr) return { screen: scr, frequent: flag };
        }
      }
    }
  }
  return null;
}

// The wire target for a job the script addresses. The script's own variable
// holds INPA's dispatch LIST ("IHKA46,IHKA46_2,IHKA46_3") until inpainit
// stores the resolved variant; the car's identified SGBD is what we talk to.
// A script that names ANOTHER shipped module explicitly (a DME screen asking
// the EGS) keeps that name.
function ipoWireTarget(ecu, sgbd) {
  const mine = String((ecu && ecu.sgbd) || '').toLowerCase();
  const s = String(sgbd || '')
    .toLowerCase()
    .trim();
  if (!s || s.includes(',') || s === mine) return mine;
  const base = String((ecu && ecu._sgbdBase) || '').toLowerCase();
  if (s === base) return mine;
  const known = ecu && ecu._ipoKnownSgbds;
  if (known && known.has(s)) return s;
  return mine;
}

// ENGLISH FOR WHAT A JOB RETURNS. The script reads F_ORT_TEXT, F_SYMPTOM_TEXT,
// F_READY_TEXT... and glues them into its own lines before it paints, so by
// paint time there is one string nobody can split; the swap has to happen on
// the result values as they are fed to the VM. Exact dictionary lookups only
// (phraseText: the fault phrase tables and the generated fault-location
// dictionary), plus the fault-code lookup the fault screen uses for a location
// whose text has no entry but whose number the ECU's own codespace knows. A
// string without an entry is fed exactly as the ECU sent it; Original mode
// feeds everything untouched. Captions the .IPO prints itself are not this:
// irLabel handles those at paint.
function ipoTranslating() {
  return (
    typeof phraseText === 'function' &&
    typeof lang === 'function' &&
    lang() !== 'orig'
  );
}

// F_ORT_TEXT: the phrase dictionary, else the code. The code is the one the
// text leads with ("27DA BSD-Generator", kept as a prefix because the ECU
// wrote it there) or F_HEX_CODE, else the 16-bit F_ORT_NR when a codespace
// knows it whole (a DTC, not a location+detail word). The ECU's own codespace
// outranks the flat DB: 27C3 is the oil-level sensor on the E46 MS45 and
// something else elsewhere.
function ipoLocationText(set, text, sgbd) {
  const hit = phraseText(text);
  if (hit !== text) return hit;
  const own = typeof scopedFaultDb === 'function' ? scopedFaultDb(sgbd) : null;
  const flat = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || null;
  if (!own && !flat) return text;
  const codes = [];
  const led =
    typeof bmwCode === 'function' ? bmwCode(text, set.F_HEX_CODE) : null;
  if (led) codes.push({ code: led, flatOk: true });
  const full = typeof ortNrFull === 'function' ? ortNrFull(set.F_ORT_NR) : null;
  if (full) codes.push({ code: full, flatOk: !own });
  for (const { code, flatOk } of codes) {
    const name = (own && own[code]) || (flatOk && flat && flat[code]) || null;
    if (!name) continue;
    return new RegExp(`^${code}\\b`, 'i').test(String(text).trim())
      ? `${code} ${name}`
      : name;
  }
  return text;
}

// One result set with its *_TEXT strings in English where a dictionary
// carries them; every other value, and every string without an entry, as
// sent. A new object: the wire's answer is not rewritten in place.
// F_PCODE_TEXT is composed: "P1128 " + the fault location (FO) + " - " +
// the fault type (FA). Each part is a dictionary string of its own, so the
// line is translated part by part; a part with no entry stays German.
function ipoPcodeText(v) {
  const whole = phraseText(v);
  if (whole !== v) return whole;
  const m = String(v).match(/^(P[0-9A-F]{4}\s+)([\s\S]*)$/i);
  const code = m ? m[1] : '';
  const rest = m ? m[2] : String(v);
  const parts = rest.split(' - ');
  if (parts.length < 2) return v;
  const en = parts.map((x) => phraseText(x.trim()));
  if (en.every((x, i) => x === parts[i].trim())) return v;
  return code + en.join(' - ');
}

// Freeze-frame (Umwelt) labels and their enum values have their own curated
// dictionary (envLabel over envmap.js): "(Motor) - Öltemperatur" -> "Engine
// oil temperature", "0 ES - Motor steht" -> "0 ES - engine stopped".
function ipoEnvText(v) {
  const e = typeof envLabel === 'function' ? envLabel(v) : v;
  return e !== v ? e : phraseText(v);
}

function ipoTranslateSet(set, sgbd) {
  const out = {};
  for (const [k, v] of Object.entries(set || {})) {
    let t = v;
    if (typeof v === 'string') {
      if (k === 'F_ORT_TEXT') t = ipoLocationText(set, v, sgbd);
      else if (/^F_PCODE7?_TEXT$/.test(k)) t = ipoPcodeText(v);
      else if (/^F_(UW|FF)\d*_TEXT$/.test(k)) t = ipoEnvText(v);
      else if (/^F_(UW|FF)\d*_WERT$/.test(k) && /[A-Za-z]/.test(v))
        t = ipoEnvText(v); // an enum value, not a number
      else if (/_TEXT$/.test(k)) t = phraseText(v);
    }
    out[k] = t;
  }
  return out;
}

// WHICH JOBS ARE A USER ACTION. The write classifier is default-deny: it
// guards the raw job route, where an unknown name must never reach the car
// unasked. Inside a running script most of what it flags is PLUMBING -- the
// session INITIALISIERUNG, the DIAGNOSE_AUFRECHT keep-alive, the closing
// DIAGNOSE_ENDE -- which INPA sends without asking anyone, and prompting for
// each turns opening a module into a wall of dialogs.
//
// What is worth confirming is an ACTUATOR COMMAND: a job that energises
// something, writes, resets or clears -- what INPA itself warns about. So
// the script's own session plumbing goes silently and everything else the
// classifier flags still asks (an unknown write stays guarded).
const IPO_PLUMBING =
  /^(INITIALISIERUNG|IDENT|IDENT_\w+|INFO|DIAGNOSE_(AUFRECHT|ENDE|MODE)|ENDE)$/i;
function ipoNeedsConfirm(job) {
  const n = String(job || '').trim();
  if (!n) return false;
  if (typeof isWriteJob === 'function' && !isWriteJob(n)) return false;
  if (IPO_PLUMBING.test(n)) return false;
  return true;
}

class IpoProgram {
  constructor(ecu, exec, ui) {
    this.ecu = ecu;
    this.exec = exec;
    this.ui = ui;
    this.vm = null;
    this.menu = null;
    this.items = [];
    this.screen = null;
    this.frequent = false;
    this.title = null;
    this.cells = new Map(); // "row:col" -> {text, key}
    this.lines = []; // last painted lines (modern mode)
    this.cycleTimer = null;
    this.busy = false; // a key body or a cycle is on the wire
    this.bandTops = new Map(); // absolute row a logical line begins at -> its height
    this.lineFilter = null; // Select's choice of logical lines, null = all
    // THE USER ACTION a job belongs to: the key press (or the machine it
    // started, or the screen it set) that caused it. Sent with every job so
    // a remote owner approves the ACTION once, not each job it sends.
    this.action = null; // {id, label, jobs}
    this.actionSeq = 0;
    this.cycleToken = 0; // bumps on every (re)schedule so a stale tick is dropped
    this.filterChanged = false;
    this.running = false; // a key press, from body to settled menu/screen
    this.queued = null; // the key pressed meanwhile (nr or 'back')
    this.gen = 0; // bumped on every navigation; stale cycles stop
    this.closed = false;
    this.confirmedWrites = new Set(); // "screen:job" confirmed this screen
    this.log = []; // sent jobs, newest last
    this.messages = []; // messageboxes shown, in order
    this.hops = 0;
  }

  // ---- VM -----------------------------------------------------------------

  newVm(exec) {
    const vm = new IpoVm(exec, {
      budget: 800000,
      wireJobs: true,
      host: new FeedHost(),
    });
    // the script's compiled-in defaults; startup touches no wire, but a stray
    // job must not park the machine
    if (exec.procs.__inpa_startup__) {
      try {
        let st = vm.stepStart('__inpa_startup__');
        for (let n = 0; n < 200 && st && st.kind !== 'done'; n++) {
          st = vm.resume(new Map());
        }
      } catch (e) {
        /* defaults only */
      }
    }
    vm.out = new vm.out.constructor();
    return vm;
  }

  fresh() {
    // a run starts with empty emissions; state (globals, timers) persists
    this.vm.out = new this.vm.out.constructor();
    return this.vm.out;
  }

  // ---- the suspension loop --------------------------------------------------
  //
  // Drives a started run to completion, honouring every suspension: a wire job
  // is sent and its results fed back, a wait sleeps, a prompt asks, a message
  // blocks, a picker picks, a state machine ticks, an exit ends the module.
  // Returns {done, exit, cancelled}.
  async drive(step, ctx) {
    const vm = this.vm;
    let n = 0;
    while (step && step.kind !== 'done') {
      if (++n > IPO_MAX_STEPS) throw new Error('script did not settle');
      if (this.closed) return { done: false, cancelled: true };
      if (step.kind === 'job') {
        const fed = await this.runJob(step.sgbd, step.job, step.arg, ctx);
        if (fed == null) return { done: false, cancelled: true };
        step = vm.resume(fed);
      } else if (step.kind === 'wait') {
        await this.ui.sleep(Math.min(Number(step.ms) || 0, 30000));
        step = vm.resume();
      } else if (step.kind === 'input') {
        const got = await this.ui.askInput(step, ctx && ctx.label);
        if (got == null) return { done: false, cancelled: true };
        step = vm.resume(got);
      } else if (step.kind === 'message') {
        this.reflect(vm.out);
        this.messages.push({ title: step.title, body: step.body });
        await this.ui.message(step.title, step.body);
        step = vm.resume();
      } else if (step.kind === 'toggle') {
        // the picker lists the screen the machine just set (its prologue's
        // setscreen names the component list)
        this.reflect(vm.out);
        const pick = await this.ui.pickComponent(this, step);
        if (pick == null) return { done: false, cancelled: true };
        step = vm.resume(pick);
      } else if (step.kind === 'print') {
        this.ui.printScreen(this);
        step = vm.resume();
      } else if (step.kind === 'select') {
        // INPA's Select: which of the screen's named logical lines to show
        const names = ipoScreenLineNames(this.exec, this.screen);
        const pick = names.length
          ? await this.ui.pickLines(this, names, step.multiple, this.lineFilter)
          : null;
        if (pick != null) this.setLineFilter(pick.length ? pick : null);
        step = vm.resume();
      } else if (step.kind === 'exit') {
        return { done: true, exit: true };
      } else if (step.kind === 'yield') {
        this.reflect(vm.out);
        // a %STATE park: tick the machine, offering its own Continue key
        const guards = vm.pendingGuards();
        const go = await this.ui.machineTick(this, step, guards);
        if (go === 'stop') return { done: false, cancelled: true };
        if (go === 'press') guards.forEach((g) => vm.pressKey(g));
        step = vm.resume();
      } else {
        break;
      }
    }
    return { done: true, exit: !!(vm.out && vm.out.exit) };
  }

  // Select's choice: the names of the logical lines to show, or null for all.
  // The current screen is repainted through it; a screen change keeps it
  // (INPA keeps the selection until Deselect).
  setLineFilter(names) {
    this.lineFilter = names ? new Set(names) : null;
    this.cells = new Map();
    this.lines = [];
    this.filterChanged = true;
  }

  // A run that is still parked (a machine at its picker or a %STATE) may
  // already have set a title and a screen; show them without cycling the
  // screen (a cycle would clobber the suspension).
  reflect(out) {
    if (!out) return;
    if (out.title) this.title = out.title;
    if (
      out.screen &&
      out.screen !== this.screen &&
      this.exec.procs[out.screen]
    ) {
      this.screen = out.screen;
      this.frequent = !!out.screenFrequent;
      this.cells = new Map();
      this.lines = [];
    }
    this.takeCells(out);
    this.ui.paint(this);
  }

  // One job on the wire. Confirms a write the first time it appears in this
  // context, feeds the answer (plus the engine's system set, where inpainit
  // reads VARIANTE) back to the VM. Returns null when the user declined.
  async runJob(sgbd, job, arg, ctx) {
    const target = ipoWireTarget(this.ecu, sgbd);
    // Only what the USER activates asks. inpainit is the script identifying
    // the module -- INPA sends its jobs without a word, and a default-deny
    // classifier reading LWR_VORHANDEN ("is headlight levelling fitted?")
    // as a write turned opening the LSZ into a dialog.
    const entry = !!(ctx && (ctx.scope === 'entry' || ctx.scope === 'exit'));
    const write = !entry && ipoNeedsConfirm(job);
    const ckey = `${ctx && ctx.scope ? ctx.scope : '*'}:${job}`;
    if (
      write &&
      !this.confirmedWrites.has(ckey) &&
      !(ctx && ctx.preConfirmed)
    ) {
      const ok = await this.ui.confirmWrite(this, job, arg, ctx);
      if (!ok) return null;
      this.confirmedWrites.add(ckey);
    }
    if (
      write &&
      /^(STEUERN|START)/i.test(job) &&
      !/(_AUS|_ENDE|_OFF|_STOP)$/i.test(job) &&
      typeof markEnergized === 'function'
    ) {
      markEnergized();
    }
    const fed = new Map();
    let status = 'OKAY';
    try {
      const q =
        arg != null && arg !== '' ? `?arg=${encodeURIComponent(arg)}` : '';
      const d = await api(`/api/ecu/${target}/run/${job}${q}`, {
        method: 'POST',
        // the action this job serves; a remote owner gates on it
        action: this.action || undefined,
      });
      for (const [k, v] of Object.entries(d.system || {}))
        fed.set(k, String(v));
      // the *_TEXT results in English where the language setting asks and a
      // dictionary carries them (see ipoTranslateSet): the script formats
      // these itself, so the VM must see the English
      const sets = ipoTranslating()
        ? dataSets(d.sets).map((s) => ipoTranslateSet(s, target))
        : dataSets(d.sets);
      for (const set of sets) {
        for (const [k, v] of Object.entries(set)) {
          if (!k.startsWith('_')) fed.set(k, v);
        }
      }
      // numbered as EDIABAS numbers them: 0 = system record, 1..n = the
      // job's sets, so INPAapiResultInt(->x, "F_ORT_NR", i) reads fault i
      fed.sets = [d.system || {}, ...sets];
      if (!fed.has('JOB_STATUS')) fed.set('JOB_STATUS', 'OKAY');
      status = String(fed.get('JOB_STATUS'));
      // the group probe's variant outranks the engine's synthetic one
      if (/^INITIALISIERUNG$/i.test(job) && this.ecu._variant) {
        fed.set('VARIANTE', String(this.ecu._variant));
      }
      if (/^INITIALISIERUNG$/i.test(job)) {
        this.answered =
          this.answered ||
          dataSets(d.sets).some((s) =>
            Object.keys(s).some((k) => !k.startsWith('_'))
          );
      }
    } catch (e) {
      // the script prints JOB_STATUS in its own box, so the reason a
      // remote owner refused reads there in plain words rather than as a
      // wire timeout it was not
      const m = String((e && e.message) || '');
      status = /remote: .*declined/i.test(m)
        ? 'The host rejected your request'
        : /remote: .*read-only/i.test(m)
          ? 'The host shared this car read-only'
          : /remote: .*not admitted/i.test(m)
            ? 'The host has not admitted you yet'
            : 'ERROR_NO_ANSWER';
      fed.set('JOB_STATUS', status);
      fed.sets = [{}]; // no sets came back
      if (
        /^INITIALISIERUNG$/i.test(job) &&
        /IFH-0009|IFH-0019|no answer/i.test(e.message || '')
      )
        this.silent = true;
    }
    this.log.push({ target, job, arg: arg || null, status });
    if (this.log.length > 200) this.log.shift();
    this.ui.status(this, `${job}${arg ? ` ${arg}` : ''} · ${status}`);
    return fed;
  }

  // ---- entry --------------------------------------------------------------

  async start() {
    this.vm = this.newVm(this.exec);
    const r = await this.runEntry();
    if (!r.ok) return r;
    if (!this.menu) return { ok: false, reason: 'the script opened no menu' };
    await this.openMenu(this.menu, { fromEntry: true });
    return { ok: true };
  }

  // inpainit (or SgbdInpaCheck) live, following a scriptchange chain. Leaves
  // this.menu / this.screen as the script set them.
  async runEntry() {
    const exec = this.exec;
    const proc = exec.procs.inpainit
      ? 'inpainit'
      : exec.procs.SgbdInpaCheck
        ? 'SgbdInpaCheck'
        : null;
    if (!proc) return { ok: false, reason: 'no entry proc' };
    const out = this.fresh();
    let step;
    try {
      step = this.vm.stepStart(proc);
      const r = await this.drive(step, { label: proc, scope: 'entry' });
      if (r.cancelled) return { ok: false, reason: 'cancelled' };
      if (r.exit) {
        // inpainit ended the script (variant mismatch, "Program will be
        // stopped"): the messages say why
        return { ok: false, reason: 'stopped', messages: this.messages };
      }
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    if (out.scriptChange && this.hops < IPO_MAX_HOPS) {
      const next = String(out.scriptChange).toLowerCase();
      const nexec = await this.ui.loadExec(next);
      if (nexec && nexec.procs && Object.keys(nexec.procs).length) {
        this.hops += 1;
        this.exec = nexec;
        this.script = next;
        this.vm = this.newVm(nexec);
        return this.runEntry();
      }
    }
    this.menu = out.menu || null;
    this.screen = out.screen || null;
    this.frequent = !!out.screenFrequent;
    this.title = out.title || null;
    return { ok: true };
  }

  // ---- menus ----------------------------------------------------------------

  async openMenu(name, opts = {}) {
    if (!this.exec.procs[name]) return false;
    this.stopCycle();
    const gen = ++this.gen;
    this.menu = name;
    this.items = ipoMenuItems(this.exec, name);
    // the prologue: title, defaults, and often the menu's first job
    const end = ipoPrologueEnd(this.exec, name);
    const out = this.fresh();
    if (end > 0) {
      this.busy = true;
      try {
        const step = this.vm.stepStartRange(name, 0, end);
        const r = await this.drive(step, {
          label: name,
          scope: `menu:${name}`,
        });
        if (r.exit) {
          this.busy = false;
          return this.leaveModule();
        }
      } catch (e) {
        this.ui.error(this, e.message);
      } finally {
        this.busy = false;
      }
    }
    if (gen !== this.gen) return true;
    if (out.title) this.title = out.title;
    if (out.menu && out.menu !== name && this.exec.procs[out.menu]) {
      // the prologue itself switched menus
      return this.openMenu(out.menu, {
        screen: out.screen || opts.screen,
        frequent: out.screen ? out.screenFrequent : opts.frequent,
      });
    }
    // the key that opened this menu usually set its backdrop screen too
    // (setscreen(s_x); setmenu(m_x)); the prologue's own setscreen wins
    if (out.screen) {
      this.screen = out.screen;
      this.frequent = !!out.screenFrequent;
    } else if (opts.screen) {
      this.screen = opts.screen;
      this.frequent = !!opts.frequent;
    } else if (!opts.fromEntry) {
      // a deep link: the backdrop the opening key would have set
      const bd = ipoScreenForMenu(this.exec, name);
      if (bd) {
        this.screen = bd.screen;
        this.frequent = bd.frequent;
      }
    }
    this.confirmedWrites.clear();
    // The key bar's leave hook (ActionBar.set -> runMenuLeave) fires on every
    // repaint that is not held. Paint the keys held, THEN register this menu's
    // release: registering first let the hook send the new menu's Back job
    // the moment its keys appeared.
    this.ui.renderKeys(this);
    this.registerRelease();
    this.ui.route(this);
    if (this.screen) await this.showScreen(this.screen, this.frequent);
    else this.ui.paint(this);
    return true;
  }

  // The script's own release for this menu: the Back ITEM's first job, so a
  // route change or page hide still sends it (a pressed Back runs the whole
  // body itself).
  registerRelease() {
    if (typeof registerMenuLeave !== 'function') return;
    const back = this.items.find((it) => it.nr === 10);
    let job = null,
      arg = null;
    if (back) {
      const toks = this.exec.procs[this.menu];
      for (let i = back.start; i < back.end; i++) {
        const t = toks[i];
        if (t.op === 'call' && /^INP.?apiJob/.test(t.name || '')) {
          const consts = [];
          for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
            const c = toks[j];
            if (c.op === 'frame') break;
            if (c.op === 'const' && c.t === 's') consts.unshift(String(c.v));
          }
          const jn = consts.find((v) => /^[A-Z][A-Z0-9_]{3,}$/.test(v));
          if (jn && ipoNeedsConfirm(jn)) {
            job = jn;
            const idx = consts.indexOf(jn);
            const a = consts[idx + 1];
            arg = a != null && a !== '' ? a : null;
          }
          break;
        }
      }
    }
    registerMenuLeave(this.ecu, `${this.ecu.sgbd}:${this.menu}`, job, arg);
  }

  // Same key, no job: registerMenuLeave keeps the key and so sends nothing.
  forgetRelease() {
    if (typeof registerMenuLeave !== 'function') return;
    registerMenuLeave(this.ecu, `${this.ecu.sgbd}:${this.menu}`, null, null);
  }

  // ---- screens --------------------------------------------------------------

  async showScreen(name, frequent) {
    if (!this.exec.procs[name]) {
      this.ui.paint(this);
      return;
    }
    this.stopCycle();
    this.screen = name;
    this.frequent = !!frequent;
    this.cells = new Map();
    this.lines = [];
    await this.cycle(this.gen);
    this.relabelFromLegend();
  }

  // An ITEM with no caption is still a key (SHD46's Select, its quit-mode
  // pair): INPA's bar shows it blank and the screen's legend names it. Take
  // that legend line as the key's label.
  relabelFromLegend() {
    if (!this.items.some((it) => it.hidden)) return;
    const legend = ipoLegendMap(this);
    let changed = false;
    for (const it of this.items) {
      if (!it.hidden) continue;
      const l = legend.get(it.nr) || '';
      if (l && it.legendLabel !== l) {
        it.legendLabel = l;
        changed = true;
      }
    }
    if (changed) this.ui.renderKeys(this);
  }

  // One INIT -> LINE cycle of the current screen, painted at the end; a
  // frequent screen schedules the next one.
  async cycle(gen) {
    if (this.closed || gen !== this.gen || !this.screen) return;
    if (this.busy) {
      this.scheduleCycle(gen);
      return;
    }
    this.busy = true;
    const out = this.fresh();
    try {
      const step = this.vm.stepStart(this.screen);
      const r = await this.drive(step, {
        label: this.screen,
        scope: `screen:${this.screen}`,
      });
      if (r.exit) {
        this.busy = false;
        return this.leaveModule();
      }
    } catch (e) {
      this.ui.error(this, e.message);
      this.busy = false;
      return;
    } finally {
      this.busy = false;
    }
    if (gen !== this.gen || this.closed) return;
    this.takeCells(out);
    this.ui.paint(this);
    if (this.queued != null) {
      this._drain();
      return;
    }
    // a LINE body may switch menu or screen (rare, but INPA allows it)
    if (out.menu && out.menu !== this.menu && this.exec.procs[out.menu]) {
      // the key's own body already ran whatever this menu owed (Back sends
      // its release itself); forget the registration so switching menus does
      // not send it again
      this.forgetRelease();
      return this.openMenu(out.menu, {
        screen: out.screen || null,
        frequent: out.screen ? out.screenFrequent : false,
      });
    }
    if (out.screen && out.screen !== this.screen) {
      return this.showScreen(out.screen, out.screenFrequent);
    }
    if (this.frequent) this.scheduleCycle(gen);
  }

  scheduleCycle(gen) {
    this.stopCycle();
    // the tick runs on the bus's worker-backed timer where one exists: a
    // hidden tab's setTimeout fires once a second at best, which stretched a
    // 600 ms screen cycle to a second or more for a remote helper
    const my = ++this.cycleToken;
    if (typeof bmwSleep === 'function') {
      this.cycleTimer = true;
      bmwSleep(IPO_TICK_MS).then(() => {
        if (this.cycleToken !== my || this.closed) return;
        this.cycleTimer = null;
        this.cycle(gen);
      });
      return;
    }
    this.cycleTimer = setTimeout(() => {
      this.cycleTimer = null;
      this.cycle(gen);
    }, IPO_TICK_MS);
    // a headless harness must not be kept alive by a refresh timer
    if (this.cycleTimer && typeof this.cycleTimer.unref === 'function')
      this.cycleTimer.unref();
  }

  stopCycle() {
    this.cycleToken = (this.cycleToken || 0) + 1; // orphan a pending tick
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  // The painted grid from a cycle's emissions. Cells keyed by position so a
  // later cycle overwrites in place; blankscreen clears first.
  takeCells(out) {
    if (out.blank) {
      this.cells = new Map();
      this.lines = [];
    }
    if (out.deselect && this.lineFilter) this.setLineFilter(null);
    // only the logical lines Select kept, plus the unnamed ones (the screen
    // function's own output has no name to select by)
    const lines = (out.lines || []).filter(
      (ln) => !this.lineFilter || !ln.label || this.lineFilter.has(ln.label)
    );
    // the LINE grouping the modern skin draws from: a screen cycle emits every
    // LINE, a key body usually none -- keep the last full cycle's
    if (lines.some((ln) => (ln.elements || []).some((el) => el.row != null)))
      this.lines = lines;
    // INPA's virtual screen is a stack of LOGICAL lines: every LINE block's
    // coordinates are relative to its own top, and a LINE is as tall as the
    // physical rows it printed (the manual's `text(2, 0, "")` pads one to
    // three rows). A fault list prints each entry at rows 0-4 of its own
    // LINE; placing them absolutely drew every fault over the first.
    let top = 0;
    // where each logical line starts and how tall it is: the grid breathes
    // between TALL logical lines (a fault entry), not between one-row ones
    // (a switch and its lamp), where the script's own blank rows suffice
    if (lines.length) this.bandTops = new Map();
    for (const ln of lines) {
      let height = 0;
      for (const el of ln.elements || []) {
        if (el.row == null || el.col == null) continue;
        if (el.lrow == null) el.lrow = el.row; // the script's own coordinate
        el.row = top + el.lrow;
        height = Math.max(height, el.lrow + 1);
      }
      if (height) this.bandTops.set(top, height);
      top += height;
      for (const el of ln.elements || []) {
        if (el.row == null || el.col == null) continue;
        let text = '';
        if (el.t === 'text') text = String(el.s == null ? '' : el.s);
        else if (el.t === 'value') text = el.s != null ? String(el.s) : '';
        else if (el.t === 'lamp') text = el.s != null ? String(el.s) : '';
        else if (el.t === 'gauge') text = el.s != null ? String(el.s) : '';
        this.cells.set(`${el.row}:${el.col}`, {
          row: el.row,
          col: el.col,
          text,
          key: el.key || null,
          kind: el.t,
          // what analogout/digitalout declared: the scale, the good band,
          // the two words -- the painter draws INPA's bar and lamp from it
          meta:
            el.t === 'gauge' || el.t === 'lamp'
              ? {
                  min: el.min,
                  max: el.max,
                  lo: el.warnLo,
                  hi: el.warnHi,
                  fmt: el.fmt,
                  on: el.on,
                  off: el.off,
                }
              : null,
        });
      }
    }
  }

  // ---- keys ---------------------------------------------------------------

  // A key pressed while a cycle or another key is on the wire is QUEUED, not
  // dropped: INPA takes the keypress after the current block. One key waits
  // (the last pressed), and Back too.
  async press(nr) {
    if (!this.items.some((x) => x.nr === nr)) return false;
    if (this.running || this.busy) {
      this.queued = nr;
      return true;
    }
    this.running = true;
    try {
      return await this._press(nr);
    } finally {
      this.running = false;
      this._drain();
    }
  }

  _drain() {
    const q = this.queued;
    if (q == null || this.closed) return;
    this.queued = null;
    setTimeout(() => {
      if (q === 'back') this.back();
      else this.press(q);
    }, 0);
  }

  async _press(nr) {
    const it = this.items.find((x) => x.nr === nr);
    if (!it) return false;
    this.stopCycle();
    const gen = ++this.gen;
    // confirm once, naming what the body can send
    const jobs =
      typeof irItemBodyJobs === 'function'
        ? irItemBodyJobs(
            this.exec,
            this.exec.procs[this.menu],
            it.start,
            it.end
          )
        : [];
    const writes = jobs.filter(ipoNeedsConfirm);
    this.action = {
      id: `${Date.now().toString(36)}-${++this.actionSeq}`,
      label: it.label || it.legendLabel || `F${it.nr}`,
      jobs: jobs.slice(0, 30),
    };
    let preConfirmed = false;
    if (writes.length) {
      const ok = await this.ui.confirmKey(this, it, jobs, writes);
      if (!ok) {
        if (this.frequent && this.screen) this.scheduleCycle(gen);
        return true;
      }
      preConfirmed = true;
    }
    this.busy = true;
    const out = this.fresh();
    let result;
    try {
      const step = this.vm.stepStartItem(this.menu, nr);
      result = await this.drive(step, {
        label: it.label,
        scope: `key:${this.menu}:${nr}`,
        preConfirmed,
      });
    } catch (e) {
      this.ui.error(this, e.message);
      this.busy = false;
      if (this.frequent && this.screen) this.scheduleCycle(gen);
      return true;
    } finally {
      this.busy = false;
    }
    if (this.closed || gen !== this.gen) return true;
    if (result.exit || out.exit) return this.leaveModule();
    if (result.cancelled) {
      this.ui.status(this, `${it.label} · cancelled`);
      if (this.frequent && this.screen) this.scheduleCycle(gen);
      return true;
    }
    if (out.title) this.title = out.title;
    // the body painted (userbox text, a result line): show it with the screen
    this.takeCells(out);
    // setstate(&sm): the key's work IS the machine (SHD46 Select: togglelist
    // -> STEUERN_DIGITAL -> quit-mode box -> back to the menu screen)
    if (out.stateEnter && this.exec.procs[out.stateEnter]) {
      return this.runMachine(out.stateEnter, it, gen, preConfirmed);
    }
    return this.settle(out, it, gen);
  }

  async runMachine(name, it, gen, preConfirmed) {
    this.busy = true;
    const out = this.fresh();
    let result;
    try {
      const step = this.vm.stepStart(name);
      result = await this.drive(step, {
        label: it.label || name,
        scope: `machine:${name}`,
        preConfirmed,
      });
    } catch (e) {
      this.ui.error(this, e.message);
      this.busy = false;
      if (this.frequent && this.screen) this.scheduleCycle(gen);
      return true;
    } finally {
      this.busy = false;
    }
    if (this.closed || gen !== this.gen) return true;
    if (result.exit || out.exit) return this.leaveModule();
    if (result.cancelled) {
      this.ui.status(this, `${it.label || name} · cancelled`);
      if (this.frequent && this.screen) this.scheduleCycle(gen);
      return true;
    }
    if (out.title) this.title = out.title;
    this.takeCells(out);
    return this.settle(out, it, gen);
  }

  // After a key or a machine ran: follow the menu/screen it set.
  async settle(out, it, gen) {
    if (this.filterChanged && !out.menu && !out.screen && this.screen) {
      this.filterChanged = false;
      await this.showScreen(this.screen, this.frequent);
      return true;
    }
    this.filterChanged = false;
    if (out.menu && out.menu !== this.menu && this.exec.procs[out.menu]) {
      return this.openMenu(out.menu, {
        screen: out.screen || null,
        frequent: out.screen ? out.screenFrequent : false,
      });
    }
    if (out.screen) {
      // a setscreen re-runs the screen even when it is the same one: INPA
      // restarts its cycle (the idle-actuator keys redraw their readout)
      await this.showScreen(out.screen, out.screenFrequent);
      return true;
    }
    this.ui.paint(this);
    if (this.frequent && this.screen) this.scheduleCycle(gen);
    return true;
  }

  // Navigation Back = INPA's F10 when the menu has one, else the root: exit.
  async back() {
    if (this.running || this.busy) {
      this.queued = 'back';
      return;
    }
    if (this.items.some((it) => it.nr === 10)) return this.press(10);
    return this.leaveModule();
  }

  async leaveModule() {
    if (this.closed) return;
    this.closed = true;
    this.stopCycle();
    // inpaexit: what the script owes the ECU on the way out (DIAGNOSE_ENDE,
    // INPAapiEnd). A release, so it does not prompt.
    if (this.exec.procs.inpaexit) {
      try {
        this.fresh();
        const step = this.vm.stepStart('inpaexit');
        await this.drive(step, {
          label: 'inpaexit',
          scope: 'exit',
          preConfirmed: true,
        });
      } catch (e) {
        /* leaving anyway */
      }
    }
    if (typeof registerMenuLeave === 'function')
      registerMenuLeave(null, null, null, null);
    this.ui.left(this);
  }

  close() {
    // the view is being torn down by navigation: stop, keep the release
    this.closed = true;
    this.stopCycle();
  }
}

// ---- the UI adapter ----------------------------------------------------------
//
// Maps the program's state onto the app's grammar: the F-key bar, a title,
// the painted grid (INPA mode) or per-LINE rows (modern), the app's own
// dialogs for INPA's prompts, and the status line.

let _ipoCurrent = null;

function ipoKeyLabel(program, it) {
  const raw = it.label || it.legendLabel || '';
  return irLabel(raw) || raw;
}

function ipoText(s) {
  const raw = String(s == null ? '' : s);
  if (!raw.trim()) return raw;
  return irLabel(raw) || raw;
}

// INPA's two instrument cells, drawn the same in both skins.
//
// digitalout(val, row, col, TrueText, FalseText) is a lamp: a filled circle
// with the TrueText beside it when the value is set, an empty circle with
// the FalseText otherwise. analogout(val, row, col, min, max, minvalid,
// maxvalid, fmt) is a bar: the declared scale min..max, the valid band
// green and the rest red, a black fill from the left up to the reading, the
// scale ends and band edges printed under it, the number beside it.
function ipoScaleLabel(v) {
  if (v == null || !Number.isFinite(v)) return '';
  const r = Math.round(v * 100) / 100;
  return String(r);
}
function ipoLampHtml(c) {
  const m = c.meta || {};
  const word = String(c.text || '').trim();
  const on =
    m.on != null && word && word === String(m.on).trim()
      ? true
      : m.off != null && word === String(m.off).trim()
        ? false
        : /^(1|ein|on|an|ja|yes|aktiv|true)$/i.test(word);
  const key = c.key ? ` data-key="${esc(c.key)}"` : '';
  return (
    `<span class="ipo-lamp-cell"${key}>` +
    `<span class="ipo-dot${on ? ' on' : ''}"></span>` +
    `<span class="ipo-lamp-word">${esc(ipoText(word))}</span></span>`
  );
}
function ipoGaugeHtml(c) {
  const m = c.meta || {};
  const text = String(c.text || '').trim();
  const n = parseFloat(text);
  const key = c.key ? ` data-key="${esc(c.key)}"` : '';
  const hasScale =
    m.min != null &&
    m.max != null &&
    Number.isFinite(m.min) &&
    Number.isFinite(m.max);
  if (!hasScale || Number.isNaN(n)) {
    // no declared scale, or a state word where a number was expected:
    // the value as text
    return `<span class="ipo-val ipo-gauge-val"${key}>${esc(text)}</span>`;
  }
  const span = m.max - m.min || 1;
  const at = (v) => Math.max(0, Math.min(100, ((v - m.min) / span) * 100));
  const pct = at(n).toFixed(1);
  let bg = 'var(--gauge-ok)';
  let edges = '';
  if (
    m.lo != null &&
    m.hi != null &&
    Number.isFinite(m.lo) &&
    Number.isFinite(m.hi)
  ) {
    const a = at(m.lo),
      b = at(m.hi);
    bg =
      `linear-gradient(to right, var(--gauge-warn) 0 ${a.toFixed(1)}%, ` +
      `var(--gauge-ok) ${a.toFixed(1)}% ${b.toFixed(1)}%, ` +
      `var(--gauge-warn) ${b.toFixed(1)}% 100%)`;
    // an edge within reach of a scale end collides with its number
    for (const [v, pos] of [
      [m.lo, a],
      [m.hi, b],
    ]) {
      if (pos > 8 && pos < 92)
        edges += `<span class="ipo-gauge-edge" style="left:${pos.toFixed(1)}%">${esc(ipoScaleLabel(v))}</span>`;
    }
  }
  return (
    `<span class="ipo-gauge"${key}>` +
    `<span class="ipo-gauge-bar">` +
    `<span class="ipo-gauge-track" style="background:${bg}">` +
    `<span class="ipo-gauge-fill" style="width:${pct}%"></span></span>` +
    `<span class="ipo-gauge-foot"><span>${esc(ipoScaleLabel(m.min))}</span>${edges}` +
    `<span>${esc(ipoScaleLabel(m.max))}</span></span></span>` +
    `<span class="ipo-gauge-val">${esc(text)}</span></span>`
  );
}
// the width a bar takes on the text grid, in columns
const IPO_GAUGE_COLS = 34;

// Modern skin: the same cycle's emissions, grouped the way the script wrote
// them -- one row per LINE block. Within a LINE the text elements before the
// first value are its caption, the value/lamp/gauge elements are its cells,
// text after a value is a unit or trailer. A LINE with only text is a note.
// Nothing here decides what a line means: a row exists because the program
// painted it this cycle, keyed by the result the script bound.
function ipoLineRows(p) {
  const rows = [];
  for (const ln of p.lines || []) {
    const els = (ln.elements || [])
      .filter((el) => el.row != null && el.col != null)
      .sort((a, b) => a.row - b.row || a.col - b.col);
    if (!els.length) continue;
    const cellOf = (el) => p.cells.get(`${el.row}:${el.col}`);
    // a LINE that prints several screen rows (a menu legend, a banner) is
    // several rows here too: INPA laid them out one under the other
    const byRow = new Map();
    for (const el of els) {
      if (!byRow.has(el.row)) byRow.set(el.row, []);
      byRow.get(el.row).push(el);
    }
    let first = true;
    for (const group of byRow.values()) {
      const caption = [];
      const cells = [];
      const trailer = [];
      for (const el of group) {
        const c = cellOf(el);
        const text = c ? c.text : '';
        if (el.t === 'text') {
          if (!text.trim()) continue;
          (cells.length ? trailer : caption).push(text.trim());
        } else {
          cells.push({
            kind: el.t,
            key: el.key || null,
            text,
            on: el.on,
            off: el.off,
            meta: c ? c.meta : null,
          });
        }
      }
      if (!caption.length && !cells.length) continue;
      // A row the script printed as text only, in two or more pieces at
      // different columns, is a caption and its value (ZKE5's info screen:
      // "Rework program" at column 0, ":" at 33, the name at 35 -- copied
      // into strings at startup and printed with ftextout). The first piece
      // is the caption, a lone ":" is dropped, the rest are the value.
      if (
        !cells.length &&
        caption.length >= 2 &&
        !IPO_KEY_LEGEND.test(caption[0])
      ) {
        const rest = caption.slice(1).filter((t) => t !== ':');
        if (rest.length) {
          for (const t of rest)
            cells.push({ kind: 'text', key: null, text: t, meta: null });
          caption.length = 1;
        }
      }
      rows.push({
        caption: caption.join('  '),
        parts: caption,
        cells,
        trailer: trailer.join(' '),
        band: first, // first row of its logical line
      });
      first = false;
    }
  }
  return rows;
}

// A menu's backdrop screen prints a key legend ("< F4 >  Fehlerspeicher
// lesen") and nothing live. Modern mode shows that menu as the function-group
// tiles the app has always used: one per ITEM the script declared, captioned
// by the ITEM's own short label, described by the legend line the screen
// printed for that key. Category colour comes from the SGBD job the key's
// body sends (a fixed vocabulary), never from the caption.
const IPO_KEY_LEGEND =
  /^\s*(<\s*Shift\s*>\s*\+\s*)?<\s*F\s*(\d+)\s*>\s*(\S.*)$/i;
function ipoJobCategory(job) {
  if (!job) return '';
  if (/^(FS|IS|HS)_/i.test(job)) return 'gt-fault';
  if (/^(STATUS|MESSWERT)/i.test(job)) return 'gt-live';
  if (/^(STEUERN|START)/i.test(job)) return 'gt-act';
  if (/IDENT|^INFO$/i.test(job)) return 'gt-info';
  if (/COD|ADAPT|ABGLEICH/i.test(job)) return 'gt-code';
  return '';
}
// nr -> the caption the current screen printed for that key in its legend
function ipoLegendMap(p, notes) {
  const legend = new Map();
  for (const r of ipoLineRows(p)) {
    for (const t of r.parts || []) {
      const m = t.match(IPO_KEY_LEGEND);
      if (!m) {
        if (notes) notes.push(t);
        continue;
      }
      const nr = Number(m[2]) + (m[1] ? 10 : 0);
      if (!legend.has(nr)) legend.set(nr, m[3].trim());
    }
  }
  return legend;
}

function ipoMenuTiles(p) {
  const rows = ipoLineRows(p);
  const legend = ipoLegendMap(p, null);
  // a menu backdrop prints a legend for its keys; a screen that prints none
  // is a readout, drawn as rows. ZKE5's main screen prints BOTH -- the part
  // number and build date above the legend -- so those rows stay rows and
  // the legend becomes the tiles.
  if (!legend.size) return null;
  const items = (p.items || []).filter((it) => !it.hidden || legend.has(it.nr));
  if (!items.length || !items.some((it) => legend.has(it.nr))) return null;
  const rest = rows.filter(
    (r) => !(r.parts || []).some((t) => IPO_KEY_LEGEND.test(t))
  );
  const toks = p.exec && p.exec.procs ? p.exec.procs[p.menu] : null;
  const tiles = items.map((it) => {
    let cat = '';
    if (toks && typeof irItemBodyJobs === 'function') {
      const jobs = irItemBodyJobs(p.exec, toks, it.start, it.end) || [];
      for (const j of jobs) {
        cat = ipoJobCategory(j);
        if (cat) break;
      }
    }
    return {
      nr: it.nr,
      shift: !!it.shift,
      label: it.label || legend.get(it.nr) || '',
      legend: legend.get(it.nr) || '',
      cat: cat || 'gt-default',
    };
  });
  return { tiles, rest };
}

function ipoPaintTiles(gridEl, p, menu) {
  // A backdrop screen can be frequent: the cycle repaints every tick. The
  // tiles are rebuilt (and their entrance animation replayed) only when
  // what they show changed, else the grid is left exactly as it is.
  const sig = JSON.stringify([p.menu, menu.tiles, menu.rest]);
  if (gridEl._ipoTilesSig === sig) return;
  gridEl._ipoTilesSig = sig;
  const notes = ipoRowsHtml(menu.rest);
  const grid = document.createElement('div');
  grid.className = 'group-grid stagger';
  for (const t of menu.tiles) {
    const tile = document.createElement('div');
    tile.className = `group-tile ${t.cat}`;
    const fk = `${t.shift ? 'Shift+' : ''}F${t.nr > 10 ? t.nr - 10 : t.nr}`;
    const name = ipoText(t.label);
    const desc = t.legend ? ipoText(t.legend) : '';
    tile.innerHTML =
      `<div class="group-header-row"><span class="group-fkey">${esc(fk)}</span></div>` +
      `<div class="group-name">${esc(name)}</div>` +
      `<div class="group-count">${esc(desc !== name ? desc : '')}</div>` +
      `<div class="group-arrow">→</div>`;
    tile.onclick = () => p.press(t.nr);
    grid.appendChild(tile);
  }
  gridEl.classList.add('ipo-tiles');
  gridEl.innerHTML = notes ? `<div class="ipo-notes">${notes}</div>` : '';
  gridEl.appendChild(grid);
  if (typeof stagger === 'function') stagger(grid, 20);
}

function ipoPaintLines(gridEl, p) {
  const menu = ipoMenuTiles(p);
  if (menu) {
    ipoPaintTiles(gridEl, p, menu);
    return;
  }
  gridEl._ipoTilesSig = null;
  gridEl.classList.remove('ipo-tiles');
  const rows = ipoLineRows(p);
  if (!rows.length) {
    // the screen func printed without LINE blocks (a userbox, a banner):
    // fall back to its rows of text in order
    const texts = [...p.cells.values()]
      .filter((c) => c.text && c.text.trim())
      .sort((a, b) => a.row - b.row || a.col - b.col);
    if (!texts.length) {
      gridEl.innerHTML = `<div class="ipo-empty">${esc(ipoText(p.title || ''))}</div>`;
      return;
    }
    const byRow = new Map();
    for (const c of texts) {
      if (!byRow.has(c.row)) byRow.set(c.row, []);
      byRow.get(c.row).push(ipoText(c.text).trim());
    }
    gridEl.innerHTML = [...byRow.values()]
      .map(
        (parts) =>
          `<div class="ipo-line ipo-line-note">${esc(parts.join(' '))}</div>`
      )
      .join('');
    return;
  }
  gridEl.innerHTML = ipoRowsHtml(rows);
}

// The modern rows for a list of LINE rows (see ipoLineRows).
function ipoRowsHtml(rows) {
  const html = [];
  const capHtml = (parts) =>
    parts
      .map((t) => esc(ipoText(t).replace(/\s*[:=]\s*$/, '')))
      .join('<span class="ipo-line-gap"></span>');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cap = capHtml(r.parts || [r.caption]);
    // a logical line's first row gets air above it (one LINE per fault)
    const band = i > 0 && r.band ? ' ipo-band' : '';
    if (!r.cells.length) {
      html.push(`<div class="ipo-line ipo-line-note${band}">${cap}</div>`);
      continue;
    }
    const cells = r.cells
      .map((c) => {
        const text = ipoText(c.text);
        const key = c.key ? ` data-key="${esc(c.key)}"` : '';
        if (c.kind === 'lamp') return ipoLampHtml(c);
        if (c.kind === 'gauge') return ipoGaugeHtml(c);
        return `<span class="ipo-line-val ipo-${c.kind}"${key}>${esc(text.trim())}</span>`;
      })
      .join('');
    const unit = r.trailer
      ? `<span class="ipo-line-unit">${esc(ipoText(r.trailer))}</span>`
      : '';
    // no caption: the value IS the line (a fault's own header row)
    const nocap = r.parts && r.parts.length ? '' : ' ipo-nocap';
    html.push(
      `<div class="ipo-line${band}${nocap}">` +
        `<span class="ipo-line-cap">${cap}</span>` +
        `<span class="ipo-line-cells">${cells}${unit}</span>` +
        `</div>`
    );
  }
  return html.join('');
}

// The LINE declarations of a screen that carry a component key: INPA's
// togglelist offers exactly these.
function ipoScreenComponents(exec, screen) {
  const toks = exec && exec.procs && screen ? exec.procs[screen] : null;
  if (!toks) return [];
  return toks
    .filter((t) => t.op === 'LINE' && t.keys)
    .map((t) => ({ label: t.label || '', keys: String(t.keys) }));
}

// The named logical lines of a screen: what INPA's Select offers.
function ipoScreenLineNames(exec, screen) {
  const toks = exec && exec.procs && screen ? exec.procs[screen] : null;
  if (!toks) return [];
  const out = [];
  for (const t of toks) {
    if (t.op === 'LINE' && t.label && String(t.label).trim())
      if (!out.includes(t.label)) out.push(t.label);
  }
  return out;
}

function ipoMakeUi(ecu, container, back) {
  const inpa = typeof inpaMode === 'function' && inpaMode();
  let gridEl = null,
    titleEl = null,
    statusEl = null,
    machineEl = null;

  const build = () => {
    container.className = inpa ? 'ipo-view ipo-inpa' : 'ipo-view results-panel';
    container.innerHTML =
      `<div class="ipo-title"></div>` +
      `<div class="ipo-screen"></div>` +
      `<div class="ipo-machine" hidden></div>` +
      `<div class="ipo-status mono"></div>`;
    titleEl = container.querySelector('.ipo-title');
    gridEl = container.querySelector('.ipo-screen');
    machineEl = container.querySelector('.ipo-machine');
    statusEl = container.querySelector('.ipo-status');
  };
  build();

  const ui = {
    // the bus's worker-backed timer: a hidden tab's setTimeout is throttled
    // to once a second, which stretched every scripted wait and screen tick
    sleep: (ms) =>
      typeof bmwSleep === 'function'
        ? bmwSleep(ms)
        : new Promise((r) => setTimeout(r, ms)),
    loadExec: async (sgbd) => {
      try {
        return typeof irLiveExec === 'function' ? await irLiveExec(sgbd) : null;
      } catch (e) {
        return null;
      }
    },
    route: (p) => {
      if (typeof routeSetCar === 'function' && ecu.chassis && ecu.sgbd) {
        const rootMenu = p.rootMenu || (p.rootMenu = p.menu);
        routeSetCar(ecu.chassis, ecu.sgbd, p.menu === rootMenu ? null : p.menu);
      }
    },
    status: (p, text) => {
      if (statusEl) statusEl.textContent = text;
      sbLeft.textContent = `${ecu.sgbd}.prg · ${p.menu || ''} · ${text}`;
    },
    error: (p, text) => {
      if (statusEl) statusEl.textContent = `error: ${text}`;
      sbLeft.textContent = `${ecu.sgbd}.prg · ${text}`;
    },
    message: (title, body) =>
      messageDialog({
        title: esc(ipoText(title)),
        body: esc(ipoText(body || '')),
      }),
    askInput: (step, label) => irAskInput(step, label),
    confirmKey: (p, it, jobs, writes) =>
      confirmDialog({
        title: `${esc(ipoKeyLabel(p, it))} on ${esc(ecu.label)}?`,
        body:
          `Runs INPA's own key script live; it can send ` +
          `<span class="mono">${jobs.map(esc).join(' · ')}</span>.` +
          `<br><br>The argument is computed by the script, exactly as INPA ` +
          `computes it.`,
        confirmLabel: 'Run',
        danger: writes.length > 0,
      }),
    confirmWrite: (p, job, arg, ctx) =>
      confirmDialog({
        title: `Send ${esc(job)} on ${esc(ecu.label)}?`,
        body:
          `The ${esc(ctx && ctx.label ? ctx.label : 'script')} wants to send ` +
          `<span class="mono">${esc(job)}${arg ? ' ' + esc(arg) : ''}</span>` +
          ` to the module.` +
          (ctx && String(ctx.scope || '').startsWith('screen:')
            ? ` This screen sends it on every refresh; confirming allows it ` +
              `for as long as the screen is open.`
            : ''),
        confirmLabel: 'Send',
        danger: true,
      }),
    pickComponent: async (p, step) => {
      // INPA's togglelist lists the ACTIVE screen's LINE declarations: the
      // name is the LINE's label, the argument its key string (SHD46's
      // s_steuern_digital: "Switch Sunroof Open" / SSHDA ...). With
      // MultipleSelectFlag set (LSZ's in/output selection) it is a tick list
      // and the script gets every picked key, ";"-joined, as one argument;
      // with ArgNumFlag set it gets the lines' numbers instead of their keys.
      const multiple = !!(step && step.multiple);
      const argnum = !!(step && step.argnum);
      const rows = ipoScreenComponents(p.exec, p.screen).map((l, i) => ({
        key: argnum ? String(i + 1) : String(l.keys).split(';')[0],
        caption: ipoText(l.label || String(l.keys).split(';')[0]),
      }));
      if (!rows.length) {
        await messageDialog({
          title: 'No components to pick',
          body: 'This screen lists no components for the picker.',
        });
        return null;
      }
      return new Promise((resolveRaw) => {
        // closing the modal fires onClose, which used to resolve null BEFORE
        // the pick resolved: every pick read as cancelled
        let settled = false;
        const resolve = (v) => {
          if (settled) return;
          settled = true;
          resolveRaw(v);
        };
        const type = multiple ? 'checkbox' : 'radio';
        const actions = multiple
          ? `<button class="btn" data-x="cancel">Cancel</button>
             <button class="btn primary" data-x="ok">Select</button>`
          : `<button class="btn" data-x="cancel">Cancel</button>
             <button class="btn" data-x="off">Off</button>
             <button class="btn primary" data-x="on">On</button>`;
        const { overlay, close } = openModal(
          `<div class="modal" role="dialog" aria-modal="true">
            <div class="modal-title">${multiple ? 'Select components' : 'Select component'}</div>
            <div class="modal-body ipo-pick${rows.length > 12 ? ' ipo-pick-long' : ''}">${rows
              .map(
                (r, i) =>
                  `<label class="ipo-pick-row"><input type="${type}" name="ipo-pick" value="${i}"${!multiple && i === 0 ? ' checked' : ''}/> ` +
                  `<span>${esc(r.caption)}</span> <span class="mono ipo-pick-key">${esc(r.key)}</span></label>`
              )
              .join('')}</div>
            ${
              rows.length > 12
                ? `<div class="ipo-pick-hint">${rows.length} components · scroll the list for more</div>`
                : ''
            }
            <div class="modal-actions">${actions}</div></div>`,
          { onClose: () => resolve(null) }
        );
        overlay.querySelectorAll('[data-x]').forEach((b) => {
          b.onclick = () => {
            const x = b.dataset.x;
            const picked = [
              ...overlay.querySelectorAll('input[name="ipo-pick"]:checked'),
            ].map((el) => rows[Number(el.value)]);
            if (x === 'cancel' || !picked.length) resolve(null);
            else if (multiple)
              resolve({ ort: picked.map((r) => r.key).join(';'), ein: 0 });
            else resolve({ ort: picked[0].key, ein: x === 'on' ? 0 : 1 });
            close();
          };
        });
      });
    },
    // INPA's Select: tick the logical lines to keep on screen
    pickLines: (p, names, multiple, current) =>
      new Promise((resolve) => {
        const { overlay, close } = openModal(
          `<div class="modal" role="dialog" aria-modal="true">
            <div class="modal-title">Select lines</div>
            <div class="modal-body ipo-pick">${names
              .map(
                (n, i) =>
                  `<label class="ipo-pick-row"><input type="${multiple ? 'checkbox' : 'radio'}" name="ipo-lines" value="${i}"${
                    current ? (current.has(n) ? ' checked' : '') : ''
                  }/> <span>${esc(ipoText(n))}</span></label>`
              )
              .join('')}</div>
            <div class="modal-actions">
              <button class="btn" data-x="cancel">Cancel</button>
              <button class="btn" data-x="all">Show all</button>
              <button class="btn primary" data-x="ok">Show selected</button>
            </div></div>`,
          { onClose: () => resolve(null) }
        );
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          resolve(v);
          close();
        };
        overlay.querySelectorAll('[data-x]').forEach((b) => {
          b.onclick = () => {
            const x = b.dataset.x;
            if (x === 'cancel') return done(null);
            if (x === 'all') return done([]);
            const picked = [
              ...overlay.querySelectorAll('input[name="ipo-lines"]:checked'),
            ].map((el) => names[Number(el.value)]);
            done(picked);
          };
        });
      }),
    // INPA's printscreen: the browser's own print of the page
    printScreen: () => {
      if (typeof window !== 'undefined' && typeof window.print === 'function')
        window.print();
    },
    machineTick: (p, step, guards) =>
      new Promise((resolve) => {
        if (!machineEl) return resolve('tick');
        machineEl.hidden = false;
        const name = String(step.name || '').replace(/^%/, '');
        machineEl.innerHTML =
          `<span class="ipo-machine-state">${esc(name)}</span>` +
          (guards && guards.size
            ? ` <button class="btn primary ipo-continue">Continue</button>`
            : '') +
          ` <button class="btn ipo-stop">Stop</button>`;
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          // the park is over either way; the next park draws its own control
          machineEl.hidden = true;
          resolve(v);
        };
        const t = setTimeout(() => done('tick'), IPO_TICK_MS);
        // ...and on the worker clock too, for a hidden tab (done() is idempotent)
        if (typeof bmwSleep === 'function')
          bmwSleep(IPO_TICK_MS).then(() => done('tick'));
        const c = machineEl.querySelector('.ipo-continue');
        if (c) c.onclick = () => done('press');
        machineEl.querySelector('.ipo-stop').onclick = () => {
          machineEl.hidden = true;
          done('stop');
        };
      }),
    renderKeys: (p) => {
      const shown = (it) => !it.hidden || !!it.legendLabel;
      const plain = p.items.filter((it) => !it.shift && shown(it));
      const shifted = p.items.filter((it) => it.shift && shown(it));
      const asAction = (it) => {
        const n = it.shift ? it.nr - 10 : it.nr;
        return {
          key: n === 20 ? null : String(n % 10),
          keyLabel: it.shift ? `⇧F${it.nr - 10}` : `F${it.nr}`,
          label: ipoKeyLabel(p, it),
          kind: it.nr === 10 ? 'back' : undefined,
          fn: () => p.press(it.nr),
        };
      };
      const acts = plain.map(asAction);
      // The script's own F10 is the Back key (kind 'back' answers Esc too).
      // Only a menu WITHOUT one gets the app's Esc Back -- adding it beside
      // an F10 spilled it into the first empty slot, and SM46's captionless
      // F3 (read coding data) read "Back".
      if (!plain.some((it) => it.nr === 10)) {
        acts.push({
          key: 'Escape',
          keyLabel: 'Esc',
          label: 'Back',
          kind: 'back',
          fn: () => p.back(),
        });
      }
      const put = () =>
        setActions(acts, shifted.length ? shifted.map(asAction) : undefined);
      if (typeof setActions === 'function') {
        if (typeof keepActivationsDuring === 'function')
          keepActivationsDuring(put);
        else put();
      }
      if (titleEl) titleEl.textContent = ipoText(p.title || '');
      if (machineEl) machineEl.hidden = true;
      const jc =
        document.getElementById && document.getElementById('job-count');
      if (jc) jc.textContent = `${p.items.length} keys`;
    },
    paint: (p) => {
      if (!gridEl) return;
      if (titleEl) titleEl.textContent = ipoText(p.title || '');
      if (!inpa) {
        ipoPaintLines(gridEl, p);
        return;
      }
      // INPA mode: the canvas. One DOM row per screen row, each cell placed
      // at its column (padding with spaces), captions and values marked.
      const byRow = new Map();
      for (const c of p.cells.values()) {
        const r = Number(c.row),
          col = Number(c.col);
        // INPA's virtual screen has as many logical lines as the script
        // prints (a four-fault freeze-frame list runs past 30 rows and INPA
        // scrolls); the page scrolls the same way, so nothing is cut off
        if (!(r >= 0) || !(col >= 0)) continue;
        // a translated cell keeps the width the script gave the German, so
        // the columns INPA laid out stay put ("Motordrehzahl" and its value
        // at column 40 -> "Engine speed" padded to the same width). A longer
        // English pushes only its own row right.
        let text = ipoText(c.text);
        if (!text) continue;
        if (text !== c.text && text.length < c.text.length)
          text = text.padEnd(c.text.length);
        if (!byRow.has(r)) byRow.set(r, []);
        byRow
          .get(r)
          .push({ col, text, kind: c.kind, key: c.key, meta: c.meta });
      }
      const rows = [...byRow.keys()].sort((a, b) => a - b);
      if (!rows.length) {
        gridEl.innerHTML = `<div class="ipo-empty">${esc(ipoText(p.title || ''))}</div>`;
        return;
      }
      const last = rows[rows.length - 1];
      const html = [];
      for (let r = 0; r <= last; r++) {
        const cells = (byRow.get(r) || []).sort((a, b) => a.col - b.col);
        // a logical line's first row gets a little air above it (the fault
        // list is one LINE per entry); the top of the screen needs none
        const band =
          r > 0 && p.bandTops && (p.bandTops.get(r) || 0) >= 3
            ? ' ipo-band'
            : '';
        if (!cells.length) {
          html.push(`<div class="ipo-row${band}">&nbsp;</div>`);
          continue;
        }
        let out = '';
        let at = 0;
        for (const c of cells) {
          // a cell that starts before the previous one ended still gets one
          // space, so overlapping draws never merge into one word
          const gap = Math.max(c.col - at, at > 0 ? 1 : 0);
          out += ' '.repeat(gap);
          if (c.kind === 'lamp') {
            out += ipoLampHtml(c);
            at = c.col + c.text.length + 2;
            continue;
          }
          if (c.kind === 'gauge') {
            out += ipoGaugeHtml(c);
            at = c.col + IPO_GAUGE_COLS + c.text.length;
            continue;
          }
          const cls = c.kind === 'value' ? 'ipo-val' : 'ipo-cap';
          out += `<span class="${cls}"${c.key ? ` data-key="${esc(c.key)}"` : ''}>${esc(c.text)}</span>`;
          at = c.col + c.text.length;
        }
        // a value the script padded to its column width ends in blanks that
        // would only widen the row
        html.push(
          `<div class="ipo-row${band}">${out.replace(/\s+$/, '')}</div>`
        );
      }
      gridEl.innerHTML = html.join('');
    },
    left: () => {
      _ipoCurrent = null;
      if (typeof back === 'function') back();
    },
  };
  return ui;
}

// ---- entry point -------------------------------------------------------------
//
// Open the live program for a module. Returns true when it took the view
// (even if the script stopped itself: the reason is shown), false when this
// module cannot run live (no exec) so the caller falls back.
// ONE DRIVER AT A TIME. While the owner has admitted a helper, the helper's
// runtime is what runs on the cable. The owner's own module screens would
// cycle their jobs on the same K-line every tick and the helper's requests
// would queue behind them, seconds at a time; so an owner opening a module
// during a live share sees a notice instead, and a share being admitted
// closes whatever the owner had running.
function ipoRemoteDriving() {
  return (
    typeof Remote !== 'undefined' &&
    Remote &&
    Remote.role === 'owner' &&
    !!Remote.accepted
  );
}
function ipoPauseForRemote() {
  if (_ipoCurrent) {
    _ipoCurrent.close();
    _ipoCurrent = null;
  }
}

async function ipoProgramOpen(ecu, container, back, openMenu) {
  if (typeof IpoVm === 'undefined' || typeof FeedHost === 'undefined')
    return false;
  if (ipoRemoteDriving()) {
    container.className = 'results-panel';
    container.innerHTML =
      `<div class="empty"><div class="empty-big" style="color:var(--amber)">A helper is driving your car</div>` +
      `<div>Your own module screens stay off while the remote session is live, so the helper's reads are not queued behind them. End the session to use this module yourself.</div></div>`;
    sbLeft.textContent = `${ecu.sgbd}.prg · remote session live`;
    setActions([
      {
        key: 'Escape',
        keyLabel: 'Esc',
        label: 'Back',
        kind: 'back',
        fn: () => back(),
      },
    ]);
    return true;
  }
  if (typeof irLiveExec !== 'function' || typeof irExecSgbd !== 'function')
    return false;
  const exec = await irLiveExec(irExecSgbd(ecu));
  if (!exec || !exec.procs || !Object.keys(exec.procs).length) return false;
  if (!(exec.procs.inpainit || exec.procs.SgbdInpaCheck)) return false;
  if (_ipoCurrent) _ipoCurrent.close();
  if (ecu._ir && typeof irUseTranslations === 'function')
    irUseTranslations(ecu._ir);
  // which shipped SGBDs a script may address explicitly
  if (!ecu._ipoKnownSgbds) {
    try {
      const idx = await fetch('api/ecu-index.json').then((r) =>
        r.ok ? r.json() : null
      );
      ecu._ipoKnownSgbds = new Set(
        Object.keys(idx || {}).map((k) => k.toLowerCase())
      );
    } catch (e) {
      ecu._ipoKnownSgbds = new Set();
    }
  }
  // the fault dictionaries the fed results are translated through
  // (faultdb.js: large, injected on demand, absent from a build that opted
  // out of the fault tables -- then the ECU's German is what shows)
  if (ipoTranslating() && typeof loadFaultDb === 'function') {
    try {
      await loadFaultDb();
    } catch (e) {
      /* results stay as sent */
    }
  }
  const ui = ipoMakeUi(ecu, container, back);
  const program = new IpoProgram(ecu, exec, ui);
  _ipoCurrent = program;
  sbLeft.textContent = `${ecu.sgbd}.prg · starting`;
  const r = await program.start();
  if (!r.ok) {
    if (program.silent || r.reason === 'stopped') {
      const m = (program.messages || []).slice(-1)[0];
      container.className = 'results-panel';
      container.innerHTML =
        `<div class="empty"><div class="empty-big" style="color:var(--amber)">` +
        `${esc(m ? ipoText(m.title) : `${ecu.label} is not answering`)}</div>` +
        `<div>${esc(
          m
            ? ipoText(m.body || '')
            : 'The cable is connected, but this module did not identify itself. It may not be fitted to this car, or the ignition may need to be on.'
        )}</div></div>`;
      sbLeft.textContent = `${ecu.sgbd}.prg · ${program.silent ? 'no response' : 'stopped'}`;
      setActions([
        {
          key: 'Escape',
          keyLabel: 'Esc',
          label: 'Back',
          kind: 'back',
          fn: () => back(),
        },
      ]);
      _ipoCurrent = null;
      return true;
    }
    _ipoCurrent = null;
    return false; // let the caller fall back to the derived renderer
  }
  if (openMenu && openMenu !== program.menu && exec.procs[openMenu]) {
    await program.openMenu(openMenu);
  }
  return true;
}

if (typeof window !== 'undefined') {
  window.ipoProgramOpen = ipoProgramOpen;
  window.ipoPauseForRemote = ipoPauseForRemote;
  window.ipoLiveEnabled = ipoLiveEnabled;
  window.IpoProgram = IpoProgram;
  window.ipoMenuItems = ipoMenuItems;
  window.ipoWireTarget = ipoWireTarget;
  window.ipoScreenForMenu = ipoScreenForMenu;
  window.ipoNeedsConfirm = ipoNeedsConfirm;
  window.ipoMakeUi = ipoMakeUi;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipoNeedsConfirm,
    IpoProgram,
    ipoMenuItems,
    ipoWireTarget,
    ipoProgramOpen,
    ipoMakeUi,
    ipoLiveEnabled,
    ipoLineRows,
    ipoMenuTiles,
    ipoScreenComponents,
    ipoLampHtml,
    ipoGaugeHtml,
    ipoScreenLineNames,
  };
}
