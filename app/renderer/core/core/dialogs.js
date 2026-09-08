/**
 * @file Modal dialogs: the shared overlay lifecycle and the three INPA-shaped
 * prompts built on it (confirm, message box, value input).
 */

/** How long the overlay's fade-out runs before the node is removed. */
const MODAL_FADE_MS = 160;
/** How long an empty input shakes when submitted. */
const INPUT_SHAKE_MS = 350;

/**
 * A modal handle.
 * @typedef {Object} ModalHandle
 * @property {HTMLElement} overlay - The overlay element; query the dialog inside it.
 * @property {(val?: any) => void} close - Close, forwarding `val` to onClose.
 */

/**
 * Shared modal lifecycle: overlay, captured keydown, backdrop click, fade-out.
 * @param {string} html - The dialog markup.
 * @param {Object} [opts]
 * @param {(e: KeyboardEvent, close: (val?: any) => void) => void} [opts.onKey] - Overrides Esc-to-close.
 * @param {(val: any) => void} [opts.onClose] - Receives whatever close() was given.
 * @param {any} [opts.backdropValue] - What a backdrop click closes with.
 * @returns {ModalHandle}
 */
function openModal(html, { onKey, onClose, backdropValue } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = (val) => {
    overlay.classList.remove('show');
    window.removeEventListener('keydown', handler, true);
    setTimeout(() => overlay.remove(), MODAL_FADE_MS);
    if (onClose) onClose(val);
  };
  const handler = (e) => {
    if (onKey) return onKey(e, close);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  window.addEventListener('keydown', handler, true);
  overlay.onclick = (e) => {
    if (e.target === overlay) close(backdropValue);
  };
  return { overlay, close };
}

/**
 * Confirm modal. Enter confirms, Esc cancels.
 * @param {Object} opts
 * @param {string} opts.title - Dialog title (trusted HTML).
 * @param {string} opts.body - Dialog body (trusted HTML).
 * @param {string} [opts.confirmLabel='Confirm'] - Confirm button caption.
 * @param {string} [opts.cancelLabel='Cancel'] - Cancel button caption.
 * @param {boolean} [opts.danger=false] - Red styling for a destructive action.
 * @param {any} [opts.dismissValue=false] - What Esc / a backdrop click resolve
 *   with. false by default (a dismissal is a cancel); a caller whose two
 *   buttons are both real answers (INPA's inputdigital, where either word may
 *   be the one that sends) passes null so a dismissal is neither.
 * @returns {Promise<boolean|any>} true on confirm, false on cancel, else dismissValue.
 */
function confirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  dismissValue = false,
}) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(
      `
      <div class="modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <button class="btn modal-cancel">${cancelLabel}<span class="modal-key">Esc</span></button>
          <button class="btn ${danger ? 'danger' : 'primary'} modal-confirm">${confirmLabel}<span class="modal-key">⏎</span></button>
        </div>
      </div>`,
      {
        onClose: resolve,
        backdropValue: dismissValue,
        onKey: (e, close) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close(dismissValue);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            close(true);
          }
        },
      }
    );
    overlay.querySelector('.modal-cancel').onclick = () => close(false);
    overlay.querySelector('.modal-confirm').onclick = () => close(true);
    overlay.querySelector('.modal-confirm').focus();
  });
}

/**
 * INPA's messagebox: one OK button, information only. The interpreted-screen
 * path pops these with the script's own words when a live job fails, which is
 * what INPA itself does ("Wrong JOB_STATUS : ...").
 * @param {Object} opts
 * @param {string} opts.title - Dialog title (trusted HTML).
 * @param {string} opts.body - Dialog body (trusted HTML).
 * @param {boolean} [opts.danger=false] - Red styling.
 * @returns {Promise<true>} Resolves when dismissed.
 */
