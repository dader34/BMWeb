/**
 * @file Data logging: saved selections.
 *
 * Fifth piece of screens/logging/ (see store.js for the folder map).
 *
 * A useful log is a dozen keys picked out of several thousand, and the same
 * dozen is wanted again on the next drive. The selection is therefore
 * nameable and persisted in the ordinary Settings store, keyed by chassis so
 * a preset built for one car does not offer itself on another whose modules
 * do not carry those jobs.
 */

/* exported LOG_PRESET_KEY, logPresetsGet, logPresetSave, logPresetDelete */

/** The Settings key the presets live under. @type {string} */
const LOG_PRESET_KEY = 'loggingPresets';

/**
 * Every saved preset, by chassis.
 * @returns {Object<string, Object<string, Array<object>>>} chassis -> name -> rows.
 */
function logPresetsAll() {
  const v = Settings.get(LOG_PRESET_KEY, {});
  return v && typeof v === 'object' ? v : {};
}

/**
 * The presets saved for one chassis.
 * @param {string} chassis - The chassis id.
 * @returns {Object<string, Array<object>>} name -> selection rows.
 */
function logPresetsGet(chassis) {
  const all = logPresetsAll();
  const forCar = all[String(chassis).toUpperCase()];
  return forCar && typeof forCar === 'object' ? forCar : {};
}

/**
 * Save a selection under a name, replacing one of the same name.
 * @param {string} chassis - The chassis id.
 * @param {string} name - The preset name.
 * @param {Array<object>} rows - The selection (LogSelection#toJSON).
 * @returns {void}
 */
function logPresetSave(chassis, name, rows) {
  const all = logPresetsAll();
  const car = String(chassis).toUpperCase();
  if (!all[car]) all[car] = {};
  all[car][name] = rows;
  Settings.set(LOG_PRESET_KEY, all);
}

/**
 * Delete a preset.
 * @param {string} chassis - The chassis id.
 * @param {string} name - The preset name.
 * @returns {void}
 */
function logPresetDelete(chassis, name) {
  const all = logPresetsAll();
  const car = String(chassis).toUpperCase();
  if (all[car]) {
    delete all[car][name];
    if (!Object.keys(all[car]).length) delete all[car];
  }
  Settings.set(LOG_PRESET_KEY, all);
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LOG_PRESET_KEY,
    logPresetsGet,
    logPresetSave,
    logPresetDelete,
  };
}
