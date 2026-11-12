// Flashing/Tuning, the Fast flasher page's "Full backup": everything an
// MS45 (MS45.1 or MS45.0) holds that a flash or a repair can lose, read in
// ONE fast flasher session and handed over as one zip named after the car --
//
//   _Flash.bin            the 1 MB external flash (boot sector, tune, program)
//   _MPC.bin              the 448 KB MPC flash
//   _Tune_0x40000.bin     the tune, [0x40000, 0x5D000) of the external flash
//   _AIF_0x1FB34.bin      the programming log, [0x1FB34, 0x20000)
//   _EEPROM_4K.bin        the 4 KB serial EEPROM
//   manifest.txt          the car, the time, and each file's size and CRC-32
//   session.log           the session's own log (when the history kept one)
//
// The tune and the log are cut out of the external image this session just
// read (every block of it checked against the body's CRC): the same bytes a
// read of their own would return, without the wire time. The EEPROM is the
// one store neither flash image carries, so it is read through the body's
// EEPROM window. Nothing is written to the DME at any point.
//
// To put a backup back on a DME, load its _Flash.bin and _MPC.bin as Flash
// Program's pair and run Flash Program (its own gates, its own question).
/* exported fbBackupHtml, fbBackupRefresh */

/** The tune and the programming log inside the external image: [start, length]. */
const FB_BACKUP_TUNE = [0x40000, 0x1d000];
const FB_BACKUP_AIF = [0x1fb34, 0x4cc];

/** The section. The button is wired in fbBackupRefresh (the page's pattern). */
function fbBackupHtml() {
  return `
      <div class="fb-section" id="fb-backup-section">
        <div class="fb-code">FULL BACKUP</div>
        <div class="fb-row">
          <button class="btn" id="fb-backup-run" disabled
            title="Reads the external flash, the MPC and the EEPROM through the fast flasher and saves them, with the tune and the programming log, as one zip. Nothing is written.">Full backup</button>
        </div>
        <div class="fb-faint" id="fb-backup-reason"></div>
      </div>`;
}

/** Why the backup cannot run, or null. */
function fbBackupWhyNot() {
  const d = fbState.dme;
  if (fbState.module !== 'dme' || !d || !d.identified)
    return 'Identify the DME on the Flashing tab first.';
  if (!fbDmeIsMs45()) return 'The full backup is for the MS45 only.';
  if (typeof webBus === 'undefined' || !webBus.port || !webBus.port.setSignals)
    return 'Needs a cable that can hold the break line (Web Serial or a gateway).';
  if (typeof eepromDump === 'undefined')
    return 'The EEPROM client (core/flash/eeprom.js) is not loaded in this build.';
  if (typeof fflate === 'undefined')
    return 'The zip library (vendor/fflate) is not loaded in this build.';
  return null;
}

/** Wire once, then gate from the state (called by fbFastPaint). */
function fbBackupRefresh() {
  const btn = fbEls['backup-run'];
  if (!btn) return;
  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    // autoEnter: a DME with no flasher on it is entered by the one-click
    // first, as the ISN and EEPROM tools are
    btn.onclick = () => {
      fbShowPage('flashing');
      fbDmeGuard('Full backup', fbBackupRun, { autoEnter: true });
    };
  }
  const why = fbBackupWhyNot();
  btn.disabled = !!why || !!fbState.running;
  fbEls['backup-reason'].textContent =
    why ||
    'Ready: the external flash, the MPC, the tune, the programming log and the EEPROM in one zip. Nothing is written.';
}

/**
 * The zip's contents from what one session read.
 * @param {{vin?: string, hwRef?: string, progRef?: string, swRef?: string}} car
 * @param {{flash: Uint8Array, mpc: Uint8Array, eeprom: Uint8Array}} read
 * @param {Date} when
 * @param {(bytes: Uint8Array) => number} crc32
 * @param {string} [log] - The session's log text, when there is one.
 * @returns {{name: string, files: Record<string, Uint8Array|string>}} The
 *   zip's file name and its entries (manifest.txt and session.log are text).
 */
