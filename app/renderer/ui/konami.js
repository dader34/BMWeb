// The Konami code (up up down down left right left right B A) breaks the
// screen. Something hits it, a web of cracks spreads slowly with light
// leaking through, it splits in two along the main crack and the halves
// swing out and fall, throwing glass and sparks. Behind it: a warp of stars,
// a shockwave, and the logo inside a rev counter that revs to the limiter
// and settles to idle, with arcs crackling round it. Esc, a click or the
// code again puts the page back.
//
// The halves are two copies of the page, each clipped to its side of the
// crack; the live page is hidden underneath until it is put back, so nothing
// the app holds is touched. Self-contained: its styles are injected here.

(function () {
  const CODE = [
    'ArrowUp',
    'ArrowUp',
    'ArrowDown',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowLeft',
    'ArrowRight',
    'b',
    'a',
  ];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** When the screen splits, ms after the hit; the cracks finish before it. */
  const T_SPLIT = 3900;
  /** The rev counter's full scale, in thousands of rpm. */
  const GAUGE_MAX = 8;
  const GAUGE_R = 150;
  const B_PATH =
    'M88 0 H400 C470 0 520 40 516 100 C512 160 480 196 432 214 C488 236 512 290 500 352 C486 440 420 490 320 490 H0 Z';
  const BOLT_PATH = 'M318 26 L128 262 L230 262 L176 452 L384 210 L282 210 Z';

  let pos = 0;
  /** The running egg, or null. */
  let egg = null;

  const CSS = `
.kn-stage { position: fixed; inset: 0; z-index: 2147483000; overflow: hidden; cursor: pointer; perspective: 1400px; }
.kn-behind {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, #18202b 0%, #06080b 72%);
  color: #eef2f5; font-family: Inter, system-ui, sans-serif; text-align: center; overflow: hidden; isolation: isolate;
}
.kn-bg { position: absolute; inset: 0; width: 100%; height: 100%; }
.kn-ring {
  position: absolute; left: 50%; top: 50%; width: 60px; height: 60px; margin: -30px 0 0 -30px;
  border-radius: 50%; border: 3px solid #ffb24a; box-shadow: 0 0 30px #ff9e2c, inset 0 0 30px #ff9e2c; opacity: 0;
}
.kn-go .kn-ring { animation: kn-wave .9s cubic-bezier(.1,.6,.3,1) forwards; }
.kn-go .kn-ring.two { animation-delay: .18s; }
.kn-center { position: relative; width: 340px; height: 340px; z-index: 1; opacity: 0; }
.kn-go .kn-center { animation: kn-slam .9s cubic-bezier(.2,1.6,.4,1) .15s forwards; }
.kn-gauge { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.kn-gauge .track { fill: none; stroke: rgba(255,255,255,.08); stroke-width: 10; stroke-linecap: round; }
.kn-gauge .red { fill: none; stroke: #e5484d; stroke-width: 10; opacity: .55; }
.kn-gauge .fill { fill: none; stroke: url(#kn-grad); stroke-width: 10; stroke-linecap: round; filter: drop-shadow(0 0 8px rgba(255,158,44,.8)); }
.kn-gauge .tick { stroke: rgba(255,255,255,.35); stroke-width: 1.5; }
.kn-gauge .tick.major { stroke: rgba(255,255,255,.75); stroke-width: 2.5; }
.kn-gauge text { fill: #9aa6b2; font: 600 15px ui-monospace, Menlo, monospace; text-anchor: middle; dominant-baseline: middle; }
.kn-gauge .dot { fill: #fff; filter: drop-shadow(0 0 6px #ffb24a) drop-shadow(0 0 12px #ff9e2c); }
.kn-limit .kn-gauge .red { opacity: 1; filter: drop-shadow(0 0 10px #e5484d); }
.kn-limit .kn-gauge, .kn-limit .kn-rpm b { animation: kn-buzz .05s linear infinite; }
.kn-logo { position: absolute; left: 50%; top: 50%; width: 132px; height: 132px; margin: -66px 0 0 -66px; filter: drop-shadow(0 0 26px rgba(255,158,44,.6)); }
.kn-go .kn-logo { animation: kn-float 4s ease-in-out 1.2s infinite; }
.kn-logo .bolt { stroke: #fff; stroke-width: 14; stroke-dasharray: 1; stroke-dashoffset: 1; fill: transparent; }
.kn-go .kn-logo .bolt { animation: kn-draw .7s ease-in .55s forwards, kn-boltfill .3s steps(2) 1.2s forwards, kn-flicker 3.4s steps(1) 2s infinite; }
.kn-rpm { margin-top: 4px; font: 600 13px ui-monospace, Menlo, monospace; color: #9aa6b2; letter-spacing: .14em; opacity: 0; z-index: 1; }
.kn-rpm b { color: #fff; font-size: 22px; letter-spacing: 0; display: inline-block; min-width: 4.2ch; text-align: right; }
.kn-go .kn-rpm { animation: kn-fade .4s ease .6s forwards; }
.kn-limit .kn-rpm b { color: #ff6b6b; text-shadow: 0 0 12px #e5484d; }
.kn-title { margin: 18px 0 6px; font-size: 40px; font-weight: 800; letter-spacing: -.02em; z-index: 1; white-space: pre; }
.kn-title span { display: inline-block; opacity: 0; transform: translateY(-40px) scale(1.6); filter: blur(8px); }
.kn-go .kn-title span { animation: kn-drop .55s cubic-bezier(.2,1.4,.4,1) forwards; animation-delay: calc(1.1s + var(--i) * 45ms); }
.kn-sub { margin: 0; color: #9aa6b2; font-size: 15px; opacity: 0; z-index: 1; }
.kn-go .kn-sub { animation: kn-fade .6s ease 2s forwards; }
.kn-code { display: flex; gap: 6px; margin-top: 18px; z-index: 1; }
.kn-code span {
  width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid #2a333d; border-radius: 6px;
  font: 600 13px ui-monospace, Menlo, monospace; color: #3d4752; background: rgba(255,255,255,.02);
}
.kn-go .kn-code span { animation: kn-key .5s ease forwards; animation-delay: calc(2.3s + var(--i) * 110ms); }
.kn-hint { margin-top: 22px; font-size: 12.5px; color: #5d6b78; opacity: 0; z-index: 1; }
.kn-go .kn-hint { animation: kn-fade .8s ease 3.6s forwards; }
.kn-half { position: absolute; inset: 0; overflow: hidden; pointer-events: none; will-change: transform; backface-visibility: hidden; }
.kn-half > .kn-page { position: absolute; inset: 0; }
.kn-half::after { content: ''; position: absolute; inset: 0; background: #000; opacity: var(--shade, 0); }
.kn-cracks { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.kn-cracks path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.kn-fx { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
@keyframes kn-wave { 0% { opacity: 1; transform: scale(.2); } 100% { opacity: 0; transform: scale(30); } }
@keyframes kn-slam { 0% { opacity: 0; transform: scale(.15) rotate(-25deg); filter: blur(10px); } 60% { opacity: 1; filter: blur(0); } 100% { opacity: 1; transform: scale(1) rotate(0); } }
@keyframes kn-float { 50% { transform: translateY(-6px); } }
@keyframes kn-draw { to { stroke-dashoffset: 0; } }
@keyframes kn-boltfill { to { fill: #eef2f5; stroke-width: 0; } }
@keyframes kn-flicker { 0%, 100% { opacity: 1; } 46% { opacity: .3; } 48% { opacity: 1; } 50% { opacity: .5; } 52% { opacity: 1; } }
@keyframes kn-fade { to { opacity: 1; } }
@keyframes kn-drop { to { opacity: 1; transform: none; filter: none; } }
@keyframes kn-key {
  0% { color: #3d4752; } 35% { color: #1a1206; background: #ffb24a; border-color: #ffb24a; box-shadow: 0 0 18px #ff9e2c; transform: translateY(-3px); }
  100% { color: #ff9e2c; border-color: rgba(255,158,44,.45); background: rgba(255,158,44,.08); }
}
@keyframes kn-buzz { 0% { transform: translate(.6px, -.4px); } 50% { transform: translate(-.6px, .5px); } 100% { transform: translate(.4px, .6px); } }`;

  function injectStyles() {
    if (document.getElementById('kn-style')) return;
    const style = document.createElement('style');
    style.id = 'kn-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
  const easeIn = (x) => Math.pow(clamp01(x), 2.2);

  // ---- sound: everything synthesised, nothing fetched ----------------------

  function makeAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
      const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return { ctx, master, noise, engine: null };
    } catch (_) {
      return null;
    }
  }

  /** A burst of filtered noise: a click, a crack or a crash. */
  function noiseHit(
    a,
    { at = 0, len = 0.2, gain = 0.5, hp = 800, lp = 12000 }
  ) {
    if (!a) return;
    const t = a.ctx.currentTime + at;
    const src = a.ctx.createBufferSource();
    src.buffer = a.noise;
    const h = a.ctx.createBiquadFilter();
    h.type = 'highpass';
    h.frequency.value = hp;
    const l = a.ctx.createBiquadFilter();
    l.type = 'lowpass';
    l.frequency.value = lp;
    const g = a.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(h).connect(l).connect(g).connect(a.master);
    src.start(t, Math.random() * 0.5, len + 0.05);
  }

  /** A low thump. */
  function thump(a, at = 0, freq = 70, gain = 0.9) {
    if (!a) return;
    const t = a.ctx.currentTime + at;
    const o = a.ctx.createOscillator();
    o.frequency.setValueAtTime(freq * 1.8, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + 0.4);
    const g = a.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g).connect(a.master);
    o.start(t);
    o.stop(t + 0.55);
  }

  /** The engine: a buzzy saw whose pitch follows the rev counter. */
  function engine(a) {
    if (!a) return null;
    const o1 = a.ctx.createOscillator();
    const o2 = a.ctx.createOscillator();
    o1.type = 'sawtooth';
    o2.type = 'square';
    const lp = a.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = a.ctx.createGain();
    g.gain.value = 0;
    o1.connect(lp);
    o2.connect(lp);
    lp.connect(g).connect(a.master);
    o1.start();
    o2.start();
    return { o1, o2, lp, g };
  }

  function setRevs(a, v, level) {
    if (!a || !a.engine) return;
    const t = a.ctx.currentTime;
    // a six fires three times a revolution
    const f = 30 + ((v * 1000) / 60) * 3 * 0.5;
    a.engine.o1.frequency.setTargetAtTime(f, t, 0.02);
    a.engine.o2.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    a.engine.lp.frequency.setTargetAtTime(500 + v * 260, t, 0.03);
    a.engine.g.gain.setTargetAtTime(level, t, 0.05);
  }

  // ---- the cracks ----------------------------------------------------------

  /**
   * A crack from (x, y) at angle `ang`, wandering, until it leaves the screen
   * or reaches `max` px.
   * @returns {number[][]}
   */
  function radial(x, y, ang, w, h, max, wobble) {
    const pts = [[x, y]];
    let len = 0;
    while (len < max) {
      const a = ang + rand(-wobble, wobble);
      const step = rand(22, 58);
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      len += step;
      pts.push([x, y]);
      if (x < -30 || x > w + 30 || y < -30 || y > h + 30) break;
    }
    return pts;
  }

  /** The point `dist` px along a polyline, or null past its end. */
  function along(pts, dist) {
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      if (dist <= seg)
        return [x0 + ((x1 - x0) * dist) / seg, y0 + ((y1 - y0) * dist) / seg];
      dist -= seg;
    }
    return null;
  }

  function jagged(a, b, n, amp) {
    const pts = [a];
    const nx = -(b[1] - a[1]);
    const ny = b[0] - a[0];
    const nl = Math.hypot(nx, ny) || 1;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const o = rand(-amp, amp);
      pts.push([
        a[0] + (b[0] - a[0]) * t + (nx / nl) * o,
        a[1] + (b[1] - a[1]) * t + (ny / nl) * o,
      ]);
    }
    pts.push(b);
    return pts;
  }

  const pathOf = (pts) =>
    pts
      .map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1))
      .join(' ');

  /**
   * The whole web from the point of impact: two main cracks to the top and
   * bottom edges (the split), radials between, rings joining them, branches.
   * Each line carries when it starts and how fast it draws.
   */
  function web(ix, iy, w, h) {
    const lines = [];
    const diag = Math.hypot(w, h);
    // the split: straight-ish up and down, so the halves' outlines never cross
    const up = radial(ix, iy, -Math.PI / 2, w, h, diag, 0.32).filter(
      (p, i, a) => i === 0 || p[1] < a[i - 1][1] + 1
    );
    const down = radial(ix, iy, Math.PI / 2, w, h, diag, 0.32).filter(
      (p, i, a) => i === 0 || p[1] > a[i - 1][1] - 1
    );
    while (up[up.length - 1][1] > -10) {
      const p = up[up.length - 1];
      up.push([p[0] + rand(-20, 20), p[1] - 50]);
    }
    while (down[down.length - 1][1] < h + 10) {
      const p = down[down.length - 1];
      down.push([p[0] + rand(-20, 20), p[1] + 50]);
    }
    const rads = [
      { ang: -Math.PI / 2, pts: up, main: true },
      { ang: Math.PI / 2, pts: down, main: true },
    ];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const ang =
        -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / (n + 2) + rand(-0.15, 0.15);
      const max = Math.random() < 0.7 ? diag : rand(140, 420);
      rads.push({
        ang,
        pts: radial(ix, iy, ang, w, h, max, 0.22),
        main: false,
      });
    }
    const norm = (a) => (a + 4 * Math.PI) % (2 * Math.PI);
    rads.sort((a, b) => norm(a.ang) - norm(b.ang));
    rads.forEach((r, i) => {
      lines.push({
        pts: r.pts,
        width: r.main ? 2.8 : 1.9,
        start: r.main ? 120 : 260 + i * 110 + rand(0, 160),
        speed: r.main ? 0.42 : 0.55,
      });
    });
    // rings: segments between neighbouring radials, inner first
    [55, 120, 210, 320].forEach((rad, k) => {
      for (let i = 0; i < rads.length; i++) {
        if (Math.random() > 0.72 - k * 0.1) continue;
        const a = along(rads[i].pts, rad + rand(-12, 12));
        const b = along(rads[(i + 1) % rads.length].pts, rad + rand(-12, 12));
        if (!a || !b) continue;
        lines.push({
          pts: jagged(a, b, 3, 7),
          width: 1.2,
          start: 900 + k * 520 + rand(0, 380),
          speed: 0.3,
        });
      }
    });
    // branches off the radials
    rads.forEach((r) => {
      for (let k = 0; k < 2; k++) {
        if (Math.random() < 0.35) continue;
        const d = rand(80, 520);
        const p = along(r.pts, d);
        if (!p) continue;
        const ang = r.ang + (Math.random() < 0.5 ? -1 : 1) * rand(0.45, 0.9);
        lines.push({
          pts: radial(p[0], p[1], ang, w, h, rand(50, 170), 0.3),
          width: 1,
          start: 700 + d * 2.6 + rand(0, 300),
          speed: 0.35,
        });
      }
    });
    // the dent: tiny cracks round the point of impact, there at once
    for (let i = 0; i < 18; i++) {
      const ang = rand(0, Math.PI * 2);
      lines.push({
        pts: radial(ix, iy, ang, w, h, rand(8, 26), 0.4),
        width: 0.9,
        start: 0,
        speed: 0.6,
      });
    }
    return { lines, split: [...up.slice().reverse(), ...down.slice(1)] };
  }

  // ---- the page copies -----------------------------------------------------

  /**
   * A copy of the page with nothing live in it: ids and scripts removed,
   * canvases redrawn, form values and scroll positions carried over.
   * @returns {HTMLDivElement}
   */
  function pageCopy(children) {
    const page = document.createElement('div');
    page.className = 'kn-page';
    page.setAttribute('aria-hidden', 'true');
    for (const el of children) {
      const copy = el.cloneNode(true);
      page.appendChild(copy);
      const a = [el, ...el.querySelectorAll('*')];
      const b = [copy, ...copy.querySelectorAll('*')];
      for (let i = 0; i < a.length && i < b.length; i++) {
        const o = a[i];
        const c = b[i];
        if (o.tagName === 'CANVAS') {
          try {
            c.getContext('2d').drawImage(o, 0, 0);
          } catch (_) {
            /* a WebGL or tainted canvas stays blank */
          }
        } else if (
          o.tagName === 'INPUT' ||
          o.tagName === 'TEXTAREA' ||
          o.tagName === 'SELECT'
        ) {
          c.value = o.value;
        }
        if (o.scrollTop || o.scrollLeft)
          c.dataset.knScroll = o.scrollTop + ',' + o.scrollLeft;
      }
    }
    page.querySelectorAll('script').forEach((s) => s.remove());
    page.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
    return page;
  }

  function restoreScroll(page) {
    page.querySelectorAll('[data-kn-scroll]').forEach((e) => {
      const [t, l] = e.dataset.knScroll.split(',').map(Number);
      e.scrollTop = t;
      e.scrollLeft = l;
    });
  }

  // ---- what is behind ------------------------------------------------------

  function gaugePoint(v, r) {
    const a = ((135 + (v / GAUGE_MAX) * 270) * Math.PI) / 180;
    return [Math.cos(a) * r, Math.sin(a) * r];
  }

  function gaugeSvg() {
    const p0 = gaugePoint(0, GAUGE_R);
    const p1 = gaugePoint(GAUGE_MAX, GAUGE_R);
    const arc = `M${p0[0]} ${p0[1]} A${GAUGE_R} ${GAUGE_R} 0 1 1 ${p1[0]} ${p1[1]}`;
    const r0 = gaugePoint(6.5, GAUGE_R);
    let ticks = '';
    for (let i = 0; i <= GAUGE_MAX * 2; i++) {
      const v = i / 2;
      const major = i % 2 === 0;
      const a = gaugePoint(v, GAUGE_R - 14);
      const b = gaugePoint(v, GAUGE_R - (major ? 30 : 22));
      ticks += `<line class="tick${major ? ' major' : ''}" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
      if (major) {
        const t = gaugePoint(v, GAUGE_R - 46);
        ticks += `<text x="${t[0]}" y="${t[1]}">${v}</text>`;
      }
    }
    return (
      `<svg class="kn-gauge" viewBox="-170 -170 340 340" aria-hidden="true">` +
      `<defs><linearGradient id="kn-grad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ffcf7a"/><stop offset=".7" stop-color="#ff9e2c"/><stop offset="1" stop-color="#e5484d"/></linearGradient></defs>` +
      `<path class="track" d="${arc}"/>` +
      `<path class="red" d="M${r0[0]} ${r0[1]} A${GAUGE_R} ${GAUGE_R} 0 0 1 ${p1[0]} ${p1[1]}"/>` +
      `<path class="fill" d="${arc}" pathLength="1" stroke-dasharray="0 1"/>` +
      ticks +
      `<circle class="dot" r="7" cx="${p0[0]}" cy="${p0[1]}"/>` +
      `</svg>`
    );
  }

  function behind() {
    const div = document.createElement('div');
    div.className = 'kn-behind';
    const title = 'You broke BMWeb.';
    const keys = ['↑', '↑', '↓', '↓', '←', '→', '←', '→', 'B', 'A'];
    div.innerHTML =
      '<canvas class="kn-bg"></canvas>' +
      '<div class="kn-ring"></div><div class="kn-ring two"></div>' +
      '<div class="kn-center">' +
      gaugeSvg() +
      '<svg class="kn-logo" viewBox="0 0 100 100" aria-hidden="true">' +
      '<rect x="1.5" y="1.5" width="97" height="97" rx="21" fill="#11161c" stroke="#9aa6b2" stroke-width="3"/>' +
      `<g transform="translate(17 18.5) scale(0.126)"><path fill="#ff9e2c" d="${B_PATH}"/><path class="bolt" pathLength="1" d="${BOLT_PATH}"/></g>` +
      '</svg></div>' +
      '<div class="kn-rpm"><b>0</b> RPM</div>' +
      '<h2 class="kn-title">' +
      [...title].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('') +
      '</h2>' +
      '<p class="kn-sub">Nothing on the car was touched.</p>' +
      '<div class="kn-code">' +
      keys.map((k, i) => `<span style="--i:${i}">${k}</span>`).join('') +
      '</div>' +
      '<div class="kn-hint">Esc or click to put it back together</div>';
    return div;
  }

  /** A jagged bolt between two points, by midpoint displacement. */
  function arcPoints(x1, y1, x2, y2, disp, out) {
    if (disp < 3) {
      out.push([x2, y2]);
      return;
    }
    const mx = (x1 + x2) / 2 + rand(-disp, disp);
    const my = (y1 + y2) / 2 + rand(-disp, disp);
    arcPoints(x1, y1, mx, my, disp / 2, out);
    arcPoints(mx, my, x2, y2, disp / 2, out);
  }

  function fitCanvas(c, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  // ---- the run -------------------------------------------------------------

  function crack() {
    if (egg) return;
    injectStyles();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const reduce = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    const ground =
      [document.body, document.documentElement]
        .map((el) => getComputedStyle(el).backgroundColor)
        .find((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') ||
      '#0d1217';

    const hidden = [...document.body.children].filter(
      (el) => el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE'
    );
    const stage = document.createElement('div');
    stage.className = 'kn-stage';
    const back = behind();
    stage.appendChild(back);
    const bgc = fitCanvas(back.querySelector('.kn-bg'), w, h);

    const ix = w * rand(0.42, 0.58);
    const iy = h * rand(0.36, 0.52);
    const { lines, split } = web(ix, iy, w, h);
    const halves = [
      [[-5, -5], ...split, [-5, h + 5]],
      [[w + 5, -5], ...split, [w + 5, h + 5]],
    ].map((poly) => {
      const half = document.createElement('div');
      half.className = 'kn-half';
      half.style.background = ground;
      half.style.clipPath =
        'polygon(' +
        poly
          .map((p) => p[0].toFixed(1) + 'px ' + p[1].toFixed(1) + 'px')
          .join(',') +
        ')';
      half.style.transformOrigin = `${ix}px ${iy}px`;
      const page = pageCopy(hidden);
      half.appendChild(page);
      stage.appendChild(half);
      return {
        half,
        page,
        x: 0,
        y: 0,
        rz: 0,
        ry: 0,
        vx: 0,
        vy: 0,
        vrz: 0,
        vry: 0,
      };
    });

    // cracks: a blurred orange glow (the light behind leaking through),
    // a dark edge and a bright core, each drawn in as the crack runs
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'kn-cracks');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML =
      '<defs><filter id="kn-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.5"/></filter></defs>';
    const gGlow = document.createElementNS(SVG_NS, 'g');
    gGlow.setAttribute('filter', 'url(#kn-blur)');
    gGlow.style.opacity = '0';
    const gDark = document.createElementNS(SVG_NS, 'g');
    const gCore = document.createElementNS(SVG_NS, 'g');
    svg.append(gGlow, gDark, gCore);
    const strokes = [];
    for (const line of lines) {
      const d = pathOf(line.pts);
      const parts = [
        [gGlow, '#ff9e2c', line.width * 3.2],
        [gDark, 'rgba(0,0,0,.6)', line.width + 2.4],
        [gCore, 'rgba(255,255,255,.92)', line.width],
      ].map(([g, color, width]) => {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', d);
        p.setAttribute('stroke', color);
        p.setAttribute('stroke-width', String(width));
        g.appendChild(p);
        return p;
      });
      const len = parts[2].getTotalLength() || 1;
      parts.forEach((p) => {
        p.style.strokeDasharray = len + ' ' + len;
        p.style.strokeDashoffset = String(len);
      });
      strokes.push({
        parts,
        len,
        start: line.start,
        dur: len / line.speed,
        ticked: false,
      });
    }
    stage.appendChild(svg);

    const fx = document.createElement('canvas');
    fx.className = 'kn-fx';
    stage.appendChild(fx);
    const fxc = fitCanvas(fx, w, h);

    hidden.forEach((el) => {
      el.dataset.knVis = el.style.visibility;
      el.style.visibility = 'hidden';
    });
    document.body.appendChild(stage);
    halves.forEach((x) => restoreScroll(x.page));
    stage.addEventListener('click', close);

    const audio = reduce ? null : makeAudio();
    egg = { stage, hidden, audio, raf: 0 };

    if (reduce) {
      halves.forEach((x) => x.half.remove());
      svg.remove();
      back.classList.add('kn-go');
      return;
    }

    // impact
    thump(audio, 0, 60, 1);
    noiseHit(audio, { len: 0.35, gain: 0.6, hp: 400 });
    noiseHit(audio, { at: 0.02, len: 0.12, gain: 0.4, hp: 3000 });

    const shards = [];
    const sparks = [];
    const stars = [];
    const embers = [];
    const arcs = [];
    let shake = 26;
    let flash = 0.85;
    let broken = false;
    let revealAt = 0;
    let nextArc = 0;
    let nextCreak = 400;
    const t0 = performance.now();
    let last = t0;
    const center = back.querySelector('.kn-center');
    const fill = back.querySelector('.kn-gauge .fill');
    const dot = back.querySelector('.kn-gauge .dot');
    const rpmText = back.querySelector('.kn-rpm b');

    function doSplit() {
      broken = true;
      // the cracks go with the halves
      const [l, r] = halves;
      const lc = svg.cloneNode(true);
      lc.style.clipPath = l.half.style.clipPath;
      svg.style.clipPath = r.half.style.clipPath;
      l.half.appendChild(lc);
      r.half.appendChild(svg);
      l.vx = -rand(380, 480);
      r.vx = rand(380, 480);
      l.vy = -rand(160, 240);
      r.vy = -rand(160, 240);
      l.vrz = -rand(10, 22);
      r.vrz = rand(10, 22);
      l.vry = rand(40, 70);
      r.vry = -rand(40, 70);
      // glass along the split, and sparks
      for (let i = 0; i < 70; i++) {
        const p = split[Math.floor(Math.random() * split.length)];
        const s = rand(5, 26);
        shards.push({
          x: p[0] + rand(-14, 14),
          y: p[1] + rand(-14, 14),
          vx: rand(-260, 260),
          vy: rand(-380, 60),
          r: rand(0, 6.28),
          vr: rand(-9, 9),
          pts: [0, 1, 2].map((k) => [
            Math.cos(k * 2.1 + rand(-0.5, 0.5)) * s,
            Math.sin(k * 2.1 + rand(-0.5, 0.5)) * s,
          ]),
          life: 1,
        });
      }
      for (let i = 0; i < 220; i++) {
        const p = split[Math.floor(Math.random() * split.length)];
        const a = rand(0, 6.28);
        const sp = rand(120, 720);
        sparks.push({
          x: p[0],
          y: p[1],
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 120,
          life: rand(0.5, 1.3),
          max: 1.3,
          hot: Math.random() < 0.4,
        });
      }
      flash = 0.9;
      shake = 34;
      thump(audio, 0, 45, 1);
      noiseHit(audio, { len: 1.2, gain: 0.7, hp: 300 });
      noiseHit(audio, { at: 0.05, len: 0.6, gain: 0.35, hp: 4000 });
      for (let i = 0; i < 6; i++) {
        noiseHit(audio, {
          at: 0.15 + i * rand(0.06, 0.14),
          len: 0.05,
          gain: 0.25,
          hp: 5000,
        });
      }
    }

    function startReveal(now) {
      revealAt = now;
      back.classList.add('kn-go');
      for (let i = 0; i < 260; i++) {
        stars.push({
          a: rand(0, 6.28),
          d: rand(0, Math.max(w, h) * 0.7),
          s: rand(0.3, 1.2),
          z: rand(0.4, 1),
        });
      }
      for (let i = 0; i < 46; i++) {
        embers.push({
          x: rand(0, w),
          y: rand(h * 0.3, h * 1.2),
          v: rand(18, 60),
          s: rand(1, 2.6),
          ph: rand(0, 6.28),
        });
      }
      if (audio) audio.engine = engine(audio);
    }

    /** The rev counter: up to the limiter, bounce on it, settle to idle. */
    function revs(rt) {
      let v;
      let level = 0.07;
      if (rt < 500) {
        v = 0;
        level = 0;
      } else if (rt < 1700) v = GAUGE_MAX * easeIn((rt - 500) / 1200);
      else if (rt < 2700) v = 7.55 + 0.45 * Math.abs(Math.sin(rt / 38));
      else if (rt < 3700) {
        v = 0.85 + 6.9 * (1 - easeOut((rt - 2700) / 1000));
        level = 0.07 - 0.045 * clamp01((rt - 2700) / 1000);
      } else {
        v = 0.85 + 0.04 * Math.sin(rt / 90);
        level = rt < 6000 ? 0.025 * (1 - (rt - 3700) / 2300) : 0;
      }
      back.classList.toggle('kn-limit', rt >= 1700 && rt < 2700);
      fill.setAttribute('stroke-dasharray', `${(v / GAUGE_MAX).toFixed(4)} 1`);
      const pd = gaugePoint(v, GAUGE_R);
      dot.setAttribute('cx', pd[0].toFixed(1));
      dot.setAttribute('cy', pd[1].toFixed(1));
      rpmText.textContent = String(Math.round((v * 1000) / 10) * 10);
      setRevs(audio, v, level);
    }

    /** The background: a warp of stars slowing to a drift, embers, arcs. */
    function drawBack(rt, dt) {
      bgc.clearRect(0, 0, w, h);
      const warp = 1 + 42 * Math.pow(Math.max(0, 1 - rt / 1600), 2);
      const cx = w / 2;
      const cy = h / 2;
      bgc.lineCap = 'round';
      for (const s of stars) {
        const d0 = s.d;
        s.d += s.s * warp * 60 * dt * (0.4 + s.d / 400);
        if (s.d > Math.max(w, h)) {
          s.d = rand(0, 40);
          s.a = rand(0, 6.28);
        }
        const alpha = clamp01(s.d / 300) * s.z;
        bgc.strokeStyle = `rgba(255,${200 + Math.floor(55 * s.z)},${170 + Math.floor(80 * s.z)},${alpha})`;
        bgc.lineWidth = s.z * 1.6;
        bgc.beginPath();
        bgc.moveTo(cx + Math.cos(s.a) * d0, cy + Math.sin(s.a) * d0);
        bgc.lineTo(
          cx + Math.cos(s.a) * (s.d + 0.5),
          cy + Math.sin(s.a) * (s.d + 0.5)
        );
        bgc.stroke();
      }
      for (const e of embers) {
        e.y -= e.v * dt;
        e.ph += dt * 2;
        if (e.y < -10) {
          e.y = h + 10;
          e.x = rand(0, w);
        }
        bgc.fillStyle = `rgba(255,${150 + Math.floor(60 * Math.sin(e.ph))},60,${0.35 + 0.35 * Math.sin(e.ph * 1.7)})`;
        bgc.beginPath();
        bgc.arc(e.x + Math.sin(e.ph) * 8, e.y, e.s, 0, 6.28);
        bgc.fill();
      }
      // arcs: from the logo's edge out past the dial
      const box = center.getBoundingClientRect();
      const ccx = box.left + box.width / 2;
      const ccy = box.top + box.height / 2;
      if (rt > 1300 && rt > nextArc) {
        nextArc = rt + rand(250, 900);
        const n = Math.random() < 0.3 ? 2 : 1;
        for (let i = 0; i < n; i++)
          arcs.push({
            a: rand(0, 6.28),
            r: rand(170, 300),
            life: rand(0.09, 0.2),
          });
        noiseHit(audio, { len: 0.08, gain: 0.08, hp: 2500 });
      }
      for (let i = arcs.length - 1; i >= 0; i--) {
        const arc = arcs[i];
        arc.life -= dt;
        if (arc.life <= 0) {
          arcs.splice(i, 1);
          continue;
        }
        const x1 = ccx + Math.cos(arc.a) * 64;
        const y1 = ccy + Math.sin(arc.a) * 64;
        const a2 = arc.a + rand(-0.3, 0.3);
        const pts = [[x1, y1]];
        arcPoints(
          x1,
          y1,
          ccx + Math.cos(a2) * arc.r,
          ccy + Math.sin(a2) * arc.r,
          46,
          pts
        );
        for (const [width, style, blur] of [
          [6, 'rgba(255,158,44,.35)', 18],
          [1.6, 'rgba(255,248,230,.95)', 10],
        ]) {
          bgc.lineWidth = width;
          bgc.strokeStyle = style;
          bgc.shadowColor = '#ffb24a';
          bgc.shadowBlur = blur;
          bgc.beginPath();
          pts.forEach((p, k) =>
            k ? bgc.lineTo(p[0], p[1]) : bgc.moveTo(p[0], p[1])
          );
          bgc.stroke();
        }
        bgc.shadowBlur = 0;
      }
    }

    /** The foreground: glass, sparks and the flash. */
    function drawFront(dt) {
      fxc.clearRect(0, 0, w, h);
      for (let i = shards.length - 1; i >= 0; i--) {
        const s = shards[i];
        s.vy += 1500 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.r += s.vr * dt;
        s.life -= dt * 0.45;
        if (s.life <= 0 || s.y > h + 60) {
          shards.splice(i, 1);
          continue;
        }
        fxc.save();
        fxc.translate(s.x, s.y);
        fxc.rotate(s.r);
        fxc.globalAlpha = clamp01(s.life * 1.5);
        fxc.beginPath();
        s.pts.forEach((p, k) =>
          k ? fxc.lineTo(p[0], p[1]) : fxc.moveTo(p[0], p[1])
        );
        fxc.closePath();
        fxc.fillStyle = 'rgba(30,38,48,.85)';
        fxc.fill();
        fxc.strokeStyle = 'rgba(255,255,255,.8)';
        fxc.lineWidth = 1;
        fxc.stroke();
        fxc.restore();
      }
      fxc.globalAlpha = 1;
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.vy += 900 * dt;
        s.vx *= Math.pow(0.4, dt);
        const px = s.x;
        const py = s.y;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life -= dt;
        if (s.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        const a = clamp01(s.life / s.max);
        fxc.strokeStyle = s.hot
          ? `rgba(255,250,230,${a})`
          : `rgba(255,${120 + Math.floor(100 * a)},40,${a})`;
        fxc.lineWidth = s.hot ? 2 : 1.4;
        fxc.beginPath();
        fxc.moveTo(px, py);
        fxc.lineTo(s.x, s.y);
        fxc.stroke();
      }
      if (flash > 0.01) {
        flash *= Math.pow(0.004, dt);
        const g = fxc.createRadialGradient(ix, iy, 0, ix, iy, Math.max(w, h));
        g.addColorStop(0, `rgba(255,255,255,${flash})`);
        g.addColorStop(0.4, `rgba(255,200,140,${flash * 0.5})`);
        g.addColorStop(1, 'rgba(255,160,60,0)');
        fxc.fillStyle = g;
        fxc.fillRect(0, 0, w, h);
      }
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now - t0;

      // the stage shakes, settling
      shake *= Math.pow(0.02, dt);
      const sx = rand(-shake, shake);
      const sy = rand(-shake, shake);

      // the cracks run, with creaks and tremors, until it gives
      if (!broken) {
        let done = true;
        for (const s of strokes) {
          const p = clamp01((t - s.start) / s.dur);
          if (p < 1) done = false;
          if (p > 0 && !s.ticked) {
            s.ticked = true;
            if (s.start > 0)
              noiseHit(audio, { len: 0.04, gain: 0.12, hp: 3500 });
          }
          const off = String(s.len * (1 - easeOut(p)));
          s.parts.forEach((x) => (x.style.strokeDashoffset = off));
        }
        gGlow.style.opacity = String(0.25 + 0.75 * clamp01(t / T_SPLIT));
        if (t > nextCreak && t < T_SPLIT - 300) {
          nextCreak = t + rand(450, 900);
          shake = Math.max(shake, rand(4, 9));
          noiseHit(audio, { len: 0.25, gain: 0.18, hp: 900, lp: 3000 });
        }
        if (t > T_SPLIT - 380 && t < T_SPLIT - 300) shake = Math.max(shake, 14);
        svg.style.transform = `translate(${sx}px, ${sy}px)`;
        if (t >= T_SPLIT && (done || t > T_SPLIT + 600)) {
          svg.style.transform = '';
          doSplit();
          startReveal(now);
        }
      }

      // the halves fall
      for (const x of halves) {
        if (broken) {
          x.vy += 1900 * dt;
          x.x += x.vx * dt;
          x.y += x.vy * dt;
          x.rz += x.vrz * dt;
          x.ry += x.vry * dt;
          x.half.style.setProperty(
            '--shade',
            String(clamp01(Math.abs(x.ry) / 120))
          );
          if (x.y > h * 1.6 && x.half.isConnected) x.half.remove();
        }
        if (x.half.isConnected) {
          x.half.style.transform = `translate3d(${x.x + sx}px, ${x.y + sy}px, 0) rotateY(${x.ry}deg) rotateZ(${x.rz}deg)`;
        }
      }

      if (revealAt) {
        const rt = now - revealAt;
        drawBack(rt, dt);
        revs(rt);
      }
      drawFront(dt);

      egg.raf = requestAnimationFrame(frame);
    }
    egg.raf = requestAnimationFrame(frame);
  }

  function close() {
    if (!egg) return;
    cancelAnimationFrame(egg.raf);
    if (egg.audio) egg.audio.ctx.close().catch(() => {});
    egg.stage.remove();
    egg.hidden.forEach((el) => {
      el.style.visibility = el.dataset.knVis || '';
      delete el.dataset.knVis;
    });
    egg = null;
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (egg && e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      const t = e.target;
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === CODE[pos]) pos++;
      // a third up keeps the two before it: the code can still follow
      else if (key === CODE[0]) pos = pos === 2 ? 2 : 1;
      else pos = 0;
      if (pos === CODE.length) {
        pos = 0;
        if (egg) close();
        else crack();
      }
    },
    true
  );
})();
