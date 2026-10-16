/**
 * @file Special: INPA's Speicher (memory dump). A real INPA screen, root F7
 * ("MS45 Read memory"), reading through SPEICHER_LESEN_ASCII with a
 * "<REGION>;0x<addr>;<n>" argument. Read-only.
 */

/**
 * One memory region the layout offers.
 * @typedef {object} MemRegion
 * @property {string} token - The region token sent in the job argument.
 * @property {string} label - Display label.
 * @property {string} start - Start address, hex.
 * @property {string} low - Lowest readable address, hex.
 * @property {string} high - Highest readable address, hex.
 * @property {string} [key] - Short softkey caption (hand-built layouts).
 * @property {string} [fkey] - INPA's own long caption.
 */

/**
 * The memory-dump layout, decoded from the .IPO.
 * @typedef {object} MemLayout
 * @property {string} title - Screen title.
 * @property {string} job - The read job (SPEICHER_LESEN_ASCII).
 * @property {number} maxBytes - The most bytes one read may ask for.
 * @property {MemRegion[]} regions - The regions, in INPA key order.
 * @property {{ delta: number, key?: string, label: string }[]} steps
 *   - The address steps (±10h / ±100h).
 */
