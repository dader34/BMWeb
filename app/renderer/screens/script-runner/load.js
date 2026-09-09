/**
 * @file Turning dropped files into a runnable script, and picking the module
 * it drives.
 *
 * The two front ends -- a compiled `.IPO` and a source `.IPS` / `.SRC` -- meet
 * here and produce the same exec object the shipped scripts run as. Nothing is
 * stored: the files live in memory for as long as the screen is open.
 */

/**
 * Read every dropped file, sorting it into the script and its includes.
 *
 * A `.SRC` is ambiguous -- BMW writes both scripts and libraries with that
 * extension -- so the one the user named as the script wins and the rest are
 * offered as includes.
 *
 * @param {File[]} files The dropped or picked files.
 * @returns {Promise<{script: {name: string, bytes: Uint8Array}|null,
 *   includes: Object<string, string>, ignored: string[]}>} The script, the
 *   include texts by file name, and anything unusable.
 */
async function scriptRunnerRead(files) {
  const list = Array.from(files || []);
  const includes = {};
  const ignored = [];
  let script = null;
  // a compiled file is unambiguous, so it claims the script slot first
  const compiled = list.filter((f) => ipofIsCompiled(f.name));
  const sources = list.filter((f) => ipofIsSource(f.name));
  const pick = compiled[0] || sources[0] || null;
  for (const f of list) {
    if (f === pick) {
      script = { name: f.name, bytes: await ipofReadBytes(f) };
      continue;
    }
    if (ipofIsInclude(f.name)) {
      const bytes = await ipofReadBytes(f);
      includes[f.name] = scriptRunnerText(bytes);
      continue;
    }
    if (!ipofIsCompiled(f.name)) ignored.push(f.name);
  }
  return { script, includes, ignored };
}

/**
 * Decode bytes as the latin-1 text INPA's own tooling writes.
 *
 * The sources are CP1252 and carry accented German; decoding them as UTF-8
 * would replace those bytes and change string literals the car may be shown.
 *
 * @param {Uint8Array} bytes The file bytes.
 * @returns {string} The text.
 */
function scriptRunnerText(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Build a runnable exec from what the user supplied.
 *
 * @param {{name: string, bytes: Uint8Array}} script The script file.
 * @param {Object<string, string>} includes The include texts by name.
 * @returns {{ok: boolean, exec: Object|null, kind: string, errors: Object[],
 *   missing: string[], includes: string[]}} The result; `kind` is 'compiled'
 *   or 'source', and `errors` each carry a line and a ready-to-show text.
 */
function scriptRunnerBuild(script, includes) {
  const stem = ipofStem(script.name);
  if (ipofIsCompiled(script.name)) {
    try {
      const exec = ipofDecodeExec(script.bytes, stem);
      return {
        ok: true,
        exec,
        kind: 'compiled',
        errors: [],
        missing: [],
        includes: exec.includes || [],
      };
    } catch (e) {
      return {
        ok: false,
        exec: null,
        kind: 'compiled',
        errors: [{ line: 0, text: String((e && e.message) || e) }],
        missing: [],
        includes: [],
      };
    }
  }
  const r = ipofCompileSource(scriptRunnerText(script.bytes), {
    name: stem,
    files: includes,
  });
  return {
    ok: r.ok,
    exec: r.exec,
    kind: 'source',
    errors: r.errors,
    missing: r.missing,
    includes: r.includes,
  };
}

/**
 * The SGBD a script drives, taken from the script itself.
 *
 * A script's entry proc names the modules it accepts -- the same list
 * ipoScriptVariants reads for a scriptchange -- so the module is the script's
 * own choice, not a guess from the file name. Where the car can be asked (the
 * script names a group's variants), the group is resolved live and the car's
 * answer wins; otherwise the first name the script mentions that this build
 * ships is taken, and failing that the file's own stem, so the first job
 * fails with the shim's own message about an SGBD it does not have.
 *
 * @param {Object} exec The script.
 * @param {string} stem The file's name without its extension.
 * @returns {Promise<{sgbd: string, how: string, choices: string[]}>} The SGBD,
 *   how it was chosen, and every candidate the script named.
 */
async function scriptRunnerSgbd(exec, stem) {
  let known;
  try {
    const idx = await fetch('api/ecu-index.json').then((r) => (r.ok ? r.json() : null));
    known = new Set(Object.keys(idx || {}).map((k) => k.toLowerCase()));
  } catch (e) {
    known = new Set();
  }
  const wants = typeof ipoScriptVariants === 'function'
    ? ipoScriptVariants(exec, known)
    : [];
  if (wants.length && typeof ipoVariantsByGroup === 'function'
      && typeof webResolveVariant === 'function') {
    let group = null;
    let best = 0;
    try {
      const byGroup = (await ipoVariantsByGroup()) || {};
      for (const g of Object.keys(byGroup)) {
        const hits = (byGroup[g] || [])
          .filter((v) => wants.includes(String(v).toLowerCase())).length;
        if (hits > best) {
          best = hits;
          group = g;
        }
      }
    } catch (e) {
      group = null;
    }
    if (group) {
      try {
        const answered = await webResolveVariant(group);
        if (answered) {
          return {
            sgbd: String(answered).toLowerCase(),
            how: `the car answered ${group.toUpperCase()}`,
            choices: wants,
          };
        }
      } catch (e) {
        /* no cable, or the group did not answer: fall through to the list */
      }
    }
  }
  if (wants.length) {
    return {
      sgbd: wants[0],
      how: 'the first module the script names that this build ships',
      choices: wants,
    };
  }
  const own = String(stem).toLowerCase();
  return {
    sgbd: own,
    how: known.has(own)
      ? "the script's own name"
      : "the script's own name, which this build does not ship",
    choices: [],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scriptRunnerRead, scriptRunnerBuild, scriptRunnerSgbd, scriptRunnerText,
  };
}
