// Control unit tree: the live scan. INPA's whole-car fault read runs here,
// headless, against a read-only UI adapter, so the tree's boxes colour in
// as each module answers instead of the page leaving for the module view.
// The program is the same IpoProgram the module view drives; only the UI
// differs, and it declines every write, so nothing this screen starts can
// change the car.

/** How often the boxes are repainted from the wire log while a read runs. */
const ECU_TREE_SCAN_TICK_MS = 250;

/**
 * @typedef {object} EcuTreeScanHooks
 * @property {(report: object, text: string) => void} [onProgress] - the
 *   reads so far folded into a report, and the script's own progress line
 * @property {(title: string, body: string) => void} [onMessage] - a message
 *   box the script opened (recorded, the read goes on)
 */

/**
 * The read-only UI adapter the headless scan runs against: every method
 * ipoMakeUi offers, none of them touching the page. A key that would write
 * is declined and a prompt is abandoned, so the script can only read.
 * @param {EcuTreeScanHooks} hooks - where progress goes
 * @returns {object} the adapter
 */
function ecuTreeHeadlessUi(hooks) {
  const h = hooks || {};
  let lastBox = '';
  return {
    /** the program leaves the address bar alone for a UI that owns no page */
    headless: true,
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
    route: () => {},
    status: () => {},
    error: (p, text) => {
      if (h.onProgress) h.onProgress(null, `error: ${text}`);
    },
    message: async (title, body) => {
      if (h.onMessage) h.onMessage(String(title || ''), String(body || ''));
    },
    askInput: async () => null,
    confirmKey: async () => false,
    confirmWrite: async () => false,
    pickComponent: async () => null,
    pickHome: async () => null,
    pickLines: async () => null,
    saveFile: async () => null,
    writeFile: async () => {},
    printScreen: () => {},
    printFile: () => {},
    resolveScriptEcu: (from, script, exec) =>
      typeof ipoResolveScriptEcu === 'function'
        ? ipoResolveScriptEcu(from, script, exec)
        : null,
    machineTick: async () => {
      await new Promise((r) => setTimeout(r, 100));
      return 'tick';
    },
    userbox: (p, box) => {
      if (!box) return;
      const lines = box.lines || [];
      const raw = lines.length ? String(lines[lines.length - 1]) : '';
      // the script's own words, in the app's language where it has them
      const text = (typeof ipoText === 'function' ? ipoText(raw) : raw).trim();
      if (text && text !== lastBox) {
        lastBox = text;
        if (h.onProgress) h.onProgress(null, text);
      }
    },
    renderKeys: () => {},
    paint: () => {},
    left: () => {},
  };
}

/**
 * @typedef {object} EcuTreeScanHandle
 * @property {Promise<{report: object, lines: string[]}>} done - resolves
 *   with the finished report (rejects: no cable, no script, no read key)
 * @property {() => void} cancel - end the read between two jobs
 */

/**
 * Start INPA's whole-car fault read for a chassis, headless.
 *
 * The same steps the Garage's Fault scan takes in the module view: open
 * the chassis's vehicle script, go to its fault-memory menu, press the read
 * key, fold the wire log into a report, run the script's own exit. While
 * the key runs, the wire log is folded every ECU_TREE_SCAN_TICK_MS and
 * handed to onProgress, so a caller can colour in what has answered.
 * @param {string} chassis - the chassis id
 * @param {EcuTreeScanHooks} hooks - progress sinks
 * @param {object} [deps] - the runtime pieces (tests hand in fakes)
 * @returns {EcuTreeScanHandle}
 */
function ecuTreeScanStart(chassis, hooks, deps) {
  const D = {
    Program: typeof IpoProgram !== 'undefined' ? IpoProgram : null,
    loadExec: typeof irLiveExec === 'function' ? irLiveExec : null,
    report: typeof ipoProtocolReport === 'function' ? ipoProtocolReport : null,
    /** the script's caption dictionary (ir.i18n), as the module view loads it */
    loadLabels:
      typeof api === 'function' ? (sgbd) => api(`/api/ecu/${sgbd}/ir`) : null,
    faultMenu:
      typeof IPO_VEHICLE_FAULT_MENU !== 'undefined'
        ? IPO_VEHICLE_FAULT_MENU
        : 'm_fs',
    faultKey:
      typeof GARAGE_FAULT_KEY !== 'undefined'
        ? GARAGE_FAULT_KEY
        : /^(FS lesen|Fehlerspeicher lesen|Read fault memory)$/i,
    cableReady: typeof window !== 'undefined' ? window.cableReady : null,
    label: (id) => (typeof dispChassis === 'function' ? dispChassis(id) : id),
    ...(deps || {}),
  };
  const id = String(chassis).toUpperCase();
  /** @type {object|null} */
  let program = null;
  let cancelled = false;
  const done = (async () => {
    if (!D.Program || !D.loadExec || !D.report)
      throw new Error('the script runtime is not loaded');
    const exec = await D.loadExec(id.toLowerCase());
    if (!exec)
      throw new Error(`INPA ships no whole-car script for ${D.label(id)}`);
    // the script's own words come through userbox; the module view draws
    // them through the script's caption dictionary, so this read does too
    if (D.loadLabels && typeof irUseTranslations === 'function') {
      const ir = await Promise.resolve(D.loadLabels(id.toLowerCase())).catch(
        () => null
      );
      if (ir) irUseTranslations(ir);
    }
    // the silent reconnect on load may still be running
    if (D.cableReady) await D.cableReady.catch(() => {});
    const ecu = {
      code: id,
      sgbd: id.toLowerCase(),
      label: `INPA ${D.label(id)} script`,
      group: null,
      kind: 'vehicle',
      chassis: id,
    };
    const p = new D.Program(ecu, exec, ecuTreeHeadlessUi(hooks));
    program = p;
    if (cancelled) {
      p.close();
      throw new Error('cancelled');
    }
    const r = await p.start();
    if (p.noCable) {
      p.close();
      throw new Error('No adapter connected');
    }
    if (!r || !r.ok) {
      const last = p.messages[p.messages.length - 1];
      p.close();
      throw new Error(
        `the script did not start (${(r && r.reason) || 'stopped'})` +
          (last ? `: ${last.title}${last.body ? ` ${last.body}` : ''}` : '')
      );
    }
    if (exec.procs[D.faultMenu] && p.menu !== D.faultMenu)
      await p.openMenu(D.faultMenu);
    const key = p.items.find((it) =>
      D.faultKey.test(String(it.label || it.legendLabel || '').trim())
    );
    if (!key) {
      await p.leaveModule();
      throw new Error(`no fault-memory read key on ${p.menu}`);
    }
    const tick = () => {
      if (hooks && hooks.onProgress)
        hooks.onProgress(D.report(p.wireReads, []), '');
    };
    const timer = setInterval(tick, ECU_TREE_SCAN_TICK_MS);
    try {
      await p.press(key.nr);
    } finally {
      clearInterval(timer);
    }
    // every address failing "no cable" is not a car full of silent modules
    if (p.noCable) {
      await p.leaveModule();
      throw new Error('No adapter connected');
    }
    const lines = (p.view && p.view.lines) || [];
    const report = (p.view && p.view.report) || D.report(p.wireReads, lines);
    await p.leaveModule();
    return { report, lines: lines.slice(), cancelled };
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      if (program && typeof program.cancel === 'function') program.cancel();
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ECU_TREE_SCAN_TICK_MS,
    ecuTreeHeadlessUi,
    ecuTreeScanStart,
  };
}
