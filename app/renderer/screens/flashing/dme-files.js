// Flashing/Tuning, the DME's files: loading what is to be flashed (raw
// binaries, BMW's .0PA / .0DA exchange files, a built pair), the pills that
// show them, and the immobilizer checks around every load (a tune and a
// program must agree with each other and with the car). Part of the DME
// screen with dme.js; one scope.
/* exported fbDmeFullBinChanged, fbDmeProgramHasNoTune, fbDmeLoadFile1, fbDmeLoadFile2, fbDmeRemovePairedTune, fbDmeClearExchangeFile, fbDmeLoadBuiltPair, fbDmeMatchImmobilizer, fbDmeGateLoadedFiles, fbDmeStoredMapsHaveStockImmobilizer, fbDmeStoredMapsWithoutImmobilizer */

// ---- loading files ------------------------------------------------------------------------------------
function fbDmeFullBinChanged() {
  const d = fbState.dme;
  d.fullBin = fbEls['dme-fullbin'].checked;
  d.flash = null;
  d.mpc = null;
  d.flashName = '';
  d.mpcName = '';
  fbDmeClearExchangeFile(false);
  fbProgress(0);
  fbRefreshAll();
  fbOptionsRefreshEwsGate();
}

/** A loaded .0PA has no tune in it unless its .0DA was paired. */
function fbDmeProgramHasNoTune() {
  const d = fbState.dme;
  return d.exchangeKind === '0PA' && !d.exchangeTuneLoaded;
}

function fbDmeTuneMismatchPrompt() {
  return fbState.dme.ident.swRef
    ? "Loaded tune does not match DME's program.\n\nDo you wish to load it anyway?"
    : 'No DME has been identified, so this tune cannot be checked against one.\n\nDo you wish to load it anyway?';
}

function fbDmeProgramMismatchPrompt() {
  return fbState.dme.ident.hwRef
    ? 'Loaded program does not match DME hardware.\n\nDo you wish to load it anyway?'
    : 'No DME has been identified, so this program cannot be checked against one.\n\nDo you wish to load it anyway?';
}

async function fbDmeLoadFile1() {
  const d = fbState.dme;
  fbProgress(0);
  try {
    const file = await fbPickFile(
      d.fullBin ? '.bin,.ori,.0PA,.0pa' : '.bin,.ori,.0DA,.0da'
    );
    if (!file) return;
    if (
      ms45ExchangeFile.isProgramFile(file.name) ||
      ms45ExchangeFile.isDataFile(file.name)
    ) {
      await fbDmeLoadExchangeFile(file);
      await fbDmeGateLoadedFiles();
      return;
    }
    const bytes = await fbReadBytes(file);
    if (!d.fullBin) {
      if (bytes.length >= 0x1d000 && bytes.length <= 0x20000) {
        if (
          !ms45VerifyParameterMatch(bytes, d.ident.swRef) &&
          !(await fbConfirm(fbDmeTuneMismatchPrompt(), 'Warning'))
        ) {
          d.flash = null;
          d.mpc = null;
          return;
        }
        d.flash = bytes;
        d.flashName = file.name;
      } else {
        fbSetStatus('Invalid tune file length');
        d.flash = null;
        return;
      }
    } else {
      if (bytes.length !== MS45_FULL_FLASH_LENGTH) {
        fbSetStatus('Invalid flash file length');
        d.flash = null;
        return;
      }
      if (
        !ms45VerifyProgramMatch(bytes, d.ident.hwRef) &&
        !(await fbConfirm(fbDmeProgramMismatchPrompt(), 'Warning'))
      ) {
        d.flash = null;
        d.mpc = null;
        return;
      }
      if (d.mpc && !ms45VerifyFlashMpcMatch(bytes, d.mpc)) {
        if (
          !(await fbConfirm(
            'External flash and MPC flash do not match. Flashing them may permanently brick your DME.\n\nDo you wish to load them anyway?',
            'Warning'
          ))
        ) {
          d.flash = null;
          d.mpc = null;
          return;
        }
      }
      d.flash = bytes;
      d.flashName = file.name;
    }
    fbSetStatus(`Loaded ${file.name}`);
    await fbDmeGateLoadedFiles();
  } finally {
    fbRefreshAll();
    fbOptionsRefreshEwsGate();
  }
}

