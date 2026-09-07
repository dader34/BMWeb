/**
 * @file The one bus instance this host drives, and the lock that serialises
 * everything that touches it.
 */
/* exported webBus, withBusLock, webBusRawExchange, lockBus */

/**
 * Which transport this host can do: the native serial bridge when the macOS
 * shell injects one, else Web Serial. Both drive the same K+DCAN cable.
 * @type {NativeSerialBus|WebSerialBus}
 */
const webBus =
  typeof window !== 'undefined' && window.bmacw && window.bmacw.serialOpen
    ? new NativeSerialBus()
    : new WebSerialBus();

/**
 * The tail of the bus queue: every locked call chains onto it.
 * @type {Promise<void>}
 */
let busChain = Promise.resolve();

/**
 * ONE EXCHANGE AT A TIME, BUS-WIDE. The K-line is half duplex: two
 * concurrent callers interleave writes and steal each other's answers -- the
 * 3-second topbar state poll was clobbering any job that took longer than a
 * second. The old C# engine held a bus lock server-side; the VM migration
 * lost it. Every entry point that can touch the wire queues here.
 * @template T
 * @param {() => Promise<T>|T} fn - The wire operation to run once the bus is free.
 * @returns {Promise<T>} Its result, settled when it has finished.
 */
function withBusLock(fn) {
  const run = busChain.then(fn, fn);
  busChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * The bus's exchange BEFORE the lock wrapped it -- set by lockBus.
 * @type {((out: ArrayLike<number>, comm: CommParams) => Promise<number[]>)|null}
 */
let busRawExchange = null;

/**
 * The raw exchange, unwrapped from the bus lock, for a caller that ALREADY
 * holds the lock and must not queue behind itself: webWriteCoding runs a
 * whole sequence inside one lock, and going through the locked
 * webBus.exchange again would deadlock (the sequence's next exchange waits on
 * a chain the sequence itself is blocking).
 * @param {ArrayLike<number>} out - The request without its checksum.
 * @param {CommParams} comm - Its wire parameters.
 * @returns {Promise<number[]>} The answer frame.
 * @throws {Error} When lockBus has not run yet.
 */
function webBusRawExchange(out, comm) {
  if (!busRawExchange) throw new Error('bus not initialised');
  return busRawExchange(out, comm);
}

/**
 * Wrap the bus's wire entry points (connect, exchange, readState,
 * disconnect) in the bus lock, and run `onDisconnect` before the wire drops.
 *
 * A session must not outlive the cable: dropping the bus without clearing it
 * would leave the next connection thinking INITIALISIERUNG had already run,
 * and reuse shared data from a car that may not even be the same one. ENDE
 * is skipped deliberately -- the wire is already going away.
 * @param {NativeSerialBus|WebSerialBus} bus - The transport to wrap in place.
 * @param {() => void} onDisconnect - Forgets everything known about the car.
 */
function lockBus(bus, onDisconnect) {
  const raw = {
    disconnect: bus.disconnect.bind(bus),
    exchange: bus.exchange.bind(bus),
    connect: bus.connect.bind(bus),
    readState: bus.readState ? bus.readState.bind(bus) : null,
  };
  bus.disconnect = async (...a) => {
    onDisconnect();
    return withBusLock(() => raw.disconnect(...a));
  };
  bus.exchange = (...a) => withBusLock(() => raw.exchange(...a));
  // The unlocked exchange, for a caller that ALREADY holds the bus lock and
  // must not queue behind itself. Kept so coding-write reaches the same raw
  // wire reads do.
  busRawExchange = (...a) => raw.exchange(...a);
  bus.connect = (...a) => withBusLock(() => raw.connect(...a));
  if (raw.readState) {
    bus.readState = (...a) => withBusLock(() => raw.readState(...a));
  }
}
