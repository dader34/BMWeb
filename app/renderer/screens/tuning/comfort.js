/**
 * @file Tuning screen: Comfort mode -- the definition tree as a short list
 * of subjects under plain names.
 *
 * A definition lists every parameter the program has, under the program's
 * own symbol names: 5,700 rows, and the rev limit is `id_n_max_mt`. A
 * comfort list is a hand-made index over the same definition -- "Rev limits"
 * holds the handful of parameters that set them, each under a name that says
 * what it does. Every entry is still one item of the open definition, found
 * by its symbol name, so it opens, edits and goes live exactly as its row in
 * the full tree does. An entry the open definition does not carry is left
 * out; a definition that carries too few gets no comfort list at all.
 */

/* exported tnComfortFor, tnComfortModeGet, tnComfortModeSet, tnRenderComfortList */

/**
 * @typedef {Object} ComfortSubject
 * @property {string} name - The subject, e.g. "Rev limits".
 * @property {Array<[string, string]>} items - [symbol name, plain name].
 */

/** The fewest entries a definition must carry for the list to be offered. */
const TN_COMFORT_MIN = 12;

const TN_COMFORT_GEARBOXES = [
  ['mt', 'manual'],
  ['at', 'automatic'],
  ['amt', 'SMG'],
];
const TN_COMFORT_CAMS = [
  ['in', 'Intake'],
  ['ex', 'Exhaust'],
];

/**
 * The target-angle maps of one camshaft, both thermal conditions.
 * @param {string} cam - 'in' or 'ex'.
 * @param {string} name - 'Intake' or 'Exhaust'.
 * @returns {Array<[string, string]>}
 */
const tnComfortCamItems = (cam, name) =>
  [1, 2].flatMap((c) => [
    [
      `ip_cam_sp_${c}_${cam}_is__n__maf_ivvt`,
      `${name} cam at idle, condition ${c}`,
    ],
    [
      `ip_cam_sp_${c}_${cam}_pl__n__maf_ivvt`,
      `${name} cam at part load, condition ${c}`,
    ],
    [`ip_cam_sp_${c}_${cam}_fl__n`, `${name} cam at full load, condition ${c}`],
  ]);

/**
 * The comfort list of the Siemens MS45 program (M54/M56).
 * @type {Array<{name: string, subjects: ComfortSubject[]}>}
 */
