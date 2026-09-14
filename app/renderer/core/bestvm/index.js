/**
 * @file The VM's public surface. Loaded two ways: as the last of the
 * bestvm/ <script> tags in the app (publishes the globals other files
 * call) and via require() in the verify suite (module.exports). Both must
 * work from this one file.
 *
 * Load order, which index.html and the node requires below both follow:
 *   write-guard.js  isWriteJob, the classifier the guard rests on
 *   codec.js        Best2Codec, text/number/wire-parameter encodings
 *   machine.js      Best2Vm, VmError, the run loop and result publishing
 *   registers.js    the register file            (extends the prototype)
 *   operands.js     operand addressing modes      (extends the prototype)
 *   environment.js  arguments, pool, tables       (extends the prototype)
 *   executor.js     the opcode `step` switch      (extends the prototype)
 */

if (typeof require === 'function' && typeof module !== 'undefined') {
  Object.assign(
    globalThis,
    require('./write-guard.js'),
    require('./codec.js'),
    require('./machine.js'),
    require('./registers.js'),
    require('./operands.js'),
    require('./environment.js'),
    require('./executor.js')
  );
}

if (typeof window !== 'undefined') {
  window.Best2Vm = Best2Vm;
  window.VmError = VmError;
  window.isWriteJob = isWriteJob;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Best2Vm,
    VmError,
    Best2Codec,
    STOP,
    JUMP_TESTS,
    REG_BYTES,
    isWriteJob,
    // the classifier's parts, exported for tests and tooling
    READ_TOKEN,
    CONFIG_READ_TOKEN,
    WRITE_TOKEN,
    INFO_READ_TOKEN,
  };
}
