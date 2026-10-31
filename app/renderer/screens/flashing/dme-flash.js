// Flashing/Tuning, the DME's stock writes: Flash Tune, Flash Program (also
// Install fast flasher, a full flash with the flasher spliced in) and Finish
// Programming, all through BMW's own loader over KWP. Part of the DME screen
// with dme.js; one scope.
/* exported fbDmeFlashTune, fbDmePrepareTuneCal, fbDmeFlashProgram, fbDmeProgramMatchPrompts, fbDmeApplyProgramEdits, fbDmeChipImage, fbDmeVerifyProgramming */

// ---- Flash Tune ----------------------------------------------------------------------------------------
async function fbDmeFlashTune() {
  const d = fbState.dme;
  if (!d.identified || !d.flash) return;
  let success = true;
  fbFlashingBar(true);
  await fbSessionStart('flash-tune', {
    vin: d.ident.vin,
    module: d.ident.hwRef,
  });
  try {
    flashLog.note(
      `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / diag ${d.ident.diagProtocol}${d.flashName ? ` / file ${d.flashName}` : ''}`
    );
    if (!(await fbProgrammingCounter(false))) return;
    // the other maps of a block-layout map switch take what they do not
    // store from map 1, so a new map 1 changes them too
    if (
      d.carMapLayout === 'blocks' &&
      d.carMapCount > 1 &&
      !(await fbConfirm(
        `The car carries the map switch with ${d.carMapCount} maps. Maps 2 and up store only what differs from map 1 and take the rest from it, so writing a different map 1 changes them as well.\n\nTo keep them as they are, rebuild the map switch with this tune as map 1 and flash the program instead.\n\nWrite the tune anyway?`,
        'Flash Tune'
      ))
    ) {
      fbSetStatus('Tune not written');
      return;
    }
    const cal = await fbDmePrepareTuneCal();
    const result = await fbFlashRun('dme-tune', {
      cal,
      diagProtocol: d.ident.diagProtocol,
      aifArgs: fbAifArgs(),
      describe: `DME calibration (Flash Tune), data version ${mapSwitch.readDataVersion(cal) || 'unknown'}`,
      vin: d.ident.vin,
      hwRef: d.ident.hwRef,
    });
    success = result.ok;
    fbSetStatus(result.status);
  } finally {
    fbFlashingBar(false);
    fbProgress(0);
    if (success) await fbDmeIdentify(true);
    await fbSessionStop();
  }
}

/**
 * The calibration a tune flash writes, taken from the loaded image and, when
 * the program on the DME is EWS-deleted but the tune is not, matched to it
 * (with the user's consent). Shared by Flash Tune and Fast Flash Tune so the
 * bytes that reach the car are identical whichever path writes them. The
 * read it makes happens before any programming session opens.
 * @returns {Promise<Uint8Array>} The 0x1D000-byte calibration, not yet signed.
 */
async function fbDmePrepareTuneCal() {
  const d = fbState.dme;
  const calFromFull = d.fullBin || d.flash.length > 0x40000;
  let cal = calFromFull
    ? Uint8Array.from(d.flash.subarray(0x40000, 0x40000 + MS45_CAL_LENGTH))
    : Uint8Array.from(d.flash.subarray(0, MS45_CAL_LENGTH));
  let programDeleted = false;
  if (
    fbDmeIsMs451() &&
    (d.ident.progRef || '').includes(ewsDelete.SUPPORTED_PROGRAM_VERSION)
  ) {
    const progBytes = await ms45ReadCarBytes(
      ewsDelete.PROGRAM_STATE_OFFSET,
      ewsDelete.PROGRAM_MASK_OFFSET,
      'ROMX',
      d.ident.diagProtocol
    );
    if (
      progBytes &&
      progBytes.length ===
        ewsDelete.PROGRAM_MASK_OFFSET - ewsDelete.PROGRAM_STATE_OFFSET + 1
    ) {
      programDeleted = ewsDelete.programBytesAreDeleted(
        progBytes[0],
        progBytes[progBytes.length - 1]
      );
      flashLog.note(
        `Program EWS bytes on DME: ${progBytes[0].toString(16)} / ${progBytes[progBytes.length - 1].toString(16)} -> ${programDeleted ? 'EWS-DELETED' : 'stock/immobilizer-active'}`
      );
    } else {
      flashLog.note(
        'Could not read the program EWS bytes to check for a tune mismatch; continuing.'
      );
    }
  }
  if (programDeleted && ewsDelete.calibrationHasStockImmobilizer(cal, 0)) {
    if (
      await fbConfirm(
        'The current program that is on your DME is EWS deleted, and requires a matching edit in the tune. Apply the EWS delete to the uploaded tune?',
        'EWS Delete Mismatch'
      )
    ) {
      cal = ewsDelete.applyCalibrationDelete(cal, 0);
      flashLog.note(
        'Applied cal EWS delete to the tune to match the EWS-deleted program.'
      );
      fbSetStatus('Matched tune to EWS-deleted program');
    } else {
      flashLog.note(
        'User declined matching the tune to the EWS-deleted program; the car may not start.'
      );
    }
  }
  return cal;
}

