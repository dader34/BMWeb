#!/usr/bin/env node
// The repair section's pure helpers: the data layer's filters and search,
// the generic browser's tree walk, and the document renderer.
//
// Nothing here touches a DOM or the network. What it guards is the
// behaviour a reader would notice going wrong:
//   - picking a group lists EVERY document under it, subgroups included
//   - a search scope that is off does not match
//   - a torque figure always carries its unit
//   - a deep link finds the document it names
//   - the browser's tree walk is data-shaped, so the other ISTA structures
//     can reuse it

'use strict';
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const fs = require('fs');

let passed = 0;
/**
 * Note one passing check.
 * @param {string} what - what held
 * @returns {void}
 */
function ok(what) {
  passed++;
  console.log(`  ok  ${what}`);
}

// the renderer files are classic scripts: they are loaded into one context
// the way the browser loads them, so a missing global here is a missing
// global in the app too
const ROOT = path.join(__dirname, '..', '..', 'app', 'renderer');
const ctx = {
  window: {},
  module: undefined,
  console,
  /**
   * The app's HTML escaper, the one the renderer uses.
   * @param {*} s - the value to escape
   * @returns {string}
   */
  esc: (s) =>
    String(s === undefined || s === null ? '' : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c]
    ),
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of [
  'screens/repair/data.js',
  'screens/repair/render.js',
  'screens/repair/browser.js',
]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, {
    filename: f,
  });
}

// a chassis index shaped exactly as repair_extract.py writes one
const IDX = {
  version: 1,
  chassis: 'E46',
  tree: [
    {
      id: '11',
      name: 'Engine',
      n: 3,
      subs: [
        { id: '21', name: 'Crankshaft with bearing', n: 2 },
        { id: '31', name: 'Valve timing gear', n: 1 },
      ],
    },
    {
      id: '34',
      name: 'Brakes',
      n: 1,
      subs: [{ id: '11', name: 'Front Wheel Brakes', n: 1 }],
    },
  ],
  docs: [
    {
      id: 1,
      type: 'REP',
      title: 'Removing and installing crankshaft',
      g: '11',
      s: '21',
      job: '500',
      shard: '11',
    },
    {
      id: 2,
      type: 'REP',
      title: 'Replacing crankshaft bearing shells',
      g: '11',
      s: '21',
      job: '510',
      shard: '11',
    },
    {
      id: 3,
      type: 'AZD',
      title: 'Overview of tightening torques',
      g: '11',
      s: '31',
      job: '001',
      shard: '11',
      unsure: true,
    },
    {
      id: 4,
      type: 'REP',
      title: 'Replacing front brake pads',
      g: '34',
      s: '11',
      job: '050',
      shard: '34',
    },
  ],
};

// ---- the group tree and the document lists ---------------------------------
{
  const tree = ctx.repairGroupTree(IDX);
  assert.strictEqual(
    Array.from(tree, (g) => g.id).join(','),
    '11,34',
    'groups come back in number order'
  );
  ok('the group tree is in number order');

  // THE BEHAVIOUR THAT MAKES THE TREE A TREE: a main group lists what is
  // under it, not only what is filed directly on it
  const whole = ctx.repairDocsUnder(IDX, ['11']);
  assert.strictEqual(whole.length, 3, 'group 11 lists all three of its docs');
  const one = ctx.repairDocsUnder(IDX, ['11', '21']);
  assert.strictEqual(one.length, 2, 'subgroup 1121 lists only its two');
  assert.strictEqual(Array.from(one, (d) => d.id).join(','), '1,2');
  assert.strictEqual(ctx.repairDocsUnder(IDX, null).length, 0);
  ok('a node lists every document beneath it');

  // sorted by job number, so a manual reads in the order it was written
  assert.strictEqual(
    Array.from(whole, (d) => d.job).join(','),
    '001,500,510',
    'documents sort by job number'
  );
  ok('documents sort by job number');
}

// ---- the browser's node shape ----------------------------------------------
{
  const tree = ctx.repairBrowserTree(IDX);
  assert.strictEqual(tree.length, 2);
  assert.strictEqual(tree[0].num, '11');
  assert.strictEqual(tree[0].label, 'Engine');
  // ISTA cites a subgroup with its group in front: 11 + 21 reads "1121"
  assert.strictEqual(tree[0].kids[0].num, '1121');
  ok('the group tree translates to browser nodes');

  const flat = ctx.browserFlatten(tree);
  assert.strictEqual(flat.length, 5, 'two groups and three subgroups');
  assert.strictEqual(flat[1].path.join('/'), '11/21');
  assert.strictEqual(flat[1].depth, 1);
  ok('the tree walk yields every node with its path');

  assert.strictEqual(
    ctx.browserNodeAt(tree, ['11', '31']).label,
    'Valve timing gear'
  );
  assert.strictEqual(ctx.browserNodeAt(tree, ['99']), null);
  assert.strictEqual(ctx.browserNodeAt(tree, null), null);
  ok('a path resolves to its node');

  // the breadcrumb is the whole path: "1121" means nothing without "Engine"
  assert.strictEqual(
    ctx.browserCrumb(tree, ['11', '21'], 'none'),
    '11 Engine / 1121 Crankshaft with bearing'
  );
  assert.strictEqual(ctx.browserCrumb(tree, ['11'], 'none'), '11 Engine');
  assert.strictEqual(
    ctx.browserCrumb(tree, null, 'Product structure'),
    'Product structure'
  );
  ok("the pane title is the selected node's breadcrumb");
}

