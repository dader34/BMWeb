#!/usr/bin/env node
// The Full backup's bundle (screens/flashing/dme-backup.js): the zip's
// entries from what one session read -- the two flash images whole, the tune
// and the programming log cut out of the external image at their addresses,
// the EEPROM, and a manifest naming each with its size and CRC -- and the
// page wiring the rendered page needs. No hardware.
//
//   node tools/verify/test_backup.js
if (typeof global.window === 'undefined') global.window = {};
const fs = require('fs');
const path = require('path');
const {
  fbBackupBundle,
  FB_BACKUP_TUNE,
  FB_BACKUP_AIF,
} = require('../../app/renderer/screens/flashing/dme-backup.js');
const bytes = require('../../app/renderer/core/bytes/index.mjs');

let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}${detail ? ' -- ' + detail : ''}`);
  } else console.log(`  ok    ${what}`);
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const flash = new Uint8Array(0x100000);
for (let i = 0; i < flash.length; i++) flash[i] = (i * 7 + (i >> 9)) & 0xff;
const mpc = new Uint8Array(0x70000).fill(0x5a);
const eeprom = new Uint8Array(0x1000).fill(0xee);
const car = {
  vin: 'WBATEST0000000001',
  hwRef: '0044570',
  progRef: '0044570LO02S',
  swRef: '0044570',
};
const when = new Date(2026, 10, 10, 9, 5);
const b = fbBackupBundle(car, { flash, mpc, eeprom }, when, bytes.crc32Mpeg2);
const who = 'WBATEST0000000001_0044570';

check(
  'bundle: the zip is named after the car and the time',
  b.name === `${who}_Full_Backup_20261110-0905.zip`,
  b.name
);
check(
  'bundle: six entries, the five files and the manifest',
  Object.keys(b.files).sort().join(' ') ===
    [
      `${who}_AIF_0x1FB34.bin`,
      `${who}_EEPROM_4K.bin`,
      `${who}_Flash.bin`,
      `${who}_MPC.bin`,
      `${who}_Tune_0x40000.bin`,
      'manifest.txt',
    ]
      .sort()
      .join(' '),
  Object.keys(b.files).join(' ')
);
check(
  'bundle: the flash, the MPC and the EEPROM are the bytes read',
  same(b.files[`${who}_Flash.bin`], flash) &&
    same(b.files[`${who}_MPC.bin`], mpc) &&
    same(b.files[`${who}_EEPROM_4K.bin`], eeprom)
);
check(
  'bundle: the tune is [0x40000, 0x5D000) of the external image',
  FB_BACKUP_TUNE[0] === 0x40000 &&
    FB_BACKUP_TUNE[1] === 0x1d000 &&
    same(b.files[`${who}_Tune_0x40000.bin`], flash.subarray(0x40000, 0x5d000))
);
check(
  'bundle: the programming log is [0x1FB34, 0x20000) of the external image',
  FB_BACKUP_AIF[0] + FB_BACKUP_AIF[1] === 0x20000 &&
    same(b.files[`${who}_AIF_0x1FB34.bin`], flash.subarray(0x1fb34, 0x20000))
);
const manifest = b.files['manifest.txt'];
const crcOf = (d) =>
  (bytes.crc32Mpeg2(d) >>> 0).toString(16).toUpperCase().padStart(8, '0');
check(
  'manifest: the car, and every file with its size and CRC',
  typeof manifest === 'string' &&
    manifest.includes(car.vin) &&
    manifest.includes(car.progRef) &&
    Object.entries(b.files)
      .filter(([n]) => n !== 'manifest.txt')
      .every(([n, d]) =>
        manifest.includes(`${n}  ${d.length} bytes  CRC-32/MPEG-2 ${crcOf(d)}`)
      )
);
check(
  'bundle: a car with no VIN or reference still gets a name',
  fbBackupBundle({}, { flash, mpc, eeprom }, when, bytes.crc32Mpeg2).name ===
    'dme_Full_Backup_20261110-0905.zip'
);
// ---- MS45.0: same geometry, the manifest names the model it read ------------
const car450 = {
  vin: 'WBANA52054B566269',
  hwRef: '0044560',
  progRef: '0044560CE',
  swRef: '0044560',
};
const b450 = fbBackupBundle(
  car450,
  { flash, mpc, eeprom },
  when,
  bytes.crc32Mpeg2
);
check(
  'ms45.0: the bundle reads the same way, named after the 45.0 car',
  b450.name === 'WBANA52054B566269_0044560_Full_Backup_20261110-0905.zip' &&
    same(b450.files['WBANA52054B566269_0044560_Flash.bin'], flash) &&
    same(b450.files['WBANA52054B566269_0044560_MPC.bin'], mpc)
);
check(
  'ms45.0: the manifest says MS45.0, the 45.1 bundle still says MS45.1',
  b450.files['manifest.txt'].includes('full backup (MS45.0)') &&
    manifest.includes('full backup (MS45.1)')
);
check(
  'ms45.0: an unknown DME still bundles, labelled MS45',
  fbBackupBundle(
    { hwRef: '0000000' },
    { flash, mpc, eeprom },
    when,
    bytes.crc32Mpeg2
  ).files['manifest.txt'].includes('full backup (MS45)')
);

const refuses = (what, read) => {
  let threw = false;
  try {
    fbBackupBundle(car, read, when, bytes.crc32Mpeg2);
  } catch (e) {
    threw = true;
  }
  check(what, threw);
};
refuses('bundle: a short external image is refused', {
  flash: flash.subarray(0, 0x80000),
  mpc,
  eeprom,
});
refuses('bundle: a missing MPC is refused', { flash, mpc: null, eeprom });
refuses('bundle: a missing EEPROM is refused', { flash, mpc, eeprom: null });

// ---- the session log ---------------------------------------------------------
const logged = fbBackupBundle(
  car,
  { flash, mpc, eeprom },
  when,
  bytes.crc32Mpeg2,
  '# BMWeb Flashing/Backups log\nline'
);
check(
  'log: a session log goes in as session.log and the manifest names it',
  logged.files['session.log'] === '# BMWeb Flashing/Backups log\nline' &&
    logged.files['manifest.txt'].includes('session.log')
);
check(
  'log: without one the zip has no session.log',
  !('session.log' in b.files) && !manifest.includes('session.log')
);

// ---- the page wiring (no DOM: the invariants the rendered page needs) ---------
const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('app/renderer/index.html');
const srcAt = (src) => html.indexOf(`src="${src}"`);
const order = (a, b2) =>
  srcAt(a) !== -1 && srcAt(b2) !== -1 && srcAt(a) < srcAt(b2);
check(
  'page: the zip library, the EEPROM client and the fast session load before the screen, the page after',
  order('vendor/fflate.min.js', 'screens/flashing/dme-backup.js') &&
    order('core/flash/eeprom.js', 'screens/flashing/dme-backup.js') &&
    order('screens/flashing/dme-fast.js', 'screens/flashing/dme-backup.js') &&
    order('screens/flashing/dme-backup.js', 'screens/flashing/fast-page.js')
);
check(
  'page: the offline export ships the screen',
  read('app/renderer/core/offline-export.js').includes(
    "'screens/flashing/dme-backup.js'"
  )
);
const fastPage = read('app/renderer/screens/flashing/fast-page.js');
check(
  'page: the fast page mounts the section and repaints it',
  fastPage.includes('${fbBackupHtml()}') &&
    fastPage.includes('fbBackupRefresh();')
);
const screen = read('app/renderer/screens/flashing/dme-backup.js');
const ids = ['backup-section', 'backup-run', 'backup-reason'];
check(
  'page: the section carries every id the wiring looks up',
  ids.every((id) => screen.includes(`id="fb-${id}"`))
);
const corpus = (html.match(/src="[^"]+\.js"/g) || [])
  .map((s) => s.slice(5, -1))
  .map((src) => {
    try {
      return read(`app/renderer/${src}`);
    } catch (e) {
      return '';
    }
  })
  .join('\n');
const helpers = [
  'fbDmeGuard',
  'fbDmeFastFlash',
  'fbDmeIsMs45',
  'fbShowPage',
  'fbMessage',
  'fbSaveBytes',
  'fbSetStatus',
];
const declared = (name) =>
  new RegExp(`function\\s+${name}\\s*\\(`).test(corpus);
check(
  'page: every helper the screen calls is declared in the loaded corpus',
  helpers.every(declared),
  helpers.filter((h) => !declared(h)).join(' ')
);
check(
  'page: the wire and the EEPROM client expose what the screen uses',
  /readImage:\s*ffReadImage/.test(corpus) &&
    /crc32:\s*ffWireBytes\.crc32Mpeg2/.test(corpus) &&
    /dump:\s*dumpEeprom/.test(corpus)
);

check(
  'page: the history the session log comes from is loaded',
  /const flashHistory\s*=/.test(corpus) && /async load\(\)/.test(corpus)
);

console.log(
  failures ? `\nfull backup: ${failures} FAILED` : '\nfull backup: ALL PASS'
);
process.exit(failures ? 1 : 0);