// ---- Flash Program --------------------------------------------------------------------------------------
/**
 * The immobilizer-match questions a program flash asks, before the
 * diagnostic session opens (a prompt left waiting cannot time it out).
 * Shared by Flash Program and Fast Flash Program so their targets come out
 * the same. Also where the spark-cut / protection config is checked.
 * @param {string} title - The dialog title.
 * @returns {Promise<{clearMap1: boolean, clearMap2: boolean}|null>} Null when
 *   the config is bad and the flow must stop.
 */
async function fbDmeProgramMatchPrompts(title) {
  const d = fbState.dme;
  // the spark cut and engine protection are checked before anything is
  // opened or erased
  if (d.protect) {
    const bad =
      ms45Protect.configError(d.protect) || fbOptionsProtectBlockedReason();
    if (bad) {
      await fbMessage(bad, 'Engine Protection');
      return null;
    }
  }
  let clearMap1 = false;
  let clearMap2 = false;
  if (d.flash.length === MS45_FULL_FLASH_LENGTH) {
    const programDeleted =
      d.ews ||
      ewsDelete.programBytesAreDeleted(
        d.flash[ewsDelete.PROGRAM_STATE_OFFSET],
        d.flash[ewsDelete.PROGRAM_MASK_OFFSET]
      );
    const matched = await fbDmeMatchImmobilizer(
      d.flash,
      d.mpc,
      programDeleted,
      !d.ews && !fbDmeProgramHasNoTune(),
      title
    );
    clearMap1 =
      ewsDelete.calibrationHasStockImmobilizer(d.flash, MS45_CAL_START) &&
      !ewsDelete.calibrationHasStockImmobilizer(matched, MS45_CAL_START);
    clearMap2 =
      fbDmeStoredMapsHaveStockImmobilizer(d.flash, d.mpc) &&
      !fbDmeStoredMapsHaveStockImmobilizer(matched, d.mpc);
  }
  return { clearMap1, clearMap2 };
}

/**
 * The program images with every option applied -- the EWS delete, the
 * immobilizer matches the prompts asked for, the spark cut / engine
 * protection -- exactly as Flash Program writes them (and Fast Flash Program
 * too: it lands what a full flash would). Asks nothing; throws (with
 * `.title` for the dialog) when an edit cannot be applied, which is always
 * before anything is opened or erased.
 * @param {{clearMap1: boolean, clearMap2: boolean}} prompts
 * @returns {{source: Uint8Array, mpc: Uint8Array}}
 */