/**
 * A progress popup: a title, one status line that the caller updates, and
 * a Cancel button. The backdrop does not dismiss it (the work is still
 * running); Esc or the button cancels.
 * @param {{title: string, text?: string, cancelLabel?: string, onCancel?: () => void}} opts
 * @returns {{update: (text: string) => void, close: () => void}}
 */
function progressDialog({
  title,
  text = '',
  cancelLabel = 'Cancel',
  onCancel,
}) {
  let open = true;
  const { overlay, close } = openModal(
    `
    <div class="modal modal-progress" role="dialog" aria-modal="true" aria-live="polite">
      <div class="modal-title">${title}</div>
      <div class="modal-body"><span class="modal-spinner" aria-hidden="true"></span><span class="modal-progress-text">${esc(text)}</span></div>
      <div class="modal-actions">
        <button class="btn modal-cancel">${cancelLabel}<span class="modal-key">Esc</span></button>
      </div>
    </div>`,
    {
      onClose: (val) => {
        open = false;
        if (val === true && onCancel) onCancel();
      },
      onKey: (e, c) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          c(true);
        }
      },
    }
  );
  overlay.onclick = null;
  const line = overlay.querySelector('.modal-progress-text');
  overlay.querySelector('.modal-cancel').onclick = () => close(true);
  return {
    update: (t) => {
      if (line) line.textContent = t == null ? '' : String(t);
    },
    close: () => {
      if (open) close(false);
    },
  };
}

function messageDialog({ title, body, danger = false }) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(
      `
      <div class="modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <button class="btn primary modal-confirm">OK<span class="modal-key">⏎</span></button>
        </div>
      </div>`,
      {
        onClose: resolve,
        backdropValue: true,
        onKey: (e, close) => {
          if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            close(true);
          }
        },
      }
    );
    overlay.querySelector('.modal-confirm').onclick = () => close(true);
    overlay.querySelector('.modal-confirm').focus();
  });
}

/**
 * Value-input modal for INPA functions. Enter submits, Esc cancels; an empty
 * value shakes the field instead of submitting.
 * @param {Object} opts
 * @param {string} opts.title - Dialog title (trusted HTML).
 * @param {string} [opts.body] - Prompt text (trusted HTML).
 * @param {'text'|'number'|'hex'} [opts.kind='text'] - Field kind.
 * @param {string} [opts.example=''] - Placeholder example.
 * @param {string} [opts.confirmLabel='Run'] - Confirm button caption.
 * @param {boolean} [opts.danger=false] - Red styling.
 * @returns {Promise<string|null>} The trimmed value, or null when cancelled.
 */
function inputDialog({
  title,
  body,
  kind = 'text',
  example = '',
  confirmLabel = 'Run',
  danger = false,
}) {
  return new Promise((resolve) => {
    const htmlType = kind === 'number' ? 'number' : 'text';
    const ph = example ? `e.g. ${example}` : '';
    const { overlay, close } = openModal(
      `
      <div class="modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body || ''}</div>
        <div class="modal-input-wrap">
          <input class="modal-input" type="${htmlType}" placeholder="${ph}"
                 ${kind === 'hex' ? 'spellcheck="false" autocapitalize="off"' : ''} />
          ${kind === 'hex' ? '<span class="modal-input-hint">hex / KWP bytes, e.g. 22,40,0A</span>' : ''}
          ${kind === 'number' ? '<span class="modal-input-hint">numeric value</span>' : ''}
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn ${danger ? 'danger' : 'primary'} modal-confirm">${confirmLabel}<span class="modal-key">⏎</span></button>
        </div>
      </div>`,
      {
        onClose: resolve,
        backdropValue: null,
        onKey: (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close(null);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            submit();
          }
        },
      }
    );
    const field = overlay.querySelector('.modal-input');
    const submit = () => {
      const v = field.value.trim();
      if (v === '') {
        field.focus();
        field.classList.add('shake');
        setTimeout(() => field.classList.remove('shake'), INPUT_SHAKE_MS);
        return;
      }
      close(v);
    };
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = submit;
    field.focus();
  });
}
