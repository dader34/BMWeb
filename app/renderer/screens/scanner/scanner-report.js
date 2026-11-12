/**
 * @file BMWeb Scanner: the scan as a whole-car report, for the Garage.
 *
 * The Garage keeps, redraws and compares fault scans in one shape (the
 * IpoProtocolReport of screens/ipo-runtime/protocol.js). This turns what
 * the Scanner's walk read (scanner-scan.js) -- the same units, telegrams
 * and fault lists its window shows -- into that shape, so everything that
 * reads a stored scan (the history, the comparison, the control unit
 * tree's boxes) reads this one unchanged.
 *
 * No SGBD is involved, so a unit has no variant name. It is filed under
 * the group the chassis's control unit tree gives its address: that is the
 * name the tree's boxes join on, and it stays the same from one scan to
 * the next, which is what the comparison needs.
 */

/* exported SCANNER_KLINE_BUS, scannerScansChassis, scannerGroupsByAddress, scannerUnitGroup, scannerFaultEntry, scannerUnitCodes, scannerReport, scannerGarageReport */

/**
 * The body bus of the series the scanner can talk to. It asks in DS2 and
 * KWP2000 at 9600 baud on the K line, which is the diagnostic line of the
 * cars built around the K-bus (E46, E39, E38, E53, E83, E85 ...); a car
 * whose tree has none is reached through a gateway this scan cannot use.
 */
const SCANNER_KLINE_BUS = 'KBUS';

/** A fault's presence, in the words the report's readers look for. */
const SCANNER_PRESENT_TEXT = 'Fehler momentan vorhanden';
const SCANNER_STORED_TEXT = 'Fehler momentan nicht vorhanden';

/** The reference's marker for a fault that is present now (red). */
const SCANNER_STATE_PRESENT = 2;

/**
 * Can the scanner scan this chassis?
 * @param {string} chassis - The chassis id.
 * @param {(chassis: string) => Promise<string[]>} [busesFor] - The buses its
 *   tree draws (ecuTreeBusesFor).
 * @returns {Promise<boolean>}
 */
async function scannerScansChassis(chassis, busesFor) {
  const ask =
    busesFor ||
    (typeof ecuTreeBusesFor === 'function' ? ecuTreeBusesFor : null);
  if (!ask || !chassis) return false;
  const buses = await ask(chassis).catch(() => []);
  return buses.includes(SCANNER_KLINE_BUS);
}

/**
 * The group each diagnostic address goes by in a control unit tree. Every
 * entry counts, drawn or not: an address is an address whichever bus the
 * tree files it under. The first entry to name an address keeps it.
 * @param {EcuTree|null} tree
 * @returns {Map<number, string>} Address -> group, lower-case.
 */
function scannerGroupsByAddress(tree) {
  const out = new Map();
  for (const e of (tree && tree.ecus) || []) {
    const group = String((e.groups || [])[0] || '').toLowerCase();
    if (typeof e.addr !== 'number' || !group || out.has(e.addr)) continue;
    out.set(e.addr, group);
  }
  return out;
}

/**
 * The group a unit is filed under: the tree's group for the address it
 * answered on (its KWP2000 address when that is how it identified), else
 * the group EDIABAS names any address by, D_00xx.
 * @param {ScannerModule} m
 * @param {boolean} kwp - It identified over KWP2000.
 * @param {Map<number, string>} groups - scannerGroupsByAddress.
 * @returns {string}
 */
function scannerUnitGroup(m, kwp, groups) {
  const answeredOn = kwp ? scannerKwpAddress(m) : m.address;
  return (
    groups.get(answeredOn) ||
    groups.get(m.address) ||
    `d_00${m.address.toString(16).padStart(2, '0')}`
  );
}

/**
 * One fault as the report keeps it: the fields a fault-memory read gives
 * (the code as F_ORT_NR, the text as F_ORT_TEXT, the presence text), with
 * the reference's wording, and the code as the Errors window prints it
 * (F_CODE_STRING) -- which tells the report's readers to show both as they
 * are (faultFields, screens/module/faults.js) rather than look the code up
 * in a codespace this read never had.
 * @param {string} unit - The unit's short name.
 * @param {ScannerFault} f
 * @param {boolean} shadow - It is in the shadow memory.
 * @returns {object}
 */
