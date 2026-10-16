/**
 * @file Map switch builder: the public surface (mapSwitch), which builds a program pair from a flash, its MPC image and the maps.
 */

/* exported mapSwitch */

// ---- the public surface ---------------------------------------------------------------------------
const mapSwitch = {
  SUPPORTED_PROGRAM_VERSION: MAPSWITCH_PROGRAM_VERSION,
  FULL_FLASH_LENGTH: MAPSWITCH_FULL_FLASH_LENGTH,
  MPC_LENGTH: MAPSWITCH_MPC_LENGTH,
  CALIBRATION_START: MAPSWITCH_CAL_START,
  CALIBRATION_LENGTH: MAPSWITCH_CAL_LENGTH,
  MAP2_START: MAPSWITCH_MAP2_START,
  MAP2_LENGTH: MAPSWITCH_MAP2_LENGTH,
  CAR_CHECK_OFFSET: MAPSWITCH_FREE_START,
  CAR_CHECK_LENGTH: MS_CAR_CHECK_LENGTH,
  MAP2_DATA_VERSION_OFFSET:
    MAPSWITCH_MAP2_START + MAPSWITCH_DATA_VERSION_OFFSET,
  DATA_VERSION_LENGTH: MAPSWITCH_DATA_VERSION_LENGTH,
  /** Generation 4: the header and block tables, read whole from a car. */
  TABLES_OFFSET: MS_HEADER,
  TABLES_LENGTH: MS_TABLES_LENGTH,
  BLOCK_LENGTH: MS_BLOCK,
  MAX_MAPS: MS_MAX_MAPS,
  MIN_MAPS: MS_MIN_MAPS,
  DSC_PRESS_CHOICES: MS_DSC_PRESS_CHOICES,
  DEFAULT_DSC_PRESSES: MS_DEFAULT_DSC_PRESSES,
  DEFAULT_TRIGGER: 'dsc',
  /** RAM worth reading on a car to see the trigger work. */
  RAM: {
    canAsc1: 0x3fdcac,
    canEgs1: MS_RAM_EGS1,
    dscState: MAPSWITCH_R13 + MS_VAR_DSC_STATE,
    engineSpeed: MAPSWITCH_R13 + MS_VAR_ENGINE_SPEED,
    vehicleSpeed: MAPSWITCH_R13 + MS_VAR_VEHICLE_SPEED,
    tach: MAPSWITCH_R13 + MS_TACH_VAR,
    flag: MS_RAM_FLAG,
  },

  /**
   * @param {'dsc'|'shifter'|'pedals'} trigger - The trigger.
   * @param {number} [presses] - DSC presses.
   * @returns {string}
   */
  describeTrigger(trigger, presses = MS_DEFAULT_DSC_PRESSES) {
    if (trigger === 'dsc') return `DSC button pressed ${presses} times`;
    if (trigger === 'shifter') return 'gear lever activation style';
    return 'brake + full throttle held 5 s';
  },
  /** @param {'fullTune'|'mapsOnly'} scope - The scope. @returns {string} */
  describeScope(scope) {
    return scope === 'fullTune' ? 'full tune' : 'maps only';
  },
  /** @param {Uint8Array} flash - A full image. @returns {string|null} */
  readProgramVersion(flash) {
    return msReadAscii(flash, MAPSWITCH_PROGRAM_VERSION_OFFSET, 12);
  },
  /** @param {Uint8Array} cal - A calibration. @returns {string|null} */
  readDataVersion(cal) {
    return msReadAscii(
      cal,
      MAPSWITCH_DATA_VERSION_OFFSET,
      MAPSWITCH_DATA_VERSION_LENGTH
    );
  },
  /** The data version in a field read from the car, or null. @param {Uint8Array} field @returns {string|null} */
  dataVersionFrom(field) {
    return field && field.length === MAPSWITCH_DATA_VERSION_LENGTH
      ? msReadAscii(field, 0, MAPSWITCH_DATA_VERSION_LENGTH)
      : null;
  },
  /**
   * The index (0 = map 1) a flag byte read from a car selects, given the
   * layout stateOnCar reported.
   * @param {number} flag
   * @param {'blocks'|'copy'|null} layout
   * @returns {number}
   */
  selectedIndex(flag, layout) {
    if (flag == null) return 0;
    return layout === 'blocks' || layout === 'chunks'
      ? (flag & MS_FLAG_INDEX_MASK) >> MS_FLAG_INDEX_SHIFT
      : flag & 1;
  },
  /** How many maps a header-and-tables area read from a car says are stored, or null. */
  mapCountFrom(area) {
    return msHeaderMapCount(area);
  },
  /** How much to read from TABLES_OFFSET for a layout's header and tables. */
  tablesLength(layout) {
    return layout === 'chunks'
      ? MS_CHUNK_TABLES_END - MS_HEADER
      : MS_TABLES_LENGTH;
  },
  /** Whether a header-and-tables area is the chunks-and-sites layout. */
  isChunksLayout(area) {
    return !!msHeaderIsChunks(area);
  },
  /**
   * The flash ranges to read for map `index` (1 = map 2), from the
   * header-and-tables area. With the chunk layout the first range is the
   * site area, whose values the map needs too.
   */
  blockRangesFrom(area, index) {
    if (msHeaderIsChunks(area)) {
      const end = msRead32(area, MS_HEADER_SITES_END);
      const ranges = [{ start: MS_SITES, end }];
      const chunks = [];
      const table = msChunkTableFrom(area, index);
      for (let c = 0; c < MS_CHUNK_COUNT; c++)
        if (table[c] !== MS_NO_BLOCK) chunks.push(table[c]);
      for (const r of msRuns(chunks))
        ranges.push({
          start: r.first * MS_CHUNK,
          end: (r.last + 1) * MS_CHUNK,
        });
      return ranges;
    }
    return msTableRanges(msTableFrom(area, index));
  },
  /**
   * Map `index` from map 1, the header-and-tables area and the ranges read
   * (`chunks`: [{start, data}] as blockRangesFrom asked for them).
   * @returns {Uint8Array|null}
   */
  mapFromChunks(map1, area, index, chunks) {
    if (msHeaderIsChunks(area)) {
      const siteArea = chunks.find((c) => c.start === MS_SITES);
      const dir = siteArea ? msReadSites(siteArea.data) : null;
      if (!dir) return null;
      return msMapFromChunkTable(
        map1,
        msChunkTableFrom(area, index),
        dir,
        index,
        (at) => {
          for (const c of chunks)
            if (at >= c.start && at + MS_CHUNK <= c.start + c.data.length)
              return c.data.subarray(at - c.start, at - c.start + MS_CHUNK);
          return null;
        }
      );
    }
    return msMapFromTable(map1, msTableFrom(area, index), (at) => {
      for (const c of chunks)
        if (at >= c.start && at + MS_BLOCK <= c.start + c.data.length)
          return c.data.subarray(at - c.start, at - c.start + MS_BLOCK);
      return null;
    });
  },
  /**
   * Where a calibration offset of map `index` lies in the flash, given the
   * header-and-tables area: in the stored block or chunk, or in map 1. With
   * the chunk layout the single values a map switches at their load sites
   * are not here: see scalarsFrom.
   */
  locateFrom(area, index, calOffset) {
    if (msHeaderIsChunks(area)) {
      const entry = index
        ? msChunkTableFrom(area, index)[calOffset >> 8]
        : MS_NO_BLOCK;
      return entry === MS_NO_BLOCK
        ? MAPSWITCH_CAL_START + calOffset
        : entry * MS_CHUNK + (calOffset & (MS_CHUNK - 1));
    }
    const entry = index
      ? msTableFrom(area, index)[calOffset >> 10]
      : MS_NO_BLOCK;
    return entry === MS_NO_BLOCK
      ? MAPSWITCH_CAL_START + calOffset
      : entry * MS_BLOCK + (calOffset & (MS_BLOCK - 1));
  },
  /** The granularity locateFrom works at for a header-and-tables area. */
  pieceLength(area) {
    return msHeaderIsChunks(area) ? MS_CHUNK : MS_BLOCK;
  },
  /** The site area's flash range for a chunk-layout header, [start, end), or null. */
  siteRangeFrom(area) {
    return msHeaderIsChunks(area)
      ? { start: MS_SITES, end: msRead32(area, MS_HEADER_SITES_END) }
      : null;
  },
  /** The single values map `index` switches at their load sites, from the site area read: [{offset, data}]. */
  scalarsFrom(siteArea, index) {
    const dir = msReadSites(siteArea);
    if (!dir) return [];
    return dir.scalars.map((s) => ({
      offset: s.offset,
      data: s.values[index],
    }));
  },
  /** @param {Uint8Array} flash @param {Uint8Array} mpc @returns {boolean} */
  hasMap2(flash, mpc) {
    const maps = msStoredMaps(flash, mpc);
    return !!maps && maps.length > 0;
  },
  /**
   * The maps 2..N a pair carries, as calibrations (map 2's safety-monitor
   * sum is map 1's, as stored); null when the pair carries no build.
   * @returns {Uint8Array[]|null}
   */
  storedMaps(flash, mpc) {
    return msStoredMaps(flash, mpc);
  },
  /**
   * Copies of `flash` and `mpc` with the stored maps replaced by `maps`
   * (calibrations of maps 2..N), laid out against the calibration in the
   * image, for the build the MPC carries; from generation 6 the MPC changes
   * too (the load sites). The count must stay what the code was built for.
   * @returns {{flash: Uint8Array, mpc: Uint8Array}}
   */
  replaceStoredMaps(flash, mpc, maps) {
    const v = msVersionOf(mpc);
    if (!v)
      throw new Error('the MPC carries no recognised build of the map switch');
    const out = Uint8Array.from(flash);
    const map1 = out.subarray(
      MAPSWITCH_CAL_START,
      MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH
    );
    if (!msMulti(v)) {
      if (maps.length !== 1) throw new Error('this build holds one map 2');
      out.set(maps[0].subarray(0, MAPSWITCH_MAP2_LENGTH), MAPSWITCH_MAP2_START);
      msWriteCalTestSum(out, MAPSWITCH_MAP2_START, msCalTestSum(map1));
      return { flash: out, mpc: Uint8Array.from(mpc) };
    }
    if (maps.length + 1 !== v.maps)
      throw new Error(
        `this build cycles through ${v.maps} maps, so it stores ${v.maps - 1} besides map 1`
      );
    const prepared = maps.map((m) => {
      const cal = Uint8Array.from(m);
      msWriteCalTestSum(cal, 0, msCalTestSum(map1));
      return cal;
    });
    if (v.gen >= MS_SITE_GEN) {
      const result = {
        flash: out,
        mpc: Uint8Array.from(mpc),
        wasAlreadyPatched: true,
        log: [],
      };
      msBuildSites(result, Uint8Array.from(map1), prepared, v);
      return result;
    }
    const layout = msLayout(map1, prepared);
    if (!layout.ok) throw new Error(layout.reason);
    msEraseMapAreas(out);
    msWriteLayout(out, prepared, layout);
    return { flash: out, mpc: Uint8Array.from(mpc) };
  },
  /**
   * Whether `maps` (calibrations of maps 2..N) fit beside `map1`, how much
   * flash they take and whether one more would fit. `map1` null assumes
   * maps identical to it.
   * @returns {{ok: boolean, reason: string|null, kbUsed: number, kbTotal: number, perMapKb: number[], canAddAnother: boolean, maxMaps: number}}
   */
  plan(map1, maps, flash = null, mpc = null) {
    const base =
      map1 ||
      (maps.find((m) => m) ?? new Uint8Array(MAPSWITCH_CAL_LENGTH).fill(0xff));
    const list = (maps || []).map((m) => m || base);
    if (MS_CURRENT_GEN >= MS_SITE_GEN) {
      // without the program to scan, every differing byte counts as table data: the most it can cost
      const scan =
        flash &&
        mpc &&
        flash.length === MAPSWITCH_FULL_FLASH_LENGTH &&
        mpc.length === MAPSWITCH_MPC_LENGTH
          ? msScanSites(flash, mpc)
          : { sites: new Map(), uncovered: new Set() };
      const sized = (ms) => {
        const plan = msSitePlan(scan, base, ms);
        const poolStart =
          (MS_SITES + msSiteAreaLength(plan) + MS_CHUNK - 1) & ~(MS_CHUNK - 1);
        const layout = msChunkLayout(base, ms, plan, poolStart);
        return { plan, layout, poolStart };
      };
      const here = sized(list);
      const more = sized([...list, base]);
      const total = Math.round(
        (MS_POOLS[0][1] - MS_HEADER + MS_POOLS[1][1] - MS_POOLS[1][0]) / 1024
      );
      return {
        ok: here.layout.ok,
        reason: here.layout.reason,
        kbUsed:
          Math.round(
            ((here.poolStart - MS_HEADER) / 1024 + here.layout.chunksUsed / 4) *
              10
          ) / 10,
        kbTotal: total,
        perMapKb: here.layout.maps.map(
          (m) => Math.round((m.carried / 4) * 10) / 10
        ),
        canAddAnother:
          here.layout.ok && more.layout.ok && list.length + 2 <= MS_MAX_MAPS,
        maxMaps: MS_MAX_MAPS,
      };
    }
    const layout = msLayout(base, list);
    const more = msLayout(base, [...list, base]);
    return {
      ok: layout.ok,
      reason: layout.reason,
      kbUsed: layout.blocksUsed,
      kbTotal: layout.blocksTotal,
      perMapKb: layout.maps.map((m) => m.carried),
      canAddAnother: layout.ok && more.ok && list.length + 2 <= MS_MAX_MAPS,
      maxMaps: MS_MAX_MAPS,
    };
  },
  /** @param {Uint8Array} mpc @returns {boolean} */
  isAlreadyPatched(mpc) {
    return msVersionOf(mpc) != null || msCarriesSomeBuild(mpc);
  },
  /** @param {Uint8Array} mpc @returns {boolean} */
  isCurrentVersion(mpc) {
    const v = msVersionOf(mpc);
    return v != null && msIsCurrent(v);
  },
  /**
   * The trigger, presses, scope, map count and layout a patched MPC carries; null when it is not patched.
   * @param {Uint8Array} mpc
   * @returns {{trigger: string, presses: number, scope: string, maps: number, layout: string}|null}
   */
  installed(mpc) {
    const v = msVersionOf(mpc);
    return v ? msVersionSummary(v) : null;
  },
  /**
   * What the first CAR_CHECK_LENGTH bytes of the MPC's free area, as read from
   * a car, say: 'notInstalled', 'current', 'earlier' or 'unrecognised', with the
   * trigger / presses / scope / maps / layout when known.
   * @param {Uint8Array} freeArea
   * @returns {{state: string, trigger: string|null, presses: number|null, scope: string|null, maps: number|null, layout: string|null}}
   */
  stateOnCar(freeArea) {
    msCheckFreeArea(freeArea);
    if (msFreeAreaMatches(freeArea, new Uint8Array(0)))
      return { state: 'notInstalled', ...msVersionSummary(null) };
    const v = msVersionOnCar(freeArea);
    if (!v)
      return {
        state: msLooksLikeOurCode(freeArea) ? 'earlier' : 'unrecognised',
        ...msVersionSummary(null),
      };
    return {
      state: msIsCurrent(v) ? 'current' : 'earlier',
      ...msVersionSummary(v),
    };
  },
  /**
   * stateOnCar from the START of the free area, when that much already
   * settles it: reading the area off a car is the slow part of recognising a
   * build, and most of it is often not needed. Only the two answers that no
   * later byte can change are given early -- bytes that are not blank and
   * match no known build are 'earlier' or 'unrecognised' whatever follows.
   * A blank start, or one a known build still fits, says nothing yet.
   * @param {Uint8Array} start - The first bytes of the free area, any length.
   * @returns {ReturnType<typeof mapSwitch.stateOnCar>|null} null while the
   *   rest could still change the answer.
   */
  stateFromStart(start) {
    if (start.length >= MS_CAR_CHECK_LENGTH)
      return mapSwitch.stateOnCar(start.subarray(0, MS_CAR_CHECK_LENGTH));
    if (start.every((b) => b === 0xff)) return null; // may yet be blank throughout
    for (const v of MS_KNOWN_VERSIONS) {
      const { code } = msBuildCode(v);
      if (code.length > MS_CAR_CHECK_LENGTH) continue;
      let fits = true;
      for (let i = 0; i < start.length && fits; i++)
        if (start[i] !== (i < code.length ? code[i] : 0xff)) fits = false;
      if (fits) return null; // this build is still possible
    }
    // no known build: ours-but-changed or somebody else's, by the lookup
    // stubs at the very start -- once enough of them has been read to tell
    let ours = false;
    for (const sample of msOurCodeSamples()) {
      const built = msBuildCode(sample);
      const lookupBytes = built.tachStub - MAPSWITCH_FREE_START;
      let same = true;
      for (let i = 0; i < Math.min(lookupBytes, start.length) && same; i++)
        if (start[i] !== built.code[i]) same = false;
      if (!same) continue;
      if (start.length < lookupBytes) return null; // matches so far, not all read
      ours = true;
      break;
    }
    return {
      state: ours ? 'earlier' : 'unrecognised',
      ...msVersionSummary(null),
    };
  },
  /**
   * Turn the map 2 area of an earlier build, as read from a car, back into the tune it was stored from.
   * @param {Uint8Array} map2Area - The 0x18000 bytes at 0xE0000.
   * @returns {Uint8Array|null}
   */
  map2AsCalibration(map2Area) {
    if (!map2Area || map2Area.length !== MAPSWITCH_MAP2_LENGTH) {
      throw new Error(
        `expected the 0x${MAPSWITCH_MAP2_LENGTH.toString(16).toUpperCase()} bytes of the map 2 area`
      );
    }
    if (
      msReadAscii(
        map2Area,
        MAPSWITCH_DATA_VERSION_OFFSET,
        MAPSWITCH_DATA_VERSION_LENGTH
      ) == null
    )
      return null;
    const cal = new Uint8Array(MAPSWITCH_CAL_LENGTH).fill(0xff);
    cal.set(map2Area, 0);
    return cal;
  },
  /**
   * A tune in any accepted form (a 0x1D000-0x20000 partial, or a full 1 MB
   * image) as the 0x1D000-byte calibration.
   * @param {Uint8Array} file
   * @returns {Uint8Array}
   */
  extractCalibration(file) {
    if (!file) throw new Error('no file');
    if (file.length === MAPSWITCH_FULL_FLASH_LENGTH)
      return Uint8Array.from(
        file.subarray(
          MAPSWITCH_CAL_START,
          MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH
        )
      );
    if (file.length >= MAPSWITCH_CAL_LENGTH && file.length <= 0x20000)
      return Uint8Array.from(file.subarray(0, MAPSWITCH_CAL_LENGTH));
    throw new Error(
      `a tune must be a calibration partial (0x1D000 bytes) or a full 1 MB image; this file is 0x${file.length.toString(16).toUpperCase()} bytes`
    );
  },
  /**
   * Why this pair cannot be patched, or null when it can. A pair that is
   * already patched is accepted (its maps can be replaced).
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {string|null}
   */
  blockedReason(flash, mpc) {
    if (!flash || flash.length !== MAPSWITCH_FULL_FLASH_LENGTH)
      return 'Map switch needs a full 1 MB external flash image.';
    if (!mpc || mpc.length !== MAPSWITCH_MPC_LENGTH)
      return 'Map switch needs the 448 KB MPC (internal flash) image.';
    const version = mapSwitch.readProgramVersion(flash);
    if (version !== MAPSWITCH_PROGRAM_VERSION) {
      return `Map switch is only built for program ${MAPSWITCH_PROGRAM_VERSION}, but this image reports ${version || 'an unreadable version'}.`;
    }
    const upper = msUpperSites(flash, mpc).length;
    const sensor = msSensorSitesState(mpc);
    const sitesBuild =
      mapSwitch.isAlreadyPatched(mpc) &&
      msHeaderIsChunks(flash.subarray(MS_HEADER, MS_HEADER + 0x40));
    if (
      !sitesBuild &&
      (upper !== MS_UPPER_SITES || sensor !== 'stock') &&
      !(
        upper === 0 &&
        sensor === 'rewritten' &&
        mapSwitch.isAlreadyPatched(mpc)
      )
    ) {
      return `The program does not carry the ${MS_UPPER_SITES} accesses to the calibration's upper half and the two sensor-table readers the map switch rewrites (found ${upper}, readers ${sensor || 'unexpected'}), so it is not what the map switch was built for.`;
    }
    if (mapSwitch.isAlreadyPatched(mpc)) return null;
    for (let i = MAPSWITCH_FREE_START; i < MAPSWITCH_FREE_END; i++) {
      if (mpc[i] !== 0xff)
        return "The MPC's free area (0x6E550 up) is not empty, so it carries some other modification.";
    }
    for (const [start, end] of MS_POOLS) {
      for (let i = start; i < end; i++) {
        if (flash[i] !== 0xff)
          return `The external flash area for the maps (0x${start.toString(16).toUpperCase()}-0x${(end - 1).toString(16).toUpperCase()}) is not empty.`;
      }
    }
    const all = msEntriesFor(msCurrentVersion('dsc'));
    for (let i = 0; i < all.entries.length; i++) {
      if (msRead32(mpc, all.entries[i]) !== all.stock[i]) {
        return `The MPC does not carry the expected code at lookup routine 0x${all.entries[i].toString(16).toUpperCase()}.`;
      }
    }
    if (msRead32(mpc, MS_TACH_STORE_ADDR) !== MS_TACH_STORE_INSN)
      return 'The MPC does not carry the expected code at the engine speed frame builder.';
    if (
      msRead32(mpc, MS_MIL_STORE_ADDR) !== MS_MIL_STORE_INSN ||
      msRead32(mpc, MS_ECON_STORE_ADDR) !== MS_ECON_STORE_INSN
    ) {
      return 'The MPC does not carry the expected code at the lamp / fuel frame builder.';
    }
    for (let i = 0; i < 3; i++) {
      if (msRead32(mpc, MS_NV_DESCRIPTOR + 4 * i) !== MS_NV_STOCK[i])
        return "The MPC's stored-data table does not match the expected layout.";
    }
    return null;
  },
  /**
   * Why a calibration cannot be stored as an extra map, or null when it can.
   * @param {Uint8Array} calibration
   * @param {Uint8Array} map1
   * @param {number} [number] - The map's number, for the message.
   * @returns {string|null}
   */
  mapBlockedReason(calibration, map1, number = 2) {
    if (!calibration || calibration.length !== MAPSWITCH_CAL_LENGTH)
      return `Map ${number} is not a 0x1D000-byte calibration.`;
    const v1 = mapSwitch.readDataVersion(map1);
    const v2 = mapSwitch.readDataVersion(calibration);
    if (v1 == null || v2 == null || v1 !== v2) {
      return `Map ${number} is for data version ${v2 || '(unreadable)'} but map 1 is ${v1 || '(unreadable)'}. All maps must share one layout.`;
    }
    return null;
  },
  /** The earlier builds' rule for map 2, which also had to fit the full copy. */
  map2BlockedReason(calibration, map1) {
    const r = mapSwitch.mapBlockedReason(calibration, map1, 2);
    if (r) return r;
    for (let i = MAPSWITCH_MAP2_LENGTH; i < MAPSWITCH_CAL_LENGTH; i++) {
      if (calibration[i] !== 0xff) {
        return `Map 2 has data past offset 0x${MAPSWITCH_MAP2_LENGTH.toString(16).toUpperCase()}, which does not fit in the free flash area.`;
      }
    }
    return null;
  },
  /**
   * Patched copies of the pair. `map1` null keeps the calibration already in
   * the image; `maps` are the calibrations of maps 2..N (a single one may be
   * passed bare; null or empty stores one copy of map 1, so the build has
   * two maps). The caller's arrays are left alone. Checksums and signatures
   * are the caller's job afterwards.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @param {Uint8Array|null} map1
   * @param {Uint8Array[]|Uint8Array|null} maps
   * @param {'dsc'|'shifter'|'pedals'} [trigger]
   * @param {number} [dscPresses]
   * @returns {{flash: Uint8Array, mpc: Uint8Array, wasAlreadyPatched: boolean, wasUpdated: boolean, mapsIdentical: boolean, maps: number, kbUsed: number, kbTotal: number, codeBytes: number, log: string[]}}
   */
  build(
    flash,
    mpc,
    map1,
    maps,
    trigger = 'dsc',
    dscPresses = MS_DEFAULT_DSC_PRESSES
  ) {
    if (!MS_TRIGGERS.includes(trigger))
      throw new Error(`unknown map switch trigger: ${trigger}`);
    if (trigger === 'dsc' && !MS_DSC_PRESS_CHOICES.includes(dscPresses))
      throw new Error('the DSC button trigger takes 2 or 4 presses');
    const list = msMapList(maps);
    if (list.length + 1 > MS_MAX_MAPS)
      throw new Error(
        `the map switch cycles through at most ${MS_MAX_MAPS} maps`
      );
    return msBuild(
      flash,
      mpc,
      map1,
      list,
      msCurrentVersion(
        trigger,
        dscPresses,
        Math.max(MS_MIN_MAPS, list.length + 1)
      )
    );
  },
  /** For tests: build an earlier version. */
  _buildVersion: (flash, mpc, map1, maps, version) =>
    msBuild(flash, mpc, map1, msMapList(maps), version),
  _version: msVersion,
  _buildCode: msBuildCode,
  _romTestSum: msRomTestSum,
  _calTestSum: msCalTestSum,
  _layout: msLayout,
  _R2_BLOCKS: MS_R2_BLOCKS,
  _upperSites: msUpperSites,
  _scanSites: msScanSites,
  _sitePlan: msSitePlan,
  _readSites: msReadSites,
  _SITES: MS_SITES,
  _CHUNK_TABLES_END: MS_CHUNK_TABLES_END,
  _sensorSitesState: msSensorSitesState,
  MAP1_ONLY: MS_MAP1_ONLY,
  UPPER_SITES: MS_UPPER_SITES,
  _HEADER: MS_HEADER,
  _POOLS: MS_POOLS,
};

