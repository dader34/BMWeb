// What the live tests share: a module script of the project's own (in
// INPA's language, compiled by the app's compiler), a fake car behind the
// engine client, and a scripted terminal. No BMW data anywhere: the script
// is written here, and the car answers what the test says it answers.
import type { ApiFn, EcuRecord, IpoExec, JobAnswer } from '../src/runtime.ts';
import { loadRuntime } from '../src/runtime.ts';
import type { Key, Terminal } from '../src/tui.ts';

/**
 * A module script with everything the runtime's contracts touch: a key that
 * reads, a key that clears (a write), a submenu whose prologue energises an
 * actuator and whose Back releases it, a screen with a lamp and a gauge,
 * and an inpaexit that ends the session.
 */
export const MODULE_SOURCE = `
#include "PROBE.H"
string g_sgbd = "MS450";

inpainit()
{
  setmenutitle("Probe");
  setscreen(s_main, 0);
  setmenu(m_main);
}

inpaexit()
{
  INPAapiJob(g_sgbd, "DIAGNOSE_ENDE", "", "");
}

MENU m_main()
{
  INIT {
    setmenutitle("Main");
  }
  ITEM(1, "Ident")
  {
    setscreen(s_ident, 0);
  }
  ITEM(2, "Fault memory")
  {
    INPAapiJob(g_sgbd, "FS_LESEN", "", "");
    setscreen(s_fs, 0);
  }
  ITEM(3, "Clear faults")
  {
    INPAapiJob(g_sgbd, "FS_LOESCHEN", "", "");
  }
  ITEM(4, "Activate")
  {
    setscreen(s_act, 0);
    setmenu(m_act);
  }
  ITEM(5, "Status")
  {
    setscreen(s_status, 1);
  }
  ITEM(20, "Exit")
  {
    exit();
  }
}

MENU m_act()
{
  INIT {
    setmenutitle("Actuator");
    INPAapiJob(g_sgbd, "STEUERN_X", "1", "");
  }
  ITEM(10, "Back")
  {
    INPAapiJob(g_sgbd, "STEUERN_X", "0", "");
    setscreen(s_main, 0);
    setmenu(m_main);
  }
}

SCREEN s_main()
{
  settitle("Main screen");
  LINE("", "")
  {
    ftextout("Probe module", 0, 0, 0, 0);
  }
}

SCREEN s_ident()
{
  settitle("Identification");
  LINE("Ident", "ID_SW_NR")
  {
    INPAapiJob(g_sgbd, "IDENT", "", "");
    text(0, 0, "Software:");
    INPAapiResultText(1, "ID_SW_NR", 0, 12);
  }
}

SCREEN s_fs()
{
  settitle("Faults");
  LINE("", "")
  {
    ftextout("Fault memory read", 0, 0, 0, 0);
  }
}

SCREEN s_act()
{
  settitle("Actuator");
  LINE("", "")
  {
    ftextout("Actuator energised", 0, 0, 0, 0);
  }
}

SCREEN s_status()
{
  settitle("Status");
  LINE("Speed", "STAT_DREHZAHL_WERT")
  {
    INPAapiJob(g_sgbd, "STATUS_LESEN", "", "");
    text(0, 0, "Speed");
    INPAapiResultAnalog(1, "STAT_DREHZAHL_WERT", 1, 0, 0, 6000, 500, 5000, "4.0");
    INPAapiResultDigital(1, "STAT_KL15", 2, 0, "on", "off");
  }
}
`;

/**
 * A whole-vehicle script in the shape of INPA's: a fault-memory menu whose
 * read key asks two groups for their fault memories through a progress
 * window.
 */
export const VEHICLE_SOURCE = `
#include "PROBE.H"

inpainit()
{
  setmenutitle("E46");
  setscreen(s_main, 0);
  setmenu(m_main);
}

MENU m_main()
{
  ITEM(1, "Fehlerspeicher")
  {
    setmenu(m_fs);
  }
}

MENU m_fs()
{
  ITEM(1, "FS lesen")
  {
    userboxopen("Fault memories", 10, 10, 60, 5);
    userboxftextout("Engine", 1, 1, 0, 0);
    INPAapiJob("D_MOTOR", "FS_LESEN", "", "");
    userboxftextout("Gearbox", 1, 1, 0, 0);
    INPAapiJob("D_0044", "FS_LESEN", "", "");
    userboxclose();
  }
  ITEM(10, "Back")
  {
    setmenu(m_main);
  }
}

SCREEN s_main()
{
  LINE("", "")
  {
    ftextout("E46 whole-vehicle script", 0, 0, 0, 0);
  }
}
`;

/** The header both scripts include: the prototypes the compiler needs. */
export const HEADER = `extern setmenutitle(in: string title);
extern INPAapiResultText(in: int set, in: string key, in: int row, in: int col);
extern INPAapiResultAnalog(in: int set, in: string key, in: int row, in: int col, in: real min, in: real max, in: real lo, in: real hi, in: string fmt);
extern INPAapiResultDigital(in: int set, in: string key, in: int row, in: int col, in: string on, in: string off);
`;

