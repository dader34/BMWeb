/**
 * @file Sharing a stored scan as a link that carries the report itself.
 *
 * Nothing is stored on a server: the compact report is deflated, base64url
 * encoded and put in the URL fragment (#report/<payload>), so the link opens
 * on any copy of the app, hosted or offline, with no car and no account. The
 * VIN is left out of the payload; the car is named by its label and chassis.
 */

/* exported garageSharePayload, garageShareEncode, garageShareDecode,
   garageShareUrl, garageShareButton, showGarageSharedReport */

/** How long the Share button shows its "Copied" confirmation, ms. */
const GARAGE_COPY_FLASH_MS = 1600;

/** The payload format version, so a later reader can tell an older link. */
const GARAGE_SHARE_V = 1;

/**
 * What a shared link carries: the report and enough to caption it. The VIN
 * is deliberately absent, as it is in the beta reports.
 * @param {GarageScan} scan - the stored scan
 * @param {GarageCar} [car] - the car it belongs to, for its label
 * @returns {{v: number, kind: string, at: string, chassis: string, label: string, report: object, summary: object}}
 */
function garageSharePayload(scan, car) {
  const label =
    typeof garageCarLabel === 'function' && car
      ? garageCarLabel(car)
      : (car && car.label) || '';
  return {
    v: GARAGE_SHARE_V,
    kind: scan.kind,
    at: scan.at,
    chassis: scan.chassis || (car && car.chassis) || '',
    label,
    report: scan.report,
    summary: scan.summary,
  };
}

/**
 * Base64url of bytes (no padding, URL-safe alphabet).
 * @param {Uint8Array} bytes - the bytes
 * @returns {string}
 */
function garageB64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Bytes of a base64url string.
 * @param {string} s - the text
 * @returns {Uint8Array}
 */