const TN_COMFORT_MS45 = [
  {
    name: 'Main parameters',
    subjects: [
      {
        name: 'Rev limits',
        items: [
          ...TN_COMFORT_GEARBOXES.map(([g, n]) => [
            `id_n_max_${g}`,
            `Rev limit, ${n}`,
          ]),
          ...TN_COMFORT_GEARBOXES.map(([g, n]) => [
            `id_n_max_h_${g}`,
            `Raised rev limit, ${n}`,
          ]),
          ...TN_COMFORT_GEARBOXES.map(([g, n]) => [
            `id_t_n_max_h_${g}`,
            `Time allowed at the raised limit, ${n}`,
          ]),
          ...TN_COMFORT_GEARBOXES.map(([g, n]) => [
            `id_n_dec_n_max_h_${g}`,
            `Step back to the normal limit, ${n}`,
          ]),
          ...TN_COMFORT_GEARBOXES.map(([g, n]) => [
            `c_vs_thd_n_max_h_${g}`,
            `Road speed for the raised limit, ${n}`,
          ]),
          ['c_n_max_dri_rvl', 'Rev limit in reverse, automatic'],
          ['c_add_n_max_fcut', 'Full fuel cut this far above the limit'],
          ['ip_n_max_1__toil', 'Rev limit by oil temperature, warning'],
          ['ip_n_max_2__toil', 'Rev limit by oil temperature, red line'],
        ],
      },
      {
        name: 'Rev limiter response',
        items: [
          ['id_fac_n_max_p_mt__gear', 'Limiter strength by gear, manual'],
          ['id_fac_n_max_i_mt__gear', 'Limiter build-up by gear, manual'],
          ['id_t_n_max_pred_mt__gear', 'Limiter look-ahead by gear, manual'],
          ['id_fac_n_max_p_at__gear', 'Limiter strength by gear, automatic'],
          ['id_fac_n_max_i_at__gear', 'Limiter build-up by gear, automatic'],
          ['id_t_n_max_pred_at__gear', 'Limiter look-ahead by gear, automatic'],
          ['lc_inh_fcut_n_max', 'No fuel cut at the rev limit'],
        ],
      },
      {
        name: 'Speed limiter',
        items: [
          ['c_vs_max', 'Top speed limit'],
          ['c_vs_max_amt', 'Top speed limit, SMG'],
          ['c_vs_max_hys', 'Speed limit hysteresis'],
        ],
      },
      {
        name: 'Idle target',
        items: [
          ['ip_n_sp_is', 'Idle speed'],
          ['ip_acin_n_sp_is', 'Idle speed, A/C on'],
          ['ip_dri_n_sp_is', 'Idle speed in Drive'],
          ['ip_dri_acin_n_sp_is', 'Idle speed in Drive, A/C on'],
          ['ip_n_sp_is_cs', 'Idle speed while pulling away'],
          ['ip_t_dly_n_sp_is__toil', 'Delay before the idle target changes'],
          ['ip_tq_add_is_bol_bas', 'Torque reserve at idle'],
          ['lc_n_ofs_kwp_disable', 'Ignore idle offset set by a tester'],
        ],
      },
      {
        name: 'Overrun fuel cut',
        items: [
          ['ip_n_min_puc__tco__gr_mt', 'Fuel cut above this speed, manual'],
          ['ip_n_min_puc__tco__gr_at', 'Fuel cut above this speed, automatic'],
          [
            'ip_n_accout_min_puc__tco__gr_mt',
            'Fuel cut above this speed, A/C on, manual',
          ],
          [
            'ip_n_accout_min_puc__tco__gr_at',
            'Fuel cut above this speed, A/C on, automatic',
          ],
          ['id_n_hys_max_puc__gr_mt', 'Fuel cut hysteresis, manual'],
          ['id_n_hys_max_puc__gr_at', 'Fuel cut hysteresis, automatic'],
        ],
      },
    ],
  },
  {
    name: 'Throttle and torque',
    subjects: [
      {
        name: 'Pedal response',
        items: [
          ['ip_fac_tq_req_driv', 'Pedal to torque request'],
          ['ip_fac_tq_req_driv_rng_l', 'Pedal to torque request, low range'],
          ['c_fac_tq_req_driv_mmv', 'Pedal smoothing'],
          ['ip_pv_max_fl__n', 'Pedal position that counts as full load'],
          ['lc_var_sof_swi', 'Sport button fitted'],
        ],
      },
      {
        name: 'Torque limits',
        items: [
          ['id_tq_p_max_mt', 'Torque limit by gear, manual'],
          ['id_tq_p_max_at', 'Torque limit by gear, automatic'],
          ['lc_tqi_p_max_inh_as', 'Torque limit off (0 = limit on)'],
        ],
      },
      {
        name: 'Traction and stability',
        items: [
          ['lc_asr_disable', 'Ignore traction control torque cuts'],
          ['lc_msr_disable', 'Ignore engine drag control'],
          ['lc_inh_fcut_asr', 'No fuel cut for traction control'],
          ['lc_inh_fcut_gs', 'No fuel cut for gear shifts'],
        ],
      },
      {
        name: 'Throttle at start',
        items: [
          ['ip_tps_sp_st', 'Throttle opening while cranking'],
          ['ip_tps_rel_st_mt', 'Start throttle, manual'],
          ['ip_tps_rel_st_at', 'Start throttle, automatic'],
          ['ip_tps_rel_st_pv', 'Start throttle by pedal'],
        ],
      },
    ],
  },
  {
    name: 'Fuel',
    subjects: [
      {
        name: 'Fuel pump',
        items: [
          ['c_t_efp_prev', 'Prime time at key on'],
          ['c_t_efp', 'Run-on after key off'],
          ['ip_t_efp_ast_max', 'Full-power time after start'],
          ['c_fup_nom', 'Nominal fuel pressure'],
          ['ip_fup_cor', 'Fuel pressure correction'],
        ],
      },
      {
        name: 'Lambda targets',
        items: [
          ['ip_lamb_fl__n', 'Full-load enrichment'],
          ['ip_lamb_bas_1', 'Base lambda target 1'],
          ['ip_lamb_bas_2', 'Base lambda target 2'],
          ['ip_lamb_cop', 'Catalyst overheat protection'],
        ],
      },
      {
        name: 'Warm-up and start',
        items: [
          ['ip_lamb_bas_wup_cor', 'Warm-up lambda correction'],
          ['ip_fac_lamb_wup', 'Warm-up enrichment'],
          ['ip_fac_lamb_wup_is', 'Warm-up enrichment at idle'],
          ['ip_fac_ti_tco_wup', 'Warm-up fuel factor'],
          ['ip_mff_cst', 'Cranking fuel'],
          ['ip_mffpr_cst', 'Priming pulse'],
          ['ip_ti_cast__tia__tco', 'After-start enrichment'],
          ['ip_ti_deac_cast__cyc_cast__tco', 'After-start enrichment fade-out'],
        ],
      },
      {
        name: 'Acceleration enrichment',
        items: [
          ['ip_ti_tco_pos_fast_wf__n__tco', 'Tip-in fuel, fast part'],
          ['ip_ti_tco_pos_slow_wf__n__tco', 'Tip-in fuel, total'],
          ['ip_ti_tco_neg_fast_wf__n__tco', 'Tip-out fuel, fast part'],
          ['ip_ti_tco_neg_slow_wf__n__tco', 'Tip-out fuel, total'],
        ],
      },
      {
        name: 'Injectors',
        items: [
          ['ip_ti_add_dly', 'Injector dead time'],
          ['ip_mff_cor_1', 'Fuel mass correction 1'],
          ['ip_mff_cor_2', 'Fuel mass correction 2'],
        ],
      },
    ],
  },
  {
    name: 'Ignition',
    subjects: [
      {
        name: 'Timing maps',
        items: [
          ['ip_iga_bas__n__maf', 'Base timing'],
          ['ip_iga_bas_ron_98__n__maf', 'Base timing, 98 octane'],
          ['ip_iga_bas_ron_91__n__maf', 'Base timing, 91 octane'],
          ['ip_iga_bas_add_max_ivvt__n__maf', 'Timing offset, most overlap'],
          ['ip_iga_bas_add_min_ivvt__n__maf', 'Timing offset, least overlap'],
          ['ip_iga_min_n_maf', 'Latest timing allowed'],
          ['ip_iga_st_bas', 'Timing while cranking'],
        ],
      },
      {
        name: 'Temperature corrections',
        items: [
          ['ip_iga_bas_temp_cor__tco__tia', 'Timing by coolant and intake air'],
          ['ip_iga_bas_lamb__lamb_sp', 'Timing by lambda target'],
        ],
      },
      {
        name: 'Knock control',
        items: [
          ['id_iga_dec_knk_1__n', 'Retard per knock, light'],
          ['id_iga_dec_knk_2__n', 'Retard per knock, heavy'],
          ['ip_iga_bas_max_knk__n__maf', 'Most retard allowed'],
          ['ip_maf_min_knk__n__tco', 'Load where knock control starts'],
        ],
      },
      {
        name: 'Coil dwell and multi-spark',
        items: [
          ['ip_td__vb', 'Dwell correction by battery voltage'],
          ['c_td_ini', 'Starting dwell time'],
          ['ip_nr_mpl_is', 'Sparks per firing at idle'],
          ['ip_nr_mpl_st', 'Sparks per firing while cranking'],
          ['ip_td_mpl', 'Dwell for the extra sparks'],
          ['c_n_max_ign_mpl', 'Multi-spark up to this engine speed'],
          ['c_tco_max_mpl_is', 'Multi-spark at idle up to this coolant'],
          ['c_tco_max_mpl_st', 'Multi-spark at start up to this coolant'],
        ],
      },
      {
        name: 'Catalyst heating',
        items: [
          ['ip_iga_ch_cold_is', 'Retarded timing, cold engine at idle'],
          ['ip_iga_ch_cold_pl', 'Retarded timing, cold engine driving'],
          ['ip_iga_ch_hot_is', 'Retarded timing, warm engine at idle'],
          ['ip_iga_ch_hot_pl', 'Retarded timing, warm engine driving'],
          ['ip_t_ch_tq_add', 'How long timing stays retarded'],
          ['ip_t_ch_n_sp_is', 'How long idle stays raised'],
          ['ip_t_ch_ivvt', 'How long VANOS stays in heating position'],
          ['lc_inh_tq_add_ch', 'Catalyst-heating torque reserve off'],
        ],
      },
    ],
  },
  {
    name: 'VANOS',
    subjects: [
      ...TN_COMFORT_CAMS.map(([cam, name]) => ({
        name: `${name} camshaft`,
        items: [
          ...tnComfortCamItems(cam, name),
          [`ip_cam_sp_ch_${cam}`, `${name} cam during catalyst heating`],
        ],
      })),
      {
        name: 'VANOS settings',
        items: [
          ['ip_pv_max_fl_ivvt__n', 'Pedal position for the full-load maps'],
          ['lc_ena_ivvt_park', 'Park the cams at shut-down'],
          ['c_toil_max_ivvt_park', 'Park the cams below this oil temperature'],
        ],
      },
    ],
  },
  {
    name: 'Cooling',
    subjects: [
      {
        name: 'Electric fan',
        items: [
          ['ip_n_ecf', 'Fan stage by temperature'],
          ['ip_n_perc_ecf', 'Fan duty for each stage'],
          ['ip_n_ecf_vs_cor', 'Fan stage by road speed'],
          ['ip_n_ecf_temp_cat', 'Lowest fan stage by catalyst temperature'],
          ['ip_n_ecf_temp_gb', 'Fan stage by gearbox temperature'],
          ['id_ecfpwm_igk_off__temp_cat', 'Fan run-on after key off'],
          ['c_n_ecf_hys', 'Fan stage hysteresis'],
          ['c_ecfpwm_min', 'Lowest fan duty'],
          ['c_ecfpwm_max', 'Highest fan duty'],
          ['lc_ecfpwm_ecf_man', 'Fan override switch'],
          ['c_ecfpwm_ecf_man', 'Fan duty override'],
          ['c_n_perc_act_ecf', 'Fan stage override'],
        ],
      },
      {
        name: 'Thermostat',
        items: [
          ['id_tco_sp_ect', 'Coolant target, no A/C'],
          ['id_tco_sp_ect_acin', 'Coolant target, A/C fitted'],
          ['c_toil_max_ect', 'Oil temperature that forces cooler running'],
          ['lc_ectpwm_man', 'Thermostat override switch'],
        ],
      },
      {
        name: 'A/C compressor cut-out',
        items: [
          ['c_tco_max_accin', 'A/C off above this coolant temperature'],
          ['c_tco_max_accin_hys', 'Coolant hysteresis'],
          ['c_toil_max_accin', 'A/C off above this oil temperature'],
          ['c_toil_max_accin_hys', 'Oil hysteresis'],
          ['c_vs_max_accin', 'Road speed condition at high load'],
        ],
      },
      {
        name: 'Control unit box fan',
        items: [
          ['c_tecu_thd_ebox_cfa', 'Fan on above this control unit temperature'],
          ['c_tecu_hys_ebox_cfa', 'Control unit temperature hysteresis'],
          ['c_tia_thd_ebox_cfa', 'Fan on above this intake air temperature'],
          ['c_tia_hys_ebox_cfa', 'Intake air temperature hysteresis'],
        ],
      },
    ],
  },
  {
    name: 'Intake and exhaust',
    subjects: [
      {
        name: 'Intake flap (DISA)',
        items: [
          ['c_n_vim_l', 'Lower switch speed'],
          ['c_n_vim_h', 'Upper switch speed'],
          ['c_n_vim_hys', 'Switch speed hysteresis'],
          ['c_fac_maf_max_vim', 'Load threshold'],
          ['c_fac_maf_max_vim_hys', 'Load threshold hysteresis'],
        ],
      },
      {
        name: 'Exhaust flap',
        items: [
          ...[1, 2, 3, 4, 5].map((n) => [
            `ip_pv_min_mt_${n}_ef`,
            `Flap opens at this pedal, manual, gear group ${n}`,
          ]),
          ...[1, 2, 3, 4, 5].map((n) => [
            `ip_pv_min_at_${n}_ef`,
            `Flap opens at this pedal, automatic, gear group ${n}`,
          ]),
          ['c_pv_hys_ef', 'Pedal hysteresis'],
          ['c_vs_min_ef_mt', 'Flap always open above this speed, manual'],
          ['c_vs_min_ef_at', 'Flap always open above this speed, automatic'],
          ['c_t_ef_ast', 'Flap held after start'],
        ],
      },
      {
        name: 'Secondary air',
        items: [
          ['c_t_dly_sap_on', 'Pump start delay'],
          ['c_t_dly_sap_off', 'Pump stop delay after the valve shuts'],
          ['ip_t_sa_off_0', 'Run time 1'],
          ['ip_t_sa_off_1', 'Run time 2'],
          ['c_n_max_sa_act', 'Engine speed that resumes secondary air'],
          ['c_dist_min_sa_act', 'Distance needed before it runs'],
        ],
      },
      {
        name: 'O2 sensor heaters',
        items: [
          ['lc_lsh_up_1', 'Front heater on, bank 1'],
          ['lc_lsh_up_2', 'Front heater on, bank 2'],
          ['lc_lsh_down_1', 'Rear heater on, bank 1'],
          ['lc_lsh_down_2', 'Rear heater on, bank 2'],
        ],
      },
    ],
  },
  {
    name: 'Vehicle setup',
    subjects: [
      {
        name: 'Monitoring',
        items: [
          ['lc_mis_inh', 'Misfire monitoring off'],
          ['c_n_max_mis_mt', 'Misfire detection up to this speed, manual'],
          ['c_n_max_mis_at', 'Misfire detection up to this speed, automatic'],
          ['c_n_lim_min', 'Engine speed logged as an over-rev'],
        ],
      },
      {
        name: 'Cruise control',
        items: [
          ['c_vs_min_cru_k', 'Lowest cruise speed, km/h cluster'],
          ['c_vs_min_cru_m', 'Lowest cruise speed, mph cluster'],
          ['lc_cru_req_swi', 'Steering wheel buttons or stalk'],
        ],
      },
    ],
  },
];

