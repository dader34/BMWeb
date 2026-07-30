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

// Read one answer off the K line. Shared by both transports, because the
// protocol does not change with the plumbing.
//
// The K line is HALF DUPLEX: one wire, so everything written is also heard
// back. Drop exactly as many bytes as were sent rather than pattern-matching
// the echo -- a request and its answer can legitimately share a prefix, and
// EdInterfaceObd drops by count for the same reason.
//
// Then the frame: BMW-FAST is [0x80|len, dst, src, ...payload, checksum]
// where the low 6 bits of byte 0 give the payload length; a zero there means
// the length moved to byte 3 (the long form).
async function readFrame(echoLen, timeoutMs, pump) {
  const buf = [];
  const deadline = Date.now() + timeoutMs;
  while (buf.length < echoLen && Date.now() < deadline) {
    const got = await pump();
    if (got && got.length) buf.push(...got);
    else await new Promise((r) => setTimeout(r, 4));
  }
  buf.splice(0, echoLen);
  while (Date.now() < deadline) {
    if (buf.length >= 4) {
      const short = buf[0] & 0x3f;
      const total = short ? short + 4 : buf[3] + 5;
      if (buf.length >= total) return buf.slice(0, total);
    }
    const got = await pump();
    if (got && got.length) buf.push(...got);
    else await new Promise((r) => setTimeout(r, 4));
  }
  if (!buf.length) throw new Error('no answer from ECU (timeout)');
  return buf;
}

// The same bus, over the native bridge. A WKWebView has no Web Serial -- that
// is a Chrome API, and the macOS app is a Cocoa window around WebKit -- so the
// shell owns the port and moves bytes for us (SerialProxy.cs). The framing,
// checksums and echo handling stay here, identical to the Web Serial path;
// only the four primitives differ.
class NativeSerialBus {
  constructor() { this.path = null; }

  get connected() { return !!this.path; }

  async connect() {
    const r = await window.bmacw.serialOpen(null, KDCAN.baudRate);
    this.path = (r && r.port) || 'serial';
    return this.portLabel();
  }

  portLabel() { return (this.path || '').replace('/dev/', ''); }

  async disconnect() {
    try { await window.bmacw.serialClose(); } catch { /* already closed */ }
    this.path = null;
  }

  async exchange(out, timeoutMs = 2000) {
    // A stale partial frame from a timed-out job would be read as this job's
    // answer, so start clean.
    await window.bmacw.serialFlush();
    await window.bmacw.serialWrite(out);
    return readFrame(out.length, timeoutMs,
      async () => window.bmacw.serialRead());
  }
}

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
    const deadline = Date.now() + timeoutMs;
    return readFrame(out.length, timeoutMs, async () => {
      const { value, done } = await this.readSome(deadline);
      return done ? null : value;
    });
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

// Whichever transport this host can actually do. The native bridge wins when
// present: inside the macOS app there is no Web Serial to fall back to, and
// outside it there is no bridge.
const webBus = (typeof window !== 'undefined'
                && window.bmacw && window.bmacw.serialOpen)
  ? new NativeSerialBus() : new WebSerialBus();

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

// WHERE THIS PAGE LIVES. GitHub Pages serves a project site from a subpath
// (/BMacW/), not the domain root, so "/api/chassis" would resolve to
// dader34.github.io/api/chassis -- off the site entirely. Derive the base
// from the document's own URL and hang every static path off it. Empty at a
// domain root and inside the macOS app, so both behave exactly as before.
const WEB_BASE = (typeof location !== 'undefined'
  ? location.pathname.replace(/\/[^/]*$/, '') : '').replace(/\/$/, '');

// Cache of chassis configs and their ECU zip buffers.
// Format: chassisId -> { config: Object, ecuZips: Map(sgbd -> ArrayBuffer) }
const CHASSIS_CACHE = new Map();

// Cache of parsed ECU files.
// Format: sgbd -> Map(filename -> content)
const ECU_CACHE = new Map();

