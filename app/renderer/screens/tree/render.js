// Control unit tree: the picture. One SVG from a layout and a status map,
// drawn the way ISTA draws it: bus lines in their colours, a box per module,
// the box's outline saying what the last scan found. Pure string building,
// so the same markup serves the screen and the print sheet.

/** The state each box outline stands for, in ISTA's legend order. */
const ECU_TREE_LEGEND = [
  { state: 'ok', label: 'Module without fault memory' },
  { state: 'faults', label: 'Module with fault memory' },
  { state: 'silent', label: 'Module not responding' },
  { state: 'unread', label: 'Not read' },
];

/**
 * The tree as SVG markup.
 * @param {EcuTreeLayout} layout - from ecuTreeLayout
 * @param {Map<string, EcuTreeStatus>} status - from ecuTreeStatus
 * @returns {string}
 */
function ecuTreeSvg(layout, status) {
  const h = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    );
  const parts = [];
  parts.push(
    `<svg class="tree-svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img" aria-label="Control unit tree">`
  );
  for (const l of layout.lines) {
    const c = ecuTreeBusStyle(l.bus).color;
    parts.push(
      `<line class="tree-bus" data-bus="${h(l.bus)}" x1="${l.x}" y1="${l.y1}" x2="${l.x}" y2="${l.y2}" stroke="${c}"/>`
    );
  }
  for (const s of layout.stubs) {
    const c = ecuTreeBusStyle(s.bus).color;
    parts.push(
      `<line class="tree-stub" data-bus="${h(s.bus)}" x1="${s.x1}" y1="${s.y}" x2="${s.x2}" y2="${s.y}" stroke="${c}"/>`
    );
  }
  for (const b of layout.boxes) {
    const key = ecuTreeKey(b.ecu);
    const st = status.get(key) || { state: 'unread', faults: 0 };
    const root = b.ecu.bus === 'ROOT';
    const title =
      `${b.ecu.name}` +
      (b.ecu.addr >= 0
        ? ` (0x${b.ecu.addr.toString(16).padStart(2, '0')})`
        : '') +
      (st.state === 'faults'
        ? `: ${st.faults} fault${st.faults === 1 ? '' : 's'}`
        : st.state === 'ok'
          ? ': no faults'
          : st.state === 'silent'
            ? ': not responding'
            : '');
    parts.push(
      `<g class="tree-box tree-${st.state}${root ? ' tree-root' : ''}" data-key="${h(key)}" tabindex="0" role="button">` +
        `<title>${h(title)}</title>` +
        `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3"/>` +
        `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2}" text-anchor="middle" dominant-baseline="central">${h(b.ecu.name)}</text>` +
        (st.state === 'faults'
          ? `<circle class="tree-badge" cx="${b.x + b.w - 6}" cy="${b.y + 6}" r="5"/>` +
            `<text class="tree-badge-n" x="${b.x + b.w - 6}" y="${b.y + 6}" text-anchor="middle" dominant-baseline="central">${st.faults}</text>`
          : '') +
        `</g>`
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

/**
 * The legend under the picture: the buses this tree draws, then the box
 * outlines.
 * @param {EcuTreeLayout} layout - the layout (its buses)
 * @returns {string}
 */
function ecuTreeLegendHtml(layout) {
  const h = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    );
  const buses = layout.buses
    .map((b) => {
      const st = ecuTreeBusStyle(b);
      return `<span class="tree-leg-bus"><i style="background:${st.color}"></i>${h(st.label)}</span>`;
    })
    .join('');
  const states = ECU_TREE_LEGEND.map(
    (l) =>
      `<span class="tree-leg-state"><b class="tree-${l.state}"></b>${h(l.label)}</span>`
  ).join('');
  return `<div class="tree-legend"><div class="tree-leg-row">${buses}</div><div class="tree-leg-row">${states}</div></div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ECU_TREE_LEGEND, ecuTreeSvg, ecuTreeLegendHtml };
}
