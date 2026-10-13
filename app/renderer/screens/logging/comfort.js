/**
 * @file Data logging: Comfort mode -- a short list of readings under plain
 * names, for a module whose jobs are known well enough to name them.
 *
 * The picker tree (picker.js) offers everything a module declares, under the
 * SGBD's own job and register names. That is the whole truth and no way to
 * find the front oxygen sensor. A comfort list is a hand-made index over the
 * same thing: each row is one register of one job, so ticking it selects
 * exactly what the tree would have, and the scheduler, store and charts
 * never learn the difference.
 *
 * Rows lean on as few jobs as they can -- a job is one exchange with the
 * car whatever is read out of its answer, so six readings from one job cost
 * the rate of one.
 */

/* exported logComfortFor, logComfortLabel, logComfortModeGet, logComfortModeSet */

/**
 * @typedef {Object} ComfortRow
 * @property {string} label - What the reading is, in plain words.
 * @property {string} unit - Its unit, shown beside the name.
 * @property {string} job - The job that reads it.
 * @property {string} key - The result register holding it.
 */

/**
 * One row.
 * @param {string} label
 * @param {string} unit
 * @param {string} job
 * @param {string} key
 * @returns {ComfortRow}
 */
const logComfortRow = (label, unit, job, key) => ({ label, unit, job, key });

const LOG_MS45_MAIN = 'STATUS_MESSWERTE';
const LOG_MS45_EXTRA = 'STATUS_FASTA2';
const LOG_MS45_COMMON = 'STATUS_FASTA_COMMON';
const LOG_MS45_PROBES = 'STATUS_FASTA_BIN';
const LOG_MS45_ROUGH = 'STATUS_MOTORLAUFUNRUHE';
const LOG_MS45_CYLINDERS = [1, 2, 3, 4, 5, 6];

