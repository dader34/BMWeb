/**
 * @file What a run of the .IPO VM produces: the drawn lines, the menu items,
 * the jobs it sent, the dialogs it opened, and the navigation it performed.
 * One Emissions object per run; the driver reads it after the run settles.
 */

/**
 * One drawn cell of a LINE. `t` says what drew it: a printed literal, a
 * value bound to a result key, a lamp (digitalout) or a bar (analogout).
 * @typedef {object} IpoElement
 * @property {'text'|'value'|'lamp'|'gauge'} t - element kind
 * @property {string} [s] - the text (a literal, or the live text of a value)
 * @property {string} [key] - the result key a value/lamp/gauge is bound to
 * @property {string[]} [also] - other keys folded into a concatenated value
 * @property {Record<string, string>} [map] - a lookup table the value came from
 * @property {string} [unit] - the *_EINH key drawn beside a value
 * @property {number} [row] - screen row, relative to its LINE
 * @property {number} [col] - screen column
 * @property {number} [lrow] - the script's own row, once the driver rebases `row`
 * @property {number} [min] - analogout scale minimum
 * @property {number} [max] - analogout scale maximum
 * @property {number} [warnLo] - analogout valid-band low edge
 * @property {number} [warnHi] - analogout valid-band high edge
 * @property {string} [fmt] - analogout display format ("6.2")
 * @property {string} [on] - digitalout's TrueText
 * @property {string} [off] - digitalout's FalseText
 */

/**
 * One LINE block's output: a logical line of INPA's virtual screen.
 * @typedef {object} IpoLine
 * @property {string|null} label - the LINE's name (what Select offers), or null
 * @property {IpoElement[]} elements - the cells it drew
 * @property {string} [jobArg] - the job argument the line was drawn for
 */

/**
 * A menu ITEM as the run saw it: the F-key, its caption, and what pressing
 * it was found to do.
 * @typedef {object} IpoItem
 * @property {number} nr - F-key number (11..20 = shifted)
 * @property {string} [label] - caption
 * @property {boolean} [fromSetitem] - declared by setitem() rather than an ITEM token
 * @property {number|null} [on] - setitem's third argument: 1 shows the key, 0 hides it
 * @property {string} [menu] - the menu it opens
 * @property {string} [screen] - the screen it sets
 * @property {string} [job] - the job it sends
 * @property {string} [jobArg] - that job's argument
 * @property {boolean} [stateJob] - the job was found inside a state machine
 * @property {string} [stateEnter] - the state machine it starts
 * @property {boolean} [faultRead] - it switches the fault-read mode
 * @property {string[]} [prompt] - the input prompts it shows
 * @property {string[]} [messages] - the message boxes it opens
 * @property {string} [action] - select | deselect | exit | printscreen
 * @property {boolean} [appTool] - scriptchange/callwin: an app-side tool
 * @property {[number, IpoValue]} [_sel] - a record index it selects (`const v; store global`)
 */

/**
 * A job the run sent.
 * @typedef {object} IpoJobRecord
 * @property {string} job - job name
 * @property {string|null} sgbd - the SGBD the script addressed
 * @property {string} [arg] - the argument, when not fed by an input dialog
 */

/**
 * A message box the run opened.
 * @typedef {object} IpoMessage
 * @property {string} title - the box's title
 * @property {string|null} body - its text
 */

/** Everything one run of a proc emitted. */
class Emissions {
  constructor() {
    /** @type {string|null} settitle/setmenutitle */
    this.title = null;
    /** @type {IpoItem[]} */
    this.items = [];
    /** @type {IpoLine[]} */
    this.lines = [];
    /** @type {IpoJobRecord[]} */
    this.jobs = [];
    /** @type {string|null} the menu setmenu() handed control to */
    this.menu = null;
    /** @type {string|null} the screen setscreen() set */
    this.screen = null;
    /** @type {IpoMessage[]} */
    this.messages = [];
    /** @type {string[]} every builtin called, in order */
    this.calls = [];
    /** @type {string[]} the %STATE labels the run parked at */
    this.states = [];
    /** @type {string[]} result keys read (executed branches and harvested ones) */
    this.reads = [];
    /** @type {Set<string>} result keys a branch decided on */
    this.predicateReads = new Set();
    /** @type {string|null} the .IPO a scriptchange() handed control to */
    this.scriptChange = null;
    /**
     * clearrect / ftextclear: screen areas the body blanked, in the
     * script's own row / column coordinates; the runtime drops the cells
     * it still holds there.
     * @type {{row: number, col: number, h: number, w: number}[]}
     */
    this.clears = [];
    /**
     * viewopen(file): the text file the script wrote and asked INPA to show
     * (a whole-vehicle fault protocol), as its lines.
     * @type {{path: string, lines: string[]}|null}
     */
    this.view = null;
    /**
     * setscreen's second argument: TRUE = a frequent screen, re-run its cycle
     * while it is current (INPA's WM_TIMER loop); null = no setscreen.
     * @type {boolean|null}
     */
    this.screenFrequent = null;
    /** @type {boolean} blankscreen: the runtime clears the painted grid before the next cycle */
    this.blank = false;
    /** @type {boolean} exit: the script ended itself (INPA returns to script selection) */
    this.exit = false;
    /**
     * setstate(&sm): the state machine a key handed control to. In wire mode
     * the driver runs it (its picker, its job, its parks); offline the
     * builtin executes it for the lift.
     * @type {string|null}
     */
    this.stateEnter = null;
    /** @type {boolean} deselect(): the line filter Select set is cleared */
    this.deselect = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Emissions };
}
