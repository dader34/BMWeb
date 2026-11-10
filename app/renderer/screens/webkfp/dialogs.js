// WebKFP's dialog boxes, drawn the way WinKFP 5.3 draws them: a draggable
// window with a title bar and buttons, and the message box on top of it. The
// coding screens borrow wkfpDraggable. The screen is screens/webkfp/screen.js.

/* exported wkfpDraggable, wkfpDialog, wkfpMessage */

// ---- the window's dialogs ----------------------------------------------------
/**
 * Let a dialog be moved by its title bar, as a Windows dialog is. It moves
 * by a translate, so it starts where the layout centres it, and its title
 * bar stays on screen.
 * @param {HTMLElement} dlg - the dialog (.wkfp-dlg).
 */
function wkfpDraggable(dlg) {
  const bar = dlg.querySelector('.wkfp-dlg-title');
  if (!bar) return;
  bar.classList.add('wkfp-drag');
  let dx = 0;
  let dy = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const x0 = e.clientX - dx;
    const y0 = e.clientY - dy;
    // the layout's own place, without the move so far
    const r = dlg.getBoundingClientRect();
    const left0 = r.left - dx;
    const top0 = r.top - dy;
    const titleH = bar.offsetHeight;
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      // keep the title bar reachable: at least 60px of it in view
      const minX = 60 - r.width - left0;
      const maxX = window.innerWidth - 60 - left0;
      const minY = -top0;
      const maxY = window.innerHeight - titleH - top0;
      dx = Math.min(maxX, Math.max(minX, ev.clientX - x0));
      dy = Math.min(maxY, Math.max(minY, ev.clientY - y0));
      dlg.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
}
/**
 * A WinKFP dialog over the window: a title bar, the body, the buttons.
 * Enter presses the first button, Esc the last (or closes with null).
 * @param {HTMLElement} win - The window it sits over.
 * @param {{title: string, body: HTMLElement|string, buttons: string[],
 *   cls?: string, onOpen?: (el: HTMLElement) => void,
 *   check?: (button: string, el: HTMLElement) => boolean}} o
 * @returns {Promise<string|null>} The button pressed.
 */
function wkfpDialog(win, o) {
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'wkfp-shade';
    const dlg = document.createElement('div');
    dlg.className = 'wkfp-dlg' + (o.cls ? ' ' + o.cls : '');
    dlg.setAttribute('role', 'dialog');
    dlg.innerHTML = `
      <div class="wkfp-dlg-title"><span>${esc(o.title)}</span><button class="wkfp-x" aria-label="Close">&#x2715;</button></div>
      <div class="wkfp-dlg-body"></div>
      <div class="wkfp-dlg-btns">${o.buttons
        .map((b) => `<button class="wkfp-btn">${esc(b)}</button>`)
        .join('')}</div>`;
    const body = dlg.querySelector('.wkfp-dlg-body');
    if (typeof o.body === 'string') body.innerHTML = o.body;
    else body.appendChild(o.body);
    shade.appendChild(dlg);
    win.appendChild(shade);
    wkfpDraggable(dlg);
    const close = (v) => {
      // a window with work in hand may refuse to go (o.canClose)
      if (o.canClose && !o.canClose(v)) return;
      if (v != null && o.check && !o.check(v, dlg)) return;
      shade.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      // only the topmost dialog answers the keyboard
      const shades = document.querySelectorAll('.wkfp-shade');
      if (shades[shades.length - 1] !== shade) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(o.buttons.length > 1 ? o.buttons[o.buttons.length - 1] : null);
      } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        e.stopPropagation();
        close(o.buttons[0]);
      } else if (/^F\d$/.test(e.key)) {
        // the window's F-keys wait while a dialog is open
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    dlg.querySelector('.wkfp-x').onclick = () =>
      close(o.buttons.length > 1 ? o.buttons[o.buttons.length - 1] : null);
    dlg
      .querySelectorAll('.wkfp-dlg-btns .wkfp-btn')
      .forEach((b, i) => (b.onclick = () => close(o.buttons[i])));
    if (o.onOpen) o.onOpen(dlg);
    const first =
      dlg.querySelector('input:not([disabled]), select') ||
      dlg.querySelector('.wkfp-dlg-btns .wkfp-btn');
    if (first) first.focus();
  });
}
/**
 * WinKFP's message box.
 * @param {HTMLElement} win - The window.
 * @param {'info'|'error'|'warn'|'question'} kind - Its icon.
 * @param {string} text - What it says (plain text).
 * @param {string[]} [buttons] - OK by default.
 * @param {string} [title] - Its own title, where WinKFP gives one.
 * @returns {Promise<string|null>}
 */
function wkfpMessage(win, kind, text, buttons, title) {
  const titles = {
    info: 'Info',
    error: 'Error',
    warn: 'Warning',
    question: 'Info',
  };
  const glyph = { info: 'i', error: '✕', warn: '!', question: '?' };
  return wkfpDialog(win, {
    title: title || titles[kind],
    cls: 'wkfp-msg',
    body: `<div class="wkfp-msg-row"><span class="wkfp-icon wkfp-icon-${kind}">${glyph[kind]}</span><div class="wkfp-msg-text">${esc(text)}</div></div>`,
    buttons: buttons || ['OK'],
  });
}