function msMapList(maps) {
  if (!maps) return [];
  if (maps instanceof Uint8Array) return [maps];
  return maps.filter((m) => m);
}

/**
 * Generation 6's data: the stock instructions back at any earlier sites,
 * the scan, the plan, the site area and the chunks. Fills result.kbUsed /
 * kbTotal and logs per map.
 */
function msBuildSites(result, map1, maps, version) {
  const restored = result.wasAlreadyPatched ? msRestoreSites(result) : 0;
  if (result.wasAlreadyPatched) msEraseMapAreas(result.flash);
  const scan = msScanSites(result.flash, result.mpc);
  const plan = msSitePlan(scan, map1, maps);
  const siteLength = msSiteAreaLength(plan);
  const poolStart = (MS_SITES + siteLength + MS_CHUNK - 1) & ~(MS_CHUNK - 1);
  if (poolStart > MS_POOLS[0][1] - 4 * MS_CHUNK)
    throw new Error(
      `The maps change ${plan.scalars.length} single values read at ${plan.sites.length} places; the stubs for them (${siteLength} bytes) leave no room for the tables.`
    );
  const layout = msChunkLayout(map1, maps, plan, poolStart);
  if (!layout.ok) throw new Error(layout.reason);
  const sitesEnd = msWriteSites(result, plan);
  msWriteChunkLayout(result.flash, maps, layout, sitesEnd);
  const siteKb = (sitesEnd - MS_HEADER) / 1024;
  result.kbUsed = Math.round((siteKb + layout.chunksUsed / 4) * 10) / 10;
  result.kbTotal = Math.round(
    (MS_POOLS[0][1] - MS_HEADER + MS_POOLS[1][1] - MS_POOLS[1][0]) / 1024
  );
  result.perMapKb = layout.maps.map(
    (m) => Math.round((m.carried / 4) * 10) / 10
  );
  if (restored)
    result.log.push(
      `Sites: the stock instructions put back at the ${restored} the earlier build had patched`
    );
  result.log.push(
    `Sites: ${plan.scalars.length} single values differ between the maps, read at ${plan.sites.length} places; a stub for each at 0x${MS_SITES.toString(16).toUpperCase()} picks the selected map's value (${sitesEnd - MS_SITES} bytes with the header and chunk tables' ${(MS_SITES - MS_HEADER) / 1024} KB before it)`
  );
  if (plan.unswitchable.length) {
    const list = plan.unswitchable
      .slice(0, 6)
      .map((b) => `0x${b.toString(16).toUpperCase()}`)
      .join(', ');
    result.log.push(
      `WARNING: ${plan.unswitchable.length} differing bytes (${list}${plan.unswitchable.length > 6 ? ', ...' : ''}) are read in a way no stub can take over (a float or auto-update load); they are map 1's on every map`
    );
  }
  for (const m of layout.maps) {
    result.log.push(
      `Map ${m.index + 1}: ${m.differing} chunks of 256 bytes differ from map 1 beyond the single values; ${m.carried} stored (${result.perMapKb[m.index - 1]} KB), with map 1's calibration sum`
    );
  }
}

