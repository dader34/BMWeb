// Flashing/Tuning: the map switch section of Custom Options
// (screens/flashing/options.js draws it). File preparation only: nothing
// here talks to the car. The built pair is handed to Flash Program.

/* exported fbMs, fbMsHtml, fbMsWire, fbMsInputsChanged */

/** The map switch inputs and the last build. */
const fbMs = {
  flash: null,
  mpc: null,
  map1: null,
  /** Maps 2 and up: {cal, name}; a slot without a file stores a copy of map 1. */
  maps: [{ cal: null, name: '(none)' }],
  built: null,
  trigger: 'dsc',
  presses: 4,
};

/** Anything that changes an input throws the last build away. */
/** @returns {string} The section's markup. */
function fbMsHtml() {
  return `
    <div class="fb-section" id="fb-opt-ms-section">
      <div class="fb-code">MAP SWITCH</div>
      <div class="fb-grid2">
        <span class="fb-dim">Trigger</span>
        <span class="fb-radios">
          <label class="fb-check"><input type="radio" name="fb-ms-trigger" value="dsc" checked> DSC button</label>
          <label class="fb-check"><input type="radio" name="fb-ms-trigger" value="shifter"> Gear lever D-S-D / S-D-S, 2 s</label>
          <label class="fb-check"><input type="radio" name="fb-ms-trigger" value="pedals"> Brake + full throttle, 5 s</label>
        </span>
        <span class="fb-dim" id="fb-ms-presses-label">Presses</span>
        <span class="fb-radios" id="fb-ms-presses-row">
          <label class="fb-check"><input type="radio" name="fb-ms-presses" value="4" checked> 4</label>
          <label class="fb-check"><input type="radio" name="fb-ms-presses" value="2"> 2</label>
        </span>
      </div>
      <div class="fb-grid2 fb-files">
        <button class="btn" id="fb-ms-load-flash">External Flash / .0pa...</button><span class="fb-mono fb-dim fb-ellipsis" id="fb-ms-flash">(none)</span>
        <button class="btn" id="fb-ms-load-mpc">MPC Flash / .0pa...</button><span class="fb-mono fb-dim fb-ellipsis" id="fb-ms-mpc">(none)</span>
        <button class="btn" id="fb-ms-load-map1">Map 1 Tune / .0da...</button><span class="fb-mono fb-dim fb-ellipsis" id="fb-ms-map1">(none)</span>
      </div>
      <div class="fb-grid2 fb-files" id="fb-ms-maps"></div>
      <div class="fb-row">
        <button class="btn" id="fb-ms-add-map">Add another map</button>
        <span class="fb-faint" id="fb-ms-space"></span>
      </div>
      <hr class="fb-sep">
      <div class="fb-row">
        <button class="btn primary" id="fb-ms-build" disabled>Build</button>
        <button class="btn" id="fb-ms-save" disabled title="Save the built external flash and MPC flash, checksummed and signed.">Save Files...</button>
        <button class="btn" id="fb-ms-send" disabled title="Load the built pair as the full binary to flash, ready for Flash Program.">Load for Flashing</button>
      </div>
      <div class="fb-mono fb-report" id="fb-ms-report">Choose an external flash and its MPC flash.</div>
    </div>`;
}

/** Wire the trigger choice, the file buttons and Build / Save / Load. */
function fbMsWire() {
  document
    .querySelectorAll(
      'input[name="fb-ms-trigger"], input[name="fb-ms-presses"]'
    )
    .forEach((r) => {
      r.onchange = () => {
        fbMs.trigger = document.querySelector(
          'input[name="fb-ms-trigger"]:checked'
        ).value;
        fbMs.presses = Number(
          document.querySelector('input[name="fb-ms-presses"]:checked').value
        );
        const dsc = fbMs.trigger === 'dsc';
        fbEls['ms-presses-label'].hidden = !dsc;
        fbEls['ms-presses-row'].hidden = !dsc;
        fbMsInputsChanged();
      };
    });
  fbEls['ms-load-flash'].onclick = () => fbMsLoadFlash();
  fbEls['ms-load-mpc'].onclick = () => fbMsLoadMpc();
  fbEls['ms-load-map1'].onclick = () => fbMsLoadMap(1);
  fbEls['ms-add-map'].onclick = () => {
    if (fbMs.maps.length + 2 > mapSwitch.MAX_MAPS) return;
    fbMs.maps.push({ cal: null, name: '(none)' });
    fbMsRenderMaps();
    fbMsInputsChanged();
  };
  fbMsRenderMaps();
  fbEls['ms-build'].onclick = () => fbMsBuild();
  fbEls['ms-save'].onclick = () => fbMsSave();
  fbEls['ms-send'].onclick = () => fbMsSend();
}