async function loadChassis(chassisId, realFetch) {
  const upperId = chassisId.toUpperCase();
  if (CHASSIS_CACHE.has(upperId)) return CHASSIS_CACHE.get(upperId);

  const fileUrl = `${WEB_BASE}/api/chassis/${upperId}.chassis`;
  const res = await realFetch(fileUrl);
  if (!res.ok) throw new Error(`Failed to load chassis ${upperId}: ${res.statusText}`);

  const buffer = await res.arrayBuffer();
  if (typeof fflate === 'undefined') {
    throw new Error('fflate decompression library not loaded');
  }
  const unzipped = fflate.unzipSync(new Uint8Array(buffer));

  const configBytes = unzipped['config.json'];
  if (!configBytes) throw new Error(`Missing config.json in chassis ${upperId}`);

  const configText = new TextDecoder('utf-8').decode(configBytes);
  const config = JSON.parse(configText);

  const ecuZips = new Map();
  for (const [name, bytes] of Object.entries(unzipped)) {
    if (name.startsWith('ecu/') && name.endsWith('.ecu')) {
      const sgbd = name.slice(4, -4).toLowerCase();
      ecuZips.set(sgbd, bytes);
    }
  }

  const data = { config, ecuZips };
  CHASSIS_CACHE.set(upperId, data);
  return data;
}

async function loadEcu(sgbd, realFetch) {
  const lowerSgbd = sgbd.toLowerCase();
  if (ECU_CACHE.has(lowerSgbd)) return ECU_CACHE.get(lowerSgbd);

  // Search cached chassis first
  let ecuZipBytes = null;
  for (const chassisData of CHASSIS_CACHE.values()) {
    if (chassisData.ecuZips.has(lowerSgbd)) {
      ecuZipBytes = chassisData.ecuZips.get(lowerSgbd);
      break;
    }
  }

  // Fallback: fetch directly
  if (!ecuZipBytes) {
    const fileUrl = `${WEB_BASE}/api/ecu/${lowerSgbd}.ecu`;
    const res = await realFetch(fileUrl);
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      ecuZipBytes = new Uint8Array(buffer);
    }
  }

  if (!ecuZipBytes) {
    throw new Error(`ECU archive not found for ${lowerSgbd}`);
  }

  if (typeof fflate === 'undefined') {
    throw new Error('fflate decompression library not loaded');
  }
  const unzipped = fflate.unzipSync(ecuZipBytes);
  const ecuFiles = new Map();
  const decoder = new TextDecoder('utf-8');

  for (const [name, bytes] of Object.entries(unzipped)) {
    try {
      const text = decoder.decode(bytes);
      const parsed = JSON.parse(text);
      ecuFiles.set(name, parsed);
    } catch (e) {
      ecuFiles.set(name, decoder.decode(bytes));
    }
  }

  ECU_CACHE.set(lowerSgbd, ecuFiles);
  return ecuFiles;
}

