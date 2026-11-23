/**
 * @file Error explaining: terse engine/wire/flash messages mapped to a title,
 * a detail line and a fix the user can act on.
 *
 * HOW A MESSAGE IS RECOGNISED. By what it IS, most exact first: the app's
 * own interpreter errors, a job the module does not have, the interface
 * code (IFH-xxxx) when the message carries one, then the few phrases the
 * app's own code throws. Never by a loose word. This used to test for
 * 'connect', 'denied', 'sequence', 'echo', 'checksum' and 'timeout'
 * anywhere in the text, in an order that put the job-not-found case last:
 * "No adapter connected" (thrown when there is no cable) was explained as
 * "the cable is present but the DME did not answer", a browser's
 * "permission denied" as a failed seed/key, and "no job
 * STATUS_BUS_TIMEOUT" as the ECU timing out. A message nothing here
 * recognises is shown as it is, with no guess at a cause.
 * tools/verify/test_errors.js holds every message the app throws to its
 * explanation.
 */

/* exported errorBlock */

/**
 * A user-facing explanation of an error.
 * @typedef {Object} ErrorExplanation
 * @property {string} title - Short headline.
 * @property {string} detail - What happened.
 * @property {string} fix - What to do about it.
 */

/**
 * The interface errors, by their code. The code is EDIABAS's own and the
 * transport raises each for one reason (core/webshim/framing.js, exchange.js,
 * web-serial-bus.js), so the code alone decides the explanation. `detail`
 * null shows the message itself: for those codes it says which protocol or
 * which browser limit is in the way.
 * @type {Object<string, {title: string, detail: ?string, fix: string}>}
 */
const IFH_EXPLAINED = {
  // the echo of what was sent did not come back, or came back wrong
  '0003': {
    title: 'The cable is not hearing itself (IFH-0003)',
    detail:
      'The K line echoes everything sent; that echo did not come back correctly.',
    fix: 'Reseat the cable at both ends. If it persists, another device may be driving the bus, or the FTDI latency timer needs raising to 2 ms -- on macOS a 1 ms latency corrupts K-line reads (short-tail responses).',
  },
  // an ADS-only module: nothing a K+DCAN cable can do about it
  '0006': {
    title: 'This module needs a different cable (IFH-0006)',
    detail: null,
    fix: 'Nothing is wrong with the car or the cable. The module is on the ADS interface, which a K+DCAN cable does not drive; the other modules are not affected.',
  },
  // the ECU said nothing at all (INPA's most common error)
  '0009': {
    title: 'No response from the ECU (IFH-0009)',
    detail: 'The request went out and nothing came back.',
    fix: 'Ignition on (engine off), cable seated at both ends. If other modules answer, this one may not be fitted to the car.',
  },
  // the module's protocol cannot be spoken from this cable or this browser
  '0018': {
    title: 'This module cannot be reached from here (IFH-0018)',
    detail: null,
    fix: 'The cable or the browser cannot speak this module’s protocol, so nothing was sent to it. The other modules are not affected.',
  },
  // bytes arrived, but not a whole valid telegram
  '0019': {
    title: 'Damaged answer from the ECU (IFH-0019)',
    detail: 'The telegram arrived truncated or with a bad checksum.',
    fix: 'Usually electrical: check power and the cable, and keep the engine off. Retrying often succeeds.',
  },
};

/**
 * The app's own interpreter failing BEFORE the wire: the phrases the BEST2
 * VM throws (core/bestvm), and IFH-0056, which is the VM reaching a telegram
 * with no CommParameter set -- a script fault, not a line fault.
 * @type {RegExp}
 */
const APP_ERROR_RE =
  /vm ?error|unimplemented opcode|refusing to (run|transmit)|step limit at op|unknown register|operand mode|unresolved (jump|etag)|no telegram sink|no test for |raised error via eerr|IFH-0056/i;

/**
 * Map a raw error message to a title, detail and fix.
 * @param {any} raw - The error text (an Error's message, a string, or anything).
 * @returns {ErrorExplanation}
 */
