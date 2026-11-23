/**
 * @file The coding keyword labels every coding screen shares: BMW's DATEN
 * keyword (a function, or one of its values) to the English shown for it.
 *
 * EXACT LOOKUPS ONLY, like the captions and the fault texts. A keyword has a
 * translation -- the community's (NCS Dummy's Translations.csv, shipped as
 * BMW_DATEN_I18N), or one of the few whole keywords added by hand below --
 * or it is shown as BMW wrote it.
 *
 * This file used to carry a 500-word German glossary applied word by word
 * with a regex, and a pass that "tidied" the result. Measured over the
 * 23,756 keywords of every shipped coding file (2026-11): the community
 * list translates 12,489; the glossary changed 10, because a keyword is
 * SNAKE_CASE and `\b` does not break at an underscore, so its words were
 * never found inside one -- and where it did reach it left hybrids
 * ("EKS_GEDRUECKT/open"); the tidy pass re-cased 300 of BMW's identifiers
 * ("VBATTOPLIMIT" became "Vbattoplimit"). The six whole keywords the
 * glossary did translate are kept, as whole keywords.
 */

/**
 * Whole keywords the community list does not carry, translated by hand.
 * Keyed by the lower-cased keyword and matched WHOLE: nothing here is looked
 * for inside a longer name.
 * @type {Record<string, string>}
 */
const COD_KEYWORDS = {
  typ: 'Type',
  zustand: 'State',
  gong: 'Chime',
  kompressoraustaktung: 'Compressor cut-out',
  hinterachsuebersetzung: 'Rear axle ratio',
  wegstreckenzaehler: 'Odometer',
};

/**
 * The translation of a DATEN keyword: the community's, else the hand-kept
 * one. Returned as written -- already English. orig (EDIABAS) mode shows
 * BMW's keyword untouched.
 * @param {string|null|undefined} name - the DATEN keyword.
 * @returns {string} the translation, or '' when there is none.
 */
function datI18n(name) {
  if (typeof lang === 'function' && lang() === 'orig') return '';
  if (!name) return '';
  const key = String(name).toLowerCase();
  // own entries only: a keyword may be spelled like something every object
  // has ("constructor"), and that is not a translation
  const own = (map) =>
    map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '';
  const t = (typeof window !== 'undefined' && window.BMW_DATEN_I18N) || null;
  return own(t) || own(COD_KEYWORDS) || '';
}

/**
 * Label for a DATEN keyword: its translation, else the keyword as BMW wrote
 * it (its first letter upper-cased, as a row of a list starts; nothing else
 * about it is changed).
 * @param {string} name - the DATEN keyword.
 * @returns {string} the label.
 */
function datLabel(name) {
  const own = datI18n(name);
  if (own) return own;
  const raw = String(name == null ? '' : name).trim();
  if (typeof lang === 'function' && lang() === 'orig') return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// The pieces the other coding screens call; published explicitly so the shared surface is visible.
if (typeof window !== 'undefined') {
  window.datI18n = datI18n;
  window.datLabel = datLabel;
}
