/**
 * @file IpoProgram: the driver that runs a module's script the way INPA
 * does. Entry (startup + inpainit, following scriptchange), the root menu
 * the script sets, key presses in the same persistent VM, screen cycles with
 * their own jobs, the script's own Back as the release, inpaexit on leave.
 * Every suspension the VM raises (a wire job, a wait, a prompt, a message, a
 * picker, a %STATE park, an exit) is answered here through the UI adapter.
 */

/** A frequent screen's cycle period, and a parked machine's tick. */
const IPO_TICK_MS = 600;

/** scriptchange chain bound: how many hand-offs runEntry follows. */
const IPO_MAX_HOPS = 4;

/** Suspensions per drive, a runaway guard. */
const IPO_MAX_STEPS = 4000;

/** The VM's step budget per run in the live runtime. */
const IPO_VM_BUDGET = 800000;

/** How many suspensions the startup proc may raise while its defaults run. */
const IPO_STARTUP_STEPS = 200;

/** The longest a scripted wait (wartezeit) is honoured, in ms. */
const IPO_WAIT_MAX_MS = 30000;

/** How many sent jobs the program's log keeps. */
const IPO_LOG_MAX = 200;

/** How many job names an action record carries for the remote owner. */
const IPO_ACTION_JOBS_MAX = 30;

/** INPA's Back key: F10 when the menu declares one. */
const IPO_BACK_KEY = 10;

/** A job the wire could not run at all. */
const IPO_STATUS_NO_ANSWER = 'ERROR_NO_ANSWER';

/**
 * How a remote owner's refusal reads in the script's own JOB_STATUS box, so
 * the reason shows in plain words rather than as a wire timeout it was not.
 * @type {Array<[RegExp, string]>}
 */
const IPO_REMOTE_STATUS = [
  [/remote: .*declined/i, 'The host rejected your request'],
  [/remote: .*read-only/i, 'The host shared this car read-only'],
  [/remote: .*not admitted/i, 'The host has not admitted you yet'],
];

/** A job that energises something (STEUERN_ or START prefixed)... */
const IPO_ENERGISE_RE = /^(STEUERN|START)/i;
/** ...unless it is the release half of the pair (an _AUS, _ENDE, _OFF, _STOP). */
const IPO_RELEASE_SUFFIX_RE = /(_AUS|_ENDE|_OFF|_STOP)$/i;

/** The job that identifies the module; its answer names the variant. */
const IPO_INIT_JOB_RE = /^INITIALISIERUNG$/i;

/** The wire errors that mean the module did not answer at all. */
const IPO_SILENT_RE = /IFH-0009|IFH-0019|no answer/i;

/**
 * The context a run is driven in: what it is, for confirm dialogs and the
 * confirm cache, and whether the user already confirmed it.
 * @typedef {object} IpoRunContext
 * @property {string} label - what is running (a key caption, a proc name)
 * @property {string} scope - entry | exit | menu:<name> | screen:<name> |
 *   key:<menu>:<nr> | machine:<name>
 * @property {boolean} [preConfirmed] - the key's confirm already covered its writes
 */

/**
 * What drive() reports when a run settles.
 * @typedef {object} IpoDriveResult
 * @property {boolean} done - the run finished
 * @property {boolean} [exit] - the script ended itself
 * @property {boolean} [cancelled] - the user declined a prompt, or the view closed
 * @property {boolean} [noCable] - the entry run stopped because no adapter is connected
 */

/**
 * The USER ACTION a job belongs to: the key press (or the machine it
 * started, or the screen it set) that caused it. Sent with every job so a
 * remote owner approves the ACTION once, not each job it sends.
 * @typedef {object} IpoAction
 * @property {string} id - unique per press
 * @property {string} label - the key's caption
 * @property {string[]} jobs - the job names the body can send
 */

