/**
 * @file Vehicle identity: which car is plugged in, asked of the car.
 *
 * Sixth piece of screens/vehicle-identity/. Plug-in-and-go tools do not ask
 * the user which chassis it is. They put the cluster's own group probe on
 * the wire (D_0080, the same bytecode INPA runs on open), read the coding
 * key off whatever cluster answers, and the GM key names the car. The
 * chassis tables do the naming here (chassisFromKeys); the group probe is
 * the shipped D_0080 / D_0044 bytecode run in the VM, so this path has no
 * address or variant list of its own.
 */

/**
 * The identified car.
 * @typedef {object} ViDetectedCar
 * @property {string} chassis - Chassis id (E46).
 * @property {string} sgbd - The SGBD that answered the group probe.
 * @property {string} group - The group that found it (d_0080 / d_0044).
 * @property {ViReadKeys} keys - The coding keys read off it.
 * @property {'gm'|'config'} via - 'gm' when the key named the chassis,
 *   'config' when only the config membership of the answering SGBD did.
 * @property {string} [type] - The type key that held (via 'gm').
 * @property {string[]} [keywords] - That type row's keywords (via 'gm').
 */

/** The groups to probe, in order: the cluster, then the EWS. */
const VI_DETECT_GROUPS = [
  { group: 'd_0080', what: 'cluster', address: '0x80' },
  { group: 'd_0044', what: 'EWS', address: '0x44' },
];

/**
 * Put the group probes on the wire until one names a variant.
 * @param {(text: string) => void} wait - Progress callback.
 * @returns {Promise<{ sgbd: string, group: string }>} What answered.
 * @throws {Error} When neither group answers, with the resolver's path.
 */
async function viProbeGroups(wait) {
  for (const g of VI_DETECT_GROUPS) {
    wait(`Asking the ${g.what} who it is…`);
    let v;
    try {
      v = await webResolveVariant(g.group);
    } catch (e) {
      v = null;
    }
    if (v) return { sgbd: String(v).toLowerCase(), group: g.group };
  }
  const why =
    typeof webResolveVariantLast === 'function'
      ? webResolveVariantLast()
      : null;
  const names = VI_DETECT_GROUPS.map((g) => `the ${g.what} (${g.address})`);
  throw new Error(
    `neither ${names.join(' nor ')} answered its group probe` +
      (why && why.path ? ` (${why.path})` : '')
  );
}

/**
 * The chassis ids whose configs list an SGBD.
 * @param {string} sgbd - Lower-case SGBD.
 * @returns {Promise<string[]>} Upper-case chassis ids; empty on failure.
 */
async function viChassisListing(sgbd) {
  try {
    const ids = await api('/api/chassis');
    const cfgs = await Promise.all(
      (ids || []).map((c) => api(`/api/chassis/${c}`).catch(() => null))
    );
    return cfgs
      .filter(Boolean)
      .filter((c) =>
        (c.sections || []).some((sec) =>
          (sec.ecus || []).some(
            (e) => String(e.sgbd || '').toLowerCase() === sgbd
          )
        )
      )
      .map((c) => String(c.id).toUpperCase());
  } catch (e) {
    return [];
  }
}

/**
 * Identify the car: probe, read the coding key, name the chassis.
 * @param {(text: string) => void} wait - Progress callback for the pane.
 * @returns {Promise<ViDetectedCar>} The identified car.
 * @throws {Error} With a reason the screen can print.
 */
async function viDetectCar(wait) {
  if (typeof webResolveVariant !== 'function') {
    throw new Error('this build cannot probe the car (no group resolver)');
  }
  const { sgbd, group } = await viProbeGroups(wait);
  wait(`${sgbd.toUpperCase()} answered · reading its coding key…`);
  const jobs = await viJobs(sgbd);
  const zcsJob = await viPickZcsJob(sgbd, jobs);
  if (!zcsJob) {
    throw new Error(`${sgbd} answered but declares no coding-key read`);
  }
  const values = await viRunValues(sgbd, zcsJob.job);
  const keys = viKeysFrom(values, zcsJob.keys);
  if (!keys) {
    throw new Error(`${sgbd}: ${zcsJob.job} returned no valid coding key`);
  }
  // The key names the chassis. A key no table claims falls back to which
  // chassis configs list the answering SGBD -- data too, just weaker: a
  // cluster variant can serve more than one chassis.
  const byKey =
    typeof VehicleIdentity !== 'undefined'
      ? VehicleIdentity.chassisFromKeys(keys)
      : [];
  const listed = await viChassisListing(sgbd);
  const agreed = byKey.filter((c) => listed.includes(c.chassis));
  // WHICH MODULE ANSWERED OUTRANKS WHAT ITS KEY SAYS. A cluster that only
  // one chassis config lists (kombi46r: E46) is the car; its GM key may be
  // stale or unprogrammed on an FA-era car (a 2004 325i answered 00020002,
  // which happens to be an E39 type row) and must not overrule that.
  const pick =
    agreed[0] ||
    (listed.length === 1 ? { chassis: listed[0], viaConfig: true } : null) ||
    byKey[0] ||
    null;
  if (pick && pick.viaConfig) {
    return { chassis: pick.chassis, sgbd, group, keys, via: 'config' };
  }
  if (pick) {
    return {
      chassis: pick.chassis,
      sgbd,
      group,
      keys,
      via: 'gm',
      type: pick.key,
      keywords: pick.keywords,
    };
  }
  throw new Error(
    `no chassis table claims GM ${keys.gm}` +
      (listed.length
        ? ` (the ${sgbd} cluster is listed on ${listed.join(', ')})`
        : '')
  );
}
