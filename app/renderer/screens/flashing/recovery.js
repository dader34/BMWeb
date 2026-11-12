/**
 * @file The MS45 recoveries (MS45.1 and MS45.0), as the recovery script's
 * host: identify the DME, say whether it needs its program, and when it
 * does, flash the newest program and data for it.
 *
 * The script (home/bmweb-recovery.ips) draws the screen and owns the keys.
 * It starts a step with bmweb_recovery and reads the fields below with
 * bmweb_recovery_read on every cycle of its screen, which is how a step
 * that takes minutes shows its progress without the script waiting on it.
 *
 * NOTHING HERE TALKS TO THE CAR ITSELF. Identify is the Flashing app's
 * Identify; the flash is its Flash Program, with its questions, its checks
 * and its log. For the MS45.1 that is whichever way its own button would
 * reach this DME (the fast flasher, the one-click, the stock loader); for
 * the MS45.0 it is always the DME's own loader. This file chooses the
 * files -- the SP-Daten WebKFP programs from -- and hands them over.
 */

/* exported fbRecoveryFor, IPO_RECOVERY_HOST, FB_RECOVERY_TARGETS, fbRecoveryVerdict, fbRecoveryPick, fbRecoveryNewest, fbRecoveryBar */

/** The DME's programming status when its program runs (the SGBD's word). */
const FB_RECOVERY_NORMAL = 'Normalbetrieb';

/**
 * A DME a recovery is for.
 * @typedef {object} FbRecoveryTarget
 * @property {string} name - What it is called on the screen.
 * @property {string} hwRef - Its hardware reference.
 * @property {string} folder - The SP-Daten folder with its programs and data.
 * @property {boolean} stockLoader - The flash always goes through the DME's
 *   own loader, never the fast flasher or the one-click.
 */

/**
 * The DMEs that have a recovery, by the name the screens open one with.
 * @type {Object<string, FbRecoveryTarget>}
 */
const FB_RECOVERY_TARGETS = {
  ms451: {
    name: 'MS45.1',
    hwRef: '0044570',
    folder: 'MDS451',
    stockLoader: false,
  },
  ms450: {
    name: 'MS45.0',
    hwRef: '0044560',
    folder: 'MDS450',
    stockLoader: true,
  },
};

/** How long the screen's own looking for a DME waits between two tries. */
const FB_RECOVERY_RETRY_MS = 1000;

/** How many characters the progress bar is drawn with. */
const FB_RECOVERY_BAR_CELLS = 40;

/**
 * What an identification says about a DME.
 *   ''        nothing identified yet
 *   'silent'  it did not answer
 *   'other'   it answered and is not the DME this recovery is for
 *   'ok'      that DME, on a working program
 *   'recover' that DME, and not: its loader reports the program or the
 *             data missing, unsigned or mismatched, or it sits in a flasher
 * @param {object|null} dme - The Flashing app's DME state (fbState.dme).
 * @param {FbRecoveryTarget} [target] - The DME the recovery is for (the
 *   MS45.1 when not given).
 * @returns {''|'silent'|'other'|'ok'|'recover'}
 */
function fbRecoveryVerdict(dme, target = FB_RECOVERY_TARGETS.ms451) {
  const id = dme && dme.ident;
  if (!id || id.answered == null) return '';
  if (!id.answered) return 'silent';
  if (id.hwRef !== target.hwRef) return 'other';
  if (id.inFlasher) return 'recover';
  return String(id.programmingStatus || '').trim() === FB_RECOVERY_NORMAL
    ? 'ok'
    : 'recover';
}

/**
 * The program and data a DME should be flashed with: the newest assembly
 * number its own leads to, the way WinKFP's ZB update finds it, and the two
 * files that assembly number names.
 * @param {string} zb - The DME's assembly number (its AIF's ZB number).
 * @param {string} tableText - The family's ZB table (.DAT).
 * @param {string} historyText - Its ZB history (.HIS); '' when it has none.
 * @param {string[]} names - The files its folder holds.
 * @returns {{zb: string, program: string, data: string}}
 * @throws {Error} When the table does not lead from this assembly number to
 *   one whose two files are there.
 */
