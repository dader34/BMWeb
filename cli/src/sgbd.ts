/**
 * @file What an SGBD DECLARES, read off the site's data with no cable in
 * the loop: the jobs it carries with their arguments, results and comment,
 * and the lookup tables its bytecode reads.
 *
 * The app reads exactly the same files. Tool32 lists a module's jobs from
 * `/api/ecu/<sgbd>/jobs` and asks `arguments/<JOB>` and `results/<JOB>` for
 * what one declares; the job VM is handed `data/sgbd-tables/<sgbd>.json`
 * for its `tabset` lookups. Both are static members of the chassis archive
 * the shim already fetches, so nothing here opens the port, sends a
 * telegram, or needs a car to be attached.
 *
 * A diagnostic group (D_MOTOR, D_0012) is not in any ECU archive: it is the
 * group bytecode under `data/groups/<name>.json.gz`, which carries its own
 * job names and tables. It is read here as a file, never resolved on the
 * wire, because resolving is what needs a car.
 */
import { CliError } from './args.ts';
import { formatCount, formatTable } from './table.ts';
import { loadRuntime, runtimeGlobals, type ApiFn } from './runtime.ts';

/** One argument a job declares, as `arguments/<JOB>.json` carries it. */
export interface JobArgument {
  ARG?: string;
  ARGTYPE?: string;
  name?: string;
  type?: string;
  [key: string]: unknown;
}

/** One result a job declares, once normalised out of either build's shape. */
export interface JobResult {
  name: string;
  comment: string;
}

/** Everything the SGBD says about one job. */
export interface JobInfo {
  sgbd: string;
  job: string;
  /** true when the app's classifier would gate this job behind a question */
  write: boolean;
  args: { name: string; type: string; comment: string }[];
  results: JobResult[];
  comment: string;
}

/** One lookup table of an SGBD, with its shape. */
export interface TableInfo {
  name: string;
  rows: number;
  columns: string[];
}

/**
 * The engine client to read declarations through: the runtime's own unless
 * a caller (a test with a fake site) hands one in.
 * @param api - the client, when given
 * @returns the client to use
 */
function client(api?: ApiFn): ApiFn {
  return api || (runtimeGlobals().api as ApiFn);
}

/**
 * Read a data/ file the app's own way.
 *
 * The two loaders behind this are the shim's (data-fetch.js): plain JSON
 * for the per-SGBD tables the shim serves out of the ECU archive, and the
 * gzip-aware one for the group files, which are gzipped on the site and
 * plain after a host content-decodes them. Going through the client first
 * lets a test's fake site answer the same path; the loaders are the
 * fallback, and are what a real run uses.
 * @param path - the site-relative data path
 * @param gzipped - read it with the gzip-aware loader
 * @param api - the client, when a caller supplied one
 * @returns the parsed body, or null
 */
async function dataFile(
  path: string,
  gzipped: boolean,
  api?: ApiFn
): Promise<unknown> {
  if (api) return api(`/${path}`).catch(() => null);
  const g = runtimeGlobals();
  const load = (gzipped ? g.webFetchGz : g.webFetchJson) as (
    p: string
  ) => Promise<unknown>;
  return load(path);
}

/**
 * Whether a name is one of the diagnostic groups the site ships.
 *
 * ASKED, NOT GUESSED. Most groups are named d_XXXX, but the shipped set
 * also holds d_motor, d_m60_10, g_amp and more, so a name pattern would
 * both miss real groups and claim ones that are not there. data/groups/
 * index.json is the list the app's own resolver checks a group against
 * (live.ts does the same before it resolves one), and it is a small static
 * file, so it is the answer here too.
 * @param sgbd - the name as typed
 * @param api - the client, when a caller supplied one
 * @returns true when the site ships a group by this name
 */
