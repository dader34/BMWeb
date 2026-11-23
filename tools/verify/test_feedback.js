#!/usr/bin/env node
// The feedback prompt (core/feedback.js): when it asks, what it sends, and
// that it stops asking.
//
// What would be silently wrong in the field, and is held here:
//   * a prompt that keeps coming back (after an answer, or more than twice
//     to someone who never answers), or that comes up in an offline copy,
//     over a running flash, over another dialog, or with reports turned off;
//   * a report that carries more than an opinion needs (the session journal,
//     the wire trace) or a VIN typed into the text;
//   * an answer lost because the network was down when Send was pressed.
//
//   node tools/verify/test_feedback.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = path.join(__dirname, '..', '..', 'app', 'renderer');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// ---- a page, as much of one as the prompt touches ---------------------------
// An element whose innerHTML is text: '#id' and '.class' find one stand-in
// each (the same one every time, so a handler set on it can be fired from
// here), '[data-x]' one per data-x="..." in the markup.
const element = () => {
  let html = '';
  let found = new Map();
  const stand = (extra) => ({
    onclick: null,
    oninput: null,
    onmouseenter: null,
    onmouseleave: null,
    disabled: false,
    textContent: '',
    value: '',
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    focus() {},
    ...extra,
  });
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(v) {
      html = String(v);
      found = new Map();
    },
    querySelector(sel) {
      const has =
        sel[0] === '#'
          ? html.includes(`id="${sel.slice(1)}"`)
          : new RegExp(`class="[^"]*\\b${sel.slice(1)}\\b`).test(html);
      if (!has) return null;
      if (!found.has(sel)) found.set(sel, stand());
      return found.get(sel);
    },
    querySelectorAll(sel) {
      const name = /^\[data-([a-z]+)\]$/.exec(sel)[1];
      if (!found.has(sel))
        found.set(
          sel,
          [...html.matchAll(new RegExp(`data-${name}="([^"]*)"`, 'g'))].map(
            (m) => stand({ dataset: { [name]: m[1] } })
          )
        );
      return found.get(sel);
    },
  };
};

/** The prompt loaded into a page of its own, with a clock the test moves. */
function page(opts = {}) {
  const settings = { ...(opts.settings || {}) };
  const posted = [];
  const timers = [];
  const dialogs = [];
  const ctx = {
    console,
    URLSearchParams,
    APP_NAME: 'BMWeb',
    DEFAULT_THEME: 'instrument',
    BMWEB_VERSION: '1.3.0-test',
    esc: (s) => String(s),
    scrubVin: (t) =>
      String(t).replace(
        /\b([A-HJ-NPR-Z0-9]{10})([A-HJ-NPR-Z0-9]{7})\b/g,
        (m, head) => `${head}XXXXXXX`
      ),
    flashing: !!opts.flashing,
    location: { search: opts.search || '', hash: '#apps/tuning' },
    navigator: { userAgent: 'test-agent', platform: 'test' },
    Settings: {
      get: (k, d) => (k in settings ? settings[k] : d),
      set: (k, v) => {
        settings[k] = v;
      },
    },
    Journal: {
      endpoint: () =>
        opts.endpoint === undefined ? 'https://c/report' : opts.endpoint,
      testerId: () => 'ab12cd34',
      log: () => {},
      send: async (report) => {
        posted.push(report);
        return opts.network === false
          ? { sent: false, why: 'network error' }
          : { sent: true };
      },
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    document: {
      querySelector: (sel) =>
        sel === '.modal-overlay' && opts.otherDialog ? {} : null,
    },
    openModal: (html, o) => {
      const box = element();
      const d = { box, closed: false };
      d.close = () => {
        d.closed = true;
        if (o && o.onClose) o.onClose();
      };
      dialogs.push(d);
      return { overlay: { querySelector: () => box }, close: d.close };
    },
  };
  ctx.window = {
    BMWEB_OFFLINE: !!opts.offline,
    innerWidth: 1280,
    innerHeight: 800,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(R, 'core/feedback.js'), 'utf8'),
    ctx,
    { filename: 'core/feedback.js' }
  );
  let now = opts.now || Date.UTC(2026, 10, 23);
  ctx.Date = class extends Date {
    static now() {
      return now;
    }
  };
  return {
    ctx,
    settings,
    posted,
    dialogs,
    advance: (ms) => (now += ms),
    /** A visit to the Tuning page, and the moment the prompt waits. */
    visit: (stillThere) => {
      ctx.feedbackMaybeAsk('tuning', stillThere);
      while (timers.length) timers.shift().fn();
    },
    last: () => dialogs[dialogs.length - 1],
  };
}
const DAY = 86400e3;

