#!/usr/bin/env node
// A deep link may name a variant the car answered with, not a configured row.
//
//   #car/E46/me9k_ng4   -- the car answers as me9k_ng4; the E46 menu lists ME9_4N
//
// The variant's own record carries identifiedVariantOf, but that names the row
// it was DISCOVERED under (the first on its address), and one bus address
// hosts many modules: the E46's D_0012 carries nine (DDE30/40, D50M57, BMS46,
// ME9_4N, MS420/430/450, MSS54M3). So among the rows on that address, the one
// whose INPA script DECLARES the variant wins: ME9_4N.IPO lists
// "ME9K_5,ME9K_6,ME9K42,ME9K_NG4". Opening a petrol ME9 on the DDE40 diesel
// row would be wrong, and no SGBD name is compared but the one BMW wrote.
//
//   node tools/verify/test_deep_link_variant.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { irDeclaresSgbd } = require('../../app/renderer/screens/module/ir.js');
const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (m) => {
  passed++;
  if (process.env.V) console.log('  ok', m);
};

const cfg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data/chassis-config/E46.json'), 'utf8')
);
const rows = (cfg.sections || []).flatMap((s) =>
  (s.ecus || []).map((e) => ({ ...e, _sec: s.name }))
);

// a row's INPA script, as /api/ecu/<sgbd>/ipoexec serves it
const exec = (sgbd) => {
  const p = path.join(
    ROOT,
    'data/chassis/E46',
    String(sgbd).toLowerCase(),
    'ipoexec.json.gz'
  );
  return fs.existsSync(p)
    ? JSON.parse(zlib.gunzipSync(fs.readFileSync(p)))
    : null;
};

// the resolution the screen performs, in the same order
function resolve(want, rec) {
  const direct = rows.find((e) => String(e.sgbd).toLowerCase() === want);
  if (direct) return direct;
  if (!rec) return null;
  const par = String(rec.identifiedVariantOf || '').toLowerCase();
  const grp = String(rec.group || '').toLowerCase();
  const onAddr = rows.filter(
    (e) => String(e.group || '').toLowerCase() === grp
  );
  const named = rows.find(
    (e) =>
      par &&
      (String(e.sgbd).toLowerCase() === par ||
        String(e.code || '').toLowerCase() === par)
  );
  return (
    onAddr.find((e) => irDeclaresSgbd(exec(e.sgbd), want)) ||
    named ||
    onAddr[0] ||
    null
  );
}

{
  // the real record, as /api/ecu/me9k_ng4/ecu serves it
  const rec = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'data/chassis/E46/me9k_ng4/ecu.json'),
      'utf8'
    )
  );
  // The trap: me9k_ng4's named parent is whichever row the generator met
  // first on address D_0012 -- DDE40 on disk, DME338DS in some builds --
  // and D_0012 carries eight modules, so the name says nothing about which
  // engine this is. Either way it must not open a diesel row.
  const onAddr = rows.filter(
    (e) =>
      String(e.group || '').toLowerCase() === String(rec.group).toLowerCase()
  );
  assert.ok(onAddr.length > 1, 'the engine address really is shared');
  const hit = resolve('me9k_ng4', rec);
  assert.ok(hit, 'the link still resolves to a row');
  // its named parent is DDE40, a real row -- the diesel. The script that
  // declares it wins over that name.
  assert.strictEqual(
    String(rec.identifiedVariantOf).toUpperCase(),
    'DDE40',
    'the record names the diesel row it was discovered under'
  );
  assert.strictEqual(
    hit.code,
    'ME9_4N',
    'it opens on the ME9 row, whose script declares ME9K_NG4'
  );
  ok('a variant opens on the row whose INPA script declares it');
  assert.ok(
    !irDeclaresSgbd(exec('dde40kw0'), 'me9k_ng4'),
    "the diesel's script does not declare it"
  );
}
{
  // GS20: the named parent IS a row, so it wins outright
  const rec = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data/chassis/E46/gs20/ecu.json'), 'utf8')
  );
  const hit = resolve('gs20', rec);
  assert.ok(hit, 'gs20 resolves');
  assert.strictEqual(
    String(hit.code).toLowerCase(),
    String(rec.identifiedVariantOf).toLowerCase(),
    'the named parent wins when it really is a row'
  );
  ok('a variant whose parent is a configured row opens that row');
}
{
  // a configured SGBD never reaches the fallback
  const hit = resolve('ms450ds0', null);
  assert.strictEqual(
    hit && hit.code,
    'MS450',
    'a configured row resolves directly'
  );
  ok('a configured SGBD resolves on the first pass');
}

console.log(`deep-link-variant: ${passed} checks passed`);
