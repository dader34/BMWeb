/**
 * @file The Flashing/Tuning & Logging tutorial: a coach-mark walk (the
 * app's tour driver, screens/tutorial.js) through the flashing page, the
 * tuning editor and data logging -- and, for an MS45 owner, its custom
 * options and live tuning on top. Offered once, the first time the app
 * opens; replayed any time from its Settings page or the editor's
 * Tutorial button.
 *
 * Every step names a control of the page it lives on; a control that is
 * not there (no file loaded, no table open) is skipped by the driver, so
 * the walk reads right whether the editor is empty or mid-session.
 */

/* exported tnTutorialSteps, tnTutorialStart, tnTutorialOffer */

const TN_TOUR_SEEN_KEY = 'flashingTutorialSeen';

/**
 * Reach a page of the Flashing/Tuning & Logging app, opening the app when
 * the tour was started from elsewhere.
 * @param {'flashing'|'tuning'|'logging'|'history'} page
 * @returns {Promise<void>}
 */
async function tnTourPage(page) {
  if (!document.getElementById('fb-rail-' + page)) {
    await showFlashing(page);
    return;
  }
  fbShowPage(page);
}

/** @type {Record<string, () => Promise<void>>} */
const TN_TOUR_SCREENS = {
  flashing: () => tnTourPage('flashing'),
  tuning: () => tnTourPage('tuning'),
  logging: () => tnTourPage('logging'),
  history: () => tnTourPage('history'),
};

/**
 * The steps. The MS45 branch adds its custom options and live tuning; the
 * logging part is for everyone.
 * @param {boolean} ms45 - The reader said their car has an MS45.
 * @returns {Array<{screen: string, sel: string, title: string, body: string}>}
 */