function garageB64urlDecode(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Run bytes through a CompressionStream / DecompressionStream.
 * @param {Uint8Array} bytes - the input
 * @param {CompressionStream|DecompressionStream} stream - the transform
 * @returns {Promise<Uint8Array>}
 */
async function garagePipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Encode a scan as the link payload: JSON, deflate-raw, base64url. A
 * whole-car read compresses to a few KB, well inside what a browser and a
 * forum post carry in a URL.
 * @param {GarageScan} scan - the stored scan
 * @param {GarageCar} [car] - the car it belongs to
 * @returns {Promise<string>} the payload
 */
async function garageShareEncode(scan, car) {
  const json = JSON.stringify(garageSharePayload(scan, car));
  const raw = new TextEncoder().encode(json);
  const packed = await garagePipe(raw, new CompressionStream('deflate-raw'));
  return garageB64urlEncode(packed);
}

/**
 * Decode a link payload back into what garageSharePayload built.
 * @param {string} payload - the base64url text from the URL
 * @returns {Promise<object|null>} the payload object, or null when unreadable
 */
async function garageShareDecode(payload) {
  try {
    const packed = garageB64urlDecode(payload);
    const raw = await garagePipe(
      packed,
      new DecompressionStream('deflate-raw')
    );
    const obj = JSON.parse(new TextDecoder().decode(raw));
    if (!obj || typeof obj !== 'object' || !obj.report) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

/**
 * The shareable URL for a scan: this app's own address with the payload in
 * the fragment, so it opens on the hosted site or an offline copy alike.
 * @param {GarageScan} scan - the stored scan
 * @param {GarageCar} [car] - the car it belongs to
 * @param {string} [base] - the page address without a fragment (defaults to this page)
 * @returns {Promise<string>}
 */
async function garageShareUrl(scan, car, base) {
  const payload = await garageShareEncode(scan, car);
  const here =
    base != null
      ? base
      : typeof location !== 'undefined'
        ? location.href.split('#')[0]
        : '';
  return `${here}#report/${payload}`;
}

/**
 * Copy text to the clipboard, through the wiring app's helper when it is
 * loaded (async clipboard with a textarea fallback for file://).
 * @param {string} text - what to copy
 * @returns {Promise<boolean>}
 */
async function garageCopyText(text) {
  if (typeof wiringCopyText === 'function') return wiringCopyText(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * A Share button for a stored scan: copies the report link and flashes
 * "Copied", exactly like the wiring app's Share.
 * @param {GarageScan} scan - the stored scan
 * @param {GarageCar} [car] - the car it belongs to
 * @returns {HTMLButtonElement}
 */
function garageShareButton(scan, car) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn garage-share';
  btn.textContent = 'Share';
  btn.title = 'Copy a link that carries this report';
  btn.onclick = async () => {
    const url = await garageShareUrl(scan, car);
    const ok = await garageCopyText(url);
    const original = 'Share';
    btn.textContent = ok ? '✓ Copied' : 'Copy failed';
    btn.classList.toggle('copied', ok);
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, GARAGE_COPY_FLASH_MS);
  };
  return btn;
}

/**
 * A report someone sent as a link: drawn by the live view's own renderer,
 * with Save to garage so the recipient can keep it against a car of theirs.
 * @param {string} payload - the base64url payload from #report/<payload>
 * @returns {Promise<void>}
 */
async function showGarageSharedReport(payload) {
  const p = await garageShareDecode(payload);
  lastScreen = () => showGarageSharedReport(payload);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Garage', fn: showGarage },
    { label: 'Shared report' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'shared report';
  if (!p) {
    view.innerHTML = head('Garage', 'Shared report', '');
    view.appendChild(
      errorBlock(
        'This link does not carry a readable report. It may have been cut short when it was pasted.'
      )
    );
    setActions([garageBackAction(showGarage)]);
    return;
  }
  const kindText = p.kind === 'ident' ? 'Identification' : 'Fault memories';
  const who = [p.label, p.chassis && dispChassis(p.chassis)]
    .filter(Boolean)
    .join(' · ');
  view.innerHTML = head(
    'Garage',
    'Shared report',
    `${who ? `${who} · ` : ''}${kindText} · ${garageDateText(p.at)}`
  );
  const scan = {
    kind: p.kind,
    at: p.at,
    chassis: p.chassis,
    report: p.report,
    summary: p.summary || garageScanSummary(p.report),
  };
  sbRight.textContent = garageScanCountsText(scan);
  const body = document.createElement('div');
  view.appendChild(body);
  if (typeof ipoProtocolRender === 'function')
    await ipoProtocolRender(body, garageViewFor(scan));
  garageDisarmStoredReport(body);
  if (typeof garageAttachEnv === 'function')
    await garageAttachEnv(body, scan.report, {
      screensFor:
        typeof garageScreensFor === 'function' ? garageScreensFor : null,
    });
  // keep it: the report goes into the Garage against a car the recipient picks
  const keep = async () => {
    if (typeof garagePickCar !== 'function') return;
    const car = await garagePickCar({ vin: '', chassis: p.chassis });
    if (!car) return;
    const kept = garageAddScan(
      car.id,
      { report: p.report },
      {
        chassis: p.chassis,
        at: p.at,
      }
    );
    if (kept) showGarageScan(car.id, kept.id);
  };
  const bar = body.querySelector('.quick-bar-btns');
  if (bar) {
    const save = document.createElement('button');
    save.className = 'btn garage-save';
    save.textContent = 'Save to garage';
    save.onclick = keep;
    bar.appendChild(save);
  }
  setActions([
    { key: '1', label: 'Save to garage', fn: keep },
    {
      key: 'p',
      label: 'Print',
      kind: 'print',
      fn: () =>
        garagePrintScan(
          { label: p.label || 'Shared report', chassis: p.chassis },
          scan
        ),
    },
    garageBackAction(showGarage),
  ]);
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    garageSharePayload,
    garageShareEncode,
    garageShareDecode,
    garageShareUrl,
  };
}
