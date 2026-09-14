// The ipo commands over a source compiled through the app's own compiler:
// the static scan finds what each key opens and sends, marks the writes
// the app would confirm, follows a helper function, and the file-level
// commands read, refuse and write what they should.
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CliError } from '../src/args.ts';
import {
  describeMenu,
  describeScript,
  ipoCompile,
  ipoInfo,
  ipoKeys,
  keyName,
  readScript,
} from '../src/ipo.ts';
import { loadRuntime } from '../src/runtime.ts';

/**
 * A script in INPA's own source form, small enough to reason about: a
 * key that reads, one that writes, one that reaches its job through a
 * helper, a blank slot that opens a submenu, and INPA's Back and Print.
 */
const SOURCE = `
#include "PROBE.H"
string g_sgbd = "MS450";

inpainit()
{
  setmenutitle("Test script");
  setscreen(s_main, 0);
  setmenu(m_main);
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
    setscreen(s_fs, 1);
  }
  ITEM(3, "Clear faults")
  {
    INPAapiJob("MS450", "FS_LOESCHEN", "", "");
  }
  ITEM(4, "Helper")
  {
    do_read();
  }
  ITEM(5, "")
  {
    setmenu(m_sub);
  }
  ITEM(10, "Back")
  {
    INPAapiJob("MS450", "DIAGNOSE_ENDE", "", "");
    exit();
  }
  ITEM(20, "Print")
  {
    printscreen();
  }
}

MENU m_sub()
{
  ITEM(1, "Sub key")
  {
    INPAapiJob("MS450", "STATUS_LESEN", "", "");
  }
}

do_read()
{
  INPAapiJob("MS450", "IDENT", "", "");
}

SCREEN s_main()
{
  settitle("Main screen");
  LINE("", "")
  {
    ftextout("hello", 1, 1, 0, 0, 0);
  }
}

SCREEN s_ident()
{
  settitle("Identification");
  LINE("Ident", "ID_SW_NR")
  {
    INPAapiJob("MS450", "IDENT", "", "");
    INPAapiResultText(1, "ID_SW_NR", 1, "");
  }
}

SCREEN s_fs()
{
  settitle("Faults");
  LINE("", "")
  {
    INPAapiJob("MS450", "FS_LESEN_DETAIL", "", "");
  }
}
`;

/** The header the source includes: one prototype, as INPA.H declares them. */
const HEADER = 'extern setmenutitle(in: string title);\n';

// the source in one directory and its header in another, so that a compile
// without -I is missing the header and one with it is not
const dir = mkdtempSync(join(tmpdir(), 'bmweb-ipo-'));
const inc = join(dir, 'inc');
mkdirSync(inc);
writeFileSync(join(dir, 'PROBE.IPS'), SOURCE, 'latin1');
writeFileSync(join(inc, 'Probe.H'), HEADER, 'latin1');
after(() => rmSync(dir, { recursive: true, force: true }));

/** The source compiled with its header supplied in memory. */
function compiled() {
  const R = loadRuntime();
  const r = R.ipofCompileSource(SOURCE, {
    name: 'PROBE',
    files: { 'probe.h': HEADER },
  });
  assert.ok(r.ok && r.exec, `compile: ${JSON.stringify(r.errors)}`);
  return r.exec;
}

test('keyName: the shifted bank starts at 11', () => {
  assert.equal(keyName(1), 'F1');
  assert.equal(keyName(10), 'F10');
  assert.equal(keyName(11), 'Shift+F1');
  assert.equal(keyName(20), 'Shift+F10');
});

test('describeScript: entry, root menu and screen, counts, includes', () => {
  // the includes are the caller's: a compiled source's exec carries none
  const info = describeScript(
    compiled(),
    'compiled from source',
    loadRuntime(),
    ['PROBE.H']
  );
  assert.equal(info.entry, 'inpainit');
  assert.equal(info.rootMenu, 'm_main');
  assert.equal(info.rootScreen, 's_main');
  assert.equal(info.screens, 3);
  assert.deepEqual(
    info.menus.map((m) => m.name),
    ['m_main', 'm_sub']
  );
  assert.deepEqual(info.includes, ['PROBE.H']);
  assert.match(info.form, /diagnostic script/);
});

