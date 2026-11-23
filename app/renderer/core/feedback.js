/**
 * @file The feedback prompt. On a visit to the Tuning page the user is asked,
 * once, whether they have a moment; if they do, three questions: whether
 * they have used BMWeb before, what they rate it, and what they would like
 * added or changed. The answers go to the beta collector (core/journal.js,
 * tools/beta/worker.js) as a report of kind 'feedback'.
 *
 * WHAT IS SENT is the answers and what says which build they are about: the
 * app version, the browser, the window size, the skin and the anonymous
 * tester id every report carries. Not the session journal and not the wire
 * trace a bug report holds -- an opinion needs no telegrams -- and nothing
 * about the car.
 *
 * WHEN IT ASKS. Not again once answered. Declined ("Not now", Esc, a click
 * outside), it asks once more, no sooner than FEEDBACK_RETRY_MS later, and
 * then never. Never in an offline copy (no collector to send to), never
 * when beta reports are switched off in Settings, never while a flash holds
 * the bus, and never on top of another dialog: that visit is simply not the
 * one.
 *
 * `?feedback` on the page's address asks regardless of what was answered
 * before (`?feedback=form` and `?feedback=thanks` open on that step), for
 * looking at it; what is sent from there is real.
 */

/* exported feedbackMaybeAsk */

/** The Settings key the prompt's history is kept under ({asks, last, done}). */
const FEEDBACK_KEY = 'feedback';
/** The Settings key an answer that could not be sent waits under. */
const FEEDBACK_PENDING_KEY = 'feedbackPending';
/** How many times the prompt is shown to someone who never answers. */
const FEEDBACK_ASK_LIMIT = 2;
/** How long after a declined prompt the next one may come. */
const FEEDBACK_RETRY_MS = 14 * 24 * 60 * 60 * 1000;
/** How long the page is left alone before the prompt comes up. */
const FEEDBACK_DELAY_MS = 1500;
/** The longest "what would you like" kept (the field stops there too). */
const FEEDBACK_TEXT_MAX = 2000;
/** How long the thank-you stays before the dialog closes itself. */
const FEEDBACK_THANKS_MS = 2600;

/**
 * The answers to "have you used BMWeb before?", as stored and as shown.
 * @type {Array<{id: string, label: string}>}
 */
const FEEDBACK_USED = [
  { id: 'first', label: 'First time' },
  { id: 'some', label: 'A few times' },
  { id: 'regular', label: 'Regularly' },
];

/**
 * The prompt's history on this browser.
 * @typedef {Object} FeedbackState
 * @property {number} asks - How many times the prompt has been shown.
 * @property {number} last - When it was last shown (ms since epoch), 0 if never.
 * @property {boolean} done - Whether the questions were answered.
 */

/**
 * What the user answered.
 * @typedef {Object} FeedbackAnswers
 * @property {string|null} used - One of FEEDBACK_USED's ids, or null.
 * @property {number|null} rating - 1 to 5, or null.
 * @property {string} wants - What they would like added or changed.
 */

/**
 * A stored history made whole: anything missing or malformed reads as "never
 * asked".
 * @param {any} raw - What Settings holds.
 * @returns {FeedbackState}
 */
function feedbackState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    asks: Number.isFinite(s.asks) && s.asks > 0 ? Math.floor(s.asks) : 0,
    last: Number.isFinite(s.last) && s.last > 0 ? s.last : 0,
    done: s.done === true,
  };
}

/**
 * Whether the prompt may come up now.
 * @param {FeedbackState} state - The history.
 * @param {number} now - The time (ms since epoch).
 * @param {{offline: boolean, reports: boolean, endpoint: boolean, busy: boolean}} env -
 *   An offline copy; beta reports on; a collector to send to; a flash holding the bus.
 * @returns {boolean}
 */
function feedbackDue(state, now, env) {
  if (env.offline || !env.reports || !env.endpoint || env.busy) return false;
  if (state.done || state.asks >= FEEDBACK_ASK_LIMIT) return false;
  return state.asks === 0 || now - state.last >= FEEDBACK_RETRY_MS;
}