/**
 * The UI adapter the program drives (see ipoMakeUi for the app's).
 * @typedef {object} IpoUi
 * @property {(ms: number) => Promise<void>} sleep - a scripted wait
 * @property {(sgbd: string) => Promise<object|null>} loadExec - another script's exec (scriptchange)
 * @property {(p: IpoProgram) => void} route - reflect the menu in the URL
 * @property {(p: IpoProgram, text: string) => void} status - the status line
 * @property {(p: IpoProgram, text: string) => void} error - an error on the status line
 * @property {(title: string, body: string|null) => Promise<void>} message - a blocking message box
 * @property {(step: IpoStep, label: string|undefined) => Promise<*>} askInput - an INPA prompt
 * @property {(p: IpoProgram, it: IpoMenuItem, jobs: string[], writes: string[]) => Promise<boolean>} confirmKey - confirm a key whose body can write
 * @property {(p: IpoProgram, job: string, arg: string|null, ctx: IpoRunContext) => Promise<boolean>} confirmWrite - confirm one write
 * @property {(p: IpoProgram, step: IpoStep) => Promise<IpoPick|null>} pickComponent - the togglelist picker
 * @property {(p: IpoProgram, names: string[], multiple: boolean, current: Set<string>|null) => Promise<string[]|null>} pickLines - INPA's Select
 * @property {(p: IpoProgram) => void} printScreen - INPA's printscreen
 * @property {(ecu: EcuRecord, script: string, exec: IpoExec) => Promise<EcuRecord|null>} [resolveScriptEcu] -
 *   the module a scriptchange target addresses, identified by the car
 * @property {(p: IpoProgram, step: IpoStep, guards: Set<number>) => Promise<'tick'|'press'|'stop'>} machineTick - a %STATE park
 * @property {(p: IpoProgram) => void} renderKeys - the F-key bar
 * @property {(p: IpoProgram) => void} paint - the screen
 * @property {(p: IpoProgram) => void} left - the module was left
 */

/** One module's script, running. */
class IpoProgram {
  /**
   * @param {object} ecu - the module (sgbd, label, chassis, group, _variant, ...)
   * @param {object} exec - the decoded script ({procs, byid})
   * @param {IpoUi} ui - the UI adapter
   */
  constructor(ecu, exec, ui) {
    this.ecu = ecu;
    this.exec = exec;
    this.ui = ui;
    /** @type {IpoVm|null} */
    this.vm = null;
    /** @type {string|null} the current menu proc */
    this.menu = null;
    /** @type {IpoMenuItem[]} */
    this.items = [];
    /** @type {string|null} the current screen proc */
    this.screen = null;
    this.frequent = false;
    /** @type {string|null} */
    this.title = null;
    /** @type {Map<string, IpoCell>} "row:col" -> cell */
    this.cells = new Map();
    /** @type {IpoLine[]} last painted lines (modern mode) */
    this.lines = [];
    this.cycleTimer = null;
    this.busy = false; // a key body or a cycle is on the wire
    /** @type {Map<number, number>} absolute row a logical line begins at -> its height */
    this.bandTops = new Map();
    /** @type {Set<string>|null} Select's choice of logical lines, null = all */
    this.lineFilter = null;
    /** @type {IpoAction|null} */
    this.action = null;
    this.actionSeq = 0;
    this.cycleToken = 0; // bumps on every (re)schedule so a stale tick is dropped
    this.filterChanged = false;
    this.running = false; // a key press, from body to settled menu/screen
    /** @type {number|'back'|null} the key pressed meanwhile */
    this.queued = null;
    this.gen = 0; // bumped on every navigation; stale cycles stop
    this.closed = false;
    /** @type {Set<string>} "scope:job" confirmed in this menu */
    this.confirmedWrites = new Set();
    /** @type {Array<{target: string, job: string, arg: string|null, status: string}>} sent jobs, newest last */
    this.log = [];
    /** @type {IpoMessage[]} messageboxes shown, in order */
    this.messages = [];
    this.hops = 0;
    /** @type {string|null} the script scriptchange handed control to */
    this.script = null;
    /** @type {string|null} the menu the entry set (the route's root) */
    this.rootMenu = null;
    this.answered = false; // INITIALISIERUNG returned any result
    this.silent = false; // INITIALISIERUNG got no answer at all
    this.noCable = false; // no adapter: the script cannot ask the car
  }

  // ---- VM -----------------------------------------------------------------