/** The rows for maps 2 and up: a file button, the file's name, and a remove button when there is more than one. */
function fbMsRenderMaps() {
  const host = fbEls['ms-maps'];
  if (!host) return;
  host.innerHTML = fbMs.maps
    .map(
      (slot, i) =>
        `<button class="btn" data-ms-map="${i}">Map ${i + 2} Tune / .0da...</button>` +
        `<span class="fb-mono fb-dim fb-ellipsis"><span data-ms-name="${i}"></span>` +
        (fbMs.maps.length > 1
          ? ` <button class="btn fb-ms-remove" data-ms-remove="${i}" title="Take this map out of the build">&times;</button>`
          : '') +
        `</span>`
    )
    .join('');
  fbMs.maps.forEach((slot, i) => {
    host.querySelector(`[data-ms-name="${i}"]`).textContent = slot.name;
    host.querySelector(`[data-ms-map="${i}"]`).onclick = () =>
      fbMsLoadMap(i + 2);
    const remove = host.querySelector(`[data-ms-remove="${i}"]`);
    if (remove)
      remove.onclick = () => {
        fbMs.maps.splice(i, 1);
        fbMsRenderMaps();
        fbMsInputsChanged();
      };
  });
}

/** Map 1 as the build will see it: the file chosen, else the tune in the loaded flash. */
function fbMsEffectiveMap1() {
  if (fbMs.map1) return fbMs.map1;
  if (fbMs.flash && fbMs.flash.length === mapSwitch.FULL_FLASH_LENGTH)
    return mapSwitch.extractCalibration(fbMs.flash);
  return null;
}

/** How the maps fit, shown under the rows; the add button follows it. */
function fbMsRefreshSpace() {
  if (!fbEls['ms-space']) return null;
  const plan = mapSwitch.plan(
    fbMsEffectiveMap1(),
    fbMs.maps.map((s) => s.cal),
    fbMs.flash,
    fbMs.mpc
  );
  const full = fbMs.maps.length + 2 > mapSwitch.MAX_MAPS;
  // one map at a time: the next slot opens once the last one has its file
  const pending = fbMs.maps.findIndex((slot) => !slot.cal);
  fbEls['ms-add-map'].disabled = full || pending >= 0 || !plan.canAddAnother;
  fbEls['ms-add-map'].title = full
    ? `The map switch cycles through at most ${mapSwitch.MAX_MAPS} maps.`
    : pending >= 0
      ? `Load a tune for map ${pending + 2} first.`
      : plan.canAddAnother
        ? ''
        : 'Another map would not fit in the free program flash.';
  const sizes = plan.perMapKb.length
    ? ` (${plan.perMapKb.map((kb, i) => `map ${i + 2}: ${kb} KB`).join(', ')})`
    : '';
  fbEls['ms-space'].textContent = plan.ok
    ? `${fbMs.maps.length + 1} maps, ${plan.kbUsed} of ${plan.kbTotal} KB of map flash used${sizes}${plan.canAddAnother ? '' : full ? '; that is the most maps the code can cycle through' : '; no room for another'}`
    : plan.reason;
  return plan;
}