async function fbDmeLoadFile2() {
  const d = fbState.dme;
  fbProgress(0);
  try {
    if (d.exchangeKind === '0PA') {
      await fbDmeLoadPairedDataFile();
      await fbDmeGateLoadedFiles();
      return;
    }
    const file = await fbPickFile('.bin,.ori');
    if (!file) return;
    const bytes = await fbReadBytes(file);
    if (bytes.length !== MS45_MPC_LENGTH) {
      fbSetStatus('Invalid mpc file length');
      d.mpc = null;
      return;
    }
    if (d.flash && !ms45VerifyFlashMpcMatch(d.flash, bytes)) {
      if (
        !(await fbConfirm(
          'External flash and MPC flash do not match. Flashing them may permanently brick your DME.\n\nDo you wish to load them anyway?',
          'Warning'
        ))
      ) {
        d.flash = null;
        d.mpc = null;
        return;
      }
    }
    d.mpc = bytes;
    d.mpcName = file.name;
    fbSetStatus(`Loaded ${file.name}`);
    await fbDmeGateLoadedFiles();
  } finally {
    fbRefreshAll();
    fbOptionsRefreshEwsGate();
  }
}

/** A .0PA (Full Binary ticked) or a .0DA (unticked) as the file to flash. */
async function fbDmeLoadExchangeFile(file) {
  const d = fbState.dme;
  const isProgram = ms45ExchangeFile.isProgramFile(file.name);
  if (isProgram && !d.fullBin) {
    await fbMessage(
      `${file.name} is a program file. Tick Full Binary to load it.`,
      'Load File'
    );
    return;
  }
  if (!isProgram && d.fullBin) {
    await fbMessage(
      `${file.name} is a data (tune) file. Untick Full Binary to load it.`,
      'Load External'
    );
    return;
  }
  try {
    const text = await fbReadText(file);
    if (isProgram) {
      const program = ms45ExchangeFile.decodeProgramText(text);
      if (!ms45VerifyFlashMpcMatch(program.flash, program.mpc)) {
        await fbMessage(
          `The external program and the MPC inside ${file.name} do not belong together, so the file is not being loaded.`,
          'Load External'
        );
        return;
      }
      if (
        !ms45VerifyProgramMatch(program.flash, d.ident.hwRef) &&
        !(await fbConfirm(fbDmeProgramMismatchPrompt(), 'Warning'))
      )
        return;
      d.flash = program.flash;
      d.mpc = program.mpc;
      d.flashName = file.name;
      d.mpcName = file.name;
      fbDmeShowExchangeFile('0PA', file.name, program.reference);
      fbSetStatus(`Loaded ${file.name} (external program and MPC)`);
    } else {
      const cal = ms45ExchangeFile.decodeCalibrationText(text);
      if (
        !ms45VerifyParameterMatch(cal.data, d.ident.swRef) &&
        !(await fbConfirm(fbDmeTuneMismatchPrompt(), 'Warning'))
      )
        return;
      d.flash = cal.data;
      d.mpc = null;
      d.flashName = file.name;
      fbDmeShowExchangeFile('0DA', file.name, cal.reference);
      fbSetStatus(`Loaded ${file.name}`);
    }
  } catch (e) {
    await fbMessage(
      `Could not load ${file.name}.\n\n${fbDescribeError(e)}`,
      isProgram ? 'Load External' : 'Load File'
    );
  }
}

