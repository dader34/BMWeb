// BMWeb wiki pages: search, the contents toggle, the phone menu, the app link.
(function () {
  function each(sel, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(sel), fn);
  }
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) {
      return null;
    }
  }

  // The Pages build renames index.html -> app.html (see docs.html), so the
  // app link is written for the local layout and rewritten once ../app.html
  // is confirmed to exist.
  fetch('../app.html', { method: 'HEAD' })
    .then(function (r) {
      if (!r.ok) return;
      each('[data-link="app"]', function (a) {
        a.href = '../app.html';
      });
    })
    .catch(function () {});

  // Contents box: [hide] / [show], remembered across pages.
  var toc = document.getElementById('toc');
  if (toc) {
    var btn = toc.querySelector('.toc-toggle');
    var set = function (hidden) {
      toc.classList.toggle('hidden', hidden);
      btn.textContent = hidden ? '[show]' : '[hide]';
    };
    set(store('wiki-toc-hidden') === '1');
    btn.addEventListener('click', function () {
      var hidden = !toc.classList.contains('hidden');
      set(hidden);
      store('wiki-toc-hidden', hidden ? '1' : '0');
    });
  }

  // Phone menu.
  var side = document.getElementById('side');
  var menu = side && side.querySelector('.menu-btn');
  if (menu)
    menu.addEventListener('click', function () {
      var open = side.classList.toggle('open');
      menu.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

  // Search: every word must appear in the title or text; title hits first.
  var input = document.getElementById('wiki-search');
  var box = document.getElementById('wiki-results');
  if (!input || !box) return;
  var sel = -1;

  function snippet(text, words) {
    var low = text.toLowerCase();
    var at = low.indexOf(words[0]);
    if (at < 0) return text.slice(0, 110) + (text.length > 110 ? '...' : '');
    var start = Math.max(0, at - 40);
    var s = text.slice(start, start + 120);
    return (start ? '...' : '') + s + (start + 120 < text.length ? '...' : '');
  }

  function run() {
    var q = input.value.trim().toLowerCase();
    box.innerHTML = '';
    sel = -1;
    if (!q || !window.WIKI_INDEX) {
      box.classList.remove('open');
      return;
    }
    var words = q.split(/\s+/);
    var hits = [];
    window.WIKI_INDEX.forEach(function (e) {
      var t = e.t.toLowerCase();
      var x = e.x.toLowerCase();
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        if (t.indexOf(words[i]) >= 0) score += 10;
        else if (x.indexOf(words[i]) >= 0) score += 1;
        else return;
      }
      hits.push({ e: e, score: score });
    });
    hits.sort(function (a, b) {
      return b.score - a.score;
    });
    if (!hits.length) {
      var none = document.createElement('div');
      none.className = 'none';
      none.textContent = 'No page matches.';
      box.appendChild(none);
    }
    hits.slice(0, 10).forEach(function (h) {
      var a = document.createElement('a');
      a.href = h.e.u;
      a.setAttribute('role', 'option');
      var b = document.createElement('b');
      b.textContent = h.e.t;
      var s = document.createElement('span');
      s.textContent = snippet(h.e.x, words);
      a.appendChild(b);
      a.appendChild(s);
      box.appendChild(a);
    });
    box.classList.add('open');
  }

  function move(d) {
    var items = box.querySelectorAll('a');
    if (!items.length) return;
    if (items[sel]) items[sel].classList.remove('sel');
    sel = (sel + d + items.length) % items.length;
    items[sel].classList.add('sel');
    items[sel].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      move(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      move(-1);
    } else if (ev.key === 'Enter') {
      var items = box.querySelectorAll('a');
      var pick = items[sel] || items[0];
      if (pick) location.href = pick.href;
    } else if (ev.key === 'Escape') {
      input.value = '';
      run();
    }
  });
  document.addEventListener('click', function (ev) {
    if (!ev.target.closest || !ev.target.closest('.search'))
      box.classList.remove('open');
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === '/' && document.activeElement !== input) {
      ev.preventDefault();
      input.focus();
    }
  });
})();