function tnTutorialSteps(ms45) {
  const tuning = [
    {
      screen: 'tuning',
      sel: '.tn-bar',
      title: 'The tuning editor',
      body:
        'The second page of the rail: where a tune is edited. Load a firmware file and a ' +
        'definition, and every table and single value in it can be opened ' +
        'by name on the left, with the raw bytes on the right. Everything ' +
        'here works offline; the car is only needed to read and flash.',
    },
    {
      screen: 'tuning',
      sel: '.tn-load-bin',
      title: 'Start from a file',
      body:
        'Load BIN opens a firmware file: a full read of the control unit ' +
        'from the Flashing page, or a tune file on its own. The editor ' +
        'remembers what you had open, so a reload brings it straight back.',
    },
    {
      screen: 'tuning',
      sel: '.tn-read-ecu',
      title: '…or straight from the car',
      body:
        "Read tune from ECU pulls the DME's calibration over the cable and " +
        'opens it here. It takes about a minute. Before you ever flash, make ' +
        'one complete backup with Read DME on the Flashing page and keep it ' +
        'somewhere safe: it is the only way back.',
    },
    {
      screen: 'tuning',
      sel: '.tn-browse-xdf',
      title: 'Definitions',
      body:
        'A definition (.xdf) names every table and value in the file and ' +
        'says how to show it: units, scaling, axes. Browse XDFs offers the ' +
        'shared library, matched to the program your file carries; Load ' +
        '.xdf opens one of your own.',
    },
    {
      screen: 'tuning',
      sel: '.tn-defs-mode',
      title: 'Comfort and Expert',
      body:
        'Comfort lists the parameters people actually tune, under plain ' +
        'names and grouped by subject: rev limits, idle, fuel, ignition, ' +
        'VANOS, cooling. Expert is the whole definition, thousands of ' +
        "rows under the program's own symbol names. Both open the same " +
        'items.',
    },
    {
      screen: 'tuning',
      sel: '.tn-defs-search',
      title: 'Find anything',
      body:
        'Type part of a name or a description to narrow the list. "fan", ' +
        '"limit", "idle" all work; in Expert the symbol names match too.',
    },
    {
      screen: 'tuning',
      sel: '.tn-defs-list',
      title: 'Open a parameter',
      body:
        'Click a row. A table (TBL) opens as a grid; a single value (VAL) ' +
        'or a flag opens a small editor with its unit and allowed range. ' +
        'The list shows what is edited, and the hex view shades every ' +
        'byte a definition covers.',
    },
    {
      screen: 'tuning',
      sel: '.tn-modal-tools',
      title: 'Editing a table',
      body:
        'Cells are coloured by value (heat); Graph draws the table in 2D ' +
        'or 3D; vs original shades what you changed. Select cells by ' +
        'click-drag, then set a value, add or subtract, scale by percent, ' +
        'interpolate across a selection, or smooth it. Undo, redo and ' +
        'revert are always there.',
    },
    {
      screen: 'tuning',
      sel: '#tn-hexpane',
      title: 'The hex view',
      body:
        'The raw file. Shaded bytes belong to a defined parameter: click ' +
        'one to open its owner. Go to an address, search for a byte ' +
        'pattern, and see what no definition covers. Double-click edits a ' +
        'byte directly.',
    },
    {
      screen: 'tuning',
      sel: '#tn-status',
      title: 'Your changes, counted',
      body:
        'The status line keeps the tally of edited bytes and the file you ' +
        'are working on. Nothing touches the car until you flash.',
    },
    {
      screen: 'tuning',
      sel: '.tn-save',
      title: 'Save BIN',
      body:
        'Writes the edited file. Checksums are redone by the flasher, so ' +
        'the saved file is what you load on the Flashing page next.',
    },
  ];

  const flashing = [
    {
      screen: 'flashing',
      sel: '.fb-rail',
      title: 'Flashing, tuning and logging',
      body:
        'One app, three jobs, down the rail on the left: read and flash a ' +
        'control unit, edit a tune, and log the engine while you drive. ' +
        'History keeps every session with its files; Settings holds the ' +
        'switches. The walk goes through all three.',
    },
    {
      screen: 'flashing',
      sel: '#fb-identify',
      title: 'Identify your control unit',
      body:
        'Pick the module and press Identify. It reads part numbers, the ' +
        'program and tune versions and the flash counters, and tells the ' +
        'flasher exactly what it is talking to.' +
        (ms45
          ? ' On an MS45 it also reports the live-tune build and any self-resets.'
          : ''),
    },
    {
      screen: 'flashing',
      sel: '#fb-dme-read',
      title: 'Back up first',
      body:
        'Read DME copies the whole unit: the program and the tune. Do this ' +
        'once before anything else and keep the files. Every read and flash ' +
        'is listed under History, with its files.',
    },
    {
      screen: 'flashing',
      sel: '#fb-dme-load1',
      title: 'Load what to flash',
      body:
        'A tune file (.0da, or the BIN you saved in the editor) or a full ' +
        'program. The flasher checks it belongs to the identified unit ' +
        'before it lets you go on.',
    },
    {
      screen: 'flashing',
      sel: '#fb-dme-flash-tune',
      title: 'Flash',
      body:
        'Flash Tune writes the calibration only: a minute or two, and the ' +
        'usual way to put an edit on the car. Flash Program rewrites ' +
        'everything and is for program changes. Ignition on, a charger on ' +
        'the battery, and do not touch the cable until it says done.',
    },
    {
      screen: 'flashing',
      sel: '#fb-custom',
      title: 'Custom Options',
      body:
        'Changes to the program itself, built here and flashed like any ' +
        'file: an immobiliser delete for a swapped unit, a map switch that ' +
        'holds several tunes at once, removing the automatic upshift on the ' +
        'gearbox. Which ones you see depends on the module identified.',
    },
  ];

  const ms45Flashing = [
    {
      screen: 'flashing',
      sel: '#fb-custom-open',
      title: 'MS45: the map switch',
      body:
        'Build a program that carries up to several tunes and switches ' +
        'between them from the driver seat: with the ignition on, press ' +
        'the DSC button the set number of times and the tachometer sweeps ' +
        'to show the map now selected. Load your flash, the MPC flash and ' +
        'the tunes, Build, then flash the pair with Flash Program.',
    },
    {
      screen: 'flashing',
      sel: '#fb-custom-open',
      title: 'MS45: EWS delete',
      body:
        'Removes the immobiliser handshake so a DME runs in a car it was ' +
        'not married to. Only for a swapped or spare unit; a car with its ' +
        'own DME does not need it.',
    },
  ];

  const ms45Live = [
    {
      screen: 'tuning',
      sel: '#tn-live-arm',
      title: 'LIVE ON: tune while it runs',
      body:
        'With the live-tune program on the DME (Identify shows it), LIVE ' +
        'ON mirrors every edit onto the running engine the moment you ' +
        'make it. Tables are always live. Change a cell, watch the engine ' +
        'respond, change it back: no flashing between tries.',
    },
    {
      screen: 'tuning',
      sel: '.tn-defs-list',
      title: 'Which single values are live',
      body:
        'The Comfort group "Always live" lists the single values the DME ' +
        'keeps in RAM of their own: fan duty, speed limit, fuel-cut ' +
        'switches, hundreds more, all live together. Any other single value ' +
        'is live one at a time, the last one you edited; the rest take ' +
        'effect after a save.',
    },
    {
      screen: 'tuning',
      sel: '#tn-live-status',
      title: "What's open on the ECU",
      body:
        'The toolbar says what the DME holds open; click the count to ' +
        'narrow the list to just those. A table is read from its mirror ' +
        'until you discard it, save it, or switch the ignition off.',
    },
    {
      screen: 'tuning',
      sel: '#tn-live-keep',
      title: 'Keeping a live tune',
      body:
        'Tick Save to ECU and the DME writes the open edits into its ' +
        'calibration when you switch the ignition off (engine stopped). ' +
        'Leave it unticked to experiment: everything vanishes at key-off. ' +
        'Discard edits closes it all now and puts the stock values back.',
    },
    {
      screen: 'tuning',
      sel: '#tn-live-apps-btn',
      title: 'Live windows',
      body:
        'UI apps opens floating windows while you are live: a rev gauge, ' +
        "the engine's live values, the fault memory with a live scan and " +
        'clear, and the adaptations the DME has learned: mixture, idle, ' +
        'throttle, VANOS, each clearable on its own.',
    },
    {
      screen: 'tuning',
      sel: '.tn-defs-list',
      title: 'The live cursor',
      body:
        'Open a table while live and the cell the engine is reading right ' +
        'now is marked, following rpm and load as you drive. It shows where ' +
        'your edit will act before you make it.',
    },
  ];

  const logging = [
    {
      screen: 'logging',
      sel: '.log-pagehead',
      title: 'Data logging',
      body:
        "Record the engine's readings while you drive, chart them live, " +
        'and replay the run afterwards. This is how you see whether a ' +
        'change did what you meant: log before, log after, compare.',
    },
    {
      screen: 'logging',
      sel: '.log-side-head',
      title: 'Comfort or Expert',
      body:
        'Comfort offers the readings that matter under plain names, in ' +
        'groups: engine, temperatures, air and throttle, O2 sensors, fuel, ' +
        'ignition and knock, VANOS. Expert lists every module and job the ' +
        'car answers, read-only ones only.',
    },
    {
      screen: 'logging',
      sel: '.log-tree',
      title: 'Pick what to record',
      body:
        'Tick the readings. The engine control unit answers many of them ' +
        'in one exchange, so adding readings costs little; the summary ' +
        'below shows the rate you are getting.',
    },
    {
      screen: 'logging',
      sel: '.log-preset-load',
      title: 'Presets',
      body:
        'Save a set of readings as a preset and load it next time: one ' +
        'for idle work, one for wide-open throttle pulls, one for ' +
        'cooling.',
    },
    {
      screen: 'logging',
      sel: '.log-start',
      title: 'Start',
      body:
        'Charts appear and fill as the car answers. Drive the thing you ' +
        'want to see; Stop when you have it. The run is kept in History ' +
        'whether or not you export it.',
    },
    {
      screen: 'logging',
      sel: '.log-csv',
      title: 'Export CSV',
      body:
        'Timestamped CSV of the whole run, for a spreadsheet or any ' +
        'log viewer.',
    },
    {
      screen: 'history',
      sel: '#fb-history-log',
      title: 'Replay a run',
      body:
        'Open Log plays any recorded run back: scrub, change speed, zoom, ' +
        'and read the values at any instant. ' +
        (ms45
          ? 'Map mode paints the path the engine took across a table from ' +
            'your tune, cell by cell. And the black box: if the DME resets ' +
            'while you log, the 30 seconds before and 5 after are saved on ' +
            'their own, with the reason the DME recorded.'
          : 'If the engine control unit resets while you log, the moments ' +
            'before and after are saved on their own as a black box.'),
    },
    {
      screen: 'flashing',
      sel: '#fb-rail-settings',
      title: "That's the walk",
      body:
        'Back up, read, edit, flash, log, compare. Replay this any time ' +
        "from Settings here, or the editor's Tutorial button.",
    },
  ];

  return ms45
    ? flashing.concat(ms45Flashing, tuning, ms45Live, logging)
    : flashing.concat(tuning, logging);
}

