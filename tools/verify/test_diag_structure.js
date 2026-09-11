#!/usr/bin/env node
// The diagnosis-structure extract's contract, checked against a committed
// fixture rather than against the 18 GB of databases it was cut from.
//
// What a wrong answer here would cost is not a crash. The extractor's two
// failure modes are both SILENT: a document labelled with the wrong short
// code sends a reader to a wiring diagram expecting a pin table, and a body
// invented for a document ISTA does not hold in English reads as content
// until someone trusts it on a car. So the fixture carries eight REAL
// documents -- one of every section shape the corpus has, plus an SVG
// wiring diagram and a document whose only paragraph is empty -- together
// with the parse the extractor produced for each, and this test asserts the
// parses are what a reader would need them to be.
//
// The tree half is checked for the property the emitted `n` exists to carry:
// a node's document count is its own documents plus everything below it, so
// a branch that says 0 really is empty and one that says 4 has four to find.
//
//   node tools/verify/test_diag_structure.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'ista', 'diag_structure.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

const byId = new Map(fixture.documents.map((d) => [d.id, d]));
const doc = (id) => {
  const d = byId.get(id);
  assert.ok(d, `fixture has document ${id}`);
  return d;
};

// every block's text, in order, so a check can ask what a reader would see
const textOf = (body) =>
  body.sections
    .flatMap((s) => [s.heading, ...s.blocks.map((b) => b.s || '')])
    .filter(Boolean);

const tablesOf = (body) =>
  body.sections.flatMap((s) => s.blocks.filter((b) => b.t === 'table'));

// ---- the short codes -------------------------------------------------------
// The type is the short code a workshop reads, derived from NODECLASS. It is
// the label on every row of every tree, so a wrong one is wrong everywhere.
{
  const expected = {
    2000004537299: 'PIB',
    2000004607508: 'EBO',
    2000005051335: 'SSP',
    2000004663902: 'FUB',
    2000013169167: 'SIT',
    2000004402750: 'STA',
    2000004660759: 'FUB',
    2000033383546: 'FUB',
  };
  for (const [id, code] of Object.entries(expected)) {
    assert.strictEqual(
      doc(Number(id)).type,
      code,
      `document ${id} is a ${code}`
    );
  }
  ok('every document carries its short code');

  // a code is never the raw class, and never blank -- an unmapped class is
  // supposed to surface as C<class>, which is visibly unknown
  for (const d of fixture.documents) {
    assert.ok(/^[A-Z]{3}$|^C\d+$/.test(d.type), `${d.id} type is a code`);
  }
  ok('codes are three letters, or a marked unknown');
}

// ---- what gets a body, and what must not -----------------------------------
{
  // an SVG wiring diagram is not prose. Shipping a body for it -- any body --
  // would claim ISTA holds text it does not.
  const svg = doc(2000005051335);
  assert.ok(svg.xml.startsWith('<svg'), 'the SSP fixture really is an SVG');
  assert.strictEqual(svg.body, null, 'an SVG wiring diagram ships no body');
  ok('SSP ships no body');

  // a document whose only paragraph is empty has nothing to show. An empty
  // {sections: []} would render as a blank page that looks like a bug; no
  // body at all is the honest answer, and the row still lists in the tree.
  const empty = doc(2000033383546);
  assert.ok(
    empty.xml.includes('<PARAGRAPH/>'),
    'the empty fixture really is empty'
  );
  assert.strictEqual(empty.body, null, 'a document with no text ships no body');
  ok('a text-free document ships no body');

  // every other fixture document parsed, and no parse is ever an empty shell
  for (const d of fixture.documents) {
    if (!d.body) continue;
    assert.ok(d.body.sections.length > 0, `${d.id} has sections`);
    for (const s of d.body.sections) {
      assert.ok(s.blocks.length > 0, `${d.id} section has blocks`);
    }
  }
  ok('no parsed body is an empty shell');
}