function fbDmeApplyProgramEdits(prompts) {
  const d = fbState.dme;
  let source = d.flash;
  if (d.ews) {
    try {
      source = ewsDelete.apply(source);
      fbSetStatus('Applied EWS delete');
      for (const line of ewsDelete.describe())
        flashLog.note(`EWS delete edit: ${line}`);
    } catch (e) {
      fbSetStatus(`EWS delete failed: ${e.message}`);
      throw Object.assign(new Error(e.message), { title: 'EWS Delete' });
    }
  }
  if (prompts.clearMap1) {
    source = ewsDelete.applyCalibrationDelete(source, MS45_CAL_START);
    flashLog.note(
      'Immobilizer flags cleared in the tune (map 1) to match the program'
    );
  }
  if (prompts.clearMap2) {
    const cleared = fbDmeStoredMapsWithoutImmobilizer(source, d.mpc);
    source = cleared.flash;
    flashLog.note(
      `Immobilizer flags cleared in ${cleared.changed || 'the stored maps'} to match the program`
    );
  }
  let mpc = d.mpc;
  if (d.protect !== undefined) {
    try {
      if (d.protect) {
        const gated = ms45Protect.apply(source, mpc, d.protect);
        source = gated.flash;
        mpc = gated.mpc;
        for (const line of gated.log) flashLog.note(line);
        fbSetStatus('Applied spark cut / engine protection');
      } else if (ms45Protect.isApplied(source, mpc)) {
        const plain = ms45Protect.remove(source, mpc);
        source = plain.flash;
        mpc = plain.mpc;
        flashLog.note('Engine protection: taken out of the program');
        fbSetStatus('Removed spark cut / engine protection');
      }
    } catch (e) {
      fbSetStatus(`Engine protection failed: ${e.message}`);
      throw Object.assign(new Error(e.message), { title: 'Engine Protection' });
    }
  }
  return { source, mpc };
}

/**
 * The image as the chip will hold it after this program flash: the signed
 * program, and -- when the calibration is written with it -- the
 * calibration slice as it is signed for its own write (the 1 MB image's
 * slice is the file's raw bytes until then). Fast Flash Program sends this
 * and compares the DME against it.
 * @param {Uint8Array} source - The prepared external image.
 * @param {Uint8Array} mpcOut - The MPC image as it is sent.
 * @param {boolean} hasCal
 * @returns {Uint8Array}
 */
function fbDmeChipImage(source, mpcOut, hasCal) {
  const signed = ms45Checksums.signProgram(
    ms45Checksums.correctProgramChecksums(source, mpcOut),
    mpcOut
  );
  if (!hasCal) return signed;
  const chip = Uint8Array.from(signed);
  chip.set(
    ms45Checksums.signParameters(
      ms45Checksums.correctParameterChecksums(
        Uint8Array.from(
          source.subarray(MS45_CAL_START, MS45_CAL_START + MS45_CAL_LENGTH)
        )
      )
    ),
    MS45_CAL_START
  );
  return chip;
}