// Install over window.fetch so core.js's api() needs no change at all.
function installWebShim() {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let rel = url.replace(/^https?:\/\/[^/]+/, '');
    
    // Normalize path relative to WEB_BASE
    if (WEB_BASE && rel.startsWith(WEB_BASE)) {
      rel = rel.slice(WEB_BASE.length);
    }
    if (!rel.startsWith('/')) rel = '/' + rel;

    const ok = (body) => new Response(JSON.stringify(body),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    const err = (msg, status = 503) => new Response(
      JSON.stringify({ error: msg }),
      { status, headers: { 'Content-Type': 'application/json' } });

    // --- VM bytecode / sgbd-tables files interception (from cached ECUs)
    if (rel.startsWith('/data/job-code/') && rel !== '/data/job-code/index.json') {
      const sgbd = rel.split('?')[0].split('/').pop()
        .replace(/\.json$/, '').toLowerCase();
      try {
        const ecu = await loadEcu(sgbd, real);
        const code = ecu.get('job-code.json');
        if (!code) return err(`Job code not found for ${sgbd}`, 404);
        return ok(code);
      } catch (e) {
        return err(e.message, 404);
      }
    }

    if (rel.startsWith('/data/sgbd-tables/')) {
      const sgbd = rel.split('?')[0].split('/').pop()
        .replace(/\.json$/, '').toLowerCase();
      try {
        const ecu = await loadEcu(sgbd, real);
        const tables = ecu.get('sgbd-tables.json');
        if (!tables) return err(`SGBD tables not found for ${sgbd}`, 404);
        return ok(tables);
      } catch (e) {
        return err(e.message, 404);
      }
    }

    // Only route to API if prefix matches /api/
    if (!rel.startsWith('/api/')) return real(input, init);

    // --- endpoints the server computed, answered locally
    if (/^\/api\/health/.test(rel)) return ok({ ok: true, web: true });
    if (/^\/api\/port/.test(rel)) {
      return ok({ port: webBus.connected ? webBus.portLabel() : null });
    }
    if (/^\/api\/state/.test(rel)) {
      return ok({ battery: null, ignition: null, connected: webBus.connected,
                  detail: webBus.connected ? null : 'no cable connected' });
    }

    // --- job execution
    const run = /^\/api\/ecu\/([^/]+)\/run\/([^/?]+)/.exec(rel);
    if (run) {
      const q = new URLSearchParams(rel.split('?')[1] || '');
      const arg = q.get('arg');
      if (q.get('demo') === '1' && typeof webDemoSets === 'function') {
        const sgbd = run[1].toLowerCase();
        try {
          const ecu = await loadEcu(sgbd, real);
          const meta = ecu.get('meta.json');
          if (!meta) return err(`Metadata not found for ${sgbd}`, 404);
          return ok({ job: run[2], demo: true,
                      sets: webDemoSets(meta, decodeURIComponent(run[2]), arg) });
        } catch (e) {
          return err(e.message, 404);
        }
      }
      if (!webBus.connected) return err('no cable connected', 503);
      try {
        const r = await webRunJob(run[1], decodeURIComponent(run[2]), arg);
        return ok({ job: run[2], sets: r.sets });
      } catch (e) { return err(e.message); }
    }
    if (/^\/api\/ecu\/[^/]+\/(clear|write|flash)/.test(rel)) {
      return err('write operations are not available in the web build', 501);
    }

    // --- everything else is a static file route (served from the zip archives)
    //
    // SPLIT THE PATH, NOT THE QUERY. ecu.js asks for "/api/ecu/msv80/ir?code=
    // MSV80" so the server can match a layout by INPA code, and splitting the
    // whole string leaves the last segment as "ir?code=MSV80", which matches
    // no kind. Every ECU then fell through to "no screen definition" while its
    // archive sat there holding 161 screens.
    const m = rel.split('?')[0].replace(/^\/api\//, '').split('/').filter(Boolean);
    if (!m.length) return err('not found', 404);

    if (m[0] === 'chassis') {
      if (m.length === 1) {
        // The LIST, not the directory. Passing the bare /api/chassis through
        // asks the host for a path that is now a directory of .chassis
        // archives, and a static server answers with an index page -- 200,
        // text/html, and the renderer parses it as the chassis list. Name the
        // file explicitly.
        return real(`${WEB_BASE}/${WEB_API_BASE}/chassis.json`, init);
      } else {
        const cid = m[1];
        try {
          const data = await loadChassis(cid, real);
          return ok(data.config);
        } catch (e) {
          return err(e.message, 404);
        }
      }
    }

    if (m[0] === 'ecu' && m.length >= 3) {
      const sgbd = m[1].toLowerCase();
      const kind = m[2];
      try {
        const ecu = await loadEcu(sgbd, real);
        if (kind === 'jobs' || kind === 'ir' || kind === 'tables') {
          const res = ecu.get(`${kind}.json`);
          if (!res) {
            if (kind === 'jobs') return ok([]);
            return err(`${kind} not found for ${sgbd}`, 404);
          }
          return ok(res);
        }
        if ((kind === 'results' || kind === 'arguments' || kind === 'table') && m[3]) {
          const subName = decodeURIComponent(m[3]).toUpperCase();
          const res = ecu.get(`${kind}/${subName}.json`);
          if (!res) return err(`${kind}/${subName} not found for ${sgbd}`, 404);
          return ok(res);
        }
      } catch (e) {
        if (kind === 'jobs') return ok([]);
        return err(e.message, 404);
      }
    }

    return err(`no static route for ${rel}`, 404);
  };
}

if (typeof window !== 'undefined') {
  window.webBus = webBus;
  window.installWebShim = installWebShim;
  installWebShim();
}
