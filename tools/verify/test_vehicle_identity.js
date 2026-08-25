// Vehicle identity: SGFAM masters, the ZCS -> SA numbering bridge, FA parsing.
//
// The load-bearing fact here is the NAMESPACE SPLIT. A ZCS key yields bit
// indices 0..63; SGET predicates test SA catalog numbers (S205, S210). Those
// are different things, and comparing them directly is what hid 37 of 44
// modules on a real E46. The bridge below is the translation, and the tests
// pin it against BMW's own shipped tables rather than fixtures.
//
//   node tools/verify/test_vehicle_identity.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => { passed++; if (process.env.V) console.log('  ok', what); };

// Lift a run of functions out of the screen file to exercise them directly.
// The screen is a browser script, not a module, so there is nothing to
// require -- but slicing on a comment that has since been reworded silently
// returns -1 and evaluates the WHOLE FILE, which then throws somewhere far
// from the real cause. Both ends are asserted instead.
function liftFrom(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  assert.ok(a >= 0, `marker not found in vehicle-identity.js: ${from}`);
  assert.ok(b > a, `marker not found after ${from}: ${to}`);
  return src.slice(a, b);
}

// The module reads its tables off a window global, the way the renderer does.
global.window = global;
const TABLES = path.join(ROOT, 'app', 'renderer', 'data', 'tables.js');
assert.ok(fs.existsSync(TABLES),
  'data/tables.js missing -- run tools/decompile/ncs_tables.py --write');
// eslint-disable-next-line no-eval
eval(fs.readFileSync(TABLES, 'utf8'));
assert.ok(window.BMW_TABLES, 'tables.js did not set BMW_TABLES');

const VI = require('../../app/renderer/core/vehicle-identity.js');

// ---- 1. SGFAM: who holds the identity --------------------------------------

{
  const m = VI.identityMasters('E46');
  const byName = Object.fromEntries(m.map((x) => [x.sg, x]));
  // Ground truth: vendor/EC-APPS/NCSEXPER/DATEN/E46/E46SGFAM.DAT, the file
  // the chassis's own directory ships. Four masters, and the FA/ZCS split
  // across them is the whole point -- KMB and EWS answer the order, AKMB and
  // ALSZ answer the coding key.
  assert.deepStrictEqual(m.map((x) => x.sg).sort(),
    ['AKMB', 'ALSZ', 'EWS', 'KMB']);
  assert.strictEqual(byName.KMB.fa, true);
  assert.strictEqual(byName.KMB.zcs, false);
  assert.strictEqual(byName.EWS.fa, true);
  assert.strictEqual(byName.EWS.zcs, false);
  assert.strictEqual(byName.AKMB.zcs, true);
  assert.strictEqual(byName.AKMB.fa, false);
  assert.strictEqual(byName.ALSZ.zcs, true);
  ok('SGFAM: E46 has 4 identity masters, FA/ZCS split as BMW ships it');
}

{
  // The CABD is what names the coding file, and two logical ECUs legitimately
  // share one: AKMB and KMB are both C_KMB46.
  const m = Object.fromEntries(VI.identityMasters('E46').map((x) => [x.sg, x]));
  assert.strictEqual(m.KMB.cabd, 'C_KMB46');
  assert.strictEqual(m.AKMB.cabd, 'C_KMB46');
  assert.strictEqual(m.ALSZ.cabd, 'C_LSZA');
  assert.strictEqual(m.EWS.cabd, 'C_EWS3');
  ok('SGFAM: CABD per master, AKMB and KMB share C_KMB46');
}

{
  // Every shipped chassis must name at least one master, or the identity
  // screen silently offers nothing on that car.
  const chassis = Object.keys(window.BMW_TABLES);
  assert.ok(chassis.length >= 10, `only ${chassis.length} chassis`);
  for (const ch of chassis) {
    if (!window.BMW_TABLES[ch].sgfam) continue;
    assert.ok(VI.identityMasters(ch).length > 0, `${ch}: no identity master`);
  }
  ok(`SGFAM: every chassis with a family map names a master (${chassis.length})`);
}

{
  assert.deepStrictEqual(VI.identityMasters('NOPE'), []);
  assert.deepStrictEqual(VI.identityMasters(null), []);
  ok('SGFAM: unknown chassis yields no masters rather than throwing');
}