function fbDmeShowExchangeFile(kind, name, reference) {
  const d = fbState.dme;
  d.exchangeKind = kind;
  fbEls['dme-exchange-text'].textContent = `${kind}: ${name}`;
  fbEls['dme-exchange'].title = reference
    ? `${kind}: ${name}  (${reference})`
    : '';
}

/** Pair a .0DA with the loaded .0PA; only a data file built for that program is accepted. */
async function fbDmeLoadPairedDataFile() {
  const d = fbState.dme;
  const file = await fbPickFile('.0DA,.0da');
  if (!file) return;
  if (!ms45ExchangeFile.isDataFile(file.name)) {
    await fbMessage(`${file.name} is not a .0DA data file.`, 'Load .0da');
    return;
  }
  try {
    const cal = ms45ExchangeFile.decodeCalibrationText(await fbReadText(file));
    if (!ms45ExchangeFile.isMatchingPair(d.flash, cal.data)) {
      await fbMessage(
        `${file.name} does not belong to the loaded program.\n\nThe program is ${mapSwitch.readProgramVersion(d.flash) || 'unknown'} ` +
          `(project ${ms45ExchangeFile.programProjectToken(d.flash) || '?'}), and this data file is ${cal.reference || 'unknown'} ` +
          `(project ${ms45ExchangeFile.calibrationProjectToken(cal.data) || '?'}).\n\nIt has not been loaded.`,
        'Load .0da'
      );
      return;
    }
    const image = Uint8Array.from(d.flash);
    image.set(cal.data, MS45_CAL_START);
    d.flash = image;
    d.exchangeTuneLoaded = true;
    fbEls['dme-tune-text'].textContent = `0DA: ${file.name}`;
    fbEls['dme-tune'].title = cal.reference
      ? `0DA: ${file.name}  (${cal.reference})`
      : '';
    fbSetStatus(`Loaded ${file.name} as the tune for the program`);
  } catch (e) {
    await fbMessage(
      `Could not load ${file.name}.\n\n${fbDescribeError(e)}`,
      'Load .0da'
    );
  }
}

function fbDmeRemovePairedTune() {
  const d = fbState.dme;
  if (!d.exchangeTuneLoaded) return;
  if (d.flash && d.flash.length === MS45_FULL_FLASH_LENGTH) {
    const image = Uint8Array.from(d.flash);
    image.fill(0xff, MS45_CAL_START, MS45_CAL_START + MS45_CAL_LENGTH);
    d.flash = image;
  }
  d.exchangeTuneLoaded = false;
  fbRefreshAll();
}

/**
 * Take the exchange file away and hand the load buttons back.
 * @param {boolean} clearFiles - Also drop the loaded images.
 */
function fbDmeClearExchangeFile(clearFiles) {
  const d = fbState.dme;
  if (d.exchangeKind == null) return;
  d.exchangeKind = null;
  d.exchangeTuneLoaded = false;
  if (clearFiles) {
    d.flash = null;
    d.mpc = null;
    d.flashName = '';
    d.mpcName = '';
    fbProgress(0);
    fbSetStatus('Removed the loaded file');
  }
  fbRefreshAll();
}

// ---- the immobilizer around every load ----------------------------------------------------------------
/**
 * Whatever was just loaded, checked against the immobilizer state it will
 * meet, with a mismatch offered to put right. A refused load is cleared.
 */
