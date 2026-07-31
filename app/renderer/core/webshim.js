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

// The THOR WiFi adapter: a Deep-OBD-style custom adapter (EdiabasLib's
// DEEPOBDWIFI protocol) behind an ESP-Link WiFi bridge at 192.168.4.1:23.
// NOT an ELM327: it carries BMW-FAST-framed telegrams, which is exactly what
// the VM sends -- but a browser has no TCP, so tools/thor_bridge.js relays a
// local WebSocket to the adapter. Telegram framing and meaning stay here.
//
// The F1 -> F1 "special" telegrams are answered by the adapter MCU itself
// (ident, ignition sense, battery voltage off the OBD pin), so connecting
// and the topbar indicators work against ANY car. Wrapping job telegrams for
// the K-line/D-CAN side is BMW-specific and still to come.
const THOR_BRIDGE = 'ws://127.0.0.1:8124';
const THOR_HOST = '192.168.4.1';
const THOR_PORT = 23;

class ThorWifiBus {
  constructor() {
    this.ws = null;
    this.native = false;                             // shell-owned TCP socket
    this.fw = null;                                  // { type, version }
    this.state = { battery: null, ignition: null };  // last ident readings
    this.rx = [];
  }

  get connected() {
    return this.native || (!!this.ws && this.ws.readyState === 1);
  }