export async function isGroupName(sgbd: string, api?: ApiFn): Promise<boolean> {
  const key = String(sgbd || '')
    .trim()
    .toLowerCase();
  if (!key) return false;
  const idx = (await dataFile('data/groups/index.json', false, api).catch(
    () => null
  )) as { groups?: string[] } | null;
  return !!idx && (idx.groups || []).includes(key);
}

/** A group's file as the exporter writes it. */
interface GroupFile {
  sgbd?: string;
  jobs?: Record<string, unknown>;
  tables?: Record<string, Record<string, unknown>[]>;
}

/**
 * Read a group's bytecode file the way the resolver reads it, from
 * data/groups/<name>.json.gz. It carries the group's own job names and the
 * tables its probe reads, which is everything a group has to say offline.
 * @param name - the group name, any case
 * @param api - the client, when a caller supplied one
 * @returns the file
 * @throws CliError when the site ships no such group
 */
async function loadGroupFile(name: string, api?: ApiFn): Promise<GroupFile> {
  const key = name.toLowerCase();
  const doc = (await dataFile(
    `data/groups/${key}.json.gz`,
    true,
    api
  )) as GroupFile | null;
  // the index listed this group, so a missing or unreadable file is the
  // site's, not a name the user got wrong
  if (!doc || typeof doc !== 'object')
    throw new CliError(
      `the site lists group ${name} but serves no bytecode for it (data/groups/${key}.json.gz)`
    );
  return doc;
}

/**
 * The job names an SGBD declares.
 *
 * jobs.json is either an array of names (the web build sorts the names of
 * meta.json's job map into it) or the spec object {jobs:[...]}, whose
 * entries may be objects; both shapes are flattened to names here exactly
 * as Tool32 flattens them.
 * @param sgbd - the SGBD, any case
 * @param api - the engine client
 * @returns the job names, sorted
 * @throws CliError when the site ships no such module
 */
export async function sgbdJobNames(
  sgbd: string,
  api?: ApiFn
): Promise<string[]> {
  const target = sgbd.toLowerCase();
  if (await isGroupName(target, api)) {
    const doc = await loadGroupFile(target, api);
    return Object.keys(doc.jobs || {}).sort();
  }
  let doc: unknown;
  try {
    doc = await client(api)(`/api/ecu/${encodeURIComponent(target)}/jobs`);
  } catch (e) {
    throw new CliError(
      `no module ${sgbd} on the site (${(e as Error).message})`
    );
  }
  const list = Array.isArray(doc)
    ? doc
    : (doc as { jobs?: unknown[] })?.jobs || [];
  const names = (list as unknown[])
    .map((j) =>
      typeof j === 'string' ? j : String((j as { name?: string })?.name || '')
    )
    .filter((n) => n);
  return [...new Set(names)].sort();
}

/**
 * One line of `results/<JOB>.json` as a name and a comment.
 *
 * The web build writes "NAME : comment" strings; a spec build writes
 * {name, comment} objects. Both reach this, and the split is on the first
 * " : " only, because a comment may well contain one of its own.
 * @param r - the entry
 * @returns the normalised result, or null when it names nothing
 */
function normalizeResult(r: unknown): JobResult | null {
  if (typeof r === 'string') {
    const at = r.indexOf(' : ');
    const name = (at >= 0 ? r.slice(0, at) : r).trim();
    return name
      ? { name, comment: at >= 0 ? r.slice(at + 3).trim() : '' }
      : null;
  }
  const o = r as { name?: string; comment?: string; unit?: string };
  const name = String(o?.name || '').trim();
  if (!name) return null;
  return { name, comment: String(o.comment || o.unit || '').trim() };
}

/**
 * Everything the SGBD declares about one job: its arguments, its results,
 * and the comment its author left, plus the write classifier's verdict.
 *
 * Nothing here runs the job. The three files behind it are static archive
 * members, and a job that declares no arguments simply has no
 * arguments/<JOB>.json, which is a 404 the app treats as "none declared".
 * @param sgbd - the SGBD, any case
 * @param job - the job name, any case
 * @param api - the engine client
 * @returns what the SGBD says
 * @throws CliError when the module or the job is not there
 */
