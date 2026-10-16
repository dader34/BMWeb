/**
 * @file Identity: INPA's "ID-data" card -- the ECU's part number, versions,
 * build date and references. Read-only, and read once rather than polled:
 * none of it changes while the car sits there.
 *
 * The field order is INPA's own (decoded from the .IPO captions), which
 * differs from the order the SGBD returns them in.
 */

/**
 * One field of the ID card.
 * @typedef {object} IdentField
 * @property {string} key - The result name (BMW_TEILENUMMER), or, for a
 *   per-argument field, "RESULT arg" once resolved.
 * @property {string} label - INPA's caption, or the SGBD's own description.
 * @property {string} [job] - The job to run for a per-argument field.
 * @property {string|number} [arg] - That job's argument.
 * @property {boolean} [extra] - Contributed by the SGBD, not shown by INPA's
 *   own screen.
 */

/**
 * The ID-card layout, decoded from the .IPO.
 * @typedef {object} IdentLayout
 * @property {string} title - Card title.
 * @property {string} subtitle - Card subtitle.
 * @property {string[]} jobs - The jobs read once, without arguments.
 * @property {IdentField[]} fields - The fields, in INPA's order.
 */