// ---- search ----------------------------------------------------------------
{
  const all = { structures: true, title: true, number: true };
  // both crankshaft titles, and doc 1 and 2 also sit in the subgroup named
  // "Crankshaft with bearing" -- the same two, so the count stays two
  assert.strictEqual(ctx.repairSearch(IDX, 'crankshaft', all).length, 2);
  // every term must match, so two words narrow rather than widen
  assert.strictEqual(
    ctx.repairSearch(IDX, 'crankshaft bearing', all).length,
    2
  );
  ok('every search term has to match');

  // a scope that is off does not match. "Valve timing" is ONLY a subgroup
  // name, never a title, so it finds the torque table with structures on
  // and nothing at all with it off
  const withStructures = { structures: true, title: true, number: false };
  assert.strictEqual(
    ctx.repairSearch(IDX, 'valve timing', withStructures).length,
    1
  );
  const titleOnly = { structures: false, title: true, number: false };
  assert.strictEqual(
    ctx.repairSearch(IDX, 'valve timing', titleOnly).length,
    0
  );
  const hits = ctx.repairSearch(IDX, 'crankshaft', titleOnly);
  assert.strictEqual(hits.length, 2);
  assert.ok(hits.every((d) => /crankshaft/i.test(d.title)));
  ok('an unchecked scope does not match');

  // the number scope finds a document by the number a mechanic would quote
  const numOnly = { structures: false, title: false, number: true };
  assert.strictEqual(ctx.repairSearch(IDX, '34 11 050', numOnly).length, 1);
  ok('the number scope finds a document by its number');

  assert.strictEqual(ctx.repairSearch(IDX, '', all).length, 0);
  assert.strictEqual(ctx.repairSearch(IDX, '   ', all).length, 0);
  ok('an empty query matches nothing');
}

// ---- deep links ------------------------------------------------------------
{
  assert.strictEqual(
    ctx.repairFindDoc(IDX, 3).title,
    'Overview of tightening torques'
  );
  // the route carries the id as a string; it must still resolve
  assert.strictEqual(ctx.repairFindDoc(IDX, '3').id, 3);
  assert.strictEqual(ctx.repairFindDoc(IDX, 999), null);
  ok('a deep link resolves its document by id');

  assert.strictEqual(ctx.repairDocNumber(IDX.docs[0]), '11 21 500');
  assert.strictEqual(ctx.repairDocNumber({ g: '11' }), '');
  assert.strictEqual(ctx.repairDocNumber(null), '');
  ok('the document number is the group, subgroup and job');
}

// ---- picture URLs ----------------------------------------------------------
{
  const local = ctx.repairPicUrl('E46', 2000003991933);
  assert.ok(
    local.endsWith('/data/ista/repair/E46/pics/2000003991933.webp'),
    local
  );
  const hosted = ctx.repairPicUrl('e46', 42, true);
  assert.ok(hosted.startsWith('https://huggingface.co/'), hosted);
  assert.ok(hosted.includes('/E46/pics/42.webp'), 'the chassis is upper-cased');
  ok('a picture resolves to a local and a hosted URL');
}

// ---- the document renderer -------------------------------------------------
{
  // A TORQUE FIGURE ALWAYS CARRIES ITS UNIT. This is the check that matters
  // most in this file: a number without its Nm is not a smaller piece of
  // information, it is a dangerous one.
  const html = ctx.repairTorqueHtml([
    {
      connection: 'Plug adapter to transmission',
      screws: [
        {
          thread: 'M8',
          values: [
            { value: '15', unit: 'Nm', kind: 'Jointing torque' },
            { value: '90', unit: '°', kind: 'Angle of rotation' },
          ],
        },
      ],
    },
  ]);
  assert.ok(html.includes('15 Nm'), 'the figure and its unit are one cell');
  assert.ok(html.includes('90 °'), 'so is the angle');
  assert.ok(html.includes('Jointing torque'));
  assert.ok(html.includes('Plug adapter to transmission'));
  // the thread is named once, on the first of the screw's rows
  assert.strictEqual((html.match(/M8/g) || []).length, 1);
  ok('a torque figure is drawn with its unit');

  assert.strictEqual(ctx.repairTorqueHtml([]), '');
  assert.strictEqual(ctx.repairTorqueHtml(null), '');
  ok('no torques draws nothing');
}

