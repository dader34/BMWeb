// WebKFP's settings and what it keeps between visits: the Ini Options
// (Winkfpt.ini), the last choice of module and ZB, and ERROR.LOG. The screen
// is screens/webkfp/screen.js.

/* exported wkfpIni, wkfpSaveIni, wkfpSaveChoice, wkfpLoadChoice, wkfpSaveLog, wkfpLoadLog */

/** The Ini Options, as WinKFP keeps them in Winkfpt.ini. */
const WKFP_INI_STORE = 'bmweb.webkfp.ini';
/** Bumped when a default changes, so saved options pick it up. */
const WKFP_INI_VERSION = 2;
/** Winkfpt.ini's defaults, by its own key names. */
const WKFP_INI_DEFAULTS = {
  U_PROG: true,
  ANZEIGE_U_PROG: true,
  // on, unlike Winkfpt.ini: the block writes go at the module's fast rate
  SCHNELLE_BAUDRATE: true,
  TEST_CHECKSUMME: true,
  PROGRAMM_ERZWINGEN: false,
  BSU_ZULASSEN: false,
  AIF_SCHREIBEN_NACH_DATEN: true,
  AIF_SCHREIBEN_NACH_PROGRAMM: true,
  EXPERT_MIT_AIF: false,
  KOMFORT_MIT_AIF: true,
  // WebKFP's own (EDIABAS's UbattHandling, in WinKFP's options): warn before
  // programming when the cable reads KL15 low. Off for a cable that never
  // wired that line, which reads "off" on a car whose ignition is on.
  UBATT_PRUEFEN: true,
};
function wkfpIni() {
  try {
    const saved =
      JSON.parse(localStorage.getItem(WKFP_INI_STORE) || '{}') || {};
    // options saved before fast baud became the default take the new default once
    if (saved.v !== WKFP_INI_VERSION) delete saved.SCHNELLE_BAUDRATE;
    return { ...WKFP_INI_DEFAULTS, ...saved };
  } catch (e) {
    return { ...WKFP_INI_DEFAULTS };
  }
}
function wkfpSaveIni(ini) {
  try {
    localStorage.setItem(
      WKFP_INI_STORE,
      JSON.stringify({ ...ini, v: WKFP_INI_VERSION })
    );
  } catch (e) {
    /* storage unavailable: the options last for this visit */
  }
}
/** What was chosen, kept between visits (wkfpSaveChoice). */
const WKFP_CHOICE_STORE = 'bmweb.webkfp.choice';
/**
 * Keep what was chosen -- the ZB, the VIN, the expert's files -- so a
 * reload comes back to it. Names only: the files are fetched again (from
 * the cache) or, for an imported folder, the folder is asked for again.
 * @param {object} st - WebKFP's state.
 * @returns {void}
 */
function wkfpSaveChoice(st) {
  const f = (x) => (x ? { mod: x.mod.id, name: x.name } : null);
  const e = st.exp;
  const choice = {
    v: 1,
    source: st.source,
    folderName: st.folderName,
    vin: st.vin,
    mod: st.mod ? st.mod.id : null,
    zb: st.row ? st.row.zb : null,
    exp: e
      ? {
          pabd: e.pabd ? e.pabd.id : null,
          sgbd: e.sgbd,
          address: e.address,
          data: f(e.data),
          program: f(e.program),
          naab: f(e.naab),
        }
      : null,
  };
  try {
    localStorage.setItem(WKFP_CHOICE_STORE, JSON.stringify(choice));
  } catch (err) {
    /* storage unavailable: the choice lasts for this visit */
  }
}
/** @returns {object|null} What wkfpSaveChoice kept, or null. */
function wkfpLoadChoice() {
  try {
    const c = JSON.parse(localStorage.getItem(WKFP_CHOICE_STORE) || 'null');
    return c && c.v === 1 ? c : null;
  } catch (err) {
    return null;
  }
}
/** Display > ERROR.LOG, kept between visits. */
const WKFP_LOG_STORE = 'bmweb.webkfp.errorlog';
/** The most of it that is kept: the newest lines. */
const WKFP_LOG_KEEP = 5000;
/**
 * Keep ERROR.LOG for the next visit (the newest WKFP_LOG_KEEP lines).
 * @param {string[]} lines - The log.
 * @returns {void}
 */
function wkfpSaveLog(lines) {
  try {
    localStorage.setItem(
      WKFP_LOG_STORE,
      JSON.stringify(lines.slice(-WKFP_LOG_KEEP))
    );
  } catch (e) {
    /* storage unavailable or full: the log lasts for this visit */
  }
}
/** @returns {string[]} ERROR.LOG as the last visit left it ([] for none). */
function wkfpLoadLog() {
  try {
    const lines = JSON.parse(localStorage.getItem(WKFP_LOG_STORE) || '[]');
    return Array.isArray(lines) ? lines.map(String) : [];
  } catch (e) {
    return [];
  }
}