// ---- 2. mask matching -------------------------------------------------------

{
  // A mask holds when every bit it names is set in the key.
  assert.strictEqual(VI.maskHolds('00000080', '00000080'), true);
  assert.strictEqual(VI.maskHolds('000000FF', '00000080'), true);
  assert.strictEqual(VI.maskHolds('0000007F', '00000080'), false);
  ok('mask: holds only when every named bit is set');
}

{
  // An all-zero mask constrains nothing. BMW uses those rows to RETIRE an
  // entry, so they must match nothing rather than everything -- treating them
  // as a wildcard would attach retired keywords to every car.
  assert.strictEqual(VI.maskHolds('FFFFFFFF', '00000000'), false);
  ok('mask: an all-zero mask matches nothing, not everything');
}

{
  // Keys run to 64 bits, past exact integer range, so comparison must not go
  // through a float. Bit 63 with every lower bit clear is the case that
  // catches a parseInt-based implementation.
  assert.strictEqual(VI.maskHolds('8000000000000000', '8000000000000000'), true);
  assert.strictEqual(VI.maskHolds('7FFFFFFFFFFFFFFF', '8000000000000000'), false);
  assert.strictEqual(VI.maskHolds('FFFFFFFFFFFFFFFF', '0000000000000001'), true);
  ok('mask: 64-bit keys compare exactly (bit 63 survives)');
}

{
  assert.strictEqual(VI.maskHolds('0000', '00000080'), false, 'width mismatch');
  assert.strictEqual(VI.maskHolds(null, '00000080'), false);
  ok('mask: mismatched width or missing key declines');
}

// ---- 3. the bridge: ZCS keys -> SA catalog numbers --------------------------

{
  // Ground truth from E46ZST.000:
  //   H 261 N0699 00000000 0000000000000080 0000000000 1 FOND_AIRBAG
  // and from E46AT.000:
  //   W 261 FOND_AIRBAG
  // so a car whose SA key has bit 7 set carries SA 261, rear side airbags.
  const r = VI.saCodesFromZcs('E46', {
    gm: '00000000', sa: '0000000000000080', vn: '0000000000',
  });
  assert.ok(r.keywords.includes('FOND_AIRBAG'), 'keyword not found');
  assert.ok(r.codes.includes('261'), `261 not in ${r.codes}`);
  assert.strictEqual(r.resolved, true);
  ok('bridge: SA bit 0x80 -> FOND_AIRBAG -> SA 261');
}

{
  // 520 fog lights: H 520 ... 0000200000000000 ... NEBELSCHEINW
  const r = VI.saCodesFromZcs('E46', {
    gm: '00000000', sa: '0000200000000000', vn: '0000000000',
  });
  assert.ok(r.keywords.includes('NEBELSCHEINW'));
  assert.ok(r.codes.includes('520'), `520 not in ${r.codes}`);
  ok('bridge: fog lights resolve to SA 520');
}

{
  // A keyword can carry SEVERAL numbers -- KLIMAAUTOMATIK is SA 534 and 857
  // (two order codes for the same equipment). Both must come through, or a
  // predicate testing the other one fails for no visible reason.
  const r = VI.saCodesFromZcs('E46', {
    gm: '00000000', sa: '0000080000000000', vn: '0000000000',
  });
  assert.ok(r.keywords.includes('KLIMAAUTOMATIK'));
  assert.ok(r.codes.includes('534') && r.codes.includes('857'),
    `expected 534 and 857, got ${r.codes}`);
  ok('bridge: one keyword may carry several SA numbers (534 + 857)');
}

{
  // THE HONESTY REQUIREMENT. Most ZST keywords are body/engine/market names
  // with no catalog number at all. Those must be reported as unresolved, not
  // silently dropped -- a caller that reads "no code" as "option absent"
  // would hide hardware the car really has.
  const r = VI.saCodesFromZcs('E46', {
    gm: 'FFFFFFFF', sa: 'FFFFFFFFFFFFFFFF', vn: 'FFFFFFFFFF',
  });
  assert.ok(r.keywords.length > r.codes.length,
    'expected some keywords to carry no SA number');
  assert.ok(r.unresolved.length > 0, 'unresolved must be reported');
  for (const k of r.unresolved) {
    assert.ok(!r.codes.includes(k), 'unresolved leaked into codes');
  }
  ok(`bridge: reports what it could not resolve (${r.unresolved.length} keywords)`);
}