// ---- the pin table, the one a wrong read makes dangerous --------------------
// PINASSIGNMENTS splits one pin's six columns across alternating PINROW1 and
// PINROW2 elements. Read naively that is two rows per pin, each half blank;
// read positionally it slides a "Connection" into the "Signal type" column.
// Either way a mechanic back-probes the wrong wire.
{
  const body = doc(2000004537299).body;
  assert.strictEqual(body.kind, 'PINASSIGNMENTS', 'it is a pin document');
  const tables = tablesOf(body);
  assert.strictEqual(tables.length, 2, 'a plug overview and a pin table');
  ok('pin document has both tables');

  const [plugs, pins] = tables;
  assert.deepStrictEqual(
    plugs.rows[0],
    ['Number', 'X-pin, colour', 'Description'],
    'the plug table keeps its head row'
  );
  ok('plug overview head row');

  assert.deepStrictEqual(
    pins.rows[0],
    [
      'Pin',
      'Type',
      'Description /',
      'Signal type',
      'Connection /',
      'Measuring notes',
    ],
    'the pin table keeps all six columns'
  );
  ok('pin table head row is six columns');

  // every row is six wide: a continuation that started its own row would be
  // short, and a positional read would be short too
  for (const row of pins.rows) {
    assert.strictEqual(row.length, 6, `row ${row[0]} is six columns`);
  }
  ok('every pin row is six columns wide');

  // the pins are 1..N with no repeats -- the PINROW2 merge proved, since a
  // failed merge shows each pin number once and a blank row after it
  const numbers = pins.rows.slice(1).map((r) => r[0]);
  assert.ok(numbers.length > 4, 'there are pins to check');
  assert.strictEqual(
    new Set(numbers).size,
    numbers.length,
    'no pin appears twice'
  );
  assert.ok(
    numbers.every((n) => n !== ''),
    'no row has a blank pin number'
  );
  ok('PINROW2 merged onto its PINROW1');

  // and the columns line up. Pin 1 of the ABS/ASC unit is the front left
  // wheel speed signal, and its CONNECTION is the sensor -- if the columns
  // were taken positionally that sensor would land in "Signal type", which
  // is the blank column the source omits.
  const one = pins.rows.find((r) => r[0] === '1');
  assert.strictEqual(one[1], 'A', 'pin 1 is an output');
  assert.strictEqual(
    one[2],
    'Signal Wheel speed sensor, front left',
    'pin 1 keeps its description'
  );
  assert.strictEqual(one[3], '', 'the omitted signal-type column stays empty');
  assert.strictEqual(
    one[4],
    'Front left speed sensor',
    'and the connection did not slide left into it'
  );
  ok('pin columns are read by name, not by position');

  // a pin with no type still holds its place rather than shifting its row
  const unused = pins.rows.find((r) => r[2] === 'Not used');
  assert.ok(unused, 'the unused pin is listed');
  assert.strictEqual(unused[1], '', 'an unused pin has no type');
  ok('an unused pin keeps its columns');
}

// ---- the installation location's legend ------------------------------------
// LEGENDTABLE is what turns "S119, X18093" into two named parts. Flattened to
// prose it becomes an unreadable run of codes.
{
  const body = doc(2000004607508).body;
  assert.strictEqual(body.kind, 'INSTALLATIONLOCATION', 'it is a location');
  const tables = tablesOf(body);
  assert.strictEqual(tables.length, 1, 'the legend is one table');
  for (const row of tables[0].rows) {
    assert.strictEqual(row.length, 2, 'a legend row is name and explanation');
    assert.ok(row[0] && row[1], 'neither legend column is blank');
  }
  ok('the legend is a real two-column table');

  // the figure is referenced, not resolved: the picture pool is another
  // extract's, and a name is honest where a stream id would be invented
  const pics = body.sections.flatMap((s) =>
    s.blocks.filter((b) => b.t === 'pic')
  );
  assert.strictEqual(pics.length, 1, 'the figure is noted');
  assert.ok(/\.png$/i.test(pics[0].s), 'a picture block carries a file name');
  ok('figures are referenced by name');
}

// ---- the prose shapes ------------------------------------------------------
{
  // FUNCTIONALDESCRIPTION: intro, then chapters, then their subsections --
  // each with the heading that tells a reader which system is being described
  const fd = doc(2000004660759).body;
  assert.strictEqual(fd.kind, 'FUNCTIONALDESCRIPTION', 'it is a description');
  assert.strictEqual(
    fd.title,
    "Passenger's airbag deactivation",
    'the title comes from DOCUMENTTITLE'
  );
  assert.ok(fd.sections.length >= 3, 'intro plus chapters');
  assert.strictEqual(fd.sections[0].heading, '', 'the intro is unheaded');
  assert.ok(
    fd.sections.slice(1).every((s) => s.heading),
    'every chapter is headed'
  );
  ok('functional description keeps its chapter headings');

  // inline markup must not truncate a sentence: itertext, not .text
  const withEmphasis = textOf(fd).find((t) => t.includes('front passeng'));
  assert.ok(withEmphasis, 'the emphasised sentence survived');
  assert.ok(
    withEmphasis.length > 40,
    'and was not cut off at the inline element'
  );
  ok('inline markup does not truncate text');

  // bullets stay bullets: the three-item dash list under the airbag switch
  const bullets = fd.sections.flatMap((s) =>
    s.blocks.filter((b) => b.t === 'bullet')
  );
  assert.ok(bullets.length >= 3, 'the dash list came through as bullets');
  ok('lists are bullets, not run-together prose');

  // HELPINFORMATION: SUBSECTION1 runs, each its own headed section
  const help = doc(2000004663902).body;
  assert.strictEqual(help.kind, 'HELPINFORMATION', 'it is help information');
  assert.ok(
    help.sections.every((s) => s.heading),
    'every help section is headed'
  );
  assert.ok(
    help.sections.some((s) => /fault causes/i.test(s.heading)),
    'the causes section is there'
  );
  ok('help information keeps its subsection headings');

  // SERVICEDOCUMENT: the title is the bulletin's subject, not the empty
  // page HEADLINE the layout element carries
  const sit = doc(2000013169167).body;
  assert.strictEqual(sit.kind, 'SERVICEDOCUMENT', 'it is a service document');
  assert.strictEqual(
    sit.title,
    'PMA control unit cannot be programmed',
    'the title is TOPIC/SUBJECT'
  );
  assert.ok(
    textOf(sit).some((t) => /Complaint/.test(t)),
    'the bulletin body came through'
  );
  ok('service document title and body');

  // PLUGIMAGE is a picture and a caption; it must still round-trip
  const sta = doc(2000004402750).body;
  assert.strictEqual(sta.kind, 'PLUGIMAGE', 'it is a plug image');
  assert.ok(
    sta.sections[0].blocks.some((b) => b.t === 'pic'),
    'the plug figure is noted'
  );
  ok('plug image round-trips');
}