async function fbDmeGateLoadedFiles() {
  const d = fbState.dme;
  if (!d.flash) return;
  if (!d.fullBin) {
    if (d.flash.length < MS45_CAL_LENGTH) return;
    await fbDmeGateTuneAgainstCar();
    return;
  }
  if (d.flash.length !== MS45_FULL_FLASH_LENGTH) return;
  const fileProgramDeleted = ewsDelete.programBytesAreDeleted(
    d.flash[ewsDelete.PROGRAM_STATE_OFFSET],
    d.flash[ewsDelete.PROGRAM_MASK_OFFSET]
  );
  if (fbDmeProgramHasNoTune()) {
    if (
      !fileProgramDeleted &&
      d.carTuneEwsDeleted === true &&
      !(await fbConfirm(
        'The tune on the car has the immobilizer switched off, and this program has it on.\n\nA .0PA has no tune in it, so on its own the tune on the car stays as it is, ' +
          'and the car may not start with this program.\n\nTo keep the car EWS deleted, load the program\'s .0DA next with "Load .0da (optional)". The EWS delete can then be applied to both.\n\nDo you wish to load it anyway?',
        'Immobilizer Mismatch'
      ))
    ) {
      fbDmeClearExchangeFile(true);
    }
    return;
  }
  if (!d.mpc) return;
  d.flash = await fbDmeMatchImmobilizer(
    d.flash,
    d.mpc,
    fileProgramDeleted,
    true,
    'Immobilizer Mismatch'
  );
  await fbDmeGateProgramAgainstCar(fileProgramDeleted);
}

async function fbDmeGateProgramAgainstCar(fileProgramDeleted) {
  const d = fbState.dme;
  if (d.carProgramEwsDeleted !== true || fileProgramDeleted || d.ews) return;
  const blocked = fbOptionsEwsBlockedReason();
  if (blocked) {
    await fbMessage(
      `The program on the car is EWS-deleted, but the program in this file is not.\n\nFlashing it puts the immobilizer back, and a car that needed the delete will crank but not start.\n\nThe EWS delete cannot be applied to this file: ${blocked}`,
      'Immobilizer Mismatch'
    );
    return;
  }
  if (
    await fbConfirm(
      'The program on the car is EWS-deleted, but the program in this file is not.\n\nFlashing it as it is puts the immobilizer back, and a car that needed the delete will crank but not start.\n\nApply the EWS delete when flashing?',
      'Immobilizer Mismatch'
    )
  ) {
    d.ews = true;
    fbOptionsRefreshSummary();
    fbSetStatus('EWS delete will be applied to the program before flashing.');
  } else {
    fbSetStatus(
      'Loaded without EWS delete. The car may not start with this program.'
    );
  }
}

async function fbDmeGateTuneAgainstCar() {
  const d = fbState.dme;
  const tune = d.flash;
  if (
    d.carProgramEwsDeleted === true &&
    ewsDelete.calibrationHasStockImmobilizer(tune, 0)
  ) {
    if (
      await fbConfirm(
        'The program on the car is EWS-deleted, but this tune still has the immobilizer switched on.\n\nFlashed like this the car will crank but not start (EWS fault P1665).\n\nClear the immobilizer flags in the tune to match the program?',
        'Immobilizer Mismatch'
      )
    ) {
      d.flash = ewsDelete.applyCalibrationDelete(tune, 0);
      fbSetStatus('Matched tune to EWS-deleted program');
    }
    return;
  }
  if (
    d.carProgramEwsDeleted === false &&
    ewsDelete.calibrationHasDeletedImmobilizer(tune, 0) &&
    !(await fbConfirm(
      'The program on the car has the immobilizer on, but this tune has it switched off.\n\nThe two do not match, and the car may not start like this.\n\nDo you wish to load it anyway?',
      'Immobilizer Mismatch'
    ))
  ) {
    fbDmeClearExchangeFile(false);
    d.flash = null;
    fbSetStatus('Tune not loaded');
  }
}

/**
 * Offer to switch the immobilizer off in the tunes of an image whose program
 * is (or is about to be) EWS-deleted. Map 1 is asked about; map 2, when the
 * image has one, is matched without asking. Returns the image to use.
 * @param {Uint8Array} flash - A full image.
 * @param {Uint8Array} mpc - The MPC.
 * @param {boolean} programDeleted - Whether the program will be EWS-deleted.
 * @param {boolean} checkMap1 - Whether to ask about map 1.
 * @param {string} title - The dialog title.
 * @param {string[]} [log] - Where to add what was done.
 * @returns {Promise<Uint8Array>}
 */