{
  // Coding-index stamps say WHICH .Cxx a module should be read against, which
  // is a different question from what equipment the car has -- so they are
  // separated out rather than mixed into the keyword list.
  const r = VI.saCodesFromZcs('E46', {
    gm: '00000000', sa: '0000000000200000', vn: '0018640620',
  });
  const stamps = Object.keys(r.ci);
  assert.ok(stamps.length > 0, 'expected coding-index stamps');
  for (const sg of stamps) {
    assert.strictEqual(typeof r.ci[sg], 'number');
    assert.ok(!r.keywords.includes(`${sg}_CI_${r.ci[sg]}`),
      'CI stamp leaked into the equipment keywords');
  }
  ok(`bridge: coding-index stamps kept apart from equipment (${stamps})`);
}

{
  // An empty key resolves to nothing, and says so, rather than throwing.
  const r = VI.saCodesFromZcs('E46', {
    gm: '00000000', sa: '0000000000000000', vn: '0000000000',
  });
  assert.deepStrictEqual(r.codes, []);
  assert.strictEqual(r.resolved, false);
  ok('bridge: an all-zero key resolves nothing and reports unresolved');
}

{
  // The codes are the namespace SGET actually tests, so they must be bare
  // decimal with no padding -- "261", never "0261" (both spellings appear in
  // AT.000 and only one matches a predicate).
  const r = VI.saCodesFromZcs('E46', {
    gm: '00000000', sa: '0000000000000080', vn: '0000000000',
  });
  for (const c of r.codes) {
    assert.ok(/^[1-9][0-9]*$/.test(c), `padded or non-numeric code ${c}`);
  }
  ok('bridge: SA numbers are unpadded decimal, as predicates spell them');
}

// ---- 4. FA: the vehicle order ----------------------------------------------

const FA = 'E46_#0303*BW32%0A08&N6TT|7531125$205$210$880';

{
  const f = VI.parseFa(FA);
  assert.strictEqual(f.br, 'E46');
  assert.strictEqual(f.date, '#0303');   // the '#' stays IN the token
  assert.strictEqual(f.typ, 'BW32');
  assert.strictEqual(f.lack, '0A08');
  assert.strictEqual(f.polster, 'N6TT');
  assert.deepStrictEqual(f.zusbau, ['7531125']);
  assert.deepStrictEqual(f.sa, ['205', '210', '880']);
  ok('FA: every marker lands in its own field');
}

{
  // The order dictionary keys date codes by their '#'-prefixed form, so
  // stripping the marker loses the lookup entirely.
  const f = VI.parseFa(FA);
  assert.ok(f.date.startsWith('#'), 'the # must stay part of the date token');
  ok('FA: the date keeps its # (the dictionary keys it that way)');
}

{
  // ROUND-TRIP. Rebuilding must replay each token's OWN marker. Re-deriving
  // markers from dictionary category flattens them all to '$', which is the
  // documented way to get an order rejected.
  const f = VI.parseFa(FA);
  assert.strictEqual(VI.formatFa(f), FA);
  ok('FA: parse -> format round-trips byte for byte');
}

{
  // An order with several build numbers and many options still round-trips.
  const long = 'E90_#0907*VA31%A52%&LCSW|7531125|7529012$205$210$249$494$880';
  assert.strictEqual(VI.formatFa(VI.parseFa(long)), long);
  ok('FA: round-trips repeated markers and empty values');
}

{
  // FA's $ tokens ARE catalog numbers -- this is why an FA car needs no
  // bridge at all.
  assert.deepStrictEqual(VI.saCodesFromFa(FA), ['205', '210', '880']);
  assert.deepStrictEqual(VI.saCodesFromFa('E46_$0205$210'), ['205', '210'],
    'zero-padded SA must normalise to the predicate spelling');
  ok('FA: SA tokens are catalog numbers, normalised unpadded');
}

