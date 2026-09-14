/**
 * @file The builtin dispatch table: every `call` token name the VM answers,
 * mapped to its implementation. Names the decoder could not resolve are
 * keyed by number (`builtin_<hex>`); each of those carries the name the
 * corpus proved it to be.
 */

/**
 * Builtin name -> implementation. A name absent here is a silent noop in
 * `_builtin` (still recorded in emissions.calls).
 * @type {Record<string, IpoBuiltin>}
 */
const BUILTINS = {
  setmenutitle: bSetTitle,
  settitle: bSetTitle,
  setitem: bSetitem,
  setmenu: bSetmenu,
  setscreen: bSetscreen,
  INPAapiJob: bJob,
  INP1apiJob: bJob,
  INPAapiFsMode: bFsmode,
  INPAapiCheckJobStatus: bCheckStatus,
  INPAapiResultText: bResult,
  INPAapiResultAnalog: bResult,
  INPAapiResultDigital: bResult,
  INPAapiResultInt: bResultInt,
  INP1apiResultText: bResult,
  INP1apiResultInt: bResultInt,
  ftextout: bTextout,
  textout: bTextout,
  text: bTextout,
  userboxftextout: bUserboxTextout,
  messagebox: bMessage,
  builtin_53: bMessage,
  exit: bExit,
  printscreen: bPrint,
  scriptchange: bScriptchange,
  callwin: bCallwin,
  analogout: bAnalogout,
  digitalout: bDigitalout,
  multianalogout: bMultiAnalogout,
  strlen: bStrlen,
  midstr: bMidstr,
  inttostring: bInttostring,
  inttolong: bIntwiden,
  bytetoint: bIntwiden,
  realtostring: bInttostring,
  // the binary-structure helpers are noops OFFLINE (the Python twin's
  // behaviour, parity-diffed); a live run answers them in ipoDriveBuiltin
  SetStructureMode: bNoop,
  CreateStructure: bNoop,
  StructureByte: bNoop,
  StructureString: bNoop,
  StructureInt: bNoop,
  StructureLong: bNoop,
  userboxopen: bUserboxOpen,
  userboxclose: bUserboxClose,
  viewopen: bViewopen,
  viewclose: bViewclose,
  setstate: bSetstate,
  start: bSetstate,
  select: bSelect,
  deselect: bDeselect,
  INPAapiInit: bNoop,
  INPAapiEnd: bNoop,
  INPAapiFsLesen: bNoop,
  INP1apiErrorText: bErrorText,
  INP1apiErrorCode: bErrorCode,
  INP1apiResultSets: bResultSets,
  getinputstate: bGetInputState,
  inputhex: bInput,
  inputdigital: bInputDigital,
  input2hex: bInput,
  builtin_47: bInput, // input2int (ACC: Kalenderwoche/Jahr)
  builtin_3f: bInput,
  builtin_40: bInput,
  input2text: bInput,
  input2hexnum: bInput,
  inputint: bInput,
  fileopen: bFileopen,
  fileclose: bFileclose,
  filewrite: bFilewrite,
  fileread: bFileread,
  hexdump: bHexdump,
  printfile: bPrintfile,
  setstatemachine: bNoop,
  StrArrayCreate: bStrArrayCreate,
  StrArrayDestroy: bNoop,
  StrArrayWrite: bStrArrayWrite,
  StrArrayRead: bStrArrayRead,
  StrArrayDelete: bNoop,
  INPAapiResultBinary: bResultBinary,
  GetBinaryDataString: bGetBinaryDataString,
  // builtin_16 = togglelist: writes the picked row into an out variable.
  // Offline a noop (the pick is runtime-only); when driven it stores the
  // user's pick.
  builtin_16: bToggleList,
  builtin_12: bNoop, // control (0x12)
  // --- coverage sweep 2026-08-27: shapes proven against the corpus ---
  stringtoreal: bStringtoreal,
  builtin_21: bStringtoint, // stringtoint
  builtin_22: bHexconvert, // hexconvert
  builtin_23: bStrcat, // strcat (dest ref FIRST)
  builtin_26: bNumconvert, // inttoreal/realtoint family
  // longtoreal(in long, out real): Inpa.h's extern after inttolong, and the
  // fault printers use it that way (F_ORT_NR -> inttolong -> longtoreal ->
  // realtostring). Unnamed, it was a no-op and every fault read "Nr: 5".
  builtin_2a: bNumconvert,
  longtoreal: bNumconvert,
  formatnum: bInttostring, // (src, dst): number -> display
  getdate: bGetdate,
  gettime: bGettime,
  builtin_15: bGetapistring, // getapistring(out s)
  INPAapiResultSets: bResultSets, // single-ref INPA form
  INP1apiResultBinary: bResultBinary,
  builtin_74: bResult, // INP1apiResultReal(rc, val, KEY, set)
  builtin_14: bNoop, // stop
  // named from their call shapes (builtin-helpers.js IPO_BUILTIN_CANON)
  callstatemachine: bCallStatemachine,
  returnstatemachine: bReturnStatemachine,
  setjobstatus: bNoop, // the exit status for a calling program
  delay: bNoop, // a live run waits (suspensions.js IPO_WAIT_BUILTIN)
  inputnum: bInput, // (out real, title, text, min, max)
  inputtext: bInput, // (out string, title, text)
  ftextclear: bFtextClear,
  clearrect: bClearRect,
  setitemrepeat: bNoop, // key auto-repeat
  // the factory line's interfaces: PLC, order files, test management
  SPSInit: bUnavailable,
  SPSLeseVonSPS: bUnavailable,
  SPSSendeAnSPS: bUnavailable,
  ApiJobFsLesenFAB: bUnavailable,
  ApiResultFsLesenFAB: bUnavailable,
  ELDIOpenStartDialog: bUnavailable,
  // DTM / PEM calls (an out-reference and a key): which of the family
  // each number is cannot be told from the corpus; all are unavailable here
  builtin_0e: bUnavailable,
  builtin_2d: bUnavailable,
  builtin_36: bUnavailable,
  builtin_3c: bUnavailable,
  builtin_3d: bUnavailable,
  builtin_70: bUnavailable,
  builtin_7d: bUnavailable,
  builtin_7e: bUnavailable,
  builtin_80: bUnavailable,
  builtin_81: bUnavailable,
  builtin_87: bUnavailable,
  builtin_93: bUnavailable,
  builtin_90: bStrArraySize, // string array length, out-param
  builtin_1a: bSetcolor, // setcolor
  setcolor: bSetcolor,
  builtin_51: bBlankscreen, // blankscreen
  blankscreen: bBlankscreen,
  settimer: bSettimer,
  testtimer: bTesttimer,
  builtin_09: bSettimer,
  builtin_0a: bTesttimer,
  // BMWeb's own (home/bmweb.h): a pick from the host, a status line
  bmweb_pick: bBmwebPick,
  bmweb_status: bBmwebStatus,
  builtin_57: bUserboxClear, // userboxclear
  builtin_58: bUserboxSetcolor, // userboxsetcolor
  userboxsetcolor: bUserboxSetcolor,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BUILTINS };
}