  async connect() {
    if (window.bmacw && window.bmacw.tcpOpen) {
      // the macOS shell opens the socket itself: no relay, no node
      await window.bmacw.tcpOpen(THOR_HOST, THOR_PORT);
      this.native = true;
    } else {
      const ws = new WebSocket(THOR_BRIDGE);
      ws.binaryType = 'arraybuffer';
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = () => rej(new Error(
          'THOR bridge is not running. Start it with: node thor_bridge.js'));
      });
      ws.onmessage = (e) => this.rx.push(...new Uint8Array(e.data));
      ws.onclose = () => { this.ws = null; };
      this.ws = ws;
    }
    // prove there is an adapter behind the socket, not just a socket
    const fw = await this.special(0xFD, 9);
    this.fw = { type: (fw[4] << 8) | fw[5], version: (fw[6] << 8) | fw[7] };
    await this.readState();
    return this.portLabel();
  }

  portLabel() {
    const v = this.fw ? ` v${this.fw.version >> 8}.${this.fw.version & 0xff}` : '';
    return `THOR${v}`;
  }

  async disconnect() {
    if (this.native) {
      try { await window.bmacw.tcpClose(); } catch { /* already gone */ }
      this.native = false;
    }
    try { if (this.ws) this.ws.close(); } catch { /* already gone */ }
    this.ws = null;
  }

  // One special telegram: 82 F1 F1 <cmd> <cmd> <sum8>. The adapter echoes
  // the request, then appends its answer (respLen bytes, sum8 last). Over
  // the WebSocket, bytes arrive via onmessage; over the native socket, poll
  // the shell (same shape as NativeSerialBus, and the timeout policy stays
  // here either way).
  async special(cmd, respLen, timeoutMs = 2000) {
    const req = [0x82, 0xF1, 0xF1, cmd, cmd];
    req.push(req.reduce((a, b) => (a + b) & 0xff, 0));
    if (this.native) await window.bmacw.tcpRead();  // drop anything stale
    this.rx.length = 0;
    if (this.native) await window.bmacw.tcpWrite(req);
    else this.ws.send(new Uint8Array(req));
    const want = req.length + respLen;
    const deadline = Date.now() + timeoutMs;
    while (this.rx.length < want && Date.now() < deadline) {
      if (this.native) {
        const got = await window.bmacw.tcpRead();
        if (got && got.length) { this.rx.push(...got); continue; }
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    if (this.rx.length < want) throw new Error('THOR adapter did not answer');
    const resp = this.rx.slice(req.length, want);
    const sum = resp.slice(0, -1).reduce((a, b) => (a + b) & 0xff, 0);
    if (sum !== resp[resp.length - 1]) throw new Error('THOR answer checksum bad');
    return resp;
  }

  // ignition sense + battery voltage, read from the adapter (no car protocol
  // involved). Feeds /api/state, so the topbar KL30/KL15 indicators are real.
  async readState() {
    const ign = await this.special(0xFE, 6);
    this.state.ignition = (ign[4] & 0x01) !== 0;
    if (this.fw && this.fw.type >= 2) {
      const v = await this.special(0xFC, 6);
      this.state.battery = v[4] / 10;
    }
    return this.state;
  }

  async exchange() {
    throw new Error('Jobs over the THOR adapter are not wired up yet: the '
      + 'K-line/D-CAN telegram wrapping is BMW-specific and waits for the '
      + 'BMW to be back from the shop.');
  }
}

// Whichever transport this host can actually do. THOR is an explicit choice
// (?thor=1 or the Adapter setting) and works in both hosts: shell-owned TCP
// inside the macOS app, the local WebSocket relay in a browser. Otherwise
// the native serial bridge wins when present: inside the macOS app there is
// no Web Serial to fall back to, and outside it there is no bridge.
const wantThor = (() => {
  if (typeof location !== 'undefined' && /[?&]thor\b/.test(location.search)) return true;
  try {
    // localStorage over the injected copy: it is written synchronously the
    // moment the setting changes, while the shell's injected settings are
    // one reload behind when the page reloads right after a change.
    const s = { ...(window.__bmacwSettings || {}),
                ...JSON.parse(localStorage.getItem('bmacw.settings') || '{}') };
    return s.adapter === 'thor';
  } catch { return false; }
})();
const webBus = wantThor ? new ThorWifiBus()
  : (typeof window !== 'undefined' && window.bmacw && window.bmacw.serialOpen)
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

  // AN OFFLINE COPY HAS NO SERVER. A file:// page gets an opaque origin
  // where fetch() is blocked, so the offline export inlines each archive as
  // base64 in a <script> instead -- which file:// loads happily. Use that
  // when it is there, and only reach for the network otherwise.
  if (typeof BMACW_INLINE === 'object' && BMACW_INLINE
      && BMACW_INLINE[upperId]) {
    const bin = atob(BMACW_INLINE[upperId]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return cacheChassis(upperId, bytes);
  }

  const fileUrl = `${WEB_BASE}/api/chassis/${upperId}.chassis`;
  const res = await realFetch(fileUrl);
  if (!res.ok) throw new Error(`Failed to load chassis ${upperId}: ${res.statusText}`);

  const buffer = await res.arrayBuffer();
  return cacheChassis(upperId, new Uint8Array(buffer));
}

// Unpack one .chassis and remember it. Shared by the inline and network
// paths, which differ only in where the bytes came from.
function cacheChassis(upperId, bytes) {
  if (typeof fflate === 'undefined') {
    throw new Error('fflate decompression library not loaded');
  }
  const unzipped = fflate.unzipSync(bytes);

  const configBytes = unzipped['config.json'];
  if (!configBytes) throw new Error(`Missing config.json in chassis ${upperId}`);
  const config = JSON.parse(new TextDecoder('utf-8').decode(configBytes));

  const ecuZips = new Map();
  for (const [name, b] of Object.entries(unzipped)) {
    if (name.startsWith('ecu/') && name.endsWith('.ecu')) {
      ecuZips.set(name.slice(4, -4).toLowerCase(), b);
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

  // Not in a chassis we have open yet. ECUs ship only inside their chassis
  // archive -- loose copies duplicated all 310 for 47 MB and nothing read
  // them -- so find the car that owns this SGBD and load that. Costs one
  // chassis download, after which every ECU in the same car is already here.
  if (!ecuZipBytes) {
    const idx = (typeof BMACW_INLINE === 'object' && BMACW_INLINE
                 && BMACW_INLINE._index)
      ? BMACW_INLINE._index
      : await (await realFetch(
          `${WEB_BASE}/${WEB_API_BASE}/ecu-index.json`)).json().catch(() => null);
    const cid = idx && idx[lowerSgbd];
    if (cid) {
      const data = await loadChassis(cid, realFetch);
      ecuZipBytes = data.ecuZips.get(lowerSgbd) || null;
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
  // Anything that needs the FILE rather than the shim's answer (the offline
  // exporter zips the archives themselves) asks for this.
  window.webRealFetch = real;
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
      // the THOR adapter senses ignition and battery itself; ask it
      if (webBus.connected && webBus.readState) {
        try {
          const st = await webBus.readState();
          return ok({ battery: st.battery, ignition: st.ignition,
                      connected: true, detail: null });
        } catch { /* adapter went away; report disconnected below */ }
      }
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
        if (typeof BMACW_INLINE === 'object' && BMACW_INLINE) {
          return ok(Object.keys(BMACW_INLINE).filter((k) => k !== '_index'));
        }
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
