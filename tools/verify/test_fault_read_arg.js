#!/usr/bin/env node
// The fault read's ARGUMENT. Most modules declare none and a bare FS_LESEN is
// right; some do not, and calling those bare hides real faults.
//
// E46's light switch centre (lsz_2) stores faults in EIGHT blocks and declares
// FS_LESEN(ALL_BLOCKS). Called bare it answers F_ZAHL 0 -- which the SGBD
// documents as "Gesamtfehler der Bloecke 1 bis 3 (schwere Fehler)" -- so a
// fault sitting in block 5 reads as a clean module. On a real E46 a CURRENT
// "Fernlicht rechts defekt" (3A21) was invisible exactly this way in the
// sweep, the fault screen, the tree scan and INPA's own script alike.
//
//   node tools/verify/test_fault_read_arg.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

/** the routes a fake car answers, and what each call asked for */
function load(routes) {
  const asked = [];
  const ctx = {
    console,
    setTimeout,
    Map,
    Promise,
    URL,
    encodeURIComponent,
    api: async (p) => {
      asked.push(p);
      const m = /^\/api\/ecu\/([^/]+)\/arguments\/(.+)$/.exec(p);
      if (m) {
        const k = `${m[1]}/${m[2]}`;
        if (!(k in routes)) throw new Error(`arguments/${m[2]} not found`);
        return routes[k];
      }
      if (/\/run\//.test(p)) return { sets: [{ F_HEX_CODE: '3A-21' }] };
      throw new Error(`no route ${p}`);
    },
    dataSets: (s) => s || [],
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(
      path.join(ROOT, 'app/renderer/screens/sweep/wire.js'),
      'utf8'
    ),
    ctx
  );
  return { ctx, asked };
}

(async () => {
  // ---- the module that declares one -----------------------------------
  {
    const { ctx } = load({
      'lsz_2/FS_LESEN': {
        arguments: [{ ARG: 'ALL_BLOCKS', ARGTYPE: 'string', ARGCOMMENT0: '' }],
      },
    });
    assert.strictEqual(await ctx.faultReadArg('lsz_2'), 'ALL_BLOCKS');
    ok('a declared single argument is found by name');

    // the route spells it ARG; reading `name` instead returned '' and was why
    // two earlier attempts at this fix changed nothing on the car
    const q = await ctx.faultReadQuery({ sgbd: 'lsz_2' });
    assert.strictEqual(q, '?arg=ALL_BLOCKS');
    ok('the query carries the argument');

    const qg = await ctx.faultReadQuery({ sgbd: 'lsz_2', group: 'd_00d0' });
    assert.strictEqual(qg, '?group=d_00d0&arg=ALL_BLOCKS');
    ok('the group and the argument travel together, both independent');
  }

  // ---- the ordinary module: nothing changes ----------------------------
  {
    const { ctx, asked } = load({});
    assert.strictEqual(await ctx.faultReadArg('ms450ds0'), '');
    ok('a module declaring no argument 404s and reads as none, not an error');

    assert.strictEqual(await ctx.faultReadQuery({ sgbd: 'ms450ds0' }), '');
    ok('an ungrouped module with no argument still sends a bare read');

    assert.strictEqual(
      await ctx.faultReadQuery({ sgbd: 'ms450ds0', group: 'd_0012' }),
      '?group=d_0012'
    );
    ok('the group alone is unchanged from before');
    void asked;
  }

  // ---- a read wanting values nothing can supply ------------------------
  {
    const { ctx } = load({
      'weird/FS_LESEN': { arguments: [{ ARG: 'BLOCK' }, { ARG: 'INDEX' }] },
    });
    // a half-filled argument list is worse than none: leave it bare
    assert.strictEqual(await ctx.faultReadArg('weird'), '');
    ok('a multi-argument read is left bare rather than half-asked');
  }

  // ---- the lookup is cached per module ---------------------------------
  {
    const { ctx, asked } = load({
      'lsz_2/FS_LESEN': { arguments: [{ ARG: 'ALL_BLOCKS' }] },
    });
    await ctx.faultReadArg('lsz_2');
    await ctx.faultReadArg('lsz_2');
    await ctx.faultReadQuery({ sgbd: 'lsz_2' });
    const n = asked.filter((p) => /\/arguments\//.test(p)).length;
    assert.strictEqual(n, 1, 'one lookup, however many reads');
    ok('the declaration is fetched once per module, not once per read');
  }

  // ---- readFaults itself sends it --------------------------------------
  {
    const { ctx, asked } = load({
      'lsz_2/FS_LESEN': { arguments: [{ ARG: 'ALL_BLOCKS' }] },
    });
    await ctx.readFaults('lsz_2');
    const run = asked.find((p) => /\/run\//.test(p));
    assert.strictEqual(
      run,
      '/api/ecu/lsz_2/run/FS_LESEN?arg=ALL_BLOCKS',
      'the sweep sends the argument'
    );
    ok('the sweep reads all eight blocks, not just the severe three');
  }

  console.log(`fault-read argument: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
