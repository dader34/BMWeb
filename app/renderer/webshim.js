// Run the app with no server: static JSON for data, Web Serial for the bus.
//
// The macOS build answers the renderer from a local C# server. On the web
// there is nothing to answer, so this replaces the two things the server did:
//
//   GET  /api/...        -> a file in the frozen api/ tree (tools/web_export.py)
//   POST /api/.../run/X  -> our own BEST2 VM, talking to the cable over
//                           Web Serial instead of EDIABAS
//
// Loaded ONLY by the web build (scripts/build-web.sh injects the tag); the
// macOS build never sees this file and keeps using the real server.
//
// The VM is the whole reason this is possible: bestvm.js already executes a
// job against a `send(bytes) -> bytes` callback, which is exactly what a
// serial port is. Nothing here re-implements EDIABAS -- it supplies a
// transport and lets the VM do what it already does at 100% agreement with
// the engine on 3730 results.

const WEB_API_BASE = 'api';

// ---------------------------------------------------------------- transport

// K+DCAN over Web Serial. Same wire settings EdInterfaceObd uses for a USB
// cable: 115200 8N1, no flow control.
const KDCAN = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };

class WebSerialBus {
  constructor() { this.port = null; this.reader = null; this.writer = null; }

  get connected() { return !!this.port; }

  // Must be called from a user gesture -- the browser will not show the port
  // picker otherwise. app.js wires this to the "connect cable" control.
  async connect() {
    if (!('serial' in navigator)) {
      throw new Error('This browser has no Web Serial. Use Chrome or Edge '
        + '(desktop), or the macOS app.');
    }
    this.port = await navigator.serial.requestPort();
    await this.port.open(KDCAN);
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    return this.portLabel();
  }

  portLabel() {
    const i = this.port && this.port.getInfo ? this.port.getInfo() : {};
    return i.usbVendorId
      ? `USB ${i.usbVendorId.toString(16)}:${(i.usbProductId || 0).toString(16)}`
      : 'serial';
  }

  async disconnect() {
    try { if (this.reader) { await this.reader.cancel(); this.reader.releaseLock(); } } catch { /* closing */ }
    try { if (this.writer) this.writer.releaseLock(); } catch { /* closing */ }
    try { if (this.port) await this.port.close(); } catch { /* closing */ }
    this.port = this.reader = this.writer = null;
  }

  // Send one request, read one answer. The VM calls this synchronously in
  // spirit but we are async, so runJob below drives it with an await loop.
  //
  // A K-line answer ECHOES the request back first (the bus is one wire, so
  // everything sent is also heard). EdInterfaceObd drops exactly as many
  // bytes as it wrote; do the same rather than pattern-matching, because a
  // request and its answer can legitimately share a prefix.
  async exchange(out, timeoutMs = 2000) {
    await this.writer.write(new Uint8Array(out));
    const want = out.length;
    const buf = [];
    const deadline = Date.now() + timeoutMs;
    // echo first
    while (buf.length < want && Date.now() < deadline) {
      const { value, done } = await this.readSome(deadline);
      if (done) break;
      if (value) buf.push(...value);
    }
    buf.splice(0, want);
    // then the frame: [fmt, dst, src, ...payload, checksum]
    while (Date.now() < deadline) {
      if (buf.length >= 4) {
        const len = (buf[0] & 0x3f) || buf[3];
        const total = (buf[0] & 0x3f) ? len + 4 : len + 5;
        if (buf.length >= total) return buf.slice(0, total);
      }
      const { value, done } = await this.readSome(deadline);
      if (done) break;
      if (value) buf.push(...value);
    }
    if (!buf.length) throw new Error('no answer from ECU (timeout)');
    return buf;
  }

  async readSome(deadline) {
    const ms = Math.max(1, deadline - Date.now());
    let timer;
    const timeout = new Promise((res) => {
      timer = setTimeout(() => res({ value: null, done: true }), ms);
    });
    try {
      return await Promise.race([this.reader.read(), timeout]);
    } finally { clearTimeout(timer); }
  }
}

const webBus = new WebSerialBus();

// ---------------------------------------------------------------- job runner