{
  const hint = ctx.repairHintHtml({
    kind: 'danger',
    text: ['High-voltage system.'],
  });
  assert.ok(hint.includes('rp-hint-danger'));
  // no title in the model: the kind names itself
  assert.ok(hint.includes('Danger'));
  assert.ok(hint.includes('High-voltage system.'));
  // an author's own title wins over the kind's default
  assert.ok(
    ctx
      .repairHintHtml({ kind: 'before', title: 'Necessary preliminary tasks:' })
      .includes('Necessary preliminary tasks:')
  );
  ok('a hint draws with its kind and its text');
}

{
  const body = {
    hints: [{ kind: 'warning', text: ['Support the engine.'] }],
    sections: [
      {
        phase: 'Preliminary work',
        title: 'Remove the underbody panelling',
        steps: [{ text: ['Release all bolts.'], pics: [7] }],
      },
      {
        title: 'Removing crankshaft',
        steps: [
          { text: ['Release screws (1).'] },
          { text: ['Remove crankshaft (2).'] },
        ],
      },
    ],
  };
  const html = ctx.repairDocHtml(IDX.docs[0], body, 'E46');
  assert.ok(html.includes('Removing and installing crankshaft'));
  assert.ok(html.includes('11 21 500'), 'the number leads the title');
  // the phase and the section title read as one label
  assert.ok(
    html.includes('Preliminary work -- Remove the underbody panelling')
  );
  assert.ok(html.includes('Support the engine.'));
  // steps are numbered from one WITHIN each section
  assert.strictEqual((html.match(/rp-step-n">1</g) || []).length, 2);
  assert.ok(html.includes('/E46/pics/7.webp'), 'the picture resolves');
  ok('a document draws its hints, sections, steps and pictures');

  // an unsure document says so rather than pretending it was filtered
  const flagged = ctx.repairDocHtml(IDX.docs[2], body, 'E46');
  assert.ok(flagged.includes('applicability could not be'));
  ok('an unsure document is marked');

  // a document whose shard did not load says so rather than drawing blank
  const missing = ctx.repairDocHtml(IDX.docs[0], null, 'E46');
  assert.ok(missing.includes('not in this build'));
  ok('a missing body is reported');

  // no steps at all is also reported rather than silently empty
  const empty = ctx.repairDocHtml(IDX.docs[0], { sections: [] }, 'E46');
  assert.ok(empty.includes('no steps'));
  ok('a document with no steps is reported');
}

// ---- escaping --------------------------------------------------------------
{
  // document titles come from BMW's data, not from a user, but they do
  // contain quotes and angle brackets, and a title must never become markup
  const html = ctx.repairDocHtml(
    { id: 9, type: 'REP', title: 'Bleed <clutch> "system"', g: '21', s: '52' },
    { sections: [{ steps: [{ text: ['a & b'] }] }] },
    'E46'
  );
  assert.ok(!html.includes('<clutch>'), 'the title is escaped');
  assert.ok(html.includes('&lt;clutch&gt;'));
  assert.ok(html.includes('a &amp; b'));
  ok('titles and step text are escaped');
}

// ---- the Type/Title table --------------------------------------------------
{
  const src = {
    /**
     * The Type column.
     * @param {object} d - a row
     * @returns {string}
     */
    rowType: (d) => d.type,
    /**
     * The Title column.
     * @param {object} d - a row
     * @returns {string}
     */
    rowTitle: (d) => d.title,
  };
  const html = ctx.browserRowsHtml(IDX.docs, src);
  assert.ok(html.includes('<th class="rp-col-type">Type</th>'));
  assert.strictEqual((html.match(/class="rp-row"/g) || []).length, 4);
  assert.ok(html.includes('Replacing front brake pads'));
  // an empty list still draws its header, so the pane keeps its shape
  const none = ctx.browserRowsHtml([], src);
  assert.ok(none.includes('Type'));
  assert.ok(!none.includes('class="rp-row"'));
  ok('the Type/Title table draws its rows and its empty state');
}

// ---- the tree's HTML -------------------------------------------------------
{
  const tree = ctx.repairBrowserTree(IDX);
  // collapsed: the roots only, each with a + expander
  let html = ctx.browserTreeHtml(tree, new Set(), null);
  assert.strictEqual((html.match(/class="rp-node[ "]/g) || []).length, 2);
  assert.ok(html.includes('>+<'), 'a collapsed node offers to expand');
  assert.ok(!html.includes('Crankshaft'), 'its children are not drawn');

  // expanded: the group's subgroups appear, indented and marked deep
  html = ctx.browserTreeHtml(tree, new Set(['11']), ['11']);
  assert.strictEqual((html.match(/class="rp-node[ "]/g) || []).length, 4);
  assert.ok(html.includes('>−<'), 'an expanded node offers to collapse');
  assert.ok(html.includes('rp-node-deep'), 'children are drawn as nested');
  assert.ok(html.includes('Crankshaft with bearing'));
  assert.ok(/class="rp-node on"/.test(html), 'the selected node is marked');
  ok('the tree expands, indents and marks its selection');

  assert.ok(ctx.browserTreeHtml([], new Set(), null).includes('Nothing in'));
  ok('an empty tree says so');
}

console.log(`test_repair: ${passed} checks passed`);