function fbMsInputsChanged() {
  if (!fbEls['ms-build']) return;
  fbMs.built = null;
  fbEls['ms-save'].disabled = true;
  fbEls['ms-send'].disabled = true;
  const plan = fbMsRefreshSpace();
  if (!fbMs.flash || !fbMs.mpc) {
    fbEls['ms-build'].disabled = true;
    fbEls['ms-report'].textContent =
      'Choose an external flash and its MPC flash.';
    return;
  }
  let blocked = mapSwitch.blockedReason(fbMs.flash, fbMs.mpc);
  if (!blocked && !ms45VerifyFlashMpcMatch(fbMs.flash, fbMs.mpc))
    blocked = 'The external flash and the MPC flash are not a matching pair.';
  if (!blocked && plan && !plan.ok) blocked = plan.reason;
  fbEls['ms-build'].disabled = !!blocked;
  fbEls['ms-report'].textContent = blocked || fbMsDescribeInputs();
}

function fbMsDescribeInputs() {
  const inst = mapSwitch.installed(fbMs.mpc);
  if (!inst) return 'Ready to build.';
  const installed = `${mapSwitch.describeTrigger(inst.trigger, inst.presses)}, ${mapSwitch.describeScope(inst.scope)}, ${inst.maps} maps`;
  if (!mapSwitch.isCurrentVersion(fbMs.mpc))
    return `This pair carries an older map switch (${installed}). Build updates it.`;
  if (
    inst.trigger === fbMs.trigger &&
    (inst.trigger !== 'dsc' || inst.presses === fbMs.presses) &&
    inst.maps === fbMs.maps.length + 1
  )
    return 'This pair already carries the map switch with this trigger and this many maps. Build replaces its maps.';
  return `This pair carries the map switch as ${installed}. Build changes it.`;
}

async function fbMsLoadFlash() {
  const file = await fbPickFile('.bin,.ori,.0PA,.0pa');
  if (!file) return;
  try {
    if (ms45ExchangeFile.isProgramFile(file.name)) {
      const program = ms45ExchangeFile.decodeProgramText(
        await fbReadText(file)
      );
      fbMs.flash = program.flash;
      fbMs.mpc = program.mpc;
      fbEls['ms-flash'].textContent =
        `${file.name}  (${program.reference || 'unknown program'})`;
      fbEls['ms-mpc'].textContent = file.name;
      fbMsInputsChanged();
      return;
    }
    const data = await fbReadBytes(file);
    if (data.length !== MS45_FULL_FLASH_LENGTH) {
      await fbMessage(
        `A flash image is 1 MB. This file is 0x${data.length.toString(16).toUpperCase()} bytes.`,
        'Map Switch'
      );
      return;
    }
    fbMs.flash = data;
    fbEls['ms-flash'].textContent =
      `${file.name}  (${mapSwitch.readProgramVersion(data) || 'unknown program'})`;
    fbMsInputsChanged();
  } catch (e) {
    await fbMessage(
      `Could not load ${file.name}.\n\n${fbDescribeError(e)}`,
      'Map Switch'
    );
  }
}

async function fbMsLoadMpc() {
  const file = await fbPickFile('.bin,.ori,.0PA,.0pa');
  if (!file) return;
  try {
    const data = ms45ExchangeFile.isProgramFile(file.name)
      ? ms45ExchangeFile.decodeProgramText(await fbReadText(file)).mpc
      : await fbReadBytes(file);
    if (data.length !== MS45_MPC_LENGTH) {
      await fbMessage(
        `An MPC flash image is 448 KB (0x70000 bytes). This file is 0x${data.length.toString(16).toUpperCase()} bytes.`,
        'Map Switch'
      );
      return;
    }
    fbMs.mpc = data;
    fbEls['ms-mpc'].textContent = file.name;
    fbMsInputsChanged();
  } catch (e) {
    await fbMessage(
      `Could not load ${file.name}.\n\n${fbDescribeError(e)}`,
      'Map Switch'
    );
  }
}

