/* exported istaAblWindow istaAblStepHtml istaAblDocPanes ISTA_ABL_STATE
   ISTA_ABL_DESIG_LABEL */
/* global esc AblEngine AblHalt istaBottomBar */

// The test module's own window: the page a test plan row opens.
//
// The frames settle the layout, and it is not the app's: a teal title bar
// carrying the module's identifier, title and version; a left Procedure
// pane holding one step at a time; a right pane of two document tabs
// (Wiring Diagram, Functional Description); and a fixed bottom row. The
// step player in core/abl/engine.js drives it -- this file is the pane that
// draws what the engine asks for and the promise that resolves when the
// technician answers.
//
// WHY THE DIALOGS ARE PANES AND NOT MODALS. In the tool every one of them
// draws inside the Procedure pane: the message, the numbered selection, the
// setpoint box with its Notice, the Yes/No rows. The right pane and the
// bottom row never move while the left pane changes. A modal would cover
// the wiring diagram the step is telling the technician to read.
//
// CONTINUE IS THE ONLY WAY FORWARD. The bottom row's Continue answers
// whatever the current step is waiting for; Back steps to the step before
// it where the engine can be re-entered there. Neither is wired to the
// engine's own step list, because the engine is a graph walker and the
// graph has loops: what Back rewinds is the window's record of what it
// drew, not a claim that the car can be put back.

/** The state glyphs a plan row can take, in the tool's own words. */
const ISTA_ABL_STATE = {
  none: { cls: 'irst-none', label: 'not called' },
  performed: { cls: 'irst-ok', label: 'performed' },
  canceled: { cls: 'irst-cancel', label: 'canceled' },
  suspected: { cls: 'irst-susp', label: 'suspected' },
};

/**
 * One step, as the Procedure pane draws it.
 *
 * The shapes come straight from the frames: a message is its text with the
 * blank lines kept; a selection is numbered square badges beside their
 * texts; a measurement is the instruction, then the entry box with its
 * unit, then the setpoint question, then the blue Notice, then the Yes/No
 * rows numbered 1 and 2.
 * @param {object|null} shown - what the engine is asking for
 * @param {object} [state] - {value, busy}
 * @returns {string} HTML for the Procedure pane's body
 */
