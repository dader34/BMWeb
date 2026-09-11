/**
 * @file Drawing a repair instruction, and the two panes that find one.
 *
 * Everything here is pure: a document model in, HTML out. The screen wires
 * the clicks; this decides what a step, a hint, a torque table and a group
 * row look like, so all of it can be tested without a DOM.
 *
 * THE VISUAL LANGUAGE IS ISTA'S, deliberately, and not the rest of the app's.
 * A mechanic reading a repair instruction is cross-checking it against a
 * printed manual or a colleague's screen, and a step numbered differently or
 * a torque laid out differently is a step they have to re-find. So: white
 * content, grey banded rows, dark grey header bars, teal for what is
 * selected, square corners, no shadows. The scoping class `.ista-repair`
 * keeps that vocabulary from leaking into screens that use the app's own.
 *
 * TORQUE IS NEVER PROSE. A tightening figure is the one thing in a repair
 * instruction that injures someone when it is wrong, so it is drawn as its
 * own table with the unit in the same cell as the number -- never as a
 * column heading a narrow screen can scroll away from, and never folded
 * into the sentence that mentions it.
 */

/* exported repairDocHtml repairStepHtml repairHintHtml repairTorqueHtml */

/** What each hint kind is called, and the order of severity it reads in. */
const REPAIR_HINT_LABELS = {
  danger: 'Danger',
  warning: 'Warning',
  caution: 'Caution',
  disposal: 'Disposal',
  install: 'Installation',
  before: 'Necessary preliminary work',
  note: 'Note',
};

/**
 * One hint block: a titled, coloured call-out.
 *
 * The kind drives only the colour and the default title. The text is never
 * reworded, abbreviated or merged -- a safety note is the author's sentence
 * or it is not a safety note.
 * @param {object} hint - {kind, title, text}
 * @returns {string} HTML
 */
function repairHintHtml(hint) {
  if (!hint) return '';
  const kind = String(hint.kind || 'note');
  const label = hint.title || REPAIR_HINT_LABELS[kind] || 'Note';
  const lines = (hint.text || [])
    .map((t) => `<p class="rp-hint-p">${esc(t)}</p>`)
    .join('');
  if (!lines && !label) return '';
  return (
    `<div class="rp-hint rp-hint-${esc(kind)}">` +
    `<div class="rp-hint-title">${esc(label)}</div>` +
    lines +
    `</div>`
  );
}

/**
 * One step's tightening torques, as their own table.
 *
 * A connection can carry several screws and a screw several figures (a
 * jointing torque AND an angle of rotation, which are two instructions, not
 * one), so both nest rather than being flattened to one row each.
 * @param {Array<object>} torques - the torque blocks
 * @returns {string} HTML
 */
function repairTorqueHtml(torques) {
  if (!torques || !torques.length) return '';
  const blocks = torques
    .map((t) => {
      const rows = [];
      for (const screw of t.screws || []) {
        const vals = screw.values || [];
        // one row per figure, the thread named once down the side
        vals.forEach((v, i) => {
          const figure = [v.value, v.unit].filter(Boolean).join(' ');
          rows.push(
            `<tr>` +
              `<td class="rp-tq-thread">${i === 0 ? esc(screw.thread || '') : ''}</td>` +
              `<td class="rp-tq-note">${i === 0 ? esc(screw.note || '') : ''}</td>` +
              `<td class="rp-tq-kind">${esc(v.kind || 'Tightening torque')}</td>` +
              `<td class="rp-tq-val">${esc(figure)}</td>` +
              `</tr>`
          );
        });
        if (!vals.length)
          rows.push(
            `<tr><td class="rp-tq-thread">${esc(screw.thread || '')}</td>` +
              `<td class="rp-tq-note">${esc(screw.note || '')}</td>` +
              `<td class="rp-tq-kind"></td><td class="rp-tq-val"></td></tr>`
          );
      }
      if (!rows.length) return '';
      return (
        `<div class="rp-tq">` +
        (t.connection
          ? `<div class="rp-tq-head">${esc(t.connection)}</div>`
          : '') +
        `<table class="rp-tq-table"><tbody>${rows.join('')}</tbody></table>` +
        `</div>`
      );
    })
    .filter(Boolean);
  return blocks.join('');
}

/**
 * One operating step: its number, its pictures, its text and its extras.
 *
 * The number is the reader's place in the job, so it is drawn even when the
 * source did not number the step -- a mechanic says "I'm on four", and a
 * list of unnumbered paragraphs cannot answer that.
 * @param {object} step - the step model
 * @param {number} n - the step's number within its section
 * @param {string} chassis - the development code, for picture URLs
 * @returns {string} HTML
 */
function repairStepHtml(step, n, chassis) {
  if (!step) return '';
  const pics = (step.pics || [])
    .map(
      (p) =>
        `<img class="rp-pic" loading="lazy" alt="Illustration for step ${n}" ` +
        `src="${esc(repairPicUrl(chassis, p))}">`
    )
    .join('');
  const text = (step.text || [])
    .map((t) => `<p class="rp-step-p">${esc(t)}</p>`)
    .join('');
  const hints = (step.hints || []).map(repairHintHtml).join('');
  const torques = repairTorqueHtml(step.torques);
  if (!pics && !text && !hints && !torques) return '';
  return (
    `<li class="rp-step">` +
    `<div class="rp-step-n">${n}</div>` +
    `<div class="rp-step-body">` +
    (pics ? `<div class="rp-pics">${pics}</div>` : '') +
    text +
    hints +
    torques +
    `</div></li>`
  );
}

/**
 * A whole document: its title bar's text is the screen's job, this is the body.
 * @param {object} doc - the index entry
 * @param {object|null} body - the body model, or null when it did not load
 * @param {string} chassis - the development code, for picture URLs
 * @returns {string} HTML
 */
function repairDocHtml(doc, body, chassis) {
  const head =
    `<h2 class="rp-doc-h">` +
    (repairDocNumber(doc) ? `${esc(repairDocNumber(doc))} ` : '') +
    `${esc((doc && doc.title) || '(untitled)')}</h2>` +
    (doc && doc.unsure
      ? `<div class="rp-unsure">This document's applicability could not be ` +
        `read, so it is shown for every vehicle. Check that it matches this ` +
        `car before working to it.</div>`
      : '');
  if (!body)
    return (
      head +
      `<div class="rp-none">This document's body is not in this build.</div>`
    );

  const parts = [head];
  for (const h of body.hints || []) parts.push(repairHintHtml(h));
  for (const sec of body.sections || []) {
    const steps = (sec.steps || [])
      .map((s, i) => repairStepHtml(s, i + 1, chassis))
      .filter(Boolean)
      .join('');
    if (!steps) continue;
    const label = [sec.phase, sec.title].filter(Boolean).join(' -- ');
    parts.push(
      `<section class="rp-sec">` +
        (label ? `<div class="rp-sec-h">${esc(label)}</div>` : '') +
        `<ol class="rp-steps">${steps}</ol></section>`
    );
  }
  const drawn = parts.filter(Boolean).join('');
  return drawn === head
    ? head + `<div class="rp-none">This document has no steps.</div>`
    : drawn;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REPAIR_HINT_LABELS,
    repairHintHtml,
    repairTorqueHtml,
    repairStepHtml,
    repairDocHtml,
  };
}