export async function jobInfo(
  sgbd: string,
  job: string,
  api?: ApiFn
): Promise<JobInfo> {
  const R = loadRuntime();
  const target = sgbd.toLowerCase();
  const name = job.toUpperCase();
  const names = await sgbdJobNames(target, api);
  if (!names.some((n) => n.toUpperCase() === name)) {
    const near = names.filter((n) => n.toUpperCase().includes(name));
    throw new CliError(
      `${target} declares no job ${name}` +
        (near.length
          ? ` (did you mean ${near.slice(0, 6).join(', ')}?)`
          : ` (${names.length} jobs; bmweb sgbd jobs ${target} lists them)`)
    );
  }
  const info: JobInfo = {
    sgbd: target,
    job: name,
    write: R.isWriteJob(name),
    args: [],
    results: [],
    comment: '',
  };
  // a group carries only its job names and its tables; the declaration
  // files are per-module archive members, so a group's info stops here
  if (await isGroupName(target, api)) return info;
  const c = client(api);
  const enc = encodeURIComponent(name);
  const a = (await c(`/api/ecu/${target}/arguments/${enc}`).catch(
    () => null
  )) as { arguments?: JobArgument[] } | JobArgument[] | null;
  const argRows = Array.isArray(a) ? a : a?.arguments || [];
  info.args = argRows
    .map((x) => ({
      name: String(x.ARG || x.name || '').trim(),
      type: String(x.ARGTYPE || x.type || '').trim(),
      // the exporter numbers a declaration's comment lines ARGCOMMENT0..n;
      // they read as one sentence, so they are joined back into one
      comment: Object.keys(x)
        .filter((k) => /^ARGCOMMENT\d+$/.test(k))
        .sort(
          (p, q) => Number(p.replace(/\D/g, '')) - Number(q.replace(/\D/g, ''))
        )
        .map((k) => String(x[k] || '').trim())
        .filter((s) => s)
        .join(' '),
    }))
    .filter((x) => x.name);
  const r = (await c(`/api/ecu/${target}/results/${enc}`).catch(() => null)) as
    unknown[] | null;
  info.results = (Array.isArray(r) ? r : [])
    .map(normalizeResult)
    .filter((x): x is JobResult => !!x);
  // WHAT THE COMMENT IS. The site's export does not carry a job's own
  // comment: it writes each result as "NAME : comment" and keeps nothing
  // above them. Where an SGBD's author put a JOB_COMMENT result in, that IS
  // the description of the job, so it is used; otherwise the first declared
  // result's comment is the nearest thing the data has to one, and saying
  // what the job's leading result means is more use than an empty column.
  const jc = info.results.find((x) => /^JOB_?COMMENT/i.test(x.name));
  info.comment = jc ? jc.comment : (info.results[0]?.comment ?? '');
  return info;
}

/**
 * `job --info`: what the SGBD declares, printed instead of run.
 * @param sgbd - the SGBD
 * @param job - the job name
 * @param opts - output shape and the client
 * @returns the lines
 */
export async function jobInfoCommand(
  sgbd: string,
  job: string,
  opts: { json?: boolean; apiFn?: ApiFn } = {}
): Promise<string[]> {
  const info = await jobInfo(sgbd, job, opts.apiFn);
  if (opts.json) return [JSON.stringify(info, null, 2)];
  const out: string[] = [
    `${info.sgbd} ${info.job}${info.write ? '  [WRITE]' : ''}`,
  ];
  // the headline comment is only worth a line of its own when it is not
  // already about to be printed as the first result's own comment
  if (info.comment && info.comment !== info.results[0]?.comment)
    out.push(info.comment);
  out.push('', `arguments (${info.args.length})`);
  out.push(
    ...(info.args.length
      ? formatTable(
          info.args.map((a) => [a.name, a.type, a.comment]),
          undefined,
          '  '
        )
      : ['  none declared'])
  );
  out.push('', `results (${info.results.length})`);
  out.push(
    ...(info.results.length
      ? formatTable(
          info.results.map((r) => [r.name, r.comment]),
          undefined,
          '  '
        )
      : ['  none declared'])
  );
  return out;
}

