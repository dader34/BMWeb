// Headless test for the CDH coding-dispatch runtime (coding-dispatch.js): it
// must execute a derived A_<cabd> dispatcher program end-to-end, route by
// jobname to the write handler, and produce the BMW coding job sequence with a
// correctly framed 22-byte request packet -- all against a mock bus, no car.
//
//   node tools/verify/test_coding_dispatch.js
//
// The exec fixture is generated on the fly from the vendored A_KMB46.IPO via
// tools/export/ipo_exec.py --coding, so the test also proves the export path.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CD = require(path.join(ROOT, 'app/renderer/core/coding-dispatch.js'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

function findKmbCabd() {
  const base = path.join(ROOT, 'vendor/EC-APPS/NCSEXPER/DATEN');
  if (!fs.existsSync(base)) return null;
  for (const chassis of fs.readdirSync(base)) {
    const dir = path.join(base, chassis);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    const m = files.find((f) => /^KMB_E46\.C0/i.test(f));
    if (m) return path.join(dir, m);
  }
  return null;
}

function buildExec() {
  const out = path.join(require('os').tmpdir(), 'A_KMB46.test.ipoexec.json');
  const args = [path.join(ROOT, 'tools/export/ipo_exec.py'), 'A_KMB46', out, '--coding'];
  const cabd = findKmbCabd();
  if (cabd) args.push(`--cabd=${cabd}`);
  execFileSync('python3', args, { cwd: ROOT });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

async function main() {
  const exec = buildExec();
  ok(exec.coding === true, 'exec marked coding');
  ok(!!exec.procs.cabimain && !!exec.procs.Cod, 'has cabimain + Cod');
  // KMB is a word-mode module: the exec must carry that from the CABD.
  if (exec.dataOrg) {
    ok(exec.dataOrg.wortBreite === 2, 'KMB dataOrg is word mode (wortBreite 2)');
    ok(exec.dataOrg.byteFolge === 1, 'KMB dataOrg is MSB (byteFolge 1)');
  }
  // const 449 must have inlined to the JOBNAME literal (pool numbering)
  const jn = exec.procs.cabimain.find((t) => t.op === 'const' && t.v === 'JOBNAME');
  ok(!!jn, 'JOBNAME const inlined in cabimain');

  // a 20-byte coding region
  const slots = [];
  for (let a = 0; a < 20; a++) slots.push({ addr: a, value: 0x40 + a, mask: 0xff, flags: 0 });

  const jobs = [];
  let packet = null;
  async function runJob(sgbd, job, argText, o) {
    jobs.push({ job, write: !!(o && o.allowWrites), binary: !!(o && o.binary) });
    if (job === 'C_S_LESEN' || job === 'C_S_AUFTRAG') {
      packet = Array.from(argText, (c) => c.charCodeAt(0));
    }
    if (job === 'IDENT') return [{ JOB_STATUS: 'OKAY', ID_COD_INDEX: '06' }];
    if (/LESEN/.test(job)) return [{ JOB_STATUS: 'OKAY', CODIERDATEN: '00'.repeat(20) }];
    return [{ JOB_STATUS: 'OKAY' }];
  }

  const r = await CD.runCodingDispatch(exec, {
    sgbd: 'C_KMB46', slots, jobname: 'SG_CODIEREN', confirmed: true, runJob,
    dataOrg: exec.dataOrg,
  });
  ok(r.ok, 'dispatch reports ok');
  ok(jobs.length > 0, 'dispatch issued jobs');
  ok(jobs.some((j) => j.job === 'IDENT'), 'issued IDENT (coding index read)');
  ok(jobs.some((j) => j.job === 'C_S_LESEN' && j.binary),
    'issued C_S_LESEN with a binary request');
  ok(jobs.some((j) => j.job === 'C_CHECKSUM'), 'issued C_CHECKSUM');

  // the framed packet: 22-byte header, correct count/addr fields, payload@0x15.
  // word count is always 20 (slots); byte count and length scale with word
  // width, which comes from the CABD (KMB = word mode, wb 2).
  const wb = (exec.dataOrg && exec.dataOrg.wortBreite) || 1;
  ok(!!packet, 'captured a C_S packet');
  if (packet) {
    ok(packet[0] === 1, 'packet dataType = 1');
    ok(packet[1] === wb, `packet word width @0x01 = ${wb}`);
    ok((packet[13] | (packet[14] << 8)) === 20 * wb, `byte count @0x0D = ${20 * wb}`);
    ok((packet[15] | (packet[16] << 8)) === 20, 'word count @0x0F = 20');
    ok((packet[17] | (packet[18] << 8)) === 0, 'wire addr @0x11 = 0');
    ok(packet.length === 21 + 20 * wb, `packet length = 21 + ${20 * wb}`);
  }

  // refuses without confirmation
  let refused = false;
  try { await CD.runCodingDispatch(exec, { sgbd: 'C_KMB46', slots, runJob }); }
  catch (e) { refused = /confirmed/.test(e.message); }
  ok(refused, 'refuses without opts.confirmed');

  // refuses a non-coding program
  let refused2 = false;
  try { await CD.runCodingDispatch({ procs: {}, coding: false }, { confirmed: true, runJob }); }
  catch (e) { refused2 = /coding-dispatcher/.test(e.message); }
  ok(refused2, 'refuses a non-coding program');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