{
  assert.strictEqual(VI.parseFa(''), null);
  assert.strictEqual(VI.parseFa(null), null);
  assert.strictEqual(VI.parseFa('NOMARKERS'), null);
  assert.deepStrictEqual(VI.saCodesFromFa(''), []);
  ok('FA: junk input declines rather than inventing an order');
}

{
  // The labels come from the same dictionary the bridge uses.
  assert.ok(/AUTOMATIK/.test(VI.saLabel('E46', '205') || ''),
    'SA 205 should be named AUTOMATIK');
  assert.strictEqual(VI.saLabel('E46', '999999'), null);
  ok('FA: SA numbers get their order-dictionary label, or null');
}

// ---- 5. the two paths agree -------------------------------------------------

{
  // Whichever way the car reports itself, the filter downstream consumes ONE
  // namespace. A ZCS car and an FA car listing the same equipment must
  // produce the same shape of answer.
  const viaFa = VI.saCodesFromFa('E46_$261');
  const viaZcs = VI.saCodesFromZcs('E46', {
    gm: '00000000', sa: '0000000000000080', vn: '0000000000',
  }).codes;
  assert.ok(viaFa.includes('261') && viaZcs.includes('261'),
    'the two identity paths disagree on SA 261');
  ok('both identity paths land in the SA-number namespace');
}

// ---- 6. finding the key region without guessing -----------------------------
//
// The ZCS region sits at a WORTADR that MOVES between coding variants -- on
// E46 KMB it is word 104 on C02-C06 and word 368 on C07-C08. The old editor
// guessed that offset with a regex over field names and fell back to 0 when
// it found nothing, which reads three keys out of unrelated bytes and shows
// them as the car's. The keys carry Mod-36 check characters, so the region
// can be FOUND instead of guessed.

{
  const Zcs = require('../../app/renderer/core/coding-zcs.js');
  global.CodingZcs = Zcs;
  const screen = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'vehicle-identity.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(liftFrom(screen, 'function viFindRegion', '// The vehicle order,'));

  const region = (gm, sa, vn) => {
    const out = [];
    const push = (full, n) => {
      for (let i = 0; i < n * 2; i += 2) out.push(parseInt(full.substr(i, 2), 16));
      out.push(full.charCodeAt(n * 2));       // the Mod-36 check character
    };
    push(Zcs.formatGm(gm), 4);
    push(Zcs.formatSa(sa), 8);
    push(Zcs.formatVn(vn), 5);
    return out;
  };
  const REG = region('1A2B3C4D', '0000000000000080', '0018640620');
  assert.strictEqual(REG.length, 20);

  // The real E46 KMB addresses are among these.
  for (const off of [0, 7, 104, 368]) {
    const blob = new Array(off).fill(0xAA).concat(REG, new Array(11).fill(0x55));
    const found = viFindRegion(blob);
    assert.ok(found, `region planted at ${off} was not found`);
    assert.strictEqual(found.offset, off);
    assert.strictEqual(found.sa, '0000000000000080');
  }
  ok('region: found by check character at any offset (incl. word 104 and 368)');

  // AND IT MUST DECLINE. Returning offset 0 for a blob with no valid region
  // is the old bug; a wrong region shown as the car's identity is worse than
  // saying the read failed.
  assert.strictEqual(viFindRegion(new Array(60).fill(0xAA)), null);
  assert.strictEqual(viFindRegion(new Array(60).fill(0x00)), null);
  assert.strictEqual(viFindRegion([1, 2, 3]), null, 'too short');
  ok('region: declines rather than falling back to offset 0');
}

// ---- 7. discovery: the ECU's own declaration, not a list of names ----------
//
// The old scan looked for hand-written spellings (GM_SCHLUESSEL, ZCS_SA) on
// hand-written module names (kmb, ike, kombi, ih). Both were wrong on the
// shipped corpus: E46's cluster is `kombi46`, and its keys are named GM/SA/VM.
// Discovery asks the SGBD what it declares instead.
//
// The runtime serves those declarations from /api/ecu/<sgbd>/results/<JOB> as
// "NAME : comment" strings. This suite feeds the pickers the SAME declarations
// out of the shipped metadata, through a stub shaped like that endpoint, so a
// change to either side has to keep agreeing with BMW's own data.

