/**
 * @file The wire path's clock: a sleep that keeps time in a background tab.
 *
 * Run the app with no server: static JSON for data, Web Serial for the bus.
 * The core/webshim/ folder replaces the two things the C# server did:
 *   GET  /api/...        -> a frozen file in api/ (tools/web_export.py)
 *   POST /api/.../run/X  -> the BEST2 VM (bestvm.js), talking to the cable
 * The VM already runs a job against a `send(bytes)->bytes` callback, which is
 * exactly a serial port; the shim only supplies the transport (framing,
 * checksums, port settings). Loaded by every build; the C# hosts now only
 * move bytes. Pieces, in load order:
 *   timers.js            this file -- bmwSleep
 *   trace.js             busTrace (ifh.trc) and apiTrace (api.trc)
 *   framing.js           concepts, checksums, frame lengths, port settings
 *   exchange.js          one request/answer with echo, pacing and retry
 *   transport-base.js    the Transport contract and the shared serial base
 *   native-bus.js        the macOS shell's serial bridge
 *   web-serial-bus.js    Web Serial, with the K-line wake and DTR handling
 *   bus.js               the one bus instance and the bus lock
 *   data-fetch.js        JSON / gzip data loaders
 *   job-runner.js        EDIABAS sessions and webRunJob
 *   variant-resolver.js  group -> variant over the live bus
 *   coding.js            the confirmed coding write entry
 *   api-router.js        the fetch shim that answers /api/* locally
 *   install.js           window exports and the bus-lock installation
 */
/* exported bmwSleep */

/**
 * Sleep `ms` milliseconds on a clock the browser does not throttle.
 *
 * TIMERS THAT KEEP TIME IN A BACKGROUND TAB. The browser throttles a hidden
 * page's setTimeout to one wake per second (and further after minutes). The K-line
 * exchange holds DTR for the telegram's byte time (a few ms), paces reads in
 * single-digit ms and enforces a 25 ms regeneration gap -- each of which
 * became a full second when the owner's tab was not in front, so a remote
 * helper saw every job take ~1 s while the same tab in front took 150 ms. A
 * dedicated worker's timers are not throttled that way: the bus's waits run
 * there. Falls back to setTimeout where workers are unavailable (node, a
 * blocked blob URL) so nothing else changes.
 *
 * Takes the wait in milliseconds (anything non-numeric or negative is 0)
 * and resolves once it has elapsed.
 *
 * @type {(ms: number) => Promise<void>}
 */
const bmwSleep = (() => {
  let worker = null;
  let seq = 0;
  const waits = new Map();
  try {
    if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
      const src =
        'onmessage=(e)=>{const{id,ms}=e.data;setTimeout(()=>postMessage(id),ms)}';
      worker = new Worker(
        URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
      );
      worker.onmessage = (e) => {
        const r = waits.get(e.data);
        if (r) {
          waits.delete(e.data);
          r();
        }
      };
      worker.onerror = () => {
        worker = null;
        for (const r of waits.values()) r();
        waits.clear();
      };
    }
  } catch {
    worker = null;
  }
  return (ms) =>
    new Promise((r) => {
      const t = Math.max(0, Number(ms) || 0);
      if (!worker) return setTimeout(r, t);
      const id = ++seq;
      waits.set(id, r);
      worker.postMessage({ id, ms: t });
    });
})();