/** How many names of a list a table cell shows before it says how many more. */
export const NAME_LIST_MAX = 6;

/**
 * A list of names for one table cell.
 *
 * A single job can declare eighty results, and the whole list in one cell
 * would pad every other row to its width and wrap the terminal. The first
 * few name what the job is about; the count says the rest are there, and
 * `job --info` or --json prints them all.
 * @param names - the names
 * @returns the cell text
 */
function nameList(names: string[]): string {
  if (names.length <= NAME_LIST_MAX) return names.join(', ');
  return `${names.slice(0, NAME_LIST_MAX).join(', ')}, +${names.length - NAME_LIST_MAX} more`;
}

/**
 * `sgbd jobs`: every job the SGBD declares, one row each.
 *
 * The WRITE column is the app's own classifier (isWriteJob): a read token
 * in the name wins, a write token makes a write, and an unknown name is a
 * write. It is the same verdict the `job` command gates on and the same one
 * Tool32 tags a job with, so a yes here means that job would be asked
 * about before it were sent.
 * @param sgbd - the SGBD or group name
 * @param opts - output shape and the client
 * @returns the lines
 */
export async function sgbdJobsCommand(
  sgbd: string,
  opts: { json?: boolean; apiFn?: ApiFn } = {}
): Promise<string[]> {
  const R = loadRuntime();
  const target = sgbd.toLowerCase();
  const names = await sgbdJobNames(target, opts.apiFn);
  const group = await isGroupName(target, opts.apiFn);
  // a group has no per-job declaration files, so its rows are names and the
  // classifier's verdict; a module's rows are filled in from its archive
  const infos: JobInfo[] = group
    ? names.map((n) => ({
        sgbd: target,
        job: n,
        write: R.isWriteJob(n),
        args: [],
        results: [],
        comment: '',
      }))
    : await Promise.all(names.map((n) => jobInfo(target, n, opts.apiFn)));
  if (opts.json)
    return [JSON.stringify({ sgbd: target, group, jobs: infos }, null, 2)];
  if (!infos.length) return [`${target} declares no jobs`];
  const rows = infos.map((i) => [
    i.job,
    nameList(i.args.map((a) => a.name)),
    nameList(i.results.map((r) => r.name)),
    // the first line only: a declaration's comment can run to a paragraph
    // and a table row is one line
    (i.comment.split(/\r?\n/)[0] as string).trim(),
    i.write ? 'yes' : '',
  ]);
  const out = formatTable(rows, [
    'NAME',
    'ARGS',
    'RESULTS',
    'COMMENT',
    'WRITE',
  ]);
  const writes = infos.filter((i) => i.write).length;
  out.push(
    '',
    `${formatCount(infos.length)} job${infos.length === 1 ? '' : 's'}, ${formatCount(writes)} the app would ask about before sending` +
      (group ? ' (a group file carries job names, not declarations)' : '')
  );
  return out;
}

/**
 * The lookup tables an SGBD carries, name to rows.
 *
 * For a module this is `data/sgbd-tables/<sgbd>.json`, the very map the job
 * VM is constructed with; for a group it is the `tables` member of the
 * group file. The shared table set (t_pcod, t_scod and friends, under
 * data/groups/shared-tables.json.gz) is NOT listed: those belong to no one
 * SGBD, every VM is given all of them, and mixing them in would say a
 * module carries tables it does not.
 * @param sgbd - the SGBD or group name
 * @param api - the engine client
 * @returns the table map
 * @throws CliError when the site ships no tables for it
 */
