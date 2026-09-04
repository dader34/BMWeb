// Find an ECU's generated files in the per-car tree.
//
// data/chassis/<CHASSIS>/<ECU>/ holds everything for one ECU, and an SGBD used
// by several cars is written into each of them. The copies are written
// together by tools/sgbd/ecu_tree.py, so any one of them will do -- this just
// finds the first.
//
// The Python side is the writer; this is the read-only mirror the JS test
// harnesses need.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const TREE = path.join(ROOT, 'data', 'chassis');
const CONFIG = path.join(ROOT, 'data', 'chassis-config');

let _owners = null;

// {sgbd: [[chassis, ecuCode], ...]} from INPA's resolved config
function owners() {
  if (_owners) return _owners;
  _owners = {};
  if (!fs.existsSync(CONFIG)) return _owners;
  for (const f of fs.readdirSync(CONFIG)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(CONFIG, f), 'utf8'));
    } catch {
      continue;
    }
    const cid = f.slice(0, -5);
    for (const sec of cfg.sections || []) {
      for (const e of sec.ecus || []) {
        const sgbd = (e.sgbd || '').toLowerCase();
        if (!sgbd) continue;
        (_owners[sgbd] = _owners[sgbd] || []).push([cid, e.code]);
      }
    }
  }
  return _owners;
}

function ecuDirs(sgbd) {
  return (owners()[String(sgbd).toLowerCase()] || []).map(([cid, code]) =>
    path.join(TREE, cid, code)
  );
}

// Read one file for an SGBD, transparently inflating a .gz sibling. Returns
// null when no car ships it.
function readEcu(sgbd, name) {
  for (const d of ecuDirs(sgbd)) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    if (fs.existsSync(`${p}.gz`)) {
      return zlib.gunzipSync(fs.readFileSync(`${p}.gz`)).toString('utf8');
    }
  }
  return null;
}

function readEcuJson(sgbd, name) {
  const s = readEcu(sgbd, name);
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Every screens.json in the tree, ONCE each. An SGBD in several cars has a
// copy per car; walking the folders blind would count it many times over, so
// key by SGBD and take the first. Returns [{sgbd, chassis, code, path}].
function screenCorpus() {
  const seen = new Set();
  const out = [];
  if (!fs.existsSync(TREE)) return out;
  for (const cid of fs.readdirSync(TREE).sort()) {
    const cd = path.join(TREE, cid);
    if (!fs.statSync(cd).isDirectory()) continue;
    for (const code of fs.readdirSync(cd).sort()) {
      const p = path.join(cd, code, 'screens.json');
      if (!fs.existsSync(p)) continue;
      let sgbd = code.toLowerCase();
      const ep = path.join(cd, code, 'ecu.json');
      if (fs.existsSync(ep)) {
        try {
          sgbd = JSON.parse(fs.readFileSync(ep, 'utf8')).sgbd || sgbd;
        } catch {
          /* keep the folder name */
        }
      }
      if (seen.has(sgbd)) continue;
      seen.add(sgbd);
      out.push({ sgbd, chassis: cid, code, path: p });
    }
  }
  return out;
}

module.exports = {
  ROOT,
  TREE,
  owners,
  ecuDirs,
  readEcu,
  readEcuJson,
  screenCorpus,
};
