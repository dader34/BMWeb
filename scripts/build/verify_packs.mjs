#!/usr/bin/env node
/**
 * @file Read every packed file the way the app will, before a build ships it.
 */
// A release must not carry a pack its own decoder cannot read. The packers
// (scripts/build/pack_offline.py, tools/export/kfp_spdaten_pack.py) check
// their work with the zstd command; the app unpacks with vendor/fzstd.js, a
// different decoder with a known limit (see that file's header). So before
// a build takes packed data, every file in it is read back here through the
// app's own readers AND fzstd, and checked against its recorded length and
// CRC-32.
//
//   node scripts/build/verify_packs.mjs --site <overlay or site dir>
//   node scripts/build/verify_packs.mjs --spdaten <packed sp-daten folder>
//
// --site     api/ecu-packs: every pack unpacks to its length, every ECU and
//            config checks, and every ECU opens as the archive the app reads;
//            data/ista/packs, data/wiring/packs, data/docs/packs, data/packs,
//            data/etk/packs: every pack, every car's list, every member; and
//            every parts-catalogue picture a car names is there as a file
// --spdaten  every file of every pack is rebuilt and checked
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const R = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'app',
  'renderer'
);
const fzstd = require(join(R, 'vendor', 'fzstd.js'));
const fflate = require(join(R, 'vendor', 'fflate.min.js'));
const packs = require(join(R, 'core', 'packs.js'));
const daten = require(join(R, 'core', 'kfp', 'daten.js'));

let bad = 0;
const fail = (what) => {
  bad++;
  console.error(`  FAILED  ${what}`);
};

/**
 * The ECU packs of a site or overlay folder.
 * @param {string} dir - the folder that holds api/ecu-packs
 */
function site(dir) {
  const at = join(dir, 'api', 'ecu-packs');
  if (!existsSync(join(at, 'index.json'))) {
    console.log(`  no ECU packs in ${dir}`);
    return;
  }
  const index = JSON.parse(readFileSync(join(at, 'index.json'), 'utf8'));
  const members = index.ecus.map((m, n) => ({
    m,
    what: `ECU ${n}`,
    ecu: true,
  }));
  for (const [id, c] of Object.entries(index.chassis)) {
    members.push({ m: c.config, what: `${id} config`, ecu: false });
    for (const [sgbd, n] of Object.entries(c.ecus))
      if (!index.ecus[n])
        fail(`${id} lists ${sgbd} as ECU ${n}, which is not in the index`);
  }
  let bytes = 0;
  let files = 0;
  index.packs.forEach((name, p) => {
    let raw;
    try {
      raw = fzstd.decompress(new Uint8Array(readFileSync(join(at, name))));
    } catch (e) {
      fail(`${name}: ${e.message}`);
      return;
    }
    if (raw.length !== index.raw[p]) {
      fail(`${name} unpacked to ${raw.length} bytes, not ${index.raw[p]}`);
      return;
    }
    for (const { m, what, ecu } of members) {
      if (m[0] !== p) continue;
      const body = raw.subarray(m[1], m[1] + m[2]);
      if (body.length !== m[2] || packs.crc32(body) !== m[3]) {
        fail(`${what} in ${name} is not what was packed`);
        continue;
      }
      try {
        // what the app does with it next
        if (ecu) files += Object.keys(fflate.unzipSync(body)).length;
        else JSON.parse(new TextDecoder().decode(body));
      } catch (e) {
        fail(`${what} in ${name} does not open: ${e.message}`);
      }
      bytes += body.length;
    }
  });
  console.log(
    `  ECU packs: ${index.packs.length} packs, ${index.ecus.length} ECUs ` +
      `(${files} files, ${(bytes / 1e9).toFixed(2)} GB), ` +
      `${Object.keys(index.chassis).length} cars`
  );
}

/**
 * A folder of packed archives (core/packs.js `archives`): every pack, every
 * archive's list, every member.
 * @param {string} at - the folder
 * @param {string} label - what it holds, for the report
 * @param {(what: string, body: Uint8Array) => void} [onMember] - handed
 *   each distinct member that checked, by "<archive>/<member>"
 */