async function fbDmeMatchImmobilizer(
  flash,
  mpc,
  programDeleted,
  checkMap1,
  title,
  log
) {
  if (!programDeleted || !flash || flash.length !== MS45_FULL_FLASH_LENGTH)
    return flash;
  const note = (line) => {
    if (log) log.push(line);
    flashLog.note(line);
  };
  if (
    checkMap1 &&
    ewsDelete.calibrationHasStockImmobilizer(flash, MS45_CAL_START)
  ) {
    if (
      await fbConfirm(
        'The program is EWS-deleted, but the tune (map 1) still has the immobilizer switched on.\n\nFlashed like this the car will crank but not start (EWS fault P1665).\n\nClear the immobilizer flags in the tune to match the program?',
        title
      )
    ) {
      flash = ewsDelete.applyCalibrationDelete(flash, MS45_CAL_START);
      note('Map 1: immobilizer flags cleared to match the EWS-deleted program');
    } else {
      note(
        'WARNING: EWS-deleted program with the immobilizer on in map 1. The car will not start like this.'
      );
    }
  }
  const cleared = fbDmeStoredMapsWithoutImmobilizer(flash, mpc);
  if (cleared.changed) {
    flash = cleared.flash;
    note(
      `${cleared.changed}: immobilizer flags cleared to match the EWS-deleted program`
    );
  }
  return flash;
}

/** Whether any map stored beside map 1 still has the stock immobilizer flags. */
function fbDmeStoredMapsHaveStockImmobilizer(flash, mpc) {
  const maps = mapSwitch.storedMaps(flash, mpc);
  return (
    !!maps &&
    maps.some((cal) => ewsDelete.calibrationHasStockImmobilizer(cal, 0))
  );
}

/**
 * The image with the immobilizer flags cleared in every stored map that has
 * them, the maps laid out again. `changed` names the maps, or is null.
 * @returns {{flash: Uint8Array, changed: string|null}}
 */
function fbDmeStoredMapsWithoutImmobilizer(flash, mpc) {
  const maps = mapSwitch.storedMaps(flash, mpc);
  if (!maps) return { flash, changed: null };
  const which = [];
  const cleared = maps.map((cal, i) => {
    if (!ewsDelete.calibrationHasStockImmobilizer(cal, 0)) return cal;
    which.push(`map ${i + 2}`);
    return ewsDelete.applyCalibrationDelete(cal, 0);
  });
  if (!which.length) return { flash, changed: null };
  const replaced = mapSwitch.replaceStoredMaps(flash, mpc, cleared);
  // the immobilizer flags are table data, so the maps' load sites, and with
  // them the MPC, stay as they are; anything else would need a rebuild
  for (let i = 0; i < mpc.length; i++)
    if (replaced.mpc[i] !== mpc[i])
      throw new Error(
        'clearing the immobilizer flags in the stored maps changed the MPC; rebuild the map switch in Custom Options instead'
      );
  return {
    flash: replaced.flash,
    changed: which.join(', ').replace(/^m/, 'M'),
  };
}

/**
 * Take the map switch build as the full binary to flash (from Custom Options).
 * @param {{flash: Uint8Array, mpc: Uint8Array}} built - The built pair.
 */
async function fbDmeLoadBuiltPair(built) {
  const d = fbState.dme;
  fbDmeClearExchangeFile(false);
  d.fullBin = true;
  fbEls['dme-fullbin'].checked = true;
  d.flash = Uint8Array.from(built.flash);
  d.mpc = Uint8Array.from(built.mpc);
  d.flashName = 'Map switch build (external)';
  d.mpcName = 'Map switch build (MPC)';
  fbRefreshAll();
  fbOptionsRefreshEwsGate();
  fbShowOptions(false);
  fbSetStatus('Loaded the map switch build. Use Flash Program to write it.');
  await fbDmeGateLoadedFiles();
  fbRefreshAll();
  fbOptionsRefreshEwsGate();
}