function istaAblStepHtml(shown, state) {
  const st = state || {};
  if (st.busy)
    return (
      `<div class="irabl-busy">` +
      `<div class="irabl-busy-h">Ongoing background process</div>` +
      `<div class="irabl-busy-b">It will take a moment...</div>` +
      `<div class="irabl-busy-bar"><i></i></div></div>`
    );
  if (!shown) return '';
  const para = (t) =>
    String(t || '')
      .split('\n')
      .map((line) =>
        line.trim()
          ? `<div class="irabl-l">${esc(line)}</div>`
          : `<div class="irabl-gap"></div>`
      )
      .join('');

  if (shown.kind === 'message' || shown.kind === 'end')
    return (
      `<div class="irabl-text">${para(shown.text)}` +
      (shown.value ? `<div class="irabl-val">${esc(shown.value)}</div>` : '') +
      `</div>`
    );

  if (shown.kind === 'selection') {
    const rows = (shown.choices || [])
      .map(
        (c, i) =>
          `<div class="irabl-pick" data-pick="${i + 1}">` +
          `<span class="irabl-num">${esc(c.label || String(i + 1))}</span>` +
          `<span class="irabl-pick-t">${esc(c.text)}</span></div>`
      )
      .join('');
    return (
      `<div class="irabl-text">${para(shown.prior)}</div>` +
      `<div class="irabl-picks">${rows}</div>` +
      (shown.past ? `<div class="irabl-text">${para(shown.past)}</div>` : '')
    );
  }

  if (shown.kind === 'question')
    return (
      `<div class="irabl-text">${para(shown.text)}</div>` +
      `<div class="irabl-picks">` +
      `<div class="irabl-pick" data-pick="1">` +
      `<span class="irabl-num">1</span>` +
      `<span class="irabl-pick-t">Yes</span></div>` +
      `<div class="irabl-pick" data-pick="2">` +
      `<span class="irabl-num">2</span>` +
      `<span class="irabl-pick-t">No</span></div></div>`
    );

  if (shown.kind === 'value') {
    // the question text carries the setpoint, the "was it reached" line and
    // -- after a blank line and the word Note -- what the tool draws as the
    // blue Notice box under the entry
    const q = String(shown.question || '');
    const cut = q.search(/\n\s*\n\s*(?:Note|Notice)\b/i);
    const ask = cut >= 0 ? q.slice(0, cut) : q;
    const note = cut >= 0 ? q.slice(cut).replace(/^\s*\n\s*\n/, '') : '';
    const val = st.value == null ? '' : String(st.value);
    return (
      `<div class="irabl-text">${para(shown.instruction)}</div>` +
      `<div class="irabl-entry">` +
      `<input type="text" class="irabl-in" value="${esc(val)}" ` +
      `inputmode="decimal" aria-label="measured value">` +
      `<span class="irabl-unit">${esc(shown.unit || '')}</span></div>` +
      `<div class="irabl-text">${para(ask)}</div>` +
      (note
        ? `<div class="irabl-note"><div class="irabl-note-h">Notice!</div>` +
          `<div class="irabl-note-b">${esc(
            note.replace(/^\s*(?:Note|Notice)\s*:?\s*/i, '')
          )}</div></div>`
        : '') +
      `<div class="irabl-picks">` +
      `<div class="irabl-pick" data-pick="1">` +
      `<span class="irabl-num">1</span>` +
      `<span class="irabl-pick-t">Yes</span></div>` +
      `<div class="irabl-pick" data-pick="2">` +
      `<span class="irabl-num">2</span>` +
      `<span class="irabl-pick-t">No</span></div></div>`
    );
  }

  if (shown.kind === 'halt')
    return `<div class="irabl-text"><div class="irabl-l">${esc(
      shown.text
    )}</div></div>`;
  return '';
}

/** What each kind of component document is called in the split. */
const ISTA_ABL_DESIG_LABEL = {
  location: 'Installation Location',
  connector: 'Connector View',
  pinout: 'Pin Assignment',
};

/**
 * The two right-hand panes a module's documents fill.
 *
 * The module asks for them by name in its first step: a wiring diagram for
 * a component, and the function description of what it is about. Each pane
 * says what it is waiting for rather than drawing an empty box, because a
 * build without that diagram is a fact worth reading.
 * @param {object[]} documents - what the engine collected
 * @returns {Array<{label: string, doc: object|null}>} the two tabs
 */
function istaAblDocPanes(documents) {
  const docs = documents || [];
  const pick = (re) => docs.find((d) => re.test(String(d.info || ''))) || null;
  return [
    { label: 'Wiring Diagram', doc: pick(/Schaltplan|Wiring/i) },
    {
      label: 'Functional Description',
      doc: pick(/Funktionsbeschreibung|Functional/i),
    },
  ];
}

/**
 * Open a recovered test module in its own page.
 *
 * @param {HTMLElement} host - where to draw (the shell's page host)
 * @param {object} ctx - {graph, runner, docs, onDone, onClose}
 *   graph   the recovered module
 *   runner  the engine host: {job, module, native, sleep}
 *   docs    async (doc) => HTML for a document pane, or null
 *   onDone  (verdict) => void, when the module ends
 *   onClose () => void, when the window is closed before it ends
 * @returns {object} {engine, close} for a caller that wants to drive it
 */
