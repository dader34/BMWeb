#!/usr/bin/env node
// The tuning screen's fault window (app/renderer/screens/tuning/live-faults.js).
//
// WHAT THIS PROVES
//   1. A read runs the DME's FS_LESEN, lists only real fault entries, and
//      keeps the summary/telegram sets out.
//   2. The CSV carries every listed fault, quoted where a name needs it,
//      with whether it is present or stored and when it was read.
//   3. Clear asks first; cancelled, nothing is sent; confirmed, FS_LOESCHEN
//      is run and the memory is read again.
//   4. A live scan reads again on its timer, but not while an edit is
//      waiting, the DME is out of reach, or the window is closed.
//   5. A failed read says so and leaves the last list alone.
//
// Run: node tools/verify/test_livetune_faults.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function world() {
  const calls = [];
  const timers = [];
  const dme = {
    faults: [
      {
        F_ORT_NR: '10100',
        F_ORT_TEXT: 'A',
        F_HEX_CODE: '27-74',
        present: true,
      },
      {
        F_ORT_NR: '10201',
        F_ORT_TEXT: 'B',
        F_HEX_CODE: '27-D9',
        present: false,
      },
    ],
    fail: false,
  };
  const el = () => ({
    disabled: false,
    textContent: '',
    className: '',
    innerHTML: '',
    checked: false,
    hidden: false,
  });
  const win = { hidden: false, querySelector: () => el() };
  const ctx = {
    console,
    Date,
    Promise,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: function (parts) {
      this.text = parts.join('');
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length,
    clearTimeout: () => {},
    document: { hidden: false },
    window: { innerWidth: 1400 },
    esc: (x) => String(x),
    confirm: { answer: true },
    confirmDialog: async () => ctx.confirm.answer,
    tnLive: {
      armed: true,
      lt: {},
      link: 'up',
      busy: false,
      pumping: false,
      pending: new Map(),
    },
    api: async (route) => {
      calls.push(route);
      if (dme.fail) throw new Error('no answer from ECU (timeout)');
      if (/FS_LOESCHEN/.test(route)) {
        dme.faults = [];
        return { sets: [{ JOB_STATUS: 'OKAY' }] };
      }
      return { sets: [...dme.faults, { JOB_STATUS: 'OKAY' }] }; // the job's summary set rides along
    },
    dataSets: (sets) => sets,
    faultFields: (c) => ({
      code: c.F_HEX_CODE.replace('-', ''),
      pcode: '',
      name: c.F_ORT_TEXT === 'A' ? 'Misfire, cylinder 1' : 'Sensor "B", signal',
      present: c.present,
      ftype: c.present ? 'static' : 'intermittent',
      count: 3,
    }),
  };
  vm.createContext(ctx);
  // the cursor file carries the "is an edit on the wire" test the scan asks
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, '../../app/renderer/screens/tuning/live-cursor.js'),
      'utf8'
    ) +
      fs.readFileSync(
        path.join(
          __dirname,
          '../../app/renderer/screens/tuning/live-faults.js'
        ),
        'utf8'
      ) +
      '\nthis.f = tnFaults; this.read = tnFaultsRead; this.clear = tnFaultsClear; this.csv = tnFaultsCsv; this.schedule = tnFaultsSchedule; this.build = tnFaultsBuild;',
    ctx,
    { filename: 'live-faults.js' }
  );
  ctx.build(() => win);
  return { ctx, f: ctx.f, calls, timers, dme, win };
}

let n = 0;
async function test(name, fn) {
  await fn();
  n++;
  console.log(`ok ${n} - ${name}`);
}

(async () => {
  await test('a read lists the faults and nothing else', async () => {
    const w = world();
    await w.ctx.read();
    assert.deepStrictEqual(w.calls, ['/api/ecu/ms450ds0/run/FS_LESEN']);
    assert.deepStrictEqual(
      w.f.rows.map((r) => r.code),
      ['2774', '27D9']
    );
    assert.ok(w.f.readAt instanceof Date);
    assert.ok(/2 faults/.test(w.f.els.status.textContent));
    assert.ok(/Misfire, cylinder 1/.test(w.f.els.list.innerHTML));
    assert.strictEqual(w.f.els.csv.disabled, false);
  });

  await test('the CSV carries what is listed', async () => {
    const w = world();
    await w.ctx.read();
    const lines = w.ctx.csv().trim().split('\n');
    assert.strictEqual(lines[0], 'code,p_code,fault,status,type,count,read_at');
    assert.strictEqual(lines.length, 3);
    assert.ok(
      lines[1].startsWith('2774,,"Misfire, cylinder 1",present,static,3,')
    );
    assert.ok(
      lines[2].startsWith('27D9,,"Sensor ""B"", signal",stored,intermittent,3,')
    );
    assert.ok(lines[1].endsWith(w.f.readAt.toISOString()));
  });

  await test('clear asks first, then clears and reads again', async () => {
    const w = world();
    await w.ctx.read();
    w.ctx.confirm.answer = false;
    await w.ctx.clear();
    assert.strictEqual(w.calls.length, 1, 'cancelled: nothing sent');
    w.ctx.confirm.answer = true;
    await w.ctx.clear();
    assert.deepStrictEqual(w.calls.slice(1), [
      '/api/ecu/ms450ds0/run/FS_LOESCHEN',
      '/api/ecu/ms450ds0/run/FS_LESEN',
    ]);
    assert.deepStrictEqual(w.f.rows, []);
    assert.ok(/No faults stored/.test(w.f.els.list.innerHTML));
  });

  await test('a live scan takes its turn, and stands back for an edit', async () => {
    const w = world();
    w.f.scan = true;
    w.ctx.schedule();
    assert.strictEqual(w.timers[0].ms, 4000);
    await w.timers[0].fn();
    assert.strictEqual(w.calls.length, 1);
    assert.strictEqual(w.timers.length, 2, 'and queues the next');
    w.ctx.tnLive.pending.set(1, {});
    await w.timers[1].fn();
    assert.strictEqual(w.calls.length, 1, 'an edit is waiting: no read');
    w.ctx.tnLive.pending.clear();
    w.ctx.tnLive.link = 'lost';
    await w.timers[2].fn();
    assert.strictEqual(w.calls.length, 1, 'the DME is out of reach: no read');
    w.ctx.tnLive.link = 'up';
    w.win.hidden = true;
    const before = w.timers.length;
    w.ctx.schedule();
    assert.strictEqual(
      w.timers.length,
      before,
      'window closed: the scan stops'
    );
  });

  await test('a failed read says so and keeps the last list', async () => {
    const w = world();
    await w.ctx.read();
    w.dme.fail = true;
    await w.ctx.read();
    assert.strictEqual(w.f.rows.length, 2);
    assert.ok(/no answer/.test(w.f.els.status.textContent));
    assert.ok(/err/.test(w.f.els.status.className));
  });

  console.log(`\n${n} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