  /**
   * A fresh VM for a script, its compiled-in defaults already run. Startup
   * touches no wire, but a stray job must not park the machine.
   * @param {object} exec - the decoded script
   * @returns {IpoVm}
   */
  newVm(exec) {
    const vm = new IpoVm(exec, {
      budget: IPO_VM_BUDGET,
      wireJobs: true,
      host: new FeedHost(),
    });
    if (exec.procs.__inpa_startup__) {
      try {
        let st = vm.stepStart('__inpa_startup__');
        for (
          let n = 0;
          n < IPO_STARTUP_STEPS && st && st.kind !== 'done';
          n++
        ) {
          st = vm.resume(new Map());
        }
      } catch (e) {
        /* defaults only */
      }
    }
    vm.out = new vm.out.constructor();
    return vm;
  }

  /**
   * Start a run with empty emissions; state (globals, timers) persists.
   * @returns {Emissions}
   */
  fresh() {
    this.vm.out = new this.vm.out.constructor();
    return this.vm.out;
  }

  // ---- the suspension loop --------------------------------------------------

  /**
   * Drive a started run to completion, honouring every suspension: a wire
   * job is sent and its results fed back, a wait sleeps, a prompt asks, a
   * message blocks, a picker picks, a state machine ticks, an exit ends the
   * module.
   * @param {IpoStep} step - the first pending action
   * @param {IpoRunContext} ctx - what is running
   * @returns {Promise<IpoDriveResult>}
   * @throws {Error} when the run raises more suspensions than IPO_MAX_STEPS
   */
  async drive(step, ctx) {
    const vm = this.vm;
    let n = 0;
    while (step && step.kind !== 'done') {
      if (++n > IPO_MAX_STEPS) throw new Error('script did not settle');
      if (this.closed) return { done: false, cancelled: true };
      if (step.kind === 'job') {
        const fed = await this.runJob(step.sgbd, step.job, step.arg, ctx);
        if (fed == null) return { done: false, cancelled: true };
        // no adapter while identifying the module: stop here rather than let
        // the script raise its own "Program will be stopped" box over a car
        // it never reached -- the opener shows the no-cable notice instead
        if (this.noCable && ctx && ctx.scope === 'entry')
          return { done: false, cancelled: true, noCable: true };
        step = vm.resume(fed);
      } else if (step.kind === 'wait') {
        await this.ui.sleep(Math.min(Number(step.ms) || 0, IPO_WAIT_MAX_MS));
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

  /**
   * Select's choice: the names of the logical lines to show, or null for
   * all. The current screen is repainted through it; a screen change keeps
   * it (INPA keeps the selection until Deselect).
   * @param {string[]|null} names - the lines to keep
   * @returns {void}
   */
  setLineFilter(names) {
    this.lineFilter = names ? new Set(names) : null;
    this.cells = new Map();
    this.lines = [];
    this.filterChanged = true;
  }

  /**
   * A run that is still parked (a machine at its picker or a %STATE) may
   * already have set a title and a screen; show them without cycling the
   * screen (a cycle would clobber the suspension).
   * @param {Emissions} out - the run's emissions so far
   * @returns {void}
   */
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

  /**
   * The JOB_STATUS a failed send reads as: a remote owner's refusal in plain
   * words, else ERROR_NO_ANSWER.
   * @param {string} message - the error's message
   * @returns {string}
   */
  static failStatus(message) {
    for (const [re, text] of IPO_REMOTE_STATUS)
      if (re.test(message)) return text;
    return IPO_STATUS_NO_ANSWER;
  }

  /**
   * One job on the wire. Confirms a write the first time it appears in this
   * context, feeds the answer (plus the engine's system set, where inpainit
   * reads VARIANTE) back to the VM.
   *
   * Only what the USER activates asks. inpainit is the script identifying
   * the module -- INPA sends its jobs without a word, and a default-deny
   * classifier reading LWR_VORHANDEN ("is headlight levelling fitted?") as
   * a write turned opening the LSZ into a dialog.
   * @param {string|null} sgbd - the SGBD the script named
   * @param {string} job - job name
   * @param {string|null} arg - job argument
   * @param {IpoRunContext} ctx - what is running
   * @returns {Promise<IpoFeed|null>} the feed, or null when the user declined
   */
  async runJob(sgbd, job, arg, ctx) {
    const target = ipoWireTarget(this.ecu, sgbd);
    const entry = !!(ctx && (ctx.scope === 'entry' || ctx.scope === 'exit'));
    const write = !entry && ipoNeedsConfirm(job);
    const ckey = `${ctx && ctx.scope ? ctx.scope : '*'}:${job}`;
    if (
      write &&
      ipoConfirmWanted(job) &&
      !this.confirmedWrites.has(ckey) &&
      !(ctx && ctx.preConfirmed)
    ) {
      const ok = await this.ui.confirmWrite(this, job, arg, ctx);
      if (!ok) return null;
      this.confirmedWrites.add(ckey);
    }
    if (
      write &&
      IPO_ENERGISE_RE.test(job) &&
      !IPO_RELEASE_SUFFIX_RE.test(job) &&
      typeof markEnergized === 'function'
    ) {
      markEnergized();
    }
    /** @type {IpoFeed} */
    const fed = new Map();
    let status;
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
      if (IPO_INIT_JOB_RE.test(job) && this.ecu._variant) {
        fed.set('VARIANTE', String(this.ecu._variant));
      }
      if (IPO_INIT_JOB_RE.test(job)) {
        this.answered =
          this.answered ||
          dataSets(d.sets).some((s) =>
            Object.keys(s).some((k) => !k.startsWith('_'))
          );
      }
    } catch (e) {
      const m = String((e && e.message) || '');
      status = IpoProgram.failStatus(m);
      fed.set('JOB_STATUS', status);
      fed.sets = [{}]; // no sets came back
      // no adapter at all: the script cannot ask the car anything, and the
      // module view says so instead of running inpainit's error branch
      if (/no cable/i.test(m)) this.noCable = true;
      if (IPO_INIT_JOB_RE.test(job) && IPO_SILENT_RE.test(e.message || ''))
        this.silent = true;
    }
    this.log.push({ target, job, arg: arg || null, status });
    if (this.log.length > IPO_LOG_MAX) this.log.shift();
    this.ui.status(this, `${job}${arg ? ` ${arg}` : ''} · ${status}`);
    return fed;
  }

  // ---- entry --------------------------------------------------------------

  /**
   * Run the script from its entry proc to its root menu.
   * @returns {Promise<{ok: boolean, reason?: string, messages?: IpoMessage[]}>}
   */
  async start() {
    this.vm = this.newVm(this.exec);
    const r = await this.runEntry();
    if (!r.ok) return r;
    if (!this.menu) return { ok: false, reason: 'the script opened no menu' };
    await this.openMenu(this.menu, { fromEntry: true });
    return { ok: true };
  }

  /**
   * inpainit (or SgbdInpaCheck) live, following a scriptchange chain. Leaves
   * this.menu / this.screen as the script set them.
   * @returns {Promise<{ok: boolean, reason?: string, messages?: IpoMessage[]}>}
   */
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

  /**
   * Follow a key's scriptchange: load the named script, let the car name the
   * module it addresses (the script's inpainit lists the variants it
   * accepts; the group that can identify one of them is asked live), then
   * run the new script's entry and open the menu it names. The original
   * module record stays on the UI adapter (title, route); the program
   * itself talks to the new one from here on. A script this build does not
   * carry, or a module that does not answer, is reported and the current
   * screen stays.
   * @param {string} name - the script the key named (any case)
   * @param {number} gen - the generation the key press belongs to
   * @returns {Promise<boolean>} true (the press was handled)
   */
  async _changeScript(name, gen) {
    const next = String(name || '')
      .trim()
      .toLowerCase();
    const nexec = next ? await this.ui.loadExec(next) : null;
    if (!nexec || !nexec.procs || !Object.keys(nexec.procs).length) {
      await this.ui.message(
        'Script not in this build',
        `${name} is not shipped with this vehicle.`
      );
      this._rescheduleIfFrequent(gen);
      return true;
    }
    const target = this.ui.resolveScriptEcu
      ? await this.ui.resolveScriptEcu(this.ecu, next, nexec)
      : null;
    if (this.closed || gen !== this.gen) return true;
    if (!target) {
      await this.ui.message(
        'Module not answering',
        `The module ${name} addresses did not identify itself.`
      );
      this._rescheduleIfFrequent(gen);
      return true;
    }
    this.stopCycle();
    this.ecu = target;
    this.exec = nexec;
    this.script = next;
    this.hops = 0;
    this.confirmedWrites.clear();
    this.lineFilter = null;
    this.messages = [];
    this.vm = this.newVm(nexec);
    this.ui.status(this, `${next}.ipo · starting`);
    const r = await this.runEntry();
    if (this.closed) return true;
    if (!r.ok) {
      if (r.reason !== 'stopped' && r.reason !== 'cancelled')
        this.ui.error(this, r.reason);
      return true;
    }
    if (!this.menu) return true;
    await this.openMenu(this.menu, { fromEntry: true });
    return true;
  }

  // ---- menus ----------------------------------------------------------------

  /**
   * Open a menu: run its prologue (title, defaults, often its first job),
   * follow a menu switch it performs, pick its backdrop screen, register its
   * release, paint.
   * @param {string} name - the menu proc
   * @param {{fromEntry?: boolean, screen?: string|null, frequent?: boolean}} [opts] -
   *   the screen the opening key set, or that this is the entry's menu
   * @returns {Promise<boolean>} false when the menu does not exist
   */
  async openMenu(name, opts = {}) {
    if (!this.exec.procs[name]) return false;
    this.stopCycle();
    const gen = ++this.gen;
    this.menu = name;
    this.items = ipoMenuItems(this.exec, name);
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
    // repaint that is not held. Paint the keys held, THEN register this
    // menu's release: registering first let the hook send the new menu's
    // Back job the moment its keys appeared.
    this.ui.renderKeys(this);
    this.registerRelease();
    this.ui.route(this);
    if (this.screen) await this.showScreen(this.screen, this.frequent);
    else this.ui.paint(this);
    return true;
  }

  /**
   * The Back ITEM's first confirm-worthy job and its argument, scanned from
   * the body: the string constants pushed before the INPAapiJob call.
   * @returns {{job: string|null, arg: string|null}}
   */
  _backItemJob() {
    const back = this.items.find((it) => it.nr === IPO_BACK_KEY);
    if (!back) return { job: null, arg: null };
    const toks = this.exec.procs[this.menu];
    for (let i = back.start; i < back.end; i++) {
      const t = toks[i];
      if (!(t.op === 'call' && /^INP.?apiJob/.test(t.name || ''))) continue;
      const consts = [];
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const c = toks[j];
        if (c.op === 'frame') break;
        if (c.op === 'const' && c.t === 's') consts.unshift(String(c.v));
      }
      const jn = consts.find((v) => /^[A-Z][A-Z0-9_]{3,}$/.test(v));
      if (jn && ipoNeedsConfirm(jn)) {
        const a = consts[consts.indexOf(jn) + 1];
        return { job: jn, arg: a != null && a !== '' ? a : null };
      }
      return { job: null, arg: null };
    }
    return { job: null, arg: null };
  }

  /**
   * The script's own release for this menu: the Back ITEM's first job, so a
   * route change or page hide still sends it (a pressed Back runs the whole
   * body itself).
   * @returns {void}
   */
  registerRelease() {
    if (typeof registerMenuLeave !== 'function') return;
    const { job, arg } = this._backItemJob();
    registerMenuLeave(this.ecu, `${this.ecu.sgbd}:${this.menu}`, job, arg);
  }

  /**
   * Same key, no job: registerMenuLeave keeps the key and so sends nothing.
   * @returns {void}
   */
  forgetRelease() {
    if (typeof registerMenuLeave !== 'function') return;
    registerMenuLeave(this.ecu, `${this.ecu.sgbd}:${this.menu}`, null, null);
  }

  // ---- screens --------------------------------------------------------------

  /**
   * Show a screen: cycle it once, then let a frequent one keep cycling.
   * @param {string} name - the screen proc
   * @param {boolean} frequent - re-run on a timer
   * @returns {Promise<void>}
   */
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

  /**
   * An ITEM with no caption is still a key (SHD46's Select, its quit-mode
   * pair): INPA's bar shows it blank and the screen's legend names it. Take
   * that legend line as the key's label.
   * @returns {void}
   */
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

  /**
   * One INIT -> LINE cycle of the current screen, painted at the end; a
   * frequent screen schedules the next one.
   * @param {number} gen - the navigation generation this cycle belongs to
   * @returns {Promise<void|boolean>}
   */
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
      // its release itself); forget the registration so switching menus
      // does not send it again
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

  /**
   * Schedule the next cycle of a frequent screen. The tick runs on the bus's
   * worker-backed timer where one exists: a hidden tab's setTimeout fires
   * once a second at best, which stretched a 600 ms screen cycle to a second
   * or more for a remote helper.
   * @param {number} gen - the navigation generation
   * @returns {void}
   */
  scheduleCycle(gen) {
    this.stopCycle();
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

  /**
   * Cancel a pending cycle (orphaning a worker-clock tick too).
   * @returns {void}
   */
  stopCycle() {
    this.cycleToken = (this.cycleToken || 0) + 1;
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  /**
   * The next cycle of a frequent screen, when one is showing.
   * @param {number} gen - the navigation generation
   * @returns {void}
   */
  _rescheduleIfFrequent(gen) {
    if (this.frequent && this.screen) this.scheduleCycle(gen);
  }

  /**
   * The painted grid from a cycle's emissions. Cells keyed by position so a
   * later cycle overwrites in place; blankscreen clears first.
   *
   * INPA's virtual screen is a stack of LOGICAL lines: every LINE block's
   * coordinates are relative to its own top, and a LINE is as tall as the
   * physical rows it printed (the manual's `text(2, 0, "")` pads one to
   * three rows). A fault list prints each entry at rows 0-4 of its own LINE;
   * placing them absolutely drew every fault over the first.
   * @param {Emissions} out - the run's emissions
   * @returns {void}
   */
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
    // the LINE grouping the modern skin draws from: a screen cycle emits
    // every LINE, a key body usually none -- keep the last full cycle's
    if (lines.some((ln) => (ln.elements || []).some((el) => el.row != null)))
      this.lines = lines;
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
        this.cells.set(`${el.row}:${el.col}`, IpoProgram.cellOf(el));
      }
    }
  }