test('describeMenu: title, backdrop, and what every key does', () => {
  const R = loadRuntime();
  const m = describeMenu(compiled(), 'm_main', R);
  assert.equal(m.title, 'Main');
  assert.equal(m.screen, 's_main', 'the screen inpainit sets before setmenu');
  const by = new Map(m.keys.map((k) => [k.key, k]));

  const f1 = by.get('F1');
  assert.ok(f1);
  assert.equal(f1.screen, 's_ident');
  assert.equal(f1.screenTitle, 'Identification');
  assert.deepEqual(f1.ownJobs, []);
  assert.deepEqual(f1.screenJobs, ['IDENT'], "the screen's own LINE job");
  assert.deepEqual(f1.writes, []);

  const f2 = by.get('F2');
  assert.ok(f2);
  assert.deepEqual(
    f2.jobs,
    ['FS_LESEN', 'FS_LESEN_DETAIL'],
    'own job, then the screen'
  );
  assert.equal(f2.frequent, true, 'setscreen(s_fs, 1) is cyclic');
  assert.deepEqual(f2.writes, []);

  const f3 = by.get('F3');
  assert.ok(f3);
  assert.deepEqual(f3.jobs, ['FS_LOESCHEN']);
  assert.deepEqual(f3.writes, ['FS_LOESCHEN'], 'a clear is confirmed');

  const f4 = by.get('F4');
  assert.ok(f4);
  assert.deepEqual(f4.jobs, ['IDENT'], 'the job a helper function sends');

  const f5 = by.get('F5');
  assert.ok(f5);
  assert.equal(f5.hidden, true);
  assert.equal(f5.submenu, 'm_sub');

  const f10 = by.get('F10');
  assert.ok(f10);
  assert.deepEqual(f10.jobs, ['DIAGNOSE_ENDE']);
  assert.deepEqual(f10.writes, [], 'session plumbing is not a write');
  assert.deepEqual(f10.actions, ['exit']);

  const print = by.get('Shift+F10');
  assert.ok(print);
  assert.deepEqual(print.actions, ['printscreen']);
});

test('readScript compiles a source with headers from -I, and names a missing one', () => {
  // without the header directory: a clear error that names the include
  assert.throws(
    () => readScript(join(dir, 'PROBE.IPS'), []),
    (e: unknown) =>
      e instanceof CliError &&
      /PROBE\.H/.test(e.message) &&
      /-I/.test(e.message)
  );
  // with the -I directory: the header is matched by name whatever its case
  // (Probe.H on disk, "PROBE.H" in the source) and reported as used
  const s = readScript(join(dir, 'PROBE.IPS'), [inc]);
  assert.equal(s.stem, 'PROBE');
  assert.equal(s.source, 'compiled from source');
  assert.deepEqual(s.includes, ['PROBE.H']);
  // a header beside the script needs no -I at all
  writeFileSync(join(dir, 'probe.h'), HEADER, 'latin1');
  writeFileSync(join(dir, 'probe.h.bak'), 'not an include');
  const t = readScript(join(dir, 'PROBE.IPS'), []);
  assert.deepEqual(t.includes, ['PROBE.H']);
  rmSync(join(dir, 'probe.h'));
  // a -I directory that does not exist is an error, not silently empty
  assert.throws(
    () => readScript(join(dir, 'PROBE.IPS'), [join(dir, 'nowhere')]),
    (e: unknown) => e instanceof CliError && /nowhere/.test(e.message)
  );
});

test('readScript refuses what is neither a script nor a source', () => {
  writeFileSync(join(dir, 'notes.txt'), 'hello');
  assert.throws(() => readScript(join(dir, 'notes.txt'), []), CliError);
  assert.throws(() => readScript(join(dir, 'absent.IPO'), []), CliError);
  // a .IPO that is not one: the reader's own message, as a CliError
  writeFileSync(join(dir, 'bad.IPO'), Buffer.alloc(64));
  assert.throws(
    () => readScript(join(dir, 'bad.IPO'), []),
    (e: unknown) => e instanceof CliError && /constant pool/.test(e.message)
  );
});

