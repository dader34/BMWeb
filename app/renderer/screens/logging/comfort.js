/**
 * @file Data logging: Comfort mode -- a short list of readings under plain
 * names, for a control unit whose values are known well enough to name.
 *
 * The picker tree (picker.js) offers everything a module declares, under the
 * SGBD's own job and register names. That is the whole truth and no way to
 * find the front oxygen sensor. A comfort list is a hand-made index over the
 * same thing, one per control unit: an E46 was built with a dozen engine
 * control units, their jobs differ, and a list written for one names nothing
 * on another.
 *
 * A row is read one of two ways. On the MS42 and MS43 it is one register of
 * one job, exactly what the tree would have selected. On the MS45 it is one
 * of the DME's own measurement values (packet.js): whatever is ticked there
 * is fetched together in a single exchange, so the rate does not fall as
 * readings are added.
 */

/* exported logComfortLists, logComfortLabel, logComfortValueFor, logComfortModeGet, logComfortModeSet, logComfortEcuGet, logComfortEcuSet */

/**
 * @typedef {Object} ComfortRow
 * @property {string} label - What the reading is, in plain words.
 * @property {string} unit - Its unit, shown beside the name ('' when the
 *   control unit names it itself, with the value).
 * @property {string} job - The job that reads it (LOG_PACKET_JOB for a
 *   measurement value).
 * @property {string} key - The result register holding it.
 * @property {{id: number, mul: number, add: number, signed: boolean}} [value] -
 *   A measurement value: its identifier and how its 16 bits become the figure.
 */

/**
 * A row read by a job.
 * @param {string} label
 * @param {string} unit
 * @param {string} job
 * @param {string} key
 * @returns {ComfortRow}
 */
const logComfortRow = (label, unit, job, key) => ({ label, unit, job, key });

/**
 * A row read as one of the DME's measurement values. The scaling is the
 * SGBD's own (its table of these values): figure = word * mul + add.
 * @param {string} label
 * @param {string} unit
 * @param {number} id - The value's identifier (0x4100..0x41FF).
 * @param {number} mul
 * @param {number} add
 * @param {boolean} signed - The word is two's complement.
 * @returns {ComfortRow}
 */
const logComfortValue = (label, unit, id, mul, add, signed) => ({
  label,
  unit,
  job: LOG_PACKET_JOB,
  key: logPacketKey(id),
  value: { id, mul, add, signed },
});

const LOG_CYLINDERS = [1, 2, 3, 4, 5, 6];
const LOG_BANKS = [1, 2];

// ---- MS43 (M54): most of it is one job, the measurement block ----------------
const LOG_MS43_BLOCK = 'STATUS_MESSWERTEBLOCK';
/**
 * A register of the MS43's measurement block.
 * @param {string} label
 * @param {string} name - The register's middle: STAT_<name>_MWB_WERT.
 * @returns {ComfortRow}
 */
const logMs43 = (label, name) =>
  logComfortRow(label, '', LOG_MS43_BLOCK, `STAT_${name}_MWB_WERT`);

/**
 * A job that answers with the one register named after it.
 * @param {string} label
 * @param {string} name - STATUS_<name> and STAT_<name>_WERT.
 * @returns {ComfortRow}
 */
const logOwnJob = (label, name) =>
  logComfortRow(label, '', `STATUS_${name}`, `STAT_${name}_WERT`);