/**
 * Compile one of the sources through the app's compiler.
 * @param src - the source
 * @param name - the stem to report as the exec's ecu
 * @returns the exec
 */
export function compile(src: string, name: string): IpoExec {
  const R = loadRuntime();
  const r = R.ipofCompileSource(src, { name, files: { 'probe.h': HEADER } });
  if (!r.ok || !r.exec)
    throw new Error(`compile ${name}: ${JSON.stringify(r.errors)}`);
  return r.exec;
}

/** One request the fake car saw. */
export interface Sent {
  target: string;
  job: string;
  arg: string | null;
}

/** The engine's synthetic system set for a module. */
export function sysSet(sgbd: string, job = 'X'): JobAnswer['system'] {
  return {
    OBJECT: sgbd,
    VARIANTE: sgbd.toUpperCase(),
    JOBNAME: job,
    SAETZE: 1,
  };
}

/**
 * A fake car behind the engine client: /api/ecu/<sgbd>/run/<job> answers
 * from `answers`, the static routes from `routes`, anything else throws.
 * Group names resolve as `groups` says, the way the shim resolves them.
 * @param answers - what a job answers (or an Error to throw)
 * @param routes - static routes (paths without query) and their JSON
 * @param groups - group name -> the variant that answers
 * @returns the client and the record of what was sent
 */
export function fakeCar(
  answers: (
    job: string,
    arg: string | null,
    target: string
  ) => JobAnswer | Error,
  routes: Record<string, unknown> = {},
  groups: Record<string, string> = {}
): { api: ApiFn; sent: Sent[] } {
  const sent: Sent[] = [];
  const api: ApiFn = async (url) => {
    const m = /^\/api\/ecu\/([^/]+)\/run\/([^?]+)(?:\?arg=(.*))?$/.exec(
      String(url)
    );
    if (m) {
      const raw = (m[1] as string).toLowerCase();
      const target = groups[raw] || raw;
      const job = decodeURIComponent(m[2] as string);
      const arg = m[3] != null ? decodeURIComponent(m[3]) : null;
      sent.push({ target, job, arg });
      const a = answers(job, arg, target);
      if (a instanceof Error) throw a;
      return a;
    }
    const path = String(url).split('?')[0] as string;
    if (path in routes) {
      const r = routes[path];
      if (r instanceof Error) throw r;
      return r;
    }
    throw new Error(`no route ${url}`);
  };
  return { api, sent };
}

/** The car's own config row for the probe module, as a chassis config. */
export const E46_CONFIG = {
  id: 'E46',
  sections: [
    {
      name: 'Engine',
      ecus: [
        { code: 'PROBE', label: 'Probe module', sgbd: 'probe', group: null },
        {
          code: 'MS450',
          label: 'MS45.1 for M54',
          sgbd: 'ms450ds0',
          group: 'D_0012',
        },
      ],
    },
  ],
};

/** A module record for the probe script, as openModule would prepare it. */
export function probeEcu(): EcuRecord {
  return {
    sgbd: 'probe',
    code: 'PROBE',
    label: 'Probe module',
    chassis: 'E46',
    _variant: 'PROBE',
    _ipoKnownSgbds: new Set(['probe', 'ms450ds0']),
  };
}

/** A scripted terminal: keys are pushed by the test, prompts answered from a queue. */
export interface FakeTerminal extends Terminal {
  out: string;
  prompts: string[];
  answers: string[];
  press(ch: string, extra?: Partial<Key>): void;
  keyHandlers: Set<(k: Key) => void>;
}

/**
 * A terminal that records what was written, answers prompts from a queue,
 * and lets the test press keys.
 * @param answers - the answers prompts get, in order (null cancels)
 * @returns the terminal
 */
export function fakeTerminal(answers: (string | null)[] = []): FakeTerminal {
  const queue = [...answers];
  const term: FakeTerminal = {
    out: '',
    prompts: [],
    answers: answers.filter((a): a is string => a != null),
    keyHandlers: new Set(),
    columns: 80,
    rows: 24,
    write(s) {
      term.out += s;
    },
    onKey(fn) {
      term.keyHandlers.add(fn);
      return () => {
        term.keyHandlers.delete(fn);
      };
    },
    async readLine(prompt) {
      term.prompts.push(prompt);
      if (!queue.length) return null;
      return queue.shift() as string | null;
    },
    close() {},
    press(ch, extra = {}) {
      const k: Key = { name: '', ch, shift: false, ctrl: false, ...extra };
      for (const f of term.keyHandlers) f(k);
    },
  };
  return term;
}

/**
 * Wait until a condition holds, or fail.
 * @param cond - what to wait for
 * @param what - named in the failure
 * @param ms - how long at most
 */
export async function waitFor(
  cond: () => boolean,
  what: string,
  ms = 3000
): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