// Run a job the way the server's /run endpoint did, but in the VM.
async function webRunJob(sgbd, job, arg) {
  const code = await webFetchJson(`data/job-code/${sgbd.toLowerCase()}.json`);
  if (!code) throw new Error(`no job code shipped for ${sgbd}`);
  const tables = await webFetchJson(
    `data/sgbd-tables/${sgbd.toLowerCase()}.json`) || {};

  // The VM's send() is synchronous, so the exchange has to be resolved before
  // run() needs it. Jobs are request/response with a small, fixed set of
  // telegrams, so drive the VM repeatedly: each pass either completes or
  // stops at a send whose answer we do not have yet, which we then fetch and
  // memoise before trying again.
  const answers = new Map();
  for (let attempt = 0; attempt < 24; attempt++) {
    let missing = null;
    const vm = new Best2Vm(code, {
      tables,
      args: arg == null ? '' : String(arg),
      allowWrites: false,
      send: (out) => {
        const key = String(Array.from(out));
        if (answers.has(key)) return answers.get(key);
        missing = Array.from(out);
        // Unwind this pass: nothing sensible to return, and continuing would
        // decode garbage. The throw is caught below.
        throw new Error('__need_answer__');
      },
    });
    try {
      return { sets: vm.run(job, arg == null ? '' : String(arg)) };
    } catch (e) {
      if (!missing) throw e;
      answers.set(String(missing), await webBus.exchange(missing));
    }
  }
  throw new Error('job did not settle after 24 telegram exchanges');
}

// ---------------------------------------------------------------- fetch shim

async function webFetchJson(path) {
  const r = await fetch(path);
  return r.ok ? r.json().catch(() => null) : null;
}

// Map an /api/... path onto the frozen tree. Everything is a .json file, and
// job/table names are upper-cased because that is how web_export.py wrote
// them (EDIABAS job names are case-insensitive; a static host is not).
function webApiPath(path) {
  const [p] = path.split('?');
  const m = p.replace(/^\/api\//, '').split('/').filter(Boolean);
  if (!m.length) return null;
  if (m[0] === 'chassis') {
    return m.length === 1
      ? `${WEB_API_BASE}/chassis.json`
      : `${WEB_API_BASE}/chassis/${m[1].toUpperCase()}.json`;
  }
  if (m[0] === 'ecu' && m.length >= 3) {
    const sgbd = m[1].toLowerCase();
    const kind = m[2];
    if (kind === 'jobs' || kind === 'ir' || kind === 'tables') {
      return `${WEB_API_BASE}/ecu/${sgbd}/${kind}.json`;
    }
    if ((kind === 'results' || kind === 'arguments' || kind === 'table')
        && m[3]) {
      return `${WEB_API_BASE}/ecu/${sgbd}/${kind}/`
        + `${decodeURIComponent(m[3]).toUpperCase()}.json`;
    }
  }
  return null;
}

// Install over window.fetch so core.js's api() needs no change at all.
function installWebShim() {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const rel = url.replace(/^https?:\/\/[^/]+/, '');
    if (!rel.startsWith('/api/')) return real(input, init);

    const ok = (body) => new Response(JSON.stringify(body),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    const err = (msg, status = 503) => new Response(
      JSON.stringify({ error: msg }),
      { status, headers: { 'Content-Type': 'application/json' } });

    // --- endpoints the server computed, answered locally
    if (/^\/api\/health/.test(rel)) return ok({ ok: true, web: true });
    if (/^\/api\/port/.test(rel)) {
      return ok({ port: webBus.connected ? webBus.portLabel() : null });
    }
    if (/^\/api\/state/.test(rel)) {
      // battery/ignition come from a DME job; without a cable say so plainly
      return ok({ battery: null, ignition: null, connected: webBus.connected,
                  detail: webBus.connected ? null : 'no cable connected' });
    }

    // --- job execution
    const run = /^\/api\/ecu\/([^/]+)\/run\/([^/?]+)/.exec(rel);
    if (run) {
      const q = new URLSearchParams(rel.split('?')[1] || '');
      const arg = q.get('arg');
      if (q.get('demo') === '1') {
        return err('demo mode needs the macOS app: the web build has no '
          + 'value synthesiser', 501);
      }
      if (!webBus.connected) return err('no cable connected', 503);
      try {
        const r = await webRunJob(run[1], decodeURIComponent(run[2]), arg);
        return ok({ job: run[2], sets: r.sets });
      } catch (e) { return err(e.message); }
    }
    // Writes stay refused here as well as in the VM: the web build has no
    // confirmation flow, and a mis-click on a phone should not reach the bus.
    if (/^\/api\/ecu\/[^/]+\/(clear|write|flash)/.test(rel)) {
      return err('write operations are not available in the web build', 501);
    }

    // --- everything else is a static file
    const file = webApiPath(rel);
    if (!file) return err(`no static route for ${rel}`, 404);
    const res = await real(file);
    if (!res.ok) return err(`not shipped: ${file}`, 404);
    return res;
  };
}

if (typeof window !== 'undefined') {
  window.webBus = webBus;
  window.installWebShim = installWebShim;
  installWebShim();
}
