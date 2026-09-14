// The argument parser: every form a flag can take, and the errors a typo
// produces instead of a silent positional.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliError, helpLines, parseArgs, type FlagSpecs } from '../src/args.ts';

const SPEC: FlagSpecs = {
  json: { kind: 'bool', help: 'JSON out' },
  chassis: { kind: 'string', alias: 'c', help: 'one chassis' },
  limit: { kind: 'number', alias: 'n' },
  include: { kind: 'list', alias: 'I' },
};

test('positionals and long flags, in any order', () => {
  const r = parseArgs(['fault', '--json', 'memory', '--chassis', 'E46'], SPEC);
  assert.deepEqual(r.positional, ['fault', 'memory']);
  assert.equal(r.flags.json, true);
  assert.equal(r.flags.chassis, 'E46');
});

test('--flag=value, -x value, -xvalue and repeatable lists', () => {
  const r = parseArgs(
    ['--limit=5', '-c', 'E90', '-I', 'a', '-Ib', '--include', 'c'],
    SPEC
  );
  assert.equal(r.flags.limit, 5);
  assert.equal(r.flags.chassis, 'E90');
  assert.deepEqual(r.flags.include, ['a', 'b', 'c']);
});

test('-- ends the options, so a query may contain a dash word', () => {
  const r = parseArgs(['--json', '--', '--not-a-flag', '-x'], SPEC);
  assert.deepEqual(r.positional, ['--not-a-flag', '-x']);
  assert.equal(r.flags.json, true);
});

test('a lone dash is a positional (stdin by convention), not an option', () => {
  assert.deepEqual(parseArgs(['-'], SPEC).positional, ['-']);
});

test('errors: unknown flag, missing value, value on a bool, non-number', () => {
  assert.throws(() => parseArgs(['--chasis', 'E46'], SPEC), CliError);
  assert.throws(() => parseArgs(['-z'], SPEC), CliError);
  assert.throws(() => parseArgs(['--chassis'], SPEC), CliError);
  assert.throws(() => parseArgs(['-c'], SPEC), CliError);
  assert.throws(() => parseArgs(['--json=1'], SPEC), CliError);
  assert.throws(() => parseArgs(['--limit', 'many'], SPEC), CliError);
  assert.match(
    (() => {
      try {
        parseArgs(['--chasis'], SPEC);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })(),
    /--chasis/
  );
});

test('help lines align and show the alias and value placeholder', () => {
  const lines = helpLines(SPEC);
  assert.equal(lines.length, 4);
  assert.match(lines[0] as string, /^ {6}--json\s+JSON out$/);
  assert.match(lines[1] as string, /^ {2}-c, --chassis <value>\s+one chassis$/);
  assert.match(lines[2] as string, /-n, --limit N/);
  // the help column starts at the same offset on every line that has one
  const column = (l: string, help: string): number => l.length - help.length;
  assert.equal(
    column(lines[0] as string, 'JSON out'),
    column(lines[1] as string, 'one chassis')
  );
});