function msBuild(flash, mpc, map1, maps, version) {
  const blocked = mapSwitch.blockedReason(flash, mpc);
  if (blocked) throw new Error(blocked);
  const result = {
    flash: Uint8Array.from(flash),
    mpc: Uint8Array.from(mpc),
    wasAlreadyPatched: mapSwitch.isAlreadyPatched(mpc),
    wasUpdated: false,
    mapsIdentical: true,
    maps: version.maps,
    kbUsed: 0,
    kbTotal: 0,
    codeBytes: 0,
    log: [],
  };
  // an unpatched pair must carry the sum its own code gives; a patched one
  // may not: earlier builds left the stock value
  if (
    !result.wasAlreadyPatched &&
    msReadRomTestSum(flash) !== msRomTestSum(flash, mpc)
  ) {
    throw new Error(
      "the safety monitor's code sum in the program header does not match the code, so this pair is not what the map switch was built for"
    );
  }
  if (map1) {
    if (map1.length !== MAPSWITCH_CAL_LENGTH)
      throw new Error('map 1 is not a 0x1D000-byte calibration');
    result.flash.set(map1, MAPSWITCH_CAL_START);
    result.log.push('Map 1: replaced the calibration at 0x40000');
  } else {
    result.log.push('Map 1: kept the calibration already in the image');
  }
  const current1 = Uint8Array.from(
    result.flash.subarray(
      MAPSWITCH_CAL_START,
      MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH
    )
  );
  if (mapSwitch.readDataVersion(current1) == null)
    throw new Error(
      'the external flash has no tune in it; choose a map 1 tune'
    );
  // the monitor sums map 1's range through absolute addresses but reads the
  // value to compare with through r2, i.e. from whichever map is selected
  if (
    msRead32(result.flash, MS_CAL_TEST_RANGE_OFFSET) !==
      MS_CAL_TEST_RANGE_START ||
    msRead32(result.flash, MS_CAL_TEST_RANGE_OFFSET + 4) !==
      MS_CAL_TEST_RANGE_END
  ) {
    throw new Error(
      "the program header does not list the expected range for the safety monitor's calibration sum"
    );
  }
  const calSum = msCalTestSum(current1);
  if (msReadCalTestSum(current1, 0) !== calSum) {
    msWriteCalTestSum(result.flash, MAPSWITCH_CAL_START, calSum);
    msWriteCalTestSum(current1, 0, calSum);
    result.log.push(
      `Map 1: safety monitor's calibration sum at 0x${MS_CAL_TEST_SUM_OFFSET.toString(16).toUpperCase()} set to ${msHex16(calSum)}`
    );
  }
  const extras = maps.length ? maps : [current1];
  if (version.maps !== extras.length + 1)
    throw new Error(
      `this version cycles through ${version.maps} maps, but ${extras.length + 1} were given`
    );
  const differs = (cal) => {
    for (let i = 0; i < MAPSWITCH_CAL_LENGTH; i++)
      if (
        current1[i] !== cal[i] &&
        !(i >= MS_CAL_TEST_SUM_OFFSET && i < MS_CAL_TEST_SUM_OFFSET + 8)
      )
        return true;
    return false;
  };
  if (!msMulti(version)) {
    const second = extras[0];
    const map2Blocked = mapSwitch.map2BlockedReason(second, current1);
    if (map2Blocked) throw new Error(map2Blocked);
    if (result.wasAlreadyPatched) msEraseMapAreas(result.flash);
    result.flash.set(
      second.subarray(0, MAPSWITCH_MAP2_LENGTH),
      MAPSWITCH_MAP2_START
    );
    result.log.push(
      maps.length
        ? 'Map 2: stored at 0xE0000'
        : 'Map 2: stored a copy of map 1 at 0xE0000'
    );
    if (msReadCalTestSum(result.flash, MAPSWITCH_MAP2_START) !== calSum) {
      msWriteCalTestSum(result.flash, MAPSWITCH_MAP2_START, calSum);
      result.log.push(
        `Map 2: given map 1's calibration sum, ${msHex16(calSum)}, which the safety monitor reads from the selected map`
      );
    }
    result.mapsIdentical = !differs(second);
    result.kbUsed = MAPSWITCH_MAP2_LENGTH / 1024;
    result.kbTotal = MAPSWITCH_MAP2_LENGTH / 1024;
  } else {
    const prepared = [];
    for (let i = 0; i < extras.length; i++) {
      const reason = mapSwitch.mapBlockedReason(extras[i], current1, i + 2);
      if (reason) throw new Error(reason);
      const cal = Uint8Array.from(extras[i]);
      msWriteCalTestSum(cal, 0, calSum);
      prepared.push(cal);
      if (differs(cal)) result.mapsIdentical = false;
      for (const [start, end, what] of MS_MAP1_ONLY) {
        let same = true;
        for (let k = start; k < end && same; k++)
          if (cal[k] !== current1[k]) same = false;
        if (!same)
          result.log.push(
            `Map ${i + 2}: differs from map 1 in ${what}, which the program reads from map 1 whichever map is selected`
          );
      }
    }
    if (version.gen >= MS_SITE_GEN) {
      msBuildSites(result, current1, prepared, version);
      result.log.push(
        `Maps: ${version.maps} in all, ${result.kbUsed} of ${result.kbTotal} KB of map flash used, header and chunk tables at 0x${MS_HEADER.toString(16).toUpperCase()}, sites at 0x${MS_SITES.toString(16).toUpperCase()}`
      );
    } else {
      const layout = msLayout(current1, prepared);
      if (!layout.ok) throw new Error(layout.reason);
      if (result.wasAlreadyPatched) msEraseMapAreas(result.flash);
      msWriteLayout(result.flash, prepared, layout);
      result.kbUsed = layout.blocksUsed;
      result.kbTotal = layout.blocksTotal;
      for (const m of layout.maps) {
        result.log.push(
          `Map ${m.index + 1}: ${m.differing} KB differ from map 1; ${msKb(m.carried)} stored` +
            ` (${msKb(m.windowBlocks)} in the r2 window at 0x${(m.windowBase * MS_BLOCK).toString(16).toUpperCase()}` +
            `${m.carried > m.windowBlocks ? `, ${msKb(m.carried - m.windowBlocks)} elsewhere` : ''}), with map 1's calibration sum`
        );
      }
      result.log.push(
        `Maps: ${version.maps} in all, ${msKb(layout.blocksUsed)} of ${msKb(layout.blocksTotal)} map flash used, header and block tables at 0x${MS_HEADER.toString(16).toUpperCase()}`
      );
    }
  }

  const built = msBuildCode(version);
  result.codeBytes = built.code.length;
  const correctRomSum = () => {
    const sum = msRomTestSum(result.flash, result.mpc);
    if (msReadRomTestSum(result.flash) === sum) return;
    msWrite32(
      result.flash,
      MS_ROM_TEST_SUM_OFFSET,
      Number((sum >> 32n) & 0xffffffffn)
    );
    msWrite32(
      result.flash,
      MS_ROM_TEST_SUM_OFFSET + 4,
      Number(sum & 0xffffffffn)
    );
    result.log.push(
      `Safety monitor: code sum at 0x${MS_ROM_TEST_SUM_OFFSET.toString(16).toUpperCase()} set to ${msHex16(sum)}`
    );
  };
  const describe = (v) =>
    `${mapSwitch.describeTrigger(v.trigger, v.presses)}, ${mapSwitch.describeScope(v.scope)}, ${v.maps} maps`;
  const rewriteUpper = () => {
    if (version.gen !== MS_WINDOW_POINTER_GEN) return; // generation 5's way; 6 leaves r2 at map 1
    const n = msRewriteUpper(result);
    result.log.push(
      n
        ? `Code: ${n} accesses to the calibration's upper half (0x8000 up, through r2 + 0x10000) and the MAF table readers now read map 1's: lis rX for addis rX, r2`
        : "Code: the accesses to the calibration's upper half and the MAF table readers already read map 1's"
    );
  };
  if (msCarriesVersion(mpc, version)) {
    result.log.push(
      `Code: image already carries this version of the map switch (${describe(version)}), left unchanged`
    );
    rewriteUpper();
    correctRomSum();
    return result;
  }
  if (result.wasAlreadyPatched) {
    const was = msVersionOf(mpc);
    for (let i = MAPSWITCH_FREE_START; i < MAPSWITCH_FREE_END; i++)
      result.mpc[i] = 0xff;
    msWrite32(result.mpc, MS_MIL_STORE_ADDR, MS_MIL_STORE_INSN);
    msWrite32(result.mpc, MS_ECON_STORE_ADDR, MS_ECON_STORE_INSN);
    msWrite32(result.mpc, MS_LOOKUP_ENTRY_17, MS_LOOKUP_STOCK_17);
    result.wasUpdated = true;
    if (!was)
      result.log.push('Code: replaced an earlier build of the map switch');
    else if (
      was.trigger === version.trigger &&
      was.scope === version.scope &&
      was.presses === version.presses &&
      was.maps === version.maps
    ) {
      result.log.push('Code: replaced the earlier version of the map switch');
    } else {
      result.log.push(`Code: replaced the map switch, was ${describe(was)}`);
    }
  }
  result.mpc.set(built.code, MAPSWITCH_FREE_START);
  for (let i = 0; i < built.entries.length; i++)
    msWrite32(
      result.mpc,
      built.entries[i],
      msBranch(built.entries[i], built.lookupStubs[i], false)
    );
  msWrite32(
    result.mpc,
    MS_TACH_STORE_ADDR,
    msBranch(MS_TACH_STORE_ADDR, built.tachStub, true)
  );
  if (msLampHook(version))
    msWrite32(
      result.mpc,
      MS_MIL_STORE_ADDR,
      msBranch(MS_MIL_STORE_ADDR, built.runStub, true)
    );
  for (let i = 0; i < 3; i++)
    msWrite32(result.mpc, MS_NV_DESCRIPTOR + 4 * i, built.nvStubs[i]);
  result.log.push(
    `Code: ${built.entries.length} lookup hooks, gesture/tach routine and stored-data routines, ${built.code.length} bytes at ` +
      `MPC 0x${MAPSWITCH_FREE_START.toString(16).toUpperCase()}, trigger: ${mapSwitch.describeTrigger(version.trigger, version.presses)}, ` +
      `switches ${mapSwitch.describeScope(version.scope)}, cycles through ${version.maps} maps`
  );
  rewriteUpper();
  correctRomSum();
  return result;
}

if (typeof window !== 'undefined') window.mapSwitch = mapSwitch;
if (typeof module !== 'undefined' && module.exports)
  module.exports = { mapSwitch };