(async () => {
  // ---- when it asks ----------------------------------------------------------
  {
    const p = page();
    p.visit();
    assert.strictEqual(p.dialogs.length, 1, 'a first visit is asked');
    assert.ok(/Got a second\?/.test(p.last().box.innerHTML));
    assert.strictEqual(p.settings.feedback.asks, 1);
    // not twice at once, however often the page is shown
    p.visit();
    assert.strictEqual(p.dialogs.length, 1, 'asked again over its own dialog');
    ok('the first visit to Tuning is asked, once');

    // "Not now": nothing for two weeks, then once more, then never
    p.last().box.querySelector('.modal-cancel').onclick();
    assert.ok(p.last().closed);
    p.advance(13 * DAY);
    p.visit();
    assert.strictEqual(p.dialogs.length, 1, 'asked again inside two weeks');
    p.advance(2 * DAY);
    p.visit();
    assert.strictEqual(p.dialogs.length, 2, 'not asked again after two weeks');
    p.last().close(); // Esc, or a click outside: the same as not now
    p.advance(400 * DAY);
    p.visit();
    assert.strictEqual(p.dialogs.length, 2, 'asked a third time');
    assert.strictEqual(p.posted.length, 0, 'something was sent unasked');
    ok('declined: once more after two weeks, then never');
  }
  {
    // the visits that are not the one
    for (const [why, opts] of [
      ['an offline copy', { offline: true }],
      ['beta reports turned off', { settings: { betaReports: false } }],
      ['no collector', { endpoint: '' }],
      ['a flash holding the bus', { flashing: true }],
      ['another dialog open', { otherDialog: true }],
    ]) {
      const p = page(opts);
      p.visit();
      assert.strictEqual(p.dialogs.length, 0, `asked with ${why}`);
      assert.ok(!p.settings.feedback, `${why} counted as an ask`);
    }
    // the user left before the prompt came up
    const gone = page();
    gone.visit(() => false);
    assert.strictEqual(gone.dialogs.length, 0);
    assert.ok(!gone.settings.feedback, 'a visit that ended counted as an ask');
    ok(
      'never offline, with reports off, over a flash or another dialog, or after the user left'
    );
  }

  // ---- what it sends -----------------------------------------------------------
  {
    const p = page();
    p.visit();
    const box = p.last().box;
    box.querySelector('#fbk-go').onclick();
    assert.ok(/Have you used BMWeb before\?/.test(box.innerHTML));
    assert.ok(/How would you rate it\?/.test(box.innerHTML));
    assert.ok(/What would you like added or changed\?/.test(box.innerHTML));
    const send = box.querySelector('#fbk-send');
    assert.strictEqual(
      send.disabled,
      true,
      'Send is offered with nothing answered'
    );

    box
      .querySelectorAll('[data-used]')
      .find((b) => b.dataset.used === 'some')
      .onclick();
    assert.strictEqual(send.disabled, false, 'one answer is enough to send');
    box
      .querySelectorAll('[data-rate]')
      .find((b) => b.dataset.rate === '4')
      .onclick();
    const wants = box.querySelector('#fbk-wants');
    wants.value = '  E39 coding. My car is WBAET37495NJ87379.  ';
    wants.oninput();
    await send.onclick();

    assert.strictEqual(p.posted.length, 1);
    const r = p.posted[0];
    assert.strictEqual(r.kind, 'feedback');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.feedback)), {
      used: 'some',
      rating: 4,
      wants: 'E39 coding. My car is WBAET37495XXXXXXX.',
    });
    assert.strictEqual(r.app, '1.3.0-test');
    assert.strictEqual(r.tester, 'ab12cd34');
    assert.strictEqual(r.where, 'tuning');
    assert.ok(
      /^\[feedback\] 4\/5 · a few times · E39 coding/.test(r.desc),
      r.desc
    );
    // an opinion, not a bug report: none of what one of those carries
    for (const k of ['journal', 'wire', 'wireVerbose', 'crashes', 'cable'])
      assert.ok(!(k in r), `the feedback carries the session's ${k}`);
    assert.ok(!JSON.stringify(r).includes('NJ87379'), 'a VIN went out whole');
    ok(
      'the three answers, the build they are about, a masked VIN, no journal and no wire trace'
    );

    assert.ok(/Thank you/.test(box.innerHTML));
    assert.strictEqual(p.settings.feedback.done, true);
    p.last().close();
    p.advance(400 * DAY);
    p.visit();
    assert.strictEqual(p.dialogs.length, 1, 'asked again after answering');
    ok('answered: thanked, and never asked again');
  }
  {
    // taking an answer back leaves nothing to send
    const p = page({ search: '?feedback=form' });
    p.visit();
    const box = p.last().box;
    assert.ok(
      /Your feedback/.test(box.innerHTML),
      '?feedback=form opens on the form'
    );
    const star = box.querySelectorAll('[data-rate]')[2];
    star.onclick();
    assert.strictEqual(box.querySelector('#fbk-send').disabled, false);
    star.onclick();
    assert.strictEqual(box.querySelector('#fbk-send').disabled, true);
    ok('an answer clicked again is taken back');
  }

  // ---- an answer the network would not take is kept ----------------------------
  {
    const p = page({ network: false });
    p.visit();
    const box = p.last().box;
    box.querySelector('#fbk-go').onclick();
    box.querySelectorAll('[data-rate]')[4].onclick();
    await box.querySelector('#fbk-send').onclick();
    assert.ok(/could not be sent just now/.test(box.innerHTML));
    assert.strictEqual(
      p.settings.feedback.done,
      true,
      'asked again for an answer already given'
    );
    assert.strictEqual(
      p.settings.feedbackPending.feedback.rating,
      5,
      'the answer was dropped'
    );
    p.last().close();

    // the next visit, with the network back: it goes, and is not kept twice
    const later = page({ settings: p.settings });
    later.visit();
    await new Promise((res) => setImmediate(res));
    assert.strictEqual(
      later.dialogs.length,
      0,
      'asked again on the visit that resends'
    );
    assert.strictEqual(later.posted.length, 1);
    assert.strictEqual(later.posted[0].feedback.rating, 5);
    assert.strictEqual(later.settings.feedbackPending, null);
    ok('an answer that could not be sent is kept, and goes on a later visit');
  }

  // ---- the pure parts, at their edges --------------------------------------------
  {
    const F = page().ctx;
    const A = (a) => JSON.parse(JSON.stringify(F.feedbackAnswers(a)));
    assert.deepStrictEqual(A({ used: 'always', rating: 6, wants: null }), {
      used: null,
      rating: null,
      wants: '',
    });
    for (const bad of [0, -1, 3.5, 'five', NaN])
      assert.strictEqual(A({ rating: bad }).rating, null);
    assert.strictEqual(A({ rating: '4' }).rating, 4);
    assert.strictEqual(A({ wants: 'x'.repeat(5000) }).wants.length, 2000);
    // a history that is not one reads as never asked
    for (const junk of [
      null,
      'yes',
      7,
      [],
      { asks: -3, last: 'x', done: 'true' },
    ])
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(F.feedbackState(junk))),
        {
          asks: 0,
          last: 0,
          done: false,
        }
      );
    ok(
      'an answer that is not one is no answer; a broken history is no history'
    );
  }

  console.log(`test_feedback: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