/**
 * The answers as given, made safe to keep: an unknown choice or an
 * out-of-range rating is no answer, the text is trimmed, VINs in it masked,
 * and cut at FEEDBACK_TEXT_MAX.
 * @param {Partial<FeedbackAnswers>} a - What the form holds.
 * @returns {FeedbackAnswers}
 */
function feedbackAnswers(a) {
  const used = FEEDBACK_USED.some((u) => u.id === a.used) ? a.used : null;
  const n = Number(a.rating);
  const rating = Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  const text = String(a.wants == null ? '' : a.wants).trim();
  const wants = (typeof scrubVin === 'function' ? scrubVin(text) : text).slice(
    0,
    FEEDBACK_TEXT_MAX
  );
  return { used, rating, wants };
}

/**
 * Whether there is anything to send: at least one of the three answered.
 * @param {FeedbackAnswers} a
 * @returns {boolean}
 */
function feedbackHasAnswer(a) {
  return a.used != null || a.rating != null || a.wants !== '';
}

/**
 * The report the collector gets. `desc` says it in one line, for a reader
 * going through reports of every kind.
 * @param {Partial<FeedbackAnswers>} given - The form's answers.
 * @param {string} where - The page it was asked on ('tuning').
 * @returns {object}
 */
function feedbackReport(given, where) {
  const a = feedbackAnswers(given);
  const used = FEEDBACK_USED.find((u) => u.id === a.used);
  const has = (name) => typeof globalThis[name] !== 'undefined';
  return {
    v: 1,
    kind: 'feedback',
    app: (has('BMWEB_VERSION') && globalThis.BMWEB_VERSION) || 'dev',
    ts: new Date().toISOString(),
    tester: typeof Journal !== 'undefined' ? Journal.testerId() : 'anon',
    where,
    desc:
      `[feedback] ${a.rating ? `${a.rating}/5` : 'no rating'}` +
      ` · ${used ? used.label.toLowerCase() : 'not said'}` +
      (a.wants ? ` · ${a.wants}` : ''),
    feedback: a,
    route: (typeof location !== 'undefined' && location.hash) || '',
    ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
    platform: (typeof navigator !== 'undefined' && navigator.platform) || '',
    screen:
      typeof window !== 'undefined' && window.innerWidth
        ? { w: window.innerWidth, h: window.innerHeight }
        : null,
    settings: {
      theme:
        typeof Settings !== 'undefined' && typeof DEFAULT_THEME !== 'undefined'
          ? Settings.get('theme', DEFAULT_THEME)
          : null,
      inpa: typeof inpaMode === 'function' ? inpaMode() : null,
    },
  };
}

/** The prompt's timer while it waits for the page to settle. */
let _feedbackTimer = null;
/** Whether the dialog is up. */
let _feedbackOpen = false;

/**
 * The step `?feedback` on the address asks for: 'ask', 'form' or 'thanks';
 * null when the address does not ask.
 * @returns {string|null}
 */
function feedbackForced() {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  if (!q.has('feedback')) return null;
  const v = q.get('feedback');
  return v === 'form' || v === 'thanks' ? v : 'ask';
}

/**
 * Send what an earlier visit could not, quietly; kept until it goes.
 * @returns {Promise<void>}
 */
async function feedbackFlushPending() {
  const waiting = Settings.get(FEEDBACK_PENDING_KEY, null);
  if (!waiting || typeof waiting !== 'object') return;
  const r = await Journal.send(waiting);
  if (r.sent) {
    Settings.set(FEEDBACK_PENDING_KEY, null);
    Journal.log('feedback', 'sent (kept from an earlier visit)');
  }
}

/**
 * A visit to a page that asks for feedback: bring the prompt up after a
 * moment, if it is due and the user is still there with nothing else open.
 * @param {string} where - The page ('tuning').
 * @param {() => boolean} [stillThere] - Whether that page still shows.
 * @returns {void}
 */
