/**
 * @file NCS Expert's files and profile, and the FSW_PSW format — the pure
 * helpers behind the NCS screen (ncs.js). Kept apart so the screen is only
 * the window and its flow.
 *
 * NCS reads a module's coding as FSW_PSW.TRC: one function (FSW) per line
 * with its parameter (PSW) indented beneath. The expert copies that to
 * FSW_PSW.MAN, edits it, and codes the module (SG_CODIEREN) with the MAN laid
 * over what the module holds.
 */

/* exported ncsProfile, ncsSaveProfile, ncsFiles, ncsSaveFiles, ncsParamName,
   ncsParamHex, ncsTraceText, ncsParseMan, ncsManEdits, ncsDownload,
   NCS_PROFILES, NCS_JOBS_KNOWN */

/** Where the profile (NCS's .PFL) is kept. */
const NCS_PROFILE_STORE = 'bmweb.ncs.profile';
/** Where the work files (FSW_PSW.MAN/.TRC, NETTODAT.TRC, ERROR.LOG) are kept. */
const NCS_FILES_STORE = 'bmweb.ncs.files';
/** ERROR.LOG lines kept. */
const NCS_LOG_KEEP = 2000;

/** The profiles NCS ships with. */
const NCS_PROFILES = {
  expert: 'Expertmode',
};

/** @type {object} */
const NCS_PROFILE_DEFAULTS = {
  id: 'expert',
  /** Read FSW/PSW: 'inactive' | 'cvt' | 'file' */
  fswPsw: 'cvt',
  fswFile: '',
  trace: true,
  manipulate: true,
  keyEnter: true,
  keyEcu: true,
  keyFile: true,
  keyChassis: true,
  deleteBeforeInput: false,
};

/** The jobs a coding script answers, as NCS lists them. */
const NCS_JOBS_KNOWN = [
  'SG_CODIEREN',
  'CODIERDATEN_LESEN',
  'CODIERINDEX_LESEN',
  'FGNR_LESEN',
  'FGNR_SCHREIBEN',
  'ZCS_LESEN',
  'ZCS_SCHREIBEN',
  'ZCS_LOESCHEN',
  'NETTODATEN_SCHREIBEN',
  'TEILBEREICH_CODIEREN',
  'ID_LESEN',
];

/**
 * The profile, defaults filled in.
 * @returns {object}
 */
function ncsProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(NCS_PROFILE_STORE) || 'null');
    return { ...NCS_PROFILE_DEFAULTS, ...(p || {}) };
  } catch {
    return { ...NCS_PROFILE_DEFAULTS };
  }
}

/**
 * @param {object} p - the profile.
 * @returns {void}
 */
function ncsSaveProfile(p) {
  try {
    localStorage.setItem(NCS_PROFILE_STORE, JSON.stringify(p));
  } catch {
    /* private window: the profile lasts the visit */
  }
}

/**
 * The work files.
 * @returns {{man: string, trc: string, netto: string, log: string[]}}
 */
function ncsFiles() {
  try {
    const f = JSON.parse(localStorage.getItem(NCS_FILES_STORE) || 'null');
    return { man: '', trc: '', netto: '', log: [], ...(f || {}) };
  } catch {
    return { man: '', trc: '', netto: '', log: [] };
  }
}

/**
 * @param {object} f - the work files.
 * @returns {void}
 */
function ncsSaveFiles(f) {
  try {
    f.log = (f.log || []).slice(-NCS_LOG_KEEP);
    localStorage.setItem(NCS_FILES_STORE, JSON.stringify(f));
  } catch {
    /* too big or private: they last the visit */
  }
}

/**
 * A parameter's name for a function's bytes, as NCS writes it: the DATEN
 * name, or wert_<hex> when no parameter holds those bytes.
 * @param {{values?: Array<[string, string]>}} f - the function.
 * @param {string|null} hex - its bytes (fieldHex form).
 * @returns {string|null}
 */