/** The comfort lists, by SGBD (lower case). */
const LOG_COMFORT = {
  ms450ds0: {
    title: 'MS45',
    groups: [
      {
        name: 'Engine',
        rows: [
          logComfortValue('Engine speed', 'rpm', 0x4111, 0.125, 0, false),
          logComfortValue('Idle speed target', 'rpm', 0x4119, 1.0, 0, false),
          logComfortValue('Engine load', '%', 0x4113, 0.002929688, 0, false),
          logComfortValue(
            'Calculated load',
            '%',
            0x4104,
            0.001531863,
            0,
            false
          ),
          logComfortValue('Engine torque', 'Nm', 0x41d1, 0.03125, 0, true),
          logComfortValue(
            'Torque requested at the clutch',
            'Nm',
            0x4191,
            0.03125,
            0,
            true
          ),
          logComfortValue('Engine torque loss', 'Nm', 0x4172, 0.03125, 0, true),
          logComfortValue(
            'Vehicle speed',
            'km/h',
            0x410d,
            0.00390625,
            0,
            false
          ),
          logComfortValue(
            'Gear (calculated)',
            '',
            0x4181,
            0.00390625,
            0,
            false
          ),
          logComfortValue(
            'Battery voltage',
            'V',
            0x413c,
            0.000396729,
            0,
            false
          ),
          logComfortValue('Time since start', 's', 0x418b, 0.1, 0, false),
        ],
      },
      {
        name: 'Temperatures',
        rows: [
          logComfortValue('Coolant', '°C', 0x411f, 0.002929688, -48, false),
          logComfortValue(
            'Radiator outlet',
            '°C',
            0x4120,
            0.002929688,
            -48,
            false
          ),
          logComfortValue('Intake air', '°C', 0x411e, 0.002929688, -48, false),
          logComfortValue('Oil', '°C', 0x4122, 0.00390625, -40, false),
          logComfortValue('Ambient', '°C', 0x4124, 0.002929688, -48, false),
          logComfortValue(
            'Control unit',
            '°C',
            0x4121,
            0.002929688,
            -48,
            false
          ),
          logComfortValue('Exhaust (modelled)', '°C', 0x417e, 0.0625, 0, false),
          logComfortValue(
            'Coolant at start',
            '°C',
            0x4182,
            0.002929688,
            -48,
            false
          ),
        ],
      },
      {
        name: 'Air and throttle',
        rows: [
          logComfortValue('Air mass', 'kg/h', 0x4112, 0.03125, 0, false),
          logComfortValue(
            'Air per stroke',
            'mg/stroke',
            0x4118,
            0.021194458,
            0,
            false
          ),
          logComfortValue(
            'Throttle position',
            '°',
            0x4158,
            0.007293701,
            0,
            false
          ),
          logComfortValue(
            'Throttle target',
            '°',
            0x413f,
            0.007293701,
            0,
            false
          ),
          logComfortValue(
            'Accelerator pedal',
            '%',
            0x4114,
            0.001525879,
            0,
            false
          ),
          logComfortValue(
            'Pedal sensor 1 voltage',
            'V',
            0x4146,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'Pedal sensor 2 voltage',
            'V',
            0x4147,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'Air mass sensor voltage',
            'V',
            0x414f,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'Ambient pressure',
            'hPa',
            0x4134,
            0.08291626,
            0,
            false
          ),
          logComfortValue(
            'Idle valve duty',
            '%',
            0x41a7,
            0.001525879,
            0,
            false
          ),
          logComfortValue(
            'Electric fan duty',
            '%',
            0x417f,
            0.001525879,
            0,
            false
          ),
        ],
      },
      {
        name: 'O2 sensors',
        rows: [
          logComfortValue(
            'O2 sensor front, bank 1',
            'V',
            0x4145,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'O2 sensor front, bank 2',
            'V',
            0x4148,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'O2 sensor rear, bank 1',
            'V',
            0x4149,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'O2 sensor rear, bank 2',
            'V',
            0x414b,
            7.629e-5,
            0,
            false
          ),
          logComfortValue('Lambda, bank 1', '', 0x4189, 3.05176e-5, 0, false),
          logComfortValue('Lambda, bank 2', '', 0x418a, 3.05176e-5, 0, false),
          logComfortValue(
            'Lambda target, bank 1',
            '',
            0x4171,
            3.05176e-5,
            0,
            false
          ),
          logComfortValue(
            'Lambda target, bank 2',
            '',
            0x4173,
            3.05176e-5,
            0,
            false
          ),
          logComfortValue(
            'O2 heater front, bank 1',
            '%',
            0x4127,
            0.001525879,
            0,
            false
          ),
          logComfortValue(
            'O2 heater front, bank 2',
            '%',
            0x4128,
            0.001525879,
            0,
            false
          ),
          logComfortValue(
            'O2 heater rear, bank 1',
            '%',
            0x4129,
            0.001525879,
            0,
            false
          ),
          logComfortValue(
            'O2 heater rear, bank 2',
            '%',
            0x412a,
            0.001525879,
            0,
            false
          ),
          logComfortValue(
            'O2 sensor tip temperature, bank 1',
            '°C',
            0x418c,
            0.0625,
            0,
            true
          ),
          logComfortValue(
            'O2 sensor tip temperature, bank 2',
            '°C',
            0x418f,
            0.0625,
            0,
            true
          ),
        ],
      },
      {
        name: 'Fuel',
        rows: [
          logComfortValue('Injection time', 'ms', 0x4115, 0.004, 0, false),
          logComfortValue(
            'Lambda control, bank 1',
            '%',
            0x4116,
            0.001525879,
            0,
            true
          ),
          logComfortValue(
            'Lambda control, bank 2',
            '%',
            0x4117,
            0.001525879,
            0,
            true
          ),
          logComfortValue(
            'Lambda integrator, bank 1',
            '%',
            0x4106,
            0.003051758,
            -100,
            false
          ),
          logComfortValue(
            'Lambda integrator, bank 2',
            '%',
            0x4108,
            0.003051758,
            -100,
            false
          ),
          logComfortValue(
            'Fuel trim, bank 1',
            '%',
            0x4107,
            0.003051758,
            -100,
            false
          ),
          logComfortValue(
            'Fuel trim, bank 2',
            '%',
            0x4109,
            0.003051758,
            -100,
            false
          ),
          logComfortValue(
            'Fuel demand to the pump',
            'l/h',
            0x41af,
            0.00390625,
            0,
            false
          ),
          logComfortValue('Fuel tank level', 'l', 0x413b, 0.00390625, 0, false),
        ],
      },
      {
        name: 'Ignition and knock',
        rows: [
          logComfortValue(
            'Ignition timing',
            '°',
            0x4125,
            0.001464844,
            -35.625,
            false
          ),
          logComfortValue(
            'Knock sensor voltage, cylinder 1',
            'V',
            0x4183,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'Knock sensor voltage, cylinder 2',
            'V',
            0x4187,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'Knock sensor voltage, cylinder 3',
            'V',
            0x4185,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'Knock sensor voltage, cylinder 4',
            'V',
            0x4188,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'Knock sensor voltage, cylinder 5',
            'V',
            0x4184,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'Knock sensor voltage, cylinder 6',
            'V',
            0x4186,
            7.629e-5,
            0,
            false
          ),
          logComfortValue(
            'Spark duration, cylinder 1',
            'ms',
            0x41b1,
            0.004,
            0,
            false
          ),
          logComfortValue(
            'Spark duration, cylinder 2',
            'ms',
            0x41b5,
            0.004,
            0,
            false
          ),
          logComfortValue(
            'Spark duration, cylinder 3',
            'ms',
            0x41b3,
            0.004,
            0,
            false
          ),
          logComfortValue(
            'Spark duration, cylinder 4',
            'ms',
            0x41b6,
            0.004,
            0,
            false
          ),
          logComfortValue(
            'Spark duration, cylinder 5',
            'ms',
            0x41b2,
            0.004,
            0,
            false
          ),
          logComfortValue(
            'Spark duration, cylinder 6',
            'ms',
            0x41b4,
            0.004,
            0,
            false
          ),
        ],
      },
      {
        name: 'VANOS',
        rows: [
          logComfortValue(
            'Intake camshaft',
            '°',
            0x411a,
            0.001464844,
            60,
            false
          ),
          logComfortValue(
            'Intake camshaft target',
            '°',
            0x411b,
            0.001464844,
            60,
            false
          ),
          logComfortValue(
            'Exhaust camshaft',
            '°',
            0x411c,
            -0.001464844,
            -40,
            false
          ),
          logComfortValue(
            'Exhaust camshaft target',
            '°',
            0x411d,
            -0.001464844,
            -40,
            false
          ),
        ],
      },
      {
        name: 'Smooth running',
        rows: [
          logComfortValue(
            'Roughness, cylinder 1',
            '',
            0x419d,
            0.000244141,
            0,
            true
          ),
          logComfortValue(
            'Roughness, cylinder 2',
            '',
            0x41a1,
            0.000244141,
            0,
            true
          ),
          logComfortValue(
            'Roughness, cylinder 3',
            '',
            0x419f,
            0.000244141,
            0,
            true
          ),
          logComfortValue(
            'Roughness, cylinder 4',
            '',
            0x41a2,
            0.000244141,
            0,
            true
          ),
          logComfortValue(
            'Roughness, cylinder 5',
            '',
            0x419e,
            0.000244141,
            0,
            true
          ),
          logComfortValue(
            'Roughness, cylinder 6',
            '',
            0x41a0,
            0.000244141,
            0,
            true
          ),
          logComfortValue(
            'Misfires, cylinder 1',
            '',
            0x41a3,
            0.015625,
            0,
            false
          ),
          logComfortValue(
            'Misfires, cylinder 2',
            '',
            0x41fd,
            0.015625,
            0,
            false
          ),
          logComfortValue(
            'Misfires, cylinder 3',
            '',
            0x41a9,
            0.015625,
            0,
            false
          ),
          logComfortValue(
            'Misfires, cylinder 4',
            '',
            0x41fe,
            0.015625,
            0,
            false
          ),
          logComfortValue(
            'Misfires, cylinder 5',
            '',
            0x41a4,
            0.015625,
            0,
            false
          ),
          logComfortValue(
            'Misfires, cylinder 6',
            '',
            0x41aa,
            0.015625,
            0,
            false
          ),
        ],
      },
    ],
  },
  ms430ds0: {
    title: 'MS43',
    groups: [
      {
        name: 'Engine',
        rows: [
          logMs43('Engine speed', 'MOTORDREHZAHL'),
          logMs43('Engine load', 'LAST'),
          logMs43('Vehicle speed', 'GESCHWINDIGKEIT'),
          logMs43('Battery voltage', 'UBATT'),
          logMs43('Ignition voltage', 'KL15'),
        ],
      },
      {
        name: 'Temperatures',
        rows: [
          logMs43('Coolant', 'MOTORTEMP'),
          logMs43('Radiator outlet', 'KUEHLW_AUSL_TEMP'),
          logMs43('Intake air', 'AN_LUFTTEMP'),
          logMs43('Oil', 'OEL_TEMP'),
        ],
      },
      {
        name: 'Air and throttle',
        rows: [
          logMs43('Air mass', 'LMM_MASSE'),
          logMs43('Throttle position', 'DKP_WINKEL'),
          logMs43('Accelerator pedal', 'PWG_WINKEL'),
          logMs43('Ambient pressure', 'LUFTDRUCK'),
          logMs43('Idle valve duty', 'LL_STELLER_TV'),
          logMs43('Idle integrator', 'LL_INTEGRATOR'),
          logMs43(
            'Fan speed asked for by the A/C',
            'DREHZAHL_E_LUEFTER_VON_AC'
          ),
        ],
      },
      {
        name: 'O2 sensors',
        rows: [
          ...LOG_BANKS.map((b) =>
            logOwnJob(`O2 sensor front, bank ${b}`, `LS_VKAT_SIGNAL_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logOwnJob(`O2 sensor rear, bank ${b}`, `LS_NKAT_SIGNAL_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logMs43(`O2 heater front, bank ${b}`, `LS_VKAT_HEIZUNG_TV_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logMs43(`O2 heater rear, bank ${b}`, `LS_NKAT_HEIZUNG_TV_${b}`)
          ),
        ],
      },
      {
        name: 'Fuel',
        rows: [
          logMs43('Injection time', 'EINSPRITZZEIT'),
          ...LOG_BANKS.map((b) =>
            logMs43(`Lambda control, bank ${b}`, `LAMBDA_INTEGRATOR_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logOwnJob(`Fuel trim at idle, bank ${b}`, `LAMBDA_ADD_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logOwnJob(`Fuel trim, bank ${b}`, `LAMBDA_MUL_${b}`)
          ),
        ],
      },
      {
        name: 'Ignition and knock',
        rows: [
          logMs43('Ignition timing', 'ZUENDWINKEL'),
          logMs43('Knock sensor, cylinder 2', 'K_MW_2'),
          logMs43('Knock sensor, cylinder 5', 'K_MW_5'),
        ],
      },
      {
        name: 'VANOS',
        rows: [
          logMs43('Intake camshaft', 'VANOS_NW_LAGE_EINLASS'),
          logMs43('Exhaust camshaft', 'VANOS_NW_LAGE_AUSLASS'),
          logComfortRow(
            'Intake camshaft target',
            '',
            'STATUS_VANOS_NW_LAGE_IST_SOLL_REF_EINLASS',
            'STAT_VANOS_NW_LAGE_EINLASS_SOLL_WERT'
          ),
          logComfortRow(
            'Exhaust camshaft target',
            '',
            'STATUS_VANOS_NW_LAGE_IST_SOLL_REF_AUSLASS',
            'STAT_VANOS_NW_LAGE_AUSLASS_SOLL_WERT'
          ),
        ],
      },
      {
        name: 'Smooth running',
        rows: [
          ...LOG_CYLINDERS.map((c) =>
            logComfortRow(
              `Roughness, cylinder ${c}`,
              '',
              'STATUS_SYSTEMCHECK_LAUFUNRUHE',
              `STAT_SYSTEMCHECK_LAUFUNRUHE_ZYL${c}_WERT`
            )
          ),
          ...LOG_CYLINDERS.map((c) =>
            logComfortRow(
              `Misfires, cylinder ${c}`,
              '',
              'STATUS_SYSTEMCHECK_LAUFUNRUHE',
              `STAT_SYSTEMCHECK_ANZ_VERBRENNUNGSAUSSETZER_ZYL${c}_WERT`
            )
          ),
        ],
      },
    ],
  },
  // ---- MS42 (M52TU): one job to a reading, so each one ticked costs a turn ----
  ms420ds0: {
    title: 'MS42',
    groups: [
      {
        name: 'Engine',
        rows: [
          logOwnJob('Engine speed', 'MOTORDREHZAHL'),
          logOwnJob('Engine load', 'LAST'),
          logOwnJob('Vehicle speed', 'GESCHWINDIGKEIT'),
          logOwnJob('Battery voltage', 'UBATT'),
        ],
      },
      {
        name: 'Temperatures',
        rows: [
          logOwnJob('Coolant', 'MOTORTEMPERATUR_MWB'),
          logOwnJob('Radiator outlet', 'KUEHLW_AUSL_TEMPERATUR_MWB'),
          logOwnJob('Intake air', 'AN_LUFTTEMPERATUR_MWB'),
          logOwnJob('Oil', 'OEL_TEMPERATUR_MWB'),
        ],
      },
      {
        name: 'Air and throttle',
        rows: [
          logOwnJob('Air mass', 'LMM_MASSE'),
          logOwnJob('Throttle position', 'DKP_WINKEL'),
          logOwnJob('Accelerator pedal', 'PWG_WINKEL'),
          logOwnJob('Idle valve duty', 'LL_STELLER_TV'),
          logOwnJob('Idle integrator', 'LL_INTEGRATOR'),
          logOwnJob(
            'Fan speed asked for by the A/C',
            'DREHZAHL_E_LUEFTER_VON_AC'
          ),
        ],
      },
      {
        name: 'O2 sensors',
        rows: [
          ...LOG_BANKS.map((b) =>
            logOwnJob(`O2 sensor front, bank ${b}`, `LS_VKAT_SIGNAL_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logOwnJob(`O2 sensor rear, bank ${b}`, `LS_NKAT_SIGNAL_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logOwnJob(`O2 heater front, bank ${b}`, `LS_VKAT_HEIZUNG_TV_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logOwnJob(`O2 heater rear, bank ${b}`, `LS_NKAT_HEIZUNG_TV_${b}`)
          ),
        ],
      },
      {
        name: 'Fuel',
        rows: [
          logOwnJob('Injection time', 'EINSPRITZZEIT'),
          ...LOG_BANKS.map((b) =>
            logOwnJob(`Lambda control, bank ${b}`, `LAMBDA_INTEGRATOR_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logOwnJob(`Fuel trim at idle, bank ${b}`, `LAMBDA_ADD_${b}`)
          ),
          ...LOG_BANKS.map((b) =>
            logOwnJob(`Fuel trim, bank ${b}`, `LAMBDA_MUL_${b}`)
          ),
        ],
      },
      {
        name: 'Ignition and knock',
        rows: [
          logOwnJob('Ignition timing', 'ZUENDWINKEL'),
          logOwnJob('Knock adaptation', 'KR_ADAP'),
          logOwnJob('Knock sensor 1 voltage', 'KLOPF_ADC1'),
          logOwnJob('Knock sensor 2 voltage', 'KLOPF_ADC2'),
        ],
      },
      {
        name: 'VANOS',
        rows: [
          ...[
            ['EINLASS', 'Intake'],
            ['AUSLASS', 'Exhaust'],
          ].flatMap(([side, name]) => [
            logComfortRow(
              `${name} camshaft`,
              '',
              `STATUS_VANOS_NW_LAGE_${side}`,
              `STAT_VANOS_NW_LAGE_${side}_IST_WERT`
            ),
            logComfortRow(
              `${name} camshaft target`,
              '',
              `STATUS_VANOS_NW_LAGE_${side}`,
              `STAT_VANOS_NW_LAGE_${side}_SOLL_WERT`
            ),
          ]),
        ],
      },
      {
        name: 'Smooth running',
        rows: LOG_CYLINDERS.map((c) =>
          logComfortRow(
            `Roughness, cylinder ${c}`,
            '',
            'STATUS_SYSTEMCHECK_LAUFUNRUHE',
            `STAT_SYSTEMCHECK_LAUFUNRUHE_ZYL${c}_WERT`
          )
        ),
      },
    ],
  },
};

/**
 * Every comfort list a chassis's modules have, in the chassis's own order.
 * @template {{sgbd: string}} M
 * @param {M[]} modules - The chassis's modules (logModulesFor).
 * @returns {Array<{mod: M, sgbd: string, title: string, groups: Array<{name: string, rows: ComfortRow[]}>}>}
 */
function logComfortLists(modules) {
  const out = [];
  for (const mod of modules || []) {
    const sgbd = String(mod.sgbd).toLowerCase();
    const list = LOG_COMFORT[sgbd];
    if (list && !out.some((l) => l.sgbd === sgbd))
      out.push({ mod, sgbd, title: list.title, groups: list.groups });
  }
  return out;
}

/**
 * One row of a comfort list, by what it reads.
 * @param {string} sgbd
 * @param {string} job
 * @param {string} key
 * @returns {ComfortRow|null}
 */
function logComfortFind(sgbd, job, key) {
  const list = LOG_COMFORT[String(sgbd).toLowerCase()];
  if (!list) return null;
  for (const g of list.groups)
    for (const r of g.rows) if (r.job === job && r.key === key) return r;
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
  const r = logComfortFind(sgbd, job, key);
  return r ? r.label : '';
}

/**
 * The measurement value behind a packet key: what to ask the DME for and
 * how to scale it.
 * @param {string} sgbd
 * @param {string} key - logPacketKey(id).
 * @returns {{id: number, mul: number, add: number, signed: boolean, unit: string}|null}
 */
function logComfortValueFor(sgbd, key) {
  const r = logComfortFind(sgbd, LOG_PACKET_JOB, key);
  return r && r.value ? { ...r.value, unit: r.unit } : null;
}

const LOG_COMFORT_MODE_KEY = 'bmweb.logging.comfort';
const LOG_COMFORT_ECU_KEY = 'bmweb.logging.comfortEcu';

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

/**
 * The control unit whose list was last shown for a chassis.
 * @param {string} chassis
 * @returns {string} Its SGBD, or ''.
 */
function logComfortEcuGet(chassis) {
  try {
    return localStorage.getItem(`${LOG_COMFORT_ECU_KEY}.${chassis}`) || '';
  } catch (e) {
    return '';
  }
}

/**
 * Remember the control unit picked (or detected) for a chassis.
 * @param {string} chassis
 * @param {string} sgbd
 * @returns {void}
 */
function logComfortEcuSet(chassis, sgbd) {
  try {
    localStorage.setItem(`${LOG_COMFORT_ECU_KEY}.${chassis}`, sgbd);
  } catch (e) {
    // a private window: the choice lasts as long as the page
  }
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LOG_COMFORT,
    logComfortLists,
    logComfortLabel,
    logComfortValueFor,
  };
}