function feedbackMaybeAsk(where, stillThere) {
  if (_feedbackOpen || _feedbackTimer) return;
  if (typeof Settings === 'undefined' || typeof Journal === 'undefined') return;
  const env = () => ({
    offline: typeof window !== 'undefined' && !!window.BMWEB_OFFLINE,
    reports: Settings.get('betaReports', true) !== false,
    endpoint: !!Journal.endpoint(),
    busy: typeof flashing !== 'undefined' && !!flashing,
  });
  if (env().endpoint && env().reports) feedbackFlushPending().catch(() => {});
  const forced = feedbackForced();
  const due = () =>
    forced
      ? !env().offline && env().endpoint
      : feedbackDue(
          feedbackState(Settings.get(FEEDBACK_KEY, null)),
          Date.now(),
          env()
        );
  if (!due()) return;
  _feedbackTimer = setTimeout(() => {
    _feedbackTimer = null;
    // asked again, here: a flash may have begun, the user may have left, or
    // something else may be asking a question of its own
    if (!due() || (stillThere && !stillThere())) return;
    if (document.querySelector('.modal-overlay')) return;
    feedbackOpen(where, forced || 'ask');
  }, FEEDBACK_DELAY_MS);
}

/**
 * The dialog: the question, the form, the thanks.
 * @param {string} where - The page it was asked on.
 * @param {string} step - The step to open on ('ask', 'form', 'thanks').
 * @returns {void}
 */
