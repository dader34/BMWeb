/**
 * @file The UI adapter: maps the program's state onto the app's grammar --
 * the F-key bar, a title, the painted grid (INPA mode) or per-LINE rows
 * (modern), the app's own dialogs for INPA's prompts, and the status line.
 */

/**
 * The Back action for a menu without its own F10 (kind 'back' answers Esc).
 * @param {() => void} fn - what Back does
 * @returns {object} an action-bar entry
 */
/**
 * The caption over the key bar: the running script's menu title
 * (setmenutitle), the way INPA shows it; empty restores "Select menu".
 * @param {string} title
 * @returns {void}
 */
function ipoSetKeysCaption(title) {
  if (typeof document === 'undefined') return;
  const st = document.documentElement.style;
  if (title && title.trim())
    st.setProperty('--fkeys-caption', JSON.stringify(title));
  else st.removeProperty('--fkeys-caption');
}

function ipoBackAction(fn) {
  return { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn };
}

/**
 * Build the UI adapter for a module's container.
 * @param {object} ecu - the module (sgbd, label, chassis)
 * @param {HTMLElement} container - where the view is drawn
 * @param {() => void} back - leave the module view
 * @returns {IpoUi}
 */
function ipoMakeUi(ecu, container, back) {
  const inpa = typeof inpaMode === 'function' && inpaMode();
  let gridEl = null,
    statusEl = null,
    machineEl = null;
  /** INPA's progress window while a body has one open (progressDialog) */
  let progress = null;
  /** the viewopen file currently in the DOM (paint keeps it across cycles) */
  let paintedView = null;

  const build = () => {
    container.className = inpa ? 'ipo-view ipo-inpa' : 'ipo-view results-panel';
    container.innerHTML =
      `<div class="ipo-screen"></div>` +
      `<div class="ipo-machine" hidden></div>` +
      `<div class="ipo-status mono"></div>`;
    gridEl = container.querySelector('.ipo-screen');
    machineEl = container.querySelector('.ipo-machine');
    statusEl = container.querySelector('.ipo-status');
  };
  build();

  /**
   * The F-key bar: the script's plain keys, its shifted bank, and the
   * script's own F10 as Back (kind 'back' answers Esc too). Only a menu
   * WITHOUT one gets the app's Esc Back -- adding it beside an F10 spilled
   * it into the first empty slot, and SM46's captionless F3 (read coding
   * data) read "Back".
   * @param {IpoProgram} p - the program
   * @returns {void}
   */
  const renderKeys = (p) => {
    const shown = (it) => !it.hidden || !!it.legendLabel;
    const plain = p.items.filter((it) => !it.shift && shown(it));
    const shifted = p.items.filter((it) => it.shift && shown(it));
    const asAction = (it) => {
      const n = it.shift ? it.nr - IPO_SHIFT_BASE : it.nr;
      return {
        key: n === 20 ? null : String(n % 10),
        keyLabel: it.shift ? `⇧F${it.nr - IPO_SHIFT_BASE}` : `F${it.nr}`,
        label: ipoKeyLabel(p, it),
        kind: it.nr === IPO_BACK_KEY ? 'back' : undefined,
        fn: () => p.press(it.nr),
      };
    };
    const acts = plain.map(asAction);
    if (!plain.some((it) => it.nr === IPO_BACK_KEY)) {
      acts.push(ipoBackAction(() => p.back()));
    }
    const put = () =>
      setActions(acts, shifted.length ? shifted.map(asAction) : undefined);
    if (typeof setActions === 'function') {
      if (typeof keepActivationsDuring === 'function')
        keepActivationsDuring(put);
      else put();
    }
    ipoSetKeysCaption(ipoText(p.title || ''));
    if (machineEl) machineEl.hidden = true;
  };

  /** @type {IpoUi} */
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
      sbLeft.textContent = `${(p.ecu || ecu).sgbd}.prg · ${p.menu || ''} · ${text}`;
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
    pickComponent: (p, step) => ipoPickComponent(p, step),
    // INPA's save-as dialog: the browser's own picker where it has one
    // (Chrome, Edge), else a name for a download
    saveFile: (p, step) => ipoSaveFilePick(p, step),
    writeFile: (p, picked, lines) => ipoSaveFileWrite(picked, lines),
    pickLines: (p, names, multiple, current, hints) =>
      ipoPickLines(names, multiple, current, hints),
    // INPA's printscreen: the module view as a clean sheet (print.js)
    printScreen: (p) => ipoPrintScreen(p, p.ecu || ecu, inpa),
    resolveScriptEcu: (from, script, exec) =>
      ipoResolveScriptEcu(from, script, exec),
    machineTick: (p, step, guards) => ipoMachineTick(machineEl, step, guards),
    // INPA's progress window: a popup with the title, the line the script
    // wrote last (the module it is asking right now) and Cancel, which ends
    // the body between two jobs
    userbox: (p, box) => {
      if (!box) {
        if (progress) progress.close();
        progress = null;
        return;
      }
      const lines = box.lines || [];
      const text = lines.length ? ipoText(lines[lines.length - 1]) : '';
      if (!progress) {
        progress = progressDialog({
          title: esc(ipoText(box.title || '')),
          text,
          onCancel: () => {
            progress = null;
            p.cancel();
          },
        });
      } else {
        progress.update(text);
      }
    },
    renderKeys,
    paint: (p) => {
      if (!gridEl) return;
      ipoSetKeysCaption(ipoText(p.title || ''));
      // viewopen: INPA's viewer window with the file the script wrote. The
      // menu's screen cycle keeps painting behind it; the same file stays
      // in the DOM so the reader's scroll position survives each cycle.
      if (p.view) {
        if (p.view !== paintedView) {
          paintedView = p.view;
          if (p.view.report && typeof ipoProtocolRender === 'function') {
            const drawn = p.view;
            // the whole-car read is finished: show what each fault captured,
            // then offer to keep the report. Deferred until the renderer has
            // built the rows and the bar these attach to.
            Promise.resolve(ipoProtocolRender(gridEl, p)).then(async () => {
              if (p.view !== drawn) return;
              if (typeof garageAttachEnv === 'function')
                await garageAttachEnv(gridEl, drawn.report, {
                  screensFor:
                    typeof garageScreensFor === 'function'
                      ? garageScreensFor
                      : null,
                });
              if (p.view === drawn && typeof garageOfferSave === 'function')
                garageOfferSave(gridEl, drawn, p.ecu);
            });
          } else {
            gridEl.innerHTML = `<pre class="ipo-protocol mono">${esc(
              (p.view.lines || []).join('\n')
            )}</pre>`;
          }
        }
        return;
      }
      paintedView = null;
      if (inpa) ipoPaintGrid(gridEl, p);
      else ipoPaintLines(gridEl, p);
    },
    left: () => {
      ipoSetKeysCaption('');
      ipoProgramLeft();
      if (typeof back === 'function') back();
    },
  };
  return ui;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ipoBackAction, ipoMakeUi };
}