test('ipo info prints the picture as text and as JSON', () => {
  const text = ipoInfo(join(dir, 'PROBE.IPS'), [inc], false).join('\n');
  assert.match(text, /Entry\s+inpainit -> m_main \/ s_main/);
  assert.match(text, /Includes\s+PROBE\.H/);
  assert.match(text, /m_main\s+"Main"\s+\(screen s_main\)/);
  assert.match(text, /F3\s+Clear faults\s+FS_LOESCHEN \[WRITE\]/);
  assert.match(text, /F5\s+\(no caption\)\s+menu m_sub/);
  assert.match(text, /Shift\+F10\s+Print\s+\(printscreen\)/);
  const json = JSON.parse(
    ipoInfo(join(dir, 'PROBE.IPS'), [inc], true).join('\n')
  );
  assert.equal(json.entry, 'inpainit');
  assert.equal(json.menus.length, 2);
});

test('ipo keys: every menu as a table, one menu on request, an unknown menu refused', () => {
  const all = ipoKeys(join(dir, 'PROBE.IPS'), [inc], undefined, false);
  assert.match(
    all[0] as string,
    /^MENU\s+KEY\s+LABEL\s+OPENS\s+JOBS\s+WRITES$/
  );
  assert.ok(all.some((l) => /^m_sub\s+F1\s+Sub key\s+STATUS_LESEN/.test(l)));
  assert.ok(
    all.some((l) => /^m_main\s+F3\s+.*\s+yes$/.test(l)),
    'the write column'
  );
  const one = ipoKeys(join(dir, 'PROBE.IPS'), [inc], 'm_sub', false);
  assert.ok(!one.some((l) => l.startsWith('m_main')));
  assert.throws(
    () => ipoKeys(join(dir, 'PROBE.IPS'), [inc], 'm_none', false),
    (e: unknown) => e instanceof CliError && /m_main, m_sub/.test(e.message)
  );
  const json = JSON.parse(
    ipoKeys(join(dir, 'PROBE.IPS'), [inc], 'm_sub', true).join('\n')
  );
  assert.equal(json[0].keys[0].jobs[0], 'STATUS_LESEN');
});

test('ipo compile writes a real .IPO, and says what it is', () => {
  const out = join(dir, 'probe.IPO');
  const lines = ipoCompile(join(dir, 'PROBE.IPS'), [inc], out);
  assert.match(
    lines[0] as string,
    /compiled 8 procedures \(2 menus, 3 screens/
  );
  assert.match(lines[1] as string, /INPA's \.IPO container/);
  // what landed is the container, not JSON: the version bytes and the magic
  // the shipped scripts carry, and it decodes back to the procs that went in
  const bytes = readFileSync(out);
  assert.equal(bytes[0], 5, 'the v5 major version byte');
  assert.equal(bytes[1], 0, 'and its minor');
  assert.equal(
    bytes.subarray(2, 15).toString('latin1'),
    'TEST-Infotext',
    'the magic every shipped script carries'
  );
  const R = loadRuntime();
  const back = R.ipofDecodeExec(new Uint8Array(bytes), 'PROBE');
  assert.ok(back.procs.inpainit, 'the entry proc survives the round trip');
  assert.equal(back.byid['menu:0'], 'm_main');
  // the default output lands beside the source, named .IPO
  ipoCompile(join(dir, 'PROBE.IPS'), [inc], undefined);
  assert.ok(readFileSync(join(dir, 'PROBE.IPO')).length > 0);
  // compile takes sources only
  assert.throws(
    () => ipoCompile(join(dir, 'bad.IPO'), [], undefined),
    CliError
  );
});

test('ipo compile --exec keeps the app exec form', () => {
  const out = join(dir, 'probe.json');
  const lines = ipoCompile(join(dir, 'PROBE.IPS'), [inc], out, true);
  assert.match(lines[1] as string, /not INPA's binary \.IPO/);
  const exec = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(exec.procs.inpainit, 'the exec has its entry proc');
  assert.equal(exec.byid['menu:0'], 'm_main');
  // and its default name is the JSON one, not the container's
  ipoCompile(join(dir, 'PROBE.IPS'), [inc], undefined, true);
  assert.ok(readFileSync(join(dir, 'PROBE.ipoexec.json')).length > 0);
});
