/**
 * @file NCS Expert's ECU actions: pick the module, read it (FSW_PSW.TRC), run
 * a job (SG_CODIEREN codes it from FSW_PSW.MAN), and the file/profile dialogs.
 * Added onto ncs-actions.js's base so neither file grows too large.
 */

/* exported ncsBindActions2 */
/* global ncsFiles, ncsSaveFiles, ncsTraceText, ncsManEdits,
   ncsDownload, ncsProfile, ncsSaveProfile, NCS_PROFILES, NCS_JOBS_KNOWN,
   wkfpDialog, wkfpMessage,
   treeWriteModule, webReadCoding, webWriteCoding,
   codingNettoHex, saveCodingBackup, webCodingScript, ncsSlots, ncsReadSlot,
   loadTables, loadCvt, CodingSelect, CodingCvt */

/**
 * Add the ECU/read/code actions to the base from ncsBindActions.
 * @param {object} ctx - the render context.
 * @param {object} base - the VIN/ZCS/FA actions and dialogs.
 * @returns {object} the full action set.
 */
function ncsBindActions2(ctx, base) {
  const { state, profile, win, paint, setStatus, say, setMode, log } = ctx;
  const { ncsError, choose, textDialog, pickChassis } = base;

  /**
   * Settle which coding script (CABD) is this car's when its equipment did
   * not: NCS takes it from the car's key or order; without one, the expert
   * picks, seeing the rule that selects each. The pick is kept per module.
   * @returns {Promise<boolean>} false when cancelled.
   */
  async function settleScript() {
    const src = state.read && state.read.source;
    if (!src || src.route !== 'script' || src.decided) return true;
    const choices = src.choices || [];
    if (choices.length < 2) return true;
    state.cabdPick = state.cabdPick || {};
    const sg = String(state.mod.sgbd).toLowerCase();
    // the ECU entry the expert picked names its script (ALSZ: A_ALSZ)
    let pick = choices.find(
      (c) => c.script === (state.mod.cabd || state.cabdPick[sg])
    );
    if (!pick) {
      pick = await choose(
        'Choose CABD',
        choices.map((c) => ({
          label: `${c.script}.IPO   ${c.rule}`,
          value: c,
        })),
        `The coding key does not say which coding script ${String(
          state.mod.sgbd
        ).toUpperCase()} is coded with. PU01 marks a car built after the ` +
          'production change (coded by its vehicle order); enter or read ' +
          'the Vin/ZCS to have it chosen for you.'
      );
      if (!pick) return false;
      state.cabdPick[sg] = pick.script;
    }
    state.read.source = {
      ...src,
      script: pick.script,
      dispatchKey: pick.dispatchKey,
      decided: true,
    };
    log(`CABD ${pick.script} chosen for ${state.mod.sgbd}`);
    return true;
  }

  // ---- pick the ECU ---------------------------------------------------------
  async function chooseEcu() {
    if (!state.chassis) {
      const ch = await pickChassis();
      if (!ch) return;
      state.chassis = ch;
    }
    // NCS's own ECU list: the chassis's SGFAM slots (GM5, LSZ, ALSZ, KMB,
    // AKMB, IHK, PDC, ...), each with the coding files SGET routes it to
    const list = await ncsSlots(state.chassis);
    if (!list.length) {
      await ncsError('No codeable control units for this chassis.');
      return;
    }
    const pick = await choose(
      'Choose ECU',
      list.map((m) => ({
        label: `${m.umrsg.padEnd(6)} ${m.files.join(', ') || '-'}  (${m.asw})`,
        value: m,
      })),
      'Control unit:'
    );
    if (!pick) return;
    state.mod = pick;
    state.read = null;
    state.job = 'SG_CODIEREN';
    setMode('ecu');
    // NCS reads the module as soon as it is picked, so "get coded" can name
    // its files; a failure is shown but leaves the module picked.
    await readEcu(false);
  }

  /**
   * The jobs this module's coding script answers, as NCS lists them: the job
   * names its entry proc (cabimain) routes on. Falls back to the usual set
   * before a read has named the script.
   * @returns {Promise<string[]>}
   */
  async function scriptJobs() {
    const src = state.read && state.read.source;
    if (!src || !src.dispatchKey || typeof webCodingScript !== 'function')
      return NCS_JOBS_KNOWN;
    try {
      const script = await webCodingScript(src.dispatchKey);
      const toks = (script && script.procs && script.procs.cabimain) || [];
      const named = new Set(
        toks
          .filter((t) => t.op === 'const' && t.t === 's')
          .map((t) => String(t.v))
      );
      const jobs = NCS_JOBS_KNOWN.filter((j) => named.has(j));
      return jobs.length ? jobs : NCS_JOBS_KNOWN;
    } catch {
      return NCS_JOBS_KNOWN;
    }
  }

  async function changeJob() {
    const jobs = await scriptJobs();
    const job = await choose(
      'Change job',
      jobs.map((j) => ({ label: j, value: j })),
      'Job:'
    );
    if (job) {
      state.job = job;
      paint();
    }
  }

  function basicFunctions() {
    return ncsError(
      'Basic functions (ZCS write, FA write, VIN) are not offered here.\n' +
        'This tool codes a control unit; it does not rewrite the car key.'
    );
  }

  // ---- read the ECU (FSW_PSW.TRC) ------------------------------------------
  /**
   * Read the picked module's coding. Writes FSW_PSW.TRC and, with `show`,
   * opens it.
   * @param {boolean} show - open the trace after reading.
   * @returns {Promise<void>}
   */
  async function readEcu(show) {
    if (!state.mod) {
      await ncsError('Pick a control unit first (Change ECU).');
      return;
    }
    state.busy = true;
    setStatus(`Reading ${state.mod.sgbd}...`);
    say('Reading ECU...');
    try {
      // NCS's procedure (ncs-slots.js): the coding index through the slot's
      // coding SGBD, the selection table for its file, SGBD and script
      const got = await ncsReadSlot(state.chassis, state.mod);
      const { fns, image, source, ci } = got;
      if (!image && !fns.length) {
        say(`No values: ${got.why}`);
        log(`READ ${state.mod.umrsg}: ${got.why}`);
        await ncsError(`${state.mod.umrsg}: ${got.why}`);
        return;
      }
      state.read = { mod: state.mod, fns, image, source, ci, cbd: got.cbd };

      const { text, count } = ncsTraceText(fns, image);
      const f = ncsFiles();
      f.trc = text;
      // NETTODAT.TRC: the raw coding bytes the module answered with, as NCS
      // dumps them (the netto data, hex, 16 a line).
      if (image && image.bytes && image.bytes.length) {
        const rows = [];
        for (let a = 0; a < image.bytes.length; a += 16) {
          const line = [];
          for (let i = 0; i < 16 && a + i < image.bytes.length; i++)
            line.push(image.bytes[a + i].toString(16).padStart(2, '0'));
          rows.push(a.toString(16).padStart(4, '0') + '  ' + line.join(' '));
        }
        f.netto = rows.join('\r\n') + '\r\n';
      }
      ncsSaveFiles(f);
      // Say WHY a read produced no values: the coding index, the route the
      // module is read by, and the read's own error -- not a guess.
      const variants = (fns && fns.codingVariants) || [];
      const route = source
        ? `${source.route || 'none'}${source.sgbd ? ` via ${String(source.sgbd).toUpperCase()}` : ''}${source.script ? ` / ${source.script}` : ''}`
        : 'no source';
      const why = image
        ? ''
        : got.why
          ? got.why
          : ci == null
            ? 'no coding index was read'
            : !fns.codingIsResolved
              ? `coding index ${ci} selects no coding file`
              : (source && source.why) || `the ${route} read returned no data`;
      log(
        `READ ${state.mod.umrsg} index ${got.cbd || '?'} ` +
          `file ${variants.join('+') || '?'} route ${route}: ` +
          `${count} functions${why ? ` -- ${why}` : ''}`
      );
      say(
        `Read ${state.mod.umrsg}: ${count} function${count === 1 ? '' : 's'}.`,
        `Coding file ${got.file || '?'}.${got.cbd || 'C??'}, read by ${route}.`,
        ...(why ? [`No values: ${why}`] : [])
      );
      if (show) await showTrc();
    } catch (e) {
      say('Read failed.');
      await ncsError(`Read failed: ${e.message || e}`);
    } finally {
      state.busy = false;
      setStatus('Ready');
      paint();
    }
  }

  // ---- execute the job ------------------------------------------------------
  async function executeJob() {
    if (state.job === 'SG_CODIEREN') return codeEcu();
    if (state.job === 'ZCS_SCHREIBEN' || state.job === 'ZCS_LOESCHEN')
      return zcsWrite(state.job);
    if (
      state.job === 'CODIERDATEN_LESEN' ||
      state.job === 'CODIERINDEX_LESEN' ||
      state.job === 'ID_LESEN'
    )
      return readEcu(true);
    await ncsError(
      `Job ${state.job} is recognised but not run here.\n` +
        'This tool reads a module and codes it (SG_CODIEREN).'
    );
  }

  /**
   * ZCS_SCHREIBEN / ZCS_LOESCHEN: write the central coding key (GM/SA/VN)
   * into the module's ZCS block, or blank it. As in NCS, the module's own
   * coding script does the writing (it routes both jobs to the coding proc);
   * this lays the key into the image it is asked for, hands the script the
   * key as system data, and the write path backs up first and reads back.
   * @param {'ZCS_SCHREIBEN'|'ZCS_LOESCHEN'} job - which.
   * @returns {Promise<void>}
   */
  async function zcsWrite(job) {
    if (!state.read) {
      await ncsError('Read the control unit first (Read ECU).');
      return;
    }
    let src = state.read.source;
    const zcsGroup =
      src &&
      src.cabd &&
      (src.cabd.groups || []).find(
        (g) => String(g.name).toUpperCase() === 'ZCS'
      );
    if (!zcsGroup || zcsGroup.length !== 20) {
      await ncsError(
        `${state.mod.sgbd} holds no central coding key (ZCS).\n` +
          'On an E46 the key is kept by the EWS and the instrument cluster.'
      );
      return;
    }
    if (!(await settleScript())) return;
    src = state.read.source;
    if (!src || src.route !== 'script' || !src.decided) {
      await ncsError(
        `No way to write ${state.mod.sgbd}${src && src.why ? `: ${src.why}` : ''}.`
      );
      return;
    }
    const E = window.CodingEncode;
    const hexOnly = (s) =>
      String(s || '')
        .replace(/[^0-9A-Fa-f]/g, '')
        .toUpperCase();
    let gm;
    let sa;
    let vn;
    if (job === 'ZCS_LOESCHEN') {
      gm = 'FFFFFFFF';
      sa = 'FFFFFFFFFFFFFFFF';
      vn = 'FFFFFFFFFF';
    } else {
      if (!state.zcs) {
        await ncsError('Enter the key first (VIN/ZCS/FA > Enter FG/ZCS/FA).');
        return;
      }
      // the key as entered may carry its check characters; the body is what
      // is written, and the checks are recomputed from it
      gm = hexOnly(state.zcs.gm).slice(0, 8);
      sa = hexOnly(state.zcs.sa).slice(0, 16);
      vn = hexOnly(state.zcs.vn).slice(0, 10);
      if (gm.length !== 8 || sa.length !== 16 || vn.length !== 10) {
        await ncsError(
          'The key is incomplete: GM needs 8 hex digits, SA 16 and VN 10 ' +
            '(each optionally followed by its check character).'
        );
        return;
      }
      // a check character typed with the key must be the right one
      const typed = [
        [state.zcs.gm, 'C1', gm, 'GM'],
        [state.zcs.sa, 'C2', sa, 'SA'],
        [state.zcs.vn, 'C3', vn, 'VN'],
      ];
      for (const [raw, kind, body, label] of typed) {
        const s = String(raw || '')
          .trim()
          .toUpperCase();
        if (s.length > body.length) {
          const want = E.mod36(kind, body);
          if (s.charAt(body.length) !== want) {
            await ncsError(
              `COAPI-1030: ${label} check character is wrong.\n` +
                `${label} ${body}: expected ${want}, entered ${s.charAt(body.length)}.`
            );
            return;
          }
        }
      }
    }
    const key = (body, kind) => body + E.mod36(kind, body);

    // what the module holds now, for the confirmation
    const cur = state.read.image && state.read.image.bytes;
    const showKey = (bytes) => {
      if (!bytes) return '?';
      const at = zcsGroup.start;
      const h = (a, n) =>
        Array.from(bytes.slice(a, a + n), (b) =>
          b.toString(16).padStart(2, '0')
        )
          .join('')
          .toUpperCase();
      const ch = (a) => String.fromCharCode(bytes[a] || 0x3f);
      return (
        `GM ${h(at, 4)}${ch(at + 4)}  SA ${h(at + 5, 8)}${ch(at + 13)}  ` +
        `VN ${h(at + 14, 5)}${ch(at + 19)}`
      );
    };
    const ok = await wkfpDialog(win, {
      title: job,
      cls: 'wkfp-msg',
      body:
        `<div class="wkfp-msg-row"><span class="wkfp-icon wkfp-icon-warn">!</span>` +
        `<div class="wkfp-msg-text" style="white-space:pre-wrap">${esc(
          `${job} writes the central coding key of ${state.mod.sgbd}.\n\n` +
            `now: ${showKey(cur)}\n` +
            `new: GM ${key(gm, 'C1')}  SA ${key(sa, 'C2')}  VN ${key(vn, 'C3')}\n\n` +
            'The module decides its equipment from this key. The current coding ' +
            'is backed up first and read back to verify.'
        )}</div></div>`,
      buttons: ['Write', 'Cancel'],
    });
    if (ok !== 'Write') return;

    state.busy = true;
    setStatus(`${job}...`);
    say(`JOBNAME = ${job}`, 'Coding active');
    try {
      const fresh = await webReadCoding(src.sgbd, {
        dispatchKey: src.dispatchKey,
        cabd: src.cabd,
      });
      const want = E.buildZcsRegion(
        gm,
        sa,
        vn,
        zcsGroup.start,
        Uint8Array.from(fresh.netto)
      );
      const baseHex = codingNettoHex(fresh.netto);
      if (typeof saveCodingBackup === 'function')
        saveCodingBackup(state.mod.sgbd, baseHex, {
          chassis: state.chassis || null,
          ci: state.read.fns ? state.read.fns.codingIndex : null,
          note: `pre-write (${job}, ${src.sgbd} via ${src.script})`,
        });
      await webWriteCoding(src.sgbd, codingNettoHex(want), {
        confirmed: true,
        dispatchKey: src.dispatchKey,
        base: baseHex,
        cabd: src.cabd,
        jobname: job,
        vin: state.fg || undefined,
        fa: state.fa || undefined,
        systemData: {
          GM_SCHLUESSEL: key(gm, 'C1'),
          SA_SCHLUESSEL: key(sa, 'C2'),
          VN_SCHLUESSEL: key(vn, 'C3'),
        },
        onStage: (s) => setStatus(s),
      });
      log(
        `${job} ${state.mod.sgbd}: GM ${key(gm, 'C1')} SA ${key(sa, 'C2')} VN ${key(vn, 'C3')}`
      );
      say(`JOBNAME = ${job}`, 'Coding ended successfully.');
      await readEcu(false);
      await wkfpMessage(win, 'info', 'Coding ended successfully.', ['OK']);
    } catch (e) {
      log(`${job} FAILED ${state.mod.sgbd}: ${e.message || e}`);
      say(`JOBNAME = ${job}`, `Coding faulty: ${e.message || e}`);
      await ncsError(
        `Error in CABD!\n\nCOAPI-2060: coding faulty\n${state.mod.sgbd}: ${e.message || e}`
      );
    } finally {
      state.busy = false;
      setStatus('Ready');
      paint();
    }
  }

  /**
   * SG_CODIEREN: code the module with FSW_PSW.MAN laid over what it holds,
   * through the write path (backup, then prove-by-re-read).
   * @returns {Promise<void>}
   */
  async function codeEcu() {
    if (!state.read) {
      await ncsError('Read the control unit first (Read ECU).');
      return;
    }
    const man = ncsFiles().man;
    if (!man.trim()) {
      await ncsError(
        'FSW_PSW.MAN is empty.\n' +
          'Copy FSW_PSW.TRC to FSW_PSW.MAN (File > Edit FSW_PSW.MAN), ' +
          'change a parameter, then code.'
      );
      return;
    }
    const { edits, changes, unknown } = ncsManEdits(
      state.read.fns,
      state.read.image,
      man
    );
    if (unknown.length) log(`MAN warnings: ${unknown.join('; ')}`);
    if (!edits.length) {
      await ncsError(
        'Nothing in FSW_PSW.MAN differs from the control unit.\n' +
          (unknown.length ? unknown.join('\n') : 'Nothing to code.')
      );
      return;
    }

    // The confirmation: NCS does not warn, but a real EEPROM write should.
    const rows = changes
      .map((c) => `${c.fsw}:  ${c.from}  →  ${c.to}`)
      .join('\n');
    const ok = await wkfpMessageConfirm(
      `SG_CODIEREN will write ${edits.length} change${edits.length === 1 ? '' : 's'} to ` +
        `${state.mod.sgbd}:\n\n${rows}\n\n` +
        'The current coding is backed up first, and read back to verify.'
    );
    if (ok !== 'Code') return;
    if (!(await settleScript())) return;

    state.busy = true;
    setStatus('Coding...');
    say('JOBNAME = SG_CODIEREN', 'Coding...');
    try {
      const built = {
        ...state.mod,
        sgbd: state.mod.sgbd,
        fns: state.read.fns,
        chassisId: state.chassis,
        source: state.read.source,
        // the FG of the car's key, which the coding script writes back
        vin: state.fg || undefined,
        // the car's vehicle order, for a script that reads it
        fa: state.fa || undefined,
      };
      // treeWriteModule applies `edits` to a fresh read and verifies; it only
      // reads the state map to clear staged flags, which NCS does not keep.
      const res = await treeWriteModule(built, edits, new Map(), (stage) =>
        setStatus(stage)
      );
      if (res.ok) {
        log(
          `CODED ${state.mod.sgbd}: ${changes.map((c) => `${c.fsw}=${c.to}`).join(', ')}`
        );
        say(
          'JOBNAME = SG_CODIEREN',
          'Coding active',
          'Coding ended successfully.'
        );
        await readEcu(false);
        await wkfpMessage(win, 'info', 'Coding ended successfully.', ['OK']);
      } else {
        log(`CODE FAILED ${state.mod.sgbd}: ${res.err}`);
        say('JOBNAME = SG_CODIEREN', `Coding faulty: ${res.err}`);
        await ncsError(
          `Error in CABD!\n\nCOAPI-2060: coding faulty\n${state.mod.sgbd}: ${res.err}`
        );
      }
    } catch (e) {
      await ncsError(`Coding failed: ${e.message || e}`);
    } finally {
      state.busy = false;
      setStatus('Ready');
      paint();
    }
  }

  async function processCar() {
    await ncsError(
      'Process car (code every control unit from the vehicle order) is not ' +
        'offered here.\nPick one control unit with Process ECU.'
    );
  }

  /** A two-button confirm with the error icon, Code / Cancel. */
  function wkfpMessageConfirm(text) {
    return wkfpDialog(win, {
      title: 'Info',
      cls: 'wkfp-msg',
      body:
        `<div class="wkfp-msg-row"><span class="wkfp-icon wkfp-icon-question">?</span>` +
        `<div class="wkfp-msg-text" style="white-space:pre-wrap">${esc(text)}</div></div>`,
      buttons: ['Code', 'Cancel'],
    });
  }

  // ---- files ----------------------------------------------------------------
  async function showTrc() {
    const { button, text } = await textDialog(
      'FSW_PSW.TRC',
      ncsFiles().trc,
      ['Copy to FSW_PSW.MAN', 'Trace editor', 'Download', 'Close'],
      true
    );
    if (button === 'Trace editor' && typeof ctx.traceEditor === 'function') {
      await ctx.traceEditor();
    } else if (button === 'Copy to FSW_PSW.MAN') {
      const f = ncsFiles();
      f.man = f.trc;
      ncsSaveFiles(f);
      say(
        'FSW_PSW.TRC copied to FSW_PSW.MAN. Edit it (File > Edit FSW_PSW.MAN), then code.'
      );
    } else if (button === 'Download') {
      ncsDownload('FSW_PSW.TRC', text);
    }
  }

  async function editMan() {
    const { button, text } = await textDialog('FSW_PSW.MAN', ncsFiles().man, [
      'Save',
      'Download',
      'Cancel',
    ]);
    if (button === 'Save') {
      const f = ncsFiles();
      f.man = text;
      ncsSaveFiles(f);
      say(
        'FSW_PSW.MAN saved. Code the control unit (Execute job, SG_CODIEREN).'
      );
    } else if (button === 'Download') {
      ncsDownload('FSW_PSW.MAN', text);
    }
  }

  function importMan() {
    const picker = ctx.$('ncs-file');
    picker.accept = '.man,.txt';
    picker.onchange = async () => {
      const file = (picker.files || [])[0];
      picker.value = '';
      if (!file) return;
      const text = await file.text();
      const f = ncsFiles();
      f.man = text;
      ncsSaveFiles(f);
      say(`FSW_PSW.MAN imported from ${esc(file.name)}.`);
    };
    picker.click();
  }

  async function showLog() {
    await textDialog('ERROR.LOG', ncsFiles().log.join('\n'), ['Close'], true);
  }
  async function showNetto() {
    await textDialog(
      'NETTODAT.TRC',
      ncsFiles().netto || '(no coding data read yet)',
      ['Close'],
      true
    );
  }
  /** CABD-Parameter: the coding description the read resolved to (NCS shows
   * the CABD name, its coding index and the files). */
  async function showCabdPar() {
    const r = state.read;
    if (!r) {
      await ncsError('Read a control unit first (Read ECU).');
      return;
    }
    const src = r.source || {};
    const variants = (r.fns && r.fns.codingVariants) || [];
    const lines = [
      `SGBD-name       : ${String(src.sgbd || state.mod.sgbd).toUpperCase()}`,
      `CABD-name       : ${(src.script || '').toUpperCase() || '(none)'}`,
      `Coding file     : ${String(state.mod.sgbd).toUpperCase()}.${variants.length === 1 ? variants[0] : 'C??'}`,
      `Coding index    : ${r.ci == null ? '(none)' : r.ci}`,
      `Variants        : ${variants.join(', ') || '(unresolved)'}`,
      `Functions read  : ${(r.fns || []).length}`,
    ];
    await textDialog('CABD-Parameter', lines.join('\r\n'), ['Close'], true);
  }
  /** Systemdata: the direct-assignment values the coding script holds for the
   * car (the coding key GM/SA/VN, the VIN) — NCS's "FSW with direct parameter
   * assignment". */
  async function showSystemdata() {
    const rows = [];
    if (state.fg) rows.push(`FAHRGESTELL_NR  : ${state.fg}`);
    if (state.zcs) {
      rows.push(`GM_SCHLUESSEL   : ${state.zcs.gm || ''}`);
      rows.push(`SA_SCHLUESSEL   : ${state.zcs.sa || ''}`);
      rows.push(`VN_SCHLUESSEL   : ${state.zcs.vn || ''}`);
    }
    if (state.fa) rows.push(`FA              : ${state.fa}`);
    await textDialog(
      'Systemdata',
      rows.length ? rows.join('\r\n') : '(no key read — VIN/ZCS/FA first)',
      ['Close'],
      true
    );
  }
  function about() {
    return wkfpMessage(
      win,
      'info',
      'BMWeb Coding\n\nExpert-mode coding over BMWeb’s coding engine, ' +
        'in NCS Expert’s way. It reads a control unit and codes it from ' +
        'FSW_PSW.MAN, backing up and verifying every write.',
      ['OK'],
      'About BMWeb Coding'
    );
  }

  // ---- profile --------------------------------------------------------------
  async function editProfile() {
    const p = ncsProfile();
    const body = document.createElement('div');
    body.className = 'ncs-profile';
    body.innerHTML =
      `<label>Profile<select class="wkfp-input ncs-pid">${Object.entries(
        NCS_PROFILES
      )
        .map(
          ([id, name]) =>
            `<option value="${id}"${id === p.id ? ' selected' : ''}>${esc(name)}</option>`
        )
        .join('')}</select></label>` +
      '<fieldset class="ncs-fieldset"><legend>Read FSW/PSW</legend>' +
      radio('fsw', 'inactive', 'FSW/PSW-Treatment inactive', p.fswPsw) +
      radio('fsw', 'cvt', 'from CVT', p.fswPsw) +
      radio('fsw', 'file', 'From file', p.fswPsw) +
      '</fieldset>' +
      '<fieldset class="ncs-fieldset"><legend>Function buttons</legend>' +
      check('keyEnter', 'Enter Vin/ZCS', p.keyEnter) +
      check('keyEcu', 'Read Vin/ZCS from car', p.keyEcu) +
      check('keyFile', 'Read VIN/ZCS from file', p.keyFile) +
      check('keyChassis', 'Choose chassis', p.keyChassis) +
      '</fieldset>';
    const b = await wkfpDialog(win, {
      title: 'Profile editor',
      body,
      buttons: ['OK', 'Cancel'],
      cls: 'ncs-profiledlg',
    });
    if (b !== 'OK') return;
    const g = (c) => body.querySelector(c);
    p.id = g('.ncs-pid').value;
    p.fswPsw =
      (body.querySelector('input[name="fsw"]:checked') || {}).value || p.fswPsw;
    for (const k of ['keyEnter', 'keyEcu', 'keyFile', 'keyChassis'])
      p[k] = g(`.ncs-${k}`).checked;
    ncsSaveProfile(p);
    Object.assign(profile, p);
    paint();

    function radio(name, value, label, cur) {
      return `<label class="ncs-radio"><input type="radio" name="${name}" value="${value}"${
        cur === value ? ' checked' : ''
      }> ${esc(label)}</label>`;
    }
    function check(key, label, on) {
      return `<label class="ncs-check"><input type="checkbox" class="ncs-${key}"${
        on ? ' checked' : ''
      }> ${esc(label)}</label>`;
    }
  }

  // ---- the vehicle order ----------------------------------------------------
  /**
   * The car's equipment as the CVT's rules speak it, the way the factory
   * tool gets it (CodingSelect.carEquipment): from the vehicle order through
   * the AT table, time criterion included, or else from the coding key
   * through the ZST table.
   * @returns {{ids: number[]|null, source: string|null, errors: string[]}}
   */
  function orderEquipment() {
    return CodingSelect.carEquipment(state.chassis, {
      fa: state.fa || null,
      zcs: state.zcs || null,
    });
  }

  /**
   * Compare the read module with the coding its vehicle order gives (BMW's
   * CVT): what SG_CODIEREN from the order would change. Nothing is written;
   * the changes can be copied to FSW_PSW.MAN and coded the usual way. Where
   * the factory tool would refuse to code from this order -- the module's
   * coding file does not fit it (SGVT), a CVT group has no holding rule or
   * several, a function is left without a value -- this says so and offers
   * no copy.
   */
  async function compareOrder() {
    if (!state.read) {
      await ncsError('Read the control unit first (Read ECU).');
      return;
    }
    if (typeof loadTables === 'function') await loadTables();
    if (typeof loadCvt === 'function') await loadCvt();
    const eq = orderEquipment();
    if (!eq.ids) {
      await ncsError(
        'The car is not known: read or enter its Vin/ZCS/FA first (VIN/ZCS/FA).'
      );
      return;
    }
    const refusals = eq.errors.slice();
    let equipment = eq.ids;
    const sgvt = CodingSelect.sgvtRow(
      state.chassis,
      state.mod.umrsg,
      state.read.cbd,
      equipment
    );
    if (sgvt.found && !sgvt.holds)
      refusals.push(
        `the coding file ${state.mod.umrsg} ${state.read.cbd} does not fit this ${eq.source} (version table SGVT)`
      );
    equipment = [...new Set([...equipment, ...sgvt.add])].sort((x, y) => x - y);
    const t = CodingCvt.targets(state.chassis, equipment);
    if (!t) {
      await ncsError(
        `The ${state.chassis} has no coding table (CVT): its modules are not coded from the order here.`
      );
      return;
    }
    refusals.push(...t.errors);
    const { fns, image } = state.read;
    const order = CodingCvt.man(fns, t);
    refusals.push(...order.refused);
    const { changes, unknown } = ncsManEdits(fns, image, order.text);
    const out = [
      `${state.mod.umrsg || state.mod.sgbd} against its vehicle order (${eq.source})`,
      '',
    ];
    if (refusals.length)
      out.push(
        'NCS Expert would refuse to code this module from this order:',
        ...refusals.map((r) => `  ${r}`),
        ''
      );
    out.push(
      changes.length
        ? `${changes.length} function${changes.length === 1 ? '' : 's'} differ:`
        : 'The module is coded as its order says.',
      ...changes.map((c) => `  ${c.fsw}:  ${c.from}  ->  ${c.to}`)
    );
    if (order.personal.length)
      out.push(
        '',
        `Personal (Key Memory), left as they are: ${order.personal.join(', ')}`
      );
    if (order.single.length)
      out.push(
        '',
        `Not decided by the order, coded with their only value: ${order.single.join(', ')}`
      );
    if (unknown.length) out.push('', ...unknown);
    log(
      `ORDER ${state.mod.sgbd} (${eq.source}): ${changes.length} differ, ` +
        `${order.personal.length} personal, ${order.unknown.length} undecided, ` +
        `${refusals.length} refusal${refusals.length === 1 ? '' : 's'}`
    );
    const { button } = await textDialog(
      'Compare with vehicle order',
      out.join('\r\n'),
      changes.length && !refusals.length
        ? ['Copy to FSW_PSW.MAN', 'Close']
        : ['Close'],
      true
    );
    if (button !== 'Copy to FSW_PSW.MAN') return;
    const f = ncsFiles();
    f.man = changes.map((c) => `${c.fsw}\r\n\t${c.to}`).join('\r\n') + '\r\n';
    ncsSaveFiles(f);
    say(
      `FSW_PSW.MAN holds the ${changes.length} change${changes.length === 1 ? '' : 's'} to the order.`,
      'Check it (File > Edit FSW_PSW.MAN), then code (Execute job, SG_CODIEREN).'
    );
  }

  return {
    ...base,
    chooseEcu,
    changeJob,
    basicFunctions,
    readEcu,
    executeJob,
    codeEcu,
    processCar,
    compareOrder,
    showTrc,
    editMan,
    importMan,
    showLog,
    showNetto,
    showCabdPar,
    showSystemdata,
    about,
    editProfile,
  };
}