function istaAblWindow(host, ctx) {
  const graph = (ctx && ctx.graph) || {};
  /** @type {object|null} what the engine is currently asking for */
  let shown = null;
  /** @type {Function|null} what answering resolves */
  let answer = null;
  /** @type {boolean} true while a job is on the bus */
  let busy = false;
  /** @type {object[]} the steps drawn, for Back */
  const history = [];
  /** @type {number} which document tab is open */
  let tab = 0;
  /** @type {string} the typed measurement, kept across redraws */
  let typed = '';
  /** @type {number|null} the selection the technician clicked */
  let picked = null;
  /** @type {boolean} set once the window is gone */
  let closed = false;
  /**
   * The component a designator click opened, drawn beside its diagram.
   * @type {{key: string, docs: object[], pick: number}|null}
   */
  let split = null;
  /** @type {object|null} the document view's camera on the diagram */
  let lens = null;
  /** @type {string} the verdict, once there is one */
  let verdict = '';

  const engine = new AblEngine(graph, {
    job: async (spec) => {
      busy = true;
      paint();
      try {
        return ctx.runner && typeof ctx.runner.job === 'function'
          ? await ctx.runner.job(spec)
          : null;
      } finally {
        busy = false;
        paint();
      }
    },
    module: ctx.runner && ctx.runner.module,
    native: (ctx.runner && ctx.runner.native) || {},
    sleep: ctx.runner && ctx.runner.sleep,
    ui: {
      message: (m) => ask(m),
      selection: (s) => ask(s),
      question: (q) => ask(q),
      value: (v) => ask(v),
      hide: async () => {
        // the live frame is being redrawn: clear it so the next pass draws
        // into an empty pane rather than over the last numbers
        shown = null;
        paint();
      },
    },
  });

  /**
   * Draw a step and wait for the technician.
   * @param {object} what - the engine's request
   * @returns {Promise<*>} whatever the step's dialog returns
   */
  function ask(what) {
    return new Promise((resolve) => {
      if (closed) {
        resolve(what.kind === 'selection' ? 1 : { quit: true });
        return;
      }
      shown = what;
      picked = null;
      typed = '';
      history.push(what);
      answer = resolve;
      paint();
    });
  }

  /**
   * Answer the current step with whatever its kind returns.
   * @returns {void}
   */
  function advance() {
    if (!shown || !answer) return;
    const done = answer;
    answer = null;
    if (shown.kind === 'selection') {
      // a selection with nothing picked is not answerable: the tool leaves
      // Continue dead until a row is chosen
      if (picked == null) {
        answer = done;
        return;
      }
      done(picked);
      return;
    }
    if (shown.kind === 'question') {
      if (picked == null) {
        answer = done;
        return;
      }
      done({ yes: picked === 1 });
      return;
    }
    if (shown.kind === 'value') {
      if (picked == null) {
        answer = done;
        return;
      }
      done({
        value: typed === '' ? null : Number(typed),
        reached: picked === 1,
      });
      return;
    }
    done({ quit: true });
  }

  /**
   * Step the Procedure pane back to what it drew before.
   *
   * WHAT THIS REWINDS IS THE PANE, NOT THE CAR. The engine walks a graph
   * whose loops are real edges, so there is no earlier state to restore;
   * what Back offers is a re-read of the previous screen, and the step
   * still waiting is re-drawn when the technician comes forward again.
   * @returns {void}
   */
  function back() {
    if (history.length < 2) return;
    const here = history[history.length - 1];
    const prev = history[history.length - 2];
    shown = Object.assign({}, prev, { _replay: true, _next: here });
    paint();
  }

  /** @returns {void} leave the replay and show the waiting step again */
  function forward() {
    if (!shown || !shown._replay) return;
    shown = shown._next;
    paint();
  }

  /** @returns {void} */
  function paint() {
    if (closed || !host.isConnected) return;
    // A DOCUMENT TAKES THE WHOLE WINDOW. Clicking a component on a
    // schematic is a move from "which wire" to "where is it", and the tool
    // answers it with the document view: its own title bar, the diagram on
    // the left and the component's document on the right, the procedure
    // waiting underneath until Close comes back to it.
    if (split) {
      paintDoc();
      return;
    }
    const panes = istaAblDocPanes(engine.documents);
    const tabs = panes
      .map(
        (p, i) =>
          `<div class="irabl-tab${i === tab ? ' on' : ''}" data-tab="${i}">` +
          `${esc(p.label)}</div>`
      )
      .join('');
    const title =
      `${engine.identifier}` +
      (engine.title ? ` - ${engine.title}` : '') +
      (engine.version ? ` - ${engine.version}` : '');
    host.innerHTML =
      `<div class="irablwin">` +
      `<div class="irablwin-title">${esc(title)}` +
      `<span class="irablwin-x" role="button" tabindex="0" ` +
      `aria-label="Close">✕</span></div>` +
      `<div class="irablwin-body">` +
      `<div class="irabl-pane irabl-proc">` +
      `<div class="irabl-tabrow"><div class="irabl-tab on">Procedure</div>` +
      `</div><div class="irabl-proc-b"></div></div>` +
      `<div class="irabl-pane irabl-docs">` +
      `<div class="irabl-tabrow">${tabs}</div>` +
      `<div class="irabl-docs-b"></div></div>` +
      `</div></div>`;

    const body = host.querySelector('.irabl-proc-b');
    body.innerHTML = istaAblStepHtml(
      shown && shown._replay ? shown._next && shown : shown,
      { busy, value: typed }
    );
    // a replayed screen is a re-read, and the tool never lets one be
    // answered: the picks and the box are inert until Continue comes back
    const replay = !!(shown && shown._replay);
    if (replay) body.classList.add('irabl-replay');
    else body.classList.remove('irabl-replay');

    body.querySelectorAll('.irabl-pick').forEach((el) => {
      el.onclick = () => {
        if (replay) return;
        picked = Number(el.dataset.pick);
        body.querySelectorAll('.irabl-pick').forEach((x) => {
          x.classList.remove('on');
        });
        el.classList.add('on');
        bar();
      };
    });
    const input = body.querySelector('.irabl-in');
    if (input) {
      input.oninput = () => {
        typed = input.value;
        bar();
      };
      if (!replay && !busy) input.focus();
    }

    host.querySelector('.irablwin-x').onclick = () => closeWin();
    host.querySelectorAll('.irabl-tab[data-tab]').forEach((el) => {
      el.onclick = () => {
        tab = Number(el.dataset.tab);
        paint();
      };
    });
    drawDoc(panes[tab], panes);
    bar();
  }

  /**
   * Fill the right pane with the open tab's document.
   *
   * With a component tab open the pane splits: the diagram the designator
   * was clicked on stays on the left and the component's own document sits
   * on the right, which is how the tool shows "this wire, and here is where
   * that connector lives".
   * @param {object|null} pane - {label, doc}, or null for the component tab
   * @param {object[]} panes - the module's own two panes
   * @returns {Promise<void>}
   */
  async function drawDoc(pane, panes) {
    const box = host.querySelector('.irabl-docs-b');
    if (!box) return;
    if (!pane || !pane.doc) {
      box.innerHTML =
        `<div class="irgrey-w">The module does not name a ` +
        `${esc((pane && pane.label) || 'document')} for this component.</div>`;
      return;
    }
    box.innerHTML = `<div class="irgrey-w">Loading...</div>`;
    const html =
      ctx.docs && typeof ctx.docs === 'function'
        ? await ctx.docs(pane.doc, pane.label)
        : null;
    if (!box.isConnected) return;
    // No document matched. Say what was asked for and that nothing in
    // this car's set answered it, rather than claiming the build ships
    // none: it ships the tool's own documents, and this request simply
    // did not resolve to one.
    box.innerHTML =
      html ||
      `<div class="irgrey-w">No ${esc(pane.label.toLowerCase())} in ` +
        `this vehicle's set matches what the module asked for ` +
        `(${esc(pane.doc.name || pane.doc.info || 'unnamed')}).</div>`;
    camera(box);
    bindDesig(box, panes);
  }

  /**
   * The document view: the whole window, diagram left, component right.
   *
   * This is not a pane inside the module window, it replaces it. The title
   * bar becomes the document's own, each side carries a single tab naming
   * what it holds, and the bottom row turns into the document's buttons.
   * Close puts the procedure back exactly as it was.
   * @returns {Promise<void>}
   */
  async function paintDoc() {
    const doc = split.docs[split.pick] || null;
    const label = ISTA_ABL_DESIG_LABEL[doc && doc.type] || 'Document';
    const title = (doc && (doc.title || doc.identifier)) || split.key;
    host.innerHTML =
      `<div class="irablwin">` +
      `<div class="irablwin-title">${esc(title)}` +
      `<span class="irablwin-x" role="button" tabindex="0" ` +
      `aria-label="Close">✕</span></div>` +
      `<div class="irablwin-body">` +
      `<div class="irabl-pane irabl-proc">` +
      `<div class="irabl-tabrow"><div class="irabl-tab on">Wiring Diagram` +
      `</div></div><div class="irabl-docl"></div></div>` +
      `<div class="irabl-pane irabl-docs">` +
      `<div class="irabl-tabrow">` +
      split.docs
        .map((d, i) => {
          const kind = ISTA_ABL_DESIG_LABEL[d.type] || d.type;
          // several documents of one kind are told apart by where the part
          // actually sits, which is the picture's own subheading
          const detail = split.docs.length > 1 && d.detail ? d.detail : '';
          return (
            `<div class="irabl-tab${i === split.pick ? ' on' : ''}" ` +
            `data-doc="${i}"${detail ? ` title="${esc(detail)}"` : ''}>` +
            `${esc(kind)}` +
            (detail ? `<span class="irabl-tabd">${esc(detail)}</span>` : '') +
            `</div>`
          );
        })
        .join('') +
      `</div><div class="irabl-docs-b"></div></div>` +
      `</div></div>`;

    host.querySelector('.irablwin-x').onclick = () => closeDoc();
    host.querySelectorAll('.irabl-tab[data-doc]').forEach((el) => {
      el.onclick = () => {
        split.pick = Number(el.dataset.doc);
        paintDoc();
      };
    });

    const left = host.querySelector('.irabl-docl');
    const right = host.querySelector('.irabl-docs-b');
    left.innerHTML = `<div class="irgrey-w">Loading...</div>`;
    right.innerHTML = `<div class="irgrey-w">Loading...</div>`;
    docBar();

    // the diagram the component was clicked on stays put, so the technician
    // keeps the context the click came from
    const panes = istaAblDocPanes(engine.documents);
    const diagram = panes[0];
    const [dhtml, rhtml] = await Promise.all([
      diagram && diagram.doc && ctx.docs
        ? ctx.docs(diagram.doc, diagram.label)
        : null,
      doc && ctx.designatorHtml ? ctx.designatorHtml(doc.id) : null,
    ]);
    if (!host.isConnected || !split) return;
    left.innerHTML =
      dhtml || `<div class="irgrey-w">No wiring diagram is open.</div>`;
    right.innerHTML =
      rhtml ||
      `<div class="irgrey-w">No ${esc(label.toLowerCase())} for ` +
        `${esc(split.key)} in this vehicle's set.</div>`;
    // the row's Zoom buttons drive the DIAGRAM, which is what a technician
    // is zooming into; the right pane keeps its own wheel and drag
    lens = camera(left)[0] || null;
    camera(right);
    // the clicked component is lit in the drawing, the way the tool marks
    // where you are, and the other components stay live so the next click
    // moves on from here
    // BIND FIRST: the anchors only carry their designator once they are
    // bound, so lighting one before that finds nothing to light
    await bindDesig(left, panes);
    markDesignator(left, split.key);
  }

  /**
   * Light the component the technician clicked.
   * @param {HTMLElement} box - the pane holding the drawing
   * @param {string} key - the designator
   * @returns {void}
   */
  function markDesignator(box, key) {
    box.querySelectorAll('a.irabl-desig').forEach((a) => {
      const raw = (a.dataset && a.dataset.desig) || '';
      if (raw && raw === key) a.classList.add('on');
    });
  }

  /** @returns {void} leave the document view for the procedure */
  function closeDoc() {
    split = null;
    paint();
    bar();
  }

  /** @returns {void} the document view's own bottom row */
  function docBar() {
    if (typeof istaBottomBar !== 'function') return;
    istaBottomBar('abl-doc', {
      // by(k) scales the VIEWBOX, so k > 1 zooms OUT; the wiring app's own
      // controls read the same way round
      'zoom-in': () => lens && lens.by(1 / WIRING_ZOOM_STEP),
      'zoom-out': () => lens && lens.by(WIRING_ZOOM_STEP),
      full: () => host.classList.toggle('irabl-full'),
      close: () => closeDoc(),
    });
  }

  /**
   * Give every drawing in the pane the wiring app's camera.
   *
   * A schematic is read by zooming into a corner of it, so the pane gets the
   * same camera the wiring app uses rather than a second one of its own:
   * wheel, pinch, drag and the zoom controls, all by rewriting the viewBox.
   * @param {HTMLElement} box - the right pane's body
   * @returns {void}
   */
  function camera(box) {
    if (typeof fitAndPan !== 'function') return [];
    const made = [];
    box.querySelectorAll('.irabl-svg').forEach((stage) => {
      const svg = stage.querySelector('svg');
      if (!svg) return;
      const bar =
        (stage.parentElement &&
          stage.parentElement.querySelector('.irabl-doct')) ||
        stage;
      made.push(fitAndPan(svg, stage, bar));
    });
    return made;
  }

  /**
   * Make the diagram's component anchors open their documents.
   * @param {HTMLElement} box - the right pane's body
   * @param {object[]} panes - the module's own two panes
   * @returns {Promise<number>|null} how many anchors were bound
   */
  function bindDesig(box, panes) {
    if (!ctx.bindDesignators || !ctx.designatorDocs) return null;
    return ctx.bindDesignators(box, async (key) => {
      const docs = await ctx.designatorDocs(key);
      if (!docs || !docs.length || closed) return;
      split = { key, docs, pick: 0 };
      paint();
    });
  }

  /** @returns {void} the bottom row, in the frames' own order */
  function bar() {
    if (typeof istaBottomBar !== 'function') return;
    const replay = !!(shown && shown._replay);
    const answerable =
      !busy &&
      !replay &&
      !!shown &&
      (shown.kind === 'message' ||
        shown.kind === 'end' ||
        picked != null ||
        (shown.kind === 'value' && picked != null));
    istaBottomBar('abl', {
      back: history.length > 1 && !replay ? () => back() : null,
      full: () => host.classList.toggle('irabl-full'),
      continue: replay ? () => forward() : answerable ? () => advance() : null,
    });
  }

  /** @returns {void} */
  function closeWin() {
    if (closed) return;
    closed = true;
    // a step still waiting must be released, or the engine's promise never
    // settles and the run leaks behind the closed page
    if (answer) {
      const done = answer;
      answer = null;
      done({ quit: true, cancelled: true });
    }
    if (typeof ctx.onClose === 'function') ctx.onClose(verdict);
  }

  paint();
  engine.run().then(
    (v) => {
      verdict = v;
      if (closed) return;
      shown = {
        kind: 'end',
        text:
          `End of test module. Continue in testing schedule.\n\n` +
          `Result: ${v}`,
      };
      answer = null;
      paint();
      if (typeof ctx.onDone === 'function') ctx.onDone(v, engine);
    },
    (e) => {
      if (closed) return;
      // A HALT IS A SCREEN, NOT A CONSOLE LINE. The technician is holding a
      // meter; what they need is the sentence saying which step this build
      // could not run, not a silent stop.
      shown = {
        kind: 'halt',
        text:
          e instanceof AblHalt
            ? e.message
            : `This test module stopped: ${(e && e.message) || String(e)}`,
      };
      answer = null;
      verdict = 'canceled';
      paint();
      if (typeof ctx.onDone === 'function') ctx.onDone('canceled', engine);
    }
  );

  return { engine, close: closeWin };
}

if (typeof window !== 'undefined') {
  window.istaAblWindow = istaAblWindow;
}

if (typeof module !== 'undefined')
  module.exports = {
    istaAblWindow,
    istaAblStepHtml,
    istaAblDocPanes,
    ISTA_ABL_STATE,
  };
