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
const vm = require('vm');

const FIXTURE = path.join(__dirname, 'fixtures', 'ista', 'diag_structure.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// the renderer half, loaded the way the page loads it: classic scripts in
// the order index.html lists them, with the two globals they lean on
const ROOT = path.join(__dirname, '..', '..', 'app', 'renderer', 'screens');
const ctx = vm.createContext({
  esc: (s) =>
    String(s === null || s === undefined ? '' : s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    ),
  repairPicUrl: (pic) => `/data/ista/repair/pics/${pic}.webp`,
  module: undefined,
  console,
});
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'ista', 'trees.js'), 'utf8'),
  ctx,
  { filename: 'trees.js' }
);

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

  // the figure is resolved INTO the repair manual's pooled picture id. The
  // pool is that extract's and these documents reference it, so a block left
  // holding "B060052.png" could never be drawn: the app addresses the pool by
  // stream id. A name that does not resolve stays a string, which is how the
  // renderer tells a real figure from one this build cannot show.
  const pics = body.sections.flatMap((s) =>
    s.blocks.filter((b) => b.t === 'pic')
  );
  assert.strictEqual(pics.length, 1, 'the figure is noted');
  assert.strictEqual(typeof pics[0].s, 'number', 'and resolved to a pool id');
  ok('figures resolve to the pooled picture id');
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

// ---- the fault-pattern tree ------------------------------------------------
// The one ISTA actually draws is ONE root over nine numbered groups. The
// table it comes from holds four vocabularies at the same virtual parent, so
// the failure this guards is not a crash either: reading the wrong root, or
// reading none, emits thousands of flat roots that look like data.
{
  const tree = fixture.trees['fault-pattern'];

  assert.strictEqual(tree.label, 'Fault patterns', 'one root, and it is named');
  assert.ok(Array.isArray(tree.kids), 'the root has children');
  ok('the tree has a single named root');

  // the nine groups of the real tool, in order, with their numbers
  assert.deepStrictEqual(
    tree.kids.map((k) => k.label),
    [
      '01 Powertrain',
      '02 Display, information, communication',
      '03 Lights',
      '04 Locking systems, anti-theft system',
      '05 Chassis and suspension',
      '06 Body',
      '07 Ventilation, heating, climate control',
      '08 Safety, restraint, warning systems',
      '09 Voltage supply, bus systems',
    ],
    'the nine numbered groups, in their numbered order'
  );
  ok('the nine groups are the root’s children');

  // the motorcycle groups carry three digits and belong to another vehicle:
  // shipping them would put three more top-level branches on a car
  for (const k of tree.kids) {
    assert.ok(/^\d\d\s/.test(k.label), `${k.label} is a two-digit group`);
  }
  ok('no three-digit motorcycle group leaked in');

  // and none of the other three vocabularies' roots came along
  const labels = [];
  const collect = (n) => {
    labels.push(n.label);
    n.kids.forEach(collect);
  };
  collect(tree);
  for (const wrong of [
    'Component fault pattern',
    'Fault pattern function',
    'Standardised fault coding type of fault',
  ]) {
    assert.ok(!labels.includes(wrong), `${wrong} is a different vocabulary`);
  }
  ok('no sibling vocabulary leaked in');

  // the same count contract the structure trees keep
  const recount = (node) =>
    (node.docs ? node.docs.length : 0) +
    node.kids.reduce((sum, k) => sum + recount(k), 0);
  const check = (node) => {
    assert.strictEqual(
      node.n,
      recount(node),
      `${node.label} counts its subtree`
    );
    node.kids.forEach(check);
  };
  check(tree);
  ok('fault-pattern n is the subtree total at every level');

  // a sane size: the tree is a short vocabulary, not the whole 5,354-row
  // table, and not one root either
  const size = (n) => 1 + n.kids.reduce((a, k) => a + size(k), 0);
  const nodes = size(tree);
  assert.ok(nodes > 20 && nodes < 500, `${nodes} nodes is a tree, not a table`);
  ok('the tree is a tree-sized tree');
}

// ---- the validity gate -----------------------------------------------------
// A symptom rarely carries a rule of its own -- 72 of the 84 do not -- so the
// gate only works if a symptom with no rule INHERITS its parent's. Without
// that inheritance every node would pass and the tree would not be about the
// car at all; with it, the groups' rules scope everything filed beneath them.
{
  const s = fixture.symptoms;
  assert.strictEqual(s.groups, 9, 'nine groups were walked');
  assert.strictEqual(s.seen, 84, 'the whole subtree was visited');
  assert.strictEqual(s.kept, 82, 'and two nodes were gated out for E46');
  ok('the gate excluded what does not apply to this car');

  assert.ok(s.norule > 0, 'most symptoms carry no rule of their own');
  assert.strictEqual(s.norule, 72, '72 of the 84 inherited a parent rule');
  // the point of inheritance: had a missing rule meant "no rule", nothing
  // would ever be excluded and kept would equal seen
  assert.ok(s.kept < s.seen, 'an inherited rule can still exclude');
  ok('a symptom with no rule inherits its parent’s');
}

