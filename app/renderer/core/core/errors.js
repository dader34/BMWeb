/**
 * @file Error explaining: terse engine/wire/flash messages mapped to a title,
 * a detail line and a fix the user can act on. Other code matches on these
 * titles and phrases, so the strings are load-bearing.
 */

/**
 * A user-facing explanation of an error.
 * @typedef {Object} ErrorExplanation
 * @property {string} title - Short headline.
 * @property {string} detail - What happened.
 * @property {string} fix - What to do about it.
 */

/**
 * Map a raw error message to a title, detail and fix.
 * @param {any} raw - The error text (an Error's message, a string, or anything).
 * @returns {ErrorExplanation}
 */
function explainError(raw) {
  const m = (raw || '').toString();
  const lower = m.toLowerCase();

  // VM / app-side errors: the interpreter broke BEFORE the wire. Checked first so a VM checksum message can't fall into a wire branch and send the user chasing a non-existent hardware fault.
  if (
    /vm ?error|unimplemented opcode|refusing to (run|transmit)|step limit at op|unknown register|operand mode|unresolved (jump|etag)|no telegram sink|raised error via eerr/i.test(
      m
    )
  )
    return {
      title: 'App error — not the car',
      detail: m || 'The job interpreter failed.',
      fix: `This is a bug in ${APP_NAME}, not the cable or the car — nothing needs checking on the vehicle. Please report this exact message.`,
    };

  if (
    lower.includes('no interface') ||
    lower.includes('no serial') ||
    lower.includes('no cable')
  )
    return {
      title: 'No adapter connected',
      detail: `${APP_NAME} could not find the K+DCAN cable.`,
      fix: 'Plug the cable into the Mac (directly, not through a hub) and into the car OBD-II port. The status light turns green when detected.',
    };

  if (lower.includes('security access') || lower.includes('denied'))
    return {
      title: 'Security access denied',
      detail:
        'The DME rejected the seed/key authentication needed to read protected memory.',
      fix: 'Make sure the engine is OFF with ignition in position 2, the battery is healthy (or a charger is connected), and the cable is solid. Retry, the seed is random each attempt.',
    };

  if (lower.includes('read failed') || lower.includes('no data at'))
    return {
      title: 'Memory read failed',
      detail: `The DME stopped responding partway through the read (${m}).`,
      fix: 'Usually a connection drop or low battery. Check the cable seating, keep ignition on / engine off, and ensure steady power, then read again.',
    };

  if (lower.includes('conditions_not_correct') || lower.includes('sequence'))
    return {
      title: 'ECU rejected the request',
      detail:
        'The DME is not in a state that allows this, often the engine is running or ignition is not fully on.',
      fix: 'Set ignition to position 2 with the engine OFF and try again.',
    };

  // IFH-0009: the ECU said nothing at all (INPA's most common error)
  if (lower.includes('ifh-0009'))
    return {
      title: 'No response from the ECU (IFH-0009)',
      detail: 'The request went out and nothing came back.',
      fix: 'Ignition on (engine off), cable seated at both ends. If other modules answer, this one may not be fitted to the car.',
    };

  // IFH-0003: something is wrong on the line itself
  if (lower.includes('ifh-0003') || lower.includes('echo'))
    return {
      title: 'The cable is not hearing itself (IFH-0003)',
      detail:
        'The K line echoes everything sent; that echo did not come back correctly.',
      fix: 'Reseat the cable at both ends. If it persists, another device may be driving the bus, or the FTDI latency timer needs raising to 2 ms -- on macOS a 1 ms latency corrupts K-line reads (short-tail responses).',
    };

  // IFH-0019: bytes arrived, but not a whole valid telegram
  if (
    lower.includes('ifh-0019') ||
    lower.includes('checksum') ||
    lower.includes('incomplete')
  )
    return {
      title: 'Damaged answer from the ECU (IFH-0019)',
      detail: 'The telegram arrived truncated or with a bad checksum.',
      fix: 'Usually electrical: check power and the cable, and keep the engine off. Retrying often succeeds.',
    };

  if (
    lower.includes('ifh-0018') ||
    lower.includes('ifh_0018') ||
    lower.includes('interfaceconnect') ||
    lower.includes('connect')
  )
    return {
      title: 'Could not reach the ECU',
      detail: 'The cable is present but the DME did not answer.',
      fix: 'Turn the ignition on, confirm the cable is fully seated at both ends, and check the FTDI latency timer is 2 ms or more -- on macOS a 1 ms latency corrupts K-line reads.',
    };

  if (lower.includes('error_f_code'))
    return {
      title: 'This function needs a fault code',
      detail: 'The detailed fault job requires a specific DTC as input.',
      fix: 'Read the fault codes first, then open the detail for a specific one.',
    };

  if (lower.includes('timeout'))
    return {
      title: 'The ECU timed out',
      detail: 'No response within the expected time.',
      fix: 'Check the cable and ignition, then retry. A weak battery or loose connector is the usual cause.',
    };

  if (lower.includes('engine failed to start'))
    return {
      title: 'Engine failed to start',
      detail: 'The diagnostic engine (the bundled sidecar) did not come up.',
      fix: `Press Retry. If it keeps failing, quit and reopen ${APP_NAME}.`,
    };

  // "no job X": the SGBD the car identified as does not implement this job. The
  // .IPO is shared across a family and offers every screen, but a variant need
  // not carry every job (E46's kombi46r dropped DPRAM_LESEN/ROM_LESEN that the
  // older kombi46 had). This is not a fault or a bug -- INPA hits the same wall
  // -- so name the job honestly rather than "something went wrong".
  const nojob = m.match(/no job (?:code shipped for )?([A-Za-z0-9_]+)/i);
  if (nojob)
    return {
      title: 'Not available on this control unit',
      detail:
        `This variant does not implement ${nojob[1]}. The screen is part ` +
        `of the shared script, but the module the car identified as carries a ` +
        `different set of jobs.`,
      fix:
        'Nothing to fix -- the function simply is not offered by this ECU. ' +
        'INPA behaves the same against this variant.',
    };

  // fallback: raw message
  return {
    title: 'Something went wrong',
    detail: m || 'Unknown error.',
    fix: 'Check the cable and ignition (engine off, key on), then try again.',
  };
}

/**
 * An explained error as an empty-state block.
 * @param {any} raw - The error text.
 * @param {string} [accent='amber'] - Colour token for the headline ('amber', 'red').
 * @returns {string} HTML.
 */
function errorBlock(raw, accent = 'amber') {
  const e = explainError(raw);
  return `<div class="empty">
    <div class="empty-big" style="color:var(--${accent})">${e.title}</div>
    <div>${esc(e.detail)}</div>
    ${e.fix ? `<div style="font-size:12px;color:var(--ink-faint);max-width:48ch">${e.fix}</div>` : ''}
  </div>`;
}
