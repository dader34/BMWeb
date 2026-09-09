// The binary's front door: help, version, command resolution, exit codes,
// and the table printer every command lays its output out with.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commandHelp,
  helpText,
  main,
  resolveCommand,
  VERSION,
} from '../src/bmweb.ts';
import { formatCount, formatTable } from '../src/table.ts';

/** Run main() capturing both streams. */
async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    (l) => out.push(l),
    (l) => err.push(l)
  );
  return { code, out, err };
}

test('--version prints the baked-in version; --help lists every command', async () => {
  const v = await run(['--version']);
  assert.equal(v.code, 0);
  assert.deepEqual(v.out, [VERSION]);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  const h = await run(['--help']);
  assert.equal(h.code, 0);
  for (const c of [
    'ipo info',
    'ipo keys',
    'ipo compile',
    'search',
    'report show',
    'report diff',
  ])
    assert.ok(
      h.out.some((l) => l.includes(c)),
      `help lists ${c}`
    );
  assert.ok(h.out.some((l) => /K\+DCAN cable/.test(l)));
  assert.deepEqual((await run([])).out, helpText());
});

test('two-word and one-word commands resolve; the rest is theirs', () => {
  assert.deepEqual(resolveCommand(['ipo', 'info', 'x.IPO']), {
    name: 'ipo info',
    rest: ['x.IPO'],
  });
  assert.deepEqual(resolveCommand(['search', 'fault', 'memory']), {
    name: 'search',
    rest: ['fault', 'memory'],
  });
  assert.equal(resolveCommand(['ipo']), null);
  assert.equal(resolveCommand(['bogus']), null);
});

test('errors are one line on stderr and exit 1', async () => {
  const unknown = await run(['bogus']);
  assert.equal(unknown.code, 1);
  assert.deepEqual(unknown.out, []);
  assert.equal(unknown.err.length, 1);
  assert.match(unknown.err[0] as string, /^bmweb: unknown command "bogus"/);
  const missing = await run(['ipo', 'info']);
  assert.equal(missing.code, 1);
  assert.match(missing.err[0] as string, /^bmweb: usage: bmweb ipo info/);
  const typo = await run(['search', 'fault', '--chasis', 'E46']);
  assert.equal(typo.code, 1);
  assert.match(typo.err[0] as string, /--chasis/);
  const unreadable = await run(['ipo', 'info', '/nowhere/x.IPO']);
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.err[0] as string, /cannot read/);
});

test('a group alone lists its commands, and --help on a command shows its options', async () => {
  const group = await run(['ipo']);
  assert.equal(group.code, 1);
  assert.equal(group.out.length, 3);
  assert.ok(group.out.every((l) => l.startsWith('usage: bmweb ipo ')));
  const help = await run(['report', 'diff', '--help']);
  assert.equal(help.code, 0);
  assert.deepEqual(help.out, commandHelp('report diff'));
  assert.ok(help.out.some((l) => /--json/.test(l)));
});

test('formatTable pads every column but the last, rules under a header', () => {
  const lines = formatTable(
    [
      ['a', 'bb', 'c'],
      ['dddd', 'e', 'ffffff'],
    ],
    ['X', 'Y', 'Z'],
    '> '
  );
  assert.deepEqual(lines, [
    '> X     Y   Z',
    '> ----  --  ------',
    '> a     bb  c',
    '> dddd  e   ffffff',
  ]);
  // an undefined cell is empty and a ragged short row is fine
  assert.deepEqual(formatTable([['a', undefined, 'c'], ['b']]), [
    'a    c',
    'b',
  ]);
  assert.deepEqual(formatTable([]), []);
  assert.equal(formatCount(1234567), '1,234,567');
});
