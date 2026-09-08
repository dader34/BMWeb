/**
 * @file Static scans over a decoded script (the exec's procs), used by the
 * runtime without executing anything: a menu's ITEM keys and prologue, the
 * backdrop screen a menu is normally shown with, and a screen's component
 * and logical-line declarations.
 *
 * Live .IPO runtime: the module view IS the running script. The derived IR
 * (data/inpa-ir) approximated what a script would do and was corrected by
 * heuristics; each heuristic was a place the guess differed from a run. This
 * runtime runs the script instead: `inpainit` names the root menu and
 * screen, a menu's ITEMs are the keys, a key press runs its body in the SAME
 * VM the previous press left behind, a screen's LINE blocks paint cells and
 * send their own jobs (keep-alives included), and a frequent screen re-runs
 * its cycle on a timer -- INPA's own INIT -> LINE -> EXIT tick. Nothing
 * above the VM decides what a key does.
 */

/** F-key numbers above this are the shifted bank (Shift+F1 = 11). */
const IPO_SHIFT_BASE = 10;

/**
 * One key of a menu: an ITEM token and where its body lies in the proc.
 * @typedef {object} IpoMenuItem
 * @property {number} nr - F-key number (11..20 = shifted)
 * @property {string} label - the caption as the script wrote it
 * @property {boolean} shift - a Shift+F key
 * @property {boolean} hidden - no caption: INPA's bar shows it blank
 * @property {number} start - first token index of the body
 * @property {number} end - token index the body ends at (exclusive)
 * @property {string} [legendLabel] - the caption the screen's legend gave a hidden key
 */

/**
 * ITEM tokens of a menu proc, in proc order.
 * @param {object} exec - the decoded script ({procs, byid})
 * @param {string} menuName - the menu proc
 * @returns {IpoMenuItem[]}
 */
function ipoMenuItems(exec, menuName) {
  const toks = exec && exec.procs && exec.procs[menuName];
  if (!Array.isArray(toks)) return [];
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op !== 'ITEM') continue;
    let end = toks.length;
    for (let j = i + 1; j < toks.length; j++) {
      if (toks[j].op === 'ITEM' || toks[j].op === 'unk') {
        end = j;
        break;
      }
    }
    out.push({
      nr: t.nr,
      label: t.label || '',
      shift: t.nr > IPO_SHIFT_BASE,
      hidden: !String(t.label || '').trim(),
      start: i + 1,
      end,
    });
  }
  return out;
}

/**
 * Where a menu proc's prologue ends (the first ITEM), or the proc end.
 * @param {object} exec - the decoded script
 * @param {string} menuName - the menu proc
 * @returns {number} token index
 */
function ipoPrologueEnd(exec, menuName) {
  const toks = exec && exec.procs && exec.procs[menuName];
  if (!Array.isArray(toks)) return 0;
  const i = toks.findIndex((t) => t.op === 'ITEM');
  return i < 0 ? toks.length : i;
}

/**
 * The setscreen call in an ITEM body, walking back from a token: the screen
 * ref and the frequent flag pushed before the call.
 * @param {IpoToken[]} toks - the proc's tokens
 * @param {number} j - index of the setscreen call
 * @param {Record<string, string>} byid - the exec's byid table
 * @returns {{screen: string, frequent: boolean}|null}
 */
function ipoSetscreenArgs(toks, j, byid) {
  let ref = null,
    flag = false;
  for (let k = j - 1; k >= 0 && toks[k].op !== 'frame'; k--) {
    if (toks[k].op === 'procref' && toks[k].kind === IPO_REF_SCREEN)
      ref = toks[k];
    if (toks[k].op === 'const' && (toks[k].t === 'b' || toks[k].t === 'i'))
      flag = !!toks[k].v;
  }
  const scr = ref && byid[`screen:${ref.n}`];
  return scr ? { screen: scr, frequent: flag } : null;
}

/**
 * The backdrop a menu is normally shown with: the setscreen the key that
 * opens it performs right before its setmenu. A deep link (the URL route)
 * lands on the menu without pressing that key, so its screen is looked up
 * here rather than left as whatever was current.
 * @param {object} exec - the decoded script
 * @param {string} menuName - the menu proc
 * @returns {{screen: string, frequent: boolean}|null}
 */
function ipoScreenForMenu(exec, menuName) {
  const byid = (exec && exec.byid) || {};
  const menuId = Object.entries(byid).find(
    ([k, v]) => k.startsWith('menu:') && v === menuName
  );
  if (!menuId) return null;
  const mid = Number(menuId[0].split(':')[1]);
  for (const toks of Object.values(exec.procs || {})) {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!(t.op === 'procref' && t.kind === IPO_REF_MENU && t.n === mid))
        continue;
      const nxt = toks[i + 1];
      if (!(nxt && nxt.op === 'call' && nxt.name === 'setmenu')) continue;
      // walk back within the same ITEM body for a setscreen
      for (let j = i - 1; j >= 0 && toks[j].op !== 'ITEM'; j--) {
        const c = toks[j];
        if (c.op === 'call' && c.name === 'setscreen') {
          const found = ipoSetscreenArgs(toks, j, byid);
          if (found) return found;
        }
      }
    }
  }
  return null;
}

/**
 * The LINE declarations of a screen that carry a component key: INPA's
 * togglelist offers exactly these.
 * @param {object} exec - the decoded script
 * @param {string|null} screen - the screen proc
 * @returns {Array<{label: string, keys: string}>}
 */
function ipoScreenComponents(exec, screen) {
  const toks = exec && exec.procs && screen ? exec.procs[screen] : null;
  if (!toks) return [];
  return toks
    .filter((t) => t.op === 'LINE' && t.keys)
    .map((t) => ({ label: t.label || '', keys: String(t.keys) }));
}

/**
 * The named logical lines of a screen: what INPA's Select offers.
 * @param {object} exec - the decoded script
 * @param {string|null} screen - the screen proc
 * @returns {string[]}
 */
function ipoScreenLineNames(exec, screen) {
  const toks = exec && exec.procs && screen ? exec.procs[screen] : null;
  if (!toks) return [];
  const out = [];
  for (const t of toks) {
    if (t.op === 'LINE' && t.label && String(t.label).trim())
      if (!out.includes(t.label)) out.push(t.label);
  }
  return out;
}

/**
 * The keys of a menu whose body sets a screen that has named lines: what
 * Select can filter once that key is pressed. Shown in the Select box when
 * the current screen has nothing to choose from.
 * @param {object} exec - the decoded script
 * @param {string} menuName - the menu proc
 * @param {IpoMenuItem[]} items - the menu's keys (ipoMenuItems)
 * @returns {Array<{nr: number, shift: boolean, screen: string, lines: number}>}
 */
function ipoSelectableKeys(exec, menuName, items) {
  const toks = exec && exec.procs && exec.procs[menuName];
  if (!Array.isArray(toks)) return [];
  const byid = exec.byid || {};
  const out = [];
  for (const it of items || []) {
    let screen = null;
    for (let j = it.start; j < it.end; j++) {
      if (toks[j].op === 'call' && toks[j].name === 'setscreen') {
        const a = ipoSetscreenArgs(toks, j, byid);
        if (a) screen = a.screen;
      }
    }
    if (!screen) continue;
    const lines = ipoScreenLineNames(exec, screen).length;
    if (lines) out.push({ nr: it.nr, shift: !!it.shift, screen, lines });
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IPO_SHIFT_BASE,
    ipoSelectableKeys,
    ipoMenuItems,
    ipoPrologueEnd,
    ipoScreenForMenu,
    ipoScreenComponents,
    ipoScreenLineNames,
  };
}