function explainError(raw) {
  const m = (raw || '').toString();
  const lower = m.toLowerCase();

  // VM / app-side errors: the interpreter broke BEFORE the wire. Checked first so a VM message can't fall into a wire branch and send the user chasing a non-existent hardware fault.
  if (APP_ERROR_RE.test(m))
    return {
      title: 'App error — not the car',
      detail: m || 'The job interpreter failed.',
      fix: `This is a bug in ${APP_NAME}, not the cable or the car — nothing needs checking on the vehicle. Please report this exact message.`,
    };

  // "no job code shipped for X": the build carries no job code for that
  // SGBD at all. Before "no job X" below, whose pattern would otherwise
  // read the SGBD's name as the job's.
  const nocode = m.match(
    /no (?:job code|coding script) shipped for ([A-Za-z0-9_-]+)/i
  );
  if (nocode)
    return {
      title: 'No data for this control unit',
      detail: `This build carries no job code for ${nocode[1]}, so nothing was sent to the car.`,
      fix: 'Nothing needs checking on the vehicle. In an offline copy the pack for this car may be missing; otherwise the module is one this build does not cover.',
    };

  // "no job X": the SGBD the car identified as does not implement this job. The
  // .IPO is shared across a family and offers every screen, but a variant need
  // not carry every job (E46's kombi46r dropped DPRAM_LESEN/ROM_LESEN that the
  // older kombi46 had). This is not a fault or a bug -- INPA hits the same wall
  // -- so name the job honestly rather than "something went wrong". Ahead of
  // every wire case: a job's NAME may hold any word (STATUS_BUS_TIMEOUT).
  const nojob = m.match(/\bno job ([A-Za-z0-9_]+)/i);
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

  // the interface code decides, when there is one
  const ifh = /\bIFH[-_](\d{4})\b/i.exec(m);
  const known = ifh && IFH_EXPLAINED[ifh[1]];
  if (known)
    return {
      title: known.title,
      detail: known.detail || m,
      fix: known.fix,
    };

  // the other end of a shared session, not this computer's cable or the car
  if (/^remote\b|\bremote session\b/i.test(m))
    return {
      title: 'The shared session did not answer',
      detail: m,
      fix: 'The car is on the other person’s cable. Check that their session is still open and connected, then try again.',
    };

  // no cable: 'no cable connected' (the router), 'No adapter connected'
  // (the tree scan), 'no cable is open', a native host's 'no interface' /
  // 'no serial port'
  if (/\bno (cable|adapter|interface|serial)\b/.test(lower))
    return {
      title: 'No adapter connected',
      detail: `${APP_NAME} could not find the K+DCAN cable.`,
      fix: 'Plug the cable into the computer (directly, not through a hub) and into the car OBD-II port. The status light turns green when detected.',
    };

  if (lower.includes('security access'))
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

  // the ECU's own negative answers, by their KWP names
  if (/conditions_not_correct|request_sequence_error/.test(lower))
    return {
      title: 'ECU rejected the request',
      detail:
        'The DME is not in a state that allows this, often the engine is running or ignition is not fully on.',
      fix: 'Set ignition to position 2 with the engine OFF and try again.',
    };

  if (lower.includes('error_f_code'))
    return {
      title: 'This function needs a fault code',
      detail: 'The detailed fault job requires a specific DTC as input.',
      fix: 'Read the fault codes first, then open the detail for a specific one.',
    };

  if (lower.includes('engine failed to start'))
    return {
      title: 'Engine failed to start',
      detail: 'The diagnostic engine did not come up.',
      fix: `Press Retry. If it keeps failing, reload ${APP_NAME}.`,
    };

  // a file of the app's own data that did not arrive: nothing to do with
  // the car, so the cable advice below would be wrong
  if (
    /^failed to (load|fetch)\b|^load failed\b|\bnetworkerror\b|\bnot found\b|\b(ecu pack|ecu archive)\b|^missing \S+ in chassis\b/i.test(
      m
    )
  )
    return {
      title: 'Could not load the data',
      detail: m,
      fix: `Check the connection and reload ${APP_NAME}. Nothing needs checking on the car.`,
    };

  if (/\btime(d )?out\b/.test(lower))
    return {
      title: 'The ECU timed out',
      detail: 'No response within the expected time.',
      fix: 'Check the cable and ignition, then retry. A weak battery or loose connector is the usual cause.',
    };

  // fallback: the message as it is, and no guess at a cause
  return {
    title: 'Something went wrong',
    detail: m || 'Unknown error.',
    fix: 'If this happened while talking to the car, check the cable and the ignition (key on, engine off), then try again.',
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { explainError, errorBlock };
}