/** The comfort lists, by SGBD (lower case). */
const LOG_COMFORT = {
  ms450ds0: {
    title: 'MS45 engine',
    groups: [
      {
        name: 'Engine',
        rows: [
          logComfortRow('Engine speed', 'rpm', LOG_MS45_MAIN, 'STAT_NMOT_WERT'),
          logComfortRow(
            'Idle speed target',
            'rpm',
            LOG_MS45_MAIN,
            'STAT_NSOL_WERT'
          ),
          logComfortRow('Engine load', '%', LOG_MS45_EXTRA, 'STAT_RL_WERT'),
          logComfortRow('Engine torque', '', LOG_MS45_MAIN, 'STAT_MIIST_WERT'),
          logComfortRow(
            'Vehicle speed',
            'km/h',
            LOG_MS45_MAIN,
            'STAT_VFZG_WERT'
          ),
          logComfortRow('Battery voltage', 'V', LOG_MS45_MAIN, 'STAT_UB_WERT'),
        ],
      },
      {
        name: 'Temperatures',
        rows: [
          logComfortRow('Coolant', '°C', LOG_MS45_MAIN, 'STAT_TMOT_WERT'),
          logComfortRow(
            'Radiator outlet',
            '°C',
            LOG_MS45_MAIN,
            'STAT_TKA_WERT'
          ),
          logComfortRow('Intake air', '°C', LOG_MS45_MAIN, 'STAT_TANS_WERT'),
          logComfortRow('Oil', '°C', LOG_MS45_COMMON, 'STAT_TOIL_WERT'),
          ...[1, 2].map((b) =>
            logComfortRow(
              `Exhaust before cat, bank ${b} (modelled)`,
              '°C',
              LOG_MS45_PROBES,
              `STAT_TEG_CAT_UP_MDL_${b}_WERT`
            )
          ),
        ],
      },
      {
        name: 'Air and throttle',
        rows: [
          logComfortRow('Air mass', 'kg/h', LOG_MS45_MAIN, 'STAT_MSHFM_WERT'),
          logComfortRow(
            'Throttle position',
            '',
            LOG_MS45_MAIN,
            'STAT_WDKBA_WERT'
          ),
          logComfortRow(
            'Throttle target',
            '',
            LOG_MS45_EXTRA,
            'STAT_TPS_SP_WERT'
          ),
          logComfortRow(
            'Accelerator pedal',
            '',
            LOG_MS45_EXTRA,
            'STAT_PV_AV_RAW_WERT'
          ),
          logComfortRow(
            'Pedal sensor voltage',
            'V',
            LOG_MS45_MAIN,
            'STAT_UPWG_WERT'
          ),
          logComfortRow(
            'Ambient pressure',
            'hPa',
            LOG_MS45_COMMON,
            'STAT_AMP_WERT'
          ),
        ],
      },
      {
        name: 'O2 sensors',
        rows: [
          ...[1, 2].map((b) =>
            logComfortRow(
              `O2 sensor front, bank ${b}`,
              'V',
              LOG_MS45_PROBES,
              `STAT_VLS_UP_${b}_WERT`
            )
          ),
          ...[1, 2].map((b) =>
            logComfortRow(
              `O2 sensor rear, bank ${b}`,
              'V',
              LOG_MS45_PROBES,
              `STAT_VLS_DOWN_${b}_WERT`
            )
          ),
          ...[1, 2].map((b) =>
            logComfortRow(
              `O2 heater front, bank ${b}`,
              '%',
              LOG_MS45_COMMON,
              `STAT_LSHPWM_UP_${b}_WERT`
            )
          ),
          ...[1, 2].map((b) =>
            logComfortRow(
              `O2 sensor tip temperature, bank ${b}`,
              '°C',
              LOG_MS45_COMMON,
              `STAT_TTIP_LS_UP_MES_${b}_WERT`
            )
          ),
        ],
      },
      {
        name: 'Fuel',
        rows: [
          logComfortRow('Injection time', 'ms', LOG_MS45_MAIN, 'STAT_TE_WERT'),
          logComfortRow(
            'Lambda control, bank 1',
            '',
            LOG_MS45_MAIN,
            'STAT_FR_WERT'
          ),
          logComfortRow(
            'Lambda control, bank 2',
            '',
            LOG_MS45_MAIN,
            'STAT_FR2_WERT'
          ),
          ...[1, 2].map((b) =>
            logComfortRow(
              `Fuel trim at idle, bank ${b}`,
              'mg/stroke',
              LOG_MS45_COMMON,
              `STAT_MFF_AD_ADD_MMV_${b}_WERT`
            )
          ),
          ...[1, 2].map((b) =>
            logComfortRow(
              `Fuel trim lower range, bank ${b}`,
              '%',
              LOG_MS45_COMMON,
              `STAT_MFF_AD_FAC_MMV_L_${b}_WERT`
            )
          ),
          ...[1, 2].map((b) =>
            logComfortRow(
              `Fuel trim upper range, bank ${b}`,
              '%',
              LOG_MS45_COMMON,
              `STAT_MFF_AD_FAC_MMV_H_${b}_WERT`
            )
          ),
        ],
      },
      {
        name: 'Ignition and knock',
        rows: [
          logComfortRow(
            'Ignition timing',
            '°',
            LOG_MS45_MAIN,
            'STAT_ZWOUT_WERT'
          ),
          logComfortRow(
            'Fuel quality adaptation',
            '',
            LOG_MS45_COMMON,
            'STAT_FAC_RON_AD_WERT'
          ),
          ...LOG_MS45_CYLINDERS.map((c) =>
            logComfortRow(
              `Knock sensor level, cylinder ${c}`,
              '',
              LOG_MS45_MAIN,
              `STAT_RKRN${c}_WERT`
            )
          ),
        ],
      },
      {
        name: 'VANOS',
        rows: [
          logComfortRow(
            'Intake camshaft',
            '°',
            LOG_MS45_MAIN,
            'STAT_WNWKWE_WERT'
          ),
          logComfortRow(
            'Exhaust camshaft',
            '°',
            LOG_MS45_MAIN,
            'STAT_WNWKWA_WERT'
          ),
        ],
      },
      {
        name: 'Smooth running',
        rows: LOG_MS45_CYLINDERS.map((c) =>
          logComfortRow(
            `Roughness, cylinder ${c}`,
            '',
            LOG_MS45_ROUGH,
            `STAT_ZYL${c}_WERT`
          )
        ),
      },
    ],
  },
};

/**
 * The comfort list for a chassis: the first of its modules that has one.
 * @template {{sgbd: string}} M
 * @param {M[]} modules - The chassis's modules (logModulesFor).
 * @returns {{mod: M, title: string, groups: Array<{name: string, rows: ComfortRow[]}>}|null}
 */
function logComfortFor(modules) {
  for (const mod of modules || []) {
    const list = LOG_COMFORT[String(mod.sgbd).toLowerCase()];
    if (list) return { mod, title: list.title, groups: list.groups };
  }
  return null;
}

/**
 * The plain name of a reading, when a comfort list names it.
 * @param {string} sgbd
 * @param {string} job
 * @param {string} key
 * @returns {string} '' when no list does.
 */
function logComfortLabel(sgbd, job, key) {
  const list = LOG_COMFORT[String(sgbd).toLowerCase()];
  if (!list) return '';
  for (const g of list.groups)
    for (const r of g.rows) if (r.job === job && r.key === key) return r.label;
  return '';
}

const LOG_COMFORT_MODE_KEY = 'bmweb.logging.comfort';

/**
 * Whether the picker opens on the comfort list (it does until told not to).
 * @returns {boolean}
 */
function logComfortModeGet() {
  try {
    return localStorage.getItem(LOG_COMFORT_MODE_KEY) !== '0';
  } catch (e) {
    return true;
  }
}

/**
 * Remember which picker the reader chose.
 * @param {boolean} on - Comfort (true) or everything (false).
 * @returns {void}
 */
function logComfortModeSet(on) {
  try {
    localStorage.setItem(LOG_COMFORT_MODE_KEY, on ? '1' : '0');
  } catch (e) {
    // a private window: the choice lasts as long as the page
  }
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LOG_COMFORT, logComfortFor, logComfortLabel };
}