/**
 * The comfort list as it applies to one definition: every entry the
 * definition carries, resolved to its item.
 * @param {XdfFile|null} def
 * @returns {Array<{name: string, subjects: Array<{name: string, rows: Array<{item: XdfItem, label: string}>}>}>|null}
 *   null when the definition is not one the list describes.
 */
function tnComfortFor(def) {
  if (!def || !def.items) return null;
  if (def.comfortList !== undefined) return def.comfortList;
  const byTitle = new Map();
  for (const it of def.items)
    if (it.title && !byTitle.has(it.title)) byTitle.set(it.title, it);
  let found = 0;
  const resolve = (subjects) => {
    const out = [];
    for (const s of subjects) {
      const rows = [];
      for (const [title, label] of s.items) {
        const item = byTitle.get(title);
        if (item) rows.push({ item, label });
      }
      found += rows.length;
      if (rows.length) out.push({ name: s.name, rows });
    }
    return out;
  };
  const groups = [];
  for (const g of TN_COMFORT_MS45) {
    const subjects = resolve(g.subjects);
    if (subjects.length) groups.push({ name: g.name, subjects });
  }
  // remembered on the definition: 5,700 titles are not indexed twice
  def.comfortList = found >= TN_COMFORT_MIN ? groups : null;
  // the generated group last: the single values the live-tune build keeps
  // in RAM of their own (core/generated/comfort-live.js), always live
  if (def.comfortList && typeof TN_COMFORT_LIVE !== 'undefined') {
    const subjects = resolve(TN_COMFORT_LIVE.subjects);
    if (subjects.length)
      def.comfortList.push({ name: TN_COMFORT_LIVE.name, subjects });
  }
  return def.comfortList;
}