function ncsParamName(f, hex) {
  if (hex == null) return null;
  const h = String(hex).toLowerCase();
  for (const [name, vh] of f.values || [])
    if (String(vh).toLowerCase() === h) return name;
  return `wert_${h}`;
}

/**
 * A parameter name back to the function's bytes.
 * @param {{values?: Array<[string, string]>}} f - the function.
 * @param {string} name - a PSW name, or wert_<hex>.
 * @returns {string|null} the bytes, or null when the function has no such
 *   parameter.
 */
function ncsParamHex(f, name) {
  const n = String(name).trim().toLowerCase();
  for (const [pn, vh] of f.values || [])
    if (String(pn).toLowerCase() === n) return String(vh).toLowerCase();
  const m = /^wert_([0-9a-f]+)$/i.exec(n);
  return m ? m[1].toLowerCase() : null;
}

/**
 * FSW_PSW.TRC for a module: every function with the parameter it holds, in
 * NCS's layout (the function flush left, its parameter on the next line after
 * a tab). Functions the read did not reach are left out, as NCS does.
 * @param {object[]} fns - the module's functions.
 * @param {object|null} image - its coding image.
 * @returns {{text: string, count: number}}
 */
function ncsTraceText(fns, image) {
  const out = [];
  let count = 0;
  for (const f of fns) {
    if (!(f.values || []).length) continue;
    // Manufacturer/reserved data (service counters, build stamps) reads but is
    // not coding data, so it is not offered for a change — NCS shows it, but a
    // write refuses it; left out of the MAN so the trace is all editable.
    if (fns.codingLocked && fns.codingLocked.has(f.name)) continue;
    const name = ncsParamName(
      f,
      typeof codingImageValue === 'function' ? codingImageValue(f, image) : null
    );
    if (name == null) continue;
    out.push(f.name, `\t${name}`);
    count++;
  }
  return { text: out.join('\r\n') + (out.length ? '\r\n' : ''), count };
}

/**
 * FSW_PSW.MAN parsed: function -> parameter. A line flush left names a
 * function, an indented one its parameter; ';' and '//' start comments.
 * @param {string} text - the file.
 * @returns {Array<[string, string]>}
 */
function ncsParseMan(text) {
  const pairs = [];
  let fsw = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/(;|\/\/).*$/, '');
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      if (fsw) pairs.push([fsw, line.trim()]);
    } else {
      fsw = line.trim();
    }
  }
  return pairs;
}

/**
 * What FSW_PSW.MAN changes in a module: the edits for the write path, a row
 * per change for the confirmation, and what it names that the module has not.
 * @param {object[]} fns - the module's functions.
 * @param {object|null} image - what it holds.
 * @param {string} man - the file.
 * @returns {{edits: object[], changes: object[], unknown: string[]}}
 */
function ncsManEdits(fns, image, man) {
  const byName = new Map(fns.map((f) => [String(f.name).toUpperCase(), f]));
  const edits = [];
  const changes = [];
  const unknown = [];
  const value = (f) =>
    typeof codingImageValue === 'function' ? codingImageValue(f, image) : null;
  for (const [fsw, psw] of ncsParseMan(man)) {
    const f = byName.get(fsw.toUpperCase());
    if (!f) {
      unknown.push(`${fsw}: no such function`);
      continue;
    }
    if (fns.codingLocked && fns.codingLocked.has(f.name)) {
      unknown.push(`${fsw}: not coding data, left alone`);
      continue;
    }
    const hex = ncsParamHex(f, psw);
    if (hex == null) {
      unknown.push(`${fsw}: no parameter ${psw}`);
      continue;
    }
    const cur = value(f);
    if (cur != null && String(cur).toLowerCase() === hex) continue;
    edits.push({ rule: f, hex });
    changes.push({
      fsw: f.name,
      from: cur == null ? '?' : ncsParamName(f, cur),
      to: ncsParamName(f, hex),
    });
  }
  return { edits, changes, unknown };
}

/**
 * Save a text as a file, the browser's way.
 * @param {string} name - the file name.
 * @param {string} text - its contents.
 * @returns {void}
 */
function ncsDownload(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