function fbRecoveryPick(zb, tableText, historyText, names) {
  if (!/^\d{7}$/.test(String(zb || '')))
    throw new Error(
      'The DME does not report its assembly number, so the data that belongs to this car cannot be chosen for it.'
    );
  const rows = kfpDaten.parseZbTable(tableText);
  const row = kfpDaten.latestZb(kfpDaten.parseHistory(historyText), zb, rows);
  if (!row)
    throw new Error(
      `The SP-Daten do not list assembly number ${zb} or anything that replaced it.`
    );
  const files = kfpDaten.filesFor(row, names);
  if (!files.program || !files.data)
    throw new Error(
      `The SP-Daten name assembly number ${row.zb} but do not hold its ${files.program ? 'data' : 'program'} file.`
    );
  return { zb: row.zb, program: files.program, data: files.data };
}

/**
 * The assembly numbers a folder's newest cars carry, newest first, for a
 * DME that does not say which one it is: every row nothing has replaced,
 * whose program and data files are both there. "Newest" is the highest
 * number, which is how the numbers were given out.
 *
 * THIS IS NOT THE CAR'S OWN. A folder holds the data of every engine,
 * gearbox and market the DME was built into, and nothing here knows which
 * of them the car is; the recovery says so before it writes one.
 * @param {string} tableText - The family's ZB table (.DAT).
 * @param {string} historyText - Its ZB history (.HIS); '' when it has none.
 * @param {string[]} names - The files its folder holds.
 * @returns {{zb: string, program: string, data: string}[]}
 */
function fbRecoveryNewest(tableText, historyText, names) {
  const rows = kfpDaten.parseZbTable(tableText);
  const history = kfpDaten.parseHistory(historyText);
  const out = [];
  for (const row of rows) {
    const last = kfpDaten.latestZb(history, row.zb, rows);
    if (!last || last.zb !== row.zb) continue;
    const files = kfpDaten.filesFor(row, names);
    if (files.program && files.data)
      out.push({ zb: row.zb, program: files.program, data: files.data });
  }
  return out.sort((a, b) => Number(b.zb) - Number(a.zb));
}

/** Whether a DME's assembly number is one (seven digits). */
const fbRecoveryZbKnown = (zb) => /^\d{7}$/.test(String(zb || ''));

/**
 * A progress bar in text, the way a bare screen draws one.
 * @param {number} pct - 0..100.
 * @returns {string} "[#####...............]  25 %"
 */
function fbRecoveryBar(pct) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const on = Math.round((p / 100) * FB_RECOVERY_BAR_CELLS);
  return `[${'#'.repeat(on)}${'.'.repeat(FB_RECOVERY_BAR_CELLS - on)}]  ${p} %`;
}

/**
 * How many of the newest assembly numbers are tried, newest first, for a
 * DME that does not report its own, before the recovery gives up: a file
 * that does not decode or does not pair is passed over for the next.
 */
const FB_RECOVERY_NEWEST_TRIES = 6;

/**
 * Fetch the program and data to recover the identified DME with, and build
 * the pair Flash Program writes: the program's external flash with the data
 * in its calibration area, and its MPC.
 *
 * A DME that reports its assembly number gets the newest that replaced it
 * (fbRecoveryPick). One that reports none gets the newest in its folder
 * (fbRecoveryNewest), marked `guessed`: it may not be this car's data.
 * @param {object} dme - fbState.dme, identified.
 * @param {FbRecoveryTarget} target - The DME the recovery is for.
 * @returns {Promise<{zb: string, program: string, data: string,
 *   flash: Uint8Array, mpc: Uint8Array, guessed: boolean}>}
 * @throws {Error} With the reason, in words for the screen.
 */