async function fbDmeFlashProgram(opts = {}) {
  const d = fbState.dme;
  if (!d.identified || !d.flash || !d.mpc) return false;
  const title = opts.title || 'Flash Program';
  // what the pair carries besides itself: the caller's body (the bootloader
  // install's installer), else nothing -- an old resident flasher left in a
  // read is taken out with its MPC hook (the bootloader is the fast path)
  const carry = opts.carry || fastFlasher.withoutFlasher;
  const prompts = await fbDmeProgramMatchPrompts(title);
  if (!prompts) return false;
  // true once the flash itself has gone through (the caller's next step
  // depends on it); an early way out below leaves it false
  let success = false;
  fbFlashingBar(true);
  await fbSessionStart('flash-program', {
    vin: d.ident.vin,
    module: d.ident.hwRef,
  });
  try {
    flashLog.note(
      `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / diag ${d.ident.diagProtocol} / EWS delete ${d.ews}${d.flashName ? ` / ${d.flashName}` : ''}${d.mpcName && d.mpcName !== d.flashName ? ` + ${d.mpcName}` : ''}`
    );
    if (!(await fbProgrammingCounter(false))) return false;
    let images;
    try {
      images = fbDmeApplyProgramEdits(prompts);
      // spliced before signing: whatever the carry adds sits inside a
      // signed program segment (fbFlashRun's flash signs it)
      const carried = carry(images.source, images.mpc);
      images = { source: carried.flash, mpc: carried.mpc };
      // last of all: a patch that redoes a sum of its own (live tune's
      // ROM-test sum) has to see every other edit already made
      if (opts.patch) {
        const patched = opts.patch(images.source, images.mpc);
        images = { source: patched.flash, mpc: patched.mpc };
      }
    } catch (e) {
      await fbMessage(e.message, e.title || title);
      return false;
    }
    const { source, mpc } = images;
    const hasCal = d.flash.length >= 0x5d000 && !fbDmeProgramHasNoTune();
    const mpcOut = mpc;
    const progRef = ms45ReadAscii(source, 0x6031c, 12);
    const result = await fbFlashRun(
      'dme-program',
      {
        flash: source,
        mpc: mpcOut,
        hasCal,
        diagProtocol: d.ident.diagProtocol,
        aifArgs: fbAifArgs(progRef),
        describe: `DME program ${progRef || '(unreadable version)'}${hasCal ? ' + calibration' : ''}${opts.carry ? ' + installer body' : ''}${opts.patchName ? ` + ${opts.patchName}` : ''}, 1 MB external + 448 KB MPC`,
        vin: d.ident.vin,
        hwRef: d.ident.hwRef,
      },
      opts.confirmed ? { confirm: false } : {}
    );
    success = result.ok;
    fbSetStatus(result.status);
  } finally {
    fbFlashingBar(false);
    fbProgress(0);
    if (success) await (opts.after ? opts.after() : fbDmeIdentify(true));
    await fbSessionStop();
  }
  return success;
}

// ---- Finish Programming (Settings) ---------------------------------------------------------------------------
async function fbDmeVerifyProgramming() {
  const d = fbState.dme;
  if (!d.identified || fbState.running) return;
  if (
    !(await fbConfirm(
      "This runs the DME's program and calibration signature checks and resets it. Nothing is written.\n\nUse it when a flash stopped after the program was written but before it was verified: the program and the tune are on the DME, but it stays in the bootloader (programming status 5) until both checks have passed.\n\nIgnition on, engine off. Continue?",
      'Finish Programming'
    ))
  ) {
    return;
  }
  if (!(await fbEnsureCable())) return;
  fbBusy(true);
  fbShowPage('flashing');
  let success = true;
  fbFlashingBar(true);
  await fbSessionStart('verify-program', {
    vin: d.ident.vin,
    module: d.ident.hwRef,
  });
  try {
    flashLog.note(
      `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / diag ${d.ident.diagProtocol}`
    );
    if (!(await fbProgrammingCounter(false))) {
      success = false;
      return;
    }
    if (!(await ms45SecurityAccess(d.ident.diagProtocol, fbSetStatus))) {
      fbSetStatus('Security Access Denied');
      success = false;
      return;
    }
    // while in programming mode: the default session refuses the write
    await fbWriteAif();
    fbSetStatus('Checking the program signature');
    success = await ms45FinishFlash(
      'Programm',
      false,
      d.ident.diagProtocol,
      fbSetStatus
    );
    if (!success) {
      fbSetStatus('Program signature check failed');
      return;
    }
    fbProgress(50);
    fbSetStatus('Checking the calibration signature');
    success = await ms45FinishFlash(
      'Daten',
      true,
      d.ident.diagProtocol,
      fbSetStatus
    );
    if (!success) {
      fbSetStatus('Calibration signature check failed');
      return;
    }
    fbProgress(100);
    fbSetStatus('Both signatures verified, DME reset');
  } catch (e) {
    success = false;
    fbSetStatus(`Verification failed: ${e.message}`);
    await fbMessage(fbDescribeError(e), 'Finish Programming');
  } finally {
    fbFlashingBar(false);
    fbProgress(0);
    if (success) {
      try {
        await fbDmeIdentify(true);
      } catch (e) {
        fbSetStatus(`Identify failed: ${e.message}`);
      }
    }
    await fbSessionStop();
    fbBusy(false);
    fbRefreshAll();
  }
}
