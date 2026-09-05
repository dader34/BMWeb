// Beta feedback: a session journal and one-keypress bug reports.
//
// The journal is a bounded ring of what the session DID -- screens opened,
// jobs run and their verdicts, crashes -- and a report is that ring plus the
// wire-trace ring webshim already keeps, the app/browser identity, and the
// tester's one-line description. Reports POST to a small collection worker
// (Settings key 'betaEndpoint') and always offer a .json download, so a dead
// endpoint never loses a report.
//
// VINs are scrubbed from every text field by default: the 17-char pattern
// keeps the world-maker/type half and masks the 7-char serial. Raw wire hex
// is included as captured (it is the evidence), which the dialog says.

const BETA_ENDPOINT_DEFAULT =
  'https://bmweb-beta.danner-baumgartner.workers.dev/report';

function scrubVin(text) {
  return String(text == null ? '' : text).replace(
    /\b([A-HJ-NPR-Z0-9]{10})([A-HJ-NPR-Z0-9]{7})\b/g,
    (m, head) => `${head}XXXXXXX`
  );
}

const Journal = {
  rows: [],
  limit: 500,
  crashes: 0,

  log(kind, text) {
    this.rows.push({ t: Date.now(), k: kind, s: scrubVin(text) });
    if (this.rows.length > this.limit) this.rows.shift();
  },

  testerId() {
    try {
      let id = localStorage.getItem('bmacw.beta.id');
      if (!id) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(4)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        localStorage.setItem('bmacw.beta.id', id);
      }
      return id;
    } catch (e) {
      return 'anon';
    }
  },

  buildReport(desc) {
    const bus = typeof busTrace !== 'undefined' ? busTrace : null;
    const cable =
      typeof document !== 'undefined'
        ? document.getElementById('link-text')
        : null;
    return {
      v: 1,
      app: (typeof BMACW_VERSION !== 'undefined' && BMACW_VERSION) || 'dev',
      ts: new Date().toISOString(),
      tester: this.testerId(),
      desc: scrubVin(desc || ''),
      route: (typeof location !== 'undefined' && location.hash) || '',
      ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
      platform: (typeof navigator !== 'undefined' && navigator.platform) || '',
      screen:
        typeof window !== 'undefined' && window.innerWidth
          ? { w: window.innerWidth, h: window.innerHeight }
          : null,
      settings: {
        theme:
          typeof Settings !== 'undefined'
            ? Settings.get('theme', 'instrument')
            : null,
        demo: typeof demoMode === 'function' ? demoMode() : null,
        inpa: typeof inpaMode === 'function' ? inpaMode() : null,
      },
      cable: cable ? cable.textContent : null,
      crashes: this.crashes,
      journal: this.rows.slice(),
      // the always-on ring of recent telegrams, plus the verbose capture
      // when the tester had busTrace.start() running
      wire: bus ? bus.recent.slice() : [],
      wireVerbose: bus && bus.on ? bus.rows.slice(-200) : undefined,
    };
  },

  download(report) {
    const blob = new Blob([JSON.stringify(report, null, 1)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bmweb-report-${report.ts.replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  },

  endpoint() {
    // an offline build has no collector to talk to: no button, no auto
    // reports, no sends -- the journal itself still runs for the dialog-less
    // file save nothing ever triggers
    if (typeof window !== 'undefined' && window.BMACW_OFFLINE) return '';
    return typeof Settings !== 'undefined'
      ? Settings.get('betaEndpoint', BETA_ENDPOINT_DEFAULT)
      : BETA_ENDPOINT_DEFAULT;
  },

  // WIRE ERRORS FILE THEMSELVES. An IFH-xxxx surfacing to a tester is
  // exactly the moment the wire ring matters, and most testers will not
  // press Report. One auto-report per distinct code per session, five per
  // session at most, silent, and only while beta reporting is on -- a dead
  // cable repeating IFH-0009 on every job must not flood the collector.
  _auto: { seen: new Set(), sent: 0, max: 5 },
  async maybeAutoReport(msg, ctx) {
    const m = /IFH-\d{4}/.exec(String(msg || ''));
    if (!m) return false;
    if (
      typeof Settings !== 'undefined' &&
      Settings.get('betaReports', true) === false
    )
      return false;
    if (!this.endpoint()) return false;
    const code = m[0];
    if (this._auto.seen.has(code) || this._auto.sent >= this._auto.max) {
      return false;
    }
    this._auto.seen.add(code);
    this._auto.sent += 1;
    const report = this.buildReport(
      `[auto] ${code}${ctx ? ` · ${ctx}` : ''} · ${msg}`
    );
    report.auto = 'ifh';
    const r = await this.send(report);
    this.log(
      'auto',
      `${code} auto-report ` + `${r.sent ? 'sent' : `failed (${r.why})`}`
    );
    return r.sent;
  },

  async send(report) {
    const url = this.endpoint();
    if (!url) return { sent: false, why: 'no endpoint configured' };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { sent: false, why: `HTTP ${res.status}` };
      return { sent: true };
    } catch (e) {
      return {
        sent: false,
        why: e.name === 'AbortError' ? 'timeout' : e.message || 'network error',
      };
    }
  },
};

// ---- hooks: the journal writes itself -------------------------------------

function _journalInstall() {
  // navigation: every screen the tester reaches, in order
  window.addEventListener('hashchange', () =>
    Journal.log('nav', location.hash)
  );
  Journal.log('nav', `start ${location.hash || '(root)'}`);

  // crashes: the failures nobody files by hand
  window.addEventListener('error', (e) => {
    Journal.crashes += 1;
    Journal.log(
      'crash',
      `${e.message || 'script error'} ` +
        `(${(e.filename || '').split('/').pop()}:${e.lineno || '?'})`
    );
    _journalBadge();
  });
  window.addEventListener('unhandledrejection', (e) => {
    Journal.crashes += 1;
    Journal.log(
      'crash',
      `unhandled: ` +
        `${(e.reason && e.reason.message) || e.reason || 'rejected'}`
    );
    _journalBadge();
  });

  // jobs: wrap api() so every /run/ logs its verdict without touching a
  // single call site
  if (typeof api === 'function') {
    const inner = window.api;
    window.api = async function journaledApi(path, opts) {
      const run = /\/api\/ecu\/([^/]+)\/run\/([^/?]+)/.exec(path);
      const t0 = Date.now();
      try {
        const d = await inner(path, opts);
        if (run) {
          let status = '';
          try {
            for (const set of d.sets || []) {
              if (set && set.JOB_STATUS != null) {
                status = String(set.JOB_STATUS);
                break;
              }
            }
          } catch (e) {
            /* verdict only */
          }
          Journal.log(
            'job',
            `${run[1]} ${decodeURIComponent(run[2])}` +
              ` · ${status || 'ok'} · ${Date.now() - t0}ms`
          );
        }
        return d;
      } catch (e) {
        if (run) {
          Journal.log(
            'job',
            `${run[1]} ${decodeURIComponent(run[2])}` +
              ` · FAILED ${e.message} · ${Date.now() - t0}ms`
          );
          // not for the "is it there" jobs: a silent INITIALISIERUNG is how
          // a module that is not fitted answers, and the screen already says so
          if (
            !/^(INITIALISIERUNG|IDENTIFIKATION|IDENT)$/i.test(
              decodeURIComponent(run[2])
            )
          ) {
            Journal.maybeAutoReport(
              e.message,
              `${run[1]} ${decodeURIComponent(run[2])}`
            );
          }
        }
        throw e;
      }
    };
  }

  // wire errors from ANY path (jobs, group resolution, entry probes) pass
  // through busTrace.add('err', ...) -- tap it for the auto-reporter
  if (
    typeof busTrace !== 'undefined' &&
    busTrace &&
    typeof busTrace.add === 'function' &&
    !busTrace._journalTapped
  ) {
    busTrace._journalTapped = true;
    const innerAdd = busTrace.add.bind(busTrace);
    busTrace.add = function journaledAdd(tag, bytes, note) {
      // LOG only. Group probes and entry checks send telegrams whose silence
      // is a valid answer (D_0012 tries DS2, then KWP2000, before the BMW-FAST
      // form an MS45 answers), and every one of those IFH-0009s was filing a
      // report -- six in the collector, all noise. A wire error is worth a
      // report when a job the tester ASKED for fails: the api tap above.
      if (tag === 'err' && note) Journal.log('wire', String(note));
      return innerAdd(tag, bytes, note);
    };
  }

  _journalButton();
}

// the topbar Report button (beta builds; Settings.set('betaReports', false)
// hides it)
function _journalButton() {
  if (typeof window !== 'undefined' && window.BMACW_OFFLINE) return;
  if (
    typeof Settings !== 'undefined' &&
    Settings.get('betaReports', true) === false
  )
    return;
  const anchor = document.getElementById('settings-btn');
  if (!anchor || document.getElementById('beta-btn')) return;
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.id = 'beta-btn';
  b.title = 'File a beta report (session log + wire trace)';
  b.innerHTML =
    '<span class="btn-text">Report</span>' +
    '<span class="btn-icon" aria-hidden="true">◉</span>';
  b.onclick = () => showBetaReport();
  anchor.parentNode.insertBefore(b, anchor);
}

function _journalBadge() {
  const b = document.getElementById('beta-btn');
  if (b && !b.classList.contains('beta-attn')) b.classList.add('beta-attn');
}

// ---- the report dialog ------------------------------------------------------

function showBetaReport() {
  const hasEndpoint = !!Journal.endpoint();
  const n = Journal.rows.length;
  const w = typeof busTrace !== 'undefined' ? busTrace.recent.length : 0;
  const { overlay, close } = openModal(`
    <div class="modal" role="dialog" aria-modal="true" style="max-width:560px">
      <div class="modal-title">Beta report</div>
      <div class="modal-body">
        <div style="margin-bottom:10px">What happened, and on which car?</div>
        <textarea id="beta-desc" rows="4"
          style="width:100%;resize:vertical;background:transparent;
                 color:inherit;border:1px solid var(--line);padding:8px;
                 font:inherit"
          placeholder="e.g. E46 · pressed F2 on the DME fault screen, nothing appeared"></textarea>
        <div style="margin-top:12px;font-size:12.5px;color:var(--ink-dim)">
          Included: app + browser version · current screen · ${n} session
          events (screens, jobs, errors) · last ${w} wire telegrams ·
          ${Journal.crashes} captured crash${Journal.crashes === 1 ? '' : 'es'}.
          VINs in text are masked; raw telegram bytes are included as
          captured.
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
        <button class="btn" id="beta-download">Download</button>
        <button class="btn primary" id="beta-send">
          Send report<span class="modal-key">⏎</span></button>
      </div>
    </div>`);
  const desc = overlay.querySelector('#beta-desc');
  desc.focus();
  // save the exact JSON the Send button would POST, as a local file --
  // no collector, no network, just what would go to the endpoint
  overlay.querySelector('#beta-download').onclick = () => {
    Journal.download(Journal.buildReport(desc.value));
    close();
    const b = document.getElementById('beta-btn');
    if (b) b.classList.remove('beta-attn');
    sbLeft.textContent = 'report downloaded';
    Journal.log('report', 'downloaded');
  };
  const finish = async () => {
    const report = Journal.buildReport(desc.value);
    let note;
    if (hasEndpoint) {
      const r = await Journal.send(report);
      if (r.sent) {
        note = 'report sent — thank you';
      } else {
        Journal.download(report);
        note = `upload failed (${r.why}) — report saved as a file instead`;
      }
    } else {
      Journal.download(report);
      note = 'report saved — please send the file along';
    }
    close();
    const b = document.getElementById('beta-btn');
    if (b) b.classList.remove('beta-attn');
    sbLeft.textContent = note;
    Journal.log('report', note);
  };
  overlay.querySelector('.modal-cancel').onclick = () => close();
  overlay.querySelector('#beta-send').onclick = () => finish();
}

if (typeof window !== 'undefined') {
  window.Journal = Journal;
  window.scrubVin = scrubVin;
  window.showBetaReport = showBetaReport;
  // install once the DOM (topbar) exists; scripts load in <head>… tail, so
  // by here the topbar is parsed, but be safe either way
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _journalInstall);
  } else {
    _journalInstall();
  }
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Journal, scrubVin, BETA_ENDPOINT_DEFAULT };
}