  /**
   * A grid cell from a drawn element.
   * @param {IpoElement} el - the element (its row already absolute)
   * @returns {IpoCell}
   */
  static cellOf(el) {
    return {
      row: el.row,
      col: el.col,
      text: el.s != null ? String(el.s) : '',
      key: el.key || null,
      kind: el.t,
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
    };
  }

  // ---- keys ---------------------------------------------------------------

  /**
   * Press a key. A key pressed while a cycle or another key is on the wire
   * is QUEUED, not dropped: INPA takes the keypress after the current block.
   * One key waits (the last pressed), and Back too.
   * @param {number} nr - the F-key number
   * @returns {Promise<boolean>} false when the menu has no such key
   */
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

  /**
   * Run the queued key, if any, on the next turn.
   * @returns {void}
   */
  _drain() {
    const q = this.queued;
    if (q == null || this.closed) return;
    this.queued = null;
    setTimeout(() => {
      if (q === 'back') this.back();
      else this.press(q);
    }, 0);
  }

  /**
   * The press itself: confirm once, naming what the body can send, then run
   * the body and follow where it went.
   * @param {number} nr - the F-key number
   * @returns {Promise<boolean>}
   */
  async _press(nr) {
    const it = this.items.find((x) => x.nr === nr);
    if (!it) return false;
    this.stopCycle();
    const gen = ++this.gen;
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
      jobs: jobs.slice(0, IPO_ACTION_JOBS_MAX),
    };
    let preConfirmed = false;
    // "Send immediately" drops the prompt for actuator drives; a key whose
    // writes are all drives then runs like INPA's own keypress
    const asks = writes.filter(ipoConfirmWanted);
    if (asks.length) {
      const ok = await this.ui.confirmKey(this, it, jobs, asks);
      if (!ok) {
        this._rescheduleIfFrequent(gen);
        return true;
      }
      preConfirmed = true;
    }
    return this._runForKey(
      it,
      gen,
      { label: it.label, scope: `key:${this.menu}:${nr}`, preConfirmed },
      () => this.vm.stepStartItem(this.menu, nr),
      it.label,
      true
    );
  }

  /**
   * A state machine a key started: setstate(&sm) means the key's work IS
   * the machine (SHD46 Select: togglelist -> STEUERN_DIGITAL -> quit-mode
   * box -> back to the menu screen).
   * @param {string} name - the state machine proc
   * @param {IpoMenuItem} it - the key that started it
   * @param {number} gen - the navigation generation
   * @param {boolean} preConfirmed - the key's confirm covered its writes
   * @returns {Promise<boolean>}
   */
  async runMachine(name, it, gen, preConfirmed) {
    return this._runForKey(
      it,
      gen,
      { label: it.label || name, scope: `machine:${name}`, preConfirmed },
      () => this.vm.stepStart(name),
      it.label || name,
      false
    );
  }

  /**
   * Drive a key's run (its body, or the machine it started) and follow where
   * it went: an error is reported and the screen's cycle resumed, an exit
   * leaves the module, a cancel is announced, a setstate hands over to the
   * machine, anything else settles on the menu/screen the run set.
   * @param {IpoMenuItem} it - the key
   * @param {number} gen - the navigation generation
   * @param {IpoRunContext} ctx - what is running
   * @param {() => IpoStep} start - begins the run on the VM
   * @param {string} cancelLabel - what a cancel announces
   * @param {boolean} followMachine - honour a setstate the run emitted
   * @returns {Promise<boolean>}
   */
  async _runForKey(it, gen, ctx, start, cancelLabel, followMachine) {
    this.busy = true;
    const out = this.fresh();
    let result;
    try {
      result = await this.drive(start(), ctx);
    } catch (e) {
      this.ui.error(this, e.message);
      this.busy = false;
      this._rescheduleIfFrequent(gen);
      return true;
    } finally {
      this.busy = false;
    }
    if (this.closed || gen !== this.gen) return true;
    if (result.exit || out.exit) return this.leaveModule();
    if (result.cancelled) {
      this.ui.status(this, `${cancelLabel} · cancelled`);
      this._rescheduleIfFrequent(gen);
      return true;
    }
    if (out.title) this.title = out.title;
    // scriptchange from a key: INPA drops this script for another one --
    // SM46's "change to passenger's side" hands the view to B_SM46.IPO, a
    // different module on its own address
    if (out.scriptChange)
      return this._changeScript(String(out.scriptChange), gen);
    // the body painted (userbox text, a result line): show it with the screen
    this.takeCells(out);
    if (followMachine && out.stateEnter && this.exec.procs[out.stateEnter]) {
      return this.runMachine(out.stateEnter, it, gen, ctx.preConfirmed);
    }
    return this.settle(out, it, gen);
  }

  /**
   * After a key or a machine ran: follow the menu/screen it set.
   * @param {Emissions} out - the run's emissions
   * @param {IpoMenuItem} it - the key (unused; kept for callers)
   * @param {number} gen - the navigation generation
   * @returns {Promise<boolean>}
   */
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
    this._rescheduleIfFrequent(gen);
    return true;
  }

  /**
   * Navigation Back = INPA's F10 when the menu has one, else the root: exit.
   * @returns {Promise<boolean|void>}
   */
  async back() {
    if (this.running || this.busy) {
      this.queued = 'back';
      return;
    }
    if (this.items.some((it) => it.nr === IPO_BACK_KEY))
      return this.press(IPO_BACK_KEY);
    return this.leaveModule();
  }

  /**
   * Leave the module: inpaexit is what the script owes the ECU on the way
   * out (DIAGNOSE_ENDE, INPAapiEnd) -- a release, so it does not prompt.
   * @returns {Promise<void>}
   */
  async leaveModule() {
    if (this.closed) return;
    this.closed = true;
    this.stopCycle();
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

  /**
   * The view is being torn down by navigation: stop, keep the release.
   * @returns {void}
   */
  close() {
    this.closed = true;
    this.stopCycle();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IPO_TICK_MS, IpoProgram };
}