/**
 * Ask the one question that decides the depth, then run the walk.
 * @returns {Promise<void>}
 */
async function tnTutorialStart() {
  if (document.querySelector('.tour-overlay')) return;
  const ms45 = await confirmDialog({
    title: 'Do you have an MS45 ECU?',
    body:
      'The Siemens MS45 is the engine control unit of the 2003-2006 ' +
      'E46 325i/330i, the E85 Z4 2.5i/3.0i and the E83 X3 (M54). It has ' +
      'extras here: custom options and live tuning. Say yes and the walk ' +
      'covers them too.',
    confirmLabel: 'Yes, an MS45',
    cancelLabel: 'No, or not sure',
  });
  await runTour(tnTutorialSteps(!!ms45), {
    screens: TN_TOUR_SCREENS,
    onEnd: () => {
      try {
        if (document.getElementById('fb-rail-flashing')) fbShowPage('flashing');
      } catch {
        /* the app is gone: nowhere to land */
      }
    },
  });
}

/**
 * The one-time offer, when the app first opens. Whatever the answer, not
 * asked again; Settings and the editor's Tutorial button replay it.
 * @returns {Promise<void>}
 */
async function tnTutorialOffer() {
  if (Settings.get(TN_TOUR_SEEN_KEY, 'no') === 'yes') return;
  Settings.set(TN_TOUR_SEEN_KEY, 'yes');
  const go = await confirmDialog({
    title: 'New here?',
    body:
      'A guided walk shows flashing, the tuning editor and data logging in a ' +
      'couple of minutes: where to start, what to back up, how to see a ' +
      'change work.',
    confirmLabel: 'Show me',
    cancelLabel: 'Not now',
  });
  if (go) tnTutorialStart();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tnTutorialSteps };
}
