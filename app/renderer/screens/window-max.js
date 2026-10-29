/* exported winMaximizable */
// The maximise button on the classic-Windows windows (Web32, WebKFP, BMWeb
// Coding): the window goes fullscreen, and back. Double-clicking the title bar
// does the same, as on Windows. Where the browser cannot put an element
// fullscreen (iPhone Safari), the window fills the page instead (.win-max).
// Their dialogs are drawn inside the window, so they still show.

/**
 * Give a window its maximise button.
 * @param {HTMLElement} win the window (.t32-win or .wkfp-win)
 */
function winMaximizable(win) {
  const btn = document.createElement('button');
  btn.className = 'win-max-btn';
  btn.type = 'button';
  const native = !!(win.requestFullscreen && document.fullscreenEnabled);
  const isMax = () =>
    native
      ? document.fullscreenElement === win
      : win.classList.contains('win-max');
  const paint = () => {
    const max = isMax();
    btn.textContent = max ? '❐' : '□';
    btn.title = max ? 'Restore' : 'Maximize';
    btn.setAttribute('aria-label', btn.title);
  };
  const toggle = () => {
    if (!native) win.classList.toggle('win-max');
    else if (isMax()) document.exitFullscreen().catch(() => {});
    else win.requestFullscreen().catch(() => {});
    paint();
  };
  btn.onclick = toggle;
  const bar = win.querySelector('.t32-titlebar, .wkfp-titlebar');
  if (bar) bar.ondblclick = toggle;
  // Esc leaves fullscreen without the button: follow the browser's state
  if (native) {
    const onChange = () => {
      if (!win.isConnected)
        document.removeEventListener('fullscreenchange', onChange);
      else paint();
    };
    document.addEventListener('fullscreenchange', onChange);
  }
  paint();
  win.appendChild(btn);
}