function scannerFaultEntry(unit, f, shadow) {
  const t = scannerFaultText(unit, f.code, f.param, shadow);
  return {
    F_ORT_NR: f.code,
    F_CODE_STRING: f.code
      .toString(16)
      .toUpperCase()
      .padStart(f.code > 0xff ? 4 : 2, '0'),
    F_ORT_TEXT: shadow ? `${t.text} (shadow memory)` : t.text,
    F_VORHANDEN_TEXT:
      t.state === SCANNER_STATE_PRESENT
        ? SCANNER_PRESENT_TEXT
        : SCANNER_STORED_TEXT,
  };
}

/**
 * A unit's faults as report entries: its fault memory, then its shadow
 * memory.
 *
 * A MEMORY THAT COULD NOT BE READ IS NEVER FILED AS EMPTY. A unit whose
 * count says it holds faults, or gave no count at all, and whose list did
 * not come, gets one entry saying so; without it the report would print
 * "OK" for a unit nothing is known about.
 * @param {ScannerUnitResult} r
 * @returns {object[]}
 */
function scannerUnitCodes(r) {
  const unit = r.module.name;
  const lists = r.faults || { errors: null, shadow: null };
  const unread = (count, what) => ({
    F_ORT_TEXT:
      count == null
        ? `The ${what} could not be read`
        : `${count} fault${count === 1 ? '' : 's'} counted in the ${what}; the list could not be read`,
    F_VORHANDEN_TEXT: SCANNER_STORED_TEXT,
  });
  const codes = [];
  if (lists.errors) {
    for (const f of lists.errors) codes.push(scannerFaultEntry(unit, f, false));
  } else if (r.errors !== 0) {
    codes.push(unread(r.errors, 'fault memory'));
  }
  if (lists.shadow) {
    for (const f of lists.shadow) codes.push(scannerFaultEntry(unit, f, true));
  } else if (r.shadow) {
    codes.push(unread(r.shadow, 'shadow memory'));
  }
  return codes;
}

/**
 * The identification, under the names an identification read gives it.
 * @param {ScannerIdent} id
 * @returns {object}
 */
function scannerReportIdent(id) {
  return {
    ID_BMW_NR: id.part,
    ID_HW_NR: id.hw,
    ID_SW_NR: id.sw,
    ID_COD_INDEX: id.ci,
    ID_DIAG_INDEX: id.di,
    ID_BUS_INDEX: id.bi,
  };
}

/**
 * A scan as a whole-car fault report.
 * @param {ScannerUnitResult[]} answered - The units read, in scan order.
 * @param {ScannerModule[]} silent - The units that did not answer.
 * @param {Map<number, string>} groups - scannerGroupsByAddress.
 * @returns {IpoProtocolReport}
 */
function scannerReport(answered, silent, groups) {
  return {
    kind: 'faults',
    modules: answered.map((r) => {
      const group = scannerUnitGroup(r.module, !!r.id.kwp, groups);
      return {
        sgbd: group,
        via: group,
        label: r.module.desc,
        codes: scannerUnitCodes(r),
        ident: scannerReportIdent(r.id),
      };
    }),
    silent: silent.map((m) => ({
      target: scannerUnitGroup(m, false, groups),
      label: m.desc,
      error: 'no response',
    })),
    showText: false,
  };
}

/**
 * A scan as the report the Garage keeps, for a car of a chassis: the units
 * filed under that chassis's tree groups, the faults in the reference's
 * words. Without the tree or the text pack (no connection to the data
 * mirrors) it is still a report, with D_00xx and "Error number XX".
 * @param {string} chassis - The chassis id.
 * @param {ScannerUnitResult[]} answered - The units read, in scan order.
 * @param {ScannerModule[]} silent - The units that did not answer.
 * @param {{tree?: (chassis: string) => Promise<EcuTree|null>, assets?: () => Promise<boolean>}} [deps] -
 *   The data sources (tests hand in fakes).
 * @returns {Promise<IpoProtocolReport>}
 */
async function scannerGarageReport(chassis, answered, silent, deps) {
  const D = {
    tree: typeof ecuTreeForChassis === 'function' ? ecuTreeForChassis : null,
    assets: () => scannerAssetsLoad(),
    ...(deps || {}),
  };
  const [tree] = await Promise.all([
    D.tree ? D.tree(chassis).catch(() => null) : null,
    D.assets(),
  ]);
  return scannerReport(answered, silent, scannerGroupsByAddress(tree));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCANNER_KLINE_BUS,
    scannerScansChassis,
    scannerGroupsByAddress,
    scannerUnitGroup,
    scannerFaultEntry,
    scannerUnitCodes,
    scannerReport,
    scannerGarageReport,
  };
}