// ---- the body renders, and never as JSON -----------------------------------
// The bug this replaces showed a reader the raw extract. What a document body
// must become is the repair manual's own vocabulary -- its class names, its
// picture pool -- so a diagnosis document and a repair instruction read the
// same, and above all so a pin table stays a table.
{
  const pins = doc(2000004537299).body;
  const html = ctx.istaDiagBodyHtml(pins);

  assert.ok(!html.includes('{"'), 'no JSON leaked into the page');
  assert.ok(!/\bsections\b"\s*:/.test(html), 'and no model key did either');
  ok('a body never renders as JSON');

  // the pin table is a real table with its six columns intact: this is the
  // document a wrong read sends someone to back-probe the wrong wire
  assert.ok(html.includes('<table'), 'the pin table is a table');
  const headCells = (html.match(/<th>/g) || []).length;
  assert.strictEqual(headCells, 9, 'both head rows kept every column');
  assert.ok(html.includes('<th>Pin</th>'), 'the pin column is headed');
  assert.ok(
    html.includes('Signal Wheel speed sensor, front left'),
    'and a pin description survived into a cell'
  );
  ok('a pin table renders as a table with its heading');

  // every row is padded to the table's width, so the column a reader counts
  // across to is the column the source meant
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  const dataRows = rows.filter((r) => r.includes('<td>'));
  const widths = new Set(dataRows.map((r) => (r.match(/<td>/g) || []).length));
  assert.strictEqual(widths.size, 2, 'each of the two tables is rectangular');
  ok('table rows are rectangular');

  // the class names are the repair manual's, so the two pages read alike
  assert.ok(html.includes('class="rp-sec"'), 'sections are repair sections');
  assert.ok(html.includes('class="rp-doc-h"'), 'and the title is its heading');
  ok('the body wears the repair manual’s classes');
}

{
  // a figure resolves through the repair manual's pooled pictures: the
  // extract turns the SRC into the pool's stream id, which is the only form
  // repairPicUrl can address
  const loc = doc(2000004607508).body;
  const pic = loc.sections.flatMap((s) => s.blocks).find((b) => b.t === 'pic');
  assert.strictEqual(typeof pic.s, 'number', 'a resolved figure is an id');
  const html = ctx.istaDiagBodyHtml(loc);
  assert.ok(
    html.includes(`/data/ista/repair/pics/${pic.s}.webp`),
    'and it resolves through the repair pool'
  );
  ok('figures resolve through the repair manual’s pool');

  // the legend's first row is DATA, not a heading: marked head:0 by the
  // extractor, because drawing it as a heading would lose a real part
  const legend = loc.sections
    .flatMap((s) => s.blocks)
    .find((b) => b.t === 'table');
  assert.strictEqual(legend.head, 0, 'a legend table is marked headless');
  assert.ok(!html.includes('<th>'), 'so no row of it was drawn as a heading');
  assert.ok(html.includes('<td>A52</td>'), 'and the first part is still there');
  ok('a headless table keeps its first row');
}

{
  // a body that did not ship says so, rather than drawing an empty page that
  // reads as a bug or, worse, as a document with nothing in it
  const none = ctx.istaDiagBodyHtml(null);
  assert.ok(none.includes('not in this build'), 'a missing body is reported');
  assert.ok(!none.includes('undefined'), 'and says nothing about its model');
  assert.ok(
    ctx.istaDiagBodyHtml({ sections: [] }).includes('not in this build')
  );
  ok('a missing body is reported');

  // titles and cell text come from BMW's data, and must never become markup
  const html = ctx.istaDiagBodyHtml({
    title: 'Plug <X1> "A"',
    sections: [
      { heading: 'a & b', blocks: [{ t: 'table', rows: [['<td>', 'x']] }] },
    ],
  });
  assert.ok(!html.includes('<X1>'), 'the title is escaped');
  assert.ok(html.includes('&lt;X1&gt;'), 'and kept');
  assert.ok(html.includes('a &amp; b'), 'so is a heading');
  assert.ok(html.includes('&lt;td&gt;'), 'and so is a cell');
  ok('titles, headings and cells are escaped');
}

// ---- the SSP row -----------------------------------------------------------
// 10,048 of E46's documents are SVG wiring diagrams with no text body. The
// row must still LIST -- ISTA holds the diagram and a reader should see it
// exists -- and must say what it is rather than falling through to the body
// path, which is where the raw JSON used to appear.
{
  let asked = null;
  const src = ctx.istaDiagSource({ kids: [] }, (d) => {
    asked = d;
    return 'BODY';
  });

  const ssp = src.docHtml({ id: 1, type: 'SSP', title: 'A52 ABS/ASC unit' });
  assert.strictEqual(asked, null, 'an SSP never reaches the body loader');
  assert.ok(ssp.includes('wiring diagram'), 'it says what the row is');
  assert.ok(ssp.includes('not in this build'), 'and that it does not ship');
  assert.ok(!ssp.includes('{'), 'and it is not JSON');
  ok('an SSP row explains itself instead of rendering');

  // every other type still goes to the body loader
  assert.strictEqual(src.docHtml({ id: 2, type: 'PIB' }), 'BODY');
  assert.strictEqual(asked.id, 2, 'a text document still loads its body');
  ok('other types still load their bodies');

  // and the row keeps listing, with its code, so the diagram is discoverable
  assert.strictEqual(src.rowType({ type: 'SSP' }), 'SSP');
  ok('an SSP still lists with its code');
}

console.log(`test_diag_structure: ${passed} checks passed`);