async function fbRecoveryFetch(dme, target) {
  const folder = target.folder;
  const index = await wkfpSpdIndex();
  const byChassis = index && index.modules && index.modules[folder];
  const chassisList = byChassis ? Object.keys(byChassis).sort() : [];
  if (!chassisList.length)
    throw new Error(
      'The SP-Daten could not be fetched. The recovery needs a connection to get the program and data.'
    );
  const textOf = (e) => (name) =>
    wkfpText(wkfpRemoteFile(e.path + name, name, e.files[name]));
  /** A chassis's folder: its table, its history and its file names. */
  const folderOf = async (chassis) => {
    const entry = byChassis[chassis];
    const names = Object.keys(entry.files);
    const history = names.find(
      (x) => x.toUpperCase() === `${folder.toUpperCase()}.HIS`
    );
    return {
      entry,
      names,
      table: await textOf(entry)(entry.table),
      history: history ? await textOf(entry)(history) : '',
    };
  };
  /** The pair a choice names, decoded and checked against this DME. */
  const build = async (entry, pick) => {
    const text = textOf(entry);
    const program = ms45ExchangeFile.decodeProgramText(
      await text(pick.program)
    );
    if (!ms45VerifyFlashMpcMatch(program.flash, program.mpc))
      throw new Error(
        `${pick.program}: its external program and its MPC do not belong together.`
      );
    if (!ms45VerifyProgramMatch(program.flash, dme.ident.hwRef))
      throw new Error(
        `${pick.program} is not a program for this DME's hardware (${dme.ident.hwRef}).`
      );
    const cal = ms45ExchangeFile.decodeCalibrationText(await text(pick.data));
    if (!ms45ExchangeFile.isMatchingPair(program.flash, cal.data))
      throw new Error(`${pick.data} does not belong to ${pick.program}.`);
    const flash = Uint8Array.from(program.flash);
    flash.set(cal.data, MS45_CAL_START);
    return { ...pick, flash, mpc: program.mpc };
  };

  const zb = dme.aif && dme.aif.AIF_ZB_NR;
  if (fbRecoveryZbKnown(zb)) {
    // the folder is kept per chassis, each with the assembly numbers of the
    // cars it was built into: the one that knows this DME's is the one
    let why = null;
    for (const chassis of chassisList) {
      const f = await folderOf(chassis);
      let pick;
      try {
        pick = fbRecoveryPick(zb, f.table, f.history, f.names);
      } catch (err) {
        // the first chassis's answer is the one to show when none knows it
        if (!why) why = err;
        continue;
      }
      return { ...(await build(f.entry, pick)), guessed: false };
    }
    throw why;
  }

  // no assembly number: the newest across the chassis folders, newest first
  const seen = new Set();
  const newest = [];
  for (const chassis of chassisList) {
    const f = await folderOf(chassis);
    for (const pick of fbRecoveryNewest(f.table, f.history, f.names)) {
      const key = `${pick.zb} ${pick.program} ${pick.data}`.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      newest.push({ entry: f.entry, pick });
    }
  }
  newest.sort((a, b) => Number(b.pick.zb) - Number(a.pick.zb));
  let why = null;
  for (const { entry, pick } of newest.slice(0, FB_RECOVERY_NEWEST_TRIES)) {
    try {
      return { ...(await build(entry, pick)), guessed: true };
    } catch (err) {
      if (!why) why = err;
    }
  }
  throw (
    why ||
    new Error(
      'The SP-Daten hold no program and data for this DME to recover with.'
    )
  );
}

/**
 * The recovery, as the script reaches it.
 * @type {{start: (what: string) => void, read: (what: string) => string,
 *   use: (kind: string) => void}}
 */
