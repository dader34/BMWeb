// A pane of the Workspace (or a popped-out window) drives the SHELL's cable:
// core/webshim/bus.js adopts the shell's bus instance and delegates every
// lock function to it, and never wraps the shell's bus a second time. A
// document that is nobody's pane keeps its own bus and lock, and a parent
// that is not ours (cross-origin, which throws on touch) counts as none.
//
// Run: node tools/verify/test_workspace_bus.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    '..',
    'app',
    'renderer',
    'core',
    'webshim',
    'bus.js'
  ),
  'utf8'
);

/** bus.js evaluated against a given `window`. */
function load(win) {
  const ctx = {
    window: win,
    console,
    NativeSerialBus: class NativeSerialBus {},
    WebSerialBus: class WebSerialBus {
      async connect() {}
      async disconnect() {}
      async exchange(out) {
        return [out.length];
      }
      async readState() {
        return {};
      }
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    src +
      '\n;__out = { webBus, withBusLock, lockBus, webClaimBus, webBusClaimedBy, webBusRawExchange, webBusOnDisconnect };',
    ctx
  );
  return ctx.__out;
}

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok    ${name}`);
};

(async () => {
  // ---- a document on its own: its own bus, its own queue -------------------
  const own = load({});
  assert.strictEqual(own.webBus.constructor.name, 'WebSerialBus');
  const order = [];
  await Promise.all([
    own.withBusLock(async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 5));
      order.push('a2');
    }),
    own.withBusLock(() => order.push('b')),
  ]);
  assert.deepStrictEqual(order, ['a1', 'a2', 'b']);
  ok('no shell: own WebSerialBus, exchanges queue one after another');

  // ---- a pane: the shell's bus, the shell's lock ------------------------------
  const calls = [];
  const shellBus = { shell: true };
  const shell = {
    webBus: shellBus,
    withBusLock: (fn) => {
      calls.push('lock');
      return Promise.resolve().then(fn);
    },
    webClaimBus: async (owner) => {
      calls.push(`claim:${owner}`);
      return { exchange: () => {}, release: () => {} };
    },
    webBusClaimedBy: () => 'the shell',
    webBusRawExchange: (out) => {
      calls.push('raw');
      return Promise.resolve([out.length]);
    },
    webBusOnDisconnect: () => calls.push('hook'),
  };
  const win = { parent: shell };
  const pane = load(win);
  assert.strictEqual(pane.webBus, shellBus);
  ok("pane: webBus IS the shell's instance");
  assert.strictEqual(await pane.withBusLock(() => 7), 7);
  assert(calls.includes('lock'));
  ok("pane: withBusLock runs on the shell's queue");
  pane.lockBus(shellBus, () => {});
  assert(calls.includes('hook'));
  assert.strictEqual(shellBus.exchange, undefined);
  ok(
    'pane: lockBus registers the forget hook with the shell and wraps nothing'
  );
  await pane.webClaimBus('WebKFP');
  assert(calls.includes('claim:WebKFP'));
  assert.strictEqual(pane.webBusClaimedBy(), 'the shell');
  assert.deepStrictEqual(await pane.webBusRawExchange([1, 2, 3], {}), [3]);
  ok('pane: claim, claimed-by and the raw exchange all go to the shell');

  // ---- a popped-out window: the opener is the shell -----------------------------
  const popped = load({ opener: shell });
  assert.strictEqual(popped.webBus, shellBus);
  ok("popped-out window: the opener's bus");

  // ---- a parent that is not ours -----------------------------------------------
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('cross-origin');
      },
    }
  );
  const framed = load({ parent: hostile });
  assert.strictEqual(framed.webBus.constructor.name, 'WebSerialBus');
  ok('a foreign parent (throws on touch) is no shell: own bus');

  // ---- the shell side: a pane's hook runs on disconnect ---------------------
  const shellSide = load({});
  const forgot = [];
  const bus = shellSide.webBus;
  shellSide.lockBus(bus, () => forgot.push('shell'));
  shellSide.webBusOnDisconnect(() => forgot.push('pane'));
  shellSide.webBusOnDisconnect(() => {
    throw new Error('a pane that has gone');
  });
  await bus.disconnect();
  assert.deepStrictEqual(forgot, ['shell', 'pane']);
  ok(
    "shell: disconnect forgets its own car and every pane's, a dead pane aside"
  );

  console.log(`${passed} checks passed`);
})().catch((e) => {
  console.log(`FAILED: ${e.stack || e}`);
  process.exit(1);
});