export async function sgbdTables(
  sgbd: string,
  api?: ApiFn
): Promise<Record<string, Record<string, unknown>[]>> {
  const target = sgbd.toLowerCase();
  if (await isGroupName(target, api)) {
    const doc = await loadGroupFile(target, api);
    return doc.tables || {};
  }
  const doc = (await dataFile(
    `data/sgbd-tables/${target}.json`,
    false,
    api
  )) as Record<string, Record<string, unknown>[]> | null;
  if (!doc || typeof doc !== 'object') {
    // an SGBD with no tables.json is not an error the user made; one the
    // site does not carry at all is. The job list tells them apart.
    await sgbdJobNames(target, api);
    return {};
  }
  return doc;
}

/**
 * The column names of a table, in the order its first row declares them.
 *
 * The exporter writes every row of a table with the same keys, so the first
 * row is the header; a longer row later is still folded in rather than
 * dropped, because a table that is not uniform should be reported as it is.
 * @param rows - the table's rows
 * @returns the column names
 */
export function tableColumns(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  for (const row of rows || [])
    for (const k of Object.keys(row || {})) if (!cols.includes(k)) cols.push(k);
  return cols;
}

/**
 * `sgbd tables`: every lookup table the SGBD carries, with its shape.
 * @param sgbd - the SGBD or group name
 * @param opts - output shape and the client
 * @returns the lines
 */
export async function sgbdTablesCommand(
  sgbd: string,
  opts: { json?: boolean; apiFn?: ApiFn } = {}
): Promise<string[]> {
  const target = sgbd.toLowerCase();
  const tabs = await sgbdTables(target, opts.apiFn);
  const list: TableInfo[] = Object.keys(tabs)
    .sort()
    .map((name) => ({
      name,
      rows: (tabs[name] || []).length,
      columns: tableColumns(tabs[name] || []),
    }));
  if (opts.json)
    return [JSON.stringify({ sgbd: target, tables: list }, null, 2)];
  if (!list.length) return [`${target} carries no lookup tables`];
  const out = formatTable(
    list.map((t) => [t.name, t.rows, t.columns.length, nameList(t.columns)]),
    ['NAME', 'ROWS', 'COLS', 'COLUMNS']
  );
  out.push(
    '',
    `${formatCount(list.length)} table${list.length === 1 ? '' : 's'} (bmweb sgbd table ${target} <NAME> prints one)`
  );
  return out;
}

/**
 * `sgbd table`: one table's rows.
 * @param sgbd - the SGBD or group name
 * @param name - the table name, any case
 * @param opts - output shape and the client
 * @returns the lines
 * @throws CliError when the SGBD carries no such table
 */
export async function sgbdTableCommand(
  sgbd: string,
  name: string,
  opts: { json?: boolean; apiFn?: ApiFn } = {}
): Promise<string[]> {
  const target = sgbd.toLowerCase();
  const tabs = await sgbdTables(target, opts.apiFn);
  const want = name.toUpperCase();
  const key = Object.keys(tabs).find((k) => k.toUpperCase() === want);
  if (!key) {
    const near = Object.keys(tabs)
      .filter((k) => k.toUpperCase().includes(want))
      .sort();
    throw new CliError(
      `${target} carries no table ${name}` +
        (near.length
          ? ` (did you mean ${near.slice(0, 6).join(', ')}?)`
          : ` (bmweb sgbd tables ${target} lists them)`)
    );
  }
  const rows = tabs[key] || [];
  if (opts.json)
    return [JSON.stringify({ sgbd: target, table: key, rows }, null, 2)];
  const cols = tableColumns(rows);
  if (!cols.length) return [`${target} ${key}: no rows`];
  const out = formatTable(
    rows.map((r) => cols.map((c) => valueCell(r[c]))),
    cols
  );
  out.push(
    '',
    `${formatCount(rows.length)} row${rows.length === 1 ? '' : 's'} in ${key}`
  );
  return out;
}

/**
 * One table cell as text: a table's values are strings as exported, but an
 * absent key and a nested value both have to print as something.
 * @param v - the value
 * @returns the text
 */
function valueCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