function archives(at, label, onMember) {
  if (!existsSync(join(at, 'index.json'))) {
    console.log(`  no ${label} packs`);
    return;
  }
  const index = JSON.parse(readFileSync(join(at, 'index.json'), 'utf8'));
  /** @type {Map<number, {m: number[], what: string}[]>} members by pack, each once */
  const byPack = new Map();
  const seen = new Set();
  let listed = 0;
  for (const [name, [file, length, crc]] of Object.entries(index.archives)) {
    let list;
    try {
      const raw = fzstd.decompress(
        new Uint8Array(readFileSync(join(at, file)))
      );
      if (raw.length !== length || packs.crc32(raw) !== crc)
        throw new Error('is not what was packed');
      list = JSON.parse(new TextDecoder().decode(raw));
    } catch (e) {
      fail(`the list of ${name}: ${e.message}`);
      continue;
    }
    for (const [member, m] of Object.entries(list)) {
      listed++;
      const key = m.slice(0, 4).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byPack.has(m[0])) byPack.set(m[0], []);
      byPack.get(m[0]).push({ m, what: `${name}/${member}` });
    }
  }
  let bytes = 0;
  index.packs.forEach((name, p) => {
    let raw;
    try {
      raw = fzstd.decompress(new Uint8Array(readFileSync(join(at, name))));
    } catch (e) {
      fail(`${name}: ${e.message}`);
      return;
    }
    if (raw.length !== index.raw[p]) {
      fail(`${name} unpacked to ${raw.length} bytes, not ${index.raw[p]}`);
      return;
    }
    for (const { m, what } of byPack.get(p) || []) {
      const body = raw.subarray(m[1], m[1] + m[2]);
      if (body.length !== m[2] || packs.crc32(body) !== m[3])
        fail(`${what} in ${name} is not what was packed`);
      else if (onMember) onMember(what, body);
      bytes += body.length;
    }
  });
  console.log(
    `  ${label}: ${index.packs.length} packs, ${Object.keys(index.archives).length} archives, ` +
      `${listed} files (${seen.size} distinct, ${(bytes / 1e9).toFixed(2)} GB)`
  );
}

/**
 * The parts catalogue of a site or overlay folder: its packs, and that every
 * picture a car's list names is there as a file.
 * @param {string} dir - the folder that holds data/etk
 */
function etk(dir) {
  const root = join(dir, 'data', 'etk');
  let named = 0;
  const wanted = new Set();
  archives(join(root, 'packs'), 'parts catalogue', (what, body) => {
    if (!what.endsWith('/img.json')) return;
    for (const name of JSON.parse(new TextDecoder().decode(body))) {
      named++;
      wanted.add(name);
    }
  });
  let missing = 0;
  for (const name of wanted) {
    // the same folder rule as the app (screens/etk/data.mjs) and the packer
    const head = name.slice(0, 2).toLowerCase();
    const shard = /^[a-z0-9]{2}$/.test(head) ? head : '_';
    if (!existsSync(join(root, 'img', shard, name))) {
      if (missing++ < 5)
        fail(`picture ${name} is not under data/etk/img/${shard}`);
    }
  }
  if (missing > 5) fail(`${missing - 5} more pictures are missing`);
  if (wanted.size)
    console.log(
      `  parts catalogue pictures: ${named} named by the cars, ${wanted.size} distinct, ` +
        `${missing ? `${missing} MISSING` : 'all there'}`
    );
}

/**
 * A packed SP-Daten folder.
 * @param {string} dir - the folder that holds index.json and packs/
 */
function spdaten(dir) {
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  let files = 0;
  let bytes = 0;
  for (const name of index.packs) {
    try {
      const opened = daten.openPack(
        new Uint8Array(readFileSync(join(dir, 'packs', name))),
        fzstd.decompress
      );
      opened.files.forEach((f, place) => {
        try {
          // read() throws on a file that is not the one that was packed
          bytes += opened.read(place).bytes.length;
          files++;
        } catch (e) {
          fail(`${name}: ${e.message}`);
        }
      });
    } catch (e) {
      fail(`${name}: ${e.message}`);
    }
  }
  console.log(
    `  SP-Daten: ${index.packs.length} packs, ${files} files, ` +
      `${(bytes / 1e9).toFixed(2)} GB read back`
  );
}

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) {
  console.error('usage: verify_packs.mjs --site <dir> | --spdaten <dir>');
  process.exit(2);
}
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--site') {
    site(args[i + 1]);
    archives(join(args[i + 1], 'data', 'ista', 'packs'), 'ISTA bundles');
    archives(join(args[i + 1], 'data', 'wiring', 'packs'), 'wiring archives');
    archives(join(args[i + 1], 'data', 'docs', 'packs'), 'document archives');
    archives(join(args[i + 1], 'data', 'packs'), 'data files');
    etk(args[i + 1]);
  } else if (args[i] === '--spdaten') spdaten(args[i + 1]);
  else {
    console.error(`unknown option ${args[i]}`);
    process.exit(2);
  }
}
if (bad) console.error(`${bad} FAILED: this data must not ship`);
else console.log('  every packed file reads back whole');
process.exit(bad ? 1 : 0);
