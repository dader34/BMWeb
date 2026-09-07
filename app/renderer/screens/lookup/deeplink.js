/**
 * @file Shareable fault links. An open fault detail puts ?dtc=HEX (plus
 * &sgbd= and &n=, the module and the row's label) in the URL, preserving the
 * #apps/diagnostics hash; paste the URL to anyone and it reopens the same
 * fault, on the same module, under the same name. Also the one rule for
 * picking a fault's ECU-variant record by module, shared by the modal and the
 * link resolver so the two can't drift.
 */

/* exported setDtcParam, getDtcParam, lookupVariantsFor, lookupPickVariant */

/**
 * The parts of a shared fault link.
 * @typedef {object} LookupDtcLink
 * @property {string} hex - the fault code, upper-cased
 * @property {string} sgbd - the module it was shared from ('' if none)
 * @property {string} name - the row label the sender saw ('' if none)
 */

/**
 * Reflect an open fault in the URL, or strip it when `hex` is null.
 * replaceState keeps it out of the history stack (browsing faults shouldn't
 * spam Back).
 * @param {string|null} hex - the fault code, or null to clear
 * @param {string} [sgbd] - the module the fault was opened on
 * @param {string} [name] - the row's own label
 * @returns {void}
 */
function setDtcParam(hex, sgbd, name) {
  try {
    const u = new URL(location.href);
    if (hex) {
      u.searchParams.set('dtc', String(hex).toUpperCase());
      if (sgbd) u.searchParams.set('sgbd', String(sgbd));
      else u.searchParams.delete('sgbd');
      // Carry the row's own label too. It comes from the per-chassis fault
      // file ("Outside temperature"), not the ISTA variant metadata
      // ("IHKA: Automatic heater - A/C system: fault stored"), so it cannot be
      // recovered from dtc+sgbd alone -- without it a shared link opens the
      // right fault under a different name than the sender saw.
      if (name) u.searchParams.set('n', String(name));
      else u.searchParams.delete('n');
    } else {
      u.searchParams.delete('dtc');
      u.searchParams.delete('sgbd');
      u.searchParams.delete('n');
    }
    history.replaceState(history.state, '', u.href);
  } catch (e) {
    /* URL API missing: shareable link is best-effort */
  }
}

/**
 * The shared fault link in the current URL, if any.
 * @returns {LookupDtcLink|null}
 */
function getDtcParam() {
  try {
    const p = new URLSearchParams(location.search);
    const dtc = p.get('dtc');
    return dtc
      ? {
          hex: dtc.toUpperCase(),
          sgbd: p.get('sgbd') || '',
          name: p.get('n') || '',
        }
      : null;
  } catch (e) {
    return null;
  }
}

/**
 * The ISTA variant records of a fault code, or [] when the metadata isn't
 * loaded.
 * @param {string} code - the fault code
 * @returns {FaultMetaVariant[]}
 */
function lookupVariantsFor(code) {
  return (
    (typeof variantsForHex === 'function' ? variantsForHex(code) : []) || []
  );
}

/**
 * Pick the ONE variant record for a module -- never a fan-out. In order:
 * exact sgbd, sgbd-family prefix (ms_s65 -> ms_s65_2), exact name (when a
 * name is given), else the first record.
 * @param {FaultMetaVariant[]} variants - the code's variant records
 * @param {string} sgbd - the wanted module ('' = any)
 * @param {string|null} [name] - the row label to fall back to, or null to skip that step
 * @returns {FaultMetaVariant|null} null only when there are no records at all
 */
function lookupPickVariant(variants, sgbd, name) {
  const wantSgbd = (sgbd || '').toLowerCase();
  const famKey = wantSgbd.replace(/[^a-z0-9]/g, '');
  const wantName = name == null ? null : name.trim().toLowerCase();
  return (
    variants.find((v) => (v.sgbd || '').toLowerCase() === wantSgbd) ||
    variants.find((v) => {
      const s = (v.sgbd || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return famKey && (s.startsWith(famKey) || famKey.startsWith(s));
    }) ||
    (wantName != null
      ? variants.find((v) => (v.name || '').trim().toLowerCase() === wantName)
      : null) ||
    variants[0] ||
    null
  );
}