async function fbMsLoadMap(n) {
  const file = await fbPickFile('.bin,.ori,.0DA,.0da');
  if (!file) return;
  try {
    const cal = ms45ExchangeFile.isDataFile(file.name)
      ? ms45ExchangeFile.decodeCalibrationText(await fbReadText(file)).data
      : mapSwitch.extractCalibration(await fbReadBytes(file));
    const name = `${file.name}  (${mapSwitch.readDataVersion(cal) || 'unknown data version'})`;
    if (n === 1) {
      fbMs.map1 = cal;
      fbEls['ms-map1'].textContent = name;
    } else {
      fbMs.maps[n - 2] = { cal, name };
      fbMsRenderMaps();
    }
    fbMsInputsChanged();
  } catch (e) {
    await fbMessage(
      `Could not load ${file.name}.\n\n${fbDescribeError(e)}`,
      'Map Switch'
    );
  }
}

async function fbMsBuild() {
  try {
    const built = mapSwitch.build(
      fbMs.flash,
      fbMs.mpc,
      fbMs.map1,
      fbMs.maps.map((s) => s.cal || fbMsEffectiveMap1()),
      fbMs.trigger,
      fbMs.presses
    );
    // an EWS-deleted program needs the immobilizer off in the tunes too
    built.flash = await fbDmeMatchImmobilizer(
      built.flash,
      built.mpc,
      ewsDelete.programBytesAreDeleted(
        built.flash[ewsDelete.PROGRAM_STATE_OFFSET],
        built.flash[ewsDelete.PROGRAM_MASK_OFFSET]
      ),
      true,
      'Map Switch',
      built.log
    );
    // checksum and sign here as well, so the saved files are complete on
    // their own; the flash path repeats both
    let cal = Uint8Array.from(
      built.flash.subarray(MS45_CAL_START, MS45_CAL_START + MS45_CAL_LENGTH)
    );
    cal = ms45Checksums.signParameters(
      ms45Checksums.correctParameterChecksums(cal)
    );
    built.flash.set(cal, MS45_CAL_START);
    built.flash = ms45Checksums.correctProgramChecksums(built.flash, built.mpc);
    built.flash = ms45Checksums.signProgram(built.flash, built.mpc);
    fbMs.built = built;
    fbEls['ms-save'].disabled = false;
    fbEls['ms-send'].disabled = false;
    const report = built.log.slice();
    if (built.mapsIdentical)
      report.push(
        built.maps > 2
          ? 'Every map is identical to map 1, so switching will change nothing yet.'
          : 'Map 1 and map 2 are identical, so switching will change nothing yet.'
      );
    report.push('Checksums corrected and both partitions signed.');
    fbEls['ms-report'].textContent = report.join('\n');
    fbSetStatus('Map switch built');
  } catch (e) {
    fbMs.built = null;
    fbEls['ms-save'].disabled = true;
    fbEls['ms-send'].disabled = true;
    fbEls['ms-report'].textContent = `Build failed: ${e.message}`;
  }
}

function fbMsSave() {
  if (!fbMs.built) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  fbSaveBytes(`MS45.1_mapswitch_Flash_${stamp}.bin`, fbMs.built.flash);
  fbSaveBytes(`MS45.1_mapswitch_MPC_${stamp}.bin`, fbMs.built.mpc);
}

async function fbMsSend() {
  if (!fbMs.built) return;
  const d = fbState.dme;
  if (fbState.module !== 'dme' || !d.ident.hwRef) {
    await fbMessage(
      'Identify the DME first, then load the build again.',
      'Map Switch'
    );
    return;
  }
  if (!ms45VerifyProgramMatch(fbMs.built.flash, d.ident.hwRef)) {
    await fbMessage(
      `The built program is for hardware 0044570, but the identified DME reports ${d.ident.hwRef}.`,
      'Map Switch'
    );
    return;
  }
  if (
    !(await fbConfirm(
      "Flashing this rewrites the DME's internal flash. If it does not boot, it cannot be recovered over the diagnostic port. Keep a full read of the car first.\n\nLoad it?",
      'Map Switch'
    ))
  ) {
    return;
  }
  await fbDmeLoadBuiltPair(fbMs.built);
}