(async () => {
  const zlib = require('zlib');
  const bestvm = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'core', 'bestvm.js'), 'utf8');
  try { eval(bestvm); } catch (e) { /* only isWriteJob is needed here */ }
  assert.strictEqual(typeof isWriteJob, 'function',
    'the write classifier must load: discovery depends on it');

  const metaOf = (sgbd) => JSON.parse(zlib.gunzipSync(fs.readFileSync(
    path.join(ROOT, 'data', 'ecu-src', `${sgbd}.meta.json.gz`))));

  // Stand in for the two endpoints discovery uses, answering in the SHAPES
  // the runtime answers in: job names only, and "NAME : comment" per job.
  global.api = async (route) => {
    const m = /^\/api\/ecu\/([^/]+)\/(jobs|results)(?:\/(.+))?$/.exec(route);
    if (!m) throw new Error(`unexpected route ${route}`);
    const jobs = metaOf(m[1]).jobs;
    if (m[2] === 'jobs') return Object.keys(jobs);
    const j = jobs[decodeURIComponent(m[3])];
    if (!j) throw new Error(`results/${m[3]} not found`);
    return (j.results || []).map((r) => `${r.name} : ${r.comment || ''}`);
  };

  const screen = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'vehicle-identity.js'), 'utf8');
  eval(liftFrom(screen, 'const VI_KEY_ROLE', '// WHICH CONTROL UNITS HOLD'));

  const jobsOf = async (sgbd) => viJobs(sgbd);

  // THE SPELLING TRAP. ZCS_LESEN calls the third key VM; C_ZCS_LESEN calls it
  // VN. A typed list containing only VN loses a key on every E46 module.
  const ews = await viPickZcsJob('ews', await jobsOf('ews'));
  assert.ok(ews, 'ews declares ZCS_LESEN and must be found');
  assert.strictEqual(ews.job, 'ZCS_LESEN');
  assert.deepStrictEqual(ews.keys, { gm: 'GM', sa: 'SA', vn: 'VM' });
  ok('discovery: ews key names come from the declaration (VM, not VN)');

  // The E46 cluster is `kombi46` -- not `kmb`, which is what SGFAM calls it
  // and what a name transform would have produced.
  const kJobs = await jobsOf('kombi46');
  const kombi = await viPickZcsJob('kombi46', kJobs);
  assert.ok(kombi, 'kombi46 holds the coding key');
  assert.strictEqual(kombi.job, 'ZCS_LESEN');
  const kombiFa = await viPickFaJob('kombi46', kJobs);
  assert.ok(kombiFa && kombiFa.job === 'C_FA_LESEN');
  assert.strictEqual(kombiFa.result, 'FAHRZEUGAUFTRAG');
  ok('discovery: the E46 cluster is found as kombi46, holding both records');

  // E60+ answer with an order rather than keys.
  const cJobs = await jobsOf('cas');
  const cas = await viPickFaJob('cas', cJobs);
  assert.ok(cas, 'cas holds the vehicle order');
  assert.strictEqual(cas.result, 'FAHRZEUGAUFTRAG');
  assert.strictEqual(await viPickZcsJob('cas', cJobs), null,
    'cas has no coding key and must not claim one');
  ok('discovery: E60+ resolves to the order, and declines the key');

  // NEVER A WRITE. The corpus ships C_ZCS_AUFTRAG and STEUERN_FAHRZEUGAUFTRAG
  // beside the reads; an identity screen that picked one would change the car.
  for (const sgbd of ['ews', 'kombi46', 'cas']) {
    const js = await jobsOf(sgbd);
    const picked = [await viPickZcsJob(sgbd, js), await viPickFaJob(sgbd, js)]
      .filter(Boolean).map((x) => x.job);
    for (const j of picked) {
      assert.strictEqual(isWriteJob(j), false, `${sgbd}: picked a write (${j})`);
    }
  }
  ok('discovery: only read jobs are ever selected');

  // A module with no identity job must say so rather than offering one.
  assert.strictEqual(await viPickZcsJob('lsz', []), null);
  assert.strictEqual(await viPickFaJob('lsz', []), null);
  assert.strictEqual(await viPickZcsJob('lsz', await jobsOf('lsz')), null,
    'lsz declares no key-returning job and must not be claimed as a master');
  ok('discovery: a module without the job is not claimed as a master');

  console.log(`vehicle-identity: ${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