const IPO_RECOVERY_HOST = (() => {
  /** The step running now: 'ident', 'watch', 'recover' or null. */
  let running = null;
  /** When the screen's own looking may try again (FB_RECOVERY_RETRY_MS). */
  let watchAfter = 0;
  /** What the last step ended with, when it has something to say. */
  let note = '';
  /** The files the last recovery chose: "7545150  7561382A.0PA + P7561533.0DA". */
  let newest = '';
  /** The DME this recovery is for (use). */
  let target = FB_RECOVERY_TARGETS.ms451;

  /**
   * Point the recovery at a DME, as its screen opens: what the last screen
   * left behind is not this one's.
   * @param {string} kind - A key of FB_RECOVERY_TARGETS.
   */
  function use(kind) {
    target = FB_RECOVERY_TARGETS[kind] || FB_RECOVERY_TARGETS.ms451;
    note = '';
    newest = '';
    watchAfter = 0;
  }

  /** What the identification says about this recovery's DME. */
  const verdictNow = () => fbRecoveryVerdict(dme(), target);

  const dme = () => (typeof fbState !== 'undefined' && fbState.dme) || null;

  /** Whether there is a cable to ask through, without asking for one. */
  const cabled = () =>
    (typeof fbOnSharedCar === 'function' && fbOnSharedCar()) ||
    (typeof webBus !== 'undefined' && !!webBus && !!webBus.connected);

  /**
   * The Flashing app's Identify, on the DME.
   * @param {boolean} [quiet] - A try the screen makes by itself: what
   *   Identify would put up as a message (no answer, the cable) is left in
   *   its log, and the screen asks again.
   */
  async function identify(quiet) {
    fbMountHidden();
    if (fbState.module !== 'dme') {
      fbModuleDd.set('dme');
      fbModuleChanged();
    }
    // a read from before says nothing about the DME now
    fbState.dme.ident = { ...fbState.dme.ident, answered: null };
    if (quiet) await fbQuietly(fbIdentify);
    else await fbIdentify();
  }

  /**
   * The screen looking for a DME by itself: one quiet Identify, while none
   * is identified and a cable is there (the cable is never asked for from
   * here: opening one is the user's click).
   * @returns {(() => Promise<void>)|null} The step, or null when it is not
   *   due.
   */
  function watch() {
    const verdict = verdictNow();
    if (verdict !== '' && verdict !== 'silent') return null;
    if (!cabled() || Date.now() < watchAfter) return null;
    return async () => {
      try {
        await identify(true);
      } finally {
        watchAfter = Date.now() + FB_RECOVERY_RETRY_MS;
      }
    };
  }

  /** Choose the files, ask, hand them to Flash Program, identify again. */
  async function recover() {
    const title = `${target.name} recovery`;
    const d = dme();
    fbSetStatus('Recovery: fetching the newest program and data...');
    const got = await fbRecoveryFetch(d, target);
    newest = `${got.zb}  ${got.program} + ${got.data}`;
    const from = d.aif && d.aif.AIF_ZB_NR;
    // with no assembly number the files are the newest there are, not the
    // car's own: said first, because it is what the user is agreeing to
    const which = got.guessed
      ? `This DME does not report its assembly number, so the data for this car cannot be chosen. The newest in the SP-Daten is ${got.zb}; its data may be for a different engine or gearbox.\n\n`
      : `This DME is assembly number ${from}` +
        `${got.zb === from ? '' : `; the newest that replaced it is ${got.zb}`}.\n\n`;
    const options = [
      d.ews ? 'EWS delete' : '',
      d.protect ? 'spark cut / engine protection' : '',
    ].filter(Boolean);
    const go = await fbConfirm(
      which +
        `Program ${got.program} will be loaded along with data ${got.data}, this will overwrite your current program and tune.\n\n` +
        (options.length
          ? `Custom Options are set in Flashing (${options.join(', ')}) and Flash Program applies them on top. Clear them there first for the files as released.\n\n`
          : '') +
        'Keep the ignition on, a charger on the battery and the cable plugged in until it has finished.\n\n' +
        'Write the program?',
      title
    );
    if (!go) {
      note = 'Recovery not started: nothing was sent to the car.';
      return;
    }
    await fbDmeLoadBuiltPair(
      { flash: got.flash, mpc: got.mpc },
      {
        flashName: `${got.program} + ${got.data}`,
        mpcName: `${got.program} (MPC)`,
        status: `Recovery: loaded ${got.program} and ${got.data}.`,
      }
    );
    // a gate of the loader's own may have been answered No, which unloads
    if (!d.flash || !d.mpc) {
      note = 'Recovery not started: the files were not accepted.';
      return;
    }
    // the question above was this flash's: Flash Program does not ask again
    await fbDmeGuard('Flash Program', () =>
      target.stockLoader
        ? fbDmeViaStockLoader('Flash Program', () =>
            fbDmeFlashProgram({ confirmed: true })
          )
        : fbDmeFlashProgramRoute({ confirmed: true })
    );
    const outcome = fbState.status || '';
    await identify();
    note =
      verdictNow() === 'ok'
        ? 'Recovery finished: the DME is on its program again.'
        : `Recovery did not finish. ${outcome}`;
  }

  /**
   * Start a step and come straight back. One step at a time, and none while
   * the Flashing app itself is talking to the car.
   * @param {string} what - 'ident', 'watch' (the screen's own quiet try,
   *   made only while no DME is identified) or 'recover'.
   */
  function start(what) {
    if (running || (typeof fbState !== 'undefined' && fbState.running)) return;
    const step =
      what === 'ident'
        ? () => identify(false)
        : what === 'watch'
          ? watch()
          : what === 'recover' && verdictNow() === 'recover'
            ? recover
            : null;
    if (!step) return;
    running = what;
    note = '';
    if (what !== 'recover') newest = '';
    step()
      .catch((e) => {
        // a try of the screen's own says nothing and is made again
        if (what === 'watch') return;
        note = `${what === 'ident' ? 'Identify' : 'Recovery'} failed: ${(e && e.message) || e}`;
      })
      .then(() => {
        running = null;
      });
  }

  /** The line that says where things stand, in words. */
  function headline() {
    if (running === 'ident') return 'Identifying the DME...';
    if (running === 'watch') return 'Looking for the DME...';
    if (running === 'recover') return 'Recovering the DME. Do not switch off.';
    const d = dme();
    const verdict = verdictNow();
    if ((verdict === '' || verdict === 'silent') && !cabled())
      return 'No cable connected. Connect it in the top bar.';
    if (verdict === 'silent')
      return 'The DME did not answer. Check the ignition and the cable.';
    if (verdict === 'other')
      return `This is not an ${target.name}. This recovery is for the ${target.name} only.`;
    if (verdict === 'ok') return 'The DME is fine. Nothing to recover.';
    if (verdict === 'recover')
      return d.ident.inFlasher
        ? 'The DME is in a flasher, not on its program. It can be recovered.'
        : 'The DME is not on a working program. It can be recovered.';
    return 'Looking for the DME...';
  }

  /**
   * A program or data reference as the DME gave it, or '' when what it
   * gave is not one: an erased program reads back as twelve FF bytes.
   * @param {string} ref
   * @returns {string}
   */
  const reference = (ref) =>
    /^[\x20-\x7e]+$/.test(String(ref || '')) ? String(ref).trim() : '';

  /**
   * One field, as text.
   * @param {string} what - The field (home/bmweb-recovery.h lists them).
   * @returns {string}
   */
  function read(what) {
    const d = dme();
    const id = (d && d.ident) || {};
    const known = verdictNow() !== '' && !!id.answered;
    switch (what) {
      case 'title':
        return `${target.name} recovery`;
      case 'state':
        return running ? 'busy' : verdictNow();
      case 'headline':
        return headline();
      case 'dme':
        return known ? `${id.type || ''}  ${id.hwRef || ''}`.trim() : '';
      case 'vin':
        return known ? id.vin || '' : '';
      case 'program':
        return known ? reference(id.progRef) : '';
      case 'data':
        return known ? reference(id.swRef) : '';
      case 'assembly':
        return known ? reference(d.aif && d.aif.AIF_ZB_NR) : '';
      case 'status':
        return known
          ? id.inFlasher
            ? 'In a flasher'
            : fbDmeProgrammingStatus(id.programmingStatus || '')
          : '';
      case 'newest':
        return newest;
      case 'step':
        return running ? fbState.status || '' : note;
      case 'bar':
        return running === 'recover' ? fbRecoveryBar(fbState.barPct) : '';
      default:
        return '';
    }
  }

  return { start, read, use };
})();

/**
 * The recovery for one DME, pointed at it: how the rest of the app reaches
 * the recovery (an entry of the flashing part, scripts/build/chunks.json).
 * @param {string} kind - A key of FB_RECOVERY_TARGETS.
 * @returns {{host: typeof IPO_RECOVERY_HOST, name: string}} The script's
 *   host and the DME's name.
 */
function fbRecoveryFor(kind) {
  IPO_RECOVERY_HOST.use(kind);
  return { host: IPO_RECOVERY_HOST, name: FB_RECOVERY_TARGETS[kind].name };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FB_RECOVERY_TARGETS,
    IPO_RECOVERY_HOST,
    fbRecoveryFor,
    fbRecoveryVerdict,
    fbRecoveryPick,
    fbRecoveryNewest,
    fbRecoveryBar,
  };
}