function feedbackOpen(where, step) {
  _feedbackOpen = true;
  const shown = feedbackState(Settings.get(FEEDBACK_KEY, null));
  Settings.set(FEEDBACK_KEY, {
    ...shown,
    asks: shown.asks + 1,
    last: Date.now(),
  });
  Journal.log('feedback', `asked on ${where}`);

  /** @type {Partial<FeedbackAnswers>} */
  const answers = { used: null, rating: null, wants: '' };
  let closeTimer = null;
  const { overlay, close } = openModal(
    '<div class="modal fbk" role="dialog" aria-modal="true" aria-labelledby="fbk-title"></div>',
    {
      onClose: () => {
        _feedbackOpen = false;
        clearTimeout(closeTimer);
      },
    }
  );
  const box = overlay.querySelector('.fbk');

  const ask = () => {
    box.innerHTML = `
      <div class="modal-title" id="fbk-title">Got a second?</div>
      <div class="modal-body">
        Three quick questions about ${esc(APP_NAME)}: whether you have used it
        before, how you would rate it, and what you would like added or
        changed. It takes about half a minute, and it shapes what gets built
        next.
      </div>
      <div class="modal-actions">
        <button class="btn modal-cancel">Not now<span class="modal-key">Esc</span></button>
        <button class="btn primary" id="fbk-go">Share feedback</button>
      </div>`;
    box.querySelector('.modal-cancel').onclick = () => {
      Journal.log('feedback', 'not now');
      close();
    };
    const go = box.querySelector('#fbk-go');
    go.onclick = form;
    go.focus();
  };

  const form = () => {
    box.innerHTML = `
      <div class="modal-title" id="fbk-title">Your feedback</div>
      <div class="fbk-q">
        <div class="fbk-label" id="fbk-used-l">Have you used ${esc(APP_NAME)} before?</div>
        <div class="seg fbk-seg" role="radiogroup" aria-labelledby="fbk-used-l">
          ${FEEDBACK_USED.map(
            (u) =>
              `<button type="button" class="seg-btn" role="radio" aria-checked="false" data-used="${u.id}">${esc(u.label)}</button>`
          ).join('')}
        </div>
      </div>
      <div class="fbk-q">
        <div class="fbk-label" id="fbk-rate-l">How would you rate it?</div>
        <div class="fbk-stars" role="radiogroup" aria-labelledby="fbk-rate-l">
          ${[1, 2, 3, 4, 5]
            .map(
              (n) =>
                `<button type="button" class="fbk-star" role="radio" aria-checked="false" data-rate="${n}" aria-label="${n} of 5">★</button>`
            )
            .join('')}
          <span class="fbk-rate-word" aria-hidden="true"></span>
        </div>
      </div>
      <div class="fbk-q">
        <label class="fbk-label" for="fbk-wants">What would you like added or changed?</label>
        <textarea class="fbk-text" id="fbk-wants" rows="4" maxlength="${FEEDBACK_TEXT_MAX}"
          placeholder="Something you miss, something that got in your way, a car or a module that is not covered…"></textarea>
      </div>
      <div class="fbk-note">
        Sent with the app version, your browser and an anonymous id. Nothing
        about your car.
      </div>
      <div class="modal-actions">
        <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
        <button class="btn primary" id="fbk-send" disabled>Send feedback</button>
      </div>`;
    const send = box.querySelector('#fbk-send');
    const wants = box.querySelector('#fbk-wants');
    const word = box.querySelector('.fbk-rate-word');
    const WORDS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];
    const paint = (hover) => {
      box.querySelectorAll('[data-used]').forEach((b) => {
        const on = b.dataset.used === answers.used;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      });
      const lit = hover || answers.rating || 0;
      box.querySelectorAll('[data-rate]').forEach((b) => {
        const n = Number(b.dataset.rate);
        b.classList.toggle('on', n <= lit);
        b.setAttribute('aria-checked', String(n === answers.rating));
      });
      word.textContent = WORDS[lit] || '';
      send.disabled = !feedbackHasAnswer(feedbackAnswers(answers));
    };
    box.querySelectorAll('[data-used]').forEach((b) => {
      b.onclick = () => {
        // a second click on the chosen one takes the answer back
        answers.used = answers.used === b.dataset.used ? null : b.dataset.used;
        paint();
      };
    });
    box.querySelectorAll('[data-rate]').forEach((b) => {
      const n = Number(b.dataset.rate);
      b.onclick = () => {
        answers.rating = answers.rating === n ? null : n;
        paint();
      };
      b.onmouseenter = () => paint(n);
      b.onmouseleave = () => paint();
    });
    wants.oninput = () => {
      answers.wants = wants.value;
      paint();
    };
    box.querySelector('.modal-cancel').onclick = () => {
      Journal.log('feedback', 'cancelled');
      close();
    };
    send.onclick = async () => {
      send.disabled = true;
      send.textContent = 'Sending…';
      const report = feedbackReport(answers, where);
      const r = await Journal.send(report);
      // answered, whatever the network did: it is not asked again, and what
      // could not go now goes on a later visit
      Settings.set(FEEDBACK_KEY, {
        ...feedbackState(Settings.get(FEEDBACK_KEY, null)),
        done: true,
      });
      if (!r.sent) Settings.set(FEEDBACK_PENDING_KEY, report);
      Journal.log('feedback', r.sent ? 'sent' : `kept (${r.why})`);
      thanks(r.sent);
    };
    paint();
  };

  const thanks = (sent) => {
    box.innerHTML = `
      <div class="modal-title" id="fbk-title">Thank you</div>
      <div class="modal-body">
        ${
          sent
            ? 'That goes straight into what gets built next.'
            : 'It could not be sent just now, so it is kept and goes out the next time you open this page.'
        }
      </div>
      <div class="modal-actions">
        <button class="btn primary modal-cancel">Close</button>
      </div>`;
    const done = box.querySelector('.modal-cancel');
    done.onclick = () => close();
    done.focus();
    closeTimer = setTimeout(close, FEEDBACK_THANKS_MS);
  };

  if (step === 'form') form();
  else if (step === 'thanks') thanks(true);
  else ask();
}

if (typeof window !== 'undefined') window.feedbackMaybeAsk = feedbackMaybeAsk;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    feedbackState,
    feedbackDue,
    feedbackAnswers,
    feedbackHasAnswer,
    feedbackReport,
    feedbackMaybeAsk,
    FEEDBACK_ASK_LIMIT,
    FEEDBACK_RETRY_MS,
    FEEDBACK_TEXT_MAX,
    FEEDBACK_USED,
  };
}