function fbBackupBundle(car, read, when, crc32, log) {
  if (!read.flash || read.flash.length !== 0x100000)
    throw new Error('Full backup: the external image is not 1 MB');
  if (!read.mpc || read.mpc.length !== 0x70000)
    throw new Error('Full backup: the MPC image is not 448 KB');
  if (!read.eeprom || !read.eeprom.length)
    throw new Error('Full backup: the EEPROM was not read');
  const who = [car.vin, car.hwRef].filter(Boolean).join('_') || 'dme';
  const cut = ([at, len]) => read.flash.slice(at, at + len);
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}` +
    `-${p(when.getHours())}${p(when.getMinutes())}`;
  const parts = [
    [`${who}_Flash.bin`, read.flash, 'external flash, 0x00000-0xFFFFF'],
    [`${who}_MPC.bin`, read.mpc, 'MPC flash, 0x00000-0x6FFFF'],
    [
      `${who}_Tune_0x40000.bin`,
      cut(FB_BACKUP_TUNE),
      'tune, external 0x40000-0x5CFFF',
    ],
    [
      `${who}_AIF_0x1FB34.bin`,
      cut(FB_BACKUP_AIF),
      'programming log, external 0x1FB34-0x1FFFF',
    ],
    [
      `${who}_EEPROM_${read.eeprom.length >> 10}K.bin`,
      read.eeprom,
      'serial EEPROM',
    ],
  ];
  const hex8 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const model =
    car.hwRef === '0044570'
      ? 'MS45.1'
      : car.hwRef === '0044560'
        ? 'MS45.0'
        : 'MS45';
  const manifest = [
    `BMWeb full backup (${model})`,
    `VIN:      ${car.vin || '(not read)'}`,
    `Hardware: ${car.hwRef || '(not read)'}`,
    `Program:  ${car.progRef || '(not read)'}`,
    `Software: ${car.swRef || '(not read)'}`,
    `Read:     ${when.toISOString()}`,
    '',
    'The tune and the programming log are cut out of the external flash',
    'image in this backup; the EEPROM is in neither flash image.',
    '',
    ...parts.map(
      ([name, data, what]) =>
        `${name}  ${data.length} bytes  CRC-32/MPEG-2 ${hex8(crc32(data))}  ${what}`
    ),
    ...(log ? ['', 'session.log  the log of the session that read them'] : []),
    '',
  ].join('\n');
  const files = { 'manifest.txt': manifest };
  if (log) files['session.log'] = log;
  for (const [name, data] of parts) files[name] = data;
  return { name: `${who}_Full_Backup_${stamp}.zip`, files };
}

/**
 * Full backup: one fast flasher session -- the external flash, the MPC and
 * the EEPROM read, the DME restarted on its program, the zip saved.
 */
async function fbBackupRun() {
  const why = fbBackupWhyNot();
  if (why) {
    await fbMessage(why, 'Full backup');
    return;
  }
  const d = fbState.dme;
  // kept across the push's resume: a dropped connection carries on at the
  // block that failed (ffReadArea's `keep`)
  const resume = { ext: {}, mpc: {} };
  let read = null;
  const began = Date.now();
  await fbDmeFastFlash({
    title: 'Full backup',
    operation: 'full-backup',
    what: 'read',
    confirm:
      'Full backup goes through the fast flasher: the DME restarts into it, the 1 MB external flash, the 448 KB MPC and the EEPROM are read, and it restarts on its program. Nothing is written. Engine off.\n\n' +
      'Back up the DME?',
    note: `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / ${fastFlasher.describe(d.fastFlasher)} / full backup`,
    push: async (client, cb) => {
      const t0 = Date.now();
      // the two flash images take all but the last of the bar; the EEPROM
      // is one 4 KB frame
      const r = await fastFlashWire.readImage(client, {
        ...cb,
        progress: (pct) => cb.progress(Math.floor((pct * 98) / 100)),
        mpc: true,
        resume,
      });
      cb.stage('Reading the EEPROM');
      const eeprom = await eepromDump.dump(client);
      cb.progress(99);
      const s = Math.round((Date.now() - t0) / 1000);
      cb.stage('Restarting the DME');
      await client.reset();
      read = { flash: r.flash, mpc: r.mpc, eeprom };
      flashLog.note(
        `Full backup: ${r.flash.length + r.mpc.length + eeprom.length} bytes in ${s} s`
      );
      return {
        ok: true,
        skipped: false,
        summary: 'read the flash, the MPC and the EEPROM',
      };
    },
    // a read changes nothing to identify again for
    after: async () => {},
  });
  if (!read) return;
  const bundle = fbBackupBundle(
    d.ident,
    read,
    new Date(),
    fastFlashWire.crc32,
    await fbBackupSessionLog(began)
  );
  const entries = {};
  for (const [name, data] of Object.entries(bundle.files))
    entries[name] = typeof data === 'string' ? fflate.strToU8(data) : data;
  fbSaveBytes(bundle.name, fflate.zipSync(entries, { level: 6 }));
  fbSetStatus(`Full backup: saved ${bundle.name}`);
}

/**
 * The log of the backup session that just ended, from the history (where
 * the session put it when it stopped). Empty when the history kept none --
 * a browser without storage -- and the zip then goes without it.
 * @param {number} began - When the click started, ms.
 * @returns {Promise<string>}
 */
async function fbBackupSessionLog(began) {
  try {
    const rows = await flashHistory.load();
    const row = rows.find(
      (r) => r.operation === 'full-backup' && r.started >= began && r.hasLog
    );
    const entry = row ? await flashHistory.get(row.id) : null;
    return (entry && entry.log) || '';
  } catch (e) {
    return '';
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fbBackupBundle,
    FB_BACKUP_TUNE,
    FB_BACKUP_AIF,
  };
}