const TN_COMFORT_MODE_KEY = 'bmweb.tuning.comfort';

/**
 * Whether the tree opens on the comfort list (it does until told not to).
 * @returns {boolean}
 */
function tnComfortModeGet() {
  try {
    return localStorage.getItem(TN_COMFORT_MODE_KEY) !== '0';
  } catch (e) {
    return true;
  }
}

/**
 * Remember which tree the reader chose.
 * @param {boolean} on - Comfort (true) or everything (false).
 * @returns {void}
 */
function tnComfortModeSet(on) {
  try {
    localStorage.setItem(TN_COMFORT_MODE_KEY, on ? '1' : '0');
  } catch (e) {
    // a private window: the choice lasts as long as the page
  }
}

/**
 * Render the comfort list into `listWrap`: groups, their subjects, and
 * under an open subject its entries, each the same row the full tree draws
 * under a plainer name.
 * @param {TuningEditor} ed
 * @param {HTMLElement} listWrap
 * @param {NonNullable<ReturnType<typeof tnComfortFor>>} groups
 * @returns {void}
 */
function tnRenderComfortList(ed, listWrap, groups) {
  // rebuilt in place (a section opened or shut): stay where the reader was
  const scrolled = listWrap.scrollTop;
  listWrap.innerHTML = '';
  const f = tuningState.filter.trim().toLowerCase();
  if (!tuningState.openCats) tuningState.openCats = new Set();
  const open = tuningState.openCats;
  let shown = 0;
  for (const g of groups) {
    const groupHit = !f || g.name.toLowerCase().includes(f);
    const groupEl = document.createElement('div');
    groupEl.className = 'tn-comfort-group';
    groupEl.innerHTML = `<div class="tn-comfort-group-name">${esc(g.name)}</div>`;
    for (const s of g.subjects) {
      const subjectHit = groupHit || s.name.toLowerCase().includes(f);
      const rows = subjectHit
        ? s.rows
        : s.rows.filter(
            (r) =>
              r.label.toLowerCase().includes(f) ||
              (r.item.title || '').toLowerCase().includes(f)
          );
      if (!rows.length) continue;
      shown += rows.length;
      const id = `comfort/${g.name}/${s.name}`;
      const holdsSelected =
        tuningState.selectedId != null &&
        rows.some((r) => r.item.key === tuningState.selectedId);
      // a search opens what it found; otherwise only what the reader opened
      const isOpen = holdsSelected || !!f || open.has(id);
      const cat = document.createElement('div');
      cat.className = 'tn-cat tn-comfort-subject' + (isOpen ? ' open' : '');
      cat.innerHTML = `<button class="tn-cat-head" type="button"
            aria-expanded="${isOpen ? 'true' : 'false'}">
            <span class="tn-cat-caret">${isOpen ? '▾' : '▸'}</span>
            <span class="tn-cat-name">${esc(s.name)}</span>
            <span class="tn-cat-count">${rows.length}</span>
          </button>`;
      const body = document.createElement('div');
      body.className = 'tn-cat-body';
      if (isOpen)
        for (const r of rows)
          body.appendChild(tnRenderItemRow(ed, r.item, r.label));
      cat.appendChild(body);
      cat.querySelector('.tn-cat-head').onclick = () => {
        if (holdsSelected) {
          // the open entry was holding the subject open: let go of it too
          tnDefsDeselect(ed);
          open.delete(id);
        } else if (open.has(id)) open.delete(id);
        else open.add(id);
        tnRenderComfortList(ed, listWrap, groups);
      };
      groupEl.appendChild(cat);
    }
    if (groupEl.children.length > 1) listWrap.appendChild(groupEl);
  }
  if (!shown)
    listWrap.appendChild(
      makeEmpty('⌕', 'Nothing here matches.', 'Expert lists every parameter.')
    );
  listWrap.scrollTop = scrolled;
  if (ed.els.hexMeta) ed.els.hexMeta.dataset.shown = String(shown);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TN_COMFORT_MS45, TN_COMFORT_MIN, tnComfortFor };
}