// ---- the tree's counts -----------------------------------------------------
// `n` is what a reader trusts when deciding whether to open a branch. It must
// be own-documents plus everything below, at every level -- a node that
// counted only its own would make a populated branch look empty.
{
  const tree = fixture.trees['component-slice'];

  const recount = (node) =>
    (node.docs ? node.docs.length : 0) +
    node.kids.reduce((sum, k) => sum + recount(k), 0);

  const check = (node) => {
    assert.strictEqual(
      node.n,
      recount(node),
      `${node.label} counts its whole subtree`
    );
    node.kids.forEach(check);
  };
  check(tree);
  ok('n is the subtree document total at every level');

  // the shape every node keeps, so a renderer never has to guess
  const shape = (node) => {
    assert.strictEqual(typeof node.id, 'number', 'a node has a numeric id');
    assert.strictEqual(typeof node.label, 'string', 'a node has a label');
    assert.ok(Array.isArray(node.kids), 'a node has a kids array');
    assert.strictEqual(typeof node.n, 'number', 'a node has a count');
    // `docs` is present only when there are some: an empty array on every
    // leaf would be bytes shipped to say nothing
    if ('docs' in node) {
      assert.ok(node.docs.length > 0, `${node.label} docs is never empty`);
      for (const d of node.docs) {
        assert.strictEqual(typeof d.id, 'number', 'a doc has an id');
        assert.strictEqual(typeof d.title, 'string', 'a doc has a title');
        assert.ok(/^[A-Z]{3}$|^C\d+$/.test(d.type), 'a doc has a code');
      }
    }
    node.kids.forEach(shape);
  };
  shape(tree);
  ok('every node keeps the emitted shape');

  // a branch whose only content is two levels down still reports it, which
  // is the whole reason the count recurses
  const deep = tree.kids.find((k) => k.label === 'Empty group');
  assert.strictEqual(deep.n, 1, 'a grouping node reports its grandchild');
  assert.strictEqual(deep.docs, undefined, 'and carries no documents itself');
  ok('a grouping node reports what is below it');
}

// ---- the branch decision ---------------------------------------------------
// This is the one thing about the extract that is a claim about a CAR: which
// platform branch E46's structures come from. It is decided by the branch's
// own validity rule, never by matching its title, because no branch is
// titled E46.
{
  const b = fixture.branches;
  assert.strictEqual(b.chassis, 'E46', 'the fixture is E46');

  assert.deepStrictEqual(
    b.component.map((x) => x.label),
    ['BMW01'],
    'E46 component structure is BMW01'
  );
  ok('component branch is BMW01');

  assert.deepStrictEqual(
    b.function.map((x) => x.label),
    ['BMW01', 'Non-electrical diagnosis'],
    'E46 function net is BMW01 plus the brand-wide branch'
  );
  ok('function branch is BMW01 and Non-electrical diagnosis');

  // every branch kept for E46 was DECIDED, not merely not-excluded. An
  // `unsure` branch riding along beside a decoded one would mean the answer
  // was widened by a rule nobody can read.
  for (const side of ['component', 'function']) {
    for (const branch of b[side]) {
      assert.strictEqual(branch.rule, 'decoded', `${branch.label} decoded`);
      assert.strictEqual(branch.unsure, false, `${branch.label} is not unsure`);
    }
  }
  ok('every kept branch was decided by a decoded rule');

  // and no branch named for another chassis came along
  const labels = [...b.component, ...b.function].map((x) => x.label);
  for (const wrong of ['E38', 'E39', 'PL2', 'PL6', 'MINI', 'Motorcycle']) {
    assert.ok(!labels.includes(wrong), `${wrong} is not an E46 branch`);
  }
  ok('no other platform branch leaked in');
}

console.log(`test_diag_structure: ${passed} checks passed`);
